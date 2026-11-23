begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set workflow_fixture_namespace 65060000
\ir fixtures/factory_workflow_lifecycle.psql

create temp table benchmark_task as
select task.* from lifecycle_roots root
cross join lateral public.create_factory_benchmark_task(root.workspace_id, root.factory_id,
  pg_temp.workflow_fixture_id(1), root.checkpoint_run_id, 'Lifecycle queue fixture',
  'Check benchmark queue priority.', '{}', 'eligible') task
where root.scenario = 'budget-root';
insert into public.factory_benchmark_task_inputs(task_id, workspace_id, factory_id, source_run_id, source_session_id,
  source_job_id, source_attempt_count, definition_revision_id, repository_id, checkout_sha)
select task.task_id, task.workspace_id, task.factory_id, root.checkpoint_run_id, root."sessionId", root."jobId", 1,
  pin.definition_revision_id, pg_temp.workflow_fixture_id(34), repeat('a', 40)
from benchmark_task task cross join lifecycle_roots root
join public.session_factory_admission_inputs pin on pin.session_id = root."sessionId"
where root.scenario = 'budget-root'
on conflict (task_id) do nothing;
insert into public.workspace_vercel_sandbox_connections(workspace_id, connection_revision, encrypted_token, team_id, project_id)
values (pg_temp.workflow_fixture_id(11), pg_temp.workflow_fixture_id(50),
  'synthetic-encrypted-token', 'team_fixture', 'prj_fixture');
create temp table benchmark_job as
select trial.job_id
from benchmark_task task
cross join lateral public.publish_factory_benchmark_replay_fixture(task.workspace_id, task.factory_id, pg_temp.workflow_fixture_id(1),
  'tool_read', repeat('f', 64), '{"answer":"frozen"}') fixture
cross join lateral public.publish_factory_benchmark_replay_policy(task.workspace_id, task.factory_id, pg_temp.workflow_fixture_id(1),
  'blocked') blocked
cross join lateral public.publish_factory_benchmark_replay_policy(task.workspace_id, task.factory_id, pg_temp.workflow_fixture_id(1),
  'recorded_fixtures', blocked.id, array[fixture.id]) recorded
cross join lateral public.admit_factory_benchmark_trial(task.workspace_id, task.factory_id, pg_temp.workflow_fixture_id(1),
  pg_temp.workflow_fixture_id(60), task.id, recorded.id, recorded.policy_digest, repeat('f', 64), pg_temp.workflow_fixture_id(50)) trial;

select public.control_factory_workflow_lifecycle(root."sessionId", root.workspace_id, root.factory_id, 1, gen_random_uuid(), 'pause')
from lifecycle_roots root where root.scenario = 'running-child';
select is((select id from public.claim_next_agent_job(true, 3, 'node')),
  (select job_id from lifecycle_children where scenario = 'queued-child'),
  'runnable production work has priority while an unrelated workflow is parked');
select public.control_factory_workflow_lifecycle(root."sessionId", root.workspace_id, root.factory_id, 1, gen_random_uuid(), 'cancel')
from lifecycle_roots root where root.scenario = 'queued-child';
select is((select id from public.claim_next_agent_job(true, 3, 'node')),
  (select job_id from benchmark_job),
  'a parked production child does not starve the eligible benchmark');

select * from finish();
rollback;
