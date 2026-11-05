begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

-- Committed, namespaced fixtures are visible to independent worker transactions.
insert into public.sessions(id,workspace_id,number,title,prompt_md,creator_member_id,pipeline_id,current_stage_id,github_repository_id)
select ('aef49600-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  stage.workspace_id,99004960+n,'Checkpoint publication race '||n,'Retain exact output',
  'c1b2c3d4-0001-4000-8000-000000000001',stage.pipeline_id,stage.id,'12b2c3d4-0001-4000-8000-000000000001'
from public.pipeline_stages stage join public.pipelines pipeline on pipeline.id=stage.pipeline_id
cross join generate_series(1,6) n
where stage.workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and pipeline.is_default and stage.slug='plan';
insert into public.agent_jobs(id,workspace_id,session_id,stage_id,stage_slug,stage_name,trigger_type,status,attempt_count)
select ('aef49600-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
  s.workspace_id,s.id,stage.id,stage.slug,stage.name,'assignment','running',1
from generate_series(1,6) n
join public.sessions s on s.id=('aef49600-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
join public.pipeline_stages stage on stage.id=s.current_stage_id;
insert into public.agent_runs(id,workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,model_provider,model_name,run_type)
select ('aef49600-0000-4000-8000-'||lpad((200+n)::text,12,'0'))::uuid,
  j.workspace_id,j.session_id,j.id,j.stage_id,j.stage_slug,j.stage_name,'codex','gpt-5.5','project'
from generate_series(1,6) n
join public.agent_jobs j on j.id=('aef49600-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid;
select public.start_session_job_attempt(j.id,1,j.stage_id,0,'codex','gpt-5.5','project','wallie/publication-race-'||j.id)
from public.agent_jobs j where j.id::text like 'aef49600-0000-4000-8000-%';
select public.pin_session_job_git_input(r.agent_job_id,1,r.id,'12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40))
from public.agent_runs r where r.id::text like 'aef49600-0000-4000-8000-%';
-- Fixtures 4 and 6 begin without source or intent for preparation races.
select public.prepare_session_source_and_checkpoint_publication(r.id,'12b2c3d4-0001-4000-8000-000000000001',
  'main',repeat('a',40),repeat('b',40),'Concurrent checkpoint','PR body','',
  encode(extensions.digest('concurrent checkpoint'::bytea,'sha256'),'hex'),encode('concurrent checkpoint'::bytea,'base64'),
  0,'Complete concurrent artifact')
from public.agent_runs r where r.id in (
  'aef49600-0000-4000-8000-000000000201','aef49600-0000-4000-8000-000000000202',
  'aef49600-0000-4000-8000-000000000203','aef49600-0000-4000-8000-000000000205');
select public.claim_session_checkpoint_publication(r.id) from public.agent_runs r where r.id in (
  'aef49600-0000-4000-8000-000000000201','aef49600-0000-4000-8000-000000000202','aef49600-0000-4000-8000-000000000203');
commit;
begin;

create function pg_temp.wait_checkpoint_lock(target_application text) returns void language plpgsql as $$
declare deadline timestamptz:=clock_timestamp()+interval '5 seconds';
begin
  while not exists(select 1 from pg_catalog.pg_stat_activity where application_name=target_application and wait_event_type='Lock') loop
    if clock_timestamp()>deadline then raise exception 'Expected checkpoint lock not reached by %',target_application; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;
select extensions.dblink_connect('checkpoint_owner',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('checkpoint_contender',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('checkpoint_owner','set application_name=''checkpoint_owner''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');
select extensions.dblink_exec('checkpoint_contender','set application_name=''checkpoint_contender''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');

-- Cancellation owns the session first. Adoption must wait, then revalidate.
select extensions.dblink_exec('checkpoint_owner','begin');
select is((select cardinality(run_ids) from extensions.dblink('checkpoint_owner',$q$
  select * from public.cancel_session_job_attempts('aef49600-0000-4000-8000-000000000001',
    'b1b2c3d4-0001-4000-8000-000000000001','Cancel concurrent publication','aef49600-0000-4000-8000-000000000201')
$q$) as canceled(job_ids uuid[],run_ids uuid[])),1,'cancellation owns and retires the exact first execution');
select extensions.dblink_send_query('checkpoint_contender',$q$
  select public.adopt_session_checkpoint_publication(run_id,claim_id,retained_ref,repeat('b',40))
  from public.session_checkpoint_publications where run_id='aef49600-0000-4000-8000-000000000201'
$q$);
select pg_temp.wait_checkpoint_lock('checkpoint_contender');
select ok(exists(select 1 from pg_catalog.pg_stat_activity where application_name='checkpoint_contender' and wait_event_type='Lock'),
  'adoption actually waits behind the cancellation lifecycle lock');
select extensions.dblink_exec('checkpoint_owner','commit');
select is((select adopted from extensions.dblink_get_result('checkpoint_contender') as result(adopted boolean)),false,
  'adoption rechecks committed cancellation after its lock wait');
select count(*) from extensions.dblink_get_result('checkpoint_contender') as result(adopted boolean);
select ok((select r.status='canceled' and j.status='canceled' and s.current_artifact_id is null
  and p.artifact_id is null and p.remote_verified_sha is null
  from public.agent_runs r join public.agent_jobs j on j.id=r.agent_job_id join public.sessions s on s.id=r.session_id
  join public.session_checkpoint_publications p on p.run_id=r.id where r.id='aef49600-0000-4000-8000-000000000201'),
  'losing remote proof cannot create an artifact, successful execution, or verified receipt');
select is((select count(*) from public.session_git_checkpoints where run_id='aef49600-0000-4000-8000-000000000201'),0::bigint,
  'cancel-winning race leaves no accepted checkpoint');

-- Inverse ordering: adoption commits first; an old expected-run cancellation
-- must not rewrite the successful run or the newly accepted artifact.
select extensions.dblink_exec('checkpoint_owner','begin');
select is((select adopted from extensions.dblink('checkpoint_owner',$q$
  select public.adopt_session_checkpoint_publication(run_id,claim_id,retained_ref,repeat('b',40))
  from public.session_checkpoint_publications where run_id='aef49600-0000-4000-8000-000000000202'
$q$) as result(adopted boolean)),true,'adoption owns the second execution and inserts its checkpoint before commit');
select extensions.dblink_send_query('checkpoint_contender',$q$
  select * from public.cancel_session_job_attempts('aef49600-0000-4000-8000-000000000002',
    'b1b2c3d4-0001-4000-8000-000000000001','Stale cancel','aef49600-0000-4000-8000-000000000202')
$q$);
select pg_temp.wait_checkpoint_lock('checkpoint_contender');
select extensions.dblink_exec('checkpoint_owner','commit');
select is((select cardinality(run_ids) from extensions.dblink_get_result('checkpoint_contender') as canceled(job_ids uuid[],run_ids uuid[])),0,
  'expected-run cancellation rechecks the successful execution after waiting for adoption');
select count(*) from extensions.dblink_get_result('checkpoint_contender') as canceled(job_ids uuid[],run_ids uuid[]);
select ok((select r.status='success' and j.status='success' and p.status='adopted'
  and p.artifact_id=s.current_artifact_id and c.artifact_id=p.artifact_id and c.output_ref=p.retained_ref
  from public.agent_runs r join public.agent_jobs j on j.id=r.agent_job_id join public.sessions s on s.id=r.session_id
  join public.session_checkpoint_publications p on p.run_id=r.id join public.session_git_checkpoints c on c.run_id=r.id
  where r.id='aef49600-0000-4000-8000-000000000202'),
  'adoption-winning race preserves one canonical successful artifact and exact retained checkpoint');

-- A generation transition commits while the old publisher is waiting.
select extensions.dblink_exec('checkpoint_owner','begin');
select count(*) from extensions.dblink('checkpoint_owner',$q$
  select id from public.sessions where id='aef49600-0000-4000-8000-000000000003' for no key update
$q$) as locked(id uuid);
select extensions.dblink_exec('checkpoint_owner',$q$
  update public.agent_jobs set attempt_count=2 where id='aef49600-0000-4000-8000-000000000103'
$q$);
select ok((select run_id is not null from extensions.dblink('checkpoint_owner',$q$
  select public.start_session_job_attempt(id,2,stage_id,0,'codex','gpt-5.5','project','wallie/publication-race-replacement')
  from public.agent_jobs where id='aef49600-0000-4000-8000-000000000103'
$q$) as started(run_id uuid)),'new generation starts a replacement run while holding lifecycle ownership');
select extensions.dblink_send_query('checkpoint_contender',$q$
  select public.adopt_session_checkpoint_publication(run_id,claim_id,retained_ref,repeat('b',40))
  from public.session_checkpoint_publications where run_id='aef49600-0000-4000-8000-000000000203'
$q$);
select pg_temp.wait_checkpoint_lock('checkpoint_contender');
select extensions.dblink_exec('checkpoint_owner','commit');
select is((select adopted from extensions.dblink_get_result('checkpoint_contender') as result(adopted boolean)),false,
  'old generation cannot adopt after a concurrent replacement commits');
select count(*) from extensions.dblink_get_result('checkpoint_contender') as result(adopted boolean);
select ok((select r.status='error' and j.attempt_count=2 and j.status='running' and s.current_artifact_id is null
  and p.remote_verified_sha is null and p.artifact_id is null
  from public.agent_runs r join public.agent_jobs j on j.id=r.agent_job_id join public.sessions s on s.id=r.session_id
  join public.session_checkpoint_publications p on p.run_id=r.id where r.id='aef49600-0000-4000-8000-000000000203'),
  'new generation remains current and old remote proof never becomes canonical');
select is((select count(*) from public.agent_runs where agent_job_id='aef49600-0000-4000-8000-000000000103' and status='running'),1::bigint,
  'stale adoption does not retire the one running replacement execution');

-- Reproduce a stale preliminary stall read. Atomic preparation wins the
-- lifecycle lock before the authoritative stall transition can execute.
select is((select count(*) from public.session_checkpoint_publications where run_id='aef49600-0000-4000-8000-000000000204'),0::bigint,
  'stall observer initially sees no publication obligation');
select extensions.dblink_exec('checkpoint_owner','begin');
select is((select prepared from extensions.dblink('checkpoint_owner',$q$
  select public.prepare_session_source_and_checkpoint_publication('aef49600-0000-4000-8000-000000000204',
    '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40),repeat('b',40),'Concurrent checkpoint','PR body','',
    encode(extensions.digest('concurrent checkpoint'::bytea,'sha256'),'hex'),encode('concurrent checkpoint'::bytea,'base64'),
    0,'Complete concurrent artifact')
$q$) as result(prepared boolean)),true,'atomic preparation records source and full intent under the lifecycle lock');
select extensions.dblink_send_query('checkpoint_contender',$q$
  select public.fail_stalled_session_job_attempt('aef49600-0000-4000-8000-000000000104',1,'Stale stall observation',true,3,
    'aef49600-0000-4000-8000-000000000204')
$q$);
select pg_temp.wait_checkpoint_lock('checkpoint_contender');
select extensions.dblink_exec('checkpoint_owner','commit');
select is((select outcome from extensions.dblink_get_result('checkpoint_contender') as result(outcome text)),'stale',
  'stall failure rechecks the intent committed while it waited and preserves the original execution');
select count(*) from extensions.dblink_get_result('checkpoint_contender') as result(outcome text);
select ok((select r.status='running' and j.status='running' and j.attempt_count=1 and p.status='pending'
  and p.deadline_at>clock_timestamp() and p.artifact_md='Complete concurrent artifact' and d.bundle_base64 is not null
  from public.agent_runs r join public.agent_jobs j on j.id=r.agent_job_id
  join public.session_checkpoint_publications p on p.run_id=r.id join public.session_source_deliveries d on d.run_id=r.id
  where r.id='aef49600-0000-4000-8000-000000000204'),
  'read-before-prepare stall race leaves complete source and artifact intent recoverable without an agent retry');

-- The combined API must wait for session ownership before taking the run
-- lock: otherwise cancellation here would deadlock against its partial writes.
select extensions.dblink_exec('checkpoint_owner','begin');
select count(*) from extensions.dblink('checkpoint_owner',$q$
  select id from public.sessions where id='aef49600-0000-4000-8000-000000000006' for no key update
$q$) as locked(id uuid);
select extensions.dblink_send_query('checkpoint_contender',$q$
  select public.prepare_session_source_and_checkpoint_publication('aef49600-0000-4000-8000-000000000206',
    '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40),repeat('b',40),'Concurrent checkpoint','PR body','',
    encode(extensions.digest('concurrent checkpoint'::bytea,'sha256'),'hex'),encode('concurrent checkpoint'::bytea,'base64'),
    0,'Complete concurrent artifact')
$q$);
select pg_temp.wait_checkpoint_lock('checkpoint_contender');
select is((select cardinality(run_ids) from extensions.dblink('checkpoint_owner',$q$
  select * from public.cancel_session_job_attempts('aef49600-0000-4000-8000-000000000006',
    'b1b2c3d4-0001-4000-8000-000000000001','Cancel before preparation','aef49600-0000-4000-8000-000000000206')
$q$) as canceled(job_ids uuid[],run_ids uuid[])),1,
  'session owner cancels while combined preparation waits, without a run-to-session lock inversion');
select extensions.dblink_exec('checkpoint_owner','commit');
select is((select prepared from extensions.dblink_get_result('checkpoint_contender') as result(prepared boolean)),false,
  'blocked combined preparation rechecks cancellation before writing either obligation');
select count(*) from extensions.dblink_get_result('checkpoint_contender') as result(prepared boolean);
select ok(not exists(select 1 from public.session_source_deliveries where run_id='aef49600-0000-4000-8000-000000000206')
  and not exists(select 1 from public.session_checkpoint_publications where run_id='aef49600-0000-4000-8000-000000000206'),
  'cancellation-winning combined preparation leaves neither source nor artifact intent');

-- A concurrent claimant skips held lifecycle ownership rather than locking an
-- intent first and blocking its owner in the opposite order.
select extensions.dblink_exec('checkpoint_owner','begin');
select count(*) from extensions.dblink('checkpoint_owner',$q$
  select id from public.sessions where id='aef49600-0000-4000-8000-000000000005' for no key update
$q$) as locked(id uuid);
select is((select claim_id from extensions.dblink('checkpoint_contender',$q$
  select public.claim_session_checkpoint_publication('aef49600-0000-4000-8000-000000000205')
$q$) as result(claim_id uuid)),null::uuid,'claim contender skips another transaction holding the session lifecycle lock');
select ok((select claim_id is not null from extensions.dblink('checkpoint_owner',$q$
  select public.claim_session_checkpoint_publication('aef49600-0000-4000-8000-000000000205')
$q$) as result(claim_id uuid)),'session lock owner can claim without an inverted publication-row lock deadlock');
select extensions.dblink_exec('checkpoint_owner','commit');
select is((select claim_id from extensions.dblink('checkpoint_contender',$q$
  select public.claim_session_checkpoint_publication('aef49600-0000-4000-8000-000000000205')
$q$) as result(claim_id uuid)),null::uuid,'concurrent claimant cannot replace the committed live lease');

select extensions.dblink_disconnect('checkpoint_owner');
select extensions.dblink_disconnect('checkpoint_contender');
select * from finish();
delete from public.sessions where id::text like 'aef49600-0000-4000-8000-%';
commit;
