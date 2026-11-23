begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
\set workflow_fixture_namespace 65030000
\ir fixtures/factory_workflow_lifecycle.psql

-- The independent worker connections need committed scope and publication fixtures.
create temp table race_targets as
select root.scenario, root."sessionId" as root_session_id, root.checkpoint_run_id as prior_root_head,
  child.child_session_id, publication.job_id, publication.run_id, publication.claim_id,
  format('select public.control_factory_workflow_lifecycle(%L,%L,%L,1,%L,''cancel'')',
    root."sessionId", root.workspace_id, root.factory_id, gen_random_uuid()) as cancel_query,
  format('select public.adopt_session_checkpoint_publication(%L,%L,null,null)',
    publication.run_id, publication.claim_id) as adopt_query
from lifecycle_roots root join lifecycle_children child using (scenario)
cross join lateral pg_temp.prepare_child_publication(root.scenario) publication;

create temp table pause_target as
select child.job_id, format('select public.control_factory_workflow_lifecycle(%L,%L,%L,1,%L,''pause'')',
  root."sessionId", root.workspace_id, root.factory_id, gen_random_uuid()) as pause_query,
  format('select public.control_factory_workflow_lifecycle(%L,%L,%L,2,%L,''resume'')',
    root."sessionId", root.workspace_id, root.factory_id, gen_random_uuid()) as resume_query
from lifecycle_roots root
cross join lateral pg_temp.admit_scoped_child(root.scenario) child
where root.scenario = 'budget-root';
commit;

create function pg_temp.wait_for_lifecycle_lock() returns boolean language plpgsql as $$
declare deadline timestamptz := clock_timestamp() + interval '8 seconds';
begin
  while not exists (
    select 1 from pg_stat_activity waiter
    join pg_stat_activity holder on holder.pid = any(pg_blocking_pids(waiter.pid))
    where waiter.application_name = 'op650_lifecycle_contender' and holder.application_name = 'op650_lifecycle_owner'
  ) loop
    if clock_timestamp() >= deadline then return false; end if;
    perform pg_sleep(0.02);
  end loop;
  return true;
end;
$$;

select extensions.dblink_connect('op650_owner', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('op650_contender', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('op650_owner',
  'set application_name = ''op650_lifecycle_owner''; set statement_timeout = ''15s''; set request.jwt.claim.role = ''service_role''');
select extensions.dblink_exec('op650_contender',
  'set application_name = ''op650_lifecycle_contender''; set statement_timeout = ''15s''; set request.jwt.claim.role = ''service_role''');

-- Cancellation wins the first race. The pending adopter cannot use its old claim.
select extensions.dblink_exec('op650_owner', 'begin');
select ok(receipt->>'lifecycleStatus' = 'canceled', 'cancel holds the root and child until commit')
from race_targets target cross join lateral extensions.dblink('op650_owner', target.cancel_query) reply(receipt jsonb)
where target.scenario = 'running-child';
select extensions.dblink_send_query('op650_contender', adopt_query) from race_targets where scenario = 'running-child';
select ok(pg_temp.wait_for_lifecycle_lock(), 'racing adoption waits for the cancellation transaction');
select extensions.dblink_exec('op650_owner', 'commit');
select is((select adopted from extensions.dblink_get_result('op650_contender') result(adopted boolean)), false,
  'late adoption loses after exact cancellation commits');
select count(*) from extensions.dblink_get_result('op650_contender') result(adopted boolean);
select ok(not exists (
  select 1 from race_targets target join public.session_git_checkpoints checkpoint on checkpoint.run_id = target.run_id
  where target.scenario = 'running-child'
), 'the canceled child has no accepted checkpoint');

-- Adoption wins the second race. Cancellation must preserve the completed attempt.
select extensions.dblink_exec('op650_owner', 'begin');
select ok(adopted, 'adoption holds the child after completing the exact attempt')
from race_targets target cross join lateral extensions.dblink('op650_owner', target.adopt_query) reply(adopted boolean)
where target.scenario = 'queued-child';
select extensions.dblink_send_query('op650_contender', cancel_query) from race_targets where scenario = 'queued-child';
select ok(pg_temp.wait_for_lifecycle_lock(), 'racing cancellation waits for the adoption transaction');
select extensions.dblink_exec('op650_owner', 'commit');
select ok((select receipt->>'lifecycleStatus' = 'canceled' and receipt->'retired' = '[]'::jsonb
  from extensions.dblink_get_result('op650_contender') result(receipt jsonb)),
  'cancellation observes the already accepted attempt');
select count(*) from extensions.dblink_get_result('op650_contender') result(receipt jsonb);
select ok((select head.checkpoint_run_id = target.run_id and run.status = 'success' and job.status = 'success'
  from race_targets target join public.session_git_heads head on head.session_id = target.child_session_id
  join public.agent_runs run on run.id = target.run_id join public.agent_jobs job on job.id = target.job_id
  where target.scenario = 'queued-child'), 'the child head and successful attempt survive cancellation');
select ok((select bool_and(head.checkpoint_run_id = target.prior_root_head) from race_targets target
  join public.session_git_heads head on head.session_id = target.root_session_id),
  'neither ordering changes the accepted root head');

-- The normal scheduler skips a pause transaction that owns the root. Once
-- resumed, it claims the original job for the first time without a replacement.
select extensions.dblink_exec('op650_owner', 'begin');
select ok(receipt->>'lifecycleStatus' = 'paused' and receipt->'retired' = '[]'::jsonb,
  'pause owns the root while leaving its never-claimed child queued')
from pause_target target cross join lateral extensions.dblink('op650_owner', target.pause_query) reply(receipt jsonb);
select is((select count(*) from extensions.dblink('op650_contender',
  'select id from public.claim_next_agent_job(false, 1000, ''node'')') claimed(id uuid)
  join pause_target target on target.job_id = claimed.id), 0::bigint, 'claim skips the root before pause commits');
select extensions.dblink_exec('op650_owner', 'commit');
select is((select count(*) from extensions.dblink('op650_contender',
  'select id from public.claim_next_agent_job(false, 1000, ''node'')') claimed(id uuid)
  join pause_target target on target.job_id = claimed.id), 0::bigint, 'claim skips the paused root after commit');
select ok(receipt->>'lifecycleStatus' = 'running' and receipt->'resumed' = '[]'::jsonb,
  'resume retains the original queued child')
from pause_target target cross join lateral extensions.dblink('op650_owner', target.resume_query) reply(receipt jsonb);
select is((select claimed.attempt_count from extensions.dblink('op650_contender',
  'select id, attempt_count from public.claim_next_agent_job(false, 1000, ''node'')') claimed(id uuid, attempt_count integer)
  join pause_target target on target.job_id = claimed.id), 1, 'the scheduler claims the same original job once after resume');

select extensions.dblink_disconnect('op650_owner');
select extensions.dblink_disconnect('op650_contender');

begin;
set local request.jwt.claim.role = 'service_role';
delete from public.workspaces where id = pg_temp.workflow_fixture_id(11);
delete from auth.users where id = pg_temp.workflow_fixture_id(1);
select public.set_git_continuity_release(false, current.revision, initial.reason)
from lifecycle_release_before initial cross join public.get_git_continuity_release_state() current
where not initial.enabled and current.enabled;
select is((select count(*) from internal.factory_workflow_lifecycle_commands command
  join lifecycle_roots root on root."sessionId" = command.root_session_id), 0::bigint,
  'cleanup removes the scoped lifecycle fixtures');
select * from finish();
commit;
