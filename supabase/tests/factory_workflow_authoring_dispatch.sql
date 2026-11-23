begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65570000
\set op651_open_groups false
\set op651_parallel_only true
\ir fixtures/factory_workflow_branch.psql

create temp table authored_scope as
select scope.*, pg_temp.op651_id(201) as workflow_id, base.id as base_activation_id,
  base.revision_id as base_revision_id, base.digest as base_digest
from op651_scope scope
cross join lateral internal.factory_workflow_authoring_base(scope.workspace_id,scope.factory_id) base;
select public.create_factory_workflow_authoring(
  workspace_id,factory_id,pg_temp.op651_id(1),workflow_id,'Authored fixture workflow'
) from authored_scope;

create function pg_temp.publish_authored(
  first_node text, request_slot integer, expected_draft uuid default null, expected_activation uuid default null
) returns table(draft_id uuid,activation_id uuid,graph_revision_id uuid) language plpgsql as $$
declare
  scope record;
  body text;
  digest text;
  saved jsonb;
  published jsonb;
begin
  select * into strict scope from authored_scope;
  body:=jsonb_build_object('schemaVersion',1,'kind','graph','entryNodeId',first_node,'grants','[]'::jsonb,
    'nodes',jsonb_build_array(jsonb_build_object('id',first_node,'kind','deterministic','operation','checkpoint'),
      jsonb_build_object('id','human.review','kind','human-gate','anyoneCanApprove',false,
        'approverMemberIds',jsonb_build_array(pg_temp.op651_id(21)))),
    'edges',jsonb_build_array(jsonb_build_object('id','next.review','kind','next','from',first_node,'to','human.review')))::text;
  digest:=encode(sha256(convert_to(body,'UTF8')),'hex');
  saved:=public.save_factory_workflow_authoring_draft(
    p_workspace_id=>scope.workspace_id,p_factory_id=>scope.factory_id,p_actor_user_id=>pg_temp.op651_id(1),
    p_workflow_id=>scope.workflow_id,p_request_id=>pg_temp.op651_id(request_slot),
    p_expected_draft_id=>expected_draft,p_expected_activation_id=>expected_activation,
    p_expected_base_activation_id=>scope.base_activation_id,p_expected_base_revision_id=>scope.base_revision_id,
    p_expected_base_digest=>scope.base_digest,p_workflow_json=>body,p_workflow_digest=>digest
  );
  draft_id:=(saved->>'draftId')::uuid;
  published:=public.publish_factory_workflow_authoring_draft(
    p_workspace_id=>scope.workspace_id,p_factory_id=>scope.factory_id,p_actor_user_id=>pg_temp.op651_id(1),
    p_workflow_id=>scope.workflow_id,p_request_id=>pg_temp.op651_id(request_slot+1),
    p_expected_draft_id=>draft_id,p_expected_activation_id=>expected_activation,
    p_expected_base_activation_id=>scope.base_activation_id,p_expected_base_revision_id=>scope.base_revision_id,
    p_expected_base_digest=>scope.base_digest,p_verified_draft_digest=>digest
  );
  activation_id:=(published->>'activationId')::uuid;
  graph_revision_id:=(published->>'graphRevisionId')::uuid;
  return next;
end;
$$;

create temp table authored_version_a as select * from pg_temp.publish_authored('old.checkpoint',202);
create temp table authored_session as
select admitted.*
from authored_scope scope cross join authored_version_a activation
cross join lateral public.create_session_command_once(
  scope.workspace_id,pg_temp.op651_id(21),pg_temp.op651_id(206),repeat('a',64),scope.base_digest,
  'Authored dispatch fixture','Run the selected workflow.','codex','gpt-5.5','{}',
  target_factory_id=>scope.factory_id,
  p_workflow_selection=>jsonb_build_object('workflowId',scope.workflow_id,'activationId',activation.activation_id)
) admitted;
select is(public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(210)),null::jsonb,
  'a queue claim cannot enroll before the exact preparation checkpoint is adopted');
create temp table authored_version_b as
select later.* from authored_version_a version
cross join lateral pg_temp.publish_authored('new.checkpoint',207,version.draft_id,version.activation_id) later;

create temp table preparation as
select session_id,job_id,pg_temp.adopt_source_checkpoint(session_id,job_id) as run_id from authored_session;
select ok((select count(*) = 1 and bool_and(dispatch.artifact_id = parent.current_artifact_id)
  from preparation
  join internal.factory_workflow_authoring_dispatches dispatch
    on (dispatch.session_id,dispatch.input_run_id) = (preparation.session_id,preparation.run_id)
  join public.sessions parent on parent.id = preparation.session_id),
  'preparation adoption atomically records one exact authored handoff');
select throws_ok($$
  select public.approve_session_stage(parent.id,parent.workspace_id,parent.current_stage_id,parent.current_artifact_id,
    parent.current_artifact_version,pg_temp.op651_id(21),'codex','gpt-5.5','code',parent.artifact_review_revision)
  from preparation checkpoint join public.sessions parent on parent.id=checkpoint.session_id
$$,'PT409','The selected workflow is waiting for checkpoint enrollment.',
  'ordinary stage review cannot race ahead of the pending enrollment');

create temp table first_lease as
select public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(210)) as claim;
select ok((select claim->>'nodeId' = 'old.checkpoint'
    and (claim->>'inputRunId')::uuid = preparation.run_id
    and execution.graph_revision_id = original.graph_revision_id
    and execution.graph_revision_id <> later.graph_revision_id
    and execution.graph_input_run_id = preparation.run_id
  from first_lease cross join preparation cross join authored_version_a original cross join authored_version_b later
  join internal.factory_workflow_executions execution on execution.root_session_id = preparation.session_id),
  'durable dispatch enrolls the frozen original graph rather than the newer publication');
select is(public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(210)),
  (select claim from first_lease),'a lost claim response replays the same exact lease');
select is(public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(211)),null::jsonb,
  'another worker cannot claim the same entry while its lease is active');

update internal.factory_workflow_authoring_dispatches dispatch set lease_expires_at=clock_timestamp()-interval '1 second'
from preparation where dispatch.session_id=preparation.session_id;
select is(public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(210)),null::jsonb,
  'the expired lease cannot renew itself');
create temp table resumed_lease as
select public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(211)) as claim;
select ok((select resumed.claim is not null and
    (resumed.claim-'leaseId'-'leaseExpiresAt')=(first.claim-'leaseId'-'leaseExpiresAt')
  from first_lease first cross join resumed_lease resumed),
  'a new worker resumes the original occurrence and existing workflow ownership');
select is((select public.finish_factory_workflow_authoring_dispatch(session_id,run_id,pg_temp.op651_id(210),
  (claim->>'generation')::bigint) from preparation cross join first_lease),'stale',
  'the retired lease cannot finish the entry');

create temp table first_result as
select result.* from resumed_lease lease cross join lateral public.record_factory_workflow_command_result(
  (claim->>'rootSessionId')::uuid,(claim->>'workspaceId')::uuid,(claim->>'factoryId')::uuid,(claim->>'generation')::bigint,
  (claim->>'ownershipToken')::uuid,(claim->>'occurrenceId')::uuid,'checkpoint:'||(claim->>'inputRunId')) result;
select is((select count(*) from first_result where created),1::bigint,
  'the exact retained preparation checkpoint records the existing native command result');
select is((select public.finish_factory_workflow_authoring_dispatch(session_id,run_id,pg_temp.op651_id(211),
  (claim->>'generation')::bigint) from preparation cross join resumed_lease),'retry',
  'a lost reply between result and transition cannot finish a partially advanced entry');

update internal.factory_workflow_authoring_dispatches dispatch set next_attempt_at=clock_timestamp()-interval '1 second'
from preparation where dispatch.session_id=preparation.session_id;
create temp table recovered_lease as
select public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(212)) as claim;
create temp table next_occurrence as
select transition.* from recovered_lease lease cross join first_result saved
cross join lateral public.admit_factory_workflow_next(
  (claim->>'rootSessionId')::uuid,(claim->>'workspaceId')::uuid,(claim->>'factoryId')::uuid,(claim->>'generation')::bigint,
  (claim->>'ownershipToken')::uuid,(claim->>'occurrenceId')::uuid,'next.review',saved.result_id) transition;
select ok((select next.created and occurrence.node_id='human.review' and occurrence.node_kind='human-gate'
  from next_occurrence next join internal.factory_workflow_node_occurrences occurrence on occurrence.occurrence_id=next.target_occurrence_id),
  'recovery advances the selected graph to its independent human gate');
select is((select public.finish_factory_workflow_authoring_dispatch(session_id,run_id,pg_temp.op651_id(212),
  (claim->>'generation')::bigint) from preparation cross join recovered_lease),'complete',
  'only the active lease and durable transition finish the entry');
select is(public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(213)),null::jsonb,
  'completed entries stay out of the dispatch queue');

select ok(not has_function_privilege('authenticated','public.claim_factory_workflow_authoring_dispatch(uuid)','execute')
  and not has_function_privilege('authenticated','public.finish_factory_workflow_authoring_dispatch(uuid,uuid,uuid,bigint)','execute'),
  'only the trusted worker can retrieve or settle workflow dispatch ownership');
select * from finish();
rollback;
