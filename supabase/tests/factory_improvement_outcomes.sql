begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
\ir fixtures/factory_improvement_adoption.psql

select public.set_git_continuity_release(true,revision,'Improvement outcomes fixture')
from public.get_git_continuity_release_state() where not enabled;
insert into internal.workspace_issue_counters(workspace_id,last_issue_number)
select scope.workspace_id,max(session.number) from live_scope scope
join public.sessions session on session.workspace_id = scope.workspace_id group by scope.workspace_id
on conflict (workspace_id) do update set last_issue_number = excluded.last_issue_number;

create function pg_temp.admit_outcome_session(p_slot integer)
returns public.agent_jobs language plpgsql as $$
declare job_id uuid; admitted_job public.agent_jobs;
begin
  select admitted.job_id into strict job_id from live_scope scope cross join lateral public.create_session_once_with_first_job(
    scope.workspace_id,pg_temp.live_id(21),pg_temp.live_id(p_slot),repeat('1',64),
    'Improvement outcome ' || p_slot,'Use the frozen admission.', 'codex','gpt-4.1-2025-04-14','{}'::uuid[],
    session_github_repository_id => pg_temp.live_id(42),selected_pipeline_id => pg_temp.live_id(40),
    selected_stage_ids => array[pg_temp.live_id(41)]) admitted;
  select * into strict admitted_job from public.agent_jobs job where job.id = job_id;
  return admitted_job;
end;
$$;

create function pg_temp.start_outcome_attempt(p_job public.agent_jobs)
returns uuid language plpgsql as $$
declare run_id uuid;
begin
  update public.agent_jobs set status = 'running', attempt_count = 1,
    git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
  where id = p_job.id;
  run_id := public.start_session_job_attempt(p_job.id,1,p_job.stage_id,0,'codex','gpt-4.1-2025-04-14',
    'project','wallie/outcome-' || p_job.id);
  if run_id is null then raise exception 'Expected the exact outcome attempt to start.'; end if;
  -- A real worker starts in a later transaction. Use wall time for the test's shared transaction.
  update public.agent_runs set started_at = clock_timestamp() where id = run_id;
  return run_id;
end;
$$;

create function pg_temp.write_outcome_usage(p_job uuid,p_run uuid,p_cost numeric,p_provenance text)
returns void language plpgsql as $$
begin
  if not (select accepted from public.record_session_run_usage(p_job,1,p_run,
    p_cost_usd => p_cost,p_cost_provenance => p_provenance,
    p_estimation_revision => case when p_provenance = 'estimated' then 'fixture-cost-v1' end))
  then raise exception 'Expected acceptance of the exact attempt cost.'; end if;
end;
$$;

create function pg_temp.approve_outcome_session(p_slot integer)
returns uuid language plpgsql as $$
declare
  job public.agent_jobs;
  started_run uuid;
  retained public.session_checkpoint_publications;
  owner public.sessions;
  result public.pipeline_phase_status;
  claim uuid;
begin
  job := pg_temp.admit_outcome_session(p_slot);
  started_run := pg_temp.start_outcome_attempt(job);
  perform pg_temp.write_outcome_usage(job.id,started_run,0.1,'measured');
  perform public.pin_session_job_git_input(job.id,1,started_run,pg_temp.live_id(42),'main',repeat('a',40));
  if not public.prepare_session_source_and_checkpoint_publication(
    started_run,pg_temp.live_id(42),'main',repeat('a',40),repeat('b',40),'Outcome checkpoint',
    'Retained outcome source','',encode(sha256('outcome source'::bytea),'hex'),
    encode('outcome source'::bytea,'base64'),0,'Approve this retained output.')
  then raise exception 'Expected checkpoint preparation for the exact outcome.'; end if;
  claim := public.claim_session_checkpoint_publication(started_run);
  select * into strict retained from public.session_checkpoint_publications publication where publication.run_id = started_run;
  if claim is null or not public.adopt_session_checkpoint_publication(started_run,claim,retained.retained_ref,repeat('b',40))
  then raise exception 'Expected checkpoint adoption for the exact outcome.'; end if;
  update public.agent_runs set finished_at = clock_timestamp() where id = started_run;
  select * into strict owner from public.sessions where id = job.session_id;
  select phase_status into strict result from public.approve_session_stage(owner.id,owner.workspace_id,
    owner.current_stage_id,owner.current_artifact_id,owner.current_artifact_version,pg_temp.live_id(21),
    'codex','gpt-4.1-2025-04-14','project',owner.artifact_review_revision);
  if result <> 'approved' then raise exception 'Expected a final stage approval.'; end if;
  return owner.id;
end;
$$;

create function pg_temp.fail_outcome_session(p_slot integer,p_reason text,p_cost numeric,p_provenance text)
returns uuid language plpgsql as $$
declare job public.agent_jobs; run_id uuid;
begin
  job := pg_temp.admit_outcome_session(p_slot);
  run_id := pg_temp.start_outcome_attempt(job);
  perform pg_temp.write_outcome_usage(job.id,run_id,p_cost,p_provenance);
  perform internal.exhaust_session_execution(job.session_id,p_reason,1,1);
  if public.fail_session_job_attempt(job.id,1,'Fixture terminal attempt',false,1,run_id) <> 'error'
  then raise exception 'Expected the exact exhausted attempt to settle.'; end if;
  update public.agent_runs set finished_at = clock_timestamp() where id = run_id;
  return job.session_id;
end;
$$;

create function pg_temp.read_outcomes(p_actor uuid default pg_temp.live_id(1),p_factory uuid default null,
  p_revision uuid default pg_temp.live_id(312))
returns jsonb language sql as $$
  select public.get_factory_improvement_outcomes(workspace_id,coalesce(p_factory,factory_id),p_actor,
    pg_temp.live_id(300),p_revision)
  from live_scope
$$;

select ok(has_function_privilege('service_role',
  'public.get_factory_improvement_outcomes(uuid,uuid,uuid,uuid,uuid)','execute')
  and not has_function_privilege('authenticated',
    'public.get_factory_improvement_outcomes(uuid,uuid,uuid,uuid,uuid)','execute')
  and not has_function_privilege('anon',
    'public.get_factory_improvement_outcomes(uuid,uuid,uuid,uuid,uuid)','execute'),
  'only the trusted service can project production outcomes');
select is(pg_temp.read_outcomes(),null::jsonb,'a proposal without an adoption has no production outcome');

create temp table baseline_outcome_sessions as
select slot,pg_temp.approve_outcome_session(slot) as session_id from generate_series(650,659) slot;
create temp table baseline_outcome_in_flight as
select admitted.* from pg_temp.admit_outcome_session(660) admitted;
select internal.exhaust_session_execution(session_id,'elapsed_execution',1,1) from baseline_outcome_in_flight;
create temp table baseline_outcome_pin as
select to_jsonb(input) as pin from public.session_factory_admission_inputs input
join baseline_outcome_in_flight admitted using (session_id);

create temp table outcome_adoption as select pg_temp.adopt_fixture()->'adoption' as receipt;
select throws_ok($$select pg_temp.read_outcomes(pg_temp.live_id(699))$$,'42501',null,
  'an actor outside this factory cannot read adoption outcomes');
create temp table unrelated_outcome_factory as
select factory.id from live_scope scope cross join lateral public.create_factory(
  scope.workspace_id,scope.owner_id,'Unrelated outcomes','unrelated-outcomes') factory;
select is(pg_temp.read_outcomes(p_factory => (select id from unrelated_outcome_factory)),null::jsonb,
  'a factory manager cannot resolve a receipt under another factory');
select is(pg_temp.read_outcomes(p_revision => pg_temp.live_id(311)),null::jsonb,
  'a different proposal revision has no outcome even within the same factory');

select ok((select report @> '{"minimumCompleted":10,"status":"inconclusive",
  "baseline":{"activationNumber":2,"admittedSessions":11,"startedSessions":10,"approvedSessions":10,
    "exhaustedSessions":0,"unresolvedSessions":1,"verifiedMerges":0,"approvalRateBps":10000,
    "approvalLimitsBps":{"lower":9090,"upper":10000},"spend":{"state":"measured","knownUsd":1,
    "measuredAttempts":10,"estimatedAttempts":0,"unavailableAttempts":0,"pendingAttempts":0}},
  "candidate":{"activationNumber":3,"admittedSessions":0,"approvalRateBps":null,"approvalLimitsBps":null,
    "spend":{"state":"no_attempts","knownUsd":null}},
  "restore":{"eligible":true,"receipt":null}}'
  and report->'reasons' ? 'insufficient_completed_sessions'
  and report->>'adoptionId' = receipt->>'id'
  and report#>>'{baseline,revisionId}' = receipt#>>'{baseline,revisionId}'
  and report#>>'{baseline,digest}' = receipt#>>'{baseline,digest}'
  and report#>>'{candidate,revisionId}' = receipt#>>'{adopted,revisionId}'
  and report#>>'{candidate,digest}' = receipt#>>'{adopted,digest}'
  from (select pg_temp.read_outcomes() report) outcome cross join outcome_adoption),
  'the projection compares the exact admitted activations and keeps unstarted admissions visible');

savepoint before_candidate_observations;
select pg_temp.approve_outcome_session(slot) from generate_series(661,670) slot;
select report @> '{"status":"observed",
  "candidate":{"admittedSessions":10,"approvedSessions":10,"approvalRateBps":10000}}'
  and report->'reasons' = '[]'::jsonb as observed_outcomes
from (select pg_temp.read_outcomes() report) outcome \gset
rollback to before_candidate_observations;
release savepoint before_candidate_observations;
select ok(:'observed_outcomes'::boolean,'supported overlapping approval limits keep the report observed');

create temp table candidate_outcome_approved as select pg_temp.approve_outcome_session(661) session_id;
create function pg_temp.open_outcome_pull(p_session uuid)
returns public.session_pr_epochs language plpgsql as $$
declare
  claim uuid;
  operation public.session_pr_operations;
  epoch public.session_pr_epochs;
  observation uuid;
  pull_url text;
begin
  claim := public.claim_session_pr_sync(p_session);
  select * into strict operation from public.session_pr_operations where claim_id = claim;
  select * into strict epoch from public.session_pr_epochs where id = operation.epoch_id;
  pull_url := 'https://github.com/' || epoch.repository_full_name || '/pull/64101';
  if not public.arm_session_pr_creation(epoch.id,operation.id,claim)
  then raise exception 'Expected the canonical pull request creation to be armed.'; end if;
  observation := public.begin_session_pr_sync_observation(operation.id,claim,64101,pull_url);
  if not public.finish_session_pr_sync(operation.id,claim,operation.desired_sha,operation.desired_fence_sha,
    64101,pull_url,'open',true,operation.desired_sha,clock_timestamp(),observation)
  then raise exception 'Expected a canonical open pull request.'; end if;
  select * into strict epoch from public.session_pr_epochs where id = operation.epoch_id;
  return epoch;
end;
$$;

create temp table candidate_outcome_pull as
select epoch.* from candidate_outcome_approved approved
cross join lateral pg_temp.open_outcome_pull(approved.session_id) epoch;
select is(pg_temp.read_outcomes()#>'{candidate,verifiedMerges}','0'::jsonb,
  'the merged configuration pull request and an open delivery pull request are not delivery outcomes');
select ok(public.finish_session_pr_observation_with_merge(
  p_observation_id => public.begin_session_pr_observation(
    epoch.workspace_id,epoch.repository_id,epoch.branch_name,epoch.pr_number),
  p_pr_url => epoch.pr_url,p_pr_state => 'merged',p_is_draft => false,p_pr_head_sha => epoch.pr_head_sha,
  p_pr_updated_at => timing.observed,p_merged_at => timing.observed,p_merge_commit_sha => repeat('f',40),
  p_merge_source_head_sha => epoch.pr_head_sha),'the exact native provider merge observation is accepted')
from candidate_outcome_pull epoch cross join (select clock_timestamp() observed) timing;
select is(pg_temp.read_outcomes()#>'{candidate,verifiedMerges}','1'::jsonb,
  'the exact admitted session contributes a verified canonical delivery merge');

create temp table candidate_outcome_pending as select admitted.* from pg_temp.admit_outcome_session(662) admitted;
select pg_temp.start_outcome_attempt(job)
from public.agent_jobs job join candidate_outcome_pending pending using (id);
select pg_temp.fail_outcome_session(663,'elapsed_execution',0.2,'estimated');
select pg_temp.fail_outcome_session(664,'spend_unavailable',null,'unavailable');
-- A legacy approved status without an exact M06 receipt is unresolved.
create temp table candidate_outcome_unverified as select admitted.* from pg_temp.admit_outcome_session(665) admitted;
update public.sessions set phase_status = 'approved' where id = (select session_id from candidate_outcome_unverified);

select ok((select report @> '{"status":"inconclusive","candidate":{"admittedSessions":5,"startedSessions":4,
  "approvedSessions":1,"exhaustedSessions":1,"unresolvedSessions":3,"approvalRateBps":5000,
  "approvalLimitsBps":{"lower":2000,"upper":8000},"spend":{"state":"partial","knownUsd":0.3,
    "measuredAttempts":1,"estimatedAttempts":1,"unavailableAttempts":1,"pendingAttempts":1}}}'
  and report->'reasons' ? 'insufficient_completed_sessions'
  from (select pg_temp.read_outcomes() report) outcome),
  'approval requires current exact evidence and unknown, estimated and pending usage remain distinct');

select pg_temp.fail_outcome_session(slot,'elapsed_execution',0.1,'measured') from generate_series(671,678) slot;
select ok((select report @> '{"status":"inconclusive","candidate":{"admittedSessions":13,
    "approvedSessions":1,"exhaustedSessions":9,"unresolvedSessions":3}}'
  and report->'reasons' ? 'incomplete_outcome_coverage'
  and not (report->'reasons' ? 'insufficient_completed_sessions')
  from (select pg_temp.read_outcomes() report) outcome),
  'enough completions still require sufficient outcome coverage');
select pg_temp.fail_outcome_session(slot,'elapsed_execution',0.1,'measured') from generate_series(679,680) slot;
select ok((select report @> '{"status":"degraded","candidate":{"admittedSessions":15,
    "approvedSessions":1,"exhaustedSessions":11,"unresolvedSessions":3,
    "approvalLimitsBps":{"lower":666,"upper":2667}}}'
  and report->'reasons' = '[]'::jsonb
  from (select pg_temp.read_outcomes() report) outcome),
  'the candidate degrades only when supported approval limits no longer overlap');

create function pg_temp.restore_outcome_baseline(p_expected bigint default 3)
returns public.factory_definition_activations language sql as $$
  select public.rollback_factory_routing_activation(scope.workspace_id,scope.factory_id,scope.owner_id,p_expected,
    2,pg_temp.live_id(161),array['vercel'],array['agentCli','git','node','packageManager'])
  from live_scope scope
$$;

create temp table pending_outcome_pin as
select to_jsonb(input) as pin from public.session_factory_admission_inputs input
join candidate_outcome_pending admitted using (session_id);
select throws_ok($$select pg_temp.restore_outcome_baseline(2)$$,'PT409',null,
  'a stale head cannot append the restore');
select throws_ok($$select pg_temp.restore_outcome_baseline()$$,'PT422',null,
  'restoring the exact prior definition still requires current smoke evidence');
select ok(public.finish_factory_definition_smoke_test(scope.workspace_id,test.id,'passed',
  jsonb_build_object('runtimeProfile','vercel','stageCount',1,'completedStageCount',1,
    'stages',jsonb_build_array(jsonb_build_object('stageId',pg_temp.live_id(41),'promptDigest',repeat('a',64)))),
  null),'the exact prior revision passes its current head-scoped smoke')
from live_scope scope
join public.factory_definition_revisions baseline on baseline.id = pg_temp.live_id(161)
cross join lateral public.start_factory_definition_smoke_test(scope.workspace_id,scope.factory_id,scope.owner_id,
  3,'revision',baseline.id,baseline.canonical_digest,array['vercel'],
  array['agentCli','git','node','packageManager']) test;

create temp table outcome_before_restore as select pg_temp.read_outcomes() report;
create temp table outcome_restore as select restored.* from pg_temp.restore_outcome_baseline() restored;
create temp table admission_after_restore as select admitted.* from pg_temp.admit_outcome_session(681) admitted;
select ok((select input.activation_number = 4 and input.definition_revision_id = pg_temp.live_id(161)
    and input.definition_digest = report#>>'{baseline,digest}'
  from public.session_factory_admission_inputs input join admission_after_restore admitted using(session_id)
  cross join outcome_before_restore),'a new admission pins the restored revision in the new activation');
select ok((select outcome.report @> '{"restore":{"eligible":false,"receipt":{"activationNumber":4,
  "previousActivationNumber":3,"targetActivationNumber":2,"restoredMode":"shadow"}}}'
  and outcome.report#>>'{restore,receipt,targetRevisionId}' = pg_temp.live_id(161)::text
  and outcome.report#>>'{restore,receipt,createdAt}' is not null
  and outcome.report->'baseline' = prior.report->'baseline'
  and outcome.report->'candidate' = prior.report->'candidate'
  from (select pg_temp.read_outcomes() report) outcome cross join outcome_before_restore prior),
  'the receipt identifies the exact restore and a repeated digest in a new activation cannot join the original cohort');
select is((select to_jsonb(input) from public.session_factory_admission_inputs input
  join candidate_outcome_pending admitted using (session_id)),(select pin from pending_outcome_pin),
  'an in-flight adopted admission keeps its original pin after the restore');
select is((select to_jsonb(input) from public.session_factory_admission_inputs input
  join baseline_outcome_in_flight admitted using (session_id)),(select pin from baseline_outcome_pin),
  'an in-flight baseline admission keeps its original pin after adoption and restore');
select * from finish();
rollback;
