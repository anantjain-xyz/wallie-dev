begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.live_id(slot integer) returns uuid language sql immutable as $$
  select ('62300000-0000-4000-9000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values (pg_temp.live_id(1), 'benchmark-frontier-owner@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.live_id(11), 'benchmark-frontier-test', 'Live benchmark test');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.live_id(21), pg_temp.live_id(11), pg_temp.live_id(1), 'human', 'owner');

create temp table live_scope as
select workspace_id, id as factory_id, pg_temp.live_id(1) as owner_id
from public.factories where workspace_id = pg_temp.live_id(11) and is_default;

insert into public.pipelines(id, workspace_id, factory_id, name)
select pg_temp.live_id(40), workspace_id, factory_id, 'Live replay pipeline' from live_scope;
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name, prompt_template_md)
values (pg_temp.live_id(41), pg_temp.live_id(11), pg_temp.live_id(40), 1, 'review', 'Review', 'Review the task.');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.live_id(35), pg_temp.live_id(11), 62300001, 'https://example.test/install', 7350,
  'Organization', 'Live fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name,
  private, html_url, default_branch)
select pg_temp.live_id(42), workspace_id, factory_id, pg_temp.live_id(35), 62300002,
  'live-fixture', 'fixture/live', true, 'https://example.test/fixture', 'main' from live_scope;
insert into public.factory_agents(id, workspace_id, factory_id, name, slug, created_by)
select pg_temp.live_id(47), workspace_id, factory_id, 'Benchmarked agent', 'benchmarked-agent', owner_id from live_scope;
insert into public.factory_agent_prompt_revisions(id,workspace_id,factory_id,agent_id,revision_number,prompt_md,prompt_sha256,created_by)
select pg_temp.live_id(48),workspace_id,factory_id,pg_temp.live_id(47),1,'',encode(sha256(''::bytea),'hex'),owner_id
from live_scope;
with definition as (
  select scope.*, jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.live_id(40), 'repositoryId', pg_temp.live_id(42),
    'sandboxProvider', 'vercel', 'agent', jsonb_build_object(
      'provider','codex','model','gpt-4.1-2025-04-14','concurrencyLimit',2),
    'implementationAgent', jsonb_build_object('agentId',pg_temp.live_id(47),
      'promptRevisionId',pg_temp.live_id(48),'promptMd','','promptSha256',encode(sha256(''::bytea),'hex')),
    'stages', jsonb_build_array(jsonb_build_object('id', pg_temp.live_id(41), 'slug','review'))
  )::text as body from live_scope scope
)
insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json,
  canonical_digest, created_by)
select pg_temp.live_id(43), workspace_id, factory_id, 1, body,
  encode(sha256(convert_to(body, 'UTF8')), 'hex'), owner_id from definition;

insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id,
  factory_definition_provenance, factory_definition_revision_id)
select pg_temp.live_id(44), workspace_id, factory_id, 1, 'Synthetic replay source', pg_temp.live_id(40),
  pg_temp.live_id(41), 'pinned', pg_temp.live_id(43) from live_scope;
insert into public.agent_jobs(id, workspace_id, session_id, stage_id, stage_slug, trigger_type, status, attempt_count, finished_at)
values (pg_temp.live_id(45), pg_temp.live_id(11), pg_temp.live_id(44), pg_temp.live_id(41),
  'review', 'manual_run', 'success', 1, clock_timestamp());
insert into public.agent_runs(id, workspace_id, session_id, agent_job_id, stage_id, stage_slug, run_type,
  model_provider, model_name, status, attempt_count, finished_at)
values (pg_temp.live_id(46), pg_temp.live_id(11), pg_temp.live_id(44), pg_temp.live_id(45), pg_temp.live_id(41),
  'review', 'project', 'codex', 'gpt-4.1-2025-04-14', 'success', 1, clock_timestamp());
create temp table live_task as
select revision.* from live_scope scope
cross join lateral public.create_factory_benchmark_task(scope.workspace_id, scope.factory_id, scope.owner_id,
  pg_temp.live_id(46), 'Synthetic live replay', 'Keep the frozen acceptance criteria.', '{}', 'eligible') revision;
insert into public.factory_benchmark_task_inputs(task_id, workspace_id, factory_id, source_run_id, source_session_id,
  source_job_id, source_attempt_count, definition_revision_id, repository_id, checkout_sha)
select task_id, workspace_id, factory_id, pg_temp.live_id(46), pg_temp.live_id(44), pg_temp.live_id(45), 1,
  pg_temp.live_id(43), pg_temp.live_id(42), repeat('a', 40) from live_task;
create temp table live_suite as
select suite.* from live_scope scope cross join live_task task
cross join lateral public.save_factory_benchmark_suite_revision(scope.workspace_id, scope.factory_id,
  scope.owner_id, 'Live replay suite', 'regression', p_task_revision_ids => array[task.id]) suite;
create temp table live_policy as
select policy.* from live_scope scope
cross join lateral public.publish_factory_benchmark_replay_policy(scope.workspace_id, scope.factory_id,
  scope.owner_id, 'blocked') policy;

insert into public.workspace_vercel_sandbox_connections(workspace_id, connection_revision, encrypted_token, team_id, project_id)
values (pg_temp.live_id(11), pg_temp.live_id(50), 'synthetic-encrypted-token', 'team_live', 'prj_live');
insert into public.sandbox_capability_checks(id, workspace_id, github_repository_id, agent_provider, agent_model,
  sandbox_provider, sandbox_id, sandbox_connection_revision, sandbox_vercel_team_id, sandbox_vercel_project_id, status, capabilities)
select pg_temp.live_id(config.slot), pg_temp.live_id(11), pg_temp.live_id(42), config.harness, config.model,
  'vercel', 'sbx_live_capability', pg_temp.live_id(50), 'team_live', 'prj_live', 'success',
  (select jsonb_object_agg(key, jsonb_build_object('ok', true, 'detail', config.cli))
    from unnest(array['agentCli','git','node','packageManager','playwrightPackage','chromium',
      'screenshotSmoke','codexExternalSandbox']) capability(key))
from (values (51, 'codex', 'gpt-4.1-2025-04-14', 'codex-cli 0.88.0'),
  (52, 'opencode', 'openai/gpt-4.1-2025-04-14', '1.2.27')) config(slot, harness, model, cli);

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
select scorer.* from live_scope scope cross join lateral public.create_factory_scorer(
  scope.workspace_id,scope.factory_id,scope.owner_id,'Exact quality','exact-quality',
  '{"schemaVersion":1,"rubric":"Inspect exact output.","requiredEvidence":["artifact","validation_report"],"scoring":{"kind":"boolean","passValue":true}}') scorer;
create temp table frontier_judge as
select * from public.configure_factory_judge_profile(pg_temp.live_id(11),pg_temp.live_id(1),0,
  'openai/gpt-example','openai',false,false,'v2.' || repeat('a',16) || '.synthetic.' || repeat('b',22));

create function pg_temp.freeze_frontier(p_slot integer,p_definitions integer[],p_repetitions integer,p_scored boolean default true)
returns jsonb language sql as $$
  with pinned as (
    select jsonb_agg(jsonb_build_object('definitionRevisionId',pg_temp.live_id(revision.slot),
      'qualificationId',pg_temp.live_id(51),'workerRuntime','workerd') order by revision.position) as candidates
    from unnest(p_definitions) with ordinality revision(slot,position)
  )
  select case when p_scored then public.freeze_factory_benchmark_experiment_axes_with_evaluation(
      scope.workspace_id,scope.factory_id,scope.owner_id,pg_temp.live_id(p_slot),suite.id,policy.id,pinned.candidates,p_repetitions,211,120000,
      jsonb_build_object('scorerRevisionIds',(select jsonb_agg(id) from frontier_scorer),'budgetLimitUsd',20))
    else public.freeze_factory_benchmark_experiment_axes(scope.workspace_id,scope.factory_id,scope.owner_id,
      pg_temp.live_id(p_slot),suite.id,policy.id,pinned.candidates,p_repetitions,211,120000) end
  from live_scope scope cross join live_suite suite cross join live_policy policy cross join pinned;
$$;
create function pg_temp.configure_frontier(p_slot integer,p_cap integer) returns jsonb language sql as $$
  select public.configure_factory_benchmark_live_schedule(scope.workspace_id,scope.factory_id,pg_temp.live_id(p_slot),
    scope.owner_id,(key.receipt->>'id')::uuid,0.2,0.1,50,1,p_cap)
  from live_scope scope cross join live_connection key;
$$;
create function pg_temp.read_frontier(p_slot integer default 80,p_limit integer default 50,p_after text default null,
  p_floor integer default 8000,p_minimum integer default 2) returns jsonb language sql as $$
  select public.read_factory_benchmark_frontier(workspace_id,factory_id,pg_temp.live_id(p_slot),owner_id,null,p_after,p_limit,p_floor,p_minimum)
  from live_scope;
$$;
create function pg_temp.frontier_result(p_order integer,p_slot integer default 80) returns jsonb language sql as $$
  select item from jsonb_array_elements(pg_temp.read_frontier(p_slot)->'items') item
  where (item->>'position')::integer = p_order;
$$;

select is(pg_temp.freeze_frontier(80,array[101,102,103,104,105],5)->>'expectedTrialCount','25','the shared task and five repetitions freeze exactly');
select is(pg_temp.freeze_frontier(82,array[101,102],2,false)->>'expectedTrialCount','4','an unscored frozen comparison is retained');
select is(pg_temp.read_frontier(82)#>>'{recommendation,reason}','no_scorer','an unscored comparison cannot recommend');
select throws_ok($$select pg_temp.read_frontier(p_floor => 10001)$$,'22023',null,'the exact floor bounds are enforced in SQL');
select throws_ok($$select pg_temp.read_frontier(p_minimum => 1)$$,'22023',null,'the minimum resolved policy cannot drop below two');
select throws_ok($$select pg_temp.read_frontier(p_after => repeat('a',64))$$,'22023',null,'a cursor must resolve within the requested matrix');
select throws_ok($$select public.read_factory_benchmark_frontier(workspace_id,factory_id,pg_temp.live_id(80),pg_temp.live_id(975))
  from live_scope$$,'42501',null,'the frontier shares current factory manager access');
select throws_ok($$select public.read_factory_benchmark_frontier(workspace_id,factory_id,pg_temp.live_id(80),owner_id,pg_temp.live_id(975))
  from live_scope$$,'22023',null,'a manually supplied scorer must be frozen in this matrix');
select ok(not has_function_privilege('authenticated','public.read_factory_benchmark_frontier(uuid,uuid,uuid,uuid,uuid,text,integer,integer,integer)','EXECUTE'),
  'browsers cannot impersonate the current authorized manager');

create function pg_temp.frontier_execute(p_unpriced_position integer default null) returns void language plpgsql as $$
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
  -- The queue stores dispatch deadlines relative to the overall test
  -- transaction. The individual trial still uses its frozen two-minute cap.
  select * into strict dispatch from public.claim_next_worker_dispatch(true,10,3,1800000);
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
  cost := case trial.comparison_position when 1 then 0.06 when 2 then 0.14 when 3 then 0.18
    when 4 then case when trial.repetition = 5 then null else 0.001 end when 5 then 0.068 end;
  if cost is not null and trial.comparison_position is distinct from p_unpriced_position
    and not (select accepted from public.record_session_run_usage(trial.job_id,trial.attempt_count,
    trial.run_id,null,null,'unavailable',cost,'measured')) then raise exception 'Could not record exact frontier measured dollars.'; end if;
  inference := public.close_factory_benchmark_live_inference(trial.id,trial.job_id,trial.run_id,trial.attempt_count);
  if trial.repetition = 5 and trial.comparison_position in (1,5) then
    if trial.comparison_position = 1 then
      if not public.fail_factory_benchmark_trial(trial.id,trial.job_id,trial.attempt_count,trial.run_id,'checkpoint_unavailable')
      then raise exception 'Could not settle the paid failed trial.'; end if;
    elsif public.fail_deadline_session_job_attempt(trial.job_id,trial.attempt_count,'Exact frontier fixture deadline.',trial.run_id) <> 'error' then
      raise exception 'Could not settle the paid timeout trial.';
    end if;
    return;
  end if;
  path := trial.workspace_id::text || '/benchmark/' || trial.id::text || '/' || trial.run_id::text || '/' || repeat('e',64) || '.bundle';
  operation_id := public.begin_workspace_resource_operation(trial.workspace_id,'upload','',path,
    'session-source-checkpoints',clock_timestamp() + interval '5 minutes');
  insert into storage.objects(bucket_id,name,metadata) values ('session-source-checkpoints',path,'{"mimetype":"application/octet-stream","size":8}');
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

create function pg_temp.frontier_score(p_mixed boolean default false,p_fail_position integer default null)
returns void language plpgsql as $$
declare
  claim record;
  slot record;
  passed boolean;
  cost numeric;
  profile uuid := (select id from frontier_judge);
  evidence jsonb;
  provider text;
  retrying boolean;
begin
  while true loop
    select * into claim from public.claim_factory_judge_job();
    if not found then exit; end if;
    select candidate.comparison_position,frozen.repetition,sample.evidence as refs into strict slot
    from public.factory_scorer_sample_receipts sample join public.factory_benchmark_experiment_trials frozen on frozen.trial_id = sample.benchmark_trial_id
    join public.factory_benchmark_experiment_candidates candidate on
    (candidate.workspace_id,candidate.factory_id,candidate.experiment_id,candidate.candidate_key) =
      (frozen.workspace_id,frozen.factory_id,frozen.experiment_id,frozen.candidate_key)
    where sample.id = claim.sample_receipt_id;
    if public.begin_factory_judge_invocation(claim.workspace_id,claim.factory_id,claim.job_id,claim.attempt_id,claim.lease_id,
      profile,repeat('f',64),'workerd')->>'status' is distinct from 'authorized'
    then raise exception 'Could not authorize the exact frontier judge.'; end if;
    retrying := not p_mixed and slot.comparison_position = 1 and slot.repetition = 1 and claim.attempt_number = 1;
    if retrying then
      if not public.finish_factory_judge_invocation(claim.workspace_id,claim.factory_id,claim.job_id,claim.attempt_id,
        claim.lease_id,'provider_unavailable',p_cost_usd => 0.04,p_cost_provenance => 'measured')
      then raise exception 'Could not retain the billed failed judge attempt.'; end if;
      update public.factory_evaluation_jobs set available_at = statement_timestamp() where id = claim.job_id;
      continue;
    end if;
    passed := not ((slot.comparison_position = 3 and slot.repetition = 5)
      or (slot.comparison_position is not distinct from p_fail_position and slot.repetition = 1));
    cost := case slot.comparison_position when 1 then 0.015 when 3 then 0.02 when 5 then 0.015 else 0.01 end;
    provider := case when p_mixed and slot.comparison_position = 2 then 'Different routing provider' else 'OpenAI' end;
    if not public.finish_factory_judge_invocation(claim.workspace_id,claim.factory_id,claim.job_id,claim.attempt_id,
      claim.lease_id,'completed',jsonb_build_object('schemaVersion',1,'status',case when passed then 'pass' else 'fail' end,
        'evidence',slot.refs,'score',jsonb_build_object('kind','boolean','value',passed)),
      p_provider_model => 'openai/gpt-example',p_provider_name => provider,p_cost_usd => cost,p_cost_provenance => 'measured')
    then raise exception 'Could not retain the exact frontier verdict.'; end if;
  end loop;
end;
$$;

update public.agent_jobs set scheduled_at = clock_timestamp() + interval '1 hour' where status = 'queued';
select pg_temp.configure_frontier(80,25);
select is(pg_temp.read_frontier()#>>'{recommendation,reason}','comparison_in_progress','an open frozen cohort cannot give a premature global recommendation');
select pg_temp.frontier_execute() from generate_series(1,25);
select is(pg_temp.read_frontier()#>>'{recommendation,reason}','comparison_in_progress',
  'score-ready adopted results remain in progress before the selected evaluator jobs are enqueued');
select is(public.reconcile_factory_benchmark_evaluations(100),23,'only adopted live outputs admit the exact frozen rubric');
select is(pg_temp.read_frontier()#>>'{recommendation,reason}','comparison_in_progress',
  'selected exact judge work also withholds a premature global recommendation');
select ok(pg_temp.frontier_result(1)#>'{quality,passRateBps}' = 'null'::jsonb
  and pg_temp.frontier_result(1)#>'{cost,meanCostUsd}' = 'null'::jsonb
  and pg_temp.frontier_result(1)#>>'{counts,resolved}' = '1',
  'the incomplete cohort preserves the known failed execution without imputing a quality or cost mean');
select pg_temp.frontier_score();

select is(pg_temp.read_frontier()->'cohort',
  '{"plannedTrialCount":25,"eligibleTrialCount":25,"excludedTrialCount":0,"eligibleSlotCount":5,"taskRevisionCount":1,"repetitions":5}'::jsonb,
  'frontier compares each candidate to the same five frozen eligible slots');
select is(pg_temp.read_frontier()->>'frontierCount','3','two exact ties and a higher-cost higher-quality tradeoff stay on the frontier');
select is(pg_temp.read_frontier()#>>'{recommendation,status}','tied','cost and quality ties are equally recommended');
select is(pg_temp.read_frontier()#>>'{recommendation,candidateCount}','2','the exact tie count remains global');
select is(pg_temp.read_frontier(p_limit => 1)#>>'{recommendation,meanCostUsd}','0.08','the full-cohort global recommendation is independent of pagination');
select is(pg_temp.frontier_result(1)#>>'{counts,nonPassFailure}','1','a paid exact execution failure remains a resolved non-pass');
select is(pg_temp.frontier_result(5)#>>'{counts,nonPassFailure}','1','a paid exact timeout remains a resolved non-pass');
select is(pg_temp.frontier_result(1)#>>'{cost,measuredUsd}','0.4','the measured total includes the paid failed judge retry and the failed execution');
select is(pg_temp.frontier_result(1)#>>'{quality,passRateBps}','8000','the quality floor counts all five exact resolved executions');
select is(pg_temp.frontier_result(1)#>>'{quality,scoredPassRateBps}','10000','the observed scorer pass rate discloses its own denominator');
select is(pg_temp.frontier_result(1)#>>'{spread,minPassRateBps}','0','the empirical repetition spread includes the known failure');
select is(pg_temp.frontier_result(1)#>>'{spread,maxPassRateBps}','10000','the empirical repetition spread includes the observed passes');
select is(pg_temp.frontier_result(1)#>>'{spread,minMeanCostUsd}','0.06','the lowest fully measured repetition includes the paid failed execution');
select is(pg_temp.frontier_result(1)#>>'{spread,maxMeanCostUsd}','0.115','the highest fully measured repetition includes the paid retry');
select is(pg_temp.frontier_result(3)->>'status','dominated','comparable higher-cost equal quality is dominated');
select is(pg_temp.frontier_result(3)#>>'{dominatedBy,position}','2','the retained dominator has both higher quality and lower measured cost');
select is(pg_temp.frontier_result(4)#>>'{cost,unavailableTrials}','1','one unavailable execution remains in the fixed cost denominator');
select is(pg_temp.frontier_result(4)#>'{cost,meanCostUsd}','null'::jsonb,'an observed subtotal does not become a comparable mean when a cost is missing');
select is(pg_temp.frontier_result(4)->>'status','excluded','the apparently cheapest subtotal with unknown cost cannot win');
select is(pg_temp.frontier_result(5)->>'isRecommended','true','every exact winning tie receives the per-candidate recommendation flag');
select is(pg_temp.read_frontier(p_floor => 10000)#>>'{recommendation,candidates,0,position}','2',
  'a selectable 100 percent threshold changes the global eligible recommendation');
select is(pg_temp.read_frontier(p_minimum => 6)#>>'{recommendation,status}','unavailable',
  'the selectable minimum resolved policy excludes even complete smaller cohorts');
select is(pg_temp.read_frontier(p_limit => 1,p_after => pg_temp.read_frontier(p_limit => 1)#>>'{nextCursor,candidateKey}')#>>'{items,0,position}',
  '2','a bounded page advances by exact frozen candidate position');

select pg_temp.freeze_frontier(81,array[101,102],2);
select pg_temp.configure_frontier(81,4);
select pg_temp.frontier_execute() from generate_series(1,4);
select is(public.reconcile_factory_benchmark_evaluations(100),4,'the next frozen matrix admits its own exact scores');
select pg_temp.frontier_score(p_mixed => true,p_fail_position => 2);
select is(pg_temp.read_frontier(81)#>>'{recommendation,reason}','mixed_judge_profile',
  'a below-floor candidate with another exact judge still prevents an incompatible recommendation');
select is(pg_temp.read_frontier(81,p_floor => 5000)->>'frontierCount','0',
  'changing the floor cannot make mixed judge signatures comparable');
select ok(pg_temp.frontier_result(2,81)->'exclusions' @> '["below_quality_floor","mixed_judge_profile"]'::jsonb,
  'the affected row explains both its below-floor score and the incompatible judge');

select pg_temp.freeze_frontier(83,array[101,102],2);
select pg_temp.configure_frontier(83,4);
select pg_temp.frontier_execute(p_unpriced_position => 2) from generate_series(1,4);
select is(public.reconcile_factory_benchmark_evaluations(100),4,'unpriced executions can still produce exact scores');
select pg_temp.frontier_score(p_mixed => true);
select is(pg_temp.read_frontier(83)#>>'{recommendation,reason}','mixed_judge_profile',
  'a candidate with full scores and missing execution price still participates in judge compatibility');
select ok(pg_temp.frontier_result(2,83)->'exclusions' @> '["unavailable_cost","mixed_judge_profile"]'::jsonb,
  'an unpriced candidate retains its cost and judge exclusions');

create function pg_temp.routing_configuration(p_position integer) returns jsonb language sql as $$
  select jsonb_build_object('agentId',pg_temp.live_id(47),'experimentId',candidate.experiment_id,
    'definitionRevisionId',candidate.definition_revision_id,'qualificationId',candidate.qualification_id,
    'modelKey',candidate.canonical_model_key,'harness',candidate.harness,'workerRuntime',candidate.worker_runtime)
  from public.factory_benchmark_experiment_candidates candidate
  join live_scope scope using(workspace_id,factory_id)
  where candidate.experiment_id = pg_temp.live_id(80) and candidate.comparison_position = p_position;
$$;

create function pg_temp.resolve_frontier_policy(policy jsonb, slug text default 'review')
returns jsonb language plpgsql as $$
declare
  admitted public.session_factory_admission_inputs;
  original public.sessions;
  definition public.factory_definition_revisions;
  document text;
  digest text;
begin
  select * into strict original from public.sessions where id = pg_temp.live_id(44);
  select (base.definition_json::jsonb || jsonb_build_object('modelRouting',policy))::text into strict document
  from public.factory_definition_revisions base where base.id = pg_temp.live_id(43);
  digest := encode(sha256(convert_to(document,'UTF8')),'hex');
  select * into definition from public.factory_definition_revisions stored
  where (stored.workspace_id,stored.factory_id,stored.canonical_digest) = (original.workspace_id,original.factory_id,digest);
  if not found then
    insert into public.factory_definition_revisions(workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
    values(original.workspace_id,original.factory_id,1,document,digest,pg_temp.live_id(1)) returning * into definition;
  end if;
  admitted.workspace_id := original.workspace_id;
  admitted.factory_id := original.factory_id;
  admitted.definition_revision_id := definition.id;
  admitted.definition_digest := definition.canonical_digest;
  admitted.github_repository_id := pg_temp.live_id(42);
  admitted.credential_owner_member_id := pg_temp.live_id(21);
  return internal.resolve_factory_model_routing(admitted,original,slug);
end;
$$;

create temp table frontier_routing_policy as
select jsonb_build_object('version',1,
  'taskClasses',jsonb_build_array(jsonb_build_object('id',pg_temp.live_id(201),'slug','review','name','Review')),
  'rules',jsonb_build_array(jsonb_build_object('id',pg_temp.live_id(202),'taskClassId',pg_temp.live_id(201),
    'configuration',pg_temp.routing_configuration(1),'onUnavailable','{"kind":"escalate"}'::jsonb,
    'constraints','{"qualityFloorBps":8000,"maxMeanCostUsd":0.09,"maxLatencyMs":null,
      "minResolvedTrials":5,"minConfidenceBps":null}'::jsonb)),
  'onUnmatched','{"kind":"escalate"}'::jsonb) as policy;

select set_eq($$
  select fact.* from live_scope scope cross join frontier_scorer scorer
  cross join lateral internal.factory_benchmark_frontier_trial_facts(scope.workspace_id,scope.factory_id,
    pg_temp.live_id(80),scorer.id,pg_temp.frontier_result(1)->>'candidateKey') fact
$$, $$
  select fact.* from live_scope scope cross join frontier_scorer scorer
  cross join lateral internal.factory_benchmark_frontier_trial_facts(scope.workspace_id,scope.factory_id,
    pg_temp.live_id(80),scorer.id) fact
  where fact.candidate_key = pg_temp.frontier_result(1)->>'candidateKey'
$$, 'candidate-scoped evidence matches the existing whole-experiment projection');

select is((select pg_temp.resolve_frontier_policy(policy)->>'reason' from frontier_routing_policy),
  'credential_unavailable','an exact frozen configuration cannot supply a missing current credential');
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values (pg_temp.live_id(1),'platform_api_key','synthetic-routing-key');
select ok((select decision->>'disposition' = 'selected' and decision->>'source' = 'primary'
  and decision->>'benchmarkCandidateKey' = pg_temp.frontier_result(1)->>'candidateKey'
  and decision = pg_temp.resolve_frontier_policy(policy)
  from frontier_routing_policy cross join lateral (select pg_temp.resolve_frontier_policy(policy) as decision) resolved),
  'identical inputs resolve the exact candidate and its measured quality and cost');
select is((select pg_temp.resolve_frontier_policy(policy,'build')->>'reason' from frontier_routing_policy),
  'unmatched_class','unmatched trusted classes follow the explicit escalation');
select is((select pg_temp.resolve_frontier_policy(jsonb_set(policy,'{rules}',
  (policy->'rules') || (policy->'rules')))->>'reason' from frontier_routing_policy),
  'ambiguous_rule','a malformed historical rule conflict escalates without choosing the first rule');
select is((select pg_temp.resolve_frontier_policy(jsonb_set(policy,'{rules,0,configuration,workerRuntime}',
  '"node"'))->>'reason' from frontier_routing_policy),
  'configuration_unavailable','unsupported runtime cannot borrow the exact qualification');
select ok((select decision->>'source' = 'rule_fallback' and decision->>'initialReason' = 'configuration_unavailable'
  and decision->>'benchmarkCandidateKey' = pg_temp.frontier_result(1)->>'candidateKey'
  from frontier_routing_policy cross join lateral (select pg_temp.resolve_frontier_policy(
    jsonb_set(jsonb_set(policy,'{rules,0,configuration,workerRuntime}','"node"'),'{rules,0,onUnavailable}',
      jsonb_build_object('kind','fallback','configuration',pg_temp.routing_configuration(1)))) as decision) resolved),
  'only the configured qualified fallback is considered after a primary failure');
select is((select pg_temp.resolve_frontier_policy(jsonb_set(policy,'{rules,0,configuration}',pg_temp.routing_configuration(4)))
    ->>'reason' from frontier_routing_policy), 'cost_unavailable', 'unmeasured spend cannot qualify a cost-constrained rule');
select is((select pg_temp.resolve_frontier_policy(jsonb_set(policy,'{rules,0,configuration,scorerRevisionId}',
    to_jsonb(pg_temp.live_id(975))))->>'reason' from frontier_routing_policy),
  'evidence_unavailable', 'an explicit scorer must be frozen in the chosen comparison');
select is((select pg_temp.resolve_frontier_policy(jsonb_set(policy,'{rules,0,constraints,minConfidenceBps}','0'))
    ->>'reason' from frontier_routing_policy), 'confidence_unavailable', 'even a zero floor requires a known confidence metric');
select is((select pg_temp.resolve_frontier_policy(jsonb_set(policy,'{rules,0,constraints,qualityFloorBps}','9000'))
    ->>'reason' from frontier_routing_policy), 'threshold_not_met', 'known non-pass executions count against the quality threshold');
delete from public.user_codex_credentials where user_id = pg_temp.live_id(1);
select is((select pg_temp.resolve_frontier_policy(policy)->>'reason' from frontier_routing_policy),
  'credential_unavailable','revoking the credential blocks new shadow selections');

select * from finish();
rollback;
