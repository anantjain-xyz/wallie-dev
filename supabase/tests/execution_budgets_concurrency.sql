begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

insert into public.workspaces(id,slug,name,created_by)
values('eb000000-0000-4000-8000-000000000000','execution-budget-race','Execution budget race',
  'a1b2c3d4-0001-4000-8000-000000000001');
insert into public.workspace_members(id,workspace_id,user_id,kind,role,email,full_name)
values('eb000000-0000-4000-8000-0000000000f0','eb000000-0000-4000-8000-000000000000',
  'a1b2c3d4-0001-4000-8000-000000000001','human','owner','owner@example.com','Budget owner');
insert into public.pipelines(id,workspace_id,name,is_default)
values('eb000000-0000-4000-8000-000000000100','eb000000-0000-4000-8000-000000000000','Budget race',true);
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,prompt_template_md)
values('eb000000-0000-4000-8000-000000000101','eb000000-0000-4000-8000-000000000100',
  'eb000000-0000-4000-8000-000000000000',1,'plan','Plan','Plan');
select public.save_execution_policy('eb000000-0000-4000-8000-000000000000',
  'a1b2c3d4-0001-4000-8000-000000000001',0,
  '{"version":1,"maxRepairAttempts":1,"maxExecutionMs":60000,"maxTotalTokens":null,"maxCostUsd":null}');
insert into public.sessions(id,workspace_id,number,title,prompt_md,creator_member_id,pipeline_id,current_stage_id,phase_status)
values('eb000000-0000-4000-8000-000000000001','eb000000-0000-4000-8000-000000000000',1,
  'Concurrent repair quota','Only one repair may be reserved','eb000000-0000-4000-8000-0000000000f0',
  'eb000000-0000-4000-8000-000000000100','eb000000-0000-4000-8000-000000000101','rejected');
insert into public.agent_jobs(id,workspace_id,session_id,requested_by_member_id,stage_id,stage_slug,stage_name,trigger_type,status,dedupe_key)
values('eb000000-0000-4000-8000-000000000010','eb000000-0000-4000-8000-000000000000',
  'eb000000-0000-4000-8000-000000000001','eb000000-0000-4000-8000-0000000000f0',
  'eb000000-0000-4000-8000-000000000101','plan','Plan','assignment','success','initial');
insert into public.agent_runs(id,workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,run_type,model_provider,model_name,status,started_at,finished_at)
values('eb000000-0000-4000-8000-000000000011','eb000000-0000-4000-8000-000000000000',
  'eb000000-0000-4000-8000-000000000001','eb000000-0000-4000-8000-000000000010',
  'eb000000-0000-4000-8000-000000000101','plan','Plan','project','codex','gpt-5.5','success',now(),now());
commit;

begin;
select extensions.dblink_connect('budget_first',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('budget_second',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('budget_first','set request.jwt.claim.role=''service_role''');
select extensions.dblink_exec('budget_second','set request.jwt.claim.role=''service_role''');

select extensions.dblink_send_query('budget_first','select * from public.enqueue_session_job_with_run(
  ''eb000000-0000-4000-8000-000000000001'',''eb000000-0000-4000-8000-000000000000'',
  ''eb000000-0000-4000-8000-000000000101'',null,''manual_retry'',''codex'',''gpt-5.5'',''project'')');
select extensions.dblink_send_query('budget_second','select * from public.enqueue_session_job_with_run(
  ''eb000000-0000-4000-8000-000000000001'',''eb000000-0000-4000-8000-000000000000'',
  ''eb000000-0000-4000-8000-000000000101'',null,''manual_retry'',''codex'',''gpt-5.5'',''project'')');
create temp table first_repair_race as select * from extensions.dblink_get_result('budget_first')
  as result(job_id uuid,run_id uuid,created boolean);
insert into first_repair_race select * from extensions.dblink_get_result('budget_second')
  as result(job_id uuid,run_id uuid,created boolean);
select count(*) from extensions.dblink_get_result('budget_first') as result(job_id uuid,run_id uuid,created boolean);
select count(*) from extensions.dblink_get_result('budget_second') as result(job_id uuid,run_id uuid,created boolean);
select is((select count(distinct job_id)::integer from first_repair_race),1,'concurrent repair callers share one active job');
select is((select count(*)::integer from first_repair_race where created),1,'only one caller creates the repair');
select is((select execution_repair_attempts from public.sessions
  where id='eb000000-0000-4000-8000-000000000001'),1,'job adoption consumes exactly one repair slot');
select is((select execution_exhaustion_code from public.sessions
  where id='eb000000-0000-4000-8000-000000000001'),null::text,'using the final slot does not prematurely exhaust it');

update public.agent_jobs set status='success',finished_at=now()
where workspace_id='eb000000-0000-4000-8000-000000000000' and status='queued';
update public.agent_runs set status='success',finished_at=now()
where workspace_id='eb000000-0000-4000-8000-000000000000' and status='queued';
commit;
begin;

select extensions.dblink_send_query('budget_first','select * from public.enqueue_session_job_with_run(
  ''eb000000-0000-4000-8000-000000000001'',''eb000000-0000-4000-8000-000000000000'',
  ''eb000000-0000-4000-8000-000000000101'',null,''manual_retry'',''codex'',''gpt-5.5'',''project'')');
select extensions.dblink_send_query('budget_second','select * from public.enqueue_session_job_with_run(
  ''eb000000-0000-4000-8000-000000000001'',''eb000000-0000-4000-8000-000000000000'',
  ''eb000000-0000-4000-8000-000000000101'',null,''manual_retry'',''codex'',''gpt-5.5'',''project'')');
create temp table exhausted_repair_race as select * from extensions.dblink_get_result('budget_first')
  as result(job_id uuid,run_id uuid,created boolean);
insert into exhausted_repair_race select * from extensions.dblink_get_result('budget_second')
  as result(job_id uuid,run_id uuid,created boolean);
select is((select count(*)::integer from exhausted_repair_race where job_id is null and run_id is null),2,
  'both excess repair requests receive non-creating receipts');
select is((select count(*)::integer from public.agent_jobs
  where session_id='eb000000-0000-4000-8000-000000000001'),2,'no third job is created after exhaustion');
select is((select execution_repair_attempts from public.sessions
  where id='eb000000-0000-4000-8000-000000000001'),1,'concurrent retries cannot overspend the attempt quota');
select is((select execution_exhaustion_code from public.sessions
  where id='eb000000-0000-4000-8000-000000000001'),'repair_attempts','the first excess request records the durable reason');

select extensions.dblink_disconnect('budget_first');
select extensions.dblink_disconnect('budget_second');
select * from finish();
rollback;

begin;
delete from public.workspaces where id='eb000000-0000-4000-8000-000000000000';
commit;
