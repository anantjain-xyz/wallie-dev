begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role"='service_role';
insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0) from public.sessions
where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);

select is((select count(*) from public.session_git_roots),0::bigint,'historical sessions receive no fabricated root SHA');
select is((select count(*) from public.session_git_checkpoints),0::bigint,'historical artifacts receive no fabricated checkpoints');

create temp table git_fixture as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Git lineage fixture','Keep the execution input','codex','gpt-5.5',null,null,null,null);
update public.sessions set github_repository_id='12b2c3d4-0001-4000-8000-000000000001'
  where id=(select session_id from git_fixture);
update public.agent_jobs set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()), status='running',attempt_count=1 where id=(select job_id from git_fixture);
select public.start_session_job_attempt(f.job_id,1,s.current_stage_id,0,'codex','gpt-5.5','project','wallie/git-fixture-1')
from git_fixture f join public.sessions s on s.id=f.session_id;

select throws_ok($$select public.pin_session_job_git_input(job_id,1,run_id,
  '12b2c3d4-0002-4000-8000-000000000002','main',repeat('a',40)) from git_fixture$$,
  '23514','Git lineage repository does not match the session.','same-workspace repository cannot replace an explicit session binding');
select throws_ok($$select public.pin_session_job_git_input(job_id,1,run_id,
  '99999999-0001-4000-8000-000000000001','main',repeat('a',40)) from git_fixture$$,
  '23514','Git lineage repository does not match the session.','unknown or foreign repository cannot be pinned');
select is((select count(*) from public.pin_session_job_git_input(
  (select job_id from git_fixture),1,(select run_id from git_fixture),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40))),1::bigint,'current attempt pins one input');
select throws_ok($$select public.pin_session_job_git_input(job_id,1,run_id,
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('b',40)) from git_fixture$$,
  '23514','Observed Git input does not match the selected checkpoint.',
  'provider must restore the selected SHA before reusing a pinned job');
select is((select input_sha from public.session_job_git_inputs where job_id=(select job_id from git_fixture)),repeat('a',40),
  'mismatched observed checkout cannot rewrite the immutable input');
select is((select input_sha from public.pin_session_job_git_input(
  (select job_id from git_fixture),1,(select run_id from git_fixture),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40))),repeat('a',40),
  'the matching observed checkout reuses its pinned input');
select throws_ok($$select public.pin_session_job_git_input(job_id,1,run_id,
  '12b2c3d4-0001-4000-8000-000000000001','other',repeat('a',40)) from git_fixture$$,
  '23514','Git execution input is already pinned.','a job cannot change its pinned base branch');
select throws_ok($$update public.session_job_git_inputs set input_sha=repeat('c',40) where job_id=(select job_id from git_fixture)$$,
  '23514','Git lineage is immutable.','privileged SQL cannot rewrite a pinned input');
select throws_ok($$update public.session_git_roots set initial_base_sha=repeat('c',40) where session_id=(select session_id from git_fixture)$$,
  '23514','Git lineage is immutable.','the session initial base is immutable');

select throws_ok($$update public.agent_runs set branch_name='wallie/tampered' where id=(select run_id from git_fixture)$$,
  '23514','Pinned Git run producer identity is immutable.','pinning freezes the producing run branch before execution');
select throws_ok($$update public.agent_runs set attempt_count=99 where id=(select run_id from git_fixture)$$,
  '23514','Pinned Git run producer identity is immutable.','pinning freezes the run claim identity');
select throws_ok($$update public.agent_jobs set session_id='a2b2c3d4-0001-4000-8000-000000000001' where id=(select job_id from git_fixture)$$,
  '23514','Pinned Git job identity is immutable.','a pinned job cannot move to another session');
select lives_ok($$update public.agent_runs set last_activity_at=clock_timestamp(),source_recovery_required=false where id=(select run_id from git_fixture)$$,
  'normal run activity and recovery bookkeeping remain writable');

-- A retry keeps the durable job intent and receives a new run/claim attempt.
update public.agent_jobs set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()), attempt_count=2 where id=(select job_id from git_fixture);
create temp table git_retry as select public.start_session_job_attempt(
  f.job_id,2,s.current_stage_id,0,'codex','gpt-5.5','project','wallie/git-fixture-2') as run_id
from git_fixture f join public.sessions s on s.id=f.session_id;
select is((select count(*) from public.pin_session_job_git_input(
  (select job_id from git_fixture),1,(select run_id from git_fixture),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('c',40))),0::bigint,
  'stale attempt cannot acquire or adopt execution input');
select throws_ok($$select public.pin_session_job_git_input((select job_id from git_fixture),2,(select run_id from git_retry),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('c',40))$$,
  '23514','Observed Git input does not match the selected checkpoint.',
  'replacement attempt cannot certify a failed or moving checkout as its original input');
select ok((select input_sha=repeat('a',40) and pinned_run_id=(select run_id from git_fixture) and pinned_attempt_count=1
  from public.session_job_git_inputs where job_id=(select job_id from git_fixture)),
  'mismatched retry preserves original SHA and first producing claim binding');
select is((select input_sha from public.pin_session_job_git_input(
  (select job_id from git_fixture),2,(select run_id from git_retry),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40))),repeat('a',40),
  'replacement attempt reuses the initial pinned SHA after exact restore');
select is((select count(*) from public.session_job_git_inputs where job_id=(select job_id from git_fixture)),1::bigint,
  'retry does not create a second input record');
select throws_ok($$delete from public.agent_runs where id=(select run_id from git_fixture)$$,
  '23514','Git lineage is immutable.','deleting the original pinning run cannot orphan the retry input');
select is(public.prepare_session_source_delivery((select run_id from git_fixture),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40),repeat('a',40),
  'No code','Artifact','','',''),false,'stale run cannot prepare source after retry claim');
select throws_ok($$select public.prepare_session_source_delivery((select run_id from git_retry),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('c',40),repeat('c',40),
  'Wrong base','Artifact','','','')$$,'23514','Source does not match the pinned Git input.',
  'preparation refuses output from a different input SHA');
select is(public.prepare_session_source_delivery((select run_id from git_retry),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40),repeat('a',40),
  'No code','Artifact','','',''),true,'no-code source retains the exact input commit');

-- Cross-workspace metadata cannot be smuggled in by privileged SQL.
insert into public.workspaces(id,name,slug) values('49400000-0001-4000-8000-000000000001','Foreign Git fixture','foreign-git-fixture');
select throws_ok($$insert into public.session_git_roots(session_id,workspace_id,repository_id,repository_full_name,base_branch,initial_base_sha)
  select session_id,'49400000-0001-4000-8000-000000000001',
  '12b2c3d4-0001-4000-8000-000000000001','any/repository','main',repeat('a',40) from git_fixture$$,
  '23514','Git lineage session is not in the workspace.','foreign workspace root references are rejected');

create function pg_temp.expired_git_publication() returns boolean language plpgsql as $$
begin
  perform public.publish_session_job_with_source((select job_id from git_fixture),2,(select run_id from git_retry),0,'Artifact',clock_timestamp()-interval '1 second');
  return false;
exception when query_canceled then return true;
end;
$$;
select is(pg_temp.expired_git_publication(),true,'expired publication does not adopt source');
select is((select count(*) from public.session_git_checkpoints where run_id=(select run_id from git_retry)),0::bigint,
  'deadline failure leaves no accepted checkpoint');
select is((select current_artifact_version from public.sessions where id=(select session_id from git_fixture)),0,
  'deadline failure leaves no published artifact');
-- This fixture predates canonical PR enrollment; retain the complete
-- historical source/lineage guards while exercising the legacy delivery path.
alter table public.session_git_heads disable trigger enqueue_session_pr_sync;
select is(public.publish_session_job_with_source((select job_id from git_fixture),2,(select run_id from git_retry),0,'Artifact',clock_timestamp()+interval '1 minute'),
  true,'current publication adopts checkpoint and artifact in one transaction');
alter table public.session_git_heads enable trigger enqueue_session_pr_sync;
select ok((select c.artifact_id=s.current_artifact_id and c.input_sha=repeat('a',40) and c.output_sha=c.input_sha
  and c.output_kind='no-code' and c.attempt_count=2 and c.output_ref is null
  from public.session_git_checkpoints c join public.sessions s on s.id=c.session_id where c.run_id=(select run_id from git_retry)),
  'accepted artifact has exact no-code lineage and producing claim');
select is((select status from public.session_source_deliveries where run_id=(select run_id from git_retry)),'pending',
  'an intended remote ref is not reported as already delivered');
select throws_ok($$update public.session_git_checkpoints set output_sha=repeat('d',40) where run_id=(select run_id from git_retry)$$,
  '23514','Git lineage is immutable.','accepted checkpoints cannot be edited');
select throws_ok($$delete from public.session_git_checkpoints where run_id=(select run_id from git_retry)$$,
  '23514','Git lineage is immutable.','accepted checkpoints cannot be directly deleted');
select throws_ok($$delete from public.session_artifacts where id=(select artifact_id from public.session_git_checkpoints where run_id=(select run_id from git_retry))$$,
  '23514','Git lineage is immutable.','deleting an artifact cannot erase accepted provenance');
select throws_ok($$delete from public.agent_runs where id=(select run_id from git_retry)$$,
  '23514','Git lineage is immutable.','deleting a run cannot erase accepted provenance');
select throws_ok($$delete from public.session_source_deliveries where run_id=(select run_id from git_retry)$$,
  '23514','Git lineage is immutable.','deleting durable source cannot orphan accepted provenance');
select throws_ok($$delete from public.session_job_git_inputs where job_id=(select job_id from git_fixture)$$,
  '23514','Git lineage is immutable.','pinned inputs cannot be directly deleted');
select throws_ok($$update public.session_source_deliveries set head_sha=repeat('d',40) where run_id=(select run_id from git_retry)$$,
  '23514','Accepted Git source identity is immutable.','accepted durable source identity cannot be rewritten');

select throws_ok($$update public.session_artifacts set artifact_json=to_jsonb('Rewritten'::text)
  where id=(select artifact_id from public.session_git_checkpoints where run_id=(select run_id from git_retry))$$,
  '23514','Accepted Git artifact identity and content are immutable.','accepted markdown cannot be rewritten beneath its checkpoint');
select throws_ok($$update public.session_artifacts set version=version+100
  where id=(select artifact_id from public.session_git_checkpoints where run_id=(select run_id from git_retry))$$,
  '23514','Accepted Git artifact identity and content are immutable.','accepted artifact version is immutable');
select throws_ok($$update public.session_artifacts set stage_id=null
  where id=(select artifact_id from public.session_git_checkpoints where run_id=(select run_id from git_retry))$$,
  '23514','Accepted Git artifact identity and content are immutable.','a live stage cannot be detached from an accepted artifact');
select throws_ok($$update public.agent_runs set stage_id=null where id=(select run_id from git_retry)$$,
  '23514','Pinned Git run producer identity is immutable.','a live stage cannot be detached from an accepted producer');
select lives_ok($$update public.agent_jobs set status='success' where id=(select job_id from git_fixture)$$,
  'normal job completion remains writable after input pinning');
update public.agent_jobs set status='running' where id=(select job_id from git_fixture);

create temp table git_old_delivery_claim as select public.claim_session_source_delivery() as claim_id;
update public.session_source_deliveries set lease_expires_at=clock_timestamp()-interval '1 second'
  where run_id=(select run_id from git_retry);
select ok(public.claim_session_source_delivery() is not null,'expired source lease can be replaced');
select is(public.finish_session_source_delivery_with_ref((select run_id from git_retry),
  (select claim_id from git_old_delivery_claim),'refs/heads/stale'),false,'stale lease cannot set an actual delivered ref');
select is((select delivered_ref from public.session_source_deliveries where run_id=(select run_id from git_retry)),null::text,
  'stale receipt leaves the actual ref unknown');
select throws_ok($$select public.finish_session_source_delivery_with_ref((select run_id from git_retry),
  (select claim_id from public.session_source_deliveries where run_id=(select run_id from git_retry)),'refs/heads/../bad')$$,
  '23514','A valid delivered Git branch ref is required for changed code.','receipt rejects malformed Git refs');
select is(public.finish_session_source_delivery_with_ref((select run_id from git_retry),
  (select claim_id from public.session_source_deliveries where run_id=(select run_id from git_retry))),true,
  'no-code delivery may omit the remote ref instead of fabricating one');
select is((select delivered_ref from public.session_source_deliveries where run_id=(select run_id from git_retry)),null::text,
  'no-code receipt retains a NULL actual ref');

-- A failed guard after the publication primitive must roll the artifact back.
create temp table git_other as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Other Git fixture','Other execution','codex','gpt-5.5',null,null,null,null);
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,prompt_template_md)
select '49400000-0003-4000-8000-000000000001',pipeline_id,workspace_id,99,'git-checkpoint-fixture','Git fixture','Produce code'
from public.sessions where id=(select session_id from git_other);
update public.sessions set current_stage_id='49400000-0003-4000-8000-000000000001' where id=(select session_id from git_other);
update public.agent_jobs set stage_id='49400000-0003-4000-8000-000000000001',stage_slug='git-checkpoint-fixture',stage_name='Git fixture'
  where id=(select job_id from git_other);
update public.agent_runs set stage_id='49400000-0003-4000-8000-000000000001',stage_slug='git-checkpoint-fixture',stage_name='Git fixture'
  where id=(select run_id from git_other);
update public.agent_jobs set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()), status='running',attempt_count=1 where id=(select job_id from git_other);
select public.start_session_job_attempt(f.job_id,1,s.current_stage_id,0,'codex','gpt-5.5','project','wallie/git-other')
from git_other f join public.sessions s on s.id=f.session_id;
select public.pin_session_job_git_input(f.job_id,1,f.run_id,'12b2c3d4-0001-4000-8000-000000000001','main',repeat('b',40)) from git_other f;
select public.prepare_session_source_delivery((select run_id from git_other),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('b',40),repeat('c',40),
  'Code','Artifact','',encode(extensions.digest('source'::bytea,'sha256'),'hex'),encode('source'::bytea,'base64'));
update public.session_source_deliveries set session_id=(select session_id from git_fixture) where run_id=(select run_id from git_other);
select throws_ok($$select public.publish_session_job_with_source((select job_id from git_other),1,(select run_id from git_other),0,'Other artifact')$$,
  '23514','Exact retained remote checkpoint proof is required.',
  'a source record from another session cannot be adopted');
select is((select current_artifact_version from public.sessions where id=(select session_id from git_other)),0,
  'adoption failure rolls back the primitive artifact publication');
select is((select status::text from public.agent_runs where id=(select run_id from git_other)),'running',
  'adoption failure rolls back the run success transition');
update public.session_source_deliveries set session_id=(select session_id from git_other) where run_id=(select run_id from git_other);
select is(public.prepare_session_checkpoint_publication((select run_id from git_other),0,'Other artifact'),true,
  'valid code checkpoint prepares an immutable publication intent');
-- Model an intent pinned to a branch before the custom ref migration.
alter table public.session_checkpoint_publications disable trigger guard_checkpoint_publication;
update public.session_checkpoint_publications
set retained_ref='refs/heads/wallie/checkpoints/'||run_id::text||'/'||repeat('c',40)
where run_id=(select run_id from git_other);
alter table public.session_checkpoint_publications enable trigger guard_checkpoint_publication;
create temp table git_other_publication_claim as select public.claim_session_checkpoint_publication((select run_id from git_other)) as claim_id;
-- This fixture predates canonical PR enrollment; retain the complete
-- historical source/lineage guards while exercising the legacy delivery path.
alter table public.session_git_heads disable trigger enqueue_session_pr_sync;
select is(public.adopt_session_checkpoint_publication((select run_id from git_other),
  (select claim_id from git_other_publication_claim),
  'refs/heads/wallie/checkpoints/'||(select run_id::text from git_other)||'/'||repeat('c',40),repeat('c',40)),true,
  'pre-migration checkpoint intent still adopts from its exact retained branch');
alter table public.session_git_heads enable trigger enqueue_session_pr_sync;
select ok((select c.output_kind='code' and c.input_sha=repeat('b',40) and c.output_sha=repeat('c',40)
  and c.bundle_sha256=encode(extensions.digest('source'::bytea,'sha256'),'hex')
  from public.session_git_checkpoints c where c.run_id=(select run_id from git_other)),
  'code checkpoint records exact input/output and durable bundle digest');

select throws_ok($$insert into public.session_git_checkpoints(run_id,workspace_id,session_id,job_id,attempt_count,repository_id,
  repository_full_name,initial_base_sha,input_sha,output_sha,output_kind,artifact_id,output_ref)
  select f.run_id,c.workspace_id,c.session_id,c.job_id,1,c.repository_id,c.repository_full_name,
    c.initial_base_sha,c.input_sha,c.output_sha,c.output_kind,c.artifact_id,c.output_ref
  from git_fixture f cross join public.session_git_checkpoints c where c.run_id=(select run_id from git_retry)$$,
  '23514','Git checkpoint does not match the accepted execution and artifact.',
  'a stale run cannot adopt a checkpoint directly, even with a valid artifact ID');

select ok(public.claim_session_source_delivery() is not null,'published code gets a source delivery lease');
select is(public.finish_session_source_delivery((select run_id from git_other),
  (select claim_id from public.session_source_deliveries where run_id=(select run_id from git_other)),true),true,
  'older delivery consumers can still finish a successful delivery');
select is((select delivered_ref from public.session_source_deliveries where run_id=(select run_id from git_other)),null::text,
  'older successful receipts retain unknown actual ref instead of inventing the intended ref');
update public.session_source_deliveries set status='pending',next_attempt_at=now(),bundle_base64=encode('source'::bytea,'base64')
  where run_id=(select run_id from git_other);
select ok(public.claim_session_source_delivery() is not null,'legacy unknown receipt can be deliberately redelivered');
select throws_ok($$select public.finish_session_source_delivery_with_ref((select run_id from git_other),
  (select claim_id from public.session_source_deliveries where run_id=(select run_id from git_other)))$$,
  '23514','A valid delivered Git branch ref is required for changed code.','changed code cannot claim a known receipt without an actual ref');
select is(public.finish_session_source_delivery_with_ref((select run_id from git_other),
  (select claim_id from public.session_source_deliveries where run_id=(select run_id from git_other)),
  'refs/heads/wallie/git-other-recovery'),true,'current lease records the actual recovery branch');
select is((select delivered_ref from public.session_source_deliveries where run_id=(select run_id from git_other)),
  'refs/heads/wallie/git-other-recovery','the actual durable ref is persisted separately from its intended target');
select is((select output_ref from public.session_git_checkpoints where run_id=(select run_id from git_other)),
  'refs/heads/wallie/checkpoints/'||(select run_id::text from git_other)||'/'||repeat('c',40),
  'PR recovery does not rewrite the immutable retained checkpoint ref');
select throws_ok($$update public.session_source_deliveries set delivered_ref='refs/heads/rewrite' where run_id=(select run_id from git_other)$$,
  '23514','Delivered Git ref is immutable.','a known durable ref cannot be overwritten');
select ok(not has_column_privilege('service_role','public.session_source_deliveries','delivered_ref','UPDATE'),
  'service callers cannot bypass the lease-fenced receipt RPC with direct updates');
select ok(not has_column_privilege('service_role','public.session_source_deliveries','delivered_ref','INSERT'),
  'service callers cannot insert a fabricated known receipt');
update public.session_source_deliveries set status='pending',next_attempt_at=now(),bundle_base64=encode('source'::bytea,'base64')
  where run_id=(select run_id from git_other);
select ok(public.claim_session_source_delivery() is not null,'retry bookkeeping can coexist with an immutable known ref');
select is(public.finish_session_source_delivery_with_ref((select run_id from git_other),
  (select claim_id from public.session_source_deliveries where run_id=(select run_id from git_other)),
  'refs/heads/different-recovery'),false,'another receipt cannot replace an already known actual ref');
select is(public.finish_session_source_delivery((select run_id from git_other),
  (select claim_id from public.session_source_deliveries where run_id=(select run_id from git_other)),false),true,
  'failure retry scheduling still works after recording a known ref');
select is((select delivered_ref from public.session_source_deliveries where run_id=(select run_id from git_other)),
  'refs/heads/wallie/git-other-recovery','retry scheduling preserves the known actual ref');
select ok(not has_function_privilege('authenticated','public.finish_session_source_delivery_with_ref(uuid,uuid,text)','EXECUTE'),
  'browser sessions cannot forge delivered-ref receipts');

-- Real stage deletion retains historical labels while the FK nulls its ID.
update public.sessions set current_stage_id=(select current_stage_id from public.sessions where id=(select session_id from git_fixture))
  where id=(select session_id from git_other);
select lives_ok($$delete from public.pipeline_stages where id='49400000-0003-4000-8000-000000000001'$$,
  'actual stage deletion may null accepted artifact and run stage references');
select ok((select stage_id is null and stage_slug='git-checkpoint-fixture' from public.session_artifacts
  where id=(select artifact_id from public.session_git_checkpoints where run_id=(select run_id from git_other))),
  'stage deletion retains accepted artifact content and historical label');
select ok((select stage_id is null from public.agent_runs where id=(select run_id from git_other)),
  'stage deletion retains the accepted producer with a null stage ID');

select ok(not has_function_privilege('authenticated','public.pin_session_job_git_input(uuid,integer,uuid,uuid,text,text)','EXECUTE'),
  'browser sessions cannot invoke input pinning');
select ok(not has_function_privilege('authenticated','public.publish_session_job_with_source(uuid,integer,uuid,integer,text,timestamptz)','EXECUTE'),
  'browser sessions cannot adopt output through publication');
select ok(not has_table_privilege('authenticated','public.session_git_checkpoints','INSERT'),
  'browser sessions cannot bypass publication with direct checkpoint writes');

set local role authenticated;
set local "request.jwt.claim.role"='authenticated';
set local "request.jwt.claim.sub"='a1b2c3d4-0001-4000-8000-000000000001';
select is((select count(*) from public.session_git_checkpoints),2::bigint,'active workspace members can read accepted metadata');
select is((select count(*) from public.session_job_git_inputs),2::bigint,'active workspace members can read pinned inputs');
select throws_ok($$update public.session_git_checkpoints set output_sha=repeat('d',40)$$,
  '42501','permission denied for table session_git_checkpoints','members cannot update checkpoint metadata');
reset role;
update public.workspace_members set is_active=false where user_id='a1b2c3d4-0001-4000-8000-000000000001';
set local role authenticated;
select is((select count(*) from public.session_git_checkpoints),0::bigint,'inactive membership cannot read accepted checkpoints');
select is((select count(*) from public.session_job_git_inputs),0::bigint,'inactive membership cannot read execution inputs');
select is((select count(*) from public.session_git_roots),0::bigint,'inactive membership cannot read initial Git roots');
reset role;

insert into auth.users(id,email) values('49400000-0002-4000-8000-000000000001','git-outsider@example.test');
insert into public.workspace_members(workspace_id,user_id,kind,role)
values('49400000-0001-4000-8000-000000000001','49400000-0002-4000-8000-000000000001','human','owner');
set local role authenticated;
set local "request.jwt.claim.sub"='49400000-0002-4000-8000-000000000001';
select is((select count(*) from public.session_git_checkpoints),0::bigint,'foreign workspace membership cannot read accepted checkpoints');
select is((select count(*) from public.session_job_git_inputs),0::bigint,'foreign workspace membership cannot read pinned inputs');
select is((select count(*) from public.session_git_roots),0::bigint,'foreign workspace membership cannot read roots');
reset role;
set local "request.jwt.claim.role"='service_role';
select lives_ok($$delete from public.sessions where id=(select session_id from git_other)$$,
  'cascading session cleanup can remove immutable metadata');
select is((select count(*) from public.session_git_checkpoints where run_id=(select run_id from git_other)),0::bigint,
  'session cleanup removes its checkpoint instead of leaving orphan lineage');
select * from finish();
rollback;
