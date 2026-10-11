begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

-- Independent, committed fixtures let actual worker transactions contend on
-- the run row. The marker writer uses the processor's exact running predicate.
insert into public.sessions(id, workspace_id, number, title, prompt_md, creator_member_id, pipeline_id, current_stage_id)
select ('aef10000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
 stage.workspace_id,99002800+n,'Source retirement race '||n,'Keep recoverable source',
 'c1b2c3d4-0001-4000-8000-000000000001',stage.pipeline_id,stage.id
from public.pipeline_stages stage join public.pipelines pipeline on pipeline.id=stage.pipeline_id
cross join generate_series(1,2) n
where stage.workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and pipeline.is_default and stage.slug='plan';
insert into public.agent_jobs(id,workspace_id,session_id,stage_id,stage_slug,stage_name,trigger_type,status,attempt_count)
select ('aef10000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
 session.workspace_id,session.id,stage.id,stage.slug,stage.name,'assignment','running',1
from generate_series(1,2) n
join public.sessions session on session.id=('aef10000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
join public.pipeline_stages stage on stage.id=session.current_stage_id;
insert into public.agent_runs(id,workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,model_provider,model_name,run_type)
select ('aef10000-0000-4000-8000-'||lpad((200+n)::text,12,'0'))::uuid,
 job.workspace_id,job.session_id,job.id,job.stage_id,job.stage_slug,job.stage_name,'codex','gpt-5.5','project'
from generate_series(1,2) n
join public.agent_jobs job on job.id=('aef10000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid;
select public.start_session_job_attempt(job.id,1,job.stage_id,0,'codex','gpt-5.5','project','wallie/retirement-'||job.id)
from public.agent_jobs job where job.id in ('aef10000-0000-4000-8000-000000000101','aef10000-0000-4000-8000-000000000102');
commit;
begin;

create function pg_temp.wait_retirement_lock(application text) returns void language plpgsql as $$
declare deadline timestamptz:=clock_timestamp()+interval '5 seconds';
begin
 while not exists(select 1 from pg_stat_activity where application_name=application and wait_event_type='Lock') loop
  if clock_timestamp()>deadline then raise exception 'Expected retirement lock not reached by %',application; end if;
  perform pg_sleep(0.01);
 end loop;
end;
$$;
select extensions.dblink_connect('source_marker',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
 'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('source_retirement',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
 'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('source_marker','set application_name=''source_marker''; set statement_timeout=''15s''');
select extensions.dblink_exec('source_retirement','set application_name=''source_retirement''; set statement_timeout=''15s''');

-- A marker that acquires the run first survives terminal retirement. Cleanup
-- must read this committed marker after fail_session_job_attempt returns.
select extensions.dblink_exec('source_marker','begin');
select is(changed,1::bigint,'running exact attempt can retain source before retirement') from extensions.dblink('source_marker',$$
 with marked as (update public.agent_runs set source_recovery_required=true
 where id='aef10000-0000-4000-8000-000000000201' and attempt_count=1 and status='running' returning id)
 select count(*) from marked$$) as result(changed bigint);
select extensions.dblink_send_query('source_retirement',$$
 select public.fail_session_job_attempt('aef10000-0000-4000-8000-000000000101',1,'Stalled',true,3,
 'aef10000-0000-4000-8000-000000000201')$$);
select pg_temp.wait_retirement_lock('source_retirement');
select extensions.dblink_exec('source_marker','commit');
select is(outcome,'queued','retirement retries the job after the retention writer commits')
from extensions.dblink_get_result('source_retirement') as result(outcome text);
select * from extensions.dblink_get_result('source_retirement') as result(outcome text);
select is((select status::text from public.agent_runs where id='aef10000-0000-4000-8000-000000000201'),'error','retired exact run is terminal');
select is((select source_recovery_required from public.agent_runs where id='aef10000-0000-4000-8000-000000000201'),true,'post-retirement cleanup observes and preserves retained source');

-- In the inverse ordering, the processor starts its marker UPDATE before the
-- failure transaction commits. PostgreSQL rechecks status after the lock wait.
select extensions.dblink_exec('source_retirement','begin');
select is(outcome,'queued','failure owns and retires the second exact run') from extensions.dblink('source_retirement',$$
 select public.fail_session_job_attempt('aef10000-0000-4000-8000-000000000102',1,'Stalled',true,3,
 'aef10000-0000-4000-8000-000000000202')$$) as result(outcome text);
select extensions.dblink_send_query('source_marker',$$
 with marked as (update public.agent_runs set source_recovery_required=true
 where id='aef10000-0000-4000-8000-000000000202' and attempt_count=1 and status='running' returning id)
 select count(*) from marked$$);
select pg_temp.wait_retirement_lock('source_marker');
select extensions.dblink_exec('source_retirement','commit');
select is(changed,0::bigint,'blocked running-only marker cannot retain a terminal run')
from extensions.dblink_get_result('source_marker') as result(changed bigint);
select * from extensions.dblink_get_result('source_marker') as result(changed bigint);
select is((select status::text from public.agent_runs where id='aef10000-0000-4000-8000-000000000202'),'error','failure remains terminal after the losing marker write');
select is((select source_recovery_required from public.agent_runs where id='aef10000-0000-4000-8000-000000000202'),false,'a post-failure false marker cannot become true through the processor writer');

select extensions.dblink_disconnect('source_marker');
select extensions.dblink_disconnect('source_retirement');
select * from finish();
delete from public.sessions where id in ('aef10000-0000-4000-8000-000000000001','aef10000-0000-4000-8000-000000000002');
commit;
