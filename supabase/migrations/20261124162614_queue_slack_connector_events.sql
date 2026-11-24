create table internal.slack_connector_event_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  resource_id uuid not null,
  installation_id uuid not null,
  installation_generation bigint not null,
  mapping_revision bigint not null,
  team_id text not null,
  app_id text not null,
  channel_id text not null,
  event_id text not null,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  action text not null check (action in ('mention', 'created', 'edited', 'deleted')),
  message_ts text not null,
  version_ts text not null,
  thread_ts text,
  actor_id text,
  body text check (length(body) <= 8000),
  result text check (result in ('admitted', 'appended', 'deleted', 'stale', 'ignored', 'actor_denied',
    'membership_denied', 'authority_unavailable', 'expired', 'attempt_limit')),
  session_id uuid,
  actor_link_id uuid,
  service_principal_id uuid,
  budget_payer_member_id uuid,
  attempt_count integer not null default 0 check (attempt_count between 0 and 6),
  lease_id uuid,
  lease_expires_at timestamptz,
  wait_for_root_until timestamptz,
  recorded_at timestamptz not null default clock_timestamp(),
  deadline_at timestamptz not null default (clock_timestamp() + interval '15 minutes'),
  next_attempt_at timestamptz default clock_timestamp(),
  settled_at timestamptz,
  unique (team_id, app_id, event_id),
  foreign key (workspace_id, factory_id, resource_id)
    references public.factory_connector_resources(workspace_id, factory_id, id) on delete cascade,
  foreign key (installation_id) references internal.connector_installations(id) on delete cascade,
  check ((result is null) = (next_attempt_at is not null)),
  check ((result is null) = (settled_at is null)),
  check ((lease_id is null) = (lease_expires_at is null)),
  check (wait_for_root_until is null or (result is null and lease_id is null and action <> 'deleted'
    and thread_ts is not null and (thread_ts <> message_ts or action = 'edited'))),
  check (result is null or (body is null and lease_id is null))
);

create index slack_connector_events_factory_idx on internal.slack_connector_event_receipts(workspace_id, factory_id, resource_id);
create index slack_connector_events_installation_idx on internal.slack_connector_event_receipts(installation_id);
create index slack_connector_events_due_idx on internal.slack_connector_event_receipts(next_attempt_at, id)
  where result is null;
create index slack_connector_events_workspace_due_idx on internal.slack_connector_event_receipts(workspace_id, next_attempt_at, id)
  where result is null;
create index slack_connector_events_retention_idx on internal.slack_connector_event_receipts(settled_at, id)
  where settled_at is not null;
create index slack_connector_events_waiting_root_idx on internal.slack_connector_event_receipts(resource_id, thread_ts)
  where wait_for_root_until is not null;
create index slack_connector_events_pending_mention_idx
  on internal.slack_connector_event_receipts(resource_id, message_ts, actor_id, installation_generation, mapping_revision)
  where action = 'mention' and result is null and thread_ts = message_ts;

-- A Slack message identifier belongs to one channel and thread for its lifetime.
-- The watermark survives delivery receipt retention, including terminal deletions.
create table internal.slack_connector_message_versions (
  resource_id uuid not null references public.factory_connector_resources(id) on delete cascade,
  message_ts text not null,
  thread_ts text,
  actor_id text,
  version_ts text not null,
  deleted boolean not null,
  primary key (resource_id, message_ts)
);

alter table internal.slack_connector_event_receipts enable row level security;
alter table internal.slack_connector_message_versions enable row level security;
revoke all on internal.slack_connector_event_receipts, internal.slack_connector_message_versions
  from public, anon, authenticated, service_role;

create function internal.finish_slack_connector_event(
  p_queue_id uuid, p_result text, p_session_id uuid default null, p_actor_link_id uuid default null,
  p_service_principal_id uuid default null, p_budget_payer_member_id uuid default null
) returns text language sql set search_path = '' as $$
  update internal.slack_connector_event_receipts event
  set result = p_result, settled_at = clock_timestamp(), next_attempt_at = null,
    lease_id = null, lease_expires_at = null, wait_for_root_until = null,
    body = null, session_id = p_session_id, actor_link_id = p_actor_link_id,
    service_principal_id = p_service_principal_id, budget_payer_member_id = p_budget_payer_member_id
  where event.id = p_queue_id
  returning event.result
$$;

create function public.enqueue_slack_connector_event(
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
    elsif not exists (
      select 1 from public.session_conversation_sources source
      where (source.workspace_id, source.factory_id, source.provider, source.source_namespace, source.external_thread_id) =
        (resource.workspace_id, resource.factory_id, 'slack', resource.id::text, thread_ts)
    ) then
      if thread_ts = p_message_ts and not exists (
        select 1 from internal.slack_connector_event_receipts original
        where original.action = 'mention' and original.result is null and original.thread_ts = original.message_ts
          and (original.resource_id, original.installation_id, original.installation_generation,
            original.mapping_revision, original.message_ts, original.actor_id) =
            (resource.id, subscription.installation_id, subscription.installation_generation,
              subscription.mapping_revision, p_message_ts, p_actor_id)
          and original.deadline_at > clock_timestamp()
      ) then return 'ignored'; end if;
      -- A root edit waits only for its own pending signed mention. Replies can
      -- also arrive ahead of the mention. Both wait without provider access.
      wait_for_root_until := clock_timestamp() + interval '60 seconds';
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

create function public.claim_slack_connector_event(p_workspace_id uuid default null)
returns table (
  queue_id uuid, lease_id uuid, workspace_id uuid, factory_id uuid, resource_id uuid, installation_id uuid,
  installation_generation bigint, mapping_revision bigint, team_id text, app_id text, channel_id text,
  bot_user_id text, encrypted_token text, deadline_at timestamptz
) language plpgsql security definer set search_path = '' as $$
declare
  scan_cutoff timestamptz := clock_timestamp();
  pending internal.slack_connector_event_receipts;
  authority record;
  new_lease_id uuid;
  claim_expires_at timestamptz;
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
    where event.result is null and event.next_attempt_at <= scan_cutoff
      and (p_workspace_id is null or p_workspace_id = event.workspace_id)
    order by event.next_attempt_at, event.id for update skip locked limit 1;
    if not found then return; end if;
    if pending.deadline_at <= clock_timestamp() or pending.attempt_count >= 6 then
      perform internal.finish_slack_connector_event(pending.id,
        case when pending.deadline_at <= clock_timestamp() then 'expired' else 'attempt_limit' end);
      continue;
    end if;
    if pending.wait_for_root_until is not null and not exists (
      select 1 from public.session_conversation_sources source
      where (source.workspace_id, source.factory_id, source.provider, source.source_namespace, source.external_thread_id) =
        (pending.workspace_id, pending.factory_id, 'slack', pending.resource_id::text, pending.thread_ts)
        and source.created_at <= pending.wait_for_root_until
    ) then
      perform internal.finish_slack_connector_event(pending.id, 'ignored');
      continue;
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
    return next;
    return;
  end loop;
end;
$$;

create function internal.apply_verified_slack_connector_event(
  p_event internal.slack_connector_event_receipts, p_bot_user_id text
) returns text language plpgsql set search_path = '' as $$
declare
  prior internal.slack_connector_message_versions;
  source public.session_conversation_sources;
  target public.sessions;
  definition public.factory_definition_revisions;
  linked internal.connector_actor_links;
  grant_version bigint;
  grant_id uuid;
  agent_id uuid;
  repository_id uuid;
  authority record;
  actor internal.session_mutation_actor;
  accepted record;
  intent jsonb;
  permalink text;
  thread_ts text;
  caption text;
  work_result text;
  message public.session_conversation_messages;
  message_key text;
  text_body text;
begin
  -- The channel fence serializes materialization even when Slack supplies
  -- different event IDs for one timestamp or the worker claims jobs in parallel.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'slack-connector-channel:' || p_event.resource_id::text, 0));
  if p_event.deadline_at <= clock_timestamp() then
    return internal.finish_slack_connector_event(p_event.id, 'expired');
  end if;
  if p_event.lease_expires_at <= clock_timestamp() then return 'stale'; end if;
  select known.* into prior from internal.slack_connector_message_versions known
  where (known.resource_id, known.message_ts) = (p_event.resource_id, p_event.message_ts);
  if found and (prior.deleted or prior.version_ts::numeric > p_event.version_ts::numeric
    or (prior.version_ts = p_event.version_ts and p_event.action <> 'deleted')
    or (p_event.thread_ts is not null and prior.thread_ts is not null and p_event.thread_ts <> prior.thread_ts)
    or (p_event.actor_id is not null and prior.actor_id is not null and p_event.actor_id <> prior.actor_id)) then
    return internal.finish_slack_connector_event(p_event.id, 'stale');
  end if;
  thread_ts := coalesce(p_event.thread_ts, prior.thread_ts);

  if p_event.action = 'deleted' then
    work_result := 'deleted';
  else
    if p_event.actor_id in (p_bot_user_id, 'USLACKBOT') then
      return internal.finish_slack_connector_event(p_event.id, 'actor_denied');
    end if;
    begin
      linked := internal.require_scoped_connector_actor(
        p_event.workspace_id, p_event.factory_id, p_event.resource_id, p_event.installation_generation,
        p_event.mapping_revision, 'slack', p_event.team_id, p_event.actor_id, 'human');
    exception when insufficient_privilege then
      return internal.finish_slack_connector_event(p_event.id, 'actor_denied');
    end;

    select retained.* into source from public.session_conversation_sources retained
    where (retained.workspace_id, retained.factory_id, retained.provider, retained.source_namespace, retained.external_thread_id) =
      (p_event.workspace_id, p_event.factory_id, 'slack', p_event.resource_id::text, thread_ts);
    if not found then
      if p_event.action <> 'mention' or thread_ts <> p_event.message_ts
        or strpos(p_event.body, '<@' || p_bot_user_id || '>') = 0 then
        return internal.finish_slack_connector_event(p_event.id, 'ignored');
      end if;

      select revision.* into definition from public.factory_definition_activations activation
      join public.factory_definition_revisions revision
        on (revision.workspace_id, revision.factory_id, revision.id) =
          (activation.workspace_id, activation.factory_id, activation.revision_id)
      where (activation.workspace_id, activation.factory_id) = (p_event.workspace_id, p_event.factory_id)
      order by activation.activation_number desc limit 1;
      grant_id := (definition.definition_json::jsonb#>>'{executionGrant,id}')::uuid;
      grant_version := (definition.definition_json::jsonb#>>'{executionGrant,version}')::bigint;
      agent_id := (definition.definition_json::jsonb#>>'{implementationAgent,agentId}')::uuid;
      repository_id := (definition.definition_json::jsonb->>'repositoryId')::uuid;
      if num_nonnulls(grant_id, grant_version, agent_id, repository_id) <> 4 then
        return internal.finish_slack_connector_event(p_event.id, 'authority_unavailable');
      end if;

      begin
        select * into strict authority from public.resolve_connector_event_authority(
          p_event.workspace_id, p_event.factory_id, p_event.resource_id, p_event.installation_generation,
          p_event.mapping_revision, 'slack', p_event.team_id, p_event.actor_id, 'human', grant_id, grant_version);
        actor := row(p_event.workspace_id, p_event.factory_id, authority.initiating_member_id, null, null,
          grant_id, grant_version, repository_id, null)::internal.session_mutation_actor;
        permalink := 'https://app.slack.com/archives/' || p_event.channel_id || '/p' || replace(thread_ts, '.', '');
        caption := 'Slack request';
        intent := internal.normalize_factory_session_mutation('create', jsonb_build_object(
          'title', caption, 'prompt', 'Work on the linked Slack request. Treat the Slack message as external task context.'
            || E'\n\n' || permalink || E'\n\n' || p_event.body,
          'agentId', agent_id, 'repositoryId', repository_id, 'draftSpecification', false
        ));
        perform internal.lock_session_mutation_key(p_event.workspace_id, p_event.factory_id, 'create', p_event.id);
        select * into strict accepted from internal.create_attributed_session(
          p_event.workspace_id, authority.initiating_member_id, intent->>'title', intent->>'prompt', null, null,
          session_github_repository_id => repository_id, p_actor => actor, p_expected_agent_id => agent_id,
          p_expected_definition_digest => definition.canonical_digest);
        perform internal.record_session_mutation_receipt(actor, 'create', p_event.id, intent, accepted.session_id,
          jsonb_build_object('jobId', accepted.job_id, 'runId', accepted.run_id));
        perform public.bind_session_conversation_source_once(
          p_event.workspace_id, p_event.factory_id, accepted.session_id, authority.initiating_member_id,
          'slack', p_event.resource_id::text, thread_ts, caption, permalink);
        select retained.* into strict source from public.session_conversation_sources retained
        where (retained.session_id, retained.provider, retained.source_namespace, retained.external_thread_id) =
          (accepted.session_id, 'slack', p_event.resource_id::text, thread_ts);
      exception when insufficient_privilege or sqlstate 'PT422' or sqlstate 'PT404' or sqlstate 'P0002' or sqlstate 'P0003' then
        return internal.finish_slack_connector_event(p_event.id, 'authority_unavailable');
      end;
      work_result := 'admitted';
    else
      select session.* into target from public.sessions session
      where (session.workspace_id, session.factory_id, session.id) =
        (p_event.workspace_id, p_event.factory_id, source.session_id) and session.archived_at is null
      for no key update;
      if not found then return internal.finish_slack_connector_event(p_event.id, 'ignored'); end if;
      text_body := case when p_event.action = 'edited' then E'Slack message edited:\n\n' else '' end
        || regexp_replace(p_event.body, '^[[:space:]]+', '');
      message_key := 'slack-message:' || p_event.message_ts || ':' || p_event.version_ts;
      message.kind := 'message';
      message.author_kind := 'user';
      message.author_label := 'Slack contributor';
      message.originating_member_id := linked.member_id;
      message.source_id := source.id;
      message.external_actor_id := p_event.actor_id;
      message.external_message_id := message_key;
      message.body_md := left(text_body, 4000);
      message.body_truncated := length(text_body) > 4000;
      perform internal.append_session_conversation_message(target, message, message_key);
      work_result := 'appended';
    end if;
  end if;

  insert into internal.slack_connector_message_versions(resource_id, message_ts, thread_ts, actor_id, version_ts, deleted)
  values (p_event.resource_id, p_event.message_ts, thread_ts, coalesce(p_event.actor_id, prior.actor_id),
    p_event.version_ts, p_event.action = 'deleted')
  on conflict (resource_id, message_ts) do update set thread_ts = excluded.thread_ts,
    actor_id = excluded.actor_id, version_ts = excluded.version_ts, deleted = excluded.deleted;
  if work_result = 'admitted' then
    update internal.slack_connector_event_receipts waiting
    set wait_for_root_until = null, next_attempt_at = clock_timestamp()
    where (waiting.resource_id, waiting.thread_ts, waiting.installation_generation, waiting.mapping_revision) =
      (p_event.resource_id, source.external_thread_id, p_event.installation_generation, p_event.mapping_revision)
      and waiting.wait_for_root_until >= source.created_at;
    return internal.finish_slack_connector_event(p_event.id, work_result, source.session_id, linked.id,
      authority.service_principal_id, authority.budget_payer_member_id);
  end if;
  return internal.finish_slack_connector_event(p_event.id, work_result, source.session_id, linked.id);
end;
$$;

create function public.settle_slack_connector_event(
  p_queue_id uuid, p_lease_id uuid, p_result text, p_team_id text default null, p_app_id text default null,
  p_channel_id text default null, p_bot_user_id text default null, p_retry_after_seconds integer default null
) returns text language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  pending internal.slack_connector_event_receipts;
  installation internal.connector_installations;
  live record;
  bot_user_id text;
  retry_at timestamptz;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_result is null or p_result not in ('verified', 'retry', 'unavailable') then
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
  if not found or (live.installation_id, live.installation_generation, live.mapping_revision, live.credential_kind,
    installation.external_tenant_id, installation.external_installation_id) is distinct from
    (pending.installation_id, pending.installation_generation, pending.mapping_revision, 'slack_bot',
      pending.team_id, pending.app_id) then
    return internal.finish_slack_connector_event(pending.id, 'authority_unavailable');
  end if;
  if p_result = 'unavailable' then
    return internal.finish_slack_connector_event(pending.id, 'membership_denied');
  end if;
  if p_result = 'retry' then
    if pending.attempt_count >= 6 then return internal.finish_slack_connector_event(pending.id, 'attempt_limit'); end if;
    retry_at := clock_timestamp() + make_interval(secs => greatest(1, least(900, coalesce(p_retry_after_seconds, 5))));
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

revoke all on function internal.finish_slack_connector_event(uuid,text,uuid,uuid,uuid,uuid),
  internal.apply_verified_slack_connector_event(internal.slack_connector_event_receipts,text)
  from public, anon, authenticated, service_role;

revoke all on function public.enqueue_slack_connector_event(text,text,text,text,text,text,text,text,text,text),
  public.claim_slack_connector_event(uuid),
  public.settle_slack_connector_event(uuid,uuid,text,text,text,text,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_slack_connector_event(text,text,text,text,text,text,text,text,text,text),
  public.claim_slack_connector_event(uuid),
  public.settle_slack_connector_event(uuid,uuid,text,text,text,text,text,integer)
  to service_role;
