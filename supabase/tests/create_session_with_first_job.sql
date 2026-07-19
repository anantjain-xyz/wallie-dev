begin;

create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;

select plan(23);
set local "request.jwt.claim.role" = 'service_role';

select has_function(
  'public',
  'create_session_with_first_job',
  array['uuid', 'uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'uuid', 'uuid'],
  'transactional create RPC exists'
);
select function_privs_are(
  'public',
  'create_session_with_first_job',
  array['uuid', 'uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'uuid', 'uuid'],
  'service_role',
  array['EXECUTE'],
  'service_role can execute the create RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.create_session_with_first_job(uuid,uuid,text,text,text,text,text,text,uuid,uuid)',
    'EXECUTE'
  ),
  'anon cannot execute the create RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.create_session_with_first_job(uuid,uuid,text,text,text,text,text,text,uuid,uuid)',
    'EXECUTE'
  ),
  'authenticated cannot execute the create RPC'
);
select is(
  (
    select config
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    cross join lateral unnest(procedure.proconfig) config
    where namespace.nspname = 'public'
      and procedure.proname = 'create_session_with_first_job'
      and config like 'search_path=%'
  ),
  'search_path=""',
  'security definer RPC has an empty search_path'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.sessions'::regclass),
  'sessions keeps RLS enabled'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.agent_jobs'::regclass),
  'agent_jobs keeps RLS enabled'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.agent_runs'::regclass),
  'agent_runs keeps RLS enabled'
);
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000000099';
select is(
  (select count(*)::integer from public.sessions),
  0,
  'RLS hides sessions from an authenticated user without membership'
);
reset role;
set local "request.jwt.claim.role" = 'service_role';

create temp table test_baseline as
select last_issue_number
from internal.workspace_issue_counters
where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001';

create temp table first_result as
select *
from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'Atomic create proof',
  'Create the session transactionally.',
  'codex',
  'gpt-5.5',
  null,
  null,
  '12b2c3d4-0001-4000-8000-000000000001',
  null
);

select is((select count(*)::integer from first_result), 1, 'RPC returns one navigation row');
select is((select workspace_slug from first_result), 'acme-corp', 'RPC returns workspace slug');
select ok(
  exists (
    select 1
    from public.sessions session
    join first_result result on result.session_id = session.id
    where session.number = result.session_number
      and session.pipeline_id = 'd1b2c3d4-0001-4000-8000-000000000001'
      and session.phase_status = 'agent_generating'
  ),
  'session is numbered and pinned to the default pipeline'
);
select ok(
  exists (
    select 1
    from public.agent_jobs job
    join first_result result on result.job_id = job.id
    where job.session_id = result.session_id
      and job.dedupe_key = 'session:' || result.session_id::text || ':active'
      and job.trigger_type = 'assignment'
      and job.status = 'queued'
      and job.stage_slug = 'plan'
  ),
  'first job uses the active-session dedupe key and stage snapshot'
);
select ok(
  exists (
    select 1
    from public.agent_runs run
    join first_result result on result.run_id = run.id
    where run.agent_job_id = result.job_id
      and run.session_id = result.session_id
      and run.run_type = 'code'
      and run.model_provider = 'codex'
      and run.model_name = 'gpt-5.5'
  ),
  'first run is linked to the job with the requested model'
);
select throws_ok(
  $$
    insert into public.agent_jobs (
      workspace_id, session_id, requested_by_member_id, stage_id,
      stage_slug, stage_name, trigger_type, dedupe_key
    )
    select
      'b1b2c3d4-0001-4000-8000-000000000001', result.session_id,
      'c1b2c3d4-0001-4000-8000-000000000001', job.stage_id,
      job.stage_slug, job.stage_name, 'assignment', job.dedupe_key
    from first_result result
    join public.agent_jobs job on job.id = result.job_id
  $$,
  '23505',
  null,
  'active job dedupe index rejects a duplicate'
);

create function pg_temp.fail_atomic_create()
returns trigger
language plpgsql
as $$
begin
  if new.model_name = 'force-run-failure' then
    raise exception 'forced run failure' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger fail_atomic_create
before insert on public.agent_runs
for each row execute function pg_temp.fail_atomic_create();

create temp table rollback_before as
select
  (select count(*) from public.sessions) as session_count,
  (select count(*) from public.agent_jobs) as job_count,
  (
    select last_issue_number
    from internal.workspace_issue_counters
    where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
  ) as last_issue_number;

select throws_ok(
  $$
    select *
    from public.create_session_with_first_job(
      'b1b2c3d4-0001-4000-8000-000000000001',
      'c1b2c3d4-0001-4000-8000-000000000001',
      'Must roll back',
      'Force the run insert to fail.',
      'codex', 'force-run-failure', null, null, null, null
    )
  $$,
  'P0001',
  'forced run failure',
  'run insertion failure aborts the RPC'
);
select is(
  (select count(*) from public.sessions),
  (select session_count from rollback_before),
  'failed RPC leaves no session'
);
select is(
  (select count(*) from public.agent_jobs),
  (select job_count from rollback_before),
  'failed RPC leaves no job'
);
select is(
  (
    select last_issue_number
    from internal.workspace_issue_counters
    where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
  ),
  (select last_issue_number from rollback_before),
  'failed RPC rolls back number allocation'
);

drop trigger fail_atomic_create on public.agent_runs;

-- Release the counter-row lock taken by the happy-path call before separate
-- dblink sessions race on it. pgTAP state and temp result tables are session
-- scoped, so the plan continues across this transaction boundary.
commit;
begin;
set local "request.jwt.claim.role" = 'service_role';

do $$
declare
  connection_name text;
  query text;
begin
  for index in 1..20 loop
    connection_name := 'create_' || index;
    perform extensions.dblink_connect(
      connection_name,
      'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'
    );
    query := format(
      $query$
        select created.session_id, created.session_number
        from (select set_config('request.jwt.claim.role', 'service_role', false) as role) config
        cross join lateral public.create_session_with_first_job(
          'b1b2c3d4-0001-4000-8000-000000000001',
          'c1b2c3d4-0001-4000-8000-000000000001',
          %L || left(config.role, 0), 'Concurrent create proof.',
          'codex', 'gpt-5.5', null, null, null, null
        ) created
      $query$,
      'Concurrent create ' || index
    );
    perform extensions.dblink_send_query(connection_name, query);
  end loop;
end;
$$;

create temp table concurrent_results (
  session_id uuid,
  session_number integer
);

do $$
declare
  connection_name text;
begin
  for index in 1..20 loop
    connection_name := 'create_' || index;
    insert into concurrent_results
    select result.session_id, result.session_number
    from extensions.dblink_get_result(connection_name) as result(
      session_id uuid,
      session_number integer
    );
    perform extensions.dblink_disconnect(connection_name);
  end loop;
end;
$$;

select is((select count(*)::integer from concurrent_results), 20, '20 concurrent creates succeed');
select is(
  (select count(distinct session_number)::integer from concurrent_results),
  20,
  '20 concurrent creates allocate unique workspace numbers'
);
select is(
  (
    select count(*)::integer
    from concurrent_results result
    join public.sessions session on session.id = result.session_id
    join public.agent_jobs job on job.session_id = result.session_id
    join public.agent_runs run on run.agent_job_id = job.id
  ),
  20,
  'every concurrent session has its first job and run'
);
select is(
  (
    select count(*)::integer
    from public.sessions session
    left join public.agent_jobs job on job.session_id = session.id
    where session.id in (select session_id from concurrent_results)
      and job.id is null
  ),
  0,
  'no concurrent session is stranded without a job'
);

delete from public.sessions
where id in (select session_id from first_result)
   or id in (select session_id from concurrent_results);

update internal.workspace_issue_counters
set last_issue_number = (select last_issue_number from test_baseline),
    updated_at = now()
where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001';

select * from finish();

commit;
