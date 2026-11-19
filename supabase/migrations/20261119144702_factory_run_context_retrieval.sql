-- The worker first requests metadata to prove current upstream visibility.
-- Only the trusted worker may submit the verified digest for the second read.
-- Neither call can add a document to the run's immutable selection.
create function public.read_factory_run_context_revision(
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

  select revision.upstream_revision, revision.content_sha256, revision.content_bytes into revision_metadata
  from public.factory_context_source_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.source_id, revision.id) =
    (owner.workspace_id, owner.factory_id, p_source_id, p_revision_id)
  for share;
  if not found then
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

revoke all on function public.read_factory_run_context_revision(uuid, uuid, uuid, integer, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.read_factory_run_context_revision(uuid, uuid, uuid, integer, uuid, uuid, text)
  to service_role;
