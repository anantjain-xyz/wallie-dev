begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set workflow_fixture_namespace 65010000
\ir fixtures/factory_workflow_lifecycle.psql

select is((select count(*) from lifecycle_children where created), 2::bigint,
  'both workflows have one real delegated child');
create temp table pending_adoption as select * from pg_temp.prepare_child_publication('running-child');
create temp view running_child as select job_id, run_id from pending_adoption;
select ok((select claim_id is not null from pending_adoption),
  'maintenance holds an exact child publication claim before pause');

create function pg_temp.control_workflow(p_scenario text,p_generation bigint,p_request_slot integer,p_action text)
returns jsonb language sql as $$
  select public.control_factory_workflow_lifecycle(root."sessionId", root.workspace_id, root.factory_id,
    p_generation, pg_temp.workflow_fixture_id(p_request_slot), p_action)
  from lifecycle_roots root where root.scenario = p_scenario
$$;
create function pg_temp.read_lifecycle(p_scenario text) returns jsonb language sql as $$
  select public.read_factory_workflow_execution(root."sessionId", root.workspace_id, root.factory_id)
  from lifecycle_roots root where root.scenario = p_scenario
$$;

insert into auth.users(id, email) values (pg_temp.workflow_fixture_id(50), 'op650-' || current_setting('wallie.workflow_lifecycle_fixture') || '-member@example.test');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.workflow_fixture_id(51), pg_temp.workflow_fixture_id(11), pg_temp.workflow_fixture_id(50), 'human', 'member');
select throws_ok($$select public.control_factory_workflow_lifecycle_for_user(
  root."sessionId", root.workspace_id, root.factory_id, pg_temp.workflow_fixture_id(50),
  1, pg_temp.workflow_fixture_id(651), 'pause'
) from lifecycle_roots root where root.scenario = 'running-child'$$,
  '42501', 'Factory manager access is required.', 'a member cannot start the scoped operator control');
select is(pg_temp.read_lifecycle('running-child')#>>'{execution,lifecycle_status}', 'running',
  'unauthorized command creates no lifecycle transition');
create temp table pause_claimed as select public.control_factory_workflow_lifecycle_for_user(
  root."sessionId", root.workspace_id, root.factory_id, pg_temp.workflow_fixture_id(1),
  1, pg_temp.workflow_fixture_id(651), 'pause'
) as receipt from lifecycle_roots root where root.scenario = 'running-child';
select ok((select receipt->>'lifecycleStatus' = 'paused' and receipt->>'generation' = '2'
  and receipt#>'{retired,0,jobIds}' = jsonb_build_array(child.job_id)
  and receipt#>'{retired,0,runIds}' = jsonb_build_array(child.run_id)
  and receipt#>>'{retired,0,jobs,0,attemptCount}' = '1'
  from pause_claimed cross join running_child child), 'pause atomically retires the child’s exact running attempt');
select ok((select job.status = 'canceled' and run.status = 'canceled' and session.phase_status = 'in_progress'
  from running_child child join public.agent_jobs job on job.id = child.job_id
  join public.agent_runs run on run.id = child.run_id join public.sessions session on session.id = job.session_id),
  'pause retires attempts while preserving the child stage for resume');
select is(pg_temp.control_workflow('running-child',1,651,'pause'), (select receipt from pause_claimed),
  'replayed pause returns the exact old retirement receipt');
select throws_ok($$select pg_temp.control_workflow('running-child',1,651,'cancel')$$, 'PT409',
  'The workflow request was already used with different intent.', 'conflicting request replay cannot cancel the paused graph');
select ok((select not public.adopt_session_checkpoint_publication(run_id, claim_id, null, null) from pending_adoption),
  'an already claimed child publication cannot adopt after pause retires the exact attempt');
select ok((select not exists(select 1 from public.session_git_checkpoints checkpoint where checkpoint.run_id = child.run_id)
  from running_child child), 'late adoption writes no child artifact or head');
select ok(pg_temp.read_lifecycle('running-child')#>>'{execution,lifecycle_status}' = 'paused'
  and pg_temp.read_lifecycle('running-child')->'runnableTransitions' = '[]'::jsonb,
  'paused snapshot retains history and exposes no runnable transitions');
select is((select count(*) from lifecycle_roots root cross join lateral public.acquire_factory_workflow_ownership(
  root."sessionId", root.workspace_id, root.factory_id, 2, gen_random_uuid()) where root.scenario = 'running-child'), 0::bigint,
  'ordinary worker recovery cannot acquire a paused generation');

create temp table pause_queued as select pg_temp.control_workflow('queued-child',1,652,'pause') as receipt;
select ok((select receipt->'retired' = '[]'::jsonb from pause_queued), 'pause leaves never-claimed child work queued');
select is((select job.status::text from public.agent_jobs job join lifecycle_children child on child.job_id = job.id
  where child.scenario = 'queued-child'), 'queued', 'queued child holds the same durable job during pause');
select is((select count(*) from public.claim_next_agent_job(false, 1000, 'node') claimed
  join lifecycle_children child on child.job_id = claimed.id and child.scenario = 'queued-child'), 0::bigint,
  'ordinary queue cannot claim a paused child');

create temp table resume_running as select pg_temp.control_workflow('running-child',2,653,'resume') as receipt;
select ok((select receipt->>'lifecycleStatus' = 'running' and receipt->>'generation' = '3'
  and jsonb_array_length(receipt->'resumed') = 1 and receipt#>>'{resumed,0,jobId}' <> child.job_id::text
  from resume_running cross join running_child child), 'resume queues one replacement exact stage job after retiring its old attempt');
select is(pg_temp.control_workflow('running-child',2,653,'resume'), (select receipt from resume_running),
  'replayed resume preserves the replacement job and run');
select ok((select public.start_session_job_attempt(job.id,1,job.stage_id,0,
  'codex','gpt-5.5','code','wallie/op650-stale') is null
  from running_child child join public.agent_jobs job on job.id = child.job_id),
  'old canceled attempt cannot start after resume');
select ok((select root.checkpoint_run_id = head.checkpoint_run_id from lifecycle_roots root
  join public.session_git_heads head on head.session_id = root."sessionId" where root.scenario = 'running-child'),
  'child lifecycle leaves the root accepted checkpoint untouched');

create temp table canceled_workflow as select pg_temp.control_workflow('running-child',3,654,'cancel') as receipt;
select ok((select cancel.receipt->>'lifecycleStatus' = 'canceled' and cancel.receipt->>'generation' = '4'
  and cancel.receipt#>'{retired,0,jobIds}' = jsonb_build_array(resume.receipt#>'{resumed,0,jobId}')
  from canceled_workflow cancel cross join resume_running resume), 'termination retires queued replacement work');
select throws_ok($$select pg_temp.control_workflow('running-child',4,655,'resume')$$, 'PT409',
  'The workflow lifecycle transition is unavailable.', 'a canceled workflow cannot resume');
select ok((select receipt->'resumed' = '[]'::jsonb from (
  select pg_temp.control_workflow('queued-child',2,656,'resume') as receipt
) resumed), 'resume of a parked queued job needs no replacement');
select is((select job.status::text from public.agent_jobs job join lifecycle_children child on child.job_id = job.id
  where child.scenario = 'queued-child'), 'queued', 'another workflow can resume its original job after termination elsewhere');
select ok(not has_function_privilege('authenticated', 'public.control_factory_workflow_lifecycle(uuid,uuid,uuid,bigint,uuid,text)', 'execute')
  and not has_table_privilege('service_role', 'internal.factory_workflow_lifecycle_commands', 'select'),
  'root lifecycle writes and history require the scoped service command');

select pg_temp.control_workflow('budget-root',1,659,'pause');
select internal.exhaust_session_execution(root."sessionId",'elapsed_execution',60000,60000)
from lifecycle_roots root where root.scenario = 'budget-root';
select throws_ok($$select pg_temp.control_workflow('budget-root',2,660,'resume')$$,
  'PT409', 'The workflow root execution budget is exhausted.',
  'a paused workflow with no retired attempts cannot resume an exhausted pinned budget');
select ok(pg_temp.read_lifecycle('budget-root')#>>'{execution,lifecycle_status}' = 'paused'
  and pg_temp.read_lifecycle('budget-root')#>>'{execution,generation}' = '2',
  'an exhausted resume leaves its previous lifecycle and generation');

select pg_temp.control_workflow('queued-child',3,657,'pause');
select revoked.revoked_at is not null from lifecycle_root_grant approved
cross join lateral public.revoke_factory_execution_grant(approved.workspace_id, approved.factory_id,
  pg_temp.workflow_fixture_id(1), approved.id, approved.version, 'Queued-only resume fixture revocation') revoked;
select throws_ok($$select pg_temp.control_workflow('queued-child',4,658,'resume')$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'queued-only resume must recheck the revoked root grant');
select ok(pg_temp.read_lifecycle('queued-child')#>>'{execution,lifecycle_status}' = 'paused'
  and pg_temp.read_lifecycle('queued-child')#>>'{execution,generation}' = '4',
  'a denied resume leaves lifecycle and generation frozen');
select ok(not exists (
  select 1 from lifecycle_roots root join internal.factory_workflow_lifecycle_commands command
    on command.root_session_id = root."sessionId"
  where root.scenario = 'queued-child' and command.request_id = pg_temp.workflow_fixture_id(658)
), 'resume refusal writes no command receipt');

select * from finish();
rollback;
