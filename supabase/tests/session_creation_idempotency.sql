begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

select ok(
  (select relrowsecurity from pg_catalog.pg_class
   where oid = 'internal.session_creation_requests'::regclass),
  'creation request records have RLS enabled'
);
select ok(not has_table_privilege('authenticated', 'internal.session_creation_requests', 'SELECT'),
  'authenticated callers cannot read request records');
select ok(not has_function_privilege('anon',
  'public.find_session_creation_request(uuid,uuid,uuid,text)', 'EXECUTE'),
  'anonymous callers cannot discover creation requests');
select ok(not has_function_privilege('authenticated',
  'public.create_session_once_with_first_job(uuid,uuid,uuid,text,text,text,text,text,uuid[],text,text,uuid,uuid,uuid[])', 'EXECUTE'),
  'authenticated callers cannot bypass the creation route');
select ok(has_function_privilege('service_role',
  'public.create_session_once_with_first_job(uuid,uuid,uuid,text,text,text,text,text,uuid[],text,text,uuid,uuid,uuid[])', 'EXECUTE'),
  'the privileged route can create idempotently');

create temp table retry_baseline as select last_issue_number
from internal.workspace_issue_counters
where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001';

insert into public.session_attachments (
  id, workspace_id, uploaded_by_member_id, original_filename, content_type,
  size_bytes, storage_path, status, expires_at
) values (
  'ab000000-0000-4000-8000-000000000001',
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'retry-proof.png', 'image/png', 1024, 'retry-proof/image.png', 'ready', now() + interval '1 hour'
);

create temp table original_creation as select * from public.create_session_once_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'ab000000-0000-4000-8000-000000000002', repeat('a', 64),
  'Creation retry proof', 'Create once with an image.', 'codex', 'gpt-5.5',
  array['ab000000-0000-4000-8000-000000000001'::uuid]
);
create temp table replayed_creation as select * from public.create_session_once_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'ab000000-0000-4000-8000-000000000002', repeat('a', 64),
  'A newly generated title', 'Create once with an image.', 'codex', 'gpt-5.5',
  array['ab000000-0000-4000-8000-000000000001'::uuid]
);
select results_eq('select * from replayed_creation', 'select * from original_creation',
  'a retry returns the original session, number, job, and run even after attachments bind');
select is((select title from public.sessions where id = (select session_id from original_creation)),
  'Creation retry proof', 'a regenerated title does not overwrite the committed session');
select is((select count(*)::integer from public.agent_jobs where session_id = (select session_id from original_creation)),
  1, 'retries do not enqueue another job');
select is((select count(*)::integer from public.agent_runs where session_id = (select session_id from original_creation)),
  1, 'retries do not create another run');
select is((select last_issue_number from internal.workspace_issue_counters
  where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'),
  (select last_issue_number + 1 from retry_baseline), 'retries do not consume another session number');
select is((select status from public.session_attachments where id = 'ab000000-0000-4000-8000-000000000001'),
  'attached', 'the original attachment remains attached');

select throws_ok($$
  select * from public.find_session_creation_request(
    'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
    'ab000000-0000-4000-8000-000000000002', repeat('b', 64))
$$, 'P0005', 'This creation request was already used for different session input',
  'a request id cannot silently change its user input');
select throws_ok($$
  select * from public.find_session_creation_request(
    'b1b2c3d4-0001-4000-8000-000000000001', 'ab000000-0000-4000-8000-000000000099',
    'ab000000-0000-4000-8000-000000000002', repeat('a', 64))
$$, '42501', 'Creator is not an active human workspace member',
  'nonmembers cannot replay another creator request');
select is((select count(*)::integer from public.find_session_creation_request(
  'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0002-4000-8000-000000000002',
  'ab000000-0000-4000-8000-000000000002', repeat('a', 64))),
  0, 'another workspace member cannot replay the creator request');

select throws_ok($$
  select * from public.create_session_once_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
    'ab000000-0000-4000-8000-000000000003', repeat('a', 64),
    'Failed attachment proof', 'Do not create without the image.', 'codex', 'gpt-5.5',
    array['ab000000-0000-4000-8000-000000000099'::uuid])
$$, 'P0004', 'Session attachments changed, expired, or are not available',
  'a failed creation rolls back');
select is((select count(*)::integer from public.find_session_creation_request(
  'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
  'ab000000-0000-4000-8000-000000000003', repeat('a', 64))),
  0, 'failed attempts leave no poisoned request record');

-- Release the workspace counter lock before independent connections race.
commit;
begin;
create temp table concurrent_retries (session_id uuid, session_number integer);
do $$
declare
  connection_name text;
begin
  for attempt in 1..8 loop
    connection_name := 'session_retry_' || attempt;
    perform extensions.dblink_connect(connection_name,
      'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres');
    perform extensions.dblink_send_query(connection_name, $query$
      select created.session_id, created.session_number
      from (select set_config('request.jwt.claim.role', 'service_role', false) as role) config
      cross join lateral public.create_session_once_with_first_job(
        'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
        'ab000000-0000-4000-8000-000000000004', repeat('c', 64),
        'Concurrent retry proof' || left(config.role, 0),
        'All eight calls are the same request.', 'codex', 'gpt-5.5', '{}'::uuid[]
      ) created
    $query$);
  end loop;
  for attempt in 1..8 loop
    connection_name := 'session_retry_' || attempt;
    insert into concurrent_retries select * from extensions.dblink_get_result(connection_name)
      as result(session_id uuid, session_number integer);
    perform extensions.dblink_disconnect(connection_name);
  end loop;
end;
$$;
select is((select count(*)::integer from concurrent_retries), 8, 'all eight concurrent retries succeed');
select is((select count(distinct session_id)::integer from concurrent_retries), 1,
  'concurrent retries create exactly one session');
select is((select count(distinct session_number)::integer from concurrent_retries), 1,
  'concurrent retries return one session number');
select is((select count(*)::integer from public.agent_jobs where session_id in (select session_id from concurrent_retries)),
  1, 'concurrent retries enqueue exactly one job');

delete from public.sessions where id in (select session_id from original_creation)
  or id in (select session_id from concurrent_retries);
delete from public.session_attachments where id = 'ab000000-0000-4000-8000-000000000001';
update internal.workspace_issue_counters set last_issue_number = (select last_issue_number from retry_baseline)
where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001';
select * from finish();
commit;
