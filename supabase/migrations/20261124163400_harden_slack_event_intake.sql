create table internal.slack_connector_event_cooldowns (
  team_id text not null,
  app_id text not null,
  method text not null check (method in ('auth.test', 'conversations.info', 'users.conversations')),
  installation_id uuid not null references internal.connector_installations(id) on delete cascade,
  retry_at timestamptz not null,
  primary key (team_id, app_id, method)
);
create index slack_connector_event_cooldowns_installation_idx
  on internal.slack_connector_event_cooldowns(installation_id);
alter table internal.slack_connector_event_cooldowns enable row level security;
revoke all on internal.slack_connector_event_cooldowns from public, anon, authenticated, service_role;

create index slack_connector_events_root_arrival_idx
  on internal.slack_connector_event_receipts(resource_id, installation_id, installation_generation, mapping_revision,
    message_ts, recorded_at)
  where action = 'mention' and thread_ts = message_ts and (result is null or result = 'admitted');

-- An early reply can wait on an in-window mention even when the worker binds
-- the source later. An existing source is authoritative in its exact scope.
create function internal.slack_connector_event_root_state(
  p_event internal.slack_connector_event_receipts, p_now timestamptz
) returns text language sql stable set search_path = '' as $$
  with matching_roots as (
    select root.result, root.session_id, root.deadline_at, root.attempt_count, root.lease_expires_at
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
    select 1 from matching_roots root where root.result is null and root.deadline_at > p_now
      and (root.attempt_count < 6 or root.lease_expires_at > p_now)
  ) then 'waiting' else 'missing' end
$$;
revoke all on function internal.slack_connector_event_root_state(internal.slack_connector_event_receipts,timestamptz)
  from public, anon, authenticated, service_role;

drop function public.claim_slack_connector_event(uuid);
drop function public.settle_slack_connector_event(uuid,uuid,text,text,text,text,text,integer);

create function public.claim_slack_connector_event(p_workspace_id uuid default null)
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
        where (cooldown.team_id, cooldown.app_id) = (event.team_id, event.app_id) and cooldown.retry_at > scan_cutoff
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
    -- A claim holds only its selected receipt while it tries the scope lock.
    if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'slack-event-cooldown:' || pending.team_id || ':' || pending.app_id, 0)) then
      contended_receipts := array_append(contended_receipts, pending.id);
      continue;
    end if;
    select max(cooldown.retry_at) into cooldown_until from internal.slack_connector_event_cooldowns cooldown
    where (cooldown.team_id, cooldown.app_id) = (pending.team_id, pending.app_id);
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

create function public.settle_slack_connector_event(
  p_queue_id uuid, p_lease_id uuid, p_result text, p_team_id text default null, p_app_id text default null,
  p_channel_id text default null, p_bot_user_id text default null, p_retry_after_seconds integer default null,
  p_rate_limited_method text default null
) returns text language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  pending internal.slack_connector_event_receipts;
  installation internal.connector_installations;
  live record;
  bot_user_id text;
  retry_at timestamptz;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_result is null or p_result not in ('verified', 'retry', 'rate_limited', 'unavailable')
    or (p_result = 'rate_limited') <> (p_rate_limited_method is not null)
    or p_rate_limited_method not in ('auth.test', 'conversations.info', 'users.conversations') then
    raise exception 'Invalid Slack connector event result.' using errcode = '22023';
  end if;
  select event.* into pending from internal.slack_connector_event_receipts event
  where (event.id, event.lease_id) = (p_queue_id, p_lease_id) and event.result is null;
  if not found then return 'stale'; end if;

  -- Parent fences precede the receipt row to avoid blocking a cascade with
  -- the worker holding its dependent row. Credential changes take this same installation fence.
  perform 1 from public.workspaces workspace where workspace.id = pending.workspace_id for share;
  perform 1 from public.factories factory
  where (factory.workspace_id, factory.id) = (pending.workspace_id, pending.factory_id) for share;
  select target.* into installation from internal.connector_installations target
  where (target.workspace_id, target.id) = (pending.workspace_id, pending.installation_id)
  for share;
  select event.* into pending from internal.slack_connector_event_receipts event
  where (event.id, event.lease_id) = (p_queue_id, p_lease_id) and event.result is null
    and event.lease_expires_at > clock_timestamp() for update;
  if not found then return 'stale'; end if;
  if pending.deadline_at <= clock_timestamp() then
    return internal.finish_slack_connector_event(pending.id, 'expired');
  end if;

  perform internal.lock_connector_authority(installation, pending.factory_id, pending.channel_id);
  select * into live from public.read_connector_subscription(pending.workspace_id, pending.factory_id, pending.resource_id);
  if pending.lease_expires_at <= clock_timestamp() then return 'stale'; end if;
  if not found or (live.installation_id, live.installation_generation, live.mapping_revision, live.credential_kind,
    installation.external_tenant_id, installation.external_installation_id) is distinct from
    (pending.installation_id, pending.installation_generation, pending.mapping_revision, 'slack_bot',
      pending.team_id, pending.app_id) then
    return internal.finish_slack_connector_event(pending.id, 'authority_unavailable');
  end if;
  if p_result = 'unavailable' then
    return internal.finish_slack_connector_event(pending.id, 'membership_denied');
  end if;
  if p_result in ('retry', 'rate_limited') then
    retry_at := clock_timestamp() + make_interval(secs => greatest(1, least(900, coalesce(p_retry_after_seconds, 5))));
    if p_result = 'rate_limited' then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'slack-event-cooldown:' || pending.team_id || ':' || pending.app_id, 0));
      if pending.lease_expires_at <= clock_timestamp() then return 'stale'; end if;
      insert into internal.slack_connector_event_cooldowns as cooldown (team_id, app_id, method, installation_id, retry_at)
      values (pending.team_id, pending.app_id, p_rate_limited_method, pending.installation_id, retry_at)
      on conflict (team_id, app_id, method) do update
        set retry_at = greatest(cooldown.retry_at, excluded.retry_at), installation_id = excluded.installation_id
      returning cooldown.retry_at into retry_at;
    end if;
    if pending.attempt_count >= 6 then return internal.finish_slack_connector_event(pending.id, 'attempt_limit'); end if;
    if retry_at >= pending.deadline_at then return internal.finish_slack_connector_event(pending.id, 'expired'); end if;
    update internal.slack_connector_event_receipts event set lease_id = null, lease_expires_at = null, next_attempt_at = retry_at
    where event.id = pending.id;
    return 'retry';
  end if;

  select credential.bot_user_id into bot_user_id from internal.slack_connector_credentials credential
  where (credential.installation_id, credential.credential_id) = (pending.installation_id, live.credential_ref);
  if (p_team_id, p_app_id, p_channel_id, p_bot_user_id) is distinct from
    (pending.team_id, pending.app_id, pending.channel_id, bot_user_id) then
    return internal.finish_slack_connector_event(pending.id, 'membership_denied');
  end if;
  return internal.apply_verified_slack_connector_event(pending, bot_user_id);
end;
$$;

revoke all on function public.claim_slack_connector_event(uuid),
  public.settle_slack_connector_event(uuid,uuid,text,text,text,text,text,integer,text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_slack_connector_event(uuid),
  public.settle_slack_connector_event(uuid,uuid,text,text,text,text,text,integer,text)
  to service_role;

create or replace function public.enqueue_slack_connector_event(
  p_team_id text, p_app_id text, p_channel_id text, p_event_id text, p_action text,
  p_message_ts text, p_version_ts text, p_thread_ts text default null, p_actor_id text default null, p_body text default null
) returns text language plpgsql security definer set search_path = '' set lock_timeout = '1s' as $$
declare
  resource public.factory_connector_resources;
  subscription record;
  prior internal.slack_connector_event_receipts;
  bot_user_id text;
  thread_ts text := coalesce(p_thread_ts, case when p_action <> 'deleted' then p_message_ts end);
  wait_for_root_until timestamptz;
  root_ingress text;
  input_hash text;
  inserted_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  if (p_team_id ~ '^T[A-Z0-9]{2,31}$' and p_app_id ~ '^A[A-Z0-9]{2,31}$'
    and p_channel_id ~ '^[CG][A-Z0-9]{2,31}$' and p_event_id ~ '^[A-Za-z0-9_-]{1,128}$'
    and p_action in ('mention', 'created', 'edited', 'deleted')
    and p_message_ts ~ '^[1-9][0-9]{0,11}[.][0-9]{6}$' and p_version_ts ~ '^[1-9][0-9]{0,11}[.][0-9]{6}$'
    and (p_thread_ts is null or p_thread_ts ~ '^[1-9][0-9]{0,11}[.][0-9]{6}$')
    and (p_actor_id is null or p_actor_id ~ '^[UW][A-Z0-9]{2,31}$')
    and (case when p_action = 'deleted' then p_body is null
      else p_actor_id is not null and length(p_body) between 1 and 8000 and p_body ~ '[^[:space:]]' end)) is not true then
    raise exception 'Invalid Slack connector event.' using errcode = '22023';
  end if;
  if p_thread_ts::numeric > p_message_ts::numeric
    or (p_action in ('mention', 'created') and p_version_ts <> p_message_ts)
    or (p_action in ('edited', 'deleted') and p_version_ts::numeric <= p_message_ts::numeric) then
    raise exception 'Invalid Slack connector event timestamp.' using errcode = '22023';
  end if;

  input_hash := encode(sha256(convert_to(jsonb_build_array(
    p_team_id, p_app_id, p_channel_id, p_action, p_message_ts, p_version_ts, thread_ts, p_actor_id, p_body
  )::text, 'UTF8')), 'hex');
  select event.* into prior from internal.slack_connector_event_receipts event
  where (event.team_id, event.app_id, event.event_id) = (p_team_id, p_app_id, p_event_id);
  if found then
    if prior.input_hash <> input_hash then
      raise exception 'Slack event identity was already used.' using errcode = 'PT409';
    end if;
    return 'replayed';
  end if;

  select mapped.* into resource from public.factory_connector_resources mapped
  join internal.connector_installations installation
    on (installation.workspace_id, installation.id) = (mapped.workspace_id, mapped.installation_id)
  where (mapped.provider, mapped.resource_kind, mapped.external_tenant_id, mapped.external_resource_id) =
    ('slack', 'channel', p_team_id, p_channel_id) and installation.external_installation_id = p_app_id;
  if not found then return 'ignored'; end if;
  select * into subscription from public.read_connector_subscription(resource.workspace_id, resource.factory_id, resource.id);
  if not found then return 'ignored'; end if;
  select credential.bot_user_id into bot_user_id from internal.slack_connector_credentials credential
  where (credential.installation_id, credential.credential_id) = (subscription.installation_id, subscription.credential_ref);
  if not found or p_actor_id in (bot_user_id, 'USLACKBOT') then return 'ignored'; end if;

  if p_action <> 'deleted' then
    if not exists (
      select 1 from internal.connector_actor_links link
      join public.workspace_members member
        on (member.workspace_id, member.id) = (link.workspace_id, link.member_id)
      where (link.installation_id, link.external_actor_id, link.actor_kind) = (resource.installation_id, p_actor_id, 'human')
        and link.revoked_at is null and member.kind = 'human' and member.is_active
        and (member.role in ('owner', 'admin') or exists (
          select 1 from public.factory_members membership
          where (membership.workspace_id, membership.factory_id, membership.member_id) =
            (resource.workspace_id, resource.factory_id, member.id) and membership.revoked_at is null
        ))
    ) then return 'ignored'; end if;
    if thread_ts = p_message_ts and p_action in ('mention', 'created') then
      if p_action <> 'mention' or strpos(p_body, '<@' || bot_user_id || '>') = 0 then return 'ignored'; end if;
    else
      -- Inspect the source and pending mention in one snapshot. Root settlement
      -- turns an eligible pending mention into a bound source atomically.
      select case when exists (
        select 1 from public.session_conversation_sources source
        where (source.workspace_id, source.factory_id, source.provider, source.source_namespace, source.external_thread_id) =
          (resource.workspace_id, resource.factory_id, 'slack', resource.id::text, thread_ts)
      ) then 'bound' when thread_ts <> p_message_ts or exists (
        select 1 from internal.slack_connector_event_receipts original
        where original.action = 'mention' and original.result is null and original.thread_ts = original.message_ts
          and (original.resource_id, original.installation_id, original.installation_generation,
            original.mapping_revision, original.message_ts, original.actor_id) =
            (resource.id, subscription.installation_id, subscription.installation_generation,
              subscription.mapping_revision, p_message_ts, p_actor_id)
          and original.deadline_at > clock_timestamp()
      ) then 'waiting' else 'ignored' end into root_ingress;
      if root_ingress = 'ignored' then return 'ignored'; end if;
      if root_ingress = 'waiting' then
        wait_for_root_until := clock_timestamp() + interval '60 seconds';
      end if;
    end if;
  end if;

  insert into internal.slack_connector_event_receipts (
    workspace_id, factory_id, resource_id, installation_id, installation_generation, mapping_revision,
    team_id, app_id, channel_id, event_id, input_hash, action, message_ts, version_ts, thread_ts, actor_id, body,
    wait_for_root_until, next_attempt_at
  ) values (
    resource.workspace_id, resource.factory_id, resource.id, subscription.installation_id,
    subscription.installation_generation, subscription.mapping_revision,
    p_team_id, p_app_id, p_channel_id, p_event_id, input_hash, p_action, p_message_ts, p_version_ts, thread_ts, p_actor_id, p_body,
    wait_for_root_until, coalesce(wait_for_root_until, clock_timestamp())
  ) on conflict (team_id, app_id, event_id) do nothing returning id into inserted_id;
  if inserted_id is not null then return 'queued'; end if;
  select event.* into strict prior from internal.slack_connector_event_receipts event
  where (event.team_id, event.app_id, event.event_id) = (p_team_id, p_app_id, p_event_id);
  if prior.input_hash <> input_hash then
    raise exception 'Slack event identity was already used.' using errcode = 'PT409';
  end if;
  return 'replayed';
end;
$$;
