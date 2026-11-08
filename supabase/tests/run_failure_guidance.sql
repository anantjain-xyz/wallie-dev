begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

select ok(not has_function_privilege('authenticated','public.fail_session_job_attempt(uuid,integer,text,boolean,integer,uuid)','EXECUTE'),
  'browser users cannot write terminal failures');
select ok(not has_function_privilege('anon','internal.terminal_run_failure(text)','EXECUTE'),
  'anonymous users cannot invoke terminal classification');

-- Exercise the persisted format with actual worker/configuration error text.
select is(internal.terminal_run_failure(failure)->>'code',code,'classifies '||label)
from (values
  ('Codex is not connected for user fixture. Ask the session owner to connect a Codex credential in their profile.','credentials','missing agent credentials'),
  ('The Cursor connection expired. Reconnect Cursor in Settings.','credentials','expired credentials'),
  ('Session has no active human owner in this workspace connected to Cursor.','credentials','missing credential owner'),
  ('OpenCode provider "opencode-go" is not connected for user fixture.','credentials','provider credentials'),
  ('Connect Vercel before starting Wallie runs.','sandbox_configuration','sandbox configuration'),
  ('No GitHub installation or repository found for workspace. Connect a GitHub repository in workspace settings.','repository_configuration','repository configuration'),
  ('Workspace max_turns must be a positive integer between 1 and 100.','agent_configuration','agent configuration'),
  ('codex CLI exited with code 7: api_key=private-value','agent_exit','agent exit'),
  ('Agent ended without a successful completion event.','agent_incomplete','incomplete result'),
  ('Worker attempt exceeded its 1800000ms deadline.','timeout','worker timeout'),
  ('Worker attempt deadline expired before dispatch.','timeout','dispatch timeout'),
  ('Stalled: no activity for 240s','timeout','stalled execution'),
  ('Session elapsed execution budget exhausted.','budget','elapsed budget'),
  ('Session execution budget exhausted: total tokens.','budget','token budget'),
  ('Checkpoint publication ref changed.','publication','publication'),
  ('Source checkpoint could not be recorded. No artifact was published.','publication','source preservation'),
  ('Tests failed; api_key=private-value','unknown','unclassified payload without inferred test cause'),
  (null,'unknown','missing payload')
) as cases(failure,code,label);
select is(internal.terminal_run_failure('codex CLI exited with code 7: api_key=private-value'),
  '{"version":1,"category":"agent_exit","code":"agent_exit"}'::jsonb,
  'persisted metadata contains no raw provider payload or secrets');

create function pg_temp.failure_fixture(fixture integer, run_status public.agent_run_status default 'running', run_attempt integer default 1)
returns table(session_id uuid,job_id uuid,run_id uuid) language plpgsql as $$
declare owner public.sessions; work public.agent_jobs; execution public.agent_runs;
begin
  insert into public.sessions(workspace_id,number,title,prompt_md,creator_member_id,pipeline_id,current_stage_id)
  select stage.workspace_id,99005200+fixture,'Terminal failure proof '||fixture,'Exercise terminal history',
    'c1b2c3d4-0001-4000-8000-000000000001',stage.pipeline_id,stage.id
  from public.pipeline_stages stage join public.pipelines pipeline on pipeline.id=stage.pipeline_id
  where stage.workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and pipeline.is_default and stage.slug='plan'
  returning * into strict owner;
  insert into public.agent_jobs(workspace_id,session_id,stage_id,stage_slug,stage_name,trigger_type,status,attempt_count)
  select owner.workspace_id,owner.id,stage.id,stage.slug,stage.name,'assignment','running',1
  from public.pipeline_stages stage where stage.id=owner.current_stage_id returning * into strict work;
  insert into public.agent_runs(workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,model_provider,model_name,run_type,status,attempt_count,started_at)
  values(owner.workspace_id,owner.id,work.id,work.stage_id,work.stage_slug,work.stage_name,'codex','gpt-5.5','project',run_status,run_attempt,
    case when run_status='running' then now() else null end)
  returning * into strict execution;
  return query select owner.id,work.id,execution.id;
end;
$$;

create temp table failures as select fixtures.*,failure,code from (values
  (1,'Codex is not connected for user fixture.','credentials'),
  (2,'codex CLI exited with code 7: api_key=private-value','agent_exit'),
  (3,'Worker attempt exceeded its 1800000ms deadline.','timeout'),
  (4,'Session execution budget exhausted: total tokens.','budget'),
  (5,'Checkpoint publication ref changed.','publication'),
  (6,'Unclassified failure api_key=private-value','unknown')
) as cases(fixture,failure,code) cross join lateral pg_temp.failure_fixture(fixture) fixtures;

insert into public.agent_run_messages(agent_run_id,workspace_id,kind,message_md)
select run_id,'b1b2c3d4-0001-4000-8000-000000000001','error','**Error:** Test failed in agent output'
from failures;
select is(public.fail_session_job_attempt(job_id,1,failure,false,3,run_id),'error','failure finalizes the exact run: '||code)
from failures;
select is((select message_md::jsonb->>'code' from public.agent_run_messages where agent_run_id=failures.run_id and kind='run_failure'),
  code,'terminal metadata survives independently from agent/test errors: '||code) from failures;
select is((select count(*) from public.agent_run_messages where agent_run_id=failures.run_id and kind='error'),1::bigint,
  'terminal persistence retains the separate agent activity: '||code) from failures;
select is(public.fail_session_job_attempt(job_id,1,'Checkpoint publication ref changed.',false,3,run_id),'stale',
  'late failure cannot replace a terminal cause: '||code) from failures;
select is((select count(*) from public.agent_run_messages where agent_run_id=failures.run_id and kind='run_failure'),1::bigint,
  'late failures do not duplicate metadata: '||code) from failures;
select is((select message_md::jsonb->>'code' from public.agent_run_messages where agent_run_id=failures.run_id and kind='run_failure'),
  code,'late failure retains the original cause: '||code) from failures;

create temp table retry_fixture as select * from pg_temp.failure_fixture(7);
select is(public.fail_session_job_attempt((select job_id from retry_fixture),1,'codex CLI exited with code 7',true,3,
  (select run_id from retry_fixture)),'queued','automatically queued repair preserves its failed run cause');
update public.agent_jobs set status='running',attempt_count=2 where id=(select job_id from retry_fixture);
create temp table next_run as
with inserted as (
  insert into public.agent_runs(workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,model_provider,model_name,run_type,status,attempt_count)
  select workspace_id,session_id,id,stage_id,stage_slug,stage_name,'codex','gpt-5.5','project','running',2
  from public.agent_jobs where id=(select job_id from retry_fixture) returning id
) select id from inserted;
select is(public.fail_session_job_attempt((select job_id from retry_fixture),2,'Checkpoint publication ref changed.',false,3,
  (select id from next_run)),'error','next attempt records its own distinct failure');
select is((select message_md::jsonb->>'code' from public.agent_run_messages where agent_run_id=(select run_id from retry_fixture) and kind='run_failure'),
  'agent_exit','job last_error updates do not overwrite previous run explanations');
select is((select message_md::jsonb->>'code' from public.agent_run_messages where agent_run_id=(select id from next_run) and kind='run_failure'),
  'publication','new attempt gets the new terminal cause');

create temp table legacy_fixture as select * from pg_temp.failure_fixture(8,'error',null);
select is((select count(*) from public.agent_run_messages where agent_run_id=(select run_id from legacy_fixture) and kind='run_failure'),
  0::bigint,'legacy failures remain explicitly without invented terminal metadata');
create temp table queued_fixture as select * from pg_temp.failure_fixture(9,'queued',null);
create temp table prior_legacy_run as
with inserted as (
  insert into public.agent_runs(workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,model_provider,model_name,run_type,status)
  select workspace_id,session_id,id,stage_id,stage_slug,stage_name,'codex','gpt-5.5','project','error'
  from public.agent_jobs where id=(select job_id from queued_fixture) returning id
) select id from inserted;
select is(public.fail_session_job_attempt((select job_id from queued_fixture),1,'Connect Vercel before starting Wallie runs.',false,3,null),
  'error','configuration failure before run claim finalizes its queued run');
select is((select message_md::jsonb->>'code' from public.agent_run_messages where agent_run_id=(select run_id from queued_fixture) and kind='run_failure'),
  'sandbox_configuration','pre-claim run receives the actual configuration failure');
select is((select count(*) from public.agent_run_messages where agent_run_id=(select id from prior_legacy_run) and kind='run_failure'),
  0::bigint,'pre-claim failure never assigns a new cause to an old unclaimed run');
create temp table stale_fixture as select * from pg_temp.failure_fixture(10);
select is(public.fail_session_job_attempt((select job_id from stale_fixture),2,'codex CLI exited with code 1',false,3,
  (select run_id from stale_fixture)),'stale','wrong attempt cannot claim a failure');
select is((select count(*) from public.agent_run_messages where agent_run_id=(select run_id from stale_fixture) and kind='run_failure'),
  0::bigint,'stale attempt writes no terminal metadata');
select is((select status::text from public.agent_runs where id=(select run_id from stale_fixture)),'running',
  'stale failure leaves the actual run active');

-- Retry suppression has its own budget reason; it must not replace the error
-- that actually stopped the run (for example, an expired credential).
select * from public.save_execution_policy('b1b2c3d4-0001-4000-8000-000000000001',
  'a1b2c3d4-0001-4000-8000-000000000001',0,
  '{"version":1,"maxRepairAttempts":1,"maxExecutionMs":60000,"maxTotalTokens":100,"maxCostUsd":null}');
create temp table limited_fixture as select * from pg_temp.failure_fixture(11);
select is(public.fail_session_job_attempt((select job_id from limited_fixture),1,'The Cursor connection expired. Reconnect Cursor in Settings.',true,3,
  (select run_id from limited_fixture)),'error','unavailable usage suppresses automatic repair');
select ok((select last_error from public.agent_jobs where id=(select job_id from limited_fixture))
  like '%Execution budget exhausted; no automatic repair was queued.','job retains the retry suppression reason');
select is((select message_md::jsonb->>'code' from public.agent_run_messages where agent_run_id=(select run_id from limited_fixture) and kind='run_failure'),
  'credentials','retry suppression does not erase the original run cause');

select * from finish();
rollback;
