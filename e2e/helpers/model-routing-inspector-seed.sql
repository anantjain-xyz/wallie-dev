begin;
set local request.jwt.claim.role = 'service_role';

create function pg_temp.seed_model_routing_inspector(
  p_workspace_id uuid, p_workspace_slug text, p_factory_id uuid,
  p_owner_id uuid, p_stage_id uuid, p_draft_id uuid
) returns jsonb language plpgsql as $$
declare
  member_id uuid;
  draft public.factory_definition_drafts;
  evidence public.factory_routing_draft_evidence;
  repository public.github_repositories;
  original_revision public.factory_definition_revisions;
  renamed_revision public.factory_definition_revisions;
  original_default_factory_id uuid;
  head_number bigint;
  definition jsonb;
  renamed_body text;
  proof record;
  attempt_run_id uuid;
  receipt public.session_factory_admission_inputs;
  class_index integer;
  inspected jsonb;
begin
  select member.id into strict member_id
  from public.workspaces workspace
  join public.workspace_members member on member.workspace_id = workspace.id
  join auth.users actor on actor.id = member.user_id
  where workspace.id = p_workspace_id and workspace.slug = p_workspace_slug
    and workspace.slug ~ '^analytics-proof-[a-f0-9]{12}$'
    and actor.id = p_owner_id and actor.email = workspace.slug || '-owner@example.test'
    and member.kind = 'human' and member.role = 'owner' and member.is_active;

  select * into strict draft from public.factory_definition_drafts candidate
  where (candidate.workspace_id, candidate.factory_id, candidate.id, candidate.created_by) =
    (p_workspace_id, p_factory_id, p_draft_id, p_owner_id);
  select * into strict evidence from public.factory_routing_draft_evidence proposal
  where (proposal.workspace_id, proposal.factory_id, proposal.draft_id) =
    (p_workspace_id, p_factory_id, p_draft_id);
  definition := draft.definition_json::jsonb;
  select * into strict repository from public.github_repositories writer
  where (writer.workspace_id, writer.factory_id, writer.id) =
    (p_workspace_id, p_factory_id, (definition->>'repositoryId')::uuid);
  if definition#>>'{stages,0,id}' is distinct from p_stage_id::text
     or definition#>>'{agent,provider}' is distinct from 'codex' then
    raise exception 'The benchmark proposal did not use the expected fixture stage and harness.';
  end if;

  insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential)
  values (p_owner_id, 'platform_api_key', 'analytics-proof-synthetic-ciphertext')
  on conflict (user_id) do nothing;

  -- The isolated fixture creates an active definition so the production admission
  -- path can make the shadow decision. No sandbox or external credential is used.
  select max(activation.activation_number) into head_number
  from public.factory_definition_activations activation
  where (activation.workspace_id, activation.factory_id) = (p_workspace_id, p_factory_id);
  if head_number is null or draft.base_activation_number is distinct from head_number then
    raise exception 'The disposable routing draft must match the active fixture head.';
  end if;
  insert into public.factory_definition_revisions(workspace_id, factory_id, source_draft_id,
    schema_version, definition_json, canonical_digest, created_by)
  values (p_workspace_id, p_factory_id, draft.id, draft.schema_version, draft.definition_json,
    draft.canonical_digest, p_owner_id)
  returning * into original_revision;
  insert into public.factory_definition_activations(workspace_id, factory_id, revision_id,
    activation_number, created_by)
  values (p_workspace_id, p_factory_id, original_revision.id, head_number + 1, p_owner_id);

  -- Personal-credential session creation uses the workspace's default factory.
  -- Route that intake to the validated fixture factory for this transaction.
  select factory.id into strict original_default_factory_id from public.factories factory
  where factory.workspace_id = p_workspace_id and factory.is_default for update;
  if original_default_factory_id <> p_factory_id then
    update public.factories set is_default = false
    where workspace_id = p_workspace_id and id = original_default_factory_id;
    update public.factories set is_default = true
    where workspace_id = p_workspace_id and id = p_factory_id and slug = 'product-delivery';
    if not found then raise exception 'Unexpected factory for disposable routing admission.'; end if;
  end if;
  select * into strict proof from public.create_session_command_once(
    p_workspace_id, member_id, gen_random_uuid(), repeat('a', 64), original_revision.canonical_digest,
    'Verify historical model routing', 'Use the pinned invoice routing policy.',
    definition#>>'{agent,provider}', definition#>>'{agent,model}', '{}'::uuid[],
    session_github_repository_id => repository.id,
    selected_pipeline_id => (definition->>'pipelineId')::uuid,
    selected_stage_ids => array[p_stage_id], target_factory_id => p_factory_id,
    draft_specification => false
  );
  if original_default_factory_id <> p_factory_id then
    update public.factories set is_default = false
    where workspace_id = p_workspace_id and id = p_factory_id;
    update public.factories set is_default = true
    where workspace_id = p_workspace_id and id = original_default_factory_id;
  end if;
  select * into strict receipt from public.session_factory_admission_inputs admission
  where (admission.workspace_id, admission.factory_id, admission.session_id) =
    (p_workspace_id, p_factory_id, proof.session_id);
  if receipt.routing_decision->>'source' is distinct from 'primary'
     or receipt.routing_decision->>'benchmarkCandidateKey' is distinct from evidence.candidate_key then
    raise exception 'The exact fixture candidate must qualify at admission, received %.',
      receipt.routing_decision->>'reason';
  end if;

  -- Establish an exact local attempt without enabling workers or the global
  -- continuity release. The manifest trigger verifies and links its admission.
  update public.agent_jobs set status = 'running', attempt_count = 1, started_at = clock_timestamp()
  where id = proof.job_id and workspace_id = p_workspace_id;
  select internal.start_session_job_attempt_before_release(proof.job_id, 1, p_stage_id,
    owner.current_artifact_version, receipt.model_provider, receipt.model_name, 'code')
  into strict attempt_run_id from public.sessions owner where owner.id = proof.session_id;
  if attempt_run_id is null then raise exception 'The fixture attempt could not be started.'; end if;

  insert into public.session_attempt_manifests(run_id, workspace_id, session_id, job_id,
    attempt_count, stage_id, definition_provenance, definition_revision_id, definition_digest,
    definition_skill_ids, definition_tool_ids, repository_id, repository_full_name, base_branch,
    initial_base_sha, input_sha, checkout_sha, prompt_sha256, prompt_utf8_bytes, renderer_version,
    predecessors, worker_runtime, run_type, model_provider, model_name, sandbox_provider,
    sandbox_connection_revision, credential_owner_member_id)
  values (attempt_run_id, p_workspace_id, proof.session_id, proof.job_id, 1, p_stage_id,
    'pinned', original_revision.id, original_revision.canonical_digest, '{}', '{}', repository.id,
    repository.full_name, repository.default_branch, repeat('a', 40), repeat('a', 40),
    repeat('a', 40), repeat('b', 64), 24, 3, '[]', 'node', 'code', receipt.model_provider,
    receipt.model_name, definition->>'sandboxProvider',
    internal.factory_connected_sandbox_revision(p_workspace_id, definition->>'sandboxProvider'), member_id);
  update public.agent_runs set status = 'success', finished_at = clock_timestamp()
  where id = attempt_run_id and workspace_id = p_workspace_id;
  update public.agent_jobs set status = 'success', finished_at = clock_timestamp()
  where id = proof.job_id and workspace_id = p_workspace_id;

  select (entry.position - 1)::integer into strict class_index
  from jsonb_array_elements(definition#>'{modelRouting,taskClasses}')
    with ordinality as entry(value, position)
  where entry.value->>'id' = receipt.routing_decision->>'taskClassId';
  renamed_body := jsonb_set(definition, array['modelRouting', 'taskClasses', class_index::text, 'name'],
    to_jsonb('Renamed invoice routing'::text))::text;
  insert into public.factory_definition_revisions(workspace_id, factory_id, schema_version,
    definition_json, canonical_digest, created_by)
  values (p_workspace_id, p_factory_id, original_revision.schema_version, renamed_body,
    encode(sha256(convert_to(renamed_body, 'UTF8')), 'hex'), p_owner_id)
  returning * into renamed_revision;
  insert into public.factory_definition_activations(workspace_id, factory_id, revision_id,
    activation_number, created_by)
  values (p_workspace_id, p_factory_id, renamed_revision.id, head_number + 2, p_owner_id);

  perform set_config('request.jwt.claim.sub', p_owner_id::text, true);
  inspected := public.get_run_routing_decision(p_workspace_id, attempt_run_id, 1);
  if inspected->'decision' is distinct from receipt.routing_decision
     or inspected->>'taskClassName' is distinct from evidence.evidence->>'taskClassName'
     or inspected->'benchmarkEvidence' is distinct from evidence.evidence then
    raise exception 'Inspection did not retain the original policy and benchmark receipt.';
  end if;
  return jsonb_build_object('runId', attempt_run_id, 'policyRevisionId', original_revision.id,
    'renamedRevisionId', renamed_revision.id, 'taskClassName', inspected->>'taskClassName');
end;
$$;

select pg_temp.seed_model_routing_inspector(:'workspace_id', :'workspace_slug', :'factory_id',
  :'owner_id', :'stage_id', :'draft_id');
commit;
