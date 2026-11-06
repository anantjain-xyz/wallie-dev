begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0)
from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);
create function pg_temp.failure_state(statement text) returns text language plpgsql as $$
begin
  begin execute statement; return '00000'; exception when others then return sqlstate; end;
end;
$$;
create function pg_temp.evidence_fixture(label text)
returns table(session_id uuid,job_id uuid,run_id uuid) language plpgsql as $$
declare fixture record; owner public.sessions; started uuid;
begin
  select * into strict fixture from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
    label,'Durable observed evidence','codex','gpt-5.5',null,null,'12b2c3d4-0001-4000-8000-000000000001',null);
  select * into owner from public.sessions s where s.id=fixture.session_id;
  update public.agent_jobs set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()),
    status='running',attempt_count=1 where id=fixture.job_id;
  started:=public.start_session_job_attempt(fixture.job_id,1,owner.current_stage_id,owner.current_artifact_version,
    'codex','gpt-5.5','project','wallie/evidence-'||fixture.job_id::text);
  perform public.pin_session_job_git_input(fixture.job_id,1,started,'12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40));
  return query select fixture.session_id,fixture.job_id,started;
end;
$$;
create function pg_temp.command_receipt(state text default 'passed') returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('key','tests','command','pnpm test','provenance','harness','status',state,
    'exitCode',case when state='passed' then 0 else 1 end,'startedAt',clock_timestamp(),'completedAt',clock_timestamp(),
    'commitSha',repeat('b',40),'treeSha',repeat('c',40),'finalCommitSha',repeat('b',40),'finalTreeSha',repeat('c',40),
    'reportKeys','[]'::jsonb,'missingRequiredReports','[]'::jsonb));
$$;
create temp table fixture as select * from pg_temp.evidence_fixture('Observed validation');
create temp table receipts as select pg_temp.command_receipt() as commands;

select is((select count(*) from public.session_validation_evidence),0::bigint,'legacy runs receive no invented command execution');
select ok(not (select public from storage.buckets where id='session-validation-evidence'),'evidence bucket is private');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence(gen_random_uuid(),repeat('b',40),repeat('c',40),'[]')$$),'42501',
 'unknown execution cannot attach evidence to another tenant');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),'[{"tests":"passed"}]')$$),'23514',
 'Markdown-style assertions cannot masquerade as observed validation');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select jsonb_set(commands,'{0,provenance}','"agent"') from receipts))$$),'23514','agent-asserted provenance cannot pass');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select jsonb_set(commands,'{0,exitCode}','1') from receipts))$$),'23514','a failed command cannot be marked passed');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select jsonb_set(commands,'{0,exitCode}','null') from receipts))$$),'23514','missing observed exit status cannot pass');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select jsonb_set(commands,'{0,finalCommitSha}',to_jsonb(repeat('d',40))) from receipts))$$),'23514','later code commits make successful validation stale');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select jsonb_set(commands,'{0,finalTreeSha}',to_jsonb(repeat('d',40))) from receipts))$$),'23514','later file changes cannot pass for the old validation tree');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select jsonb_set(commands,'{0,commitSha}','null') from receipts))$$),'23514','unknown commit execution cannot pass');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select jsonb_set(commands,'{0,missingRequiredReports}','["report"]') from receipts))$$),'23514','missing required reports cannot pass');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select jsonb_set(commands,'{0,reportKeys}','["report"]') from receipts))$$),'23514','a named report must have a durable asset');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select jsonb_set(commands,'{0,completedAt}',to_jsonb((clock_timestamp()+interval '1 hour')::text)) from receipts))$$),'23514','future execution timestamps cannot extend freshness');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select commands||commands from receipts))$$),'23514','duplicate command identities are rejected');

create temp table asset_manifest as select jsonb_build_array(jsonb_build_object('id','50700000-0000-4000-8000-000000000001',
 'key','report','kind','report','required',true,'storagePath','b1b2c3d4-0001-4000-8000-000000000001/'||run_id::text||'/50700000-0000-4000-8000-000000000001',
 'sha256',repeat('e',64),'contentType','text/plain','sizeBytes',20)) as assets from fixture;
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select jsonb_set(commands,'{0,reportKeys}','["report"]') from receipts),(select assets from asset_manifest))$$),'23514',
 'inaccessible required assets cannot be recorded as durable');
insert into storage.objects(bucket_id,name,metadata) select 'session-validation-evidence',assets->0->>'storagePath',
 '{"size":20,"mimetype":"text/plain"}' from asset_manifest;
insert into storage.objects(bucket_id,name,metadata) values('session-validation-evidence',
 'b1b2c3d4-0001-4000-8000-000000000001/unpublished','{"size":20,"mimetype":"text/plain"}');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select commands from receipts),(select jsonb_set(assets,'{0,sizeBytes}','21') from asset_manifest))$$),'23514',
 'asset metadata must match persisted size');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select jsonb_set(commands,'{0,reportKeys}','["report"]') from receipts),(select jsonb_set(assets,'{0,required}','false') from asset_manifest))$$),'23514',
 'an optional report cannot satisfy a required report identity');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select jsonb_set(commands,'{0,reportKeys}','["report","report"]') from receipts),(select assets from asset_manifest))$$),'23514',
 'duplicate required report names are rejected');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select commands from receipts),(select assets||assets from asset_manifest))$$),'23514','duplicate asset identities cannot make evidence ambiguous');
create temp table evidence as select * from public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select jsonb_set(commands,'{0,reportKeys}','["report"]') from receipts),(select assets from asset_manifest));
select is((select count(*) from evidence),1::bigint,'trusted execution receipts persist');
select is((select job_id from evidence),(select job_id from fixture),'job identity derives from the trusted execution');
select is((select attempt_count from evidence),1,'receipt retains claim attempt identity');
select is((select repository_id from evidence),'12b2c3d4-0001-4000-8000-000000000001'::uuid,'repository identity derives from the pinned input');
select is((select count(*) from public.session_validation_assets where run_id=(select run_id from fixture)),1::bigint,'asset manifest becomes durable separately from sandbox');
select is((public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),
 (select jsonb_set(commands,'{0,reportKeys}','["report"]') from receipts),(select assets from asset_manifest))).created_at,
 (select created_at from evidence),'exact persistence retry returns the original immutable receipt');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),'[]')$$),'PT409',
 'conflicting retry cannot rewrite observed execution');
select is(pg_temp.failure_state($$update public.session_validation_evidence set records='[]'$$),'23514','privileged SQL cannot rewrite execution receipts');
select is(pg_temp.failure_state($$delete from public.session_validation_assets$$),'23514','privileged SQL cannot erase report provenance');

create temp table failed_fixture as select * from pg_temp.evidence_fixture('Failed evidence retained');
select is((public.record_session_validation_evidence((select run_id from failed_fixture),repeat('b',40),repeat('c',40),
 pg_temp.command_receipt('failed'))).records->0->>'status','failed','failed execution persists without implying success');
create temp table stale_fixture as select * from pg_temp.evidence_fixture('Stale evidence retained');
select is((public.record_session_validation_evidence((select run_id from stale_fixture),repeat('b',40),repeat('c',40),
 jsonb_set(pg_temp.command_receipt('stale'),'{0,finalTreeSha}',to_jsonb(repeat('d',40))))).records->0->>'status','stale',
 'tests passing before a later edit retain an explicitly stale receipt');
create temp table old_fixture as select * from pg_temp.evidence_fixture('Superseded attempt');
update public.agent_jobs set attempt_count=2 where id=(select job_id from old_fixture);
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from old_fixture),repeat('b',40),repeat('c',40),'[]')$$),'PT409',
 'a superseded worker attempt cannot persist new evidence');

grant select on fixture,evidence,asset_manifest to authenticated,service_role;
set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';
select is((select count(*) from public.session_validation_evidence where run_id=(select run_id from fixture)),1::bigint,'active members can inspect execution receipts');
select is((select count(*) from public.session_validation_assets where run_id=(select run_id from fixture)),1::bigint,'active members can inspect durable report manifests');
select is((select count(*) from storage.objects where bucket_id='session-validation-evidence'),1::bigint,'storage reads require exact durable asset manifests');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from fixture),repeat('b',40),repeat('c',40),'[]')$$),'42501',
 'browser clients cannot fabricate observed executions');
select is(pg_temp.failure_state($$update public.session_validation_evidence set records='[]'$$),'42501','browser clients cannot rewrite receipts');
select is(pg_temp.failure_state($$insert into storage.objects(bucket_id,name) values('session-validation-evidence','b1b2c3d4-0001-4000-8000-000000000001/fabricated')$$),'42501',
 'members cannot upload fabricated evidence assets directly');
reset role;
insert into auth.users(id,email) values('50700000-0000-4000-8000-000000000002','evidence-outsider@example.test');
set local role authenticated;
set local request.jwt.claim.sub='50700000-0000-4000-8000-000000000002';
select is((select count(*) from public.session_validation_evidence),0::bigint,'outsiders cannot read execution receipts');
select is((select count(*) from public.session_validation_assets),0::bigint,'outsiders cannot read report manifests');
select is((select count(*) from storage.objects where bucket_id='session-validation-evidence'),0::bigint,'outsiders cannot download evidence');
reset role;
update public.workspace_members set is_active=false where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
 and user_id='a1b2c3d4-0001-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';
select is((select count(*) from public.session_validation_evidence),0::bigint,'deactivated members lose evidence access');
select is((select count(*) from storage.objects where bucket_id='session-validation-evidence'),0::bigint,'deactivated members lose durable asset access');
reset role;
set local role anon;
select is(pg_temp.failure_state($$select * from public.session_validation_evidence$$),'42501','anonymous callers cannot inspect receipts');
reset role;
set local role service_role;
select is(pg_temp.failure_state($$delete from public.session_validation_evidence$$),'42501','service-role writes use the fenced append-only RPC');
reset role;
set local request.jwt.claim.role='service_role';
select lives_ok($$delete from public.sessions where id=(select session_id from fixture)$$,'owning-session cleanup can cascade immutable execution history');
select is((select count(*) from public.session_validation_assets where run_id=(select run_id from fixture)),0::bigint,'session cleanup removes asset manifests');
insert into public.workspaces(id,name,slug) values('50700000-0000-4000-8000-000000000003','Evidence deletion fence','evidence-deletion-fence');
insert into storage.objects(bucket_id,name,metadata) values('session-validation-evidence',
 '50700000-0000-4000-8000-000000000003/unpublished','{"size":20,"mimetype":"text/plain"}');
update public.workspaces set deletion_requested_at=clock_timestamp() where id='50700000-0000-4000-8000-000000000003';
select ok(not public.finish_workspace_deletion('50700000-0000-4000-8000-000000000003'),
 'workspace cleanup waits for retained and incomplete evidence uploads');
select is(pg_temp.failure_state($$insert into storage.objects(bucket_id,name,metadata) values('session-validation-evidence',
 '50700000-0000-4000-8000-000000000003/late','{"size":20,"mimetype":"text/plain"}')$$),'P0010',
 'the workspace deletion fence rejects late evidence uploads');
set local storage.allow_delete_query='true';
delete from storage.objects where bucket_id='session-validation-evidence' and name='50700000-0000-4000-8000-000000000003/unpublished';
select ok(public.finish_workspace_deletion('50700000-0000-4000-8000-000000000003'),'workspace cleanup completes after evidence storage is removed');
select * from finish();
rollback;
