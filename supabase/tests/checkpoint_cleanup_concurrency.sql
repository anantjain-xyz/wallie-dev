begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

-- Already-running, committed fixtures model candidates produced before the
-- global pause. No admission/control revision is changed by this suite.
delete from public.sessions where id::text like 'aef49900-0000-4000-8000-%';
insert into public.sessions(id,workspace_id,number,title,prompt_md,creator_member_id,pipeline_id,current_stage_id,github_repository_id,phase_status)
select ('aef49900-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,stage.workspace_id,99004990+n,
  'Checkpoint cleanup race '||n,'Retain exact source under concurrent admission',
  'c1b2c3d4-0001-4000-8000-000000000001',stage.pipeline_id,stage.id,
  '12b2c3d4-0001-4000-8000-000000000001','in_progress'
from public.pipeline_stages stage join public.pipelines pipeline on pipeline.id=stage.pipeline_id
cross join generate_series(1,4) n where stage.workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
  and pipeline.is_default and stage.slug='plan';
insert into public.agent_jobs(id,workspace_id,session_id,stage_id,stage_slug,stage_name,trigger_type,status,attempt_count)
select ('aef49900-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
  session.workspace_id,session.id,stage.id,stage.slug,stage.name,'assignment','running',1
from generate_series(1,4) n join public.sessions session on session.id=('aef49900-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
join public.pipeline_stages stage on stage.id=session.current_stage_id;
insert into public.agent_runs(id,workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,attempt_count,status,
  model_provider,model_name,run_type,branch_name,started_at)
select ('aef49900-0000-4000-8000-'||lpad((200+n)::text,12,'0'))::uuid,
  job.workspace_id,job.session_id,job.id,job.stage_id,job.stage_slug,job.stage_name,1,'running','codex','gpt-5.5','project',
  'wallie/cleanup-race-'||n,clock_timestamp()
from generate_series(1,4) n join public.agent_jobs job on job.id=('aef49900-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid;
do $$
declare n integer; execution uuid; output text;
begin
  foreach n in array array[1,3] loop
    execution:=('aef49900-0000-4000-8000-'||lpad((200+n)::text,12,'0'))::uuid;
    output:=case when n=1 then repeat('b',40) else repeat('c',40) end;
    perform public.pin_session_job_git_input(('aef49900-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
      1,execution,'12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40));
    if not public.prepare_session_source_and_checkpoint_publication(execution,
      '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40),output,'Concurrent cleanup checkpoint','PR summary','',
      encode(extensions.digest('cleanup race source'::bytea,'sha256'),'hex'),encode('cleanup race source'::bytea,'base64'),
      0,'Private concurrent output',clock_timestamp()-interval '8 days') then
      raise exception 'Concurrent cleanup fixture could not prepare';
    end if;
  end loop;
end;
$$;
commit;
begin;

create function pg_temp.wait_cleanup_lock(target_application text) returns void language plpgsql as $$
declare deadline timestamptz:=clock_timestamp()+interval '5 seconds';
begin
  while not exists(select 1 from pg_catalog.pg_stat_activity where application_name=target_application and wait_event_type='Lock') loop
    if clock_timestamp()>deadline then raise exception 'Expected cleanup lock not reached by %',target_application; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;
select extensions.dblink_connect('cleanup_owner',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('cleanup_contender',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('cleanup_owner','set application_name=''cleanup_owner''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');
select extensions.dblink_exec('cleanup_contender','set application_name=''cleanup_contender''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');

-- A consumer that owns the repository/SHA advisory key first must become
-- visible before a deletion capability is granted for that same object.
select extensions.dblink_exec('cleanup_owner','begin');
select is((select accepted from extensions.dblink('cleanup_owner',$q$
  select count(*) from public.pin_session_job_git_input('aef49900-0000-4000-8000-000000000102',1,
    'aef49900-0000-4000-8000-000000000202','12b2c3d4-0001-4000-8000-000000000001','main',repeat('b',40))
$q$) as result(accepted bigint)),1::bigint,'consumer transaction binds the raw SHA before cleanup admission');
select extensions.dblink_send_query('cleanup_contender',$q$
  select public.claim_session_checkpoint_cleanup('aef49900-0000-4000-8000-000000000201')
$q$);
select pg_temp.wait_cleanup_lock('cleanup_contender');
select ok(exists(select 1 from pg_catalog.pg_stat_activity where application_name='cleanup_contender' and wait_event_type='Lock'),
  'cleanup actually waits for the concurrent repository/SHA consumer admission');
select extensions.dblink_exec('cleanup_owner','commit');
select is((select claim_id from extensions.dblink_get_result('cleanup_contender') as result(claim_id uuid)),null::uuid,
  'GC rechecks the reference committed while its advisory lock was waiting');
select count(*) from extensions.dblink_get_result('cleanup_contender') as result(claim_id uuid);
select ok((select status='blocked' and cleanup_attempt_count=0 and last_error_code='referenced' and remote_absent_at is null
  from public.session_checkpoint_cleanup where run_id='aef49900-0000-4000-8000-000000000201'),
  'consumer-winning race issues no deletion capability and invents no absence');
select ok((select root.initial_base_sha=repeat('b',40) and input.input_sha=repeat('b',40) and input.input_ref is null
  and job.status='running' from public.session_git_roots root
  join public.session_job_git_inputs input on input.session_id=root.session_id join public.agent_jobs job on job.id=input.job_id
  where root.session_id='aef49900-0000-4000-8000-000000000002'),
  'the committed consumer retains its raw input and running ownership');

-- Inverse ordering: a deletion capability is permanent evidence that a remote
-- delete may still arrive. A new consumer waits, then rejects the tombstone.
select extensions.dblink_exec('cleanup_owner','begin');
create temp table cleanup_race_claim as select claim_id from extensions.dblink('cleanup_owner',$q$
  select public.claim_session_checkpoint_cleanup('aef49900-0000-4000-8000-000000000203')
$q$) as result(claim_id uuid);
select ok((select claim_id is not null from cleanup_race_claim),'GC transaction owns the second candidate before consumer admission');
select extensions.dblink_send_query('cleanup_contender',$q$
  select count(*) from public.pin_session_job_git_input('aef49900-0000-4000-8000-000000000104',1,
    'aef49900-0000-4000-8000-000000000204','12b2c3d4-0001-4000-8000-000000000001','main',repeat('c',40))
$q$);
select pg_temp.wait_cleanup_lock('cleanup_contender');
select extensions.dblink_exec('cleanup_owner','commit');
select is((select count(*) from extensions.dblink_get_result('cleanup_contender',false) as result(accepted bigint)),0::bigint,
  'consumer waiting behind GC cannot bind the retired raw SHA');
select ok(extensions.dblink_error_message('cleanup_contender') like '%Checkpoint source was retired by retention cleanup.%',
  'losing consumer observes the committed permanent cleanup tombstone');
select count(*) from extensions.dblink_get_result('cleanup_contender',false) as result(accepted bigint);
select ok(not exists(select 1 from public.session_git_roots where session_id='aef49900-0000-4000-8000-000000000004')
  and not exists(select 1 from public.session_job_git_inputs where job_id='aef49900-0000-4000-8000-000000000104')
  and exists(select 1 from public.agent_runs where id='aef49900-0000-4000-8000-000000000204' and status='running'),
  'rejected consumer statement rolls back partial lineage without retiring unrelated execution');
select is((select public.finish_session_checkpoint_cleanup('aef49900-0000-4000-8000-000000000203',claim_id,true)
  from cleanup_race_claim),true,'independent cleanup ownership accepts an exact absence receipt');
select is((select public.finish_session_checkpoint_cleanup('aef49900-0000-4000-8000-000000000203',claim_id,true)
  from cleanup_race_claim),true,'committed absence reconciliation is idempotent under the original capability');
select ok((select status='deleted' and cleanup_attempt_count=1 and remote_absent_at is not null
  from public.session_checkpoint_cleanup where run_id='aef49900-0000-4000-8000-000000000203'),
  'GC-winning race retains the immutable remote-absence receipt');

select extensions.dblink_disconnect('cleanup_owner');
select extensions.dblink_disconnect('cleanup_contender');
select * from finish();
delete from public.sessions where id::text like 'aef49900-0000-4000-8000-%';
commit;
