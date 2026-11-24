-- A leased root can still commit while another transaction sees an expired
-- lease. A waiter stays pending until the root's terminal result is visible.
create or replace function internal.slack_connector_event_root_state(
  p_event internal.slack_connector_event_receipts, p_now timestamptz
) returns text language sql stable set search_path = '' as $$
  with matching_roots as (
    select root.result, root.session_id, root.deadline_at, root.lease_id
    from internal.slack_connector_event_receipts root
    where root.action = 'mention' and root.thread_ts = root.message_ts
      and (root.resource_id, root.installation_id, root.installation_generation, root.mapping_revision, root.message_ts) =
        (p_event.resource_id, p_event.installation_id, p_event.installation_generation,
          p_event.mapping_revision, p_event.thread_ts)
      and root.recorded_at <= p_event.wait_for_root_until
      and (p_event.message_ts <> p_event.thread_ts or root.actor_id = p_event.actor_id)
      and (root.result is null or root.result = 'admitted')
  )
  select case when exists (
    select 1 from public.session_conversation_sources source
    where (source.workspace_id, source.factory_id, source.provider, source.source_namespace, source.external_thread_id) =
      (p_event.workspace_id, p_event.factory_id, 'slack', p_event.resource_id::text, p_event.thread_ts)
      and (source.created_at <= p_event.wait_for_root_until or exists (
        select 1 from matching_roots root where root.result = 'admitted' and root.session_id = source.session_id
      ))
  ) then 'ready' when exists (
    select 1 from matching_roots root where root.result is null
      and (root.deadline_at > p_now or root.lease_id is not null)
  ) then 'waiting' else 'missing' end
$$;

create or replace function public.claim_slack_connector_event(p_workspace_id uuid default null)
returns table (
  queue_id uuid, lease_id uuid, workspace_id uuid, factory_id uuid, resource_id uuid, installation_id uuid,
  installation_generation bigint, mapping_revision bigint, team_id text, app_id text, channel_id text,
  bot_user_id text, encrypted_token text, deadline_at timestamptz, kind text
) language plpgsql security definer set search_path = '' as $$
declare
  scan_cutoff timestamptz := clock_timestamp();
  pending internal.slack_connector_event_receipts;
  authority record;
  new_lease_id uuid;
  claim_expires_at timestamptz;
  cooldown_until timestamptz;
  root_state text;
  contended_receipts uuid[] := '{}';
begin
  perform internal.assert_checkpoint_publication_service();
  delete from internal.slack_connector_event_receipts expired where expired.id in (
    select prior.id from internal.slack_connector_event_receipts prior
    where prior.settled_at < scan_cutoff - interval '30 days'
      and (p_workspace_id is null or p_workspace_id = prior.workspace_id)
    order by prior.settled_at, prior.id for update skip locked limit 16
  );

  for ignored in 1..8 loop
    select event.* into pending from internal.slack_connector_event_receipts event
    where event.result is null and (event.next_attempt_at <= scan_cutoff
      or (event.wait_for_root_until is not null and internal.slack_connector_event_root_state(event, scan_cutoff) = 'ready'))
      and (p_workspace_id is null or p_workspace_id = event.workspace_id)
      and event.id <> all(contended_receipts)
      and (event.deadline_at <= scan_cutoff or event.attempt_count >= 6 or not exists (
        select 1 from internal.slack_connector_event_cooldowns cooldown
        where (cooldown.team_id, cooldown.app_id) = (event.team_id, event.app_id)
          and cooldown.method in ('auth.test', 'conversations.info') and cooldown.retry_at > scan_cutoff
      ))
    order by event.next_attempt_at, event.id for update skip locked limit 1;
    if not found then return; end if;
    if pending.deadline_at <= clock_timestamp() or pending.attempt_count >= 6 then
      perform internal.finish_slack_connector_event(pending.id,
        case when pending.deadline_at <= clock_timestamp() then 'expired' else 'attempt_limit' end);
      continue;
    end if;
    if pending.wait_for_root_until is not null then
      root_state := internal.slack_connector_event_root_state(pending, clock_timestamp());
      if root_state = 'missing' then
        perform internal.finish_slack_connector_event(pending.id, 'ignored');
        continue;
      elsif root_state = 'waiting' then
        update internal.slack_connector_event_receipts event
        set next_attempt_at = least(pending.deadline_at, scan_cutoff + interval '5 seconds')
        where event.id = pending.id;
        continue;
      end if;
    end if;

    select credential.bot_user_id, credential.encrypted_token into authority
    from public.read_connector_subscription(pending.workspace_id, pending.factory_id, pending.resource_id) live
    join internal.connector_installations installation on installation.id = live.installation_id
    join internal.slack_connector_credentials credential
      on (credential.installation_id, credential.credential_id) = (live.installation_id, live.credential_ref)
    where (live.installation_id, live.installation_generation, live.mapping_revision, live.credential_kind,
      installation.external_tenant_id, installation.external_installation_id) =
      (pending.installation_id, pending.installation_generation, pending.mapping_revision, 'slack_bot',
        pending.team_id, pending.app_id);
    if not found then
      perform internal.finish_slack_connector_event(pending.id, 'authority_unavailable');
      continue;
    end if;

    -- Recheck after choosing a receipt to serialize with a concurrent 429.
    -- Lock the candidate receipt before the nonblocking scope check.
    if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'slack-event-cooldown:' || pending.team_id || ':' || pending.app_id, 0)) then
      contended_receipts := array_append(contended_receipts, pending.id);
      continue;
    end if;
    select max(cooldown.retry_at) into cooldown_until from internal.slack_connector_event_cooldowns cooldown
    where (cooldown.team_id, cooldown.app_id) = (pending.team_id, pending.app_id)
      and cooldown.method in ('auth.test', 'conversations.info');
    if cooldown_until > clock_timestamp() then
      update internal.slack_connector_event_receipts event
      set next_attempt_at = least(pending.deadline_at, cooldown_until)
      where event.id = pending.id;
      continue;
    end if;

    claim_expires_at := least(pending.deadline_at, clock_timestamp() + interval '30 seconds');
    new_lease_id := gen_random_uuid();
    update internal.slack_connector_event_receipts target
    set lease_id = new_lease_id, lease_expires_at = claim_expires_at, wait_for_root_until = null,
      next_attempt_at = claim_expires_at, attempt_count = target.attempt_count + 1
    where target.id = pending.id;
    queue_id := pending.id;
    lease_id := new_lease_id;
    workspace_id := pending.workspace_id;
    factory_id := pending.factory_id;
    resource_id := pending.resource_id;
    installation_id := pending.installation_id;
    installation_generation := pending.installation_generation;
    mapping_revision := pending.mapping_revision;
    team_id := pending.team_id;
    app_id := pending.app_id;
    channel_id := pending.channel_id;
    bot_user_id := authority.bot_user_id;
    encrypted_token := authority.encrypted_token;
    deadline_at := pending.deadline_at;
    kind := 'event';
    return next;
    return;
  end loop;
  kind := 'cleanup';
  return next;
end;
$$;

-- conversations.info can prove membership directly. Check the optional
-- users.conversations cooldown only when channel verification needs it.
create function public.defer_slack_connector_membership_lookup(p_queue_id uuid, p_lease_id uuid)
returns text language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  pending internal.slack_connector_event_receipts;
  cooldown_until timestamptz;
begin
  perform internal.assert_checkpoint_publication_service();
  select receipt.* into pending from internal.slack_connector_event_receipts receipt
  where (receipt.id, receipt.lease_id) = (p_queue_id, p_lease_id) and receipt.result is null
    and receipt.lease_expires_at > clock_timestamp() for update;
  if not found then return 'stale'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'slack-event-cooldown:' || pending.team_id || ':' || pending.app_id, 0));
  if pending.lease_expires_at <= clock_timestamp() then return 'stale'; end if;
  select cooldown.retry_at into cooldown_until from internal.slack_connector_event_cooldowns cooldown
  where (cooldown.team_id, cooldown.app_id, cooldown.method) = (pending.team_id, pending.app_id, 'users.conversations');
  if not found or cooldown_until <= clock_timestamp() then return 'ready'; end if;

  -- The provider lookup never happened. Release the lease and refund its attempt.
  update internal.slack_connector_event_receipts receipt set attempt_count = receipt.attempt_count - 1,
    lease_id = null, lease_expires_at = null, next_attempt_at = least(cooldown_until, pending.deadline_at)
  where receipt.id = pending.id;
  return 'deferred';
end;
$$;
revoke all on function public.defer_slack_connector_membership_lookup(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.defer_slack_connector_membership_lookup(uuid,uuid) to service_role;
