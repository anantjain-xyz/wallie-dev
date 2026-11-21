create table public.factory_benchmark_task_inputs (
  task_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  source_run_id uuid not null,
  source_session_id uuid not null,
  source_job_id uuid,
  source_attempt_count integer,
  repository_id uuid,
  input_sha text check (input_sha ~ '^[a-f0-9]{40}$'),
  input_ref text,
  checkout_sha text check (checkout_sha ~ '^[a-f0-9]{40}$'),
  source_checkpoint_run_id uuid,
  retry_source_run_id uuid,
  retry_bundle_sha256 text check (retry_bundle_sha256 ~ '^[a-f0-9]{64}$'),
  definition_revision_id uuid,
  definition_digest text check (definition_digest ~ '^[a-f0-9]{64}$'),
  original_prompt_sha256 text check (original_prompt_sha256 ~ '^[a-f0-9]{64}$'),
  rendered_prompt_sha256 text check (rendered_prompt_sha256 ~ '^[a-f0-9]{64}$'),
  renderer_version integer check (renderer_version > 0),
  context_origin_run_id uuid,
  context_manifest_sha256 text check (context_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, factory_id, task_id)
    references public.factory_benchmark_tasks(workspace_id, factory_id, id) on delete cascade
);

alter table public.factory_benchmark_task_inputs enable row level security;
revoke all on public.factory_benchmark_task_inputs from public, anon, authenticated, service_role;
grant select on public.factory_benchmark_task_inputs to service_role;
create trigger preserve_factory_benchmark_task_inputs before update or delete on public.factory_benchmark_task_inputs
  for each row execute function internal.preserve_factory_benchmark_history();

comment on table public.factory_benchmark_task_inputs is
  'Private exact source pointers and digests. Reading source bytes requires current authorization and retention checks.';

create function internal.benchmark_run_context_unavailable_reason(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid, p_manifest jsonb,
  p_grant_id uuid, p_grant_version bigint
) returns text language plpgsql set search_path = '' as $$
declare
  document jsonb;
  source public.factory_context_sources;
begin
  if internal.is_factory_memory_run_context_manifest(p_manifest) is not true then
    return 'The original run context manifest is unavailable.';
  end if;

  for document in
    select item from jsonb_array_elements(p_manifest->'documents') document(item)
    where item->>'status' = 'selected' order by item->>'sourceId'
  loop
    select registered.* into source from public.factory_context_sources registered
    where (registered.workspace_id, registered.factory_id, registered.id) =
      (p_workspace_id, p_factory_id, (document->>'sourceId')::uuid)
    for share;
    if not found or source.deleted_at is not null then
      return 'A recorded context document was deleted or is unavailable.';
    end if;
    if source.status = 'access_revoked' or (source.grant_id, source.grant_version)
      is distinct from (p_grant_id, p_grant_version) then
      return 'Current access to a recorded context document was revoked.';
    end if;
    if source.status not in ('synced', 'stale') or source.current_revision_id is null then
      return 'A recorded context document was deleted or is unavailable.';
    end if;
    begin
      perform 1 from internal.require_factory_context_connection(
        p_workspace_id, p_factory_id, source.grant_id, source.grant_version, source.repository_id,
        source.github_installation_id, source.upstream_repository_id);
    exception when insufficient_privilege then
      return 'Current access to a recorded context document was revoked.';
    end;

    perform 1 from public.factory_context_source_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.source_id, revision.id) =
      (p_workspace_id, p_factory_id, source.id, (document->>'revisionId')::uuid)
      and revision.content_purged_at is null and revision.content_sha256 = document->>'contentSha256'
      and revision.upstream_revision = document->>'upstreamRevision' and source.file_path = document->>'filePath'
    for share;
    if not found then
      return 'A recorded context document revision is missing or changed.';
    end if;
  end loop;

  begin
    perform internal.assert_factory_run_memory_eligible(p_workspace_id, p_session_id, p_manifest, false);
  exception when sqlstate 'PT409' then
    return 'A recorded memory revision is no longer available to this factory.';
  end;
  return null;
end;
$$;
revoke all on function internal.benchmark_run_context_unavailable_reason(uuid, uuid, uuid, jsonb, uuid, bigint)
  from public, anon, authenticated, service_role;

create function public.capture_factory_benchmark_run(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_source_run_id uuid,
  p_acceptance_criteria text, p_task_name text, p_replay_eligibility text, p_suite_id uuid,
  p_eligibility_reason text default null, p_expected_revision_id uuid default null,
  p_new_suite_name text default null, p_new_suite_purpose text default null,
  p_expected_task_revision_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  source_run public.agent_runs;
  source_task public.factory_benchmark_tasks;
  task_revision public.factory_benchmark_task_revisions;
  current_suite public.factory_benchmark_suite_revisions;
  result_suite public.factory_benchmark_suite_revisions;
  pinned_task_revision_id uuid;
  existing_task_revision_ids uuid[];
  evidence record;
  replay_eligibility text := p_replay_eligibility;
  eligibility_reason text := p_eligibility_reason;
  creating_suite boolean := p_new_suite_name is not null;
begin
  perform internal.assert_checkpoint_publication_service();
  -- This lock is shared with task and suite revision writes.
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  if p_suite_id is null or creating_suite <> (p_new_suite_purpose is not null)
    or (creating_suite and p_expected_revision_id is not null) then
    raise exception 'Select an existing suite or provide a new suite name and purpose.' using errcode = '22023';
  end if;

  select * into current_suite from public.factory_benchmark_suite_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.suite_id) = (p_workspace_id, p_factory_id, p_suite_id)
  order by revision.revision_number desc limit 1;
  if not creating_suite and current_suite.id is null then
    raise exception 'Benchmark suite is unavailable in this factory.' using errcode = 'P0002';
  end if;

  select * into source_task from public.factory_benchmark_tasks task
  where (task.workspace_id, task.factory_id, task.source_run_id) = (p_workspace_id, p_factory_id, p_source_run_id);
  select member.task_revision_id into pinned_task_revision_id from public.factory_benchmark_suite_members member
  where (member.suite_revision_id, member.task_id) = (current_suite.id, source_task.id);
  if pinned_task_revision_id is not null then
    -- A retry after a committed add returns the pinned revision even if the source is gone.
    return jsonb_build_object('taskId', source_task.id, 'taskRevisionId', pinned_task_revision_id,
      'suiteId', current_suite.suite_id, 'suiteRevisionId', current_suite.id, 'added', false);
  end if;

  if creating_suite and current_suite.id is not null then
    raise exception 'The new benchmark suite identity is already in use.' using errcode = 'PT409';
  end if;
  if not creating_suite and p_expected_revision_id is distinct from current_suite.id then
    raise exception 'The benchmark suite changed. Reload its revision before saving.' using errcode = 'PT409';
  end if;
  if source_task.id is not null then
    select * into strict task_revision from public.factory_benchmark_task_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.task_id) = (p_workspace_id, p_factory_id, source_task.id)
    order by revision.revision_number desc limit 1;
  end if;
  if p_expected_task_revision_id is distinct from task_revision.id then
    raise exception 'The benchmark task changed. Reload its revision before saving.' using errcode = 'PT409';
  end if;

  select run.* into source_run
  from public.agent_runs run
  join public.sessions session on (session.workspace_id, session.id) = (run.workspace_id, run.session_id)
  where run.id = p_source_run_id and (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id)
  for key share of session, run;
  if not found then
    raise exception 'Source run is unavailable in this factory.' using errcode = 'P0002';
  end if;
  if source_run.status not in ('success', 'error', 'canceled') or source_run.finished_at is null then
    raise exception 'Only completed runs can be captured for benchmarks.' using errcode = 'PT422';
  end if;
  if source_task.id is not null and (
    source_task.source_session_id is distinct from source_run.session_id
    or source_task.source_provenance->>'attempt' is distinct from source_run.attempt_count::text
  ) then
    raise exception 'The retained benchmark task belongs to a different run attempt.' using errcode = 'PT409';
  end if;
  if replay_eligibility is null or replay_eligibility not in ('unverified', 'eligible', 'ineligible')
    or (replay_eligibility = 'ineligible' and nullif(btrim(eligibility_reason), '') is null)
    or (replay_eligibility = 'eligible' and eligibility_reason is not null) then
    raise exception 'Provide a valid benchmark eligibility assessment.' using errcode = '22023';
  end if;

  select manifest.repository_id, manifest.input_sha, manifest.input_ref, manifest.checkout_sha,
    manifest.source_checkpoint_run_id, manifest.retry_source_run_id, retry_bundle.bundle_sha256,
    manifest.definition_revision_id, manifest.definition_digest,
    case when admission.original_prompt_md is not null and definition.id is not null then admission.prompt_sha256 end
      as original_prompt_sha256,
    manifest.prompt_sha256 as rendered_prompt_sha256, manifest.renderer_version,
    context.origin_run_id as context_origin_run_id, context.manifest_sha256 as context_manifest_sha256,
    context.manifest as context_manifest, admission.execution_grant_id, admission.execution_grant_version
  into evidence
  from (values (source_run.id)) captured(run_id)
  left join public.session_attempt_manifests manifest
    on (manifest.run_id, manifest.workspace_id, manifest.session_id, manifest.job_id, manifest.attempt_count) =
      (captured.run_id, source_run.workspace_id, source_run.session_id, source_run.agent_job_id, source_run.attempt_count)
  left join public.factory_definition_revisions definition
    on (definition.id, definition.workspace_id, definition.factory_id, definition.canonical_digest) =
      (manifest.definition_revision_id, p_workspace_id, p_factory_id, manifest.definition_digest)
  left join public.session_factory_admission_inputs admission
    on (admission.session_id, admission.workspace_id, admission.factory_id, admission.definition_revision_id,
        admission.definition_digest) = (source_run.session_id, p_workspace_id, p_factory_id, definition.id,
        definition.canonical_digest)
  left join public.session_run_context_manifests context
    on (context.run_id, context.workspace_id, context.session_id, context.job_id, context.attempt_count) =
      (captured.run_id, source_run.workspace_id, source_run.session_id, source_run.agent_job_id, source_run.attempt_count)
  left join public.session_retry_checkpoint_jobs retry_binding
    on (retry_binding.job_id, retry_binding.workspace_id, retry_binding.source_run_id) =
      (source_run.agent_job_id, p_workspace_id, manifest.retry_source_run_id)
  left join public.session_retry_checkpoints retry_bundle
    on (retry_bundle.source_run_id, retry_bundle.workspace_id, retry_bundle.input_sha, retry_bundle.head_sha) =
      (retry_binding.source_run_id, p_workspace_id, manifest.input_sha, manifest.checkout_sha);

  -- The server checks live retained dependencies. A positive assessment also needs the exact database receipts.
  if replay_eligibility <> 'ineligible' and (
    evidence.checkout_sha is null or evidence.original_prompt_sha256 is null
    or evidence.context_manifest_sha256 is null
    or (evidence.retry_source_run_id is not null and evidence.bundle_sha256 is null)
  ) then
    replay_eligibility := 'ineligible';
    eligibility_reason := 'One or more original run inputs are unavailable.';
  end if;
  if replay_eligibility = 'eligible' and exists (
    select 1 from public.session_attachments attachment
    where (attachment.workspace_id, attachment.session_id) = (p_workspace_id, source_run.session_id)
      and attachment.status = 'attached'
  ) then
    replay_eligibility := 'ineligible';
    eligibility_reason := 'The original session image inputs do not have a retained integrity receipt.';
  end if;
  if replay_eligibility = 'eligible' then
    eligibility_reason := internal.benchmark_run_context_unavailable_reason(p_workspace_id, p_factory_id,
      source_run.session_id, evidence.context_manifest, evidence.execution_grant_id, evidence.execution_grant_version);
    if eligibility_reason is not null then
      replay_eligibility := 'ineligible';
    end if;
  end if;

  if source_task.id is null then
    if nullif(btrim(p_acceptance_criteria), '') is null then
      raise exception 'Benchmark acceptance criteria are required.' using errcode = '22023';
    end if;
    task_revision := public.create_factory_benchmark_task(p_workspace_id, p_factory_id, p_actor_user_id,
      p_source_run_id, p_task_name, p_acceptance_criteria, '{}', replay_eligibility, eligibility_reason);
  elsif (task_revision.replay_eligibility, task_revision.eligibility_reason)
    is distinct from (replay_eligibility, eligibility_reason) then
    task_revision := public.save_factory_benchmark_task_revision(p_workspace_id, p_factory_id, p_actor_user_id,
      source_task.id, task_revision.id, task_revision.name, task_revision.acceptance_criteria, task_revision.tags,
      replay_eligibility, eligibility_reason);
  end if;

  insert into public.factory_benchmark_task_inputs(
    task_id, workspace_id, factory_id, source_run_id, source_session_id, source_job_id, source_attempt_count,
    repository_id, input_sha, input_ref, checkout_sha, source_checkpoint_run_id, retry_source_run_id, retry_bundle_sha256,
    definition_revision_id, definition_digest, original_prompt_sha256, rendered_prompt_sha256, renderer_version,
    context_origin_run_id, context_manifest_sha256
  ) values (
    task_revision.task_id, p_workspace_id, p_factory_id, source_run.id, source_run.session_id,
    source_run.agent_job_id, source_run.attempt_count, evidence.repository_id, evidence.input_sha, evidence.input_ref,
    evidence.checkout_sha, evidence.source_checkpoint_run_id, evidence.retry_source_run_id, evidence.bundle_sha256,
    evidence.definition_revision_id, evidence.definition_digest, evidence.original_prompt_sha256,
    evidence.rendered_prompt_sha256, evidence.renderer_version, evidence.context_origin_run_id, evidence.context_manifest_sha256
  ) on conflict (task_id) do nothing;

  if creating_suite then
    insert into public.factory_benchmark_suites(id, workspace_id, factory_id, created_by)
    values (p_suite_id, p_workspace_id, p_factory_id, p_actor_user_id) on conflict (id) do nothing;
    if not found then
      raise exception 'The new benchmark suite identity is already in use.' using errcode = 'PT409';
    end if;
    insert into public.factory_benchmark_suite_revisions(workspace_id, factory_id, suite_id,
      revision_number, name, purpose, created_by)
    values (p_workspace_id, p_factory_id, p_suite_id, 1, btrim(p_new_suite_name), p_new_suite_purpose, p_actor_user_id)
    returning * into result_suite;
    insert into public.factory_benchmark_suite_members(workspace_id, factory_id, suite_revision_id, task_id, task_revision_id)
    values (p_workspace_id, p_factory_id, result_suite.id, task_revision.task_id, task_revision.id);
  else
    -- A manual addition preserves the exact base membership, even for a tag-selected base revision.
    existing_task_revision_ids := array(
      select member.task_revision_id from public.factory_benchmark_suite_members member
      where member.suite_revision_id = current_suite.id order by member.task_id
    );
    result_suite := public.save_factory_benchmark_suite_revision(p_workspace_id, p_factory_id, p_actor_user_id,
      current_suite.name, current_suite.purpose, p_suite_id, current_suite.id,
      array_append(existing_task_revision_ids, task_revision.id));
  end if;

  return jsonb_build_object('taskId', task_revision.task_id, 'taskRevisionId', task_revision.id,
    'suiteId', result_suite.suite_id, 'suiteRevisionId', result_suite.id, 'added', true);
end;
$$;

revoke all on function public.capture_factory_benchmark_run(uuid, uuid, uuid, uuid, text, text, text, uuid, text, uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.capture_factory_benchmark_run(uuid, uuid, uuid, uuid, text, text, text, uuid, text, uuid, text, text, uuid)
  to service_role;
