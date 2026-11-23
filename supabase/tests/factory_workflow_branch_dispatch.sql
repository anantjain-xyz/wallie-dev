begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65120000
\set op651_open_groups false
\set op651_parallel_only false
\ir fixtures/factory_workflow_branch.psql

select is((select count(*) from internal.factory_workflow_branch_dispatches dispatch
  join branch_owner root on root."sessionId" = dispatch.root_session_id), 5::bigint,
  'graph enrollment durably queues every branch occurrence without opening a group');

-- Make the durable dispatch order deterministic while holding the fixture
-- transaction and exercise the service-side worker entry point.
update internal.factory_workflow_branch_dispatches dispatch
set due_at = clock_timestamp() - case root.scenario
  when 'bounded' then interval '5 minutes' when 'parallel' then interval '4 minutes'
  when 'canceled' then interval '3 minutes' when 'partial' then interval '2 minutes' else interval '1 minute' end
from branch_owner root where root."sessionId" = dispatch.root_session_id;

select is(public.dispatch_next_factory_workflow_branch(), true, 'maintenance resumes the oldest due fork after enrollment');
create temp table bounded_dispatch_group as
select manifest.* from internal.factory_workflow_branch_groups manifest
join branch_owner root on root."sessionId" = manifest.root_session_id where root.scenario = 'bounded';
select is((select count(*) from bounded_dispatch_group),1::bigint, 'first tick freezes the exact accepted source');
select is((select input_sha from bounded_dispatch_group), repeat('a',40), 'branch source is taken from the accepted head');
select is((select count(*) from internal.factory_workflow_delegations marker
  join branch_owner root on root."sessionId" = marker.root_session_id where root.scenario = 'bounded'),1::bigint,
  'root capacity admits only one bounded child');
select is((select slot.branch_edge_id from internal.factory_workflow_delegations marker
  join internal.factory_workflow_branch_slots slot on (slot.root_session_id,slot.slot_id) =
    (marker.root_session_id,marker.source_branch_slot_id)
  join branch_owner root on root."sessionId" = marker.root_session_id where root.scenario = 'bounded'), 'run.required',
  'required branch reserves the next slot even when its admission appears after optional work');

select is(public.dispatch_next_factory_workflow_branch(), true, 'a capacity wait does not monopolize maintenance');
create function pg_temp.dispatch_progress(p_scenario text, p_child_edge text default null)
returns jsonb language sql as $$
  select public.advance_factory_workflow_branch_occurrence(root."sessionId", root.workspace_id, root.factory_id,
    root.execution_generation,root.ownership_token, coalesce((select marker.target_occurrence_id
      from internal.factory_workflow_delegations marker
      join internal.factory_workflow_branch_slots slot on (slot.root_session_id,slot.slot_id) =
        (marker.root_session_id,marker.source_branch_slot_id)
      where marker.root_session_id = root."sessionId" and slot.branch_edge_id = p_child_edge), root.entry_occurrence_id))
  from branch_owner root where root.scenario = p_scenario
$$;
create temp table parallel_children as
select slot.branch_edge_id, marker.* from internal.factory_workflow_delegations marker
join internal.factory_workflow_branch_slots slot on (slot.root_session_id,slot.slot_id) =
  (marker.root_session_id,marker.source_branch_slot_id)
join branch_owner root on root."sessionId" = marker.root_session_id where root.scenario = 'parallel';
select is((select count(*) from parallel_children), 2::bigint, 'separate root launches both available slots in one tick');
select is((select count(distinct child_job_id) from parallel_children), 2::bigint, 'sibling jobs retain independent identities');

select id from public.claim_next_agent_job(false, 3, 'node');
select id from public.claim_next_agent_job(false, 3, 'node');
select id from public.claim_next_agent_job(false, 3, 'node');


select pg_temp.adopt_branch_code(child_session_id, child_job_id, repeat('b', 40)) from parallel_children
where branch_edge_id = 'run.required';
select is(pg_temp.dispatch_progress('parallel', 'run.required')->>'joinStatus','pending',
  'calling the branch arm before approval retains pending status');
select is((select count(*) from internal.factory_workflow_branch_outcomes outcome
  join branch_owner root on root."sessionId" = outcome.root_session_id where root.scenario = 'parallel'), 0::bigint,
  'an unapproved branch checkpoint creates no terminal receipt');

select pg_temp.approve_branch(child_session_id) from parallel_children where branch_edge_id = 'run.required';
select pg_temp.adopt_branch_code(child_session_id, child_job_id, repeat('c', 40)) from parallel_children
where branch_edge_id = 'run.optional';
select pg_temp.approve_branch(child_session_id) from parallel_children where branch_edge_id = 'run.optional';

select is(pg_temp.dispatch_progress('parallel', 'run.required')->>'joinStatus','ready',
  'branch arm dispatch records both independently approved outcomes');
select is((select count(*) from internal.factory_workflow_branch_outcomes outcome
  join parallel_children child on (outcome.child_session_id,outcome.job_id,outcome.run_id) =
    (child.child_session_id,child.child_job_id,child.child_run_id)
  where outcome.outcome = 'succeeded' and outcome.attempt_count = 1 and outcome.checkpoint_run_id = child.child_run_id),2::bigint,
  'completion records each exact child run, attempt and accepted checkpoint');
select is(pg_temp.dispatch_progress('parallel')->>'joinStatus','ready', 'replay returns the same branch readiness');
select is((select count(*) from internal.factory_workflow_node_occurrences occurrence
  join branch_owner root on root."sessionId" = occurrence.root_session_id
  where root.scenario = 'parallel' and occurrence.node_kind = 'join'),0::bigint,
  'branch maintenance does not admit or merge the join');
select ok((select head.checkpoint_run_id = root.checkpoint_run_id from public.session_git_heads head
  join branch_owner root on root."sessionId" = head.session_id where root.scenario = 'parallel'),
  'branch completion leaves the parent accepted head unchanged');

select public.control_factory_workflow_lifecycle(root."sessionId", root.workspace_id, root.factory_id,
  root.execution_generation,gen_random_uuid(),'cancel')
from branch_owner root where root.scenario = 'canceled';
update internal.factory_workflow_branch_dispatches dispatch set due_at = clock_timestamp() - interval '1 hour'
from branch_owner root where root.scenario = 'canceled' and dispatch.root_session_id = root."sessionId";
select is(public.dispatch_next_factory_workflow_branch(), true, 'maintenance skips the due canceled root and handles another fork');
select is((select count(*) from internal.factory_workflow_branch_groups manifest
  join branch_owner root on root."sessionId" = manifest.root_session_id where root.scenario = 'canceled'),0::bigint,
  'canceled dispatch never opens an unstarted group');

-- Adopt the same SHA from a different exact parent run before its fork opens.
update public.sessions session set archived_at = null, phase_status = 'awaiting_review'
from branch_owner root where root.scenario = 'paused' and root."sessionId" = session.id;
create temp table newer_parent_job as
select root."sessionId" as session_id, queued.job_id
from branch_owner root cross join lateral public.enqueue_session_retry_with_checkpoint(
  root."sessionId", root.workspace_id, pg_temp.op651_id(32), pg_temp.op651_id(21),
  root.checkpoint_run_id, 'codex', 'gpt-5.5', 'code'
) queued where root.scenario = 'paused';
create temp table newer_parent_checkpoint as
select pg_temp.adopt_source_checkpoint(session_id, job_id, 1) as run_id from newer_parent_job;
select ok((select newer.run_id <> root.checkpoint_run_id and old.output_sha = latest.output_sha
  from branch_owner root cross join newer_parent_checkpoint newer
  join public.session_git_checkpoints latest on latest.run_id = newer.run_id
  join public.session_git_checkpoints old on old.run_id = root.checkpoint_run_id
  where root.scenario = 'paused'), 'a newer accepted run can publish the same parent SHA');
select throws_ok($$select pg_temp.open_group('paused', (select run_id from newer_parent_checkpoint))$$,
  'PT409', 'Branching requires the exact accepted parent checkpoint.',
  'explicit branch admission refuses to substitute the same-SHA parent run');
select is(pg_temp.dispatch_progress('paused')->>'blocker','workflow_branch_source_changed',
  'automatic dispatch reports the changed causal source instead of opening its replacement');
select is((select count(*) from internal.factory_workflow_branch_groups manifest
  join branch_owner root on root."sessionId" = manifest.root_session_id where root.scenario = 'paused'),0::bigint,
  'the superseding run creates no manifest or branch child');

create temp table unpinned_branch_root as
select root.workspace_id, root.factory_id, root.graph_revision_id,
  (pg_temp.op651_create_service_root(106, 'Branch without checkpoint')->>'sessionId')::uuid as session_id
from branch_owner root where root.scenario = 'parallel';
select throws_ok($$
  select * from unpinned_branch_root root cross join lateral public.start_factory_workflow_graph_execution(
    root.session_id, root.workspace_id, root.factory_id, root.graph_revision_id
  )
$$, 'PT422', 'The graph requires a scoped checkpoint input run.',
  'entry branch enrollment requires a named checkpoint input');
select ok(not exists (select 1 from internal.factory_workflow_branch_dispatches dispatch
  join unpinned_branch_root root on root.session_id = dispatch.root_session_id),
  'missing source enrollment leaves no indefinitely pending branch dispatch');

select ok(not has_function_privilege('authenticated','public.dispatch_next_factory_workflow_branch()','EXECUTE')
  and not has_function_privilege('authenticated',
    'public.advance_factory_workflow_branch_occurrence(uuid,uuid,uuid,bigint,uuid,uuid)','EXECUTE'),
  'only service callers can advance persisted branch work');
select * from finish();
rollback;
