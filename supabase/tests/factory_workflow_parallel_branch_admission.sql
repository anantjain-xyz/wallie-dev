begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65110000
\set op651_open_groups true
\set op651_parallel_only false
\ir fixtures/factory_workflow_branch.psql

select is((select count(*) from branch_owner where created), 5::bigint,
  'all roots enroll the verified branch-only graph through the normal enrollment RPC');

select ok(internal.is_bounded_factory_workflow_branch_graph(graph.body::jsonb)
  and not internal.is_bounded_factory_workflow_branch_graph(
    jsonb_set(graph.body::jsonb, '{edges,0,required}', 'false'::jsonb))
  and not internal.is_bounded_factory_workflow_branch_graph(
    jsonb_set(graph.body::jsonb, '{edges,1,to}', '"agent.required"'::jsonb))
  and not internal.is_bounded_factory_workflow_branch_graph(
    jsonb_set(graph.body::jsonb, '{edges,2,kind}', '"next"'::jsonb)),
  'the native topology rejects all-optional slots, duplicate work and generic join routes')
from branch_graphs graph where scenario = 'parallel';

select ok((select count(*) = 2 and count(*) filter (where slot.required) = 1
    and count(distinct slot.child_definition_revision_id) = 2
    and count(distinct slot.branch_result_edge_id) = 2
  from branch_groups opened
  join internal.factory_workflow_branch_groups manifest on manifest.group_id = opened.group_id
  join internal.factory_workflow_branch_slots slot on (slot.root_session_id, slot.group_id) = (manifest.root_session_id, manifest.group_id)
  where opened.scenario = 'parallel'), 'the group freezes both edges, requirement flags, child profiles and result edges');
select ok((select manifest.join_node_id = 'join.finish' and manifest.input_sha = repeat('a',40)
  and manifest.parent_session_id = root."sessionId" and manifest.source_checkpoint_run_id = root.checkpoint_run_id
  from branch_groups opened join branch_owner root using (scenario)
  join internal.factory_workflow_branch_groups manifest on manifest.group_id = opened.group_id
  where opened.scenario = 'parallel'), 'the manifest captures the exact accepted parent and common join');
select ok((select opened.group_id = replay.group_id and not replay.created
  from branch_groups opened cross join pg_temp.open_group('parallel') replay where opened.scenario = 'parallel'),
  'exact open replay returns the immutable group');
select throws_ok($$select * from pg_temp.open_group('parallel',
  (select checkpoint_run_id from branch_owner where scenario = 'bounded'))$$,
  'PT409', 'The branch group already pins a different checkpoint.', 'a sibling root checkpoint cannot replace the manifest');
select throws_ok($$update internal.factory_workflow_branch_slots set required = false where required$$,
  '23514', 'The workflow branch manifest is immutable.', 'a stored requirement flag cannot be changed');
select throws_ok($$select * from pg_temp.admit_slot('parallel', 'run.required',
  (select group_id from branch_groups where scenario = 'bounded'))$$,
  'PT404', 'The workflow branch group is unavailable.', 'a different root cannot borrow an existing group');
select throws_ok($$select * from pg_temp.admit_slot('parallel', 'missing.edge')$$,
  'PT404', 'The workflow branch slot is unavailable.', 'an undeclared slot is rejected');
select is((select count(*) from pg_temp.admit_slot('parallel', 'run.optional')), 0::bigint,
  'optional work waits while a required slot is still unadmitted');

create temp table parallel_slots as select 'run.required'::text as edge_id, slot.*
from pg_temp.admit_slot('parallel', 'run.required') slot;
insert into parallel_slots select 'run.optional', slot.* from pg_temp.admit_slot('parallel', 'run.optional') slot;
select ok((select count(*) = 2 and count(distinct child_session_id) = 2
    and count(distinct job_id) = 2 and count(distinct run_id) = 2 and count(distinct target_occurrence_id) = 2
    and bool_and(created) from parallel_slots), 'both slots have independent child sessions, runs, jobs and occurrences');
select ok((select count(*) = 2 and bool_and(marker.source_checkpoint_run_id = manifest.source_checkpoint_run_id
      and input.source_checkpoint_run_id = manifest.source_checkpoint_run_id
      and input.input_sha = manifest.input_sha and input.input_ref is not distinct from manifest.input_ref
      and marker.source_route_decision_id is null and marker.source_route_occurrence_id is null
      and internal.workflow_session_can_publish_pull_request(marker.child_session_id) is false)
  from parallel_slots admitted
  join internal.factory_workflow_delegations marker using (child_session_id)
  join internal.factory_workflow_branch_slots slot on (slot.root_session_id, slot.slot_id) =
    (marker.root_session_id, marker.source_branch_slot_id)
  join internal.factory_workflow_branch_groups manifest on (manifest.root_session_id, manifest.group_id) =
    (slot.root_session_id, slot.group_id)
  join public.session_job_git_inputs input on input.job_id = admitted.job_id),
  'siblings share the pinned source and use private delegated publication authority');
select ok((select not replay.created and (replay.child_session_id, replay.job_id, replay.run_id, replay.target_occurrence_id) =
    (original.child_session_id, original.job_id, original.run_id, original.target_occurrence_id)
  from pg_temp.admit_slot('parallel', 'run.required') replay
  cross join parallel_slots original where original.edge_id = 'run.required'), 'exact slot replay creates no extra attempt');

create temp table parallel_claims as select job.id
from public.claim_next_agent_job(false, 3, 'node') job;
insert into parallel_claims select job.id from public.claim_next_agent_job(false, 3, 'node') job;
select is((select array_agg(id order by id) from parallel_claims),
  (select array_agg(job_id order by job_id) from parallel_slots),
  'the real root scheduler can claim both siblings before either finishes');
select ok((select count(*) = 2 and bool_and(reservation.attempt_count = 1)
  from parallel_slots slot join internal.factory_workflow_attempt_reservations reservation on reservation.job_id = slot.job_id),
  'each sibling consumes one reservation in the shared root budget');
select ok((select head.checkpoint_run_id = original.checkpoint_run_id from branch_owner original
  join public.session_git_heads head on head.session_id = original."sessionId" where original.scenario = 'parallel'),
  'parallel admission and worker claim leave the parent accepted head unchanged');
select throws_ok($$select * from parallel_slots slot join branch_owner root on root.scenario = 'parallel'
  cross join lateral public.record_factory_workflow_delegated_result(root."sessionId", root.workspace_id,
  root.factory_id, root.execution_generation, root.ownership_token, slot.target_occurrence_id)
  where slot.edge_id = 'run.required'$$, '42501', 'A branch child requires its declared branch outcome.',
  'the routed child command cannot finalize a branch slot');
select throws_ok($$select * from branch_owner root cross join lateral public.record_factory_workflow_node_result(
  root."sessionId", root.workspace_id, root.factory_id, root.execution_generation, root.ownership_token,
  root.entry_occurrence_id, 'succeeded', 'synthetic') where root.scenario = 'parallel'$$,
  '42501', 'This workflow node requires a guarded branch or join result.', 'generic success cannot forge a branch result');

create temp table bounded_required as select * from pg_temp.admit_slot('bounded', 'run.required');
select throws_ok($$select * from pg_temp.admit_slot('bounded', 'run.optional')$$,
  'PT409', 'The workflow root has no remaining child attempt capacity.', 'root concurrency leaves a second slot pending');
select ok((select count(*) = 1
  from branch_owner root join internal.factory_workflow_transition_receipts transition on transition.root_session_id = root."sessionId"
  where root.scenario = 'bounded'), 'reservation failure rolls back its child transition');
select ok((select count(*) = 2 from branch_owner root join internal.factory_workflow_node_occurrences occurrence
  on occurrence.root_session_id = root."sessionId" where root.scenario = 'bounded'),
  'reservation failure leaves no orphan target occurrence');

create temp table canceled_required as select * from pg_temp.admit_slot('canceled', 'run.required');
select is((select public.control_factory_workflow_lifecycle(root."sessionId",root.workspace_id,root.factory_id,
  root.execution_generation,gen_random_uuid(),'cancel')->>'lifecycleStatus'
  from branch_owner root where root.scenario = 'canceled'), 'canceled', 'OP650 cancels the branch root');
select is((select job.status::text from public.agent_jobs job join canceled_required slot on slot.job_id = job.id),
  'canceled', 'root cancellation retires the queued delegated child');
select throws_ok($$select * from pg_temp.admit_slot('canceled','run.optional')$$,
  'PT409', 'Workflow generation is stale.', 'a stale owner cannot schedule a branch after cancellation');
select ok((select count(*) = 1
  from branch_owner root join internal.factory_workflow_delegations marker on marker.root_session_id = root."sessionId"
  where root.scenario = 'canceled'), 'cancellation retains the prior admitted child and creates no sibling');


create function pg_temp.record_slot(p_scenario text, p_edge text, p_job uuid, p_run uuid)
returns table(outcome_id uuid, outcome public.factory_workflow_node_outcome, created boolean) language sql as $$
  select recorded.* from branch_owner root join branch_groups groups using (scenario)
  cross join lateral public.record_factory_workflow_branch_outcome(
    root."sessionId", root.workspace_id, root.factory_id, root.execution_generation,
    root.ownership_token, groups.group_id, p_edge, p_job, 1, p_run
  ) recorded where root.scenario = p_scenario
$$;
create function pg_temp.read_group(p_scenario text) returns jsonb language sql as $$
  select public.read_factory_workflow_branch_group(root."sessionId", root.workspace_id, root.factory_id, groups.group_id)
  from branch_owner root join branch_groups groups using (scenario) where root.scenario = p_scenario
$$;

select is(pg_temp.read_group('parallel')->>'joinStatus', 'pending', 'a running child is not a retained output');
select is(pg_temp.read_group('canceled')->>'joinStatus', 'canceled', 'a canceled group stays visible without satisfying join readiness');
select is(pg_temp.read_group('canceled')#>>'{slots,0,admission,childSessionId}',
  (select child_session_id::text from canceled_required), 'the historical read retains the admitted child after cancellation');
select throws_ok($$select * from parallel_slots sibling cross join lateral pg_temp.record_slot(
  'parallel', 'run.required', sibling.job_id, sibling.run_id) where sibling.edge_id = 'run.optional'$$,
  'PT409', 'The exact current branch attempt is unavailable.', 'a sibling run cannot settle the required slot');


create temp table parallel_accepted as
select slot.*, pg_temp.adopt_branch_code(slot.child_session_id, slot.job_id,
  repeat(case when slot.edge_id = 'run.required' then 'b' else 'c' end, 40)) as checkpoint_run_id
from parallel_slots slot;
select ok((select count(*) = 2 and bool_and(run_id = checkpoint_run_id) from parallel_accepted),
  'both guarded workers adopt private code under their own exact runs');
select is((select count(*) from parallel_accepted child
  cross join lateral pg_temp.record_slot('parallel', child.edge_id, child.job_id, child.run_id)), 0::bigint,
  'an adopted branch still requires its own final approval before publishing a successful output receipt');

select ok((select count(*) = 2 and bool_and(pg_temp.approve_branch(child.child_session_id) = child.child_session_id)
  from parallel_accepted child), 'each approved artifact belongs to its own child rather than the parent');
create temp table parallel_outputs as
select child.edge_id, stored.* from parallel_accepted child
cross join lateral pg_temp.record_slot('parallel', child.edge_id, child.job_id, child.run_id) stored;
select ok((select count(*) = 2 and count(distinct terminal.retained_ref) = 2
    and count(distinct terminal.output_sha) = 2 and bool_and(terminal.outcome = 'succeeded')
    and bool_and(terminal.checkpoint_run_id = child.run_id and terminal.output_sha = checkpoint.output_sha
      and terminal.attempt_input_sha = manifest.input_sha and terminal.retained_ref = checkpoint.output_ref
      and terminal.retained_ref = 'refs/wallie/checkpoints/' || child.run_id || '/' || terminal.output_sha)
  from parallel_outputs recorded join parallel_accepted child using (edge_id)
  join internal.factory_workflow_branch_outcomes terminal on terminal.outcome_id = recorded.outcome_id
  join public.session_git_checkpoints checkpoint on checkpoint.run_id = terminal.checkpoint_run_id
  join internal.factory_workflow_branch_slots slot on slot.slot_id = terminal.slot_id
  join internal.factory_workflow_branch_groups manifest on manifest.group_id = slot.group_id),
  'both retained outputs identify the same frozen base and their own exact checkpoint, ref, and SHA');
select ok((select not replay.created and replay.outcome_id = first.outcome_id
  from parallel_outputs first join parallel_accepted child using (edge_id)
  cross join lateral pg_temp.record_slot('parallel', child.edge_id, child.job_id, child.run_id) replay
  where first.edge_id = 'run.required'), 'the exact terminal attempt replays the same output receipt');
select throws_ok($$select * from parallel_slots sibling cross join lateral pg_temp.record_slot(
  'parallel', 'run.required', sibling.job_id, sibling.run_id) where sibling.edge_id = 'run.optional'$$,
  'PT409', 'The branch slot already has a different terminal attempt.', 'terminal replay rejects a sibling attempt');
select is(pg_temp.read_group('parallel')->>'joinStatus', 'ready', 'two retained successes make the running group eligible for a later join');
select ok((select head.checkpoint_run_id = root.checkpoint_run_id and checkpoint.output_sha = repeat('a', 40)
  from branch_owner root join public.session_git_heads head on head.session_id = root."sessionId"
  join public.session_git_checkpoints checkpoint on checkpoint.run_id = head.checkpoint_run_id
  where root.scenario = 'parallel'), 'the two child adoptions never overwrite the parent head');
select is((select count(*) from branch_owner root join internal.factory_workflow_node_occurrences occurrence
  on occurrence.root_session_id = root."sessionId" where occurrence.node_kind = 'join'),
  0::bigint, 'recording a ready group does not admit a join');
select is((select count(*) from public.session_pr_sync sync
  join parallel_accepted child on child.child_session_id = sync.session_id),
  0::bigint, 'neither child creates a canonical pull-request synchronization target');

create function pg_temp.start_branch_for_outcome(p_job_id uuid) returns uuid language plpgsql as $$
declare execution_id uuid;
begin
  update public.agent_jobs set status = 'running', attempt_count = 1,
    git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
  where id = p_job_id and status = 'queued';
  execution_id := public.start_session_job_attempt(p_job_id, 1, pg_temp.op651_id(32), 0,
    'codex', 'gpt-5.5', 'code', 'wallie/op651-branch-terminal-' || p_job_id);
  if execution_id is null then raise exception 'The terminal branch fixture did not start.'; end if;
  return execution_id;
end;
$$;
select is((select pg_temp.start_branch_for_outcome(job_id) from bounded_required),
  (select run_id from bounded_required), 'the capacity fixture starts its only required attempt');
select is((select public.fail_session_job_attempt(child.job_id, 1, 'Branch fixture failure', false, 0, child.run_id)
  from bounded_required child), 'error', 'the native worker records a permanent required failure');
select is((select outcome::text from bounded_required child cross join lateral
  pg_temp.record_slot('bounded', 'run.required', child.job_id, child.run_id)),
  'failed', 'the immutable required failure retains its exact terminal attempt without a checkpoint');
select is(pg_temp.read_group('bounded')->>'joinStatus', 'required_blocked',
  'required failure blocks a join while an optional slot is unresolved');
create temp table bounded_optional as select * from pg_temp.admit_slot('bounded', 'run.optional');
select is((select pg_temp.adopt_source_checkpoint(child_session_id, job_id) from bounded_optional),
  (select run_id from bounded_optional), 'the deferred optional slot acquires capacity after the failed sibling exits');
select pg_temp.approve_branch(child_session_id) from bounded_optional;
select is((select outcome::text from bounded_optional child cross join lateral
  pg_temp.record_slot('bounded', 'run.optional', child.job_id, child.run_id)),
  'succeeded', 'optional success is visible beside the required failure');
select is(pg_temp.read_group('bounded')->>'joinStatus', 'required_blocked',
  'optional success cannot cover the failed required branch');
select is(pg_temp.read_group('bounded')#>>'{slots,0,outcome,checkpoint_run_id}', null,
  'a required failure has no fabricated checkpoint');

create temp table partial_required as select * from pg_temp.admit_slot('partial', 'run.required');
create temp table partial_optional as select * from pg_temp.admit_slot('partial', 'run.optional');
select is((select pg_temp.adopt_source_checkpoint(child_session_id, job_id) from partial_required),
  (select run_id from partial_required), 'the partial fixture adopts its required output');
select pg_temp.approve_branch(child_session_id) from partial_required;
select outcome from partial_required child cross join lateral
  pg_temp.record_slot('partial', 'run.required', child.job_id, child.run_id);
savepoint optional_canceled_before_claim;
select public.cancel_session_job_attempts(child.child_session_id, root.workspace_id, 'Cancel queued optional work', child.run_id, false)
from partial_optional child cross join branch_owner root where root.scenario = 'partial';
select is((select public.advance_factory_workflow_branch_occurrence(root."sessionId",root.workspace_id,root.factory_id,
    root.execution_generation,root.ownership_token,root.entry_occurrence_id)->>'joinStatus'
  from branch_owner root where root.scenario = 'partial'), 'optional_failure',
  'the dispatcher exposes a queued optional cancellation without waiting for a run');
select ok((select outcome.outcome = 'canceled' and not outcome.run_started and outcome.attempt_count = 0
    and outcome.run_id = child.run_id and outcome.checkpoint_run_id is null and outcome.artifact_id is null
  from partial_optional child join internal.factory_workflow_branch_outcomes outcome on outcome.job_id = child.job_id),
  'the exact queued placeholder remains a cancellation receipt without any execution proof');
rollback to optional_canceled_before_claim;

savepoint optional_canceled_after_claim;
create temp table canceled_optional_claim as select job.id, job.attempt_count
from public.claim_next_agent_job(false, 3, 'node') job;
select ok((select claim.id = child.job_id and claim.attempt_count = 1 from canceled_optional_claim claim cross join partial_optional child),
  'the normal worker claims the optional slot before binding its first run');
select public.cancel_session_job_attempts(child.child_session_id, root.workspace_id, 'Cancel claimed optional work', child.run_id, false)
from partial_optional child cross join branch_owner root where root.scenario = 'partial';
select is((select public.advance_factory_workflow_branch_occurrence(root."sessionId",root.workspace_id,root.factory_id,
    root.execution_generation,root.ownership_token,root.entry_occurrence_id)->>'joinStatus'
  from branch_owner root where root.scenario = 'partial'), 'optional_failure',
  'cancellation after claim and before start still settles the exact optional slot');
select ok((select outcome.outcome = 'canceled' and not outcome.run_started and outcome.attempt_count = 1
    and outcome.run_id = child.run_id and outcome.checkpoint_run_id is null
  from partial_optional child join internal.factory_workflow_branch_outcomes outcome on outcome.job_id = child.job_id),
  'the receipt distinguishes a claim from an actually started run');
select is((select outcome::text from partial_optional child cross join lateral
  pg_temp.record_slot('partial','run.optional',child.job_id,child.run_id)), 'canceled',
  'an exact unstarted cancellation replays its stored receipt');
rollback to optional_canceled_after_claim;

savepoint optional_failed_before_start;
create temp table failed_optional_claim as select job.id, job.attempt_count
from public.claim_next_agent_job(false, 3, 'node') job;
select is((select public.fail_session_job_attempt(claim.id,claim.attempt_count,
    'Fixture failure before worker start',false,0,null)
  from failed_optional_claim claim join partial_optional child on child.job_id = claim.id),
  'error', 'the native worker can fail the exact claimed job before a run binds');
select is((select public.advance_factory_workflow_branch_occurrence(root."sessionId",root.workspace_id,root.factory_id,
    root.execution_generation,root.ownership_token,root.entry_occurrence_id)->>'joinStatus'
  from branch_owner root where root.scenario = 'partial'), 'optional_failure',
  'a terminal startup failure settles the exact optional slot');
select ok((select outcome.outcome = 'failed' and not outcome.run_started and outcome.attempt_count = 1
    and outcome.run_id = child.run_id and outcome.checkpoint_run_id is null and outcome.artifact_id is null
  from partial_optional child join internal.factory_workflow_branch_outcomes outcome on outcome.job_id = child.job_id),
  'a startup failure retains the exact claim and placeholder without fabricated output');
rollback to optional_failed_before_start;

select is((select pg_temp.start_branch_for_outcome(job_id) from partial_optional),
  (select run_id from partial_optional), 'the optional attempt belongs to the admitted child');
select public.cancel_session_job_attempts(child.child_session_id, root.workspace_id, 'Cancel optional work', child.run_id, false)
from partial_optional child cross join branch_owner root where root.scenario = 'partial';
select is((select outcome::text from partial_optional child cross join lateral
  pg_temp.record_slot('partial', 'run.optional', child.job_id, child.run_id)),
  'canceled', 'the individual optional cancellation retains its exact terminal attempt');
select is(pg_temp.read_group('partial')->>'joinStatus', 'optional_failure',
  'canceled optional work remains explicitly partial rather than fully ready');

create temp table paused_required as select * from pg_temp.admit_slot('paused', 'run.required');
select is((select pg_temp.start_branch_for_outcome(job_id) from paused_required),
  (select run_id from paused_required), 'the paused fixture starts its required own attempt');
select is((select public.control_factory_workflow_lifecycle(root."sessionId",root.workspace_id,root.factory_id,
  root.execution_generation,gen_random_uuid(),'pause')->>'lifecycleStatus'
  from branch_owner root where root.scenario = 'paused'), 'paused', 'OP650 pauses the running branch');
select is(pg_temp.read_group('paused')->>'joinStatus', 'paused', 'paused work has no join readiness');
select is(pg_temp.read_group('paused')#>>'{slots,0,currentAttempt,jobStatus}', 'canceled',
  'the paused projection shows the exact retired attempt');

savepoint archive_paused_work;
select archived.* from paused_required child cross join branch_owner root
cross join lateral public.archive_session_job_attempts(child.child_session_id, root.workspace_id,
  'Archive the paused branch child.') archived
where root.scenario = 'paused';
select ok((select child.archived_at is not null and job.status = 'canceled' and run.status = 'canceled'
  from paused_required admission join public.sessions child on child.id = admission.child_session_id
  join public.agent_jobs job on job.id = admission.job_id join public.agent_runs run on run.id = admission.run_id),
  'archiving a paused child retains its exact retired job and run');
select ok(pg_temp.read_group('paused')->>'joinStatus' = 'paused'
    and pg_temp.read_group('paused')#>'{slots,0,outcome}' = 'null'::jsonb,
  'archiving while paused does not publish an outcome ahead of workflow resume');
create temp table archived_branch_resume as
select root.*, public.control_factory_workflow_lifecycle(root."sessionId",root.workspace_id,root.factory_id,
  root.execution_generation + 1,gen_random_uuid(),'resume') as receipt
from branch_owner root where root.scenario = 'paused';
select ok((select receipt->>'lifecycleStatus' = 'running' and receipt->'resumed' = '[]'::jsonb from archived_branch_resume),
  'the workflow resumes without requeueing the explicitly archived child');
update branch_owner root set execution_generation = owner.execution_generation, ownership_token = owner.ownership_token
from archived_branch_resume resumed cross join lateral public.acquire_factory_workflow_ownership(
  resumed."sessionId",resumed.workspace_id,resumed.factory_id,(resumed.receipt->>'generation')::bigint,gen_random_uuid()) owner
where root.scenario = 'paused';
select is((select public.advance_factory_workflow_branch_occurrence(root."sessionId",root.workspace_id,root.factory_id,
    root.execution_generation,root.ownership_token,root.entry_occurrence_id)->>'joinStatus'
  from branch_owner root where root.scenario = 'paused'), 'required_blocked',
  'the dispatcher settles the archived required branch after root resume');
select ok((select (outcome.child_session_id,outcome.job_id,outcome.attempt_count,outcome.run_id) =
    (retired.child_session_id,retired.job_id,1,retired.run_id)
    and outcome.outcome = 'canceled' and outcome.run_started
    and outcome.checkpoint_run_id is null and outcome.artifact_id is null
  from paused_required retired join internal.factory_workflow_branch_outcomes outcome on outcome.job_id = retired.job_id),
  'the archived branch outcome retains the exact retired attempt without a completed artifact');
rollback to archive_paused_work;

create temp table resumed_group as
select root.*, public.control_factory_workflow_lifecycle(root."sessionId",root.workspace_id,root.factory_id,
  root.execution_generation + 1,gen_random_uuid(),'resume') as receipt
from branch_owner root where root.scenario = 'paused';
select ok((select receipt#>>'{resumed,0,jobId}' = prior.job_id::text
    and receipt#>>'{resumed,0,sessionId}' = prior.child_session_id::text
    and receipt->>'lifecycleStatus' = 'running'
  from resumed_group cross join paused_required prior), 'OP650 resumes the same branch job with a fresh pending attempt');
create temp table resumed_branch_owner as
select new.* from resumed_group resumed
cross join lateral public.acquire_factory_workflow_ownership(resumed."sessionId", resumed.workspace_id,
  resumed.factory_id, (receipt->>'generation')::bigint, gen_random_uuid()) new;
update branch_owner root set execution_generation = owner.execution_generation, ownership_token = owner.ownership_token
from resumed_branch_owner owner where root.scenario = 'paused';
select is((select count(*) from paused_required retired cross join lateral
  pg_temp.record_slot('paused', 'run.required', retired.job_id, retired.run_id)), 0::bigint,
  'the retired attempt cannot settle the branch while the resumed claim is queued');
select ok((select pg_temp.read_group('paused')->>'joinStatus' = 'pending'
    and pg_temp.read_group('paused')#>>'{slots,0,admission,jobId}' = original.job_id::text
    and pg_temp.read_group('paused')#>>'{slots,0,currentAttempt,jobId}' = resumed.receipt#>>'{resumed,0,jobId}'
    and pg_temp.read_group('paused')#>>'{slots,0,currentAttempt,attemptCount}' = '2'
    and pg_temp.read_group('paused')#>'{slots,0,currentAttempt,runId}' = 'null'::jsonb
    and pg_temp.read_group('paused')#>'{slots,0,outcome}' = 'null'::jsonb
  from resumed_group resumed cross join paused_required original),
  'the group keeps the admitted identity while reading the current retry separately');

-- Move aside the fixture's other ready jobs so the real claim picks the
-- authorized same-job retry. This does not change any exact attempt receipt.
update public.agent_jobs job set scheduled_at = clock_timestamp() + interval '1 day'
where job.workspace_id = pg_temp.op651_id(11) and job.status = 'queued'
  and job.id <> (select job_id from paused_required);
create temp table resumed_attempt_claim as select job.id as job_id, job.attempt_count, job.session_id
from public.claim_next_agent_job(false, 3, 'node') job;
select ok((select (claim.job_id, claim.attempt_count, claim.session_id) =
    (admission.job_id, 2, admission.child_session_id)
  from resumed_attempt_claim claim cross join paused_required admission),
  'the real queue claims a fresh attempt on the existing branch job');
create temp table resumed_attempt as
select claim.*,public.start_session_job_attempt(claim.job_id,claim.attempt_count,child.current_stage_id,
  child.current_artifact_version,'codex','gpt-5.5','code','wallie/op651-resume-' || claim.job_id) as run_id
from resumed_attempt_claim claim join public.sessions child on child.id = claim.session_id;
select ok((select resumed.run_id is not null and resumed.run_id <> previous.run_id
  from resumed_attempt resumed cross join paused_required previous),
  'the new attempt uses a new run identity');
select throws_ok($$select * from paused_required retired cross join lateral
  pg_temp.record_slot('paused','run.required',retired.job_id,retired.run_id)$$,
  'PT409','The exact current branch attempt is unavailable.','the retired exact run can never settle its replacement');
select is((select public.fail_session_job_attempt(attempt.job_id,attempt.attempt_count,
  'Fixture terminal error after pause',false,0,attempt.run_id) from resumed_attempt attempt),
  'error','the resumed attempt can finish with its own independent terminal failure');
select is((select recorded.outcome::text from resumed_attempt attempt
  cross join branch_owner root join branch_groups groups using (scenario)
  cross join lateral public.record_factory_workflow_branch_outcome(
    root."sessionId",root.workspace_id,root.factory_id,root.execution_generation,root.ownership_token,
    groups.group_id,'run.required',attempt.job_id,attempt.attempt_count,attempt.run_id) recorded
  where root.scenario = 'paused'),'failed',
  'a previous pause does not suppress the terminal result of the resumed attempt');
select is(pg_temp.read_group('paused')->>'joinStatus','required_blocked',
  'the exact resumed required failure blocks join readiness');

select * from finish();
rollback;
