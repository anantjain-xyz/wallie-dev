-- The manifest records inputs observed at dispatch. Its definition references
-- describe the admitted revision; its runtime fields describe the actual run.
create table public.session_attempt_manifests (
  run_id uuid primary key references public.agent_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  job_id uuid not null references public.agent_jobs(id) on delete cascade,
  attempt_count integer not null check (attempt_count > 0),
  stage_id uuid not null,
  definition_provenance text not null check (definition_provenance in ('legacy', 'pinned')),
  definition_revision_id uuid,
  definition_digest text check (definition_digest ~ '^[a-f0-9]{64}$'),
  definition_skill_ids text[] not null,
  definition_tool_ids text[] not null,
  definition_execution_policy_revision_id uuid,
  definition_delivery_policy_revision_id uuid,
  execution_policy_revision_id uuid,
  repository_id uuid not null,
  repository_full_name text not null,
  base_branch text not null,
  initial_base_sha text not null check (initial_base_sha ~ '^[a-f0-9]{40}$'),
  input_sha text not null check (input_sha ~ '^[a-f0-9]{40}$'),
  input_ref text,
  source_checkpoint_run_id uuid,
  checkout_sha text not null check (checkout_sha ~ '^[a-f0-9]{40}$'),
  retry_source_run_id uuid,
  prompt_sha256 text not null check (prompt_sha256 ~ '^[a-f0-9]{64}$'),
  prompt_utf8_bytes integer not null check (prompt_utf8_bytes > 0),
  renderer_version integer not null check (renderer_version > 0),
  predecessors jsonb not null check (jsonb_typeof(predecessors) = 'array'),
  worker_runtime text not null check (worker_runtime in ('node', 'workerd')),
  run_type text not null,
  model_provider text not null,
  model_name text not null,
  sandbox_provider text,
  sandbox_connection_revision uuid,
  agent_effort text check (agent_effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  max_turns integer check (max_turns > 0),
  credential_owner_member_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  check ((definition_provenance = 'pinned' and definition_revision_id is not null and definition_digest is not null)
      or (definition_provenance = 'legacy' and definition_revision_id is null and definition_digest is null)),
  check ((retry_source_run_id is null) = (checkout_sha = input_sha))
);
create index session_attempt_manifests_workspace_idx on public.session_attempt_manifests(workspace_id);
create index session_attempt_manifests_session_idx on public.session_attempt_manifests(session_id);
create index session_attempt_manifests_job_idx on public.session_attempt_manifests(job_id);

alter table public.session_attempt_manifests enable row level security;
revoke all on public.session_attempt_manifests from public, anon, authenticated, service_role;
grant select on public.session_attempt_manifests to service_role;
create trigger session_attempt_manifests_immutable before update or delete on public.session_attempt_manifests
  for each row execute function internal.guard_validation_evidence_history();

-- Digest-only prompt evidence avoids duplicating session data or materialized
-- attachments. Credential selectors identify the binding, not its value or
-- whether independently checked runtime authorization will succeed.
comment on table public.session_attempt_manifests is 'Immutable input evidence captured before the agent launches for an owned run attempt.';
comment on column public.session_attempt_manifests.credential_owner_member_id is
  'Exact session owner selector handed to the runner. Current credential authorization remains independent.';

create function public.pin_session_attempt_manifest(
  p_job_id uuid, p_run_id uuid, p_attempt_count integer,
  p_prompt_sha256 text, p_prompt_utf8_bytes integer, p_renderer_version integer,
  p_checkout_sha text, p_predecessors jsonb, p_worker_runtime text,
  p_max_turns integer default null, p_agent_effort text default null,
  p_credential_owner_member_id uuid default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  workspace uuid;
  owner public.sessions;
  job public.agent_jobs;
  execution public.agent_runs;
  pinned public.session_job_git_inputs;
  revision public.factory_definition_revisions;
  definition jsonb;
  prior public.session_attempt_manifests;
  retry_source uuid;
  reference jsonb;
  predecessor_stage uuid;
  predecessor_slug text;
  predecessor_receipt public.session_stage_approval_receipts;
  seen_stages uuid[] := '{}';
  seen_legacy_slugs text[] := '{}';
begin
  perform internal.assert_checkpoint_publication_service();
  select j.workspace_id into workspace from public.agent_jobs j where j.id = p_job_id;
  if not found or p_attempt_count is null or p_attempt_count <= 0 then return false; end if;
  perform 1 from public.workspaces w where w.id = workspace and w.deletion_requested_at is null for share;
  if not found then return false; end if;
  select s.* into owner from public.sessions s join public.agent_jobs j
    on (j.session_id, j.workspace_id) = (s.id, s.workspace_id)
    where j.id = p_job_id and s.workspace_id = workspace for no key update of s;
  if not found or owner.archived_at is not null or owner.phase_status is distinct from 'in_progress'
    or owner.creator_member_id is distinct from p_credential_owner_member_id then return false; end if;
  select * into job from public.agent_jobs j where j.id = p_job_id for update;
  if not found or job.workspace_id is distinct from owner.workspace_id or job.session_id is distinct from owner.id
    or job.status not in ('started', 'running') or job.attempt_count is distinct from p_attempt_count
    or job.stage_id is null or job.stage_id is distinct from owner.current_stage_id then return false; end if;
  select * into execution from public.agent_runs r where r.id = p_run_id for update;
  if not found or execution.status is distinct from 'running' or execution.agent_job_id is distinct from job.id
    or execution.workspace_id is distinct from owner.workspace_id or execution.session_id is distinct from owner.id
    or execution.stage_id is distinct from job.stage_id or execution.attempt_count is distinct from p_attempt_count then return false; end if;
  select * into prior from public.session_attempt_manifests m where m.run_id = p_run_id;
  if found then
    if prior.job_id = job.id and prior.attempt_count = p_attempt_count
      and prior.prompt_sha256 = p_prompt_sha256 and prior.prompt_utf8_bytes = p_prompt_utf8_bytes
      and prior.renderer_version = p_renderer_version and prior.checkout_sha = p_checkout_sha
      and prior.predecessors = p_predecessors and prior.worker_runtime = p_worker_runtime
      and prior.max_turns is not distinct from p_max_turns and prior.agent_effort is not distinct from p_agent_effort
      and prior.credential_owner_member_id is not distinct from p_credential_owner_member_id then return true; end if;
    raise exception 'Attempt inputs have already been pinned.' using errcode = 'PT409';
  end if;
  if p_prompt_sha256 is null or p_prompt_sha256 !~ '^[a-f0-9]{64}$'
    or p_checkout_sha is null or p_checkout_sha !~ '^[a-f0-9]{40}$'
    or p_prompt_utf8_bytes is null or p_prompt_utf8_bytes <= 0
    or p_renderer_version is null or p_renderer_version <= 0
    or p_worker_runtime is null or p_worker_runtime not in ('node', 'workerd')
    or p_max_turns <= 0 or p_agent_effort not in ('low', 'medium', 'high', 'xhigh', 'max')
    or jsonb_typeof(p_predecessors) is distinct from 'array' then
    raise exception 'Invalid attempt input manifest.' using errcode = '23514';
  end if;

  select * into pinned from public.session_job_git_inputs p where p.job_id = job.id
    and (p.session_id, p.workspace_id) = (owner.id, owner.workspace_id);
  if not found or pinned.pinned_run_id is null then
    raise exception 'The attempt has no bound Git input.' using errcode = '23514';
  end if;
  if p_checkout_sha <> pinned.input_sha then
    select checkpoint.source_run_id into retry_source
    from public.session_retry_checkpoint_jobs binding
    join public.session_retry_checkpoints checkpoint
      on (checkpoint.source_run_id, checkpoint.workspace_id) = (binding.source_run_id, binding.workspace_id)
    join public.agent_runs source_run on source_run.id = checkpoint.source_run_id
    where (binding.job_id, binding.workspace_id) = (job.id, owner.workspace_id)
      and (source_run.workspace_id, source_run.session_id, source_run.stage_id) = (owner.workspace_id, owner.id, job.stage_id)
      and source_run.attempt_count = checkpoint.source_attempt_count
      and job.trigger_type = 'manual_retry' and checkpoint.input_sha = pinned.input_sha
      and checkpoint.head_sha = p_checkout_sha;
    if not found then
      raise exception 'The checkout does not match the attempt source input.' using errcode = '23514';
    end if;
  end if;

  -- Only exact approvals still linked to an effective stage completion can
  -- authorize an artifact identity. The captured slug is the renderer's key
  -- and can differ from the live label after a concurrent rename.
  for reference in select value from jsonb_array_elements(p_predecessors) loop
    if jsonb_typeof(reference) is distinct from 'object'
      or not reference ?& array['stageId', 'stageSlug', 'status']
      or jsonb_typeof(reference->'stageSlug') is distinct from 'string'
      or btrim(reference->>'stageSlug') = ''
      or jsonb_typeof(reference->'status') is distinct from 'string'
      or jsonb_typeof(reference->'stageId') not in ('string', 'null')
      or (reference->>'stageId' is not null and reference->>'stageId' !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') then
      raise exception 'Invalid predecessor input identity.' using errcode = '23514';
    end if;
    predecessor_stage := (reference->>'stageId')::uuid;
    predecessor_slug := reference->>'stageSlug';
    if predecessor_stage = any(seen_stages) or predecessor_stage = job.stage_id
      or (predecessor_stage is null and predecessor_slug = any(seen_legacy_slugs)) then
      raise exception 'Invalid predecessor input identity.' using errcode = '23514';
    end if;
    if predecessor_stage is null then
      seen_legacy_slugs := array_append(seen_legacy_slugs, predecessor_slug);
    else
      seen_stages := array_append(seen_stages, predecessor_stage);
    end if;

    select receipt.* into predecessor_receipt from public.session_stage_approval_receipts receipt
    join public.session_phase_completions completion on completion.id = receipt.completion_id
      and (completion.session_id, completion.workspace_id, completion.stage_id) = (receipt.session_id, receipt.workspace_id, receipt.stage_id)
    where (receipt.session_id, receipt.workspace_id, receipt.stage_id) = (owner.id, owner.workspace_id, predecessor_stage)
    order by receipt.approval_number desc limit 1;
    case reference->>'status'
      when 'approved' then
        if not found or predecessor_stage is null
          or not reference ?& array['approvalReceiptId', 'artifactId', 'artifactVersion', 'artifactDigest']
          or (select count(*) from jsonb_object_keys(reference)) <> 7
          or jsonb_typeof(reference->'artifactVersion') is distinct from 'number'
          or reference->>'approvalReceiptId' is distinct from predecessor_receipt.id::text
          or reference->>'artifactId' is distinct from predecessor_receipt.artifact_id::text
          or reference->>'artifactVersion' is distinct from predecessor_receipt.artifact_version::text
          or reference->>'artifactDigest' is distinct from predecessor_receipt.artifact_digest then
          raise exception 'The predecessor is not the exact approved artifact.' using errcode = '23514';
        end if;
      when 'legacy_unverified' then
        if found or (select count(*) from jsonb_object_keys(reference)) <> 3 or not exists (
          select 1 from public.session_phase_completions completion
          where (completion.session_id, completion.workspace_id) = (owner.id, owner.workspace_id)
            and completion.stage_id is not distinct from predecessor_stage
            and (predecessor_stage is not null or completion.stage_slug = predecessor_slug)
        ) then raise exception 'The predecessor has no matching unverified legacy completion.' using errcode = '23514'; end if;
      else raise exception 'Invalid predecessor input identity.' using errcode = '23514';
    end case;
  end loop;

  if owner.factory_definition_provenance = 'pinned' then
    select * into revision from public.factory_definition_revisions d
      where (d.id, d.workspace_id) = (owner.factory_definition_revision_id, owner.workspace_id);
    if not found then raise exception 'The pinned factory definition is unavailable.' using errcode = '23514'; end if;
    definition := revision.definition_json::jsonb;
  end if;
  insert into public.session_attempt_manifests(
    run_id, workspace_id, session_id, job_id, attempt_count, stage_id,
    definition_provenance, definition_revision_id, definition_digest, definition_skill_ids, definition_tool_ids,
    definition_execution_policy_revision_id, definition_delivery_policy_revision_id, execution_policy_revision_id,
    repository_id, repository_full_name, base_branch, initial_base_sha, input_sha, input_ref, source_checkpoint_run_id,
    checkout_sha, retry_source_run_id, prompt_sha256, prompt_utf8_bytes, renderer_version, predecessors,
    worker_runtime, run_type, model_provider, model_name, sandbox_provider, sandbox_connection_revision,
    agent_effort, max_turns, credential_owner_member_id
  ) values (
    execution.id, owner.workspace_id, owner.id, job.id, p_attempt_count, job.stage_id,
    owner.factory_definition_provenance, revision.id, revision.canonical_digest,
    array(select jsonb_array_elements_text(definition->'skillIds')), array(select jsonb_array_elements_text(definition->'toolIds')),
    (definition->>'executionPolicyRevisionId')::uuid, (definition->>'deliveryPolicyRevisionId')::uuid, execution.execution_policy_revision_id,
    pinned.repository_id, pinned.repository_full_name, pinned.base_branch, pinned.initial_base_sha, pinned.input_sha,
    pinned.input_ref, pinned.source_checkpoint_run_id, p_checkout_sha, retry_source,
    p_prompt_sha256, p_prompt_utf8_bytes, p_renderer_version, p_predecessors, p_worker_runtime,
    execution.run_type::text, execution.model_provider, execution.model_name, execution.sandbox_provider,
    execution.sandbox_connection_revision, p_agent_effort, p_max_turns, p_credential_owner_member_id
  );
  return true;
end;
$$;
revoke all on function public.pin_session_attempt_manifest(uuid,uuid,integer,text,integer,integer,text,jsonb,text,integer,text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.pin_session_attempt_manifest(uuid,uuid,integer,text,integer,integer,text,jsonb,text,integer,text,uuid)
  to service_role;
