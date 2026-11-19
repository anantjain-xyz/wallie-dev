create function internal.normalize_factory_session_mutation(
  p_operation public.factory_session_mutation_operation, p_payload jsonb
) returns jsonb language plpgsql immutable set search_path = '' as $$
declare intent jsonb; keys text[]; text_fields text[];
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or p_operation is null then
    raise exception 'Invalid session mutation intent.' using errcode = '22023';
  end if;
  case p_operation
    when 'create' then
      keys := array['title', 'prompt', 'agentId', 'repositoryId', 'draftSpecification'];
      text_fields := array['title', 'prompt', 'agentId', 'repositoryId'];
      if (p_payload ? 'draftSpecification' and jsonb_typeof(p_payload->'draftSpecification') <> 'boolean')
        or length(btrim(p_payload->>'title', E' \t\r\n')) not between 1 and 200
        or length(btrim(p_payload->>'prompt', E' \t\r\n')) not between 1 and 20000 then
        raise exception 'Invalid session creation intent.' using errcode = '22023';
      end if;
      intent := jsonb_build_object(
        'title', btrim(p_payload->>'title', E' \t\r\n'), 'prompt', btrim(p_payload->>'prompt', E' \t\r\n'),
        'agentId', (p_payload->>'agentId')::uuid, 'repositoryId', (p_payload->>'repositoryId')::uuid,
        'draftSpecification', coalesce((p_payload->>'draftSpecification')::boolean, false));
    when 'follow_up', 'answer_clarification' then
      keys := array['sessionId', 'artifactId', 'artifactVersion', 'reviewRevision'];
      text_fields := array['sessionId', 'artifactId'];
      if jsonb_typeof(p_payload->'artifactVersion') is distinct from 'number'
        or jsonb_typeof(p_payload->'reviewRevision') is distinct from 'number'
        or (p_payload->>'artifactVersion')::integer < 1 or (p_payload->>'reviewRevision')::bigint < 0 then
        raise exception 'An exact artifact version and review revision are required.' using errcode = '22023';
      end if;
      intent := jsonb_build_object(
        'sessionId', (p_payload->>'sessionId')::uuid, 'artifactId', (p_payload->>'artifactId')::uuid,
        'artifactVersion', (p_payload->>'artifactVersion')::integer,
        'reviewRevision', (p_payload->>'reviewRevision')::bigint);
      if p_operation = 'follow_up' then
        keys := keys || array['stageId', 'feedback'];
        text_fields := text_fields || array['stageId', 'feedback'];
        if length(btrim(p_payload->>'feedback', E' \t\r\n')) not between 1 and 4000 then
          raise exception 'Invalid follow-up feedback.' using errcode = '22023';
        end if;
        intent := intent || jsonb_build_object(
          'stageId', (p_payload->>'stageId')::uuid, 'feedback', btrim(p_payload->>'feedback', E' \t\r\n'));
      else
        keys := keys || array['clarificationId', 'answer'];
        text_fields := text_fields || array['clarificationId', 'answer'];
        if length(btrim(p_payload->>'answer', E' \t\r\n')) not between 1 and 2000 then
          raise exception 'Invalid clarification answer.' using errcode = '22023';
        end if;
        intent := intent || jsonb_build_object('clarificationId', (p_payload->>'clarificationId')::uuid,
          'answer', btrim(p_payload->>'answer', E' \t\r\n'));
      end if;
    when 'cancel' then
      keys := array['sessionId', 'expectedRunId'];
      text_fields := keys;
      intent := jsonb_build_object(
        'sessionId', (p_payload->>'sessionId')::uuid, 'expectedRunId', (p_payload->>'expectedRunId')::uuid);
  end case;
  if p_payload - keys <> '{}'::jsonb
    or exists (select 1 from unnest(text_fields) field where jsonb_typeof(p_payload->field) is distinct from 'string')
    or exists (select 1 from jsonb_each(intent) field where field.value = 'null'::jsonb) then
    raise exception 'Invalid session mutation intent.' using errcode = '22023';
  end if;
  return intent;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'Invalid session mutation intent.' using errcode = '22023';
end;
$$;

-- Both transports delegate the exact generation transition to the canonical
-- cancellation RPC, and carry only committed job/run IDs into provider cleanup.
create function internal.cancel_session_mutation(
  p_actor internal.session_mutation_actor, p_intent jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare
  target public.sessions;
  expected_run_id uuid := (p_intent->>'expectedRunId')::uuid;
  target_session_id uuid := (p_intent->>'sessionId')::uuid;
  canceled record;
  reason text;
begin
  if p_actor.service_principal_id is not null then
    target := internal.lock_machine_session_mutation_target(p_actor, target_session_id);
    reason := 'Stage canceled by an authorized factory client.';
  else
    select * into target from public.sessions session
    where (session.id, session.workspace_id, session.factory_id) =
      (target_session_id, p_actor.workspace_id, p_actor.factory_id)
      and session.github_repository_id is not distinct from p_actor.writer_repository_id
    for no key update;
    if not found then raise exception 'Session not found.' using errcode = 'PT404'; end if;
    reason := 'Stage canceled by a workspace member.';
  end if;

  if target.phase_status <> 'in_progress' or target.archived_at is not null then
    raise exception 'Session is not generating.' using errcode = 'P0003';
  end if;
  select * into strict canceled from public.cancel_session_job_attempts(
    target.id, target.workspace_id, reason, expected_run_id, true);
  if not (expected_run_id = any(canceled.run_ids)) then
    raise exception 'Session generation changed.' using errcode = 'P0003';
  end if;

  insert into public.agent_run_messages (workspace_id, agent_run_id, kind, message_md)
  select target.workspace_id, run.id, 'worker_error', '**Canceled:** ' || reason
  from public.agent_runs run
  where run.workspace_id = target.workspace_id and run.id = any(canceled.run_ids) and run.status = 'canceled';
  return jsonb_build_object('sessionId', target.id, 'jobIds', canceled.job_ids, 'runIds', canceled.run_ids);
end;
$$;

alter function public.cancel_session_command_once(uuid, uuid, uuid, uuid, uuid, text, uuid) set schema internal;
revoke all on function internal.cancel_session_command_once(uuid, uuid, uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;

create function public.cancel_session_command_once(
  target_workspace_id uuid, target_factory_id uuid, actor_member_id uuid, target_session_id uuid,
  target_request_id uuid, target_request_hash text, expected_run_id uuid
) returns table(job_ids uuid[], run_ids uuid[], replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare actor internal.session_mutation_actor; result jsonb; intent jsonb;
begin
  actor := internal.session_mutation_human_actor(target_workspace_id, target_factory_id, actor_member_id, target_session_id);
  if actor.grant_id is null then
    return query select * from internal.cancel_session_command_once(
      target_workspace_id, target_factory_id, actor_member_id, target_session_id,
      target_request_id, target_request_hash, expected_run_id);
    return;
  end if;
  intent := internal.normalize_factory_session_mutation('cancel',
    jsonb_build_object('sessionId', target_session_id, 'expectedRunId', expected_run_id));
  result := internal.find_session_mutation_receipt(actor, 'cancel', target_request_id, intent);
  if result is null then
    result := internal.record_session_mutation_receipt(actor, 'cancel', target_request_id, intent,
      target_session_id, internal.cancel_session_mutation(actor, intent));
  end if;
  return query select
    array(select value::uuid from jsonb_array_elements_text(result->'jobIds') value),
    array(select value::uuid from jsonb_array_elements_text(result->'runIds') value),
    (result->>'replayed')::boolean;
end;
$$;
revoke all on function public.cancel_session_command_once(uuid, uuid, uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.cancel_session_command_once(uuid, uuid, uuid, uuid, uuid, text, uuid)
  to service_role;

create function public.execute_factory_session_mutation(
  p_workspace_id uuid, p_factory_id uuid, p_credential_kind public.factory_command_credential_kind,
  p_credential_id uuid, p_credential_digest text, p_request_id uuid, p_request_hash text, p_surface public.factory_command_surface,
  p_admission_id uuid, p_lease_id uuid, p_operation public.factory_session_mutation_operation, p_request_key uuid, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  admission internal.factory_command_admissions;
  actor internal.session_mutation_actor;
  approved public.factory_execution_grants;
  intent jsonb;
  result jsonb;
begin
  intent := internal.normalize_factory_session_mutation(p_operation, p_payload);
  admission := internal.require_factory_command(p_workspace_id, p_factory_id, p_credential_kind, p_credential_id,
    p_credential_digest, internal.session_mutation_scope(p_operation), p_request_id, p_request_hash,
    p_surface, p_admission_id, p_lease_id);
  select * into strict approved from public.factory_execution_grants grant_row
  where (grant_row.workspace_id, grant_row.factory_id, grant_row.id, grant_row.version) =
    (admission.workspace_id, admission.factory_id, admission.execution_grant_id, admission.execution_grant_version);
  actor := row(admission.workspace_id, admission.factory_id, null, admission.service_principal_id,
    admission.consenting_member_id, approved.id, approved.version, approved.github_repository_id, admission.id
  )::internal.session_mutation_actor;

  result := internal.find_session_mutation_receipt(actor, p_operation, p_request_key, intent);
  if result is null then
    case p_operation
      when 'create' then
        perform internal.assert_no_legacy_machine_creation_key(actor, p_request_key);
        result := internal.create_machine_session(actor, intent);
      when 'follow_up' then result := internal.submit_machine_session_follow_up(actor, intent);
      when 'answer_clarification' then result := internal.answer_machine_session_clarification(actor, intent);
      when 'cancel' then result := internal.cancel_session_mutation(actor, intent);
    end case;
    result := internal.record_session_mutation_receipt(actor, p_operation, p_request_key, intent,
      (result->>'sessionId')::uuid, result);
  end if;
  perform internal.record_factory_command_use(p_admission_id, p_lease_id);
  return result;
end;
$$;

revoke all on function internal.normalize_factory_session_mutation(public.factory_session_mutation_operation, jsonb),
  internal.cancel_session_mutation(internal.session_mutation_actor, jsonb),
  public.execute_factory_session_mutation(uuid, uuid, public.factory_command_credential_kind, uuid, text, uuid, text,
    public.factory_command_surface, uuid, uuid, public.factory_session_mutation_operation, uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.execute_factory_session_mutation(
  uuid, uuid, public.factory_command_credential_kind, uuid, text, uuid, text, public.factory_command_surface,
  uuid, uuid, public.factory_session_mutation_operation, uuid, jsonb
) to service_role;
