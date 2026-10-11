begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role"='service_role';
set local storage.allow_delete_query='true';
insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0) from public.sessions
where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);

create temp table source_fixture as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Source delivery fixture','Preserve source','codex','gpt-5.5',null,null,null,null);
update public.agent_jobs set status='running',attempt_count=1 where id=(select job_id from source_fixture);
select public.start_session_job_attempt(f.job_id,1,s.current_stage_id,0,'codex','gpt-5.5','project','wallie/source-fixture')
from source_fixture f join public.sessions s on s.id=f.session_id;
update public.agent_runs set source_recovery_required=true where id=(select run_id from source_fixture);
create function pg_temp.prepare_source(path text default '',bundle text default encode('private source'::bytea,'base64'))
returns boolean language sql as $$
  select public.prepare_session_source_delivery(f.run_id,
    (select id from public.github_repositories where workspace_id='b1b2c3d4-0001-4000-8000-000000000001' limit 1),
    'trunk',repeat('a',40),repeat('b',40),'Build','Artifact',path,
    encode(extensions.digest('private source'::bytea,'sha256'),'hex'),bundle)
  from source_fixture f;
$$;
select throws_ok($$select public.publish_session_job_with_source(job_id,1,run_id,0,'Artifact') from source_fixture$$,
  '23514','Source checkpoint is required before publication.','publication fails closed without a durable checkpoint');
select throws_ok($$select pg_temp.prepare_source('missing','')$$,'23514','Source checkpoint is not durable.',
  'a path without a stored object cannot satisfy the durability gate');
select throws_ok($$select pg_temp.prepare_source('','Y29ycnVwdA==')$$,'23514','Invalid source checkpoint.',
  'fallback bytes must match their recorded digest');
select is(pg_temp.prepare_source(),true,'a bounded DB fallback is durable before publication');
select is((select source_recovery_required from public.agent_runs where id=(select run_id from source_fixture)),false,
  'recording durable source clears retention in the same transaction');
select is(pg_temp.prepare_source(),true,'retrying preparation is idempotent');
select is((select count(*) from public.session_source_deliveries where run_id=(select run_id from source_fixture)),1::bigint,
  'one outbox record represents one exact run');
select is(public.claim_session_source_delivery(),null::uuid,'a crash before artifact publication does not deliver unpublished work');
create function pg_temp.expired_source_publication() returns boolean language plpgsql as $$
begin
  perform public.publish_session_job_with_source(job_id,1,run_id,0,'Artifact',clock_timestamp()-interval '1 second') from source_fixture;
  return false;
exception when query_canceled then return true;
end;
$$;
select is(pg_temp.expired_source_publication(),true,'source durability does not bypass the publication deadline');
select is((select public.publish_session_job_with_source(job_id,1,run_id,0,'Artifact',clock_timestamp()+interval '1 minute') from source_fixture),true,
  'publication makes the prepared checkpoint eligible in the same transaction');
select ok(public.claim_session_source_delivery() is not null,'published work is claimed for delivery');
create temp table old_source_lease as select claim_id from public.session_source_deliveries where run_id=(select run_id from source_fixture);
select is(public.claim_session_source_delivery(),null::uuid,'another worker cannot claim an unexpired delivery lease');
update public.session_source_deliveries set lease_expires_at=now()-interval '1 second' where run_id=(select run_id from source_fixture);
select ok(public.claim_session_source_delivery() is not null,'a worker crash becomes retryable after its lease expires');
select is(public.finish_session_source_delivery((select run_id from source_fixture),(select claim_id from old_source_lease),true),false,
  'a resumed old worker cannot retire a replacement lease');
select is(public.finish_session_source_delivery((select run_id from source_fixture),
  (select claim_id from public.session_source_deliveries where run_id=(select run_id from source_fixture)),false),true,
  'failed push or PR delivery becomes a scheduled retry');
select ok((select bundle_base64 is not null and next_attempt_at>now() from public.session_source_deliveries where run_id=(select run_id from source_fixture)),
  'failure preserves the fallback and backs off');
update public.session_source_deliveries set next_attempt_at=now() where run_id=(select run_id from source_fixture);
select ok(public.claim_session_source_delivery() is not null,'a due failed delivery can retry');
select is(public.finish_session_source_delivery((select run_id from source_fixture),
  (select claim_id from public.session_source_deliveries where run_id=(select run_id from source_fixture)),true),true,
  'successful GitHub delivery acknowledges only its own lease');
select ok((select bundle_base64 is null and status='delivered' from public.session_source_deliveries where run_id=(select run_id from source_fixture)),
  'successful delivery clears the private fallback bytes');
select is(public.claim_session_source_delivery(),null::uuid,'delivered source is not claimed again');
select ok((select not public from storage.buckets where id='session-source-checkpoints'),'checkpoint bucket is private');
select ok(not has_table_privilege('authenticated','public.session_source_deliveries','SELECT'),
  'browser sessions cannot read source bundles or delivery metadata');
select ok(not has_function_privilege('authenticated','public.prepare_session_source_delivery(uuid,uuid,text,text,text,text,text,text,text,text)','EXECUTE'),
  'browser sessions cannot enqueue privileged source delivery');

update public.session_source_deliveries set status='pending',next_attempt_at=now(),bundle_base64=encode('private source'::bytea,'base64')
where run_id=(select run_id from source_fixture);
update public.agent_jobs set status='canceled' where id=(select job_id from source_fixture);
select is(public.claim_session_source_delivery(),null::uuid,'canceling a published job prevents hidden GitHub delivery');
update public.agent_jobs set status='success' where id=(select job_id from source_fixture);
update public.sessions set archived_at=now() where id=(select session_id from source_fixture);
select is(public.claim_session_source_delivery(),null::uuid,'archiving a review in progress prevents delivery');
update public.sessions set phase_status='approved' where id=(select session_id from source_fixture);
select ok(public.claim_session_source_delivery() is not null,'final approval autoarchive still permits its source delivery');
update public.agent_jobs set status='canceled' where id=(select job_id from source_fixture);
select is(public.assert_session_source_delivery_claim((select run_id from source_fixture),
  (select claim_id from public.session_source_deliveries where run_id=(select run_id from source_fixture))),false,
  'cancellation invalidates an already captured delivery lease');
update public.agent_jobs set status='success' where id=(select job_id from source_fixture);
update public.sessions set phase_status='in_progress',archived_at=null where id=(select session_id from source_fixture);
select is(public.assert_session_source_delivery_claim((select run_id from source_fixture),
  (select claim_id from public.session_source_deliveries where run_id=(select run_id from source_fixture))),true,
  'an approved prior stage remains deliverable while a successor runs');
select public.finish_session_source_delivery((select run_id from source_fixture),
  (select claim_id from public.session_source_deliveries where run_id=(select run_id from source_fixture)),false);
delete from public.github_repositories where id=(select repository_id from public.session_source_deliveries where run_id=(select run_id from source_fixture));
select ok((select repository_id is null and bundle_base64 is not null from public.session_source_deliveries where run_id=(select run_id from source_fixture)),
  'removing a repository connection preserves the sole durable fallback copy');
update public.session_source_deliveries set next_attempt_at=now() where run_id=(select run_id from source_fixture);
select is(public.claim_session_source_delivery(),null::uuid,'disconnected source awaits deliberate repository recovery');

insert into public.workspaces(id,name,slug) values('de500000-0000-4000-8000-000000000001','Source deletion fixture','source-deletion-fixture');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
('de500000-0000-4000-8000-000000000002','de500000-0000-4000-8000-000000000001','a1b2c3d4-0001-4000-8000-000000000001','human','owner');
insert into storage.objects(bucket_id,name) values('session-source-checkpoints','de500000-0000-4000-8000-000000000001/run.bundle');
select public.begin_workspace_deletion('de500000-0000-4000-8000-000000000001','de500000-0000-4000-8000-000000000002','Source deletion fixture');
select is(public.finish_workspace_deletion('de500000-0000-4000-8000-000000000001'),false,'checkpoint objects prevent premature workspace deletion');
select throws_ok($$insert into storage.objects(bucket_id,name) values('session-source-checkpoints','de500000-0000-4000-8000-000000000001/late.bundle')$$,
'P0010','Workspace deletion is in progress.','late checkpoint uploads cannot recreate a deleting workspace prefix');
delete from storage.objects where bucket_id='session-source-checkpoints' and name='de500000-0000-4000-8000-000000000001/run.bundle';
select is(public.finish_workspace_deletion('de500000-0000-4000-8000-000000000001'),true,'deletion can finish after checkpoint cleanup');
select * from finish();
rollback;
