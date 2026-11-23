begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 66010000
\ir fixtures/factory_automation_occurrences.psql
\ir fixtures/factory_workflow_authored_setup.psql
\ir fixtures/factory_workflow_checkpoint_evidence.psql

select ok(has_function_privilege('service_role', 'public.admit_next_factory_automation_occurrence()', 'execute')
  and not has_function_privilege('authenticated', 'public.admit_next_factory_automation_occurrence()', 'execute')
  and has_function_privilege('authenticated', 'public.read_factory_automation_admission_control(uuid,uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.read_factory_automation_admission_control(uuid,uuid,uuid)', 'execute'),
  'only service workers can admit while authenticated managers can read controls');

grant select on automation_occurrence_rule to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select is(public.read_factory_automation_admission_control(workspace_id, factory_id, automation_id),
  jsonb_build_object('automationId', automation_id, 'generation', 0, 'paused', false, 'maxConcurrentSessions', 1),
  'an existing rule begins enabled with one concurrent root') from automation_occurrence_rule;
select set_config('request.jwt.claim.sub', pg_temp.op651_id(2)::text, true);
select is(public.read_factory_automation_admission_control(workspace_id, factory_id, automation_id), null::jsonb,
  'an ordinary workspace member cannot read the rule controls') from automation_occurrence_rule;
reset role;
set local request.jwt.claim.role = 'service_role';
select set_config('request.jwt.claim.sub', pg_temp.op651_id(1)::text, true);

create temp table automation_session_count as
select count(*) as total from public.sessions where workspace_id = pg_temp.op651_id(11);
create temp table first_occurrence as select pg_temp.record_test_occurrence('scheduled-first') as value;
select ok(value->>'status' = 'pending' and (value->>'attemptCount')::integer = 0
  and value->>'sessionId' is null, 'recording commits a pending occurrence without a root or attempt') from first_occurrence;
select is((select count(*) from public.sessions where workspace_id = pg_temp.op651_id(11)), total,
  'pending intake leaves the canonical session queue untouched') from automation_session_count;
select is(pg_temp.configure_test_automation(0, true, 1)->>'generation', '1',
  'a manager can pause with an exact control generation');
select throws_ok($$select pg_temp.configure_test_automation(0, false, 1)$$, 'PT409', null,
  'a stale manager cannot undo another manager’s pause');

with parked as (select public.admit_next_factory_automation_occurrence() as value)
select ok(parked.value->>'status' = 'pending' and parked.value->>'reason' = 'paused'
  and parked.value->>'attemptCount' = '0' and parked.value->>'sessionId' is null
  and parked.value->>'occurrenceId' = recorded.value->>'occurrenceId',
  'a paused claim keeps the exact occurrence pending without charging an attempt')
from parked cross join first_occurrence recorded;
select is(pg_temp.configure_test_automation(1, false, 1)->>'generation', '2', 'the current generation can resume the rule');
create temp table first_admission as select public.admit_next_factory_automation_occurrence() as value;
select ok(admitted.value->>'status' = 'admitted' and admitted.value->>'sessionId' is not null
  and admitted.value->>'mutationReceiptId' is not null and admitted.value->>'revisionId' = original.value->>'revisionId',
  'resumption admits the original occurrence and atomically links the common command receipt')
from first_admission admitted cross join first_occurrence original;

select ok((select session.creator_member_id is null and session.creator_service_principal_id = approved.service_principal_id
  and (session.execution_policy_revision_id, pin.execution_policy_revision_id, pin.execution_grant_id,
    pin.execution_grant_version, pin.invoking_actor_service_principal_id, pin.credential_owner_service_principal_id,
    pin.budget_payer_member_id, pin.definition_revision_id, pinned_definition.definition_json::jsonb->>'credentialBindingId') =
    (approved.execution_policy_revision_id, approved.execution_policy_revision_id, approved.id,
      approved.version, approved.service_principal_id, approved.service_principal_id, approved.budget_payer_member_id,
      revision.revision_id, revision.binding_id::text)
  from first_admission admitted join public.sessions session on session.id = (admitted.value->>'sessionId')::uuid
  join public.session_factory_admission_inputs pin on pin.session_id = session.id
  join public.factory_definition_revisions pinned_definition on pinned_definition.id = pin.definition_revision_id
  cross join op651_grant approved cross join scoped_revisions revision where revision.scenario = 'root'),
  'the common intake pins the exact service principal, grant, credential reference, payer, and execution policy');
select ok(exists (select 1 from first_admission admitted
  join internal.session_mutation_receipts receipt on receipt.id = (admitted.value->>'mutationReceiptId')::uuid
  join public.agent_jobs job on job.session_id = receipt.session_id
  join public.agent_runs run on run.agent_job_id = job.id
  where receipt.request_id = (admitted.value->>'occurrenceId')::uuid
    and receipt.session_id = (admitted.value->>'sessionId')::uuid and receipt.operation = 'create'),
  'the occurrence identity is the canonical session creation request key with a real job and run');
select ok(not exists (select 1 from internal.factory_automation_admission_permits permit
  join first_admission admitted on permit.occurrence_id = (admitted.value->>'occurrenceId')::uuid),
  'a committed admission retains no reusable worker permit');
select throws_ok($$
  delete from internal.factory_automation_occurrences where id = (select (value->>'occurrenceId')::uuid from first_admission)
$$, '23514', null, 'a live workspace cannot delete its settled occurrence history');

create temp table capacity_occurrence as select pg_temp.record_test_occurrence('scheduled-at-capacity') as value;
with outcome as (select public.admit_next_factory_automation_occurrence() as value)
select ok(outcome.value->>'occurrenceId' = recorded.value->>'occurrenceId' and outcome.value->>'status' = 'pending'
  and outcome.value->>'reason' = 'capacity' and outcome.value->>'attemptCount' = '0',
  'a second occurrence parks while the first root consumes the one-session limit')
from outcome cross join capacity_occurrence recorded;
select is(pg_temp.configure_test_automation(2, false, 4)->>'maxConcurrentSessions', '4',
  'a manager can increase the concurrency ceiling without losing pending work');
update internal.factory_automation_occurrences set next_attempt_at = clock_timestamp() - interval '1 second'
where id = (select (value->>'occurrenceId')::uuid from capacity_occurrence);
select is(public.admit_next_factory_automation_occurrence()->>'status', 'admitted',
  'the parked occurrence can start when the configured limit allows another root');

select pg_temp.record_test_occurrence('recorded-before-republish');
create temp table replacement_rule as
select (public.save_factory_automation_draft(workspace_id, factory_id, pg_temp.op651_id(1), automation_id, revision_id,
  jsonb_set(pg_temp.dry_run_definition('schedule'), '{name}', '"Renamed scheduled review"'))->>'draftRevisionId')::uuid as revision_id
from automation_occurrence_rule;
select public.publish_factory_automation(rule.workspace_id, rule.factory_id, pg_temp.op651_id(1), rule.automation_id, replacement.revision_id)
from automation_occurrence_rule rule cross join replacement_rule replacement;

with replay as (select pg_temp.record_test_occurrence('scheduled-first', revision_id) as value from replacement_rule)
select ok(replay.value->>'replayed' = 'true' and (replay.value - 'replayed') = (original.value - 'replayed'),
  'redelivery after republish still returns the original settled session, receipt and immutable revision')
from replay cross join first_admission original;
select is(public.admit_next_factory_automation_occurrence()->>'reason', 'revision_changed',
  'a still-pending occurrence cannot admit against a superseded publication');

select pg_temp.record_test_occurrence('recursive-schedule', replacement.revision_id, (admitted.value->>'sessionId')::uuid)
from replacement_rule replacement cross join first_admission admitted;
select is(public.admit_next_factory_automation_occurrence()->>'reason', 'recursive_event',
  'a factory-created root cannot cause another automated admission');

update public.agent_runs set started_at = clock_timestamp() - interval '61 seconds'
where id = (select run_id from authored_session);
select pg_temp.record_test_occurrence('exhausted-causal-root', replacement.revision_id, creator.session_id)
from replacement_rule replacement cross join authored_session creator;
select is(public.admit_next_factory_automation_occurrence()->>'reason', 'budget_exhausted',
  'claim checks live elapsed execution against the originating human root’s pinned policy');
select is((select execution_exhaustion_code from public.sessions where id = (select session_id from authored_session)),
  'elapsed_execution', 'an exhausted causal root retains the canonical budget denial');

select pg_temp.record_test_occurrence('mismatched-event', p_revision_id => revision_id,
  p_event => '{"kind":"issue-state","stateId":"triage","teamId":null,"projectId":null}') from replacement_rule;
select is(public.admit_next_factory_automation_occurrence()->>'reason', 'event_no_match',
  'admission consumes the same deterministic filter contract as dry run');

create temp table workflow_automation_rule as
select scope.workspace_id, scope.factory_id, scope.workflow_id, activation.activation_id, activation.graph_revision_id,
  (draft.value->>'automationId')::uuid as automation_id, (draft.value->>'draftRevisionId')::uuid as revision_id
from authored_scope scope cross join authored_version_a activation
cross join lateral (select pg_temp.create_dry_run_automation(102, jsonb_set(pg_temp.dry_run_definition('schedule'), '{target}',
  (pg_temp.dry_run_definition('schedule')->'target') || jsonb_build_object('kind', 'workflow',
    'workflowId', scope.workflow_id, 'workflowActivationId', activation.activation_id))) as value) draft;
select public.publish_factory_automation(workspace_id, factory_id, pg_temp.op651_id(1), automation_id, revision_id)
from workflow_automation_rule;
create function pg_temp.record_workflow_occurrence(p_key text) returns jsonb language sql as $$
  select public.record_factory_automation_occurrence(workspace_id, factory_id, automation_id, revision_id, 'schedule', p_key,
    '{"kind":"schedule","scheduledFor":"2026-11-23T09:00:00-08:00"}'::jsonb)
  from workflow_automation_rule
$$;
select pg_temp.record_workflow_occurrence('authored-graph-first');
create temp table workflow_automation_admission as select public.admit_next_factory_automation_occurrence() as value;
select ok(exists (select 1 from workflow_automation_admission admitted
  join internal.factory_workflow_authoring_session_pins pin on pin.session_id = (admitted.value->>'sessionId')::uuid
  cross join workflow_automation_rule rule where (pin.workflow_id, pin.activation_id, pin.graph_revision_id) =
    (rule.workflow_id, rule.activation_id, rule.graph_revision_id)), 'the common create command pins the exact selected workflow');

select pg_temp.adopt_source_checkpoint(job.session_id, job.id) from workflow_automation_admission admitted
join public.agent_jobs job on job.session_id = (admitted.value->>'sessionId')::uuid;
create temp table workflow_automation_dispatch as
select public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(210)) as claim;
select is(claim->>'rootSessionId', (select value->>'sessionId' from workflow_automation_admission),
  'the adopted session starts the native authored graph') from workflow_automation_dispatch;
with exact_session as materialized (
  select session.* from workflow_automation_admission admitted
  join public.sessions session on session.id = (admitted.value->>'sessionId')::uuid
)
select approved.id from exact_session session cross join lateral public.approve_session_stage(
  session.id, session.workspace_id, session.current_stage_id, session.current_artifact_id, session.current_artifact_version,
  pg_temp.op651_id(21), 'codex', 'gpt-5.5', 'code', session.artifact_review_revision) approved;
select ok((select session.phase_status = 'approved' and session.archived_at is not null
  from workflow_automation_admission admitted join public.sessions session on session.id = (admitted.value->>'sessionId')::uuid),
  'preparation is approved and the serial surface is archived while graph work continues');
select pg_temp.record_workflow_occurrence('authored-graph-second');
select is(public.admit_next_factory_automation_occurrence()->>'reason', 'capacity',
  'an archived serial surface still occupies one rule slot while its exact graph has pending work');
create temp table workflow_automation_graph_result as
select result.* from workflow_automation_dispatch dispatched
cross join lateral public.record_factory_workflow_command_result(
  (claim->>'rootSessionId')::uuid, (claim->>'workspaceId')::uuid, (claim->>'factoryId')::uuid,
  (claim->>'generation')::bigint, (claim->>'ownershipToken')::uuid, (claim->>'occurrenceId')::uuid,
  'checkpoint:' || (claim->>'inputRunId')) result;
select ok(result.created and not exists (
    select 1 from internal.factory_workflow_node_occurrences node
    where node.root_session_id = (dispatched.claim->>'rootSessionId')::uuid and not exists (
      select 1 from internal.factory_workflow_node_results recorded
      where (recorded.root_session_id, recorded.occurrence_id) = (node.root_session_id, node.occurrence_id)
    )
  ) and exists (
    select 1 from internal.factory_workflow_authoring_dispatches dispatch
    where dispatch.session_id = (dispatched.claim->>'rootSessionId')::uuid and dispatch.completed_at is null
  ), 'the current node result is committed to the graph before a successor is admitted')
from workflow_automation_graph_result result cross join workflow_automation_dispatch dispatched;
select pg_temp.record_workflow_occurrence('authored-graph-between-result-and-successor');
select is(public.admit_next_factory_automation_occurrence()->>'reason', 'capacity',
  'an unfinished authored dispatch still occupies one rule slot between persisting the result and admitting its successor');

create function pg_temp.test_revoked_binding_admission() returns jsonb language plpgsql as $$
declare outcome jsonb;
begin
  begin
    perform pg_temp.record_test_occurrence('revoked-binding', revision_id) from replacement_rule;
    perform public.revoke_factory_secret_binding(workspace_id, factory_id, pg_temp.op651_id(1), binding_id, 1)
    from scoped_revisions where scenario = 'root';
    outcome := public.admit_next_factory_automation_occurrence();
    raise sqlstate 'P0660';
  exception when sqlstate 'P0660' then
    return outcome;
  end;
end;
$$;
select is(pg_temp.test_revoked_binding_admission()->>'reason', 'invalid_assignment',
  'revoking the credential after intake prevents creation at claim time');

select pg_temp.record_test_occurrence('revoked-grant', revision_id) from replacement_rule;
select public.revoke_factory_execution_grant(workspace_id, factory_id, pg_temp.op651_id(1), id, version,
  'Test claim after execution authority is revoked') from op651_grant;
select is(public.admit_next_factory_automation_occurrence()->>'reason', 'invalid_assignment',
  'revoking the execution grant after intake prevents creation at claim time');
select is(pg_temp.record_test_occurrence('scheduled-first', revision_id)->>'sessionId',
  (select value->>'sessionId' from first_admission), 'revocation preserves the original admitted occurrence receipt')
from replacement_rule;
select is((select count(*) from public.sessions where workspace_id = pg_temp.op651_id(11)), total + 3,
  'only the three eligible occurrences create a session') from automation_session_count;
select is(public.admit_next_factory_automation_occurrence(), null::jsonb, 'no further occurrence is due for work');

select * from finish();
rollback;
