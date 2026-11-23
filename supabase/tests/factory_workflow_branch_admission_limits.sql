begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65150000
\set op651_open_groups false
\set op651_parallel_only true
\ir fixtures/factory_workflow_branch.psql

create temp table capacity_roots as
select spec.*, fields."sessionId" as session_id, fields."jobId" as job_id
from (values ('wide', 201, 9, 9, 2), ('limited', 202, 2, 1, 1))
  spec(scenario, request_slot, slot_count, lifetime_limit, concurrency_limit)
cross join lateral jsonb_to_record(pg_temp.op651_create_service_root(spec.request_slot, 'Branch capacity ' || spec.scenario))
  fields("sessionId" uuid, "jobId" uuid, "runId" uuid);
create temp table capacity_inputs as
select root.*, pg_temp.adopt_source_checkpoint(root.session_id, root.job_id) as checkpoint_run_id
from capacity_roots root;

create temp table capacity_graphs as
select root.*, pin.workspace_id, pin.factory_id, registered.graph_revision_id, started.*
from capacity_inputs root
join public.session_factory_admission_inputs pin on pin.session_id = root.session_id
cross join op651_grant grant_row
cross join lateral (
  select jsonb_agg(jsonb_build_object('id', named.node_id, 'kind', 'agent',
    'agentPromptRevisionId', pg_temp.op651_id(91), 'grantId', grant_row.id) order by named.slot) as agents,
    jsonb_agg(jsonb_build_object('id', 'run.' || named.node_id, 'kind', 'branch', 'required', true,
      'from', 'branch.split', 'to', named.node_id) order by named.slot) as admissions,
    jsonb_agg(jsonb_build_object('id', 'out.' || named.node_id, 'kind', 'branch-result',
      'from', named.node_id, 'to', 'join.finish') order by named.slot) as outputs,
    jsonb_object_agg(named.node_id, jsonb_build_object(
      'definitionRevisionId', revision.id, 'definitionDigest', revision.canonical_digest)) as targets
  from (
    select slot, 'agent.' || lpad(slot::text, 2, '0') as node_id
    from generate_series(1, root.slot_count) slot
  ) named
  join public.factory_definition_revisions revision on revision.id = pg_temp.op651_id(
    case when root.scenario = 'wide' and named.slot < 9 then 45 else 44 end)
) fixture
cross join lateral (select jsonb_build_object(
  'schemaVersion', 1, 'kind', 'graph', 'entryNodeId', 'branch.split',
  'nodes', '[{"id":"branch.split","kind":"branch"},{"id":"join.finish","kind":"join"}]'::jsonb || fixture.agents,
  'edges', fixture.admissions || fixture.outputs,
  'grants', jsonb_build_array(jsonb_build_object('id', grant_row.id, 'version', grant_row.version)),
  'delegationPolicy', jsonb_build_object('maxChildren', root.lifetime_limit, 'maxConcurrentChildren', root.concurrency_limit,
    'maxAttempts', 12, 'maxTotalTokens', 1000, 'maxTokensPerAttempt', 50,
    'maxCostUsd', 2, 'maxCostUsdPerAttempt', 0.2, 'targets', fixture.targets)
)::text as body) graph
cross join lateral public.register_factory_workflow_graph_revision(pin.workspace_id, pin.factory_id,
  pin.definition_revision_id, pin.definition_digest, graph.body, encode(sha256(convert_to(graph.body, 'UTF8')), 'hex')) registered
cross join lateral public.start_factory_workflow_graph_execution(root.session_id, pin.workspace_id, pin.factory_id,
  registered.graph_revision_id, root.checkpoint_run_id) started;

create function pg_temp.advance_capacity(p_scenario text) returns jsonb language sql as $$
  select public.advance_factory_workflow_branch_occurrence(root.session_id, root.workspace_id, root.factory_id,
    root.execution_generation, root.ownership_token, root.entry_occurrence_id)
  from capacity_graphs root where root.scenario = p_scenario
$$;
create function pg_temp.read_capacity(p_scenario text) returns jsonb language sql as $$
  select public.read_factory_workflow_branch_group(root.session_id, root.workspace_id, root.factory_id, groups.group_id)
  from capacity_graphs root join internal.factory_workflow_branch_groups groups on groups.root_session_id = root.session_id
  where root.scenario = p_scenario
$$;

select is(pg_temp.advance_capacity('wide')->>'admissionBlocker', 'workflow_branch_admission_unavailable',
  'the first pass attempts the eight required profiles with rejected inherited scope');
select is((select count(*) from internal.factory_workflow_branch_slot_dispatches state
  join capacity_graphs root on root.session_id = state.root_session_id where root.scenario = 'wide'), 8::bigint,
  'the scheduler records the bounded batch even though all eight child admissions roll back');
select is((select count(*) from internal.factory_workflow_delegations marker
  join capacity_graphs root on root.session_id = marker.root_session_id where root.scenario = 'wide'), 0::bigint,
  'no rejected required profile leaves a child behind');
select pg_temp.advance_capacity('wide');
select is((select slot.branch_edge_id from internal.factory_workflow_delegations marker
  join capacity_graphs root on root.session_id = marker.root_session_id
  join internal.factory_workflow_branch_slots slot on (slot.root_session_id, slot.slot_id) =
    (marker.root_session_id, marker.source_branch_slot_id)
  where root.scenario = 'wide'), 'run.agent.09', 'the later eligible required slot advances ahead of repeated rejections');

select is(pg_temp.advance_capacity('limited')->>'joinStatus', 'required_blocked',
  'the lifetime child limit terminally blocks the remaining required input');
select ok((select slot->'admission' = 'null'::jsonb and slot->'outcome' = 'null'::jsonb
  and slot->>'admissionBlocker' = 'workflow_child_limit'
  from jsonb_array_elements(pg_temp.read_capacity('limited')->'slots') slot
  where slot#>>'{slot,branch_edge_id}' = 'run.agent.02'),
  'the unadmitted slot reports the terminal reason without inventing a child or artifact');
create temp table limited_child as
select marker.child_job_id, marker.child_session_id from internal.factory_workflow_delegations marker
join capacity_graphs root on root.session_id = marker.root_session_id where root.scenario = 'limited';
update public.agent_jobs set created_at = '1900-01-01' where id = (select child_job_id from limited_child);
select is((select id from public.claim_next_agent_job(false, 5, 'node')),
  (select child_job_id from limited_child), 'the already admitted sibling can still run');
select pg_temp.adopt_branch_code(child_session_id, child_job_id, repeat('b', 40)) from limited_child;
select pg_temp.approve_branch(child_session_id) from limited_child;
select is(pg_temp.advance_capacity('limited')->>'joinStatus', 'required_blocked',
  'the group remains terminally blocked when its active sibling finishes');
select ok((select dispatch.completed_at is not null from internal.factory_workflow_branch_dispatches dispatch
  join capacity_graphs root on root.session_id = dispatch.root_session_id where root.scenario = 'limited'),
  'maintenance retires the finished group with an impossible required input');
select is(pg_temp.advance_capacity('limited')->>'joinStatus', 'required_blocked',
  'replay shows the same persistent lifetime blocker');

select * from finish();
rollback;
