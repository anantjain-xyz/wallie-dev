begin;
set local request.jwt.claim.role = 'service_role';

-- SQL settlement for synthetic provider and judge receipts. This fixture makes
-- no external calls and shares no queues with a running worker.
create temp table live_scope as
select repo.workspace_id,repo.factory_id,:'owner_id'::uuid as owner_id,
  repo.id as repository_id,stage.pipeline_id,stage.id as stage_id,stage.slug as stage_slug,
  :'experiment_id'::uuid as experiment_id,:'excluded_run_id'::uuid as excluded_run_id
from public.github_repositories repo
join public.pipeline_stages stage on (stage.workspace_id,stage.id) = (repo.workspace_id,:'stage_id'::uuid)
where (repo.workspace_id,repo.factory_id) = (:'workspace_id'::uuid,:'factory_id'::uuid)
  and stage.pipeline_id = :'pipeline_id'::uuid;

create temp table fixture_ids as
select slot,gen_random_uuid() as id from unnest(array[43,44,45,46,50,51,101,102,103,104,105]) slot;
create function pg_temp.live_id(p_slot integer) returns uuid language sql stable as $$
  select id from fixture_ids where slot = p_slot
$$;

with definition as (
  select scope.*, jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', scope.pipeline_id, 'repositoryId', scope.repository_id,
    'sandboxProvider', 'vercel', 'agent', jsonb_build_object(
      'provider','codex','model','gpt-4.1-2025-04-14','concurrencyLimit',2),
    'stages', jsonb_build_array(jsonb_build_object('id', scope.stage_id, 'slug', scope.stage_slug))
  )::text as body from live_scope scope
)
insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json,
  canonical_digest, created_by)
select pg_temp.live_id(43), workspace_id, factory_id, 1, body,
  encode(sha256(convert_to(body, 'UTF8')), 'hex'), owner_id from definition;

insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id,
  factory_definition_provenance, factory_definition_revision_id)
select pg_temp.live_id(44), workspace_id, factory_id, 80, 'Synthetic replay source', pipeline_id,
  stage_id, 'pinned', pg_temp.live_id(43) from live_scope;
insert into public.agent_jobs(id, workspace_id, session_id, stage_id, stage_slug, trigger_type, status, attempt_count, finished_at)
select pg_temp.live_id(45), workspace_id, pg_temp.live_id(44), stage_id,
  stage_slug, 'manual_run', 'success', 1, clock_timestamp() from live_scope;
insert into public.agent_runs(id, workspace_id, session_id, agent_job_id, stage_id, stage_slug, run_type,
  model_provider, model_name, status, attempt_count, finished_at)
select pg_temp.live_id(46), workspace_id, pg_temp.live_id(44), pg_temp.live_id(45), stage_id,
  stage_slug, 'project', 'codex', 'gpt-4.1-2025-04-14', 'success', 1, clock_timestamp() from live_scope;
create temp table live_task as
select revision.* from live_scope scope
cross join lateral public.create_factory_benchmark_task(scope.workspace_id, scope.factory_id, scope.owner_id,
  pg_temp.live_id(46), 'Verify invoice reconciliation', 'Keep the frozen acceptance criteria.', '{}', 'eligible') revision
union all
select revision.* from live_scope scope
cross join lateral public.create_factory_benchmark_task(scope.workspace_id, scope.factory_id, scope.owner_id,
  scope.excluded_run_id, 'Verify notification recovery', 'Preserve the original notification settings.', '{}',
  'ineligible', 'The original notification settings were not retained.') revision;
insert into public.factory_benchmark_task_inputs(task_id, workspace_id, factory_id, source_run_id, source_session_id,
  source_job_id, source_attempt_count, definition_revision_id, repository_id, checkout_sha)
select task_id, workspace_id, factory_id, pg_temp.live_id(46), pg_temp.live_id(44), pg_temp.live_id(45), 1,
  pg_temp.live_id(43), scope.repository_id, repeat('a', 40)
from live_task task join live_scope scope using (workspace_id,factory_id)
where task.replay_eligibility = 'eligible';
create temp table live_suite as
select suite.* from live_scope scope
cross join lateral public.save_factory_benchmark_suite_revision(scope.workspace_id, scope.factory_id,
  scope.owner_id, 'Invoice quality and cost', 'regression',
  p_task_revision_ids => array(select id from live_task order by replay_eligibility, id)) suite;
create temp table live_policy as
select policy.* from live_scope scope
cross join lateral public.publish_factory_benchmark_replay_policy(scope.workspace_id, scope.factory_id,
  scope.owner_id, 'blocked') policy;

insert into public.workspace_vercel_sandbox_connections(workspace_id, connection_revision, encrypted_token, team_id, project_id)
select workspace_id, pg_temp.live_id(50), 'synthetic-encrypted-token', 'team_live', 'prj_live' from live_scope;
insert into public.sandbox_capability_checks(id, workspace_id, github_repository_id, agent_provider, agent_model,
  sandbox_provider, sandbox_id, sandbox_connection_revision, sandbox_vercel_team_id, sandbox_vercel_project_id, status, capabilities)
select pg_temp.live_id(51), scope.workspace_id, scope.repository_id, 'codex', 'gpt-4.1-2025-04-14',
  'vercel', 'sbx_live_capability', pg_temp.live_id(50), 'team_live', 'prj_live', 'success',
  (select jsonb_object_agg(key, jsonb_build_object('ok', true, 'detail', 'codex-cli 0.88.0'))
    from unnest(array['agentCli','git','node','packageManager','playwrightPackage','chromium',
      'screenshotSmoke','codexExternalSandbox']) capability(key))
from live_scope scope;

create temp table live_connection as
select public.configure_factory_benchmark_inference_connection(scope.workspace_id, scope.factory_id, scope.owner_id,
  'synthetic-encrypted-key', jsonb_build_object(
    'image', 'vcr.vercel.com/example/managed@sha256:' || repeat('d', 64),
    'codex', jsonb_build_object('cliVersion','0.88.0','cliDigest',repeat('c',64)),
    'opencode', jsonb_build_object('cliVersion','1.2.27','cliDigest',repeat('e',64)))) as receipt
from live_scope scope;
-- Distinct frozen definitions reuse the same exact qualified harness/model.
with revisions as (
  select slot,base.workspace_id,base.factory_id,base.created_by,
    (base.definition_json::jsonb || jsonb_build_object('operatingRulesMd','Frontier fixture variant ' || slot))::text as config
  from public.factory_definition_revisions base cross join generate_series(101,105) slot
  where base.id = pg_temp.live_id(43)
)
insert into public.factory_definition_revisions(id,workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
select pg_temp.live_id(slot),workspace_id,factory_id,1,config,encode(sha256(convert_to(config,'UTF8')),'hex'),created_by from revisions;

create temp table frontier_scorer as
select scorer.*,rubric.slug as rubric_slug from live_scope scope
cross join (values ('Invoice accuracy','invoice-accuracy'),('Validation quality','validation-quality')) rubric(name,slug)
cross join lateral public.create_factory_scorer(
  scope.workspace_id,scope.factory_id,scope.owner_id,rubric.name,rubric.slug,
  jsonb_build_object('schemaVersion',1,'rubric',rubric.name,
    'requiredEvidence',jsonb_build_array('artifact','validation_report'),
    'scoring',jsonb_build_object('kind','boolean','passValue',true))) scorer;

create temp table frontier_judge as
select judge.id from live_scope scope cross join lateral public.configure_factory_judge_profile(
  scope.workspace_id,scope.owner_id,0,'openai/gpt-example','openai',false,false,
  'v2.' || repeat('a',16) || '.synthetic.' || repeat('b',22)) judge;

create temp table frontier_storage (path text);

create function pg_temp.frontier_execute() returns void language plpgsql as $$
declare
  dispatch record;
  trial record;
  claim jsonb;
  nonce text;
  sandbox_id text;
  request_id uuid;
  inference jsonb;
  path text;
  operation_id uuid;
  cost numeric;
begin
  if public.reconcile_factory_benchmark_schedules(10) is distinct from 1 then raise exception 'Expected one scheduled frontier trial.'; end if;
  select * into strict dispatch from public.claim_next_worker_dispatch(true,10,3,120000);
  if not public.begin_worker_dispatch(dispatch.job_id,dispatch.attempt_count,dispatch.workflow_id)
  then raise exception 'Could not begin exact frontier worker dispatch.'; end if;
  claim := public.start_factory_benchmark_live_trial(dispatch.job_id,dispatch.attempt_count,clock_timestamp()+interval '2 minutes','workerd');
  select execution.*,frozen.repetition,candidate.comparison_position into strict trial from public.factory_benchmark_trials execution
  join public.factory_benchmark_experiment_trials frozen on frozen.trial_id = execution.id
  join public.factory_benchmark_experiment_candidates candidate on
    (candidate.workspace_id,candidate.factory_id,candidate.experiment_id,candidate.candidate_key) =
      (frozen.workspace_id,frozen.factory_id,frozen.experiment_id,frozen.candidate_key)
  where execution.id = (claim#>>'{identity,trialId}')::uuid;
  nonce := encode(sha256(convert_to(trial.id::text,'UTF8')),'hex');
  sandbox_id := 'sbx_frontier_' || replace(trial.id::text,'-','');
  if not public.arm_factory_benchmark_live_sandbox_binding(trial.id,trial.job_id,trial.run_id,trial.attempt_count,nonce,
      clock_timestamp()+interval '20 seconds')
    or not public.consume_factory_benchmark_live_sandbox_binding(nonce,'team_live','prj_live',sandbox_id)
  then raise exception 'Could not bind the exact frontier sandbox.'; end if;
  perform public.open_factory_benchmark_replay_execution(trial.workspace_id,trial.factory_id,trial.actor_user_id,
    trial.id,trial.task_revision_id,trial.policy_revision_id,trial.policy_digest,repeat('a',64));
  if not public.enable_factory_benchmark_live_inference(trial.id,trial.job_id,trial.run_id,trial.attempt_count,sandbox_id,
    repeat('b',64),repeat('c',64),repeat('a',64)) then raise exception 'Could not authorize frontier provider inference.'; end if;
  request_id := (public.begin_factory_benchmark_inference_request('team_live','prj_live',sandbox_id,repeat('d',64))->>'requestId')::uuid;
  if not public.finish_factory_benchmark_inference_request(request_id,'completed','gpt-4.1-2025-04-14',40,12)
  then raise exception 'Could not retain exact frontier provider outcome.'; end if;
  cost := case trial.comparison_position when 1 then 0.07 when 2 then 0.14 when 3 then 0.19
    when 4 then case when trial.repetition = 5 then null else 0.001 end when 5 then 0.07 end;
  if cost is not null and not (select accepted from public.record_session_run_usage(trial.job_id,trial.attempt_count,
    trial.run_id,null,null,'unavailable',cost,'measured')) then raise exception 'Could not record exact frontier measured dollars.'; end if;
  inference := public.close_factory_benchmark_live_inference(trial.id,trial.job_id,trial.run_id,trial.attempt_count);
  path := trial.workspace_id::text || '/benchmark/' || trial.id::text || '/' || trial.run_id::text || '/' || repeat('e',64) || '.bundle';
  operation_id := public.begin_workspace_resource_operation(trial.workspace_id,'upload','',path,
    'session-source-checkpoints',clock_timestamp() + interval '5 minutes');
  insert into storage.objects(bucket_id,name,metadata) values ('session-source-checkpoints',path,'{"mimetype":"application/octet-stream","size":8}');
  insert into frontier_storage values (path);
  if not public.finish_factory_benchmark_live_trial(trial.id,trial.job_id,trial.attempt_count,trial.run_id,jsonb_build_object(
    'input',jsonb_build_object('restorationReceiptSha256',repeat('a',64),'replayPromptSha256',repeat('b',64),
      'inputBundleSha256',repeat('c',64),'commitSha',repeat('a',40),'treeSha',repeat('b',40),'rendererRevision',1),
    'output',jsonb_build_object('artifactMarkdown','Exact frontier output.', 'commitSha',repeat('c',40),
      'treeSha',repeat('d',40),'validation',jsonb_build_object('version',1,'key','qualified-replay-source',
        'status','passed','commitSha',repeat('c',40),'treeSha',repeat('d',40)),
      'checkpoint',jsonb_build_object('kind','bundle','sha256',repeat('e',64),'storagePath',path,'uploadOperationId',operation_id)),
    'inferenceReceiptId',inference->>'inferenceReceiptId')) then raise exception 'Could not adopt the frontier output.'; end if;
end;
$$;

create function pg_temp.frontier_score() returns integer language plpgsql as $$
declare
  claim record;
  slot record;
  passed boolean;
  profile uuid := (select id from frontier_judge);
  finished integer := 0;
begin
  while true loop
    select * into claim from public.claim_factory_judge_job();
    if not found then exit; end if;
    select candidate.comparison_position,frozen.repetition,sample.evidence as refs,
      (scorer.rubric_slug = 'validation-quality') as validation_rubric into strict slot
    from public.factory_scorer_sample_receipts sample join public.factory_benchmark_experiment_trials frozen on frozen.trial_id = sample.benchmark_trial_id
    join public.factory_benchmark_experiment_candidates candidate on
    (candidate.workspace_id,candidate.factory_id,candidate.experiment_id,candidate.candidate_key) =
      (frozen.workspace_id,frozen.factory_id,frozen.experiment_id,frozen.candidate_key)
    join frontier_scorer scorer on scorer.id = sample.scorer_revision_id
    where sample.id = claim.sample_receipt_id;
    if public.begin_factory_judge_invocation(claim.workspace_id,claim.factory_id,claim.job_id,claim.attempt_id,claim.lease_id,
      profile,repeat('f',64),'workerd')->>'status' is distinct from 'authorized'
    then raise exception 'Could not authorize the exact frontier judge.'; end if;
    passed := slot.repetition <> 5 or case when slot.validation_rubric then slot.comparison_position <> 2
      else slot.comparison_position not in (1,3,5) end;
    if not public.finish_factory_judge_invocation(claim.workspace_id,claim.factory_id,claim.job_id,claim.attempt_id,
      claim.lease_id,'completed',jsonb_build_object('schemaVersion',1,'status',case when passed then 'pass' else 'fail' end,
        'evidence',slot.refs,'score',jsonb_build_object('kind','boolean','value',passed)),
      p_provider_model => 'openai/gpt-example',p_provider_name => 'OpenAI',p_cost_usd => 0.01,p_cost_provenance => 'measured')
    then raise exception 'Could not retain the exact frontier verdict.'; end if;
    finished := finished + 1;
  end loop;
  return finished;
end;
$$;

do $$
declare
  scope live_scope := (select scope from live_scope scope);
  suite live_suite := (select suite from live_suite suite);
  policy live_policy := (select policy from live_policy policy);
  receipt jsonb;
begin
  receipt := public.freeze_factory_benchmark_experiment_axes_with_evaluation(
    scope.workspace_id,scope.factory_id,scope.owner_id,scope.experiment_id,suite.id,policy.id,
    (select jsonb_agg(jsonb_build_object('definitionRevisionId',pg_temp.live_id(slot),
      'qualificationId',pg_temp.live_id(51),'workerRuntime','workerd') order by slot)
    from generate_series(101,105) slot),
    5,211,120000,jsonb_build_object('scorerRevisionIds',(select jsonb_agg(id) from frontier_scorer),'budgetLimitUsd',20));
  if receipt->>'expectedTrialCount' is distinct from '50' or receipt->>'eligibleTrialCount' is distinct from '25' then
    raise exception 'Expected five configurations with five eligible and five excluded trials each.';
  end if;
  perform public.configure_factory_benchmark_live_schedule(
    scope.workspace_id,scope.factory_id,scope.experiment_id,scope.owner_id,
    (select (key.receipt->>'id')::uuid from live_connection key),0.2,0.1,50,1,25);
  update public.agent_jobs set scheduled_at = clock_timestamp() + interval '1 hour'
  where workspace_id = scope.workspace_id and status = 'queued';
  perform pg_temp.frontier_execute() from generate_series(1,25);
  if public.reconcile_factory_benchmark_evaluations(100) is distinct from 50 then
    raise exception 'Expected two exact scorer jobs per retained live output.';
  end if;
end;
$$;

-- The claim RPC compares availability against this statement's start time.
do $$
begin
  if pg_temp.frontier_score() is distinct from 50 then
    raise exception 'Expected all exact scorer jobs to settle.';
  end if;
end;
$$;

select jsonb_build_object('suiteId',suite.suite_id,'storagePaths',(select jsonb_agg(path) from frontier_storage),
  'accuracyScorerRevisionId',(select id from frontier_scorer where rubric_slug = 'invoice-accuracy'),
  'validationScorerRevisionId',(select id from frontier_scorer where rubric_slug = 'validation-quality'))
from live_suite suite;

commit;
