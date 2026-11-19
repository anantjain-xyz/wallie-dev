-- Show the identities captured by the same attempt and its admission.
create or replace function internal.get_run_execution_profile(
  target_workspace_id uuid, target_run_id uuid, target_attempt_count integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'provider', attempt.model_provider,
    'model', attempt.model_name,
    'effort', attempt.agent_effort,
    'maxTurns', attempt.max_turns,
    'sandboxProvider', attempt.sandbox_provider,
    'sandboxConnectionRevision', attempt.sandbox_connection_revision,
    'workerRuntime', attempt.worker_runtime,
    'definitionRevisionId', attempt.definition_revision_id,
    'factoryId', owner.factory_id,
    'agentId', run.agent_id,
    'promptRevisionId', run.agent_prompt_revision_id,
    'invokingMemberId', admission.invoking_actor_member_id,
    'triggeredByMemberId', run.triggered_by_member_id,
    'authority', case
      when receipt.run_id is not null then jsonb_build_object(
        'kind', 'service', 'grantId', admission.execution_grant_id,
        'grantVersion', admission.execution_grant_version, 'bindingId', receipt.binding_id,
        'servicePrincipalId', receipt.service_principal_id
      )
      when attempt.credential_owner_member_id is not null and admission.execution_grant_id is null
        then jsonb_build_object('kind', 'human', 'memberId', attempt.credential_owner_member_id)
      else jsonb_build_object('kind', 'unavailable')
    end
  )
  from public.session_attempt_manifests attempt
  join public.agent_runs run
    on (run.id, run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count, run.stage_id,
        run.model_provider, run.model_name) =
       (attempt.run_id, attempt.workspace_id, attempt.session_id, attempt.job_id, attempt.attempt_count,
        attempt.stage_id, attempt.model_provider, attempt.model_name)
  join public.sessions owner on (owner.id, owner.workspace_id) = (run.session_id, run.workspace_id)
  left join public.session_factory_admission_inputs admission
    on (admission.workspace_id, admission.factory_id, admission.session_id, admission.definition_revision_id,
        admission.definition_digest) =
       (attempt.workspace_id, owner.factory_id, attempt.session_id, attempt.definition_revision_id,
        attempt.definition_digest)
  left join public.factory_definition_revisions revision
    on (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
       (admission.workspace_id, admission.factory_id, admission.definition_revision_id, admission.definition_digest)
  left join public.factory_run_credential_receipts receipt
    on (receipt.workspace_id, receipt.factory_id, receipt.session_id, receipt.job_id, receipt.run_id,
        receipt.attempt_count, receipt.agent_provider, receipt.service_principal_id, receipt.binding_id::text) =
       (attempt.workspace_id, owner.factory_id, attempt.session_id, attempt.job_id, attempt.run_id,
        attempt.attempt_count, attempt.model_provider, admission.credential_owner_service_principal_id,
        revision.definition_json::jsonb->>'credentialBindingId')
    and attempt.credential_owner_member_id is null
    and admission.execution_grant_id is not null
  where attempt.workspace_id = target_workspace_id
    and attempt.run_id = target_run_id
    and attempt.attempt_count = target_attempt_count
    and auth.uid() is not null
    and internal.can_access_session(owner.id)
$$;
