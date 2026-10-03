begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

-- Fixed, isolated fixture IDs make the remote connections independent of the
-- test runner's temporary tables. Explicit cleanup follows the committed tests.
insert into public.sessions(id, workspace_id, number, title, prompt_md, creator_member_id, pipeline_id, current_stage_id)
select ('ae000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  stage.workspace_id, 99002030 + n, 'Execution contention ' || n, 'Exercise execution ownership locks',
  'c1b2c3d4-0001-4000-8000-000000000001', stage.pipeline_id, stage.id
from public.pipeline_stages stage join public.pipelines pipeline on pipeline.id = stage.pipeline_id
cross join generate_series(1, 4) n
where stage.workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001' and pipeline.is_default and stage.slug = 'plan';
insert into public.agent_jobs(id, workspace_id, session_id, stage_id, stage_slug, stage_name, trigger_type, status, attempt_count)
select ('ae000000-0000-4000-8000-' || lpad((100 + n)::text, 12, '0'))::uuid,
  session.workspace_id, session.id, stage.id, stage.slug, stage.name, 'assignment', 'running', 1
from generate_series(1, 4) n
join public.sessions session on session.id = ('ae000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
join public.pipeline_stages stage on stage.id = session.current_stage_id;
insert into public.agent_runs(id, workspace_id, session_id, agent_job_id, stage_id, stage_slug, stage_name, model_provider, model_name, run_type)
select ('ae000000-0000-4000-8000-' || lpad((200 + n)::text, 12, '0'))::uuid,
  job.workspace_id, job.session_id, job.id, job.stage_id, job.stage_slug, job.stage_name, 'codex', 'gpt-5.5', 'project'
from generate_series(1, 4) n
join public.agent_jobs job on job.id = ('ae000000-0000-4000-8000-' || lpad((100 + n)::text, 12, '0'))::uuid;

create function public.test_start_ownership_fixture(fixture integer) returns uuid
language sql set search_path = '' as $$
  select public.start_session_job_attempt(job.id, 1, session.current_stage_id, 0,
    'codex', 'gpt-5.5', 'project', 'wallie/concurrent-' || fixture)
  from public.agent_jobs job join public.sessions session on session.id = job.session_id
  where job.id = ('ae000000-0000-4000-8000-' || lpad((100 + fixture)::text, 12, '0'))::uuid;
$$;
select public.test_start_ownership_fixture(4);

create function public.test_execution_ownership_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'agent_runs' then
    if new.session_id = 'ae000000-0000-4000-8000-000000000001'::uuid and new.status = 'running' then
      perform pg_catalog.pg_advisory_xact_lock(99002031);
    end if;
  elsif tg_table_name = 'agent_jobs' then
    if new.session_id = 'ae000000-0000-4000-8000-000000000002'::uuid and new.status = 'canceled' then
      perform pg_catalog.pg_advisory_xact_lock(99002032);
    elsif new.session_id = 'ae000000-0000-4000-8000-000000000003'::uuid and new.status = 'canceled' then
      perform pg_catalog.pg_advisory_xact_lock(99002033);
    end if;
  elsif tg_table_name = 'session_artifacts' then
    if new.session_id = 'ae000000-0000-4000-8000-000000000004'::uuid then
      perform pg_catalog.pg_advisory_xact_lock(99002034);
    end if;
  end if;
  return new;
end;
$$;
create trigger execution_ownership_start_gate before update on public.agent_runs
for each row execute function public.test_execution_ownership_gate();
create trigger execution_ownership_cancel_gate before update on public.agent_jobs
for each row execute function public.test_execution_ownership_gate();
create trigger execution_ownership_publish_gate before insert on public.session_artifacts
for each row execute function public.test_execution_ownership_gate();
commit;
begin;

create function pg_temp.wait_ownership_lock(target_application text, target_event text default null) returns void
language plpgsql as $$
declare deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
  while not exists(select 1 from pg_catalog.pg_stat_activity
    where application_name = target_application and wait_event_type = 'Lock'
      and (target_event is null or wait_event = target_event)) loop
    if clock_timestamp() > deadline then raise exception 'Expected lock boundary not reached by %', target_application; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;
select extensions.dblink_connect('ownership_gate', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('ownership_owner', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('ownership_contender', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('ownership_owner', 'set application_name = ''execution_ownership_owner''; set statement_timeout = ''15s''');
select extensions.dblink_exec('ownership_contender', 'set application_name = ''execution_ownership_contender''; set statement_timeout = ''15s''');

-- Two processors presenting the same queue claim may authorize only one start.
select extensions.dblink_exec('ownership_gate', 'do $$ begin perform pg_advisory_lock(99002031); end $$');
select extensions.dblink_send_query('ownership_owner', 'select public.test_start_ownership_fixture(1)');
select pg_temp.wait_ownership_lock('execution_ownership_owner', 'advisory');
select extensions.dblink_send_query('ownership_contender', 'select public.test_start_ownership_fixture(1)');
select pg_temp.wait_ownership_lock('execution_ownership_contender');
select ok(exists(select 1 from pg_catalog.pg_stat_activity where application_name = 'execution_ownership_contender' and wait_event_type = 'Lock'),
  'second start waits while the first start owns the session');
select extensions.dblink_exec('ownership_gate', 'do $$ begin perform pg_advisory_unlock(99002031); end $$');
create temp table first_start as select * from extensions.dblink_get_result('ownership_owner') as result(run_id uuid);
create temp table duplicate_start as select * from extensions.dblink_get_result('ownership_contender') as result(run_id uuid);
select is((select run_id from first_start), 'ae000000-0000-4000-8000-000000000201'::uuid, 'first start owns the queued run');
select is((select run_id from duplicate_start), null::uuid, 'second start receives no authority to execute');
select is((select count(*) from public.agent_runs where agent_job_id = 'ae000000-0000-4000-8000-000000000101' and attempt_count = 1), 1::bigint, 'simultaneous starts bind exactly one run');
select count(*) from extensions.dblink_get_result('ownership_owner') as result(run_id uuid);
select count(*) from extensions.dblink_get_result('ownership_contender') as result(run_id uuid);

-- Cancellation wins the session lock before a delayed processor tries to start.
select extensions.dblink_exec('ownership_gate', 'do $$ begin perform pg_advisory_lock(99002032); end $$');
select extensions.dblink_send_query('ownership_owner', $query$
  select * from public.cancel_session_job_attempts('ae000000-0000-4000-8000-000000000002',
    'b1b2c3d4-0001-4000-8000-000000000001', 'concurrent cancellation')
$query$);
select pg_temp.wait_ownership_lock('execution_ownership_owner', 'advisory');
select extensions.dblink_send_query('ownership_contender', 'select public.test_start_ownership_fixture(2)');
select pg_temp.wait_ownership_lock('execution_ownership_contender');
select ok(exists(select 1 from pg_catalog.pg_stat_activity where application_name = 'execution_ownership_contender' and wait_event_type = 'Lock'), 'start waits for in-flight cancellation');
select extensions.dblink_exec('ownership_gate', 'do $$ begin perform pg_advisory_unlock(99002032); end $$');
create temp table canceled_race as select * from extensions.dblink_get_result('ownership_owner') as result(job_ids uuid[], run_ids uuid[]);
create temp table canceled_start as select * from extensions.dblink_get_result('ownership_contender') as result(run_id uuid);
select is((select run_id from canceled_start), null::uuid, 'start observes committed cancellation and refuses execution');
select is((select job_ids from canceled_race), array['ae000000-0000-4000-8000-000000000102'::uuid], 'cancellation returns only the canceled job');
select is((select run_ids from canceled_race), array['ae000000-0000-4000-8000-000000000202'::uuid], 'cancellation returns only the canceled run');
select is((select status::text from public.agent_runs where id = 'ae000000-0000-4000-8000-000000000202'), 'canceled', 'late start cannot revive canceled run');
select count(*) from extensions.dblink_get_result('ownership_owner') as result(job_ids uuid[], run_ids uuid[]);
select count(*) from extensions.dblink_get_result('ownership_contender') as result(run_id uuid);

-- Archive cancellation and the archive timestamp commit before another start.
select extensions.dblink_exec('ownership_gate', 'do $$ begin perform pg_advisory_lock(99002033); end $$');
select extensions.dblink_send_query('ownership_owner', $query$
  select * from public.archive_session_job_attempts('ae000000-0000-4000-8000-000000000003',
    'b1b2c3d4-0001-4000-8000-000000000001', 'concurrent archival')
$query$);
select pg_temp.wait_ownership_lock('execution_ownership_owner', 'advisory');
select extensions.dblink_send_query('ownership_contender', 'select public.test_start_ownership_fixture(3)');
select pg_temp.wait_ownership_lock('execution_ownership_contender');
select extensions.dblink_exec('ownership_gate', 'do $$ begin perform pg_advisory_unlock(99002033); end $$');
create temp table archived_race as select * from extensions.dblink_get_result('ownership_owner') as result(job_ids uuid[], run_ids uuid[]);
create temp table archived_start as select * from extensions.dblink_get_result('ownership_contender') as result(run_id uuid);
select is((select run_id from archived_start), null::uuid, 'start observes committed archival and refuses execution');
select ok((select archived_at is not null from public.sessions where id = 'ae000000-0000-4000-8000-000000000003'), 'archive timestamp commits with cancellation');
select is((select job_ids from archived_race), array['ae000000-0000-4000-8000-000000000103'::uuid], 'archive returns the exact canceled job');
select is((select status::text from public.agent_jobs where id = 'ae000000-0000-4000-8000-000000000103'), 'canceled', 'archived job remains canceled');
select count(*) from extensions.dblink_get_result('ownership_owner') as result(job_ids uuid[], run_ids uuid[]);
select count(*) from extensions.dblink_get_result('ownership_contender') as result(run_id uuid);

-- A timeout/failure arriving during publication must see the committed artifact.
select extensions.dblink_exec('ownership_gate', 'do $$ begin perform pg_advisory_lock(99002034); end $$');
select extensions.dblink_send_query('ownership_owner', $query$
  select public.publish_session_job_attempt('ae000000-0000-4000-8000-000000000104', 1,
    'ae000000-0000-4000-8000-000000000204', 0, 'durable race output')
$query$);
select pg_temp.wait_ownership_lock('execution_ownership_owner', 'advisory');
select extensions.dblink_send_query('ownership_contender', $query$
  select public.fail_session_job_attempt('ae000000-0000-4000-8000-000000000104', 1,
    'timeout raced publication', true, 3, 'ae000000-0000-4000-8000-000000000204')
$query$);
select pg_temp.wait_ownership_lock('execution_ownership_contender');
select is((select current_artifact_version from public.sessions where id = 'ae000000-0000-4000-8000-000000000004'), 0, 'uncommitted publication has not exposed its pointer');
select is((select count(*) from public.session_artifacts where session_id = 'ae000000-0000-4000-8000-000000000004'), 0::bigint, 'uncommitted publication has not exposed its markdown');
select extensions.dblink_exec('ownership_gate', 'do $$ begin perform pg_advisory_unlock(99002034); end $$');
create temp table publish_race as select * from extensions.dblink_get_result('ownership_owner') as result(published boolean);
create temp table failure_race as select * from extensions.dblink_get_result('ownership_contender') as result(outcome text);
select is((select published from publish_race), true, 'owner publishes successfully');
select is((select outcome from failure_race), 'success', 'racing failure acknowledges the completed publication');
select is((select phase_status::text from public.sessions where id = 'ae000000-0000-4000-8000-000000000004'), 'awaiting_review', 'racing failure cannot reset review');
select is((select artifact_json from public.session_artifacts where session_id = 'ae000000-0000-4000-8000-000000000004'), to_jsonb('durable race output'::text), 'racing failure leaves the published artifact intact');
select is((select status::text from public.agent_jobs where id = 'ae000000-0000-4000-8000-000000000104'), 'success', 'racing failure completes the publishing job without requeue');
select is((select status::text from public.agent_runs where id = 'ae000000-0000-4000-8000-000000000204'), 'success', 'racing failure preserves successful run history');

select extensions.dblink_disconnect('ownership_gate');
select extensions.dblink_disconnect('ownership_owner');
select extensions.dblink_disconnect('ownership_contender');
select * from finish();
commit;

begin;
drop trigger execution_ownership_start_gate on public.agent_runs;
drop trigger execution_ownership_cancel_gate on public.agent_jobs;
drop trigger execution_ownership_publish_gate on public.session_artifacts;
drop function public.test_execution_ownership_gate();
drop function public.test_start_ownership_fixture(integer);
delete from public.sessions where id in (
  'ae000000-0000-4000-8000-000000000001', 'ae000000-0000-4000-8000-000000000002',
  'ae000000-0000-4000-8000-000000000003', 'ae000000-0000-4000-8000-000000000004');
commit;
