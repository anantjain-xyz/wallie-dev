alter table public.workspace_run_retention
  add column context_days integer check (context_days between 1 and 3650);
drop index public.workspace_run_retention_due_idx;
create index workspace_run_retention_due_idx
  on public.workspace_run_retention(last_swept_at asc nulls first, workspace_id)
  where transcript_days is not null or evidence_days is not null or context_days is not null;

drop function public.save_workspace_run_retention(uuid,uuid,integer,integer);

create function public.save_workspace_run_retention(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_transcript_days integer default null,
  p_evidence_days integer default null,
  p_context_days integer default null
) returns public.workspace_run_retention language plpgsql security invoker set search_path = '' as $$
declare
  saved public.workspace_run_retention;
begin
  perform 1 from public.workspaces w
    where w.id = p_workspace_id and w.deletion_requested_at is null for no key update;
  if not found then raise exception 'Workspace is unavailable.' using errcode = 'P0002'; end if;
  perform 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = p_actor_user_id and m.kind = 'human'
      and m.is_active and m.role in ('owner', 'admin') for share;
  if not found then raise exception 'Workspace administrator access is required.' using errcode = '42501'; end if;

  insert into public.workspace_run_retention as current (workspace_id, transcript_days, evidence_days, context_days)
  values (p_workspace_id, p_transcript_days, p_evidence_days, p_context_days)
  on conflict (workspace_id) do update
  set transcript_days = excluded.transcript_days, evidence_days = excluded.evidence_days,
    context_days = excluded.context_days,
    updated_at = clock_timestamp(), last_swept_at = null
  where (current.transcript_days, current.evidence_days, current.context_days)
    is distinct from (excluded.transcript_days, excluded.evidence_days, excluded.context_days)
  returning * into saved;

  if saved.workspace_id is null then
    select * into strict saved from public.workspace_run_retention where workspace_id = p_workspace_id;
  end if;
  return saved;
end;
$$;
revoke all on function public.save_workspace_run_retention(uuid,uuid,integer,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.save_workspace_run_retention(uuid,uuid,integer,integer,integer) to service_role;

-- The digest and byte count survive deletion of the original text.
alter table public.factory_context_source_revisions
  alter column content drop not null,
  alter column content_bytes drop expression,
  alter column content_sha256 drop expression,
  alter column content_bytes set not null,
  alter column content_sha256 set not null,
  add column content_purged_at timestamptz,
  add check (content_bytes between 0 and 131072 and content_sha256 ~ '^[a-f0-9]{64}$'),
  add check (
    (content is null and content_purged_at is not null)
    or (content is not null and content_purged_at is null
      and content_bytes = octet_length(content)
      and content_sha256 = encode(extensions.digest(content, 'sha256'), 'hex'))
  );

create index factory_context_revision_purge_idx
  on public.factory_context_source_revisions(workspace_id, created_at, id)
  where content_purged_at is null;
grant select (content_purged_at) on public.factory_context_source_revisions to authenticated;
create index factory_memory_revision_expiry_idx
  on public.factory_memory_revisions(expires_at, id) where expires_at is not null;

create or replace function public.settle_factory_context_source_sync(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_source_id uuid, p_lease_id uuid,
  p_status text, p_content text default null, p_upstream_revision text default null,
  p_upstream_updated_at timestamptz default null
) returns public.factory_context_sources
language plpgsql security definer set search_path = '' as $$
declare
  source public.factory_context_sources;
  revision_id uuid;
  existing_content text;
  outcome text := p_status;
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into source from public.factory_context_sources target
  where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_source_id)
  for update;
  if not found then raise exception 'Context source not found.' using errcode = 'P0002'; end if;
  if p_lease_id is null or source.sync_lease_id is distinct from p_lease_id
    or source.sync_lease_expires_at <= clock_timestamp() then
    raise exception 'The context sync lease changed or expired.' using errcode = 'PT409';
  end if;

  if p_status is null or p_status not in ('synced', 'unavailable', 'access_revoked', 'upstream_deleted')
    or (p_status = 'synced' and (p_content is null or octet_length(p_content) > 131072
      or p_upstream_revision is null or p_upstream_revision !~ '^[0-9a-f]{40}$'
      or p_upstream_updated_at is null or not isfinite(p_upstream_updated_at)))
    or (p_status <> 'synced' and
      (p_content is not null or p_upstream_revision is not null or p_upstream_updated_at is not null))
  then
    raise exception 'Invalid context sync outcome.' using errcode = '22023';
  end if;

  begin
    perform internal.require_factory_context_connection(
      p_workspace_id, p_factory_id, source.grant_id, source.grant_version, source.repository_id,
      source.github_installation_id, source.upstream_repository_id
    );
  exception when insufficient_privilege then
    outcome := 'access_revoked';
  end;
  if source.sync_lease_expires_at <= clock_timestamp() then
    raise exception 'The context sync lease expired.' using errcode = 'PT409';
  end if;

  if outcome = 'synced' then
    insert into public.factory_context_source_revisions(
      workspace_id, factory_id, source_id, upstream_revision, upstream_updated_at, media_type, content, content_bytes, content_sha256
    ) values (
      p_workspace_id, p_factory_id, source.id, p_upstream_revision, p_upstream_updated_at,
      case when source.file_path ~* '[.]txt$' then 'text/plain' else 'text/markdown' end,
      p_content, octet_length(p_content), encode(extensions.digest(p_content, 'sha256'), 'hex')
    ) on conflict (workspace_id, factory_id, source_id, content_sha256) do nothing
    returning id into revision_id;
    if not found then
      select revision.id, revision.content into strict revision_id, existing_content
      from public.factory_context_source_revisions revision
      where (revision.workspace_id, revision.factory_id, revision.source_id) =
        (p_workspace_id, p_factory_id, source.id)
        and revision.content_sha256 = encode(extensions.digest(p_content, 'sha256'), 'hex');
      if existing_content is null then
        -- A matching body that was already purged cannot be restored by sync.
        revision_id := null;
        outcome := 'unavailable';
      elsif existing_content is distinct from p_content then
        raise exception 'Context revision digest collision.' using errcode = 'PT409';
      end if;
    end if;
  end if;
  if outcome = 'unavailable' and source.current_revision_id is not null then
    outcome := 'stale';
  end if;

  update public.factory_context_sources target set
    status = outcome,
    current_revision_id = case when outcome = 'stale' then source.current_revision_id else revision_id end,
    upstream_revision = case when revision_id is not null then p_upstream_revision else source.upstream_revision end,
    upstream_updated_at = case when revision_id is not null then p_upstream_updated_at else source.upstream_updated_at end,
    last_successful_sync_at = case when revision_id is not null then clock_timestamp() else source.last_successful_sync_at end,
    sync_lease_id = null,
    sync_lease_expires_at = null
  where target.id = source.id returning * into source;
  return source;
end;
$$;

create or replace function public.delete_factory_context_source(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_source_id uuid
) returns public.factory_context_sources
language plpgsql security definer set search_path = '' as $$
declare source public.factory_context_sources;
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  update public.factory_context_sources target set
    status = 'deleted', deleted_at = coalesce(target.deleted_at, clock_timestamp()), current_revision_id = null,
    sync_lease_id = null, sync_lease_expires_at = null
  where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_source_id)
  returning * into source;
  if not found then raise exception 'Context source not found.' using errcode = 'P0002'; end if;
  update public.factory_context_source_revisions revision
  set content = null, content_purged_at = source.deleted_at
  where (revision.workspace_id, revision.factory_id, revision.source_id) =
    (p_workspace_id, p_factory_id, p_source_id) and revision.content is not null;
  return source;
end;
$$;

create or replace function public.read_factory_run_context_revision(
  p_workspace_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer,
  p_source_id uuid, p_revision_id uuid, p_expected_content_sha256 text default null
) returns table (
  status text, file_path text, installation_id bigint, repository_id bigint,
  repository_full_name text, upstream_revision text, content_sha256 text,
  content_bytes integer, stale boolean, content text
)
language plpgsql security definer set search_path = '' as $$
declare
  control internal.git_continuity_release_control;
  owner public.sessions;
  job public.agent_jobs;
  run public.agent_runs;
  admission public.session_factory_admission_inputs;
  source_row public.factory_context_sources;
  connection record;
  revision_metadata record;
  definition jsonb;
  selected_documents jsonb;
  live_grant boolean := true;
  invalid_attempt constant text := 'The worker does not own a current factory context attempt.';
begin
  perform internal.assert_checkpoint_publication_service();
  if p_attempt_count is null or p_attempt_count <= 0 then
    raise exception '%', invalid_attempt using errcode = '42501';
  end if;

  -- Keep the same release → workspace → session → grant → job → run lock
  -- order as attempt-start and model credential lookup. Context resolution
  -- happens before the worker can pin its rendered prompt manifest.
  select * into strict control from internal.git_continuity_release_control where singleton for share;
  perform 1 from public.workspaces workspace
    where workspace.id = p_workspace_id and workspace.deletion_requested_at is null for share;
  if not found then raise exception '%', invalid_attempt using errcode = '42501'; end if;

  select session.* into owner from public.sessions session
  join public.agent_jobs queued on (queued.workspace_id, queued.session_id) = (session.workspace_id, session.id)
  where queued.id = p_job_id and session.workspace_id = p_workspace_id
  for no key update of session;
  if not found or owner.archived_at is not null or owner.phase_status is distinct from 'in_progress'
    or not owner.execute_pinned_definition then
    raise exception '%', invalid_attempt using errcode = '42501';
  end if;

  begin
    perform internal.recheck_session_execution_grant(owner);
  exception when insufficient_privilege or sqlstate 'P0011' then
    live_grant := false;
  end;

  select * into job from public.agent_jobs queued where queued.id = p_job_id for update;
  if not found or (job.workspace_id, job.session_id) is distinct from (owner.workspace_id, owner.id)
    or job.status not in ('started', 'running') or job.attempt_count is distinct from p_attempt_count
    or job.stage_id is null or job.stage_id is distinct from owner.current_stage_id then
    raise exception '%', invalid_attempt using errcode = '42501';
  end if;
  select * into run from public.agent_runs active where active.id = p_run_id for update;
  if not found or run.status is distinct from 'running'
    or (run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count, run.stage_id)
      is distinct from (owner.workspace_id, owner.id, job.id, p_attempt_count, job.stage_id) then
    raise exception '%', invalid_attempt using errcode = '42501';
  end if;
  if not control.enabled or job.git_continuity_release_revision is distinct from control.revision
    or not exists (select 1 from public.session_git_continuity_enrollments enrollment
      where (enrollment.session_id, enrollment.workspace_id) = (owner.id, owner.workspace_id)) then
    raise exception 'Git continuity admission is paused or requires a fresh session.' using errcode = 'P499P';
  end if;

  select * into admission from public.session_factory_admission_inputs input
  where (input.workspace_id, input.factory_id, input.session_id, input.definition_revision_id) =
    (owner.workspace_id, owner.factory_id, owner.id, owner.factory_definition_revision_id);
  if not found or admission.execution_grant_id is null or admission.execution_grant_version is null then
    raise exception '%', invalid_attempt using errcode = '42501';
  end if;

  definition := internal.pinned_session_execution_definition(owner);
  selected_documents := definition->'contextDocuments';
  if jsonb_typeof(selected_documents) is distinct from 'array' then
    status := 'not_selected'; return next; return;
  end if;
  if jsonb_array_length(selected_documents) > 8 or exists (
    select 1 from jsonb_array_elements(selected_documents) document(value)
    group by lower(document.value->>'sourceId') having count(*) > 1
  ) or not exists (
    select 1 from jsonb_array_elements(selected_documents) document(value)
    where document.value = jsonb_build_object('sourceId', p_source_id, 'revisionId', p_revision_id)
  ) then
    status := 'not_selected'; return next; return;
  end if;
  if not live_grant then
    status := 'access_revoked'; return next; return;
  end if;

  select * into source_row from public.factory_context_sources source
  where (source.workspace_id, source.factory_id, source.id) = (owner.workspace_id, owner.factory_id, p_source_id)
  for share;
  if not found then
    status := 'missing_revision'; return next; return;
  end if;
  if (source_row.grant_id, source_row.grant_version) is distinct from
      (admission.execution_grant_id, admission.execution_grant_version) then
    status := 'access_revoked'; return next; return;
  end if;
  if source_row.deleted_at is not null or source_row.current_revision_id is null
    or source_row.status not in ('synced', 'stale') then
    status := 'source_unavailable'; return next; return;
  end if;
  begin
    select * into connection from internal.require_factory_context_connection(
      owner.workspace_id, owner.factory_id, source_row.grant_id, source_row.grant_version,
      source_row.repository_id, source_row.github_installation_id, source_row.upstream_repository_id
    );
  exception when insufficient_privilege then
    status := 'access_revoked'; return next; return;
  end;

  select revision.upstream_revision, revision.content_sha256, revision.content_bytes,
    revision.content_purged_at into revision_metadata
  from public.factory_context_source_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.source_id, revision.id) =
    (owner.workspace_id, owner.factory_id, p_source_id, p_revision_id)
  for share;
  if not found or revision_metadata.content_purged_at is not null then
    status := 'missing_revision'; return next; return;
  end if;
  if p_expected_content_sha256 is not null and p_expected_content_sha256 is distinct from revision_metadata.content_sha256 then
    status := 'revision_changed'; return next; return;
  end if;
  if p_expected_content_sha256 is not null then
    select revision.content into strict content from public.factory_context_source_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.source_id, revision.id) =
      (owner.workspace_id, owner.factory_id, p_source_id, p_revision_id);
  end if;

  status := case when p_expected_content_sha256 is null then 'candidate' else 'selected' end;
  file_path := source_row.file_path;
  installation_id := connection.installation_id;
  repository_id := connection.repository_id;
  repository_full_name := connection.repository_full_name;
  upstream_revision := revision_metadata.upstream_revision;
  content_sha256 := revision_metadata.content_sha256;
  content_bytes := revision_metadata.content_bytes;
  stale := source_row.status = 'stale' or source_row.current_revision_id is distinct from p_revision_id;
  return next;
end;
$$;

-- The workspace retention sweep holds the workspace fence before entering
-- this function. A source's selected current body stays available.
create function internal.purge_factory_retained_context(
  target_workspace uuid, cutoff timestamptz, item_limit integer
) returns void language plpgsql set search_path = '' as $$
begin
  with due as materialized (
    select revision.id
    from public.factory_context_source_revisions revision
    join public.factory_context_sources source on
      (source.workspace_id, source.factory_id, source.id) =
      (revision.workspace_id, revision.factory_id, revision.source_id)
    where revision.workspace_id = target_workspace and revision.content_purged_at is null
      and revision.created_at <= cutoff and source.current_revision_id is distinct from revision.id
    order by revision.created_at, revision.id
    limit item_limit
    for update of revision skip locked
  )
  update public.factory_context_source_revisions revision
  set content = null, content_purged_at = clock_timestamp()
  from due where revision.id = due.id;

  with due as materialized (
    select candidate.run_id
    from internal.factory_run_memory_proposals candidate
    join public.agent_runs run on (run.id, run.workspace_id, run.session_id, run.attempt_count) =
      (candidate.run_id, candidate.workspace_id, candidate.session_id, candidate.attempt_count)
    where candidate.workspace_id = target_workspace and candidate.created_at <= cutoff
      and run.status in ('success', 'error', 'canceled')
    order by candidate.created_at, candidate.run_id
    limit item_limit
    for update of candidate skip locked
  )
  delete from internal.factory_run_memory_proposals candidate
  using due where candidate.run_id = due.run_id;
end;
$$;
revoke all on function internal.purge_factory_retained_context(uuid,timestamptz,integer)
  from public, anon, authenticated, service_role;

create function public.purge_expired_factory_memory_bodies(p_item_limit integer default 50)
returns integer language sql security definer set search_path = '' as $$
  with due as materialized (
    select revision.id
    from public.factory_memory_revisions revision
    join public.factory_memory_revision_bodies body on
      (body.workspace_id, body.factory_id, body.memory_id, body.revision_id) =
      (revision.workspace_id, revision.factory_id, revision.memory_id, revision.id)
    join public.factory_memories memory on (memory.workspace_id, memory.factory_id, memory.id) =
      (revision.workspace_id, revision.factory_id, revision.memory_id)
    join public.workspaces workspace on workspace.id = memory.workspace_id
    where revision.expires_at <= statement_timestamp() and workspace.deletion_requested_at is null
    order by revision.expires_at, revision.id
    limit least(greatest(coalesce(p_item_limit, 50), 1), 100)
    for update of memory skip locked
  ), purged as (
    delete from public.factory_memory_revision_bodies body using due
    where body.revision_id = due.id returning body.revision_id
  )
  select count(*)::integer from purged;
$$;
revoke all on function public.purge_expired_factory_memory_bodies(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.purge_expired_factory_memory_bodies(integer) to service_role;

create function internal.guard_retained_run_context_documents()
returns trigger language plpgsql set search_path = '' as $$
declare
  scope_factory uuid;
begin
  select factory_id into strict scope_factory from public.sessions
  where (workspace_id, id) = (new.workspace_id, new.session_id);
  perform source.id from public.factory_context_sources source
  where (source.workspace_id, source.factory_id) = (new.workspace_id, scope_factory)
    and source.id in (
      select (document->>'sourceId')::uuid from jsonb_array_elements(new.manifest->'documents') document
      where document->>'status' = 'selected'
    )
  order by source.id for share;

  if exists (
    select 1 from jsonb_array_elements(new.manifest->'documents') document
    join public.factory_context_sources source on
      (source.workspace_id, source.factory_id, source.id) =
      (new.workspace_id, scope_factory, (document->>'sourceId')::uuid)
    join public.factory_context_source_revisions revision on
      (revision.workspace_id, revision.factory_id, revision.source_id, revision.id) =
      (source.workspace_id, source.factory_id, source.id, (document->>'revisionId')::uuid)
    where document->>'status' = 'selected'
      and (source.deleted_at is not null or revision.content_purged_at is not null)
  ) then
    raise exception 'A recorded context revision was erased before the run context was frozen.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_retained_run_context_documents()
  from public, anon, authenticated, service_role;
create trigger run_context_documents_admission
  before insert on public.session_run_context_manifests
  for each row execute function internal.guard_retained_run_context_documents();
