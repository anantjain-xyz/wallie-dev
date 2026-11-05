begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

select ok((select relrowsecurity from pg_class where oid='internal.session_job_release_deferrals'::regclass),
  'release deferral receipts enforce private-schema RLS');
select ok(not has_table_privilege('service_role','internal.session_job_release_deferrals','SELECT')
  and not has_table_privilege('service_role','internal.session_job_release_deferrals','INSERT')
  and not has_table_privilege('service_role','internal.session_job_release_deferrals','UPDATE')
  and not has_table_privilege('authenticated','internal.session_job_release_deferrals','SELECT')
  and not has_table_privilege('anon','internal.session_job_release_deferrals','SELECT'),
  'service and browser callers cannot read or forge release deferral credits');
select ok(has_function_privilege('service_role',
  'internal.git_continuity_effective_attempt_count(uuid,uuid,uuid,integer)','EXECUTE')
  and not has_function_privilege('authenticated',
    'internal.git_continuity_effective_attempt_count(uuid,uuid,uuid,integer)','EXECUTE')
  and not has_function_privilege('anon',
    'internal.git_continuity_effective_attempt_count(uuid,uuid,uuid,integer)','EXECUTE'),
  'retry accounting is callable only through the service boundary');

-- Isolate actual queue claims; every fixture, control toggle and injected
-- failure rolls back at file end, including the preserved smoke-test history.
update public.agent_jobs set status='canceled' where status in('queued','started','running');
update public.agent_runs set status='canceled' where status in('queued','started','running');
insert into public.workspace_agent_config(workspace_id,key,value_json)
values('b1b2c3d4-0001-4000-8000-000000000001','concurrency_limit','20'::jsonb)
on conflict(workspace_id,key) do update set value_json=excluded.value_json;
insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0)
from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);

create function pg_temp.retry_release(enabled boolean) returns void language plpgsql as $$
begin
  perform * from public.set_git_continuity_release(enabled,
    (select revision from public.get_git_continuity_release_state()),'Retry accounting regression fixture');
end;
$$;
create function pg_temp.retry_fixture(label text)
returns table(session_id uuid,job_id uuid,run_id uuid) language sql as $$
  select created.session_id,created.job_id,created.run_id from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
    label,'Do not spend retries on release admission','codex','gpt-5.5',null,null,
    '12b2c3d4-0001-4000-8000-000000000001',null) created;
$$;
create function pg_temp.retry_claim(expected_job uuid,dispatch boolean default false)
returns integer language plpgsql as $$
declare claimed_job uuid; captured_attempt integer;
begin
  if dispatch then
    select job_id,attempt_count into strict claimed_job,captured_attempt
      from public.claim_next_worker_dispatch(20,20,1800000);
  else
    select id,attempt_count into strict claimed_job,captured_attempt from public.claim_next_agent_job(20);
  end if;
  if claimed_job<>expected_job then raise exception 'Queue claimed an unexpected fixture'; end if;
  return captured_attempt;
end;
$$;
create function pg_temp.retry_start(target_job uuid) returns uuid language plpgsql as $$
declare job public.agent_jobs; owner_session public.sessions;
begin
  select * into strict job from public.agent_jobs where id=target_job;
  select * into strict owner_session from public.sessions where id=job.session_id;
  return public.start_session_job_attempt(job.id,job.attempt_count,owner_session.current_stage_id,
    owner_session.current_artifact_version,'codex','gpt-5.5','project','wallie/retry-accounting-'||job.id);
end;
$$;

select pg_temp.retry_release(true);
create temp table retry_job as select * from pg_temp.retry_fixture('Release deferrals preserve real failure budget');
select is(pg_temp.retry_claim((select job_id from retry_job),true),1,
  'the first real queue claim has monotonic identity one');
select pg_temp.retry_release(false);

-- Force the job requeue to fail after the credit insertion. PostgreSQL must
-- roll back the receipt, job update and dispatch removal as one operation.
create function pg_temp.reject_retry_requeue() returns trigger language plpgsql as $$
begin
  if new.id=(select job_id from retry_job) and old.status='running' and new.status='queued' then
    raise exception 'Retry deferral rollback fixture.' using errcode='P0001';
  end if;
  return new;
end;
$$;
create trigger retry_deferral_rollback before update on public.agent_jobs
  for each row execute function pg_temp.reject_retry_requeue();
select throws_ok($$select public.defer_session_job_for_continuity_release((select job_id from retry_job),1)$$,
  'P0001','Retry deferral rollback fixture.','a failed atomic requeue rolls back its proposed release credit');
select is((select count(*) from internal.session_job_release_deferrals where job_id=(select job_id from retry_job)),0::bigint,
  'a failed deferral leaves no orphan retry credit');
select ok((select status='running' and attempt_count=1 and git_continuity_release_revision is not null
  from public.agent_jobs where id=(select job_id from retry_job)),
  'a rolled-back deferral preserves the original captured claim');
select is((select count(*) from public.worker_dispatches where job_id=(select job_id from retry_job) and attempt_count=1),1::bigint,
  'a rolled-back deferral preserves the exact Cloudflare dispatch');
drop trigger retry_deferral_rollback on public.agent_jobs;

select is(public.defer_session_job_for_continuity_release((select job_id from retry_job),1),true,
  'a committed release-only deferral earns its first credit');
select is(public.defer_session_job_for_continuity_release((select job_id from retry_job),1),false,
  'retrying a successful deferral after an uncertain reply cannot defer twice');
select is((select count(*) from internal.session_job_release_deferrals where job_id=(select job_id from retry_job)),1::bigint,
  'an uncertain duplicate reply mints exactly one credit');
select is((select count(*) from public.worker_dispatches where job_id=(select job_id from retry_job)),0::bigint,
  'the successful deferral removes its exact dispatch');
select pg_temp.retry_release(true);
select is(pg_temp.retry_claim((select job_id from retry_job),true),2,
  'resumption preserves identity monotonicity instead of reusing a deferred claim');
select pg_temp.retry_release(false);
select is(public.defer_session_job_for_continuity_release((select job_id from retry_job),1),false,
  'a stale previous claim cannot credit or defer the replacement claim');
select is(public.defer_session_job_for_continuity_release((select job_id from retry_job),2),true,
  'a second actual release-only deferral earns its own credit');
select is(public.defer_session_job_for_continuity_release((select job_id from retry_job),2),false,
  'the second deferral is also idempotent after commit');
select is((select array_agg(attempt_count order by attempt_count) from internal.session_job_release_deferrals
  where job_id=(select job_id from retry_job)),array[1,2],
  'the ledger contains exactly the two successfully deferred claim identities');
select throws_ok($$update internal.session_job_release_deferrals set deferred_at=deferred_at
  where job_id=(select job_id from retry_job) and attempt_count=1$$,
  '23514','Release deferral receipts are immutable.','even an owner cannot edit accepted retry credits');

select pg_temp.retry_release(true);
select is(pg_temp.retry_claim((select job_id from retry_job)),3,
  'the first actual execution starts under claim identity three');
create temp table first_execution as select pg_temp.retry_start((select job_id from retry_job)) as run_id;
select pg_temp.retry_release(false);
select is(public.defer_session_job_for_continuity_release((select job_id from retry_job),3),false,
  'a paused active execution cannot receive a release-only credit');
select is((select count(*) from internal.session_job_release_deferrals where job_id=(select job_id from retry_job)),2::bigint,
  'refusing to defer a running attempt preserves its real failure budget');
select is(public.fail_session_job_attempt((select job_id from retry_job),3,'First actual transient failure',true,3,
  (select run_id from first_execution)),'queued',
  'two release deferrals do not make the first actual failure terminal at max retries three');
select ok((select status='queued' and attempt_count=3 and last_error='First actual transient failure'
  and scheduled_at=now()+interval '10 seconds' and finished_at is null
  from public.agent_jobs where id=(select job_id from retry_job)),
  'effective failure one uses the normal ten-second backoff without decrementing the claim identity');
select is(public.fail_session_job_attempt((select job_id from retry_job),2,'Stale deferred callback',true,3,null),'stale',
  'a previously deferred claim cannot fail the queued replacement');
select ok((select scheduled_at=now()+interval '10 seconds' and last_error='First actual transient failure'
  from public.agent_jobs where id=(select job_id from retry_job)),
  'stale failure preserves the accepted retry decision and backoff');

-- Advance this fixture's scheduler only after asserting its real delay. Queue
-- admission and attempt numbers continue to come from the public claim RPC.
update public.agent_jobs set scheduled_at=null where id=(select job_id from retry_job);
select pg_temp.retry_release(true);
select is(pg_temp.retry_claim((select job_id from retry_job)),4,
  'the second actual execution receives the next monotonic claim identity');
select is(public.fail_session_job_attempt((select job_id from retry_job),4,'Old run under fresh claim',true,3,
  (select run_id from first_execution)),'stale',
  'a fresh claim number cannot authorize failure using an older execution run');
select is(public.fail_session_job_attempt((select job_id from retry_job),4,'Second actual runless setup failure',true,3,null),
  'queued','a real runless setup failure consumes the second execution retry rather than receiving a credit');
select ok((select status='queued' and attempt_count=4 and scheduled_at=now()+interval '20 seconds'
  from public.agent_jobs where id=(select job_id from retry_job)),
  'the second real failure uses the normal twenty-second backoff');
select is((select count(*) from internal.session_job_release_deferrals where job_id=(select job_id from retry_job)),2::bigint,
  'a runless setup failure creates no release-only credit');
update public.agent_jobs set scheduled_at=null where id=(select job_id from retry_job);
select is(pg_temp.retry_claim((select job_id from retry_job)),5,
  'the third actual execution retains monotonic claim identity five');
create temp table last_execution as select pg_temp.retry_start((select job_id from retry_job)) as run_id;
select is(public.fail_stalled_session_job_attempt((select job_id from retry_job),5,'Third actual stalled failure',true,3,
  (select run_id from last_execution)),'error',
  'stalled failure shares direct failure accounting and exhausts the third actual execution');
select ok((select status='error' and attempt_count=5 and scheduled_at is null and finished_at is not null
  and last_error='Third actual stalled failure' from public.agent_jobs where id=(select job_id from retry_job)),
  'real failures terminate at the original budget despite larger fenced claim identities');
select is((select count(*) from internal.session_job_release_deferrals where job_id=(select job_id from retry_job)),2::bigint,
  'only actual release-only deferrals reduce the execution retry count');

-- A durable publication remains recoverable; neither a pause nor the new
-- accounting may convert its authoritative stalled-job refusal into failure.
create temp table publication_job as select * from pg_temp.retry_fixture('Retry accounting keeps durable publication guard');
select is(pg_temp.retry_claim((select job_id from publication_job)),1,'a separate job has its own independent claim budget');
create temp table publication_run as select pg_temp.retry_start((select job_id from publication_job)) as run_id;
select * from public.pin_session_job_git_input((select job_id from publication_job),1,(select run_id from publication_run),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40));
select is(public.prepare_session_source_and_checkpoint_publication((select run_id from publication_run),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40),repeat('b',40),'Retry publication guard','Body','',
  encode(extensions.digest('retry publication'::bytea,'sha256'),'hex'),encode('retry publication'::bytea,'base64'),0,
  'Recover this exact accepted source'),true,'the owned execution prepares a durable publication obligation');
select pg_temp.retry_release(false);
select is(public.fail_stalled_session_job_attempt((select job_id from publication_job),1,'Stale publication stall',true,3,
  (select run_id from publication_run)),'stale','paused durable publication still refuses stale stalled-job retirement');
select ok((select j.status='running' and j.attempt_count=1 and r.status='running' and p.status='pending'
  from publication_job fixture join public.agent_jobs j on j.id=fixture.job_id
  join public.agent_runs r on r.id=(select run_id from publication_run)
  join public.session_checkpoint_publications p on p.run_id=r.id),
  'durable publication refusal preserves its owned run and recovery intent');
select is((select count(*) from internal.session_job_release_deferrals where job_id=(select job_id from publication_job)),0::bigint,
  'a protected active publication receives no retry credit');

-- A claim captured before revision metadata existed can still be safely
-- deferred. The receipt records the known NULL rather than inventing history.
select pg_temp.retry_release(true);
create temp table legacy_claim as select * from pg_temp.retry_fixture('Old claim with unknown release revision');
select is(pg_temp.retry_claim((select job_id from legacy_claim)),1,'the compatibility fixture owns a real queue claim');
update public.agent_jobs set git_continuity_release_revision=null where id=(select job_id from legacy_claim);
select is(public.defer_session_job_for_continuity_release((select job_id from legacy_claim),1),true,
  'an unstarted historical claim with missing revision metadata can be safely deferred');
select ok((select attempt_count=1 and release_revision is null from internal.session_job_release_deferrals
  where job_id=(select job_id from legacy_claim)),
  'legacy claim deferral preserves the unknown revision and earns exactly its own credit');
select is(public.defer_session_job_for_continuity_release((select job_id from legacy_claim),1),false,
  'historical NULL-revision deferral cannot double-credit a duplicate request');

select * from finish();
rollback;
