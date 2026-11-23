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
  first_node text, request_slot integer, expected_draft uuid default null, expected_activation uuid default null,
  first_operation text default 'checkpoint'
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
    'nodes',jsonb_build_array(jsonb_build_object('id',first_node,'kind','deterministic','operation',first_operation),
      jsonb_build_object('id','check.policy','kind','deterministic','operation','policy'),
      jsonb_build_object('id','human.review','kind','human-gate','anyoneCanApprove',false,
        'approverMemberIds',jsonb_build_array(pg_temp.op651_id(21)))),
    'edges',jsonb_build_array(
      jsonb_build_object('id','next.policy','kind','next','from',first_node,'to','check.policy'),
      jsonb_build_object('id','next.review','kind','next','from','check.policy','to','human.review')))::text;
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
create temp table policy_occurrence as
select transition.* from recovered_lease lease cross join first_result saved
cross join lateral public.admit_factory_workflow_next(
  (claim->>'rootSessionId')::uuid,(claim->>'workspaceId')::uuid,(claim->>'factoryId')::uuid,(claim->>'generation')::bigint,
  (claim->>'ownershipToken')::uuid,(claim->>'occurrenceId')::uuid,'next.policy',saved.result_id) transition;
select ok((select next.created and occurrence.node_id='check.policy' and dispatch.input_run_id=checkpoint.run_id
    and dispatch.artifact_id=parent.current_artifact_id
  from policy_occurrence next cross join preparation checkpoint
  join public.sessions parent on parent.id=checkpoint.session_id
  join internal.factory_workflow_node_occurrences occurrence on occurrence.occurrence_id=next.target_occurrence_id
  join internal.factory_workflow_authoring_dispatches dispatch
    on (dispatch.session_id,dispatch.occurrence_id)=(checkpoint.session_id,occurrence.occurrence_id)),
  'native transition admission atomically queues the policy successor with the original adopted input');

-- The entry worker disappears after admission and the successor is delayed.
update internal.factory_workflow_authoring_dispatches dispatch set next_attempt_at=clock_timestamp()+interval '1 minute'
from policy_occurrence next where dispatch.occurrence_id=next.target_occurrence_id;
select is(public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(213)),null::jsonb,
  'a delayed successor and the original active lease both remain ineligible');
update internal.factory_workflow_authoring_dispatches dispatch set next_attempt_at=clock_timestamp()-interval '1 second'
from policy_occurrence next where dispatch.occurrence_id=next.target_occurrence_id;
create temp table policy_lease as
select public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(213)) as claim;
select ok((select claim->>'nodeId'='check.policy' and (claim->>'inputRunId')::uuid=checkpoint.run_id
    and (claim->>'occurrenceId')::uuid=next.target_occurrence_id
  from policy_lease cross join preparation checkpoint cross join policy_occurrence next),
  'another worker claims the delayed successor without a finish call from its predecessor');
select is((select public.finish_factory_workflow_authoring_dispatch(session_id,run_id,pg_temp.op651_id(212),
  (claim->>'generation')::bigint) from preparation cross join recovered_lease),'complete',
  'a predecessor can settle its own receipt while the successor has a separate lease');
select is(public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(213)),
  (select claim from policy_lease),'finishing the original entry preserves the exact successor claim');

create temp table policy_result as
select result.* from policy_lease lease cross join preparation checkpoint
join public.sessions root on root.id=checkpoint.session_id
cross join lateral public.record_factory_workflow_command_result(
  (claim->>'rootSessionId')::uuid,(claim->>'workspaceId')::uuid,(claim->>'factoryId')::uuid,(claim->>'generation')::bigint,
  (claim->>'ownershipToken')::uuid,(claim->>'occurrenceId')::uuid,'policy:'||root.execution_policy_revision_id) result;
select is((select count(*) from policy_result where created),1::bigint,
  'the queued policy step records its checked execution policy');
select is((select public.finish_factory_workflow_authoring_dispatch(session_id,run_id,pg_temp.op651_id(213),
  (claim->>'generation')::bigint) from preparation cross join policy_lease),'retry',
  'a policy result without its transition reschedules only that occurrence');
update internal.factory_workflow_authoring_dispatches dispatch set next_attempt_at=clock_timestamp()-interval '1 second'
from policy_occurrence next where dispatch.occurrence_id=next.target_occurrence_id;
create temp table recovered_policy_lease as
select public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(214)) as claim;
create temp table human_occurrence as
select transition.* from recovered_policy_lease lease cross join policy_result saved
cross join lateral public.admit_factory_workflow_next(
  (claim->>'rootSessionId')::uuid,(claim->>'workspaceId')::uuid,(claim->>'factoryId')::uuid,(claim->>'generation')::bigint,
  (claim->>'ownershipToken')::uuid,(claim->>'occurrenceId')::uuid,'next.review',saved.result_id) transition;
select is((select public.finish_factory_workflow_authoring_dispatch(session_id,run_id,pg_temp.op651_id(214),
  (claim->>'generation')::bigint) from preparation cross join recovered_policy_lease),'complete',
  'resumed policy advancement completes the policy dispatch after saving its human-gate transition');
create temp table human_lease as
select public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(215)) as claim;
select ok((select claim->>'nodeId'='human.review' and (claim->>'inputRunId')::uuid=checkpoint.run_id
    and (claim->>'occurrenceId')::uuid=next.target_occurrence_id
  from human_lease cross join preparation checkpoint cross join human_occurrence next),
  'the next worker receives the independent human gate for the exact original workflow');
select is((select public.finish_factory_workflow_authoring_dispatch(session_id,run_id,pg_temp.op651_id(215),
  (claim->>'generation')::bigint) from preparation cross join human_lease),'retry',
  'a human gate stays pending before approval');

select is((select approved.id from preparation checkpoint join public.sessions root on root.id=checkpoint.session_id
  cross join lateral public.approve_session_stage(root.id,root.workspace_id,root.current_stage_id,root.current_artifact_id,
    root.current_artifact_version,pg_temp.op651_id(21),'codex','gpt-5.5','code',root.artifact_review_revision) approved),
  (select session_id from preparation),'a human approves the exact adopted preparation artifact');
update internal.factory_workflow_authoring_dispatches dispatch set next_attempt_at=clock_timestamp()-interval '1 second'
from human_occurrence next where dispatch.occurrence_id=next.target_occurrence_id;
create temp table approved_human_lease as
select public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(216)) as claim;
select is((select count(*) from approved_human_lease lease cross join preparation checkpoint
  join public.session_stage_approval_receipts approval on approval.session_id=checkpoint.session_id
  cross join lateral public.record_factory_workflow_command_result(
    (claim->>'rootSessionId')::uuid,(claim->>'workspaceId')::uuid,(claim->>'factoryId')::uuid,(claim->>'generation')::bigint,
    (claim->>'ownershipToken')::uuid,(claim->>'occurrenceId')::uuid,'human-gate:'||approval.id) result where result.created),
  1::bigint,'resuming the independent gate records the actual exact human approval');
select is((select public.finish_factory_workflow_authoring_dispatch(session_id,run_id,pg_temp.op651_id(216),
  (claim->>'generation')::bigint) from preparation cross join approved_human_lease),'complete',
  'the final approved gate completes its own dispatch');
select is((select count(*) from internal.factory_workflow_authoring_dispatches dispatch join preparation checkpoint
  on (dispatch.session_id,dispatch.input_run_id)=(checkpoint.session_id,checkpoint.run_id)
  where dispatch.completed_at is not null),3::bigint,'the checkpoint, policy, and human gate each settle one exact row');
select is(public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(217)),null::jsonb,
  'all completed occurrences stay out of the dispatch queue');

create temp table unpinned_source as
select (admitted->>'sessionId')::uuid as session_id,(admitted->>'jobId')::uuid as job_id
from (select pg_temp.op651_create_service_root(218,'An unpinned graph') as admitted) command;
create temp table unpinned_started as
select unpinned.session_id,checkpoint.run_id,scope.workspace_id,scope.factory_id,started.*
from unpinned_source unpinned cross join authored_scope scope cross join authored_version_a version
cross join lateral (select pg_temp.adopt_source_checkpoint(unpinned.session_id,unpinned.job_id) as run_id) checkpoint
cross join lateral public.start_factory_workflow_graph_execution(
  unpinned.session_id,scope.workspace_id,scope.factory_id,version.graph_revision_id,checkpoint.run_id) started;
select is((select count(*) from unpinned_started started
  cross join lateral public.record_factory_workflow_command_result(started.session_id,started.workspace_id,started.factory_id,
    started.execution_generation,started.ownership_token,started.entry_occurrence_id,'checkpoint:'||started.run_id) result
  cross join lateral public.admit_factory_workflow_next(started.session_id,started.workspace_id,started.factory_id,
    started.execution_generation,started.ownership_token,started.entry_occurrence_id,'next.policy',result.result_id) admitted
  where admitted.created),1::bigint,'an unpinned workflow can use its normal native transition');
select is((select count(*) from internal.factory_workflow_authoring_dispatches dispatch join unpinned_started workflow
  on workflow.session_id=dispatch.session_id),0::bigint,'an unpinned graph cannot enter authored dispatch');

create temp table authored_validation_version as
select later.* from authored_version_b version
cross join lateral pg_temp.publish_authored('validation.missing',219,version.draft_id,version.activation_id,'validation') later;
create temp table blocked_preparation as
select admitted.session_id,pg_temp.adopt_source_checkpoint(admitted.session_id,admitted.job_id) as run_id
from authored_scope scope cross join authored_validation_version activation
cross join lateral public.create_session_command_once(
  scope.workspace_id,pg_temp.op651_id(21),pg_temp.op651_id(221),repeat('b',64),scope.base_digest,
  'Authored workflow with a missing prerequisite','Run the selected workflow.','codex','gpt-5.5','{}',
  target_factory_id=>scope.factory_id,
  p_workflow_selection=>jsonb_build_object('workflowId',scope.workflow_id,'activationId',activation.activation_id)
) admitted;
select is(public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(222)),null::jsonb,
  'a missing pinned validation policy prevents enrollment');
select ok((select dispatch.next_attempt_at > clock_timestamp() and dispatch.completed_at is null
  from blocked_preparation source join internal.factory_workflow_authoring_dispatches dispatch
    on (dispatch.session_id,dispatch.input_run_id)=(source.session_id,source.run_id)),
  'a failed enrollment yields without discarding the pending exact artifact');
select throws_ok($$
  select public.approve_session_stage(parent.id,parent.workspace_id,parent.current_stage_id,parent.current_artifact_id,
    parent.current_artifact_version,pg_temp.op651_id(21),'codex','gpt-5.5','code',parent.artifact_review_revision)
  from blocked_preparation source join public.sessions parent on parent.id=source.session_id
$$,'PT409','The selected workflow is waiting for checkpoint enrollment.',
  'approval remains fenced when a prerequisite prevents enrollment');
create temp table preparation_rejection as
with target as materialized (
  select parent.* from blocked_preparation source join public.sessions parent on parent.id=source.session_id
)
select rejected.* from target parent
cross join lateral public.reject_session_stage(parent.id,parent.workspace_id,parent.current_artifact_version,
  'Regenerate the preparation artifact.','codex','gpt-5.5',parent.current_stage_id,parent.current_artifact_id,
  'code',pg_temp.op651_id(21)) rejected;
select ok((select phase_status='rejected' and job_id is not null from preparation_rejection),
  'an authorized reviewer can reject the exact source and queue replacement preparation');
select ok((select dispatch.completed_at is not null and dispatch.lease_id is null
    and pin.activation_id=activation.activation_id
  from blocked_preparation source cross join authored_validation_version activation
  join internal.factory_workflow_authoring_session_pins pin on pin.activation_id=activation.activation_id
  join internal.factory_workflow_authoring_dispatches dispatch
    on (dispatch.session_id,dispatch.input_run_id)=(pin.session_id,source.run_id)
  where pin.session_id=source.session_id),
  'rejection retires the old exact dispatch and preserves the immutable activation pin');
create temp table replacement_preparation as
select rejected.session_id,pg_temp.adopt_source_checkpoint(rejected.session_id,rejected.job_id,
  rejected.current_artifact_version) as run_id from preparation_rejection rejected;
select ok((select dispatch.completed_at is null and dispatch.occurrence_id is null
    and dispatch.artifact_id=parent.current_artifact_id
  from replacement_preparation source join public.sessions parent on parent.id=source.session_id
  join internal.factory_workflow_authoring_dispatches dispatch
    on (dispatch.session_id,dispatch.input_run_id)=(source.session_id,source.run_id)),
  'the replacement source creates its own pending dispatch');

select ok(not has_function_privilege('authenticated','public.claim_factory_workflow_authoring_dispatch(uuid)','execute')
  and not has_function_privilege('authenticated','public.finish_factory_workflow_authoring_dispatch(uuid,uuid,uuid,bigint)','execute'),
  'only the trusted worker can retrieve or settle workflow dispatch ownership');
select * from finish();
rollback;
