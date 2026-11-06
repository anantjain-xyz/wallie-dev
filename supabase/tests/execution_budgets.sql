begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0)
from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);

create function pg_temp.execution_requirements() returns jsonb language sql as $$
  select jsonb_build_object('version',1,'maxRepairAttempts',1,'maxExecutionMs',60000,
    'maxTotalTokens',100,'maxCostUsd',0.5);
$$;
create function pg_temp.budget_state(statement text) returns text language plpgsql as $$
begin
  begin
    execute statement;
    raise exception 'Operation unexpectedly succeeded' using errcode='Z0001';
  exception when others then return case when sqlstate='Z0001' then '00000' else sqlstate end;
  end;
end;
$$;

select ok(has_function_privilege('service_role','public.save_execution_policy(uuid,uuid,bigint,jsonb)','EXECUTE'),
  'service role can save execution policies');
select ok(not has_function_privilege('authenticated','public.record_session_run_usage(uuid,integer,uuid,bigint,bigint,text,numeric,text,text,boolean)','EXECUTE'),
  'browser roles cannot write usage accounting');
select ok(not has_function_privilege('anon','public.get_session_execution_budget(uuid)','EXECUTE'),
  'anonymous roles cannot read privileged budget state');
select ok(has_function_privilege('service_role',
  'internal.approve_session_stage_before_execution_budget(uuid,uuid,uuid,uuid,integer,uuid,text,text,text,bigint)','EXECUTE'),
  'invoker approval wrapper can call its internal implementation');
select ok(not internal.valid_execution_requirements(pg_temp.execution_requirements()-'maxRepairAttempts'),
  'repair limit must be explicit');
select ok(not internal.valid_execution_requirements(pg_temp.execution_requirements()||'{"maxExecutionMs":0}'),
  'elapsed limit must be positive');
select ok(internal.valid_execution_requirements(pg_temp.execution_requirements()||'{"maxTotalTokens":null,"maxCostUsd":null}'),
  'nullable telemetry caps are valid');
select is(pg_temp.budget_state($$select public.save_execution_policy('b1b2c3d4-0001-4000-8000-000000000001',
  'a1b2c3d4-0002-4000-8000-000000000002',0,pg_temp.execution_requirements())$$),'42501',
  'ordinary workspace members cannot save execution policies');

create temp table execution_policy as select * from public.save_execution_policy(
  'b1b2c3d4-0001-4000-8000-000000000001','a1b2c3d4-0001-4000-8000-000000000001',0,
  pg_temp.execution_requirements());
select is((select revision from execution_policy),1::bigint,'first execution policy is revision one');
select is(pg_temp.budget_state($$select public.save_execution_policy('b1b2c3d4-0001-4000-8000-000000000001',
  'a1b2c3d4-0001-4000-8000-000000000001',0,pg_temp.execution_requirements())$$),'PT409',
  'stale policy saves cannot overwrite a newer revision');

create temp table budget_pipeline as
with inserted as(insert into public.pipelines(workspace_id,name)
  values('b1b2c3d4-0001-4000-8000-000000000001','Execution budget proof') returning id)
select id from inserted;
insert into public.pipeline_stages(pipeline_id,workspace_id,position,slug,name,prompt_template_md)
select id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,1,'plan','Plan','Plan the task' from budget_pipeline
union all
select id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,2,'build','Build','Build the task' from budget_pipeline;
create temp table budget_session as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Attempt quota','Exercise repair reservations','codex','gpt-5.5',null,null,null,
  (select id from budget_pipeline));
select is((select execution_policy_revision_id from public.sessions where id=(select session_id from budget_session)),
  (select id from execution_policy),'new session pins the current execution revision');
select is((select execution_policy_revision_id from public.agent_runs where id=(select run_id from budget_session)),
  (select id from execution_policy),'run accounting carries the same revision');
select is((select execution_repair_attempts from public.sessions where id=(select session_id from budget_session)),0,
  'initial normal execution is not a repair');

create function pg_temp.start_budget_attempt(target_job uuid,target_attempt integer) returns uuid language plpgsql as $$
declare owner public.sessions;
begin
  select * into strict owner from public.sessions s join public.agent_jobs j on j.session_id=s.id where j.id=target_job;
  update public.agent_jobs set status='running',attempt_count=target_attempt,
    git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()) where id=target_job;
  return public.start_session_job_attempt(target_job,target_attempt,owner.current_stage_id,owner.current_artifact_version,
    'codex','gpt-5.5','project','wallie/budget-'||target_job::text||'-'||target_attempt::text);
end;
$$;
create function pg_temp.publish_budget_checkpoint(target_job uuid,target_run uuid) returns uuid language plpgsql as $$
declare owner public.sessions; selected public.session_job_git_inputs; claim uuid;
begin
  select * into strict owner from public.sessions s join public.agent_jobs j on j.session_id=s.id where j.id=target_job;
  select * into strict selected from public.session_job_git_inputs where job_id=target_job;
  perform public.pin_session_job_git_input(target_job,1,target_run,selected.repository_id,
    selected.base_branch,selected.input_sha);
  if not public.prepare_session_source_and_checkpoint_publication(target_run,selected.repository_id,
    selected.base_branch,selected.input_sha,selected.input_sha,'Budget checkpoint','Review body','','','',
    owner.current_artifact_version,'Review this checkpoint',null,null,null) then
    raise exception 'Budget checkpoint preparation failed';
  end if;
  claim:=public.claim_session_checkpoint_publication(target_run);
  if claim is null or not public.adopt_session_checkpoint_publication(target_run,claim,null,null) then
    raise exception 'Budget checkpoint adoption failed';
  end if;
  return target_run;
end;
$$;
select is(pg_temp.start_budget_attempt((select job_id from budget_session),1),(select run_id from budget_session),
  'first execution starts within budget');
create temp table first_usage as select * from public.record_session_run_usage(
  (select job_id from budget_session),1,(select run_id from budget_session),40,20,'measured',0.1,'measured',null,false);
select ok((select accepted and exhaustion_code is null from first_usage),'measured usage is accepted');
select is((select token_provenance from public.agent_runs where id=(select run_id from budget_session)),'measured',
  'token provenance is measured');
select is((select cost_provenance from public.agent_runs where id=(select run_id from budget_session)),'measured',
  'cost provenance is measured');
select is(public.fail_session_job_attempt((select job_id from budget_session),1,'retry once',true,3,
  (select run_id from budget_session)),'queued','first automatic repair is admitted');
select is((select execution_repair_attempts from public.sessions where id=(select session_id from budget_session)),1,
  'automatic requeue atomically reserves one repair');

create temp table second_run as select pg_temp.start_budget_attempt((select job_id from budget_session),2) run_id;
create temp table second_usage as select * from public.record_session_run_usage(
  (select job_id from budget_session),2,(select run_id from second_run),10,10,'measured',0.1,'measured',null,true);
select ok((select accepted and exhaustion_code is null from second_usage),'known cumulative usage remains within caps');
select is((select total_tokens from internal.load_session_execution_usage((select session_id from budget_session))),80::numeric,
  'session tokens reconcile exactly to both run records');
select is((select total_cost_usd from internal.load_session_execution_usage((select session_id from budget_session))),0.2::numeric,
  'session cost reconciles exactly to both run records');
select is(public.fail_session_job_attempt((select job_id from budget_session),2,'quota must stop retry',true,3,
  (select run_id from second_run)),'error','attempt quota disables automatic retry');
select is((select execution_exhaustion_code from public.sessions where id=(select session_id from budget_session)),'repair_attempts',
  'attempt exhaustion records a durable reason');
select is((select status::text from public.agent_jobs where id=(select job_id from budget_session)),'error',
  'exhaustion leaves the current job terminal');
create temp table exhausted_enqueue as select * from public.enqueue_session_job_with_run(
  (select session_id from budget_session),'b1b2c3d4-0001-4000-8000-000000000001',
  (select current_stage_id from public.sessions where id=(select session_id from budget_session)),
  'c1b2c3d4-0001-4000-8000-000000000001','manual_retry','codex','gpt-5.5','project');
select ok((select job_id is null and run_id is null and not created from exhausted_enqueue),
  'manual repair receives a non-creating exhaustion receipt');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from budget_session)),1::bigint,
  'exhaustion creates no further repair job');
select is((select execution_repair_attempts from public.sessions where id=(select session_id from budget_session)),1,
  'duplicate exhausted requests never overspend the quota');

-- Missing telemetry is explicit and cannot satisfy token/spend compliance.
create temp table missing_session as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Missing usage','Unknown is not zero','codex','gpt-5.5',null,null,null,(select id from budget_pipeline));
select is(pg_temp.start_budget_attempt((select job_id from missing_session),1),(select run_id from missing_session),
  'missing-usage fixture starts normally');
create temp table missing_usage as select * from public.record_session_run_usage(
  (select job_id from missing_session),1,(select run_id from missing_session),null,null,'unavailable',null,'unavailable',null,true);
select is((select exhaustion_code from missing_usage),'tokens_unavailable',
  'missing finalized token telemetry exhausts a token-budgeted session');
select is((select token_provenance from public.agent_runs where id=(select run_id from missing_session)),'unavailable',
  'missing tokens remain unavailable rather than zero');
select is((select input_tokens from public.agent_runs where id=(select run_id from missing_session)),null::bigint,
  'missing token value is NULL');
select public.fail_session_job_attempt((select job_id from missing_session),1,'provider usage unavailable',false,3,
  (select run_id from missing_session));
select ok((select tokens_unavailable and cost_unavailable from internal.load_session_execution_usage(
  (select session_id from missing_session))),'aggregate coverage marks both metrics incomplete');

create temp table missing_retry_session as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Missing retry usage','Finalize before reserving','codex','gpt-5.5',null,null,null,(select id from budget_pipeline));
select is(pg_temp.start_budget_attempt((select job_id from missing_retry_session),1),
  (select run_id from missing_retry_session),'missing-usage retry fixture starts normally');
select is(public.fail_session_job_attempt((select job_id from missing_retry_session),1,'failure without telemetry',true,3,
  (select run_id from missing_retry_session)),'error','missing telemetry prevents automatic retry before reservation');
select is((select status::text from public.agent_jobs where id=(select job_id from missing_retry_session)),'error',
  'missing-usage failure leaves no queued repair');
select is((select execution_repair_attempts from public.sessions where id=(select session_id from missing_retry_session)),0,
  'failed missing-usage run consumes no subsequent repair slot');
select is((select execution_exhaustion_code from public.sessions where id=(select session_id from missing_retry_session)),'tokens_unavailable',
  'finalized missing usage records the reason before retry selection');

-- Exhausted Linear rework cannot delete history or reroute the session.
create temp table linear_session as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Linear exhaustion','Preserve the original route','codex','gpt-5.5','BUDGET-LINEAR',null,null,(select id from budget_pipeline));
update public.sessions set execution_repair_attempts=1 where id=(select session_id from linear_session);
create temp table linear_exhausted as select * from public.apply_linear_session_transition(
  (select session_id from linear_session),'b1b2c3d4-0001-4000-8000-000000000001','BUDGET-LINEAR',
  (select updated_at from public.sessions where id=(select session_id from linear_session)),
  (select updated_at from public.workspace_linear_routing where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'),
  'budget-rework-span',clock_timestamp()+interval '1 second','state-rework',clock_timestamp()+interval '2 seconds',
  'Rework','codex','gpt-5.5','project');
select is((select outcome from linear_exhausted),'exhausted','Linear rework receives an exhaustion receipt');
select is((select current_stage_id from public.sessions where id=(select session_id from linear_session)),
  (select id from public.pipeline_stages where pipeline_id=(select id from budget_pipeline) and slug='plan'),
  'exhausted rework preserves the original stage');
select is((select status::text from public.agent_jobs where id=(select job_id from linear_session)),'queued',
  'exhausted rework does not cancel the existing job');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from linear_session)),1::bigint,
  'exhausted Linear rework creates no replacement job');

create temp table linear_continue_session as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Linear continuation adoption','Adopt the final repair','codex','gpt-5.5','BUDGET-CONTINUE',null,null,(select id from budget_pipeline));
update public.agent_jobs set status='success',finished_at=now() where id=(select job_id from linear_continue_session);
update public.agent_runs set status='success',finished_at=now() where id=(select run_id from linear_continue_session);
create temp table final_repair as select * from public.enqueue_session_job_with_run(
  (select session_id from linear_continue_session),'b1b2c3d4-0001-4000-8000-000000000001',
  (select current_stage_id from public.sessions where id=(select session_id from linear_continue_session)),
  null,'manual_retry','codex','gpt-5.5','project');
create temp table continued_repair as select * from public.apply_linear_session_transition(
  (select session_id from linear_continue_session),'b1b2c3d4-0001-4000-8000-000000000001','BUDGET-CONTINUE',
  (select updated_at from public.sessions where id=(select session_id from linear_continue_session)),
  (select updated_at from public.workspace_linear_routing where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'),
  'budget-continue-span',clock_timestamp()+interval '1 second','state-todo',clock_timestamp()+interval '2 seconds',
  'Todo','codex','gpt-5.5','project');
select is((select outcome from continued_repair),'queued','Linear continuation adopts the final admitted repair');
select is((select job_id from continued_repair),(select job_id from final_repair),
  'continuation preserves the existing repair job');
select is((select execution_repair_attempts from public.sessions where id=(select session_id from linear_continue_session)),1,
  'continuation does not reserve another repair');
select is((select execution_exhaustion_code from public.sessions where id=(select session_id from linear_continue_session)),null::text,
  'the final admitted repair is not prematurely exhausted');

create temp table adopt_review_session as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Checkpoint repair adoption','Adopt at the quota boundary','codex','gpt-5.5',null,null,
  '12b2c3d4-0001-4000-8000-000000000001',(select id from budget_pipeline));
insert into public.session_git_roots(session_id,workspace_id,repository_id,repository_full_name,base_branch,initial_base_sha)
select session_id,'b1b2c3d4-0001-4000-8000-000000000001','12b2c3d4-0001-4000-8000-000000000001',
  'acme-corp/webapp','main',repeat('a',40) from adopt_review_session;
select internal.prepare_session_job_git_input((select job_id from adopt_review_session));
select is(pg_temp.start_budget_attempt((select job_id from adopt_review_session),1),
  (select run_id from adopt_review_session),'checkpoint adoption fixture starts normally');
create temp table adopt_initial_usage as select * from public.record_session_run_usage(
  (select job_id from adopt_review_session),1,(select run_id from adopt_review_session),
  10,10,'measured',0.01,'measured',null,true);
select is(pg_temp.publish_budget_checkpoint((select job_id from adopt_review_session),
  (select run_id from adopt_review_session)),(select run_id from adopt_review_session),
  'checkpoint adoption fixture publishes its reviewed source');
update public.agent_jobs set status='success',finished_at=now() where id=(select job_id from adopt_review_session);
create temp table queued_checkpoint_repair as select * from public.enqueue_session_job_with_run(
  (select session_id from adopt_review_session),'b1b2c3d4-0001-4000-8000-000000000001',
  (select current_stage_id from public.sessions where id=(select session_id from adopt_review_session)),
  null,'manual_retry','codex','gpt-5.5','code');
create temp table adopted_checkpoint_repair as select * from public.reject_session_stage(
  (select session_id from adopt_review_session),'b1b2c3d4-0001-4000-8000-000000000001',1,
  'Adopt the queued checkpoint repair','codex','gpt-5.5',
  (select current_stage_id from public.sessions where id=(select session_id from adopt_review_session)),
  (select current_artifact_id from public.sessions where id=(select session_id from adopt_review_session)),
  'code','c1b2c3d4-0001-4000-8000-000000000001');
select is((select job_id from adopted_checkpoint_repair),(select job_id from queued_checkpoint_repair),
  'checkpoint-backed rejection adopts the queued final repair');
select is((select run_id from adopted_checkpoint_repair),(select run_id from queued_checkpoint_repair),
  'checkpoint-backed rejection preserves the queued run');
select ok((select not job_created from adopted_checkpoint_repair),
  'adoption does not report another repair job');
select is((select execution_repair_attempts from public.sessions where id=(select session_id from adopt_review_session)),1,
  'checkpoint adoption consumes no additional repair slot');
select is((select execution_exhaustion_code from public.sessions where id=(select session_id from adopt_review_session)),null::text,
  'the checkpoint-backed final repair remains admitted');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from adopt_review_session)),2::bigint,
  'checkpoint adoption creates no replacement job');

-- Elapsed accounting includes prior and current execution time, never review age.
create temp table elapsed_session as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Elapsed budget','Bound active execution time','codex','gpt-5.5',null,null,null,(select id from budget_pipeline));
select is(pg_temp.start_budget_attempt((select job_id from elapsed_session),1),(select run_id from elapsed_session),
  'elapsed fixture starts normally');
update public.agent_runs set started_at=clock_timestamp()-interval '61 seconds' where id=(select run_id from elapsed_session);
create temp table elapsed_budget as select * from public.get_session_execution_budget((select session_id from elapsed_session));
select is((select exhaustion_code from elapsed_budget),'elapsed_execution','active execution beyond the elapsed cap is exhausted');
select public.fail_session_job_attempt((select job_id from elapsed_session),1,'elapsed deadline',false,3,
  (select run_id from elapsed_session));
select is((select execution_exhaustion_code from public.sessions where id=(select session_id from elapsed_session)),'elapsed_execution',
  'elapsed deadline remains durable after cancellation');

-- Plain and inline feedback survive an exhausted review without a fake job/run.
insert into public.session_artifacts(workspace_id,session_id,stage_id,stage_slug,version,artifact_json)
select workspace_id,id,current_stage_id,'plan',1,to_jsonb('Review before exhaustion'::text)
from public.sessions where id=(select session_id from budget_session);
update public.sessions s set phase_status='awaiting_review',current_artifact_version=1,
  current_artifact_id=(select a.id from public.session_artifacts a where a.session_id=s.id and a.version=1),
  artifact_review_revision=0
where id=(select session_id from budget_session);
create temp table exhausted_feedback as select * from public.submit_artifact_feedback_batch(
  (select session_id from budget_session),'b1b2c3d4-0001-4000-8000-000000000001',1,
  (select current_stage_id from public.sessions where id=(select session_id from budget_session)),
  (select current_artifact_id from public.sessions where id=(select session_id from budget_session)),
  0,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{}'::uuid[],'Retain this feedback',
  'codex','gpt-5.5','project','c1b2c3d4-0001-4000-8000-000000000001');
select ok((select job_id is null and run_id is null and not job_created from exhausted_feedback),
  'exhausted inline review returns no fabricated execution');
select ok(exists(select 1 from public.artifact_feedback_batches b
  where b.id=(select feedback_batch_id from exhausted_feedback) and b.job_id is null and b.run_id is null),
  'immutable inline batch allows a durable null-job exhaustion receipt');
select is((select feedback_text from public.session_artifact_feedback where session_id=(select session_id from budget_session)
  and target_version=1),E'Whole-stage feedback:\nRetain this feedback','plain feedback is preserved on exhausted rejection');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from budget_session)),1::bigint,
  'exhausted feedback creates no repair job');

-- Revisions affect new sessions only and never clear an earlier exhaustion.
create temp table second_policy as select * from public.save_execution_policy(
  'b1b2c3d4-0001-4000-8000-000000000001','a1b2c3d4-0001-4000-8000-000000000001',1,
  pg_temp.execution_requirements()||'{"maxRepairAttempts":2}');
select is((select revision from second_policy),2::bigint,'policy edits create a new revision');
select is((select execution_policy_revision_id from public.sessions where id=(select session_id from budget_session)),
  (select id from execution_policy),'existing session remains pinned to its original revision');
select is(pg_temp.budget_state($$update public.sessions set execution_exhausted_at=null
  where id=(select session_id from budget_session)$$),'23514','exhaustion history cannot be reset silently');

set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='a1b2c3d4-0002-4000-8000-000000000002';
select is((select count(*) from public.execution_policy_revisions where id=(select id from public.execution_policy_revisions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and revision=2)),1::bigint,
  'active workspace members can read execution policy history');
set local request.jwt.claim.sub='ffffffff-ffff-4fff-8fff-ffffffffffff';
select is((select count(*) from public.execution_policy_revisions where id=(select id from public.execution_policy_revisions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and revision=2)),0::bigint,
  'foreign users cannot read execution policy history');
reset role;
set local request.jwt.claim.role='service_role';

select * from finish();
rollback;
