-- Only a connector admission can supply a canonical GitHub conversation.
create index github_connector_admitted_session_idx
  on internal.github_connector_work_deliveries(session_id, resource_id, source_kind, source_number)
  where disposition = 'admitted';
create index github_connector_admitted_thread_idx
  on internal.github_connector_work_deliveries(resource_id, source_kind, source_number)
  where disposition = 'admitted';

-- Issue comment events represent PRs as issues, with a different numeric ID.
create table internal.github_connector_pr_issue_ids (
  resource_id uuid not null references public.factory_connector_resources(id) on delete cascade,
  pull_request_id bigint not null,
  issue_id bigint not null,
  primary key (resource_id, pull_request_id),
  unique (resource_id, issue_id)
);

create table internal.github_connector_comments (
  resource_id uuid not null references public.factory_connector_resources(id) on delete cascade,
  comment_id bigint not null,
  session_id uuid not null,
  source_id uuid not null,
  actor_id bigint not null,
  provider_updated_at timestamptz not null,
  action text not null check (action in ('created', 'edited', 'deleted')),
  primary key (resource_id, comment_id),
  foreign key (session_id, source_id) references public.session_conversation_sources(session_id, id) on delete cascade
);

create table internal.github_connector_comment_deliveries (
  resource_id uuid not null references public.factory_connector_resources(id) on delete cascade,
  delivery_id uuid not null,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  result text not null check (result in ('appended', 'deleted', 'stale')),
  primary key (resource_id, delivery_id)
);

alter table internal.github_connector_pr_issue_ids enable row level security;
alter table internal.github_connector_comments enable row level security;
alter table internal.github_connector_comment_deliveries enable row level security;
revoke all on internal.github_connector_pr_issue_ids, internal.github_connector_comments,
  internal.github_connector_comment_deliveries from public, anon, authenticated, service_role;

-- Webhook delivery is not guaranteed to repeat after transient database contention.
create table internal.github_connector_comment_retries (
  workspace_id uuid not null,
  factory_id uuid not null,
  resource_id uuid not null,
  delivery_id uuid not null,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  github_installation_id bigint not null,
  github_repository_id bigint not null,
  owner_id bigint not null,
  action text not null check (action in ('created', 'edited', 'deleted')),
  source_kind text not null check (source_kind in ('issue', 'pull_request')),
  source_number integer not null,
  issue_id bigint not null,
  comment_id bigint not null,
  actor_id bigint not null,
  provider_updated_at timestamptz not null,
  body text,
  status text not null default 'pending' check (status in ('pending', 'settled', 'failed')),
  result text check (result in ('appended', 'deleted', 'stale', 'ignored')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 8),
  last_sqlstate text check (last_sqlstate ~ '^[A-Z0-9]{5}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  deadline_at timestamptz not null default clock_timestamp() + interval '24 hours',
  next_attempt_at timestamptz default clock_timestamp() + interval '5 seconds',
  settled_at timestamptz,
  primary key (resource_id, delivery_id),
  foreign key (workspace_id, factory_id, resource_id)
    references public.factory_connector_resources(workspace_id, factory_id, id) on delete cascade,
  check ((status = 'pending') = (next_attempt_at is not null)),
  check ((status = 'pending') = (settled_at is null)),
  check (status = 'pending' or body is null)
);
create index github_connector_comment_retries_due_idx
  on internal.github_connector_comment_retries(next_attempt_at, resource_id, delivery_id) where status = 'pending';
create index github_connector_comment_retries_retention_idx
  on internal.github_connector_comment_retries(recorded_at, resource_id, delivery_id);
alter table internal.github_connector_comment_retries enable row level security;
revoke all on internal.github_connector_comment_retries from public, anon, authenticated, service_role;

create function internal.validate_github_connector_comment(
  p_installation_id bigint, p_github_repository_id bigint, p_owner_id bigint, p_delivery_id uuid,
  p_action text, p_source_kind text, p_source_number integer, p_issue_id bigint, p_comment_id bigint,
  p_actor_id bigint, p_provider_updated_at timestamptz, p_body text
) returns text language plpgsql set search_path = '' set timezone = 'UTC' as $$
begin
  if (p_installation_id between 1 and 9007199254740991
    and p_github_repository_id between 1 and 9007199254740991 and p_owner_id between 1 and 9007199254740991
    and p_delivery_id is not null and p_action in ('created', 'edited', 'deleted')
    and p_source_kind in ('issue', 'pull_request') and p_source_number > 0
    and p_issue_id between 1 and 9007199254740991 and p_comment_id between 1 and 9007199254740991
    and p_actor_id between 1 and 9007199254740991 and isfinite(p_provider_updated_at)
    and p_provider_updated_at <= clock_timestamp() + interval '5 minutes'
    and ((p_action = 'deleted' and p_body is null)
      or (p_action in ('created', 'edited') and length(p_body) <= 8000 and btrim(p_body, E' \t\r\n') <> ''))) is not true then
    raise exception 'Invalid GitHub comment delivery.' using errcode = '22023';
  end if;
  return encode(sha256(convert_to(jsonb_build_array(p_action, p_source_kind, p_source_number, p_issue_id,
    p_comment_id, p_actor_id, p_provider_updated_at, p_body)::text, 'UTF8')), 'hex');
end;
$$;
revoke all on function internal.validate_github_connector_comment(bigint, bigint, bigint, uuid, text, text,
  integer, bigint, bigint, bigint, timestamptz, text) from public, anon, authenticated, service_role;

create function public.ingest_github_connector_comment(
  p_installation_id bigint, p_github_repository_id bigint, p_owner_id bigint, p_delivery_id uuid,
  p_action text, p_source_kind text, p_source_number integer, p_issue_id bigint, p_comment_id bigint,
  p_actor_id bigint, p_provider_updated_at timestamptz, p_body text default null
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' set timezone = 'UTC' as $$
declare
  resource public.factory_connector_resources;
  installation internal.connector_installations;
  linked internal.connector_actor_links;
  admission internal.github_connector_work_deliveries;
  source public.session_conversation_sources;
  target public.sessions;
  prior internal.github_connector_comments;
  receipt internal.github_connector_comment_deliveries;
  queued internal.github_connector_comment_retries;
  message public.session_conversation_messages;
  input_hash text;
  result text;
  text_body text;
begin
  perform internal.assert_checkpoint_publication_service();
  input_hash := internal.validate_github_connector_comment(p_installation_id, p_github_repository_id,
    p_owner_id, p_delivery_id, p_action, p_source_kind, p_source_number, p_issue_id, p_comment_id,
    p_actor_id, p_provider_updated_at, p_body);

  select mapped.* into resource from public.factory_connector_resources mapped
  join internal.connector_installations connected
    on (connected.workspace_id, connected.id) = (mapped.workspace_id, mapped.installation_id)
  where (mapped.provider, mapped.resource_kind, mapped.external_tenant_id, mapped.external_resource_id,
    connected.external_installation_id) = ('github', 'repository', p_owner_id::text,
    p_github_repository_id::text, p_installation_id::text);
  if not found then return null; end if;

  begin
    perform internal.assert_workspace_accepts_work(resource.workspace_id);
    perform internal.assert_factory_accepts_work(resource.workspace_id, resource.factory_id);
    select connected.* into installation from internal.connector_installations connected
    where (connected.workspace_id, connected.id, connected.external_installation_id) =
      (resource.workspace_id, resource.installation_id, p_installation_id::text) for share;
    if not found then return null; end if;

    select mapped.* into strict resource from public.factory_connector_resources mapped where mapped.id = resource.id;
    linked := internal.require_scoped_connector_actor(resource.workspace_id, resource.factory_id, resource.id,
      installation.generation, resource.current_revision, 'github', p_owner_id::text, p_actor_id::text, 'human');
  exception when insufficient_privilege or sqlstate 'P0010' or sqlstate 'P0011' then
    return null;
  end;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'github-connector-comment-delivery:' || resource.id::text || ':' || p_delivery_id::text, 0));
  select pending.* into queued from internal.github_connector_comment_retries pending
  where (pending.resource_id, pending.delivery_id) = (resource.id, p_delivery_id);
  if found and (queued.input_hash, queued.github_installation_id) is distinct from (input_hash, p_installation_id) then
    raise exception 'The GitHub comment delivery identifies different input.' using errcode = 'PT409';
  end if;
  perform internal.lock_github_connector_thread(resource.factory_id, p_github_repository_id, p_source_kind, p_source_number);

  select admitted.* into admission from internal.github_connector_work_deliveries admitted
  where (admitted.resource_id, admitted.source_kind, admitted.source_number, admitted.disposition) =
    (resource.id, p_source_kind, p_source_number, 'admitted');
  if not found or (p_source_kind = 'issue' and admission.source_id <> p_issue_id) then return null; end if;

  if p_source_kind = 'issue' and exists (
    select 1 from internal.github_connector_work_deliveries tombstone
    where (tombstone.resource_id, tombstone.source_kind, tombstone.source_id, tombstone.disposition) =
      (resource.id, 'issue', admission.source_id, 'deleted')
  ) then return null; end if;

  select bound.* into source from public.session_conversation_sources bound
  where (bound.session_id, bound.workspace_id, bound.factory_id, bound.provider, bound.source_namespace, bound.external_thread_id) =
    (admission.session_id, resource.workspace_id, resource.factory_id, 'github', resource.id::text,
      p_source_kind || ':' || admission.source_id::text);
  if not found then return null; end if;

  target := internal.lock_session_conversation(resource.workspace_id, resource.factory_id, source.session_id, linked.member_id);
  if target.archived_at is not null then return null; end if;

  if p_source_kind = 'pull_request' then
    insert into internal.github_connector_pr_issue_ids(resource_id, pull_request_id, issue_id)
    values (resource.id, admission.source_id, p_issue_id) on conflict do nothing;
    if not exists (
      select 1 from internal.github_connector_pr_issue_ids identity
      where (identity.resource_id, identity.pull_request_id, identity.issue_id) =
        (resource.id, admission.source_id, p_issue_id)
    ) then return null; end if;
  end if;

  select logged.* into receipt from internal.github_connector_comment_deliveries logged
  where (logged.resource_id, logged.delivery_id) = (resource.id, p_delivery_id);
  if found then
    if receipt.input_hash is distinct from input_hash then
      raise exception 'The GitHub comment delivery identifies different input.' using errcode = 'PT409';
    end if;
    return jsonb_build_object('status', receipt.result, 'sessionId', target.id, 'replayed', true);
  end if;

  select known.* into prior from internal.github_connector_comments known
  where (known.resource_id, known.comment_id) = (resource.id, p_comment_id);
  if found and (prior.session_id, prior.source_id, prior.actor_id)
    is distinct from (source.session_id, source.id, p_actor_id) then return null; end if;

  -- GitHub supplies second precision. Deletion always fences further delivery.
  -- An edit may advance a same-second create, and another tied edit cannot be ordered.
  if prior.action = 'deleted' or (p_action <> 'deleted' and (
    prior.provider_updated_at > p_provider_updated_at
    or (prior.provider_updated_at = p_provider_updated_at and not (prior.action = 'created' and p_action = 'edited'))
    or (prior.action = 'edited' and p_action = 'created')
  )) then
    result := 'stale';
  elsif p_action = 'deleted' then
    result := 'deleted';
  else
    text_body := case p_action when 'edited' then E'GitHub comment edited:\n\n' || p_body else p_body end;
    message.kind := 'message';
    message.author_kind := 'user';
    message.author_label := 'GitHub contributor';
    message.originating_member_id := linked.member_id;
    message.source_id := source.id;
    message.external_actor_id := p_actor_id::text;
    message.external_message_id := 'github-comment:' || p_comment_id::text || ':' || p_action || ':'
      || extract(epoch from p_provider_updated_at)::text;
    message.body_md := left(text_body, 4000);
    message.body_truncated := length(text_body) > 4000;
    perform internal.append_session_conversation_message(target, message, message.external_message_id);
    result := 'appended';
  end if;

  if result <> 'stale' then
    insert into internal.github_connector_comments as known (
      resource_id, comment_id, session_id, source_id, actor_id, provider_updated_at, action
    ) values (resource.id, p_comment_id, source.session_id, source.id, p_actor_id, p_provider_updated_at, p_action)
    on conflict (resource_id, comment_id) do update set
      provider_updated_at = excluded.provider_updated_at, action = excluded.action
    where (known.session_id, known.source_id, known.actor_id) =
      (excluded.session_id, excluded.source_id, excluded.actor_id);
    if not found then
      raise exception 'GitHub comment scope changed.' using errcode = 'PT409';
    end if;
  end if;

  insert into internal.github_connector_comment_deliveries(resource_id, delivery_id, input_hash, result)
  values (resource.id, p_delivery_id, input_hash, result);
  return jsonb_build_object('status', result, 'sessionId', target.id, 'replayed', false);
end;
$$;

revoke all on function public.ingest_github_connector_comment(bigint, bigint, bigint, uuid, text, text, integer,
  bigint, bigint, bigint, timestamptz, text) from public, anon, authenticated;
grant execute on function public.ingest_github_connector_comment(bigint, bigint, bigint, uuid, text, text, integer,
  bigint, bigint, bigint, timestamptz, text) to service_role;

create function public.defer_github_connector_comment(
  p_installation_id bigint, p_github_repository_id bigint, p_owner_id bigint, p_delivery_id uuid,
  p_action text, p_source_kind text, p_source_number integer, p_issue_id bigint, p_comment_id bigint,
  p_actor_id bigint, p_provider_updated_at timestamptz, p_body text default null
) returns boolean language plpgsql security definer set search_path = '' set lock_timeout = '250ms' as $$
declare
  resource public.factory_connector_resources;
  retry internal.github_connector_comment_retries;
  received_hash text;
  delivery_hash text;
begin
  perform internal.assert_checkpoint_publication_service();
  delivery_hash := internal.validate_github_connector_comment(p_installation_id, p_github_repository_id,
    p_owner_id, p_delivery_id, p_action, p_source_kind, p_source_number, p_issue_id, p_comment_id,
    p_actor_id, p_provider_updated_at, p_body);

  -- Read the last committed scope without taking the ingest path's processing
  -- locks. Retain comment text only for a currently linked human and mapped repo.
  select mapped.* into resource from public.factory_connector_resources mapped
  join internal.connector_installations connected
    on (connected.workspace_id, connected.id) = (mapped.workspace_id, mapped.installation_id)
  join public.workspaces workspace on workspace.id = mapped.workspace_id
  join public.factories factory on (factory.workspace_id, factory.id) = (mapped.workspace_id, mapped.factory_id)
  join internal.connector_actor_links link on link.installation_id = connected.id
    and link.actor_kind = 'human' and link.external_actor_id = p_actor_id::text and link.revoked_at is null
  join public.workspace_members member on (member.workspace_id, member.id) = (mapped.workspace_id, link.member_id)
    and member.kind = 'human' and member.is_active
  where (mapped.provider, mapped.resource_kind, mapped.external_tenant_id, mapped.external_resource_id,
    connected.external_installation_id) = ('github', 'repository', p_owner_id::text,
    p_github_repository_id::text, p_installation_id::text)
    and workspace.deletion_requested_at is null and factory.status = 'active'
    and (member.role in ('owner', 'admin') or exists (
      select 1 from public.factory_members membership
      where (membership.workspace_id, membership.factory_id, membership.member_id) =
        (mapped.workspace_id, mapped.factory_id, member.id) and membership.revoked_at is null
    ))
    and exists (select 1 from public.read_connector_subscription(mapped.workspace_id, mapped.factory_id, mapped.id));
  if not found then return false; end if;

  select receipt.input_hash into received_hash from internal.github_connector_comment_deliveries receipt
  where (receipt.resource_id, receipt.delivery_id) = (resource.id, p_delivery_id);
  if found then
    if received_hash is distinct from delivery_hash then
      raise exception 'The GitHub comment delivery identifies different input.' using errcode = 'PT409';
    end if;
    return true;
  end if;

  insert into internal.github_connector_comment_retries (
    workspace_id, factory_id, resource_id, delivery_id, input_hash, github_installation_id,
    github_repository_id, owner_id, action, source_kind, source_number, issue_id, comment_id,
    actor_id, provider_updated_at, body
  ) values (
    resource.workspace_id, resource.factory_id, resource.id, p_delivery_id, delivery_hash, p_installation_id,
    p_github_repository_id, p_owner_id, p_action, p_source_kind, p_source_number, p_issue_id, p_comment_id,
    p_actor_id, p_provider_updated_at, p_body
  ) on conflict (resource_id, delivery_id) do nothing;

  select pending.* into retry from internal.github_connector_comment_retries pending
  where (pending.resource_id, pending.delivery_id) = (resource.id, p_delivery_id);
  if (retry.input_hash, retry.github_installation_id) is distinct from (delivery_hash, p_installation_id) then
    raise exception 'The GitHub comment delivery identifies different input.' using errcode = 'PT409';
  end if;
  return true;
end;
$$;

create function public.drain_github_connector_comment_retries()
returns integer language plpgsql security definer set search_path = '' set lock_timeout = '250ms' as $$
declare
  retry internal.github_connector_comment_retries;
  answer jsonb;
  retry_error text;
  scan_at timestamptz := clock_timestamp();
  settled integer := 0;
begin
  perform internal.assert_checkpoint_publication_service();
  -- A batch holds row locks until commit. Use one drainer across Node and
  -- Workerd so independent batches cannot acquire factory locks in reverse order.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('github-connector-comment-retries', 0)) then
    return 0;
  end if;
  delete from internal.github_connector_comment_retries old
  where (old.resource_id, old.delivery_id) in (
    select expired.resource_id, expired.delivery_id from internal.github_connector_comment_retries expired
    where expired.recorded_at <= scan_at - interval '7 days'
    order by expired.recorded_at, expired.resource_id, expired.delivery_id limit 16 for update skip locked
  );

  for retry in
    select pending.* from internal.github_connector_comment_retries pending
    where pending.status = 'pending' and pending.next_attempt_at <= scan_at
    order by pending.next_attempt_at, pending.resource_id, pending.delivery_id limit 4 for update skip locked
  loop
    if retry.deadline_at <= clock_timestamp() then
      update internal.github_connector_comment_retries pending set status = 'failed', body = null,
        next_attempt_at = null, settled_at = clock_timestamp()
      where (pending.resource_id, pending.delivery_id) = (retry.resource_id, retry.delivery_id);
      settled := settled + 1;
      continue;
    end if;

    begin
      answer := public.ingest_github_connector_comment(retry.github_installation_id, retry.github_repository_id,
        retry.owner_id, retry.delivery_id, retry.action, retry.source_kind, retry.source_number, retry.issue_id,
        retry.comment_id, retry.actor_id, retry.provider_updated_at, retry.body);
      update internal.github_connector_comment_retries pending set status = 'settled', body = null,
        result = coalesce(answer->>'status', 'ignored'), attempt_count = retry.attempt_count + 1,
        next_attempt_at = null, settled_at = clock_timestamp(), last_sqlstate = null
      where (pending.resource_id, pending.delivery_id) = (retry.resource_id, retry.delivery_id);
      settled := settled + 1;
    exception when others then
      get stacked diagnostics retry_error = returned_sqlstate;
      if retry_error in ('55P03', '40P01', '40001') and retry.attempt_count < 7
        and retry.deadline_at > clock_timestamp() then
        update internal.github_connector_comment_retries pending set last_sqlstate = retry_error,
          attempt_count = retry.attempt_count + 1,
          next_attempt_at = least(retry.deadline_at, clock_timestamp() + make_interval(secs => least(300, 5 * (1 << retry.attempt_count))))
        where (pending.resource_id, pending.delivery_id) = (retry.resource_id, retry.delivery_id);
      else
        update internal.github_connector_comment_retries pending set status = 'failed', body = null,
          last_sqlstate = retry_error, attempt_count = retry.attempt_count + 1, next_attempt_at = null,
          settled_at = clock_timestamp()
        where (pending.resource_id, pending.delivery_id) = (retry.resource_id, retry.delivery_id);
        settled := settled + 1;
      end if;
    end;
  end loop;
  return settled;
end;
$$;

revoke all on function public.defer_github_connector_comment(bigint, bigint, bigint, uuid, text, text, integer,
  bigint, bigint, bigint, timestamptz, text), public.drain_github_connector_comment_retries()
  from public, anon, authenticated;
grant execute on function public.defer_github_connector_comment(bigint, bigint, bigint, uuid, text, text, integer,
  bigint, bigint, bigint, timestamptz, text), public.drain_github_connector_comment_retries() to service_role;

-- Capture lifecycle facts in their owning transaction and leave all provider
-- writes to the scoped, recoverable connector outbox.
create function internal.queue_github_connector_notice(
  p_session public.sessions, p_key text, p_kind text, p_body text, p_review_target jsonb default null
) returns void language plpgsql security definer set search_path = '' as $$
begin
  -- The lifecycle transition owns the session lock. Enqueue
  -- without taking deployment locks here; claim rechecks live authority.
  insert into internal.connector_outbound_deliveries (
    workspace_id, factory_id, resource_id, installation_id, session_id, source_id,
    provider, logical_key, operation, content, deadline_at, next_action_at
  )
  select admitted.workspace_id, admitted.factory_id, admitted.resource_id, resource.installation_id,
    source.session_id, source.id, 'github', p_key, 'reply',
    jsonb_build_object('kind', p_kind, 'body', p_body, 'sessionId', p_session.id,
      'workspaceSlug', workspace.slug, 'sessionNumber', p_session.number)
      || case when p_review_target is null then '{}'::jsonb
        else jsonb_build_object('reviewTarget', p_review_target) end,
    clock_timestamp() + interval '24 hours', clock_timestamp()
  from internal.github_connector_work_deliveries admitted
  join public.session_conversation_sources source
    on (source.session_id, source.workspace_id, source.factory_id, source.provider, source.source_namespace, source.external_thread_id) =
      (admitted.session_id, admitted.workspace_id, admitted.factory_id, 'github', admitted.resource_id::text,
        admitted.source_kind || ':' || admitted.source_id::text)
  join public.factory_connector_resources resource
    on (resource.workspace_id, resource.factory_id, resource.id) =
      (admitted.workspace_id, admitted.factory_id, admitted.resource_id)
  join public.workspaces workspace on workspace.id = admitted.workspace_id
  where (admitted.session_id, admitted.disposition) = (p_session.id, 'admitted')
    and workspace.deletion_requested_at is null
  on conflict (workspace_id, factory_id, resource_id, source_id, logical_key) do nothing;
end;
$$;

create function internal.capture_github_connector_notice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  target public.sessions;
  artifact public.session_artifacts;
begin
  case tg_table_name
    when 'github_connector_work_deliveries' then
      select session.* into target from public.sessions session where session.id = new.session_id;
      if found then
        perform internal.queue_github_connector_notice(target, 'github:accepted', 'progress',
          'Wallie accepted this request.');
      end if;
    when 'sessions' then
      if new.phase_status = 'awaiting_review' then
        select current_artifact.* into artifact from public.session_artifacts current_artifact
        where (current_artifact.id, current_artifact.session_id, current_artifact.workspace_id,
          current_artifact.stage_id, current_artifact.version) =
          (new.current_artifact_id, new.id, new.workspace_id, new.current_stage_id, new.current_artifact_version);
        if found then
          perform internal.queue_github_connector_notice(new, 'github:review:' || artifact.id::text, 'review_ready',
            'Wallie published an artifact for review.',
            jsonb_build_object('stageId', artifact.stage_id, 'stageSlug', artifact.stage_slug,
              'artifactId', artifact.id, 'artifactVersion', artifact.version,
              'reviewRevision', new.artifact_review_revision, 'clarificationId', null));
        end if;
      elsif new.phase_status = 'approved' and old.phase_status is distinct from new.phase_status then
        perform internal.queue_github_connector_notice(new, 'github:approved', 'outcome',
          'Wallie completed this session. The final stage was approved.');
      elsif new.phase_status = 'rejected' and new.execution_exhaustion_code is not null then
        perform internal.queue_github_connector_notice(new, 'github:budget-exhausted', 'outcome',
          'Wallie stopped work because of the session execution budget.');
      end if;
  end case;
  return new;
end;
$$;

revoke all on function internal.queue_github_connector_notice(public.sessions, text, text, text, jsonb),
  internal.capture_github_connector_notice() from public, anon, authenticated, service_role;

create trigger capture_github_connector_acceptance after insert on internal.github_connector_work_deliveries
  for each row when (new.disposition = 'admitted') execute function internal.capture_github_connector_notice();
create trigger capture_github_connector_review_or_outcome after update of phase_status, current_artifact_id,
  execution_exhaustion_code on public.sessions
  for each row when (
    ((new.phase_status in ('awaiting_review', 'approved') and
      (new.phase_status, new.current_artifact_id) is distinct from (old.phase_status, old.current_artifact_id))
    or (new.phase_status = 'rejected' and new.execution_exhaustion_code is not null
      and (new.phase_status, new.execution_exhaustion_code) is distinct from (old.phase_status, old.execution_exhaustion_code))))
  execute function internal.capture_github_connector_notice();

create function public.resolve_github_connector_delivery(p_delivery_id uuid, p_lease_id uuid)
returns table (
  github_installation_id bigint, github_repository_id bigint, repository_full_name text,
  source_kind text, source_number integer, source_id bigint, current_review_revision bigint
) language plpgsql security definer set search_path = '' set lock_timeout = '100ms' as $$
declare
  target internal.connector_outbound_deliveries;
  attempt internal.connector_outbound_attempts;
  authority record;
begin
  perform internal.assert_checkpoint_publication_service();
  select delivery.* into target from internal.connector_outbound_deliveries delivery
  where (delivery.id, delivery.lease_id, delivery.provider) = (p_delivery_id, p_lease_id, 'github')
    and delivery.lease_expires_at > clock_timestamp() for share;
  if not found then return; end if;

  select recorded.* into attempt from internal.connector_outbound_attempts recorded
  where (recorded.lease_id, recorded.delivery_id) = (p_lease_id, p_delivery_id)
    and recorded.authorized_at is not null and recorded.settled_at is null;
  if not found then return; end if;

  select * into authority from internal.lock_connector_outbound_authority(target);
  if not found or (authority.installation_generation, authority.mapping_revision) is distinct from
    (attempt.installation_generation, attempt.mapping_revision) or target.lease_expires_at <= clock_timestamp()
  then return; end if;

  return query
    select github.installation_id, repository.repo_id, repository.full_name,
      admitted.source_kind, admitted.source_number, admitted.source_id,
      case when target.content->>'kind' = 'review_ready' and session.phase_status = 'awaiting_review'
        and session.archived_at is null and (session.current_stage_id::text,
          session.current_artifact_id::text, session.current_artifact_version::text) =
          (target.content#>>'{reviewTarget,stageId}', target.content#>>'{reviewTarget,artifactId}',
            target.content#>>'{reviewTarget,artifactVersion}')
        then session.artifact_review_revision end
    from public.session_conversation_sources source
    join public.sessions session on (session.workspace_id, session.factory_id, session.id) =
      (source.workspace_id, source.factory_id, source.session_id)
    join internal.github_connector_work_deliveries admitted
      on (admitted.session_id, admitted.workspace_id, admitted.factory_id, admitted.resource_id) =
        (source.session_id, source.workspace_id, source.factory_id, target.resource_id)
      and admitted.disposition = 'admitted'
      and source.external_thread_id = admitted.source_kind || ':' || admitted.source_id::text
    join internal.connector_installations installation on installation.id = target.installation_id
    join public.github_installations github
      on (github.workspace_id, github.id, github.installation_id::text) =
        (installation.workspace_id, installation.legacy_credential_id, installation.external_installation_id)
    join public.github_repositories repository
      on (repository.workspace_id, repository.factory_id, repository.github_installation_id, repository.repo_id::text) =
        (target.workspace_id, target.factory_id, github.id, authority.external_resource_id)
    where (source.session_id, source.id, source.provider, source.source_namespace) =
      (target.session_id, target.source_id, 'github', target.resource_id::text)
      and not repository.is_archived and not github.suspended;
end;
$$;

revoke all on function public.resolve_github_connector_delivery(uuid, uuid) from public, anon, authenticated;
grant execute on function public.resolve_github_connector_delivery(uuid, uuid) to service_role;
