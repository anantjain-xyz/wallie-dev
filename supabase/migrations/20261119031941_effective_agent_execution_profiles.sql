-- Let the worker check connection metadata before admission. This uses the
-- same active human membership and provider namespaces as credential loading.
grant execute on function internal.open_code_model_provider(text) to service_role;

create function public.check_session_agent_credential(
  p_workspace_id uuid, p_creator_member_id uuid, p_agent_provider text, p_agent_model text
) returns text language sql stable security invoker set search_path = '' as $$
  select coalesce((
    select case p_agent_provider
      when 'codex' then (
        select case
          when credential.access_token_expires_at <= statement_timestamp() then 'expired'
          when credential.credential_type = 'chatgpt_auth_json' and credential.auth_reconnect_required
            then 'reconnect_required'
          else 'ready'
        end
        from public.user_codex_credentials credential
        where credential.user_id = member.user_id
      )
      when 'claude-code' then (
        select 'ready'::text from public.user_claude_code_credentials credential
        where credential.user_id = member.user_id
      )
      when 'cursor' then (
        select case
          when credential.reconnect_required then 'reconnect_required'
          when credential.api_key_expires_at <= statement_timestamp() then 'expired'
          else 'ready'
        end
        from public.user_cursor_credentials credential
        where credential.user_id = member.user_id
      )
      when 'opencode' then (
        select case
          when provider.id = 'opencode' then (
            select 'ready'::text from public.user_opencode_credentials credential
            where credential.user_id = member.user_id
          )
          else (
            select 'ready'::text from public.user_opencode_provider_credentials credential
            where (credential.user_id, credential.provider_id) = (member.user_id, provider.id)
          )
        end
        from internal.open_code_model_provider(p_agent_model) provider(id)
      )
    end
    from public.workspace_members member
    where (member.workspace_id, member.id) = (p_workspace_id, p_creator_member_id)
      and member.kind = 'human' and member.is_active
  ), 'missing')
$$;
revoke all on function public.check_session_agent_credential(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.check_session_agent_credential(uuid, uuid, text, text) to service_role;

-- A recorded profile uses immutable attempt inputs and a model credential
-- receipt for the exact admitted service authority. Live settings can change
-- without rewriting the run's evidence.
create function internal.get_run_execution_profile(
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
revoke all on function internal.get_run_execution_profile(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function internal.get_run_execution_profile(uuid, uuid, integer) to authenticated;

create function public.get_run_execution_profile(
  target_workspace_id uuid, target_run_id uuid, target_attempt_count integer
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.get_run_execution_profile(target_workspace_id, target_run_id, target_attempt_count)
$$;
revoke all on function public.get_run_execution_profile(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_run_execution_profile(uuid, uuid, integer) to authenticated;

-- Confirm that the default factory still matches the reviewed digest. An
-- empty expectation confirms there is still no active definition.
create or replace function public.create_confirmed_factory_session_once_with_first_job(
  target_workspace_id uuid, creator_member_id uuid, target_request_id uuid, target_request_hash text,
  expected_factory_definition_digest text, session_title text, session_prompt_md text,
  agent_model_provider text, agent_model_name text, session_attachment_ids uuid[],
  session_linear_issue_id text default null, session_linear_issue_url text default null,
  session_github_repository_id uuid default null, selected_pipeline_id uuid default null,
  selected_stage_ids uuid[] default null, source_session_id uuid default null
)
returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare accepted record; active_digest text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-create:' || target_workspace_id::text || ':' || creator_member_id::text
      || ':' || target_request_id::text, 0));
  select * into accepted from public.find_session_creation_request(
    target_workspace_id, creator_member_id, target_request_id, target_request_hash);
  if found then
    if source_session_id is distinct from (
      select lineage.source_session_id from public.session_restart_lineages lineage
      where (lineage.workspace_id, lineage.session_id) = (target_workspace_id, accepted.session_id)
    ) then
      raise exception 'This creation request was already used for different session input' using errcode = 'P0005';
    end if;
    return query select accepted.session_id::uuid, accepted.session_number::integer,
      accepted.workspace_slug::text, accepted.job_id::uuid, accepted.run_id::uuid;
    return;
  end if;

  perform internal.lock_factory_session_creation_attachments(target_workspace_id, creator_member_id, session_attachment_ids);
  perform internal.assert_workspace_accepts_work(target_workspace_id);
  select revision.canonical_digest into active_digest
  from public.factories factory
  join public.factory_definition_activations activation
    on (activation.workspace_id, activation.factory_id) = (factory.workspace_id, factory.id)
  join public.factory_definition_revisions revision
    on (revision.workspace_id, revision.factory_id, revision.id) =
      (activation.workspace_id, activation.factory_id, activation.revision_id)
  where factory.workspace_id = target_workspace_id and factory.is_default
  order by activation.activation_number desc limit 1;
  if active_digest is distinct from nullif(expected_factory_definition_digest, '') then
    raise exception 'The active factory definition changed.' using errcode = 'P0003';
  end if;

  if source_session_id is null then
    return query select * from public.create_session_once_with_first_job(
      target_workspace_id, creator_member_id, target_request_id, target_request_hash,
      session_title, session_prompt_md, agent_model_provider, agent_model_name, session_attachment_ids,
      session_linear_issue_id, session_linear_issue_url, session_github_repository_id,
      selected_pipeline_id, selected_stage_ids);
  else
    return query select * from public.restart_session_once_with_first_job(
      target_workspace_id, creator_member_id, target_request_id, target_request_hash, source_session_id,
      session_title, session_prompt_md, agent_model_provider, agent_model_name, session_attachment_ids,
      session_linear_issue_id, session_linear_issue_url, session_github_repository_id,
      selected_pipeline_id, selected_stage_ids);
  end if;
end;
$$;
