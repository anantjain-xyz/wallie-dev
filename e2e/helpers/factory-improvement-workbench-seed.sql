begin;
set local request.jwt.claim.role = 'service_role';

\if :{?advance_base}
with head as (
  select activation.*
  from public.factory_definition_activations activation
  where (activation.workspace_id, activation.factory_id) = (:'workspace_id'::uuid, :'factory_id'::uuid)
  order by activation.activation_number desc limit 1
), appended as (
  insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
  select workspace_id, factory_id, revision_id, activation_number + 1, :'owner_id'::uuid from head
  returning activation_number
)
select jsonb_build_object('activationNumber', activation_number) from appended;
commit;
\quit
\endif

create function pg_temp.seed_improvement_workbench(p_workspace_id uuid, p_factory_id uuid, p_owner_id uuid)
returns jsonb language plpgsql as $$
declare
  target internal.factory_failure_cohorts;
  agent public.factory_agent_prompt_revisions;
  head public.factory_definition_activations;
  previous public.factory_definition_revisions;
  pinned public.factory_definition_revisions;
  definition text;
  requested jsonb;
  claim jsonb;
  evidence jsonb;
begin
  while public.process_factory_failure_cohorts(100) > 0 loop
    null;
  end loop;
  select * into strict target from internal.factory_failure_cohorts cohort
  where (cohort.workspace_id, cohort.factory_id, cohort.symptom_kind) = (p_workspace_id, p_factory_id, 'scorer');
  select * into strict agent from public.create_factory_agent(
    p_workspace_id, p_factory_id, p_owner_id, 'Failure reviewer', 'failure-reviewer', 'Explain the retained failures.');

  select activation.* into strict head from public.factory_definition_activations activation
  where (activation.workspace_id, activation.factory_id) = (p_workspace_id, p_factory_id)
  order by activation.activation_number desc limit 1;
  select * into strict previous from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id) = (p_workspace_id, p_factory_id, head.revision_id);
  -- Match the compiler's canonical agent configuration for the inherited scorer fixture.
  definition := jsonb_set(previous.definition_json::jsonb, '{agent,effort}', 'null'::jsonb)::text;
  insert into public.factory_definition_revisions(workspace_id, factory_id, schema_version, definition_json,
    canonical_digest, created_by)
  values (p_workspace_id, p_factory_id, previous.schema_version, definition,
    encode(sha256(convert_to(definition, 'UTF8')), 'hex'), p_owner_id)
  returning * into pinned;
  insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
  values (p_workspace_id, p_factory_id, pinned.id, head.activation_number + 1, p_owner_id);

  requested := public.request_factory_diagnosis(p_workspace_id, p_factory_id, p_owner_id, target.id,
    gen_random_uuid(), agent.id);
  claim := public.claim_factory_diagnosis();
  if claim->>'diagnosis_id' is distinct from requested->>'diagnosis_id'
    or (public.begin_factory_diagnosis(p_workspace_id, p_factory_id, (claim->>'diagnosis_id')::uuid,
      (claim->>'attempt_id')::uuid, (claim->>'lease_id')::uuid, requested->>'evidence_digest')->>'encrypted_api_key') is null
  then raise exception 'The exact improvement browser diagnosis did not start.'; end if;
  evidence := requested#>'{evidence,0}';
  if not public.finish_factory_diagnosis(p_workspace_id, p_factory_id, (claim->>'diagnosis_id')::uuid,
    (claim->>'attempt_id')::uuid, (claim->>'lease_id')::uuid, 'completed',
    jsonb_build_object('version', 1, 'claims', jsonb_build_array(jsonb_build_object(
      'member_ids', jsonb_build_array(evidence->>'member_id'),
      'inferred_cause', 'The reconciliation prompt may omit a required check.',
      'uncertainty', 'One retained evaluation cannot isolate the cause.'))), null, null)
  then raise exception 'The exact improvement browser diagnosis did not settle.'; end if;

  return jsonb_build_object('cohortId', target.id, 'diagnosisId', requested->>'diagnosis_id',
    'evaluationAttemptId', evidence->>'evaluation_attempt_id', 'runId', evidence->>'run_id',
    'sessionId', evidence->>'session_id',
    'stageId', pinned.definition_json::jsonb#>>'{stages,0,id}',
    'expectedPromptSha256', encode(sha256(convert_to(pinned.definition_json::jsonb#>>'{stages,0,promptTemplateMd}', 'UTF8')), 'hex'),
    'base', jsonb_build_object('activationNumber', head.activation_number + 1, 'revisionId', pinned.id, 'digest', pinned.canonical_digest));
end;
$$;

select pg_temp.seed_improvement_workbench(:'workspace_id'::uuid, :'factory_id'::uuid, :'owner_id'::uuid);
commit;
