begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

-- Deterministically pause the RPC after its empty active-job lookup, while a
-- legacy direct insert races it. This exposes both the FK lock cycle and the
-- unique-index adoption path rather than relying on scheduler timing.
insert into public.sessions (
  id, workspace_id, number, title, prompt_md, creator_member_id, pipeline_id, current_stage_id
)
select 'ad000000-0000-4000-8000-000000000001', stage.workspace_id, 99002026,
  'Queue contention proof', 'Exercise mixed enqueue producers.',
  'c1b2c3d4-0001-4000-8000-000000000001', stage.pipeline_id, stage.id
from public.pipeline_stages stage
join public.pipelines pipeline on pipeline.id = stage.pipeline_id
where stage.workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
  and pipeline.is_default and stage.slug = 'plan';

create function public.test_pause_canonical_enqueue() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.session_id = 'ad000000-0000-4000-8000-000000000001'::uuid
     and new.dedupe_key = 'session:ad000000-0000-4000-8000-000000000001:active' then
    perform pg_catalog.pg_advisory_xact_lock(99002026);
  end if;
  return new;
end;
$$;
create trigger test_pause_canonical_enqueue before insert on public.agent_jobs
for each row execute function public.test_pause_canonical_enqueue();
commit;
begin;

select extensions.dblink_connect('queue_gate', coalesce(
  nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('queue_rpc', coalesce(
  nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('queue_legacy', coalesce(
  nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('queue_gate', 'do $$ begin perform pg_advisory_lock(99002026); end $$');
select extensions.dblink_exec('queue_rpc', 'set application_name = ''canonical_queue_rpc_test''; set statement_timeout = ''10s''');
select extensions.dblink_exec('queue_legacy', 'set statement_timeout = ''3s''');
select extensions.dblink_send_query('queue_rpc', $query$
  select * from public.enqueue_session_job_with_run(
    'ad000000-0000-4000-8000-000000000001',
    'b1b2c3d4-0001-4000-8000-000000000001',
    (select current_stage_id from public.sessions where id = 'ad000000-0000-4000-8000-000000000001'),
    null, 'assignment', 'codex', 'gpt-5.5', 'project')
$query$);
do $$
declare deadline timestamptz := clock_timestamp() + interval '3 seconds';
begin
  while not exists (select 1 from pg_catalog.pg_stat_activity
    where application_name = 'canonical_queue_rpc_test' and wait_event = 'advisory') loop
    if clock_timestamp() > deadline then raise exception 'RPC did not reach the insert gate'; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;
select ok(exists(select 1 from pg_catalog.pg_stat_activity
  where application_name = 'canonical_queue_rpc_test' and wait_event = 'advisory'),
  'RPC is paused after its active-job lookup');
select extensions.dblink_exec('queue_legacy', $query$
  insert into public.agent_jobs(id, workspace_id, session_id, dedupe_key, trigger_type)
  values ('ad000000-0000-4000-8000-000000000002',
    'b1b2c3d4-0001-4000-8000-000000000001',
    'ad000000-0000-4000-8000-000000000001', 'pipeline:legacy-contender:active', 'assignment')
$query$);
select is((select count(*)::integer from public.agent_jobs
  where session_id = 'ad000000-0000-4000-8000-000000000001'), 1,
  'legacy insert commits while RPC holds a compatible session lock');
select extensions.dblink_exec('queue_gate', 'do $$ begin perform pg_advisory_unlock(99002026); end $$');
create temp table queue_race_result as
select * from extensions.dblink_get_result('queue_rpc') as result(job_id uuid, run_id uuid, created boolean);
select is((select job_id from queue_race_result), 'ad000000-0000-4000-8000-000000000002'::uuid,
  'RPC adopts the legacy job that won its insert race');
select is((select created from queue_race_result), false, 'adoption reports no newly created work');
select is((select run_id from queue_race_result), null::uuid, 'runless legacy adoption does not synthesize a competing run');
select is((select count(*)::integer from public.agent_jobs
  where session_id = 'ad000000-0000-4000-8000-000000000001'), 1, 'mixed producers leave exactly one job');
select is((select count(*)::integer from public.agent_runs
  where session_id = 'ad000000-0000-4000-8000-000000000001'), 0, 'legacy worker retains responsibility for its run');
-- Drain the asynchronous query completion before reusing its connection.
select count(*) from extensions.dblink_get_result('queue_rpc')
  as result(job_id uuid, run_id uuid, created boolean);

-- Two modern producers race an empty queue; both must observe the same pair.
select extensions.dblink_exec('queue_legacy', 'delete from public.agent_jobs where session_id = ''ad000000-0000-4000-8000-000000000001''');
select extensions.dblink_send_query('queue_rpc', $query$
  select * from public.enqueue_session_job_with_run(
    'ad000000-0000-4000-8000-000000000001', 'b1b2c3d4-0001-4000-8000-000000000001',
    (select current_stage_id from public.sessions where id = 'ad000000-0000-4000-8000-000000000001'),
    null, 'assignment', 'codex', 'gpt-5.5', 'project')
$query$);
select extensions.dblink_send_query('queue_legacy', $query$
  select * from public.enqueue_session_job_with_run(
    'ad000000-0000-4000-8000-000000000001', 'b1b2c3d4-0001-4000-8000-000000000001',
    (select current_stage_id from public.sessions where id = 'ad000000-0000-4000-8000-000000000001'),
    null, 'assignment', 'codex', 'gpt-5.5', 'project')
$query$);
create temp table queue_pair_race as select * from extensions.dblink_get_result('queue_rpc')
  as result(job_id uuid, run_id uuid, created boolean);
insert into queue_pair_race select * from extensions.dblink_get_result('queue_legacy')
  as result(job_id uuid, run_id uuid, created boolean);
select is((select count(*)::integer from queue_pair_race), 2, 'both atomic enqueue callers succeed');
select is((select count(distinct job_id)::integer from queue_pair_race), 1, 'both callers return one job');
select is((select count(distinct run_id)::integer from queue_pair_race), 1, 'both callers return one run');
select is((select count(*)::integer from queue_pair_race where created), 1, 'only one caller creates work');
select is((select count(*)::integer from public.agent_jobs where session_id = 'ad000000-0000-4000-8000-000000000001'), 1, 'RPC contention leaves one active job');
select is((select count(*)::integer from public.agent_runs where session_id = 'ad000000-0000-4000-8000-000000000001'), 1, 'RPC contention leaves one queued run');

select extensions.dblink_disconnect('queue_gate');
select extensions.dblink_disconnect('queue_rpc');
select extensions.dblink_disconnect('queue_legacy');
select * from finish();
commit;

-- The fixture and gate were committed so the independent connections could
-- see them. Remove them explicitly; all production schema is unchanged.
begin;
drop trigger test_pause_canonical_enqueue on public.agent_jobs;
drop function public.test_pause_canonical_enqueue();
delete from public.sessions where id = 'ad000000-0000-4000-8000-000000000001';
commit;
