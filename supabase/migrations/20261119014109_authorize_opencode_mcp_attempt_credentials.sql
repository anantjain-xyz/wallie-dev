-- OpenCode uses the same attempt-scoped stdio MCP transport. Keep the
-- existing service-role grant and exact attempt, binding, and material checks.
create or replace function public.resolve_factory_run_mcp_credentials(
  p_workspace_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer
) returns table (
  tool_revision_id uuid, binding_id uuid, material_revision bigint, encrypted_value text
) language plpgsql security definer set search_path = '' as $$
declare
  control internal.git_continuity_release_control;
  owner public.sessions;
  job public.agent_jobs;
  run public.agent_runs;
  admission public.session_factory_admission_inputs;
  attempt public.session_attempt_manifests;
  definition jsonb;
  mcp_manifest jsonb;
  server_entry jsonb;
  revision_id uuid;
  secret_binding_id uuid;
  material public.workspace_secrets;
  prior internal.factory_run_mcp_material_pins;
  unavailable constant text := 'The worker does not own a current scoped MCP attempt.';
begin
  perform internal.assert_checkpoint_publication_service();
  if p_attempt_count is null or p_attempt_count <= 0 then
    raise exception '%', unavailable using errcode = '42501';
  end if;

  -- Match attempt-start and provider credential release lock order.
  select * into strict control from internal.git_continuity_release_control where singleton for share;
  perform 1 from public.workspaces workspace
    where workspace.id = p_workspace_id and workspace.deletion_requested_at is null for share;
  if not found then raise exception '%', unavailable using errcode = '42501'; end if;

  select session.* into owner from public.sessions session
  join public.agent_jobs queued on (queued.workspace_id, queued.session_id) = (session.workspace_id, session.id)
  where queued.id = p_job_id and session.workspace_id = p_workspace_id
  for no key update of session;
  if not found or owner.archived_at is not null or owner.phase_status is distinct from 'in_progress'
    or not owner.execute_pinned_definition then
    raise exception '%', unavailable using errcode = '42501';
  end if;
  -- Rechecks the grant, factory, invoker, tool revisions and scoped secret
  -- bindings. The factory and exact source row locks survive to RPC commit.
  perform internal.recheck_session_execution_grant(owner);

  select * into job from public.agent_jobs queued where queued.id = p_job_id for update;
  if not found or (job.workspace_id, job.session_id) is distinct from (owner.workspace_id, owner.id)
    or job.status not in ('started', 'running') or job.attempt_count is distinct from p_attempt_count
    or job.stage_id is null or job.stage_id is distinct from owner.current_stage_id then
    raise exception '%', unavailable using errcode = '42501';
  end if;
  if owner.pipeline_id is not null and (not control.enabled
    or job.git_continuity_release_revision is distinct from control.revision
    or not exists (select 1 from public.session_git_continuity_enrollments enrollment
      where (enrollment.session_id, enrollment.workspace_id) = (owner.id, owner.workspace_id))) then
    raise exception 'Git continuity admission is paused or requires a fresh session.' using errcode = 'P499P';
  end if;
  select * into run from public.agent_runs active where active.id = p_run_id for update;
  if not found or run.status is distinct from 'running'
    or run.model_provider not in ('codex', 'claude-code', 'opencode')
    or (run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count, run.stage_id)
      is distinct from (owner.workspace_id, owner.id, job.id, p_attempt_count, job.stage_id) then
    raise exception '%', unavailable using errcode = '42501';
  end if;

  select * into admission from public.session_factory_admission_inputs input
  where (input.workspace_id, input.factory_id, input.session_id, input.definition_revision_id) =
    (owner.workspace_id, owner.factory_id, owner.id, owner.factory_definition_revision_id);
  if not found or admission.execution_grant_id is null or admission.credential_owner_service_principal_id is null then
    raise exception '%', unavailable using errcode = '42501';
  end if;
  select * into attempt from public.session_attempt_manifests evidence where evidence.run_id = run.id;
  if not found or attempt.definition_provenance is distinct from 'pinned'
    or attempt.credential_owner_member_id is not null
    or (attempt.workspace_id, attempt.session_id, attempt.job_id, attempt.stage_id, attempt.attempt_count,
        attempt.definition_revision_id, attempt.definition_digest, attempt.model_provider, attempt.model_name)
      is distinct from (owner.workspace_id, owner.id, job.id, job.stage_id, p_attempt_count,
        admission.definition_revision_id, admission.definition_digest, run.model_provider, run.model_name) then
    raise exception '%', unavailable using errcode = '42501';
  end if;
  select revision.definition_json::jsonb into definition from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
    (owner.workspace_id, owner.factory_id, attempt.definition_revision_id, attempt.definition_digest);
  mcp_manifest := definition->'mcpManifest';
  if mcp_manifest is null or to_jsonb(attempt.definition_tool_ids) is distinct from definition->'toolIds'
    or (mcp_manifest->>'agentId', definition#>>'{agent,provider}', definition#>>'{agent,model}')
      is distinct from (run.agent_id::text, run.model_provider, run.model_name) then
    raise exception '%', unavailable using errcode = '42501';
  end if;
  -- The CLI credential is read first. Recheck its current binding before the
  -- last credential RPC authorizes launch, including for public MCP servers.
  perform internal.lock_definition_credential_binding(owner.workspace_id, owner.factory_id, definition,
    admission.execution_grant_id, admission.credential_owner_service_principal_id);

  for server_entry in select value from jsonb_array_elements(mcp_manifest->'servers') with ordinality as server(value, position)
      where value#>>'{auth,kind}' = 'bearer' order by position loop
    revision_id := (server_entry->>'toolRevisionId')::uuid;
    secret_binding_id := (server_entry#>>'{auth,secretBindingId}')::uuid;
    select source.* into material from public.factory_mcp_secret_bindings binding
    join public.workspace_secrets source on (source.workspace_id, source.id) = (binding.workspace_id, binding.workspace_secret_id)
    where (binding.workspace_id, binding.factory_id, binding.id, binding.execution_grant_id,
        binding.service_principal_id, binding.factory_agent_id, binding.tool_revision_id) =
      (owner.workspace_id, owner.factory_id, secret_binding_id, admission.execution_grant_id,
        admission.credential_owner_service_principal_id, run.agent_id, revision_id)
      and binding.revoked_at is null;
    if not found then raise exception '%', unavailable using errcode = '42501'; end if;

    select pin.* into prior from internal.factory_run_mcp_material_pins pin
      where pin.run_id = run.id and pin.tool_revision_id = revision_id;
    if found then
      if (prior.workspace_id, prior.session_id, prior.binding_id, prior.material_revision) is distinct from
        (owner.workspace_id, owner.id, secret_binding_id, material.material_revision) then
        raise exception 'The resolved MCP credential changed within this attempt. Start a new attempt.' using errcode = 'PT409';
      end if;
    else
      insert into internal.factory_run_mcp_material_pins(
        run_id, workspace_id, session_id, tool_revision_id, binding_id, material_revision
      ) values (run.id, owner.workspace_id, owner.id, revision_id, secret_binding_id, material.material_revision);
    end if;
    tool_revision_id := revision_id;
    binding_id := secret_binding_id;
    material_revision := material.material_revision;
    encrypted_value := material.encrypted_value;
    return next;
  end loop;
end;
$$;
