begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

select ok((select relrowsecurity from pg_class where oid = 'public.worker_dispatches'::regclass), 'job dispatches enforce RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.worker_auth_dispatches'::regclass), 'auth dispatches enforce RLS');
select ok(not has_table_privilege('authenticated', 'public.worker_dispatches', 'SELECT'), 'users cannot read dispatch metadata');
select ok(not has_table_privilege('anon', 'public.worker_auth_dispatches', 'SELECT'), 'anonymous clients cannot read auth claims');
select ok(not has_function_privilege('authenticated', 'public.claim_next_worker_dispatch(integer,integer,integer)', 'EXECUTE'), 'dispatch claims are service-only');
select ok(not has_function_privilege('anon', 'public.begin_worker_dispatch(uuid,integer,text)', 'EXECUTE'), 'execution fences are service-only');

-- Isolate ready work from seed fixtures. All changes roll back.
update public.agent_jobs set status = 'canceled' where status in ('queued','started','running');
update public.agent_runs set status = 'canceled' where status in ('queued','started','running');
insert into public.workspace_agent_config(workspace_id,key,value_json)
values ('b1b2c3d4-0001-4000-8000-000000000001','concurrency_limit','2'::jsonb)
on conflict (workspace_id,key) do update set value_json=excluded.value_json;
insert into internal.workspace_issue_counters as counters(workspace_id, last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid, coalesce(max(number), 0)
from public.sessions where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
on conflict (workspace_id) do update set last_issue_number = greatest(counters.last_issue_number, excluded.last_issue_number);

create temp table first_job as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Cloudflare first job','Dispatch atomically.','codex','test-model',null,null,
  '12b2c3d4-0001-4000-8000-000000000001',null);
create temp table second_job as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Cloudflare second job','Respect global capacity.','cursor','test-model',null,null,
  '12b2c3d4-0001-4000-8000-000000000001',null);

create temp table captured as select * from public.claim_next_worker_dispatch(1, 2, 1800000);
select is((select count(*) from captured), 1::bigint, 'claim creates one dispatch');
select is((select attempt_count from public.agent_jobs where id=(select job_id from captured)), 1, 'outbox records the claimed attempt');
select is((select status::text from public.agent_jobs where id=(select job_id from captured)), 'running', 'job and dispatch commit together');
select is((select count(*) from public.claim_next_worker_dispatch(1,2,1800000)), 0::bigint, 'global capacity prevents another claim');
select ok(public.begin_worker_dispatch((select job_id from captured),1,(select workflow_id from captured)), 'first execution acquires its fence');
select ok(not public.begin_worker_dispatch((select job_id from captured),1,(select workflow_id from captured)), 'replay cannot execute the same attempt');
select ok(not public.begin_worker_dispatch((select job_id from captured),2,(select workflow_id from captured)), 'a different attempt cannot adopt the fence');

create temp table expired as select * from public.claim_next_worker_dispatch(2,2,1800000);
update public.worker_dispatches set deadline_at=now()-interval '1 second' where job_id=(select job_id from expired);
select ok(not public.begin_worker_dispatch((select job_id from expired),1,(select workflow_id from expired)), 'expired attempts cannot start');
select throws_ok('select * from public.claim_next_worker_dispatch(0,2,1800000)', 'P0001', 'Invalid worker dispatch limits', 'reject invalid global capacity');
select throws_ok('select * from public.claim_next_worker_dispatch(10,2,1800001)', 'P0001', 'Invalid worker dispatch limits', 'attempts cannot exceed 30 minutes');

-- Simulate the outbox write failing after the queue claim.
update public.agent_jobs set status='queued' where id=(select job_id from expired);
create function pg_temp.reject_dispatch() returns trigger language plpgsql as $$ begin raise exception 'Synthetic outbox failure'; end $$;
create trigger reject_dispatch before insert on public.worker_dispatches for each row execute function pg_temp.reject_dispatch();
select throws_ok('select * from public.claim_next_worker_dispatch(10,2,1800000)', 'P0001', 'Synthetic outbox failure', 'outbox failure aborts claim transaction');
select is((select status::text from public.agent_jobs where id=(select job_id from expired)), 'queued', 'failed dispatch does not strand a running job');
select is((select attempt_count from public.agent_jobs where id=(select job_id from expired)), 1, 'failed dispatch does not consume an attempt');
drop trigger reject_dispatch on public.worker_dispatches;

update public.cursor_auth_flows set status='canceled' where status in ('starting','processing','prompted');
create temp table test_auth_users as select gen_random_uuid() as id, n from generate_series(1,5) n;
insert into auth.users(id,email) select id,'cloudflare-test-' || n::text || '@example.invalid' from test_auth_users;
insert into public.cursor_auth_flows(user_id, expires_at)
select id, now()+interval '10 minutes' from test_auth_users;
create temp table auth_claims as select * from public.claim_next_worker_auth_dispatch();
insert into auth_claims select * from public.claim_next_worker_auth_dispatch();
insert into auth_claims select * from public.claim_next_worker_auth_dispatch();
insert into auth_claims select * from public.claim_next_worker_auth_dispatch();
select is((select count(*) from auth_claims),4::bigint,'four sign-ins can run concurrently');
select is((select count(*) from public.claim_next_worker_auth_dispatch()),0::bigint,'fifth sign-in waits for capacity');
update public.cursor_auth_flows set claimed_at=now()-interval '16 seconds' where id=(select flow_id from auth_claims limit 1);
create temp table reclaimed as select * from public.claim_next_worker_auth_dispatch();
select is((select count(*) from reclaimed),1::bigint,'stale auth lease releases capacity');
select ok(not exists(select 1 from reclaimed r join auth_claims a using(flow_id,claim_token)), 'reclaimed sign-in gets a new execution identity');
select * from finish();
rollback;
