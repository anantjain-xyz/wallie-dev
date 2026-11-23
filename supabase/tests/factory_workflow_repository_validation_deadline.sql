begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
-- Peer transactions need committed fixture rows. Serialize invocations and
-- remove only this fixture's exact roots if the previous process was interrupted.
select pg_advisory_lock(hashtextextended('wallie.test.repository_validation_deadline', 0));
delete from public.workspaces
where id = '65330000-0000-4000-8000-000000000011' and slug = 'op651-65330000';
delete from auth.users
where id = '65330000-0000-4000-8000-000000000001' and email = 'op651-65330000@example.test';
\set op651_fixture_namespace 65330000
\set op653_test_validation_seconds 15
\ir fixtures/factory_workflow_repository_delivery.psql

-- Publish the exact passing validation attempt before coordinating peer locks.
commit;
set request.jwt.claim.role = 'service_role';

create function pg_temp.test_repository_validation_cutoff() returns setof text language plpgsql as $$
declare
  connection_info text := coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
    'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres');
  holder text := 'op653_validation_table_lock_' || current_setting('wallie.op651_fixture_namespace');
  worker text := 'op653_validation_late_worker_' || current_setting('wallie.op651_fixture_namespace');
  peer text;
  captured jsonb;
  seal_sql text;
  accepted boolean;
  cutoff timestamptz;
  waited boolean;
  bundle bytea := convert_to('secondary validation bundle','UTF8');
begin
  select claim into strict captured from secondary_claim;
  cutoff := (captured->>'deadlineAt')::timestamptz;
  foreach peer in array array[holder,worker] loop
    perform extensions.dblink_connect(peer, connection_info);
    perform extensions.dblink_exec(peer, format('set application_name=%L; set statement_timeout=%L; set request.jwt.claim.role=%L',
      peer, '30s', 'service_role'));
  end loop;

  perform extensions.dblink_exec(holder, 'begin; lock table public.session_validation_plans in access exclusive mode');
  seal_sql := format(
    'select public.finish_factory_workflow_repository_validation(%L::uuid,%L::uuid,%L::uuid,%L::bigint,%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L::int,%L,%L,%L,%L,%L)',
    captured->>'rootSessionId', captured->>'workspaceId', captured->>'factoryId', captured->>'generation',
    captured->>'ownershipToken', captured->>'joinId', captured->>'repositoryId', captured->>'jobId',
    captured->>'runId', captured->>'attemptCount', 'passed', repeat('4',40), repeat('5',40),
    encode(sha256(bundle),'hex'), encode(bundle,'base64'));
  perform extensions.dblink_send_query(worker, seal_sql);
  loop
    select exists (
      select 1 from pg_stat_activity active
      cross join lateral unnest(pg_blocking_pids(active.pid)) blockers(blocker)
      join pg_stat_activity owning on owning.pid = blockers.blocker
      where active.datname = current_database() and active.application_name = worker and owning.application_name = holder
    ) into waited;
    exit when waited or clock_timestamp() >= cutoff;
    perform pg_sleep(0.02);
  end loop;
  return next ok(waited, 'the exact active worker blocks while reading validation evidence');
  perform pg_sleep(greatest(0, extract(epoch from cutoff - clock_timestamp())) + 0.05);
  perform extensions.dblink_exec(holder, 'commit');

  select value into strict accepted from extensions.dblink_get_result(worker) status(value boolean);
  return next is(accepted, false, 'an elapsed secondary attempt cannot seal after the evidence lock releases');
  return next is(pg_temp.multi_status() #>> '{repositories,0,status}', 'awaiting_validation',
    'the elapsed attempt leaves no pending remote write');
exception when others then
  return next fail(format('independent validation transactions failed (%s): %s', SQLSTATE, SQLERRM));
end;
$$;

select * from pg_temp.test_repository_validation_cutoff();
select extensions.dblink_disconnect(name) from unnest(extensions.dblink_get_connections()) name
where name in (
  'op653_validation_table_lock_' || current_setting('wallie.op651_fixture_namespace'),
  'op653_validation_late_worker_' || current_setting('wallie.op651_fixture_namespace')
);

begin;
delete from public.workspaces where id = pg_temp.op651_id(11);
delete from auth.users where id = pg_temp.op651_id(1);
select ok(not exists (select 1 from public.workspaces where id = pg_temp.op651_id(11))
  and not exists (select 1 from auth.users where id = pg_temp.op651_id(1)),
  'cleanup removes the exact committed fixture');
select * from finish();
commit;
select pg_advisory_unlock(hashtextextended('wallie.test.repository_validation_deadline', 0));
