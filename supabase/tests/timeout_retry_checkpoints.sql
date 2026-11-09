begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

insert into public.workspaces(id,slug,name,created_by)
select 'b1b2c3d4-0002-4000-8000-000000000002','retry-checkpoint-other','Retry checkpoint other workspace',created_by
from public.workspaces where id='b1b2c3d4-0001-4000-8000-000000000001';

insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0)
from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);

create function pg_temp.start_retry_checkpoint_job(target_job uuid) returns uuid
language plpgsql as $$
declare owner public.sessions; started uuid;
begin
  select s.* into strict owner from public.sessions s join public.agent_jobs j on j.session_id=s.id where j.id=target_job;
  update public.agent_jobs set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()),
    status='running',attempt_count=1 where id=target_job;
  started:=public.start_session_job_attempt(target_job,1,owner.current_stage_id,owner.current_artifact_version,
    'codex','gpt-5.5','project','wallie/retry-checkpoint-'||target_job);
  perform public.pin_session_job_git_input(target_job,1,started,owner.github_repository_id,'main',repeat('a',40));
  return started;
end;
$$;

create function pg_temp.retry_checkpoint_job(target_session uuid,failed_run uuid)
returns table(job_id uuid,run_id uuid,created boolean) language sql as $$
  select result.* from public.sessions s
  cross join lateral public.enqueue_session_retry_with_checkpoint(s.id,s.workspace_id,s.current_stage_id,
    s.creator_member_id,failed_run,'codex','gpt-5.5','project') result where s.id=target_session;
$$;

create temp table plan as select f.*,pg_temp.start_retry_checkpoint_job(f.job_id) as started
from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Resume timed-out Build','Keep the reviewed source baseline','codex','gpt-5.5',null,null,
  '12b2c3d4-0001-4000-8000-000000000001'
) f;
select ok(public.prepare_session_source_and_checkpoint_publication(started,
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40),repeat('a',40),
  'Plan','Approved base','','','',0,'Plan body'),'prepare ordinary Plan publication') from plan;
select ok(public.adopt_session_checkpoint_publication(started,
  public.claim_session_checkpoint_publication(started),null,null),'adopt ordinary Plan publication') from plan;
create temp table build as select decision.job_id,decision.run_id,s.id as session_id
from plan join public.sessions s on s.id=plan.session_id
cross join lateral public.approve_session_stage(s.id,s.workspace_id,s.current_stage_id,s.current_artifact_id,
  s.current_artifact_version,s.creator_member_id,'codex','gpt-5.5','project',s.artifact_review_revision) decision;
update build set run_id=pg_temp.start_retry_checkpoint_job(job_id);
create temp table snapshot as
select b.*,s.workspace_id,s.workspace_id::text||'/'||b.run_id::text||'-retry-1-'||gen_random_uuid()::text||'.bundle' as path,
  null::uuid as upload_operation_id
from build b join public.sessions s on s.id=b.session_id;

select throws_ok($$insert into storage.objects(bucket_id,name) select 'session-source-checkpoints',path from snapshot$$,
  '23514','Retry checkpoint upload reservation is not active.','Storage refuses an unreserved retry bundle');
select throws_ok($$select public.begin_workspace_resource_operation('b1b2c3d4-0002-4000-8000-000000000002',
  'upload','',path,'session-source-checkpoints',clock_timestamp()+interval '5 minutes') from snapshot$$,
  '23514','Retry checkpoint upload path does not match its workspace.',
  'an upload reservation cannot own a different workspace Storage path');
grant select,update on snapshot to service_role;
set local role service_role;
update snapshot set upload_operation_id=public.begin_workspace_resource_operation(
  workspace_id,'upload','',path,'session-source-checkpoints',clock_timestamp()+interval '5 minutes');
reset role;
select throws_ok($$select public.begin_workspace_resource_operation(workspace_id,'upload','',path,
  'session-source-checkpoints',clock_timestamp()+interval '5 minutes') from snapshot$$,
  '23505','duplicate key value violates unique constraint "workspace_resource_operations_retry_upload_path_idx"',
  'a replayed upload reservation cannot acquire a second cleanup owner for the same path');
select is(public.save_session_retry_checkpoint(job_id,2,run_id,repeat('a',40),repeat('b',40),repeat('c',64),
  clock_timestamp()+interval '5 minutes',upload_operation_id,path),false,'an incorrect attempt cannot save') from snapshot;
select is(public.save_session_retry_checkpoint(job_id,1,run_id,repeat('a',40),repeat('b',40),repeat('c',64),
  clock_timestamp()-interval '1 second',upload_operation_id,path),false,'an expired attempt cannot save') from snapshot;
insert into public.worker_dispatches(job_id,attempt_count,workspace_id,workflow_id,deadline_at)
select b.job_id,1,s.workspace_id,'retry-checkpoint-proof-'||b.job_id,clock_timestamp()-interval '1 second'
from snapshot b join public.sessions s on s.id=b.session_id;
select is(public.save_session_retry_checkpoint(job_id,1,run_id,repeat('a',40),repeat('b',40),repeat('c',64),
  clock_timestamp()+interval '5 minutes',upload_operation_id,path),false,
  'the durable dispatch cutoff takes precedence over a later worker deadline') from snapshot;
delete from public.worker_dispatches where job_id=(select job_id from snapshot);
select throws_ok($$select public.save_session_retry_checkpoint(job_id,1,run_id,repeat('a',40),repeat('b',40),repeat('c',64),
  clock_timestamp()+interval '5 minutes',upload_operation_id,path) from snapshot$$,'23514','Retry checkpoint is not durable.',
  'a checkpoint needs a durable private Storage object');
insert into storage.objects(bucket_id,name) select 'session-source-checkpoints',path from snapshot;
select throws_ok($$select public.save_session_retry_checkpoint(job_id,1,run_id,repeat('a',40),repeat('b',40),repeat('c',64),
  clock_timestamp()+interval '5 minutes',upload_operation_id,replace(path,'-retry-1-','-retry-2-')) from snapshot$$,
  '23514','Retry checkpoint path does not match the owned attempt.','save rejects a path belonging to another attempt');
select throws_ok($$select public.save_session_retry_checkpoint(job_id,1,run_id,repeat('d',40),repeat('b',40),repeat('c',64),
  clock_timestamp()+interval '5 minutes',upload_operation_id,path) from snapshot$$,
  '23514','Retry checkpoint does not match the owned Git input.',
  'the captured bundle must use the pinned accepted input');
select is(public.save_session_retry_checkpoint(job_id,1,run_id,repeat('a',40),repeat('b',40),repeat('c',64),
  clock_timestamp()+interval '5 minutes',gen_random_uuid(),path),false,'save requires the matching upload reservation') from snapshot;
create temp table abandoned as select job_id,run_id,workspace_id,workspace_id::text||'/'||run_id::text||
  '-retry-1-'||gen_random_uuid()::text||'.bundle' as path,null::uuid as upload_operation_id from snapshot;
update abandoned set upload_operation_id=public.begin_workspace_resource_operation(
  workspace_id,'upload','',path,'session-source-checkpoints',clock_timestamp()+interval '5 minutes');
insert into storage.objects(bucket_id,name) select 'session-source-checkpoints',path from abandoned;
update public.workspace_resource_operations set recovery_after=clock_timestamp()-interval '1 second'
where id=(select upload_operation_id from abandoned);
select is(public.save_session_retry_checkpoint(job_id,1,run_id,repeat('a',40),repeat('b',40),repeat('c',64),
  clock_timestamp()+interval '5 minutes',upload_operation_id,path),false,
  'an expired reservation cannot transfer even when Storage finished uploading') from abandoned;
update public.workspace_resource_operations set settled_at=clock_timestamp()
where id=(select upload_operation_id from abandoned) and settled_at is null and recovery_after<=clock_timestamp();
select throws_ok($$update storage.objects set version=gen_random_uuid()::text where bucket_id='session-source-checkpoints'
  and name=(select path from abandoned)$$,
  '23514','Retry checkpoint upload reservation is not active.','Storage refuses a write after orphan cleanup claims the reservation');
select throws_ok($$insert into public.session_retry_checkpoints(source_run_id,workspace_id,source_attempt_count,
  rejection_count,input_sha,head_sha,checkpoint_path,bundle_sha256)
  select run_id,'b1b2c3d4-0002-4000-8000-000000000002',1,0,repeat('a',40),repeat('b',40),
    replace(path,workspace_id::text,'b1b2c3d4-0002-4000-8000-000000000002'),repeat('c',64) from snapshot$$,
  '23514','Retry checkpoint does not match its source run workspace and attempt.',
  'the checkpoint table itself rejects cross-tenant source links');
select is(public.save_session_retry_checkpoint(job_id,1,run_id,repeat('a',40),repeat('b',40),repeat('c',64),
  clock_timestamp()+interval '5 minutes',upload_operation_id,path),true,'save the exact owned attempt') from snapshot;
select is((select workspace_id from public.session_retry_checkpoints where source_run_id=snapshot.run_id),workspace_id,
  'the checkpoint records the source run workspace') from snapshot;
select is((select count(*) from public.workspace_resource_operations where id=upload_operation_id),0::bigint,
  'saving the checkpoint consumes its upload reservation') from snapshot;
select throws_ok($$select public.begin_workspace_resource_operation(workspace_id,'upload','',path,
  'session-source-checkpoints',clock_timestamp()+interval '5 minutes') from snapshot$$,
  '23514','Retry checkpoint path is already retained.','a transferred checkpoint cannot be reserved for cleanup again');
select lives_ok($$update storage.objects set last_accessed_at=clock_timestamp()
  where bucket_id='session-source-checkpoints' and name=(select path from snapshot)$$,
  'saved bundle metadata can still be updated after its upload reservation is consumed');
set local role service_role;
select is(public.save_session_retry_checkpoint(job_id,1,run_id,repeat('a',40),repeat('b',40),repeat('c',64),
  clock_timestamp()+interval '5 minutes',upload_operation_id,path),true,
  'the service role can replay an identical receipt after transfer') from snapshot;
reset role;
select is(public.save_session_retry_checkpoint(job_id,1,run_id,repeat('a',40),repeat('d',40),repeat('e',64),
  clock_timestamp()+interval '5 minutes',upload_operation_id,path),false,
  'a conflicting capture cannot replace the immutable checkpoint') from snapshot;
select is((select checkpoint_run_id from public.session_git_heads where session_id=build.session_id),
  (select started from plan),'capturing Build work does not advance accepted Plan source') from build;
select is((select count(*) from public.session_checkpoint_publications where run_id=build.run_id),0::bigint,
  'capturing does not create any publication intent') from build;

select is(public.fail_stalled_session_job_attempt(job_id,1,'Worker attempt exceeded its 1800000ms deadline.',false,0,run_id),
  'error','the worker retires the exact timed-out attempt') from build;
select is(public.save_session_retry_checkpoint(job_id,1,run_id,repeat('a',40),repeat('b',40),repeat('c',64),
  clock_timestamp()+interval '5 minutes',upload_operation_id,path),false,'the terminal attempt can no longer save') from snapshot;
select throws_ok($$select * from build b
  cross join lateral public.enqueue_session_retry_with_checkpoint(b.session_id,'b1b2c3d4-0002-4000-8000-000000000002',
    (select current_stage_id from public.sessions where id=b.session_id),
    'c1b2c3d4-0001-4000-8000-000000000001',b.run_id,'codex','gpt-5.5','project')$$,
  '42501','Retry requires a workspace member and a terminal session run.',
  'a checkpoint cannot be bound across tenants');
grant select on build to service_role;
create temp table retry(job_id uuid,run_id uuid,created boolean);
grant select,insert on retry to service_role;
set local role service_role;
insert into retry select receipt.* from build b cross join lateral pg_temp.retry_checkpoint_job(b.session_id,b.run_id) receipt;
reset role;
select ok(created,'manual Retry creates a new job and run') from retry;
select is((select source_run_id from public.session_retry_checkpoint_jobs where job_id=retry.job_id),
  (select run_id from build),'manual Retry binds the selected failed run') from retry;
select is((select workspace_id from public.session_retry_checkpoint_jobs where job_id=retry.job_id),
  (select workspace_id from snapshot),'the retry binding records its target job workspace') from retry;
select throws_ok($$update public.session_retry_checkpoint_jobs set workspace_id='b1b2c3d4-0002-4000-8000-000000000002'
  where job_id=(select job_id from retry)$$,
  '23514','Retry checkpoint binding does not match its job workspace, session, and stage.',
  'the binding table itself rejects a workspace that does not own the target job');
select is((select source_checkpoint_run_id from public.session_job_git_inputs where job_id=retry.job_id),
  (select started from plan),'the new job preserves the accepted Plan provenance') from retry;
select ok(not receipt.created and receipt.job_id=retry.job_id,'duplicate Retry reuses the original binding')
from retry cross join build b cross join lateral pg_temp.retry_checkpoint_job(b.session_id,b.run_id) receipt;
select is((select count(*) from public.get_session_retry_checkpoint(job_id,1,run_id)),0::bigint,
  'a queued run cannot read the checkpoint') from retry;
update retry set run_id=pg_temp.start_retry_checkpoint_job(job_id);
select is((select count(*) from public.get_session_retry_checkpoint(job_id,2,run_id)),0::bigint,
  'a stale attempt cannot load the checkpoint') from retry;
set local role service_role;
select ok(c.source_run_id=snapshot.run_id and c.checkpoint_path=snapshot.path and c.input_sha=repeat('a',40)
  and c.head_sha=repeat('b',40) and c.bundle_sha256=repeat('c',64),'the service role can load the exact running retry bundle')
from retry cross join snapshot cross join lateral public.get_session_retry_checkpoint(retry.job_id,1,retry.run_id) c;
reset role;

select is(public.fail_stalled_session_job_attempt(job_id,1,'Worker attempt exceeded its 1800000ms deadline.',false,0,run_id),
  'error','a second timeout can occur before another capture') from retry;
create temp table inherited as select receipt.* from build b cross join retry r
cross join lateral pg_temp.retry_checkpoint_job(b.session_id,r.run_id) receipt;
select is((select source_run_id from public.session_retry_checkpoint_jobs where job_id=inherited.job_id),
  (select run_id from build),'manual Retry falls back to the previous checkpoint after a second timeout') from inherited;
update inherited set run_id=pg_temp.start_retry_checkpoint_job(job_id);
select is(public.fail_session_job_attempt(job_id,1,'codex CLI exited with code 1',false,0,run_id),
  'error','a different terminal failure remains a normal error') from inherited;
create temp table fallback as select receipt.* from build b cross join inherited i
cross join lateral pg_temp.retry_checkpoint_job(b.session_id,i.run_id) receipt;
select ok(created and not exists(select 1 from public.session_retry_checkpoint_jobs where job_id=fallback.job_id),
  'retrying a different failure does not reuse the timeout checkpoint') from fallback;

select ok(not has_table_privilege('authenticated','public.session_retry_checkpoints','select')
  and not has_table_privilege('authenticated','public.session_retry_checkpoint_jobs','select')
  and not has_function_privilege('authenticated','public.get_session_retry_checkpoint(uuid,integer,uuid)','execute')
  and not has_function_privilege('authenticated',
    'public.save_session_retry_checkpoint(uuid,integer,uuid,text,text,text,timestamptz,uuid,text)','execute')
  and not has_function_privilege('authenticated',
    'public.enqueue_session_retry_with_checkpoint(uuid,uuid,uuid,uuid,uuid,text,text,text)','execute'),
  'browser roles cannot list, save, restore, or bind private retry checkpoints');
select ok(not has_table_privilege('service_role','public.session_retry_checkpoints','insert')
  and not has_table_privilege('service_role','public.session_retry_checkpoint_jobs','insert'),
  'service writers must use the fenced RPCs');
delete from public.sessions where id=(select session_id from plan);
select is((select count(*) from public.session_retry_checkpoints where source_run_id=(select run_id from build)),0::bigint,
  'deleting the session cascades to its private checkpoint');
select is((select count(*) from public.session_retry_checkpoint_jobs where job_id in (
  select job_id from retry union all select job_id from inherited
)),0::bigint,'deleting the session cascades to all retry bindings');

select * from finish();
rollback;
