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

-- Keep these sequential CAS fixtures deterministic if the local VM clock shifts.
create function pg_temp.order_frontier_drafts() returns trigger language plpgsql as $$
begin
  select greatest(new.created_at,max(draft.created_at)+interval '1 microsecond') into new.created_at
  from public.factory_definition_drafts draft
  where (draft.workspace_id,draft.factory_id) = (new.workspace_id,new.factory_id)
    and draft.base_activation_number is not distinct from new.base_activation_number;
  return new;
end;
$$;
create trigger fixture_order_frontier_drafts before insert on public.factory_definition_drafts
for each row when (new.workspace_id = '62300000-0000-4000-9000-000000000011')
execute function pg_temp.order_frontier_drafts();

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
    (base.definition_json::jsonb || jsonb_build_object(
      'operatingRulesMd','Frontier fixture variant ' || slot,
      'agent',(base.definition_json::jsonb->'agent') || jsonb_build_object(
        'effort',case slot when 101 then 'high' when 105 then 'low' end)))::text as config
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

create function pg_temp.freeze_frontier(p_slot integer,p_definitions integer[],p_repetitions integer,
  p_scored boolean default true,p_policy_revision_id uuid default null)
returns jsonb language sql as $$
  with pinned as (
    select jsonb_agg(jsonb_build_object('definitionRevisionId',pg_temp.live_id(revision.slot),
      'qualificationId',pg_temp.live_id(51),'workerRuntime','workerd') order by revision.position) as candidates
    from unnest(p_definitions) with ordinality revision(slot,position)
  )
  select case when p_scored then public.freeze_factory_benchmark_experiment_axes_with_evaluation(
      scope.workspace_id,scope.factory_id,scope.owner_id,pg_temp.live_id(p_slot),suite.id,coalesce(p_policy_revision_id,policy.id),
      pinned.candidates,p_repetitions,211,120000,
      jsonb_build_object('scorerRevisionIds',(select jsonb_agg(id) from frontier_scorer),'budgetLimitUsd',20))
    else public.freeze_factory_benchmark_experiment_axes(scope.workspace_id,scope.factory_id,scope.owner_id,
      pg_temp.live_id(p_slot),suite.id,coalesce(p_policy_revision_id,policy.id),pinned.candidates,p_repetitions,211,120000) end
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

create temp table independent_routing_replay_policy as
select revision.* from live_scope scope cross join live_policy base
cross join lateral public.publish_factory_benchmark_replay_policy(scope.workspace_id,scope.factory_id,
  scope.owner_id,'blocked',base.id) revision;
select pg_temp.freeze_frontier(85,array[101,102],2,p_policy_revision_id=>id) from independent_routing_replay_policy;
select pg_temp.configure_frontier(85,4);
select pg_temp.frontier_execute() from generate_series(1,4);
select public.reconcile_factory_benchmark_evaluations(100);
select pg_temp.frontier_score();

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

insert into public.factory_benchmark_evaluation_dimensions(workspace_id,factory_id,experiment_id,scorer_revision_id)
select scope.workspace_id,scope.factory_id,pg_temp.live_id(80),scorer.id
from live_scope scope cross join lateral public.create_factory_scorer(
  scope.workspace_id,scope.factory_id,scope.owner_id,'Additional quality','additional-quality',
  '{"schemaVersion":1,"rubric":"Inspect another aspect.","requiredEvidence":["artifact"],"scoring":{"kind":"boolean","passValue":true}}') scorer;
select is((select pg_temp.resolve_frontier_policy(policy)->>'reason' from frontier_routing_policy),
  'evidence_unavailable','multiple frozen scorers require an explicit selection');
select is((select pg_temp.resolve_frontier_policy(jsonb_set(policy,'{rules,0,configuration,scorerRevisionId}',
    to_jsonb(scorer.id)))->>'disposition' from frontier_routing_policy cross join frontier_scorer scorer),
  'selected','an explicit frozen scorer resolves when an experiment has multiple scorers');
delete from public.user_codex_credentials where user_id = pg_temp.live_id(1);
select is((select pg_temp.resolve_frontier_policy(policy)->>'reason' from frontier_routing_policy),
  'credential_unavailable','revoking the credential blocks new shadow selections');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '62300000-0000-4000-9000-000000000001';
select is((select count(*) from public.factory_benchmark_evaluation_dimensions
  where experiment_id = '62300000-0000-4000-9000-000000000080'),
  2::bigint,'a factory manager can resolve frozen scorers through the preview client');
set local request.jwt.claim.sub = '62300000-0000-4000-9000-000000000975';
select is((select count(*) from public.factory_benchmark_evaluation_dimensions
  where experiment_id = '62300000-0000-4000-9000-000000000080'),
  0::bigint,'a user outside the factory cannot inspect its frozen scorers');
reset role;

set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

create function pg_temp.apply_routing_finding(
  p_position integer, p_request integer, p_floor integer default 8000,
  p_cost numeric default 0.10, p_suite_id uuid default null, p_expected_draft uuid default null,
  p_activation bigint default 0
) returns uuid language plpgsql as $$
declare
  scope live_scope;
  candidate public.factory_benchmark_experiment_candidates;
  body jsonb;
  scorer_id uuid;
begin
  select * into strict scope from live_scope;
  select * into strict candidate from public.factory_benchmark_experiment_candidates
    where (workspace_id, factory_id, experiment_id, comparison_position) =
      (scope.workspace_id, scope.factory_id, pg_temp.live_id(80), p_position);
  select id into strict scorer_id from frontier_scorer;
  select definition_json::jsonb into strict body from public.factory_definition_revisions
    where id = candidate.definition_revision_id;
  body := body || jsonb_build_object('modelRouting', jsonb_build_object(
    'version', 1,
    'taskClasses', jsonb_build_array(jsonb_build_object('id', pg_temp.live_id(201), 'slug', 'review', 'name', 'Artifact review')),
    'rules', jsonb_build_array(jsonb_build_object('id', pg_temp.live_id(202), 'taskClassId', pg_temp.live_id(201),
      'configuration', jsonb_build_object(
        'agentId', body#>>'{implementationAgent,agentId}', 'definitionRevisionId', candidate.definition_revision_id,
        'experimentId', candidate.experiment_id, 'qualificationId', candidate.qualification_id,
        'scorerRevisionId', scorer_id, 'modelKey', candidate.canonical_model_key,
        'harness', candidate.harness, 'workerRuntime', candidate.worker_runtime
      ), 'constraints', jsonb_build_object('qualityFloorBps', p_floor, 'maxMeanCostUsd', p_cost,
        'minResolvedTrials', 2, 'maxLatencyMs', 120000, 'minConfidenceBps', null),
      'onUnavailable', '{"kind":"escalate"}'::jsonb)),
    'onUnmatched', '{"kind":"escalate"}'::jsonb
  ));
  return (public.save_factory_routing_draft(
    scope.workspace_id, scope.factory_id, scope.owner_id, p_activation, body::text,
    encode(sha256(convert_to(body::text, 'UTF8')), 'hex'), '{"newStageIds":[]}'::jsonb,
    candidate.experiment_id, candidate.candidate_key, coalesce(p_suite_id, (select id from live_suite)),
    scorer_id, pg_temp.live_id(202), pg_temp.live_id(p_request), repeat(p_request::text, 32), p_expected_draft
  )).id;
end;
$$;

select throws_ok($$select pg_temp.apply_routing_finding(1, 11, 9000)$$, 'PT422',
  'The measured pass rate is below the selected quality floor.', 'a low-quality candidate cannot create a draft');
select throws_ok($$select pg_temp.apply_routing_finding(4, 12)$$, 'PT422',
  'The candidate needs measured cost for all comparable trials.', 'a candidate with an unpriced slot cannot create a draft');
select throws_ok($$select pg_temp.apply_routing_finding(1, 13, p_cost => 0.079)$$, 'PT422',
  'The measured mean cost exceeds the selected ceiling.', 'the measured total is checked against the exact decimal limit');
select throws_ok($$select pg_temp.apply_routing_finding(1, 14, p_suite_id => pg_temp.live_id(299))$$, 'PT409',
  'The suite revision changed. Run a new comparison before applying it.', 'a mismatched suite cannot qualify a draft');
select is((select count(*) from public.factory_definition_drafts where workspace_id = pg_temp.live_id(11)),
  0::bigint, 'failed qualifications roll back the written draft');

create temp table routing_apply as select pg_temp.apply_routing_finding(1, 15) as draft_id;
select is(pg_temp.apply_routing_finding(1, 15), (select draft_id from routing_apply),
  'the same request returns the exact immutable draft even after its write moves the draft head');
select ok(exists (
  select 1 from public.factory_routing_draft_evidence receipt
  join routing_apply using (draft_id)
  where receipt.evidence @> jsonb_build_object('ruleId', pg_temp.live_id(202),
    'experimentId', pg_temp.live_id(80), 'candidateKey', pg_temp.frontier_result(1)->>'candidateKey',
    'scorerRevisionId', (select id from frontier_scorer), 'qualityPassRateBps', 8000,
    'resolvedTrials', 5, 'measuredMeanCostUsd', '0.08', 'suite', jsonb_build_object('revisionId', (select id from live_suite)))
), 'the saved draft retains exact frozen evidence and measured tradeoffs');
select is((select count(*) from public.factory_definition_activations where workspace_id = pg_temp.live_id(11)),
  0::bigint, 'applying a benchmark finding does not activate a policy');
insert into public.workspace_sandbox_connection_mutations(workspace_id, provider)
  values (pg_temp.live_id(11), 'vercel');
select throws_ok($$select pg_temp.apply_routing_finding(1, 17, p_expected_draft => (select draft_id from routing_apply))$$,
  'PT409', 'The sandbox connection is being updated. Retry after the change finishes.',
  'an unexpired sandbox rotation reservation blocks new routing drafts');
select is(pg_temp.apply_routing_finding(1, 15), (select draft_id from routing_apply),
  'an idempotent retry returns its frozen receipt during a sandbox rotation');
delete from public.workspace_sandbox_connection_mutations where workspace_id = pg_temp.live_id(11);
update public.github_installations set suspended = true where workspace_id = pg_temp.live_id(11);
select throws_ok($$select pg_temp.apply_routing_finding(1, 18, p_expected_draft => (select draft_id from routing_apply))$$,
  'PT409', 'The factory writer repository or installation is unavailable.',
  'a suspended writer installation blocks new routing drafts');
update public.github_installations set suspended = false where workspace_id = pg_temp.live_id(11);
select throws_ok($$update public.factory_routing_draft_evidence set evidence = '{}'::jsonb$$, '23514',
  'Factory definition records are immutable.', 'a frozen benchmark receipt cannot be edited');
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '62300000-0000-4000-9000-000000000099';
select is((select count(*) from public.factory_routing_draft_evidence where workspace_id = pg_temp.live_id(11)),
  0::bigint, 'receipt evidence is private to the factory');
reset role;
set local request.jwt.claim.role = 'service_role';

insert into auth.users(id,email) values (pg_temp.live_id(2),'routing-inspector-reader@example.test');
insert into public.workspace_members(id,workspace_id,user_id,kind,role)
values (pg_temp.live_id(22),pg_temp.live_id(11),pg_temp.live_id(2),'human','member');
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values (pg_temp.live_id(1),'platform_api_key','synthetic-routing-key');

create function pg_temp.preview_frontier_routing(
  p_slug text default 'review', p_activation bigint default 0, p_draft_id uuid default null,
  p_actor uuid default pg_temp.live_id(1)
) returns jsonb language sql as $$
  select public.preview_factory_model_routing(scope.workspace_id,scope.factory_id,p_actor,p_activation,
    coalesce(p_draft_id, applied.draft_id),p_slug)
  from live_scope scope cross join routing_apply applied;
$$;
create temp table before_routing_preview as
select count(*) as sessions from public.sessions where workspace_id = pg_temp.live_id(11);
create temp table frontier_preview as select pg_temp.preview_frontier_routing() as result;
select ok((select result->>'draftDigest'=draft.canonical_digest and result->>'draftId'=draft.id::text
    and result#>>'{decision,disposition}'='selected' and result#>>'{decision,source}'='primary'
    and not (result->'decision' ? 'policyRevisionId')
  from frontier_preview cross join routing_apply
  join public.factory_definition_drafts draft on draft.id=routing_apply.draft_id),
  'preview resolves the exact saved draft without inventing published provenance');
select is(pg_temp.preview_frontier_routing('build')#>>'{decision,reason}','unmatched_class',
  'preview explains the unmatched task class');
select is(pg_temp.preview_frontier_routing(null)#>>'{decision,reason}','unmatched_class',
  'preview can exercise a missing task class');
select is(pg_temp.preview_frontier_routing(repeat('a',64))#>>'{decision,reason}','unmatched_class',
  'preview accepts the maximum production stage slug length');
delete from public.user_codex_credentials where user_id=pg_temp.live_id(1);
select is(pg_temp.preview_frontier_routing()#>>'{decision,reason}','credential_unavailable',
  'preview uses current credentials for the requesting manager');
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values (pg_temp.live_id(1),'platform_api_key','synthetic-routing-key');
select is((select count(*) from public.sessions where workspace_id = pg_temp.live_id(11)),
  (select sessions from before_routing_preview),'preview creates no session');
select throws_ok($$select pg_temp.preview_frontier_routing(p_activation => 1)$$, 'PT409',null,
  'preview rejects a stale activation');
select throws_ok($$select pg_temp.preview_frontier_routing(p_draft_id => pg_temp.live_id(299))$$, 'PT409',null,
  'preview rejects a stale draft');
select throws_ok($$select pg_temp.preview_frontier_routing(p_actor => pg_temp.live_id(2))$$, '42501',null,
  'preview requires a workspace manager even when the caller is the service');
select ok(not has_function_privilege('authenticated','public.preview_factory_model_routing(uuid,uuid,uuid,bigint,uuid,text)','EXECUTE')
  and has_function_privilege('service_role','public.preview_factory_model_routing(uuid,uuid,uuid,bigint,uuid,text)','EXECUTE'),
  'direct draft preview is service-only');

create function pg_temp.save_frontier_routing_edit(
  p_source_draft_id uuid, p_path text[], p_value jsonb, p_activation bigint, p_expected_draft_id uuid
) returns uuid language sql as $$
  select (public.save_settings_factory_definition_draft(source.workspace_id, source.factory_id, source.created_by,
    p_activation, edited.body, encode(sha256(convert_to(edited.body,'UTF8')),'hex'),
    source.settings_metadata, p_expected_draft_id)).id
  from public.factory_definition_drafts source
  cross join lateral (select jsonb_set(source.definition_json::jsonb,p_path,p_value)::text as body) edited
  where source.id = p_source_draft_id
$$;
create temp table renamed_routing_draft as
select pg_temp.save_frontier_routing_edit(draft_id,'{modelRouting,taskClasses,0,name}','"Reviewed work"',0,draft_id) as draft_id
from routing_apply;
select is((select draft.routing_evidence_source_draft_id from public.factory_definition_drafts draft
  join renamed_routing_draft renamed on renamed.draft_id = draft.id),
  (select draft_id from routing_apply), 'renaming a class in settings retains the original routing proposal');
create temp table published_routing_draft as
select pg_temp.save_frontier_routing_edit(draft_id,'{modelRouting,taskClasses,0,name}','"Reviewed output"',0,draft_id) as draft_id
from renamed_routing_draft;
select is((select draft.routing_evidence_source_draft_id from public.factory_definition_drafts draft
  join published_routing_draft edited on edited.draft_id = draft.id),
  (select draft_id from routing_apply), 'successive label edits link directly to the original proposal');
select is((select count(*) from public.factory_routing_draft_evidence where workspace_id = pg_temp.live_id(11)),
  1::bigint, 'saving a normal draft leaves the original evidence row intact');

-- Publication mechanics have their own fixture. Use its exact source-draft pin
-- here to compare preview with real admission and the production run RPCs.
insert into public.factory_definition_revisions(id,workspace_id,factory_id,source_draft_id,schema_version,definition_json,canonical_digest,created_by)
select pg_temp.live_id(300),draft.workspace_id,draft.factory_id,draft.id,draft.schema_version,
  draft.definition_json,draft.canonical_digest,draft.created_by
from public.factory_definition_drafts draft join published_routing_draft edited on edited.draft_id=draft.id;
insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,id,1,created_by from public.factory_definition_revisions where id=pg_temp.live_id(300);
select public.set_git_continuity_release(true,revision,'Routing inspector fixture')
from public.get_git_continuity_release_state() where not enabled;
insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select pg_temp.live_id(11),max(number) from public.sessions where workspace_id=pg_temp.live_id(11)
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);
create temp table inspected_routing_run as
select * from public.create_session_with_first_job(pg_temp.live_id(11),pg_temp.live_id(21),
  'Inspect exact routing evidence','Review a fixture task.','codex','gpt-4.1-2025-04-14',
  session_github_repository_id => pg_temp.live_id(42), selected_pipeline_id => pg_temp.live_id(40),
  selected_stage_ids => array[pg_temp.live_id(41)]);
select is((select receipt.routing_decision - array['mode','policyRevisionId','policyDigest']
  from public.session_factory_admission_inputs receipt join inspected_routing_run using(session_id)),
  (select result->'decision' from frontier_preview), 'preview and admission resolve identical inputs to the same complete decision');
update public.agent_jobs set status='running',attempt_count=1,
  git_continuity_release_revision=(select revision from public.get_git_continuity_release_state())
where id=(select job_id from inspected_routing_run);
select is(public.start_session_job_attempt(job_id,1,pg_temp.live_id(41),0,
  'codex','gpt-4.1-2025-04-14','project','wallie/routing-inspector'),run_id,'the inspected run starts') from inspected_routing_run;
select public.pin_session_job_git_input(job_id,1,run_id,pg_temp.live_id(42),'main',repeat('a',40)) from inspected_routing_run;
select ok(public.pin_session_attempt_manifest(job_id,run_id,1,repeat('a',64),24,3,repeat('a',40),'[]',
  'workerd',null,null,pg_temp.live_id(21)), 'the inspected run pins the original admission receipt') from inspected_routing_run;

create temp table post_publish_routing_draft as
select pg_temp.save_frontier_routing_edit(draft_id,'{modelRouting,taskClasses,0,name}','"Next revision label"',1,null) as draft_id
from published_routing_draft;
select is((select draft.routing_evidence_source_draft_id from public.factory_definition_drafts draft
  join post_publish_routing_draft edited on edited.draft_id = draft.id),
  (select draft_id from routing_apply),'the first edit after publication follows the exact published source draft');
create temp table edited_fallback_routing_draft as
select pg_temp.save_frontier_routing_edit(draft_id,'{modelRouting,rules,0,onUnavailable}',
  jsonb_build_object('kind','fallback','configuration',pg_temp.routing_configuration(2)),1,draft_id) as draft_id
from post_publish_routing_draft;
select is((select draft.routing_evidence_source_draft_id from public.factory_definition_drafts draft
  join edited_fallback_routing_draft edited on edited.draft_id = draft.id),
  (select draft_id from routing_apply),'changing the unavailable-primary action preserves its benchmark proposal');
create temp table changed_constraints_routing_draft as
select pg_temp.save_frontier_routing_edit(draft_id,'{modelRouting,rules,0,constraints,maxMeanCostUsd}','0.11',1,draft_id) as draft_id
from edited_fallback_routing_draft;
select is((select draft.routing_evidence_source_draft_id from public.factory_definition_drafts draft
  join changed_constraints_routing_draft edited on edited.draft_id = draft.id),
  null::uuid,'a material constraint edit drops the inherited proposal');
create temp table restored_constraints_routing_draft as
select pg_temp.save_frontier_routing_edit(draft_id,'{modelRouting,rules,0,constraints,maxMeanCostUsd}','0.10',1,draft_id) as draft_id
from changed_constraints_routing_draft;
select is((select draft.routing_evidence_source_draft_id from public.factory_definition_drafts draft
  join restored_constraints_routing_draft edited on edited.draft_id = draft.id),
  null::uuid,'restoring older constraints cannot reacquire a discarded proposal');

insert into public.factory_definition_revisions(id,workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
select pg_temp.live_id(301),prior.workspace_id,prior.factory_id,prior.schema_version,changed.body,
  encode(sha256(convert_to(changed.body,'UTF8')),'hex'),prior.created_by
from public.factory_definition_revisions prior cross join lateral (
  select jsonb_set(prior.definition_json::jsonb,'{modelRouting,taskClasses,0,name}','"Renamed review"')::text as body
) changed where prior.id=pg_temp.live_id(300);
insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,id,2,created_by from public.factory_definition_revisions where id=pg_temp.live_id(301);

grant select on inspected_routing_run to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '62300000-0000-4000-9000-000000000001';
select ok((select value->>'taskClassName'='Reviewed output' and value->'canManageFactory'='true'::jsonb
    and value#>>'{decision,policyRevisionId}'=pg_temp.live_id(300)::text
    and value#>>'{benchmarkEvidence,taskClassName}'='Artifact review'
    and value#>>'{benchmarkEvidence,ruleId}'=pg_temp.live_id(202)::text
  from inspected_routing_run run cross join lateral (select public.get_run_routing_decision(pg_temp.live_id(11),run.run_id,1) as value) result),
  'a manager sees the pinned class name and the original inherited proposal after a later rename');
select is(public.get_run_routing_decision(pg_temp.live_id(11),run_id,2),null::jsonb,
  'a different attempt cannot borrow the routing receipt') from inspected_routing_run;
select is(public.get_run_routing_decision(gen_random_uuid(),run_id,1),null::jsonb,
  'a different workspace cannot borrow the routing receipt') from inspected_routing_run;
select is(public.get_run_routing_decision(pg_temp.live_id(11),pg_temp.live_id(46),1),null::jsonb,
  'a historical run without a decision is unrecorded');
set local request.jwt.claim.sub = '62300000-0000-4000-9000-000000000002';
select ok((select value->>'taskClassName'='Reviewed output' and value->'canManageFactory'='false'::jsonb
    and value->'benchmarkEvidence'='null'::jsonb
  from inspected_routing_run run cross join lateral (select public.get_run_routing_decision(pg_temp.live_id(11),run.run_id,1) as value) result),
  'a factory reader sees the original decision without manager-only benchmark evidence');
set local request.jwt.claim.sub = '62300000-0000-4000-9000-000000000975';
select is(public.get_run_routing_decision(pg_temp.live_id(11),run_id,1),null::jsonb,
  'an outsider cannot read the routing decision') from inspected_routing_run;
reset role;

set local request.jwt.claim.role = 'service_role';
create temp table unrouted_preview_draft as
select (public.save_factory_definition_draft(revision.workspace_id,revision.factory_id,revision.created_by,2,
  revision.definition_json,revision.canonical_digest)).id as id
from public.factory_definition_revisions revision where revision.id=pg_temp.live_id(43);
select is(pg_temp.preview_frontier_routing(p_activation => 2,p_draft_id => (select id from unrouted_preview_draft))->'decision',
  'null'::jsonb,'a current draft without routing has no preview decision');

insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,id,3,created_by from public.factory_definition_revisions where id=pg_temp.live_id(300);
create temp table changed_configuration_routing_draft as
select pg_temp.save_frontier_routing_edit(draft_id,'{modelRouting,rules,0,configuration,workerRuntime}','"node"',3,null) as draft_id
from published_routing_draft;
select is((select draft.routing_evidence_source_draft_id from public.factory_definition_drafts draft
  join changed_configuration_routing_draft edited on edited.draft_id = draft.id),
  null::uuid,'a primary configuration change drops evidence even from an exact published base');

create temp table review_proposal as
select pg_temp.apply_routing_finding(1,19,p_expected_draft => draft_id,p_activation => 3) as draft_id
from changed_configuration_routing_draft;
create temp table review_candidate as
select pg_temp.save_frontier_routing_edit(draft_id,'{modelRouting,rules,0,onUnavailable}',
  jsonb_build_object('kind','fallback','configuration',pg_temp.routing_configuration(5)
    || jsonb_build_object('scorerRevisionId',(select id from frontier_scorer))),3,draft_id) as draft_id
from review_proposal;
insert into public.sandbox_capability_checks(workspace_id,github_repository_id,agent_provider,agent_model,
  sandbox_provider,sandbox_id,sandbox_connection_revision,sandbox_vercel_team_id,sandbox_vercel_project_id,status,
  capabilities,factory_definition_digest)
select capability.workspace_id,capability.github_repository_id,capability.agent_provider,capability.agent_model,
  capability.sandbox_provider,capability.sandbox_id,capability.sandbox_connection_revision,
  capability.sandbox_vercel_team_id,capability.sandbox_vercel_project_id,capability.status,
  capability.capabilities,draft.canonical_digest
from public.sandbox_capability_checks capability cross join review_candidate review
join public.factory_definition_drafts draft on draft.id=review.draft_id where capability.id=pg_temp.live_id(51);
create function pg_temp.activate_reviewed_routing(p_expected bigint, p_actor uuid default pg_temp.live_id(1))
returns jsonb language sql as $$
  select public.activate_reviewed_factory_routing(scope.workspace_id,scope.factory_id,p_actor,p_expected,
    review.draft_id,array['vercel'],array['agentCli']) from live_scope scope cross join review_candidate review
$$;
select throws_ok($$select pg_temp.activate_reviewed_routing(3,pg_temp.live_id(2))$$, '42501', null,
  'a factory viewer cannot activate the reviewed proposal');
select throws_ok($$select pg_temp.activate_reviewed_routing(3)$$, 'PT422',
  'A current passing smoke test is required for the exact factory candidate.',
  'reviewed activation keeps the existing exact candidate smoke gate');
insert into public.factory_definition_smoke_tests(workspace_id,factory_id,target_kind,target_id,definition_digest,
  base_activation_number,sandbox_connection_revision,created_by,lease_expires_at,finished_at,status,evidence)
select draft.workspace_id,draft.factory_id,'draft',draft.id,draft.canonical_digest,3,pg_temp.live_id(50),draft.created_by,
  clock_timestamp()+interval '5 minutes',clock_timestamp(),'passed','{"runtimeProfile":"vercel"}'
from public.factory_definition_drafts draft join review_candidate review on review.draft_id=draft.id;
create temp table reviewed_activation as select pg_temp.activate_reviewed_routing(3) as result;
select ok((select result->>'activationNumber' = '4' and result->>'previousActivationNumber' = '3'
  and result->>'previousRevisionId' = pg_temp.live_id(300)::text and result->>'createdAt' is not null from reviewed_activation),
  'reviewed activation appends the exact candidate and previous head');
select is((select benchmark_evidence_draft_id from public.factory_routing_activations where workspace_id=pg_temp.live_id(11)),
  (select draft_id from review_proposal),'activation pins the original immutable proposal underneath the edited draft');
select throws_ok($$select pg_temp.activate_reviewed_routing(3)$$, 'PT409', null,
  'a competing writer with the same expected head cannot activate');

create function pg_temp.create_reviewed_override(p_request integer, p_reason text,
  p_member uuid default pg_temp.live_id(21), p_rule uuid default pg_temp.live_id(202), p_activation bigint default 4)
returns table(session_id uuid,session_number integer,workspace_slug text,job_id uuid,run_id uuid)
language sql as $$
  select accepted.* from live_scope scope cross join reviewed_activation reviewed
  cross join lateral public.create_session_command_with_routing_override(scope.workspace_id,p_member,pg_temp.live_id(p_request),
    repeat('a',64),reviewed.result->>'draftDigest','Choose exact routing','Use the reviewed fixture task.',
    'codex','gpt-4.1-2025-04-14','{}'::uuid[],
    jsonb_build_object('expectedActivationNumber',p_activation,'ruleId',p_rule,'target','rule_fallback','reason',p_reason),
    session_github_repository_id=>pg_temp.live_id(42), selected_pipeline_id=>pg_temp.live_id(40),
    selected_stage_ids=>array[pg_temp.live_id(41)], target_factory_id=>scope.factory_id) accepted
$$;
select throws_ok($$select pg_temp.create_reviewed_override(320,'Owner required',pg_temp.live_id(22))$$, '42501', null,
  'an ordinary factory member cannot add a one-task override');
select throws_ok($$select pg_temp.create_reviewed_override(320,'Old policy',p_activation=>3)$$, 'PT409', null,
  'a one-task override requires the exact current reviewed activation');
select throws_ok($$select pg_temp.create_reviewed_override(320,'Wrong class',p_rule=>pg_temp.live_id(299))$$, 'PT422', null,
  'a one-task override cannot use a rule outside the trusted task class');
create temp table reviewed_active_run as
select * from public.create_session_with_first_job(pg_temp.live_id(11),pg_temp.live_id(21),
  'New automatic routing','Review a fixture task.','codex','gpt-4.1-2025-04-14',
  session_github_repository_id=>pg_temp.live_id(42), selected_pipeline_id=>pg_temp.live_id(40),
  selected_stage_ids=>array[pg_temp.live_id(41)]);
select ok((select admission.routing_decision->>'mode'='active'
  and admission.routing_execution->>'benchmarkCandidateKey'=pg_temp.frontier_result(1)->>'candidateKey'
  and admission.routing_execution->>'modelName'='gpt-4.1-2025-04-14'
  and admission.routing_execution#>>'{implementationAgent,promptRevisionId}'=pg_temp.live_id(48)::text
  from public.session_factory_admission_inputs admission join reviewed_active_run using(session_id)),
  'a new admission pins the reviewed recommendation and exact executable profile');
select is((select admission.routing_execution->>'effort'
  from public.session_factory_admission_inputs admission join reviewed_active_run using(session_id)),
  'high','the automatic admission pins the selected Codex reasoning effort');
select ok((select admission.routing_decision->>'mode'='shadow' and admission.routing_execution is null
  from public.session_factory_admission_inputs admission join inspected_routing_run using(session_id)),
  'the earlier admission stays pinned in shadow mode after reviewed activation');
create temp table reviewed_override_run as select * from pg_temp.create_reviewed_override(321,'Use the exact alternate.');
select is((select session_id from pg_temp.create_reviewed_override(321,'Use the exact alternate.')),
  (select session_id from reviewed_override_run),'retrying the same one-task override returns its original session');
select throws_ok($$select pg_temp.create_reviewed_override(321,'Different reason.')$$, 'P0005', null,
  'a replay cannot replace the authorized override reason');
select ok((select admission.routing_decision->>'benchmarkCandidateKey'=pg_temp.frontier_result(1)->>'candidateKey'
  and override.routing_execution->>'benchmarkCandidateKey'=pg_temp.frontier_result(5)->>'candidateKey'
  and override.actor_member_id=pg_temp.live_id(21) and override.reason='Use the exact alternate.'
  from public.session_factory_admission_inputs admission join reviewed_override_run using(session_id)
  join public.session_factory_routing_overrides override using(session_id)),
  'the override records its actor, reason and target without replacing the recommendation');
select is((select public.get_session_factory_routing_execution(scope.workspace_id,scope.factory_id,run.session_id)
  ->>'benchmarkCandidateKey' from live_scope scope cross join reviewed_override_run run),
  pg_temp.frontier_result(5)->>'candidateKey','the worker reads the authorized alternate as its effective pin');
select is((select public.get_session_factory_routing_execution(scope.workspace_id,scope.factory_id,run.session_id)
  ->>'effort' from live_scope scope cross join reviewed_override_run run),
  'low','the override pins the alternate Codex effort independently of the workflow effort');
select throws_ok($$update public.session_factory_routing_overrides set reason='Unapproved change'$$,'23514',null,
  'the one-task override is immutable');
select public.grant_factory_membership(scope.workspace_id,scope.factory_id,scope.owner_id,pg_temp.live_id(21),'member')
from live_scope scope;
update public.workspace_members set role='owner' where id=pg_temp.live_id(22);
update public.workspace_members set role='member' where id=pg_temp.live_id(21);
select is((select session_id from pg_temp.create_reviewed_override(321,'Use the exact alternate.')),
  (select session_id from reviewed_override_run),'a still-authorized member can replay their own committed override');
select throws_ok($$select pg_temp.create_reviewed_override(323,'New unapproved override.')$$,'42501',null,
  'replay permission does not authorize a fresh override after demotion');
update public.workspace_members set role='owner' where id=pg_temp.live_id(21);
update public.workspace_members set role='member' where id=pg_temp.live_id(22);
create temp table ordinary_reviewed_command as
select accepted.* from live_scope scope cross join reviewed_activation reviewed
cross join lateral public.create_session_command_once(scope.workspace_id,pg_temp.live_id(21),pg_temp.live_id(324),
  repeat('a',64),reviewed.result->>'draftDigest','Choose exact routing','Use the reviewed fixture task.',
  'codex','gpt-4.1-2025-04-14','{}'::uuid[],session_github_repository_id=>pg_temp.live_id(42),
  selected_pipeline_id=>pg_temp.live_id(40),selected_stage_ids=>array[pg_temp.live_id(41)],
  target_factory_id=>scope.factory_id) accepted;
select throws_ok($$select pg_temp.create_reviewed_override(324,'Do not change a committed task.')$$,'P0005',null,
  'a replay cannot retrofit an override onto an ordinary committed creation');
update public.agent_jobs set scheduled_at=clock_timestamp()+interval '1 hour'
where id=(select job_id from ordinary_reviewed_command);
delete from public.user_codex_credentials where user_id=pg_temp.live_id(1);
select throws_ok($$select pg_temp.create_reviewed_override(322,'Missing credential.')$$,'PT422',
  'The reviewed routing policy escalated this task (credential_unavailable)',
  'an unavailable reviewed route escalates without granting a baseline or override execution');
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values (pg_temp.live_id(1),'platform_api_key','synthetic-routing-key');

-- Worker enforcement assertions

update public.agent_jobs set created_at = '-infinity'
where id=(select job_id from reviewed_active_run);
create temp table reviewed_node_claim as
select id from public.claim_next_agent_job(false, 2, 'node');
select ok((select job.status = 'queued' and job.attempt_count = 0 and job.claimed_worker_runtime is null
  from public.agent_jobs job join reviewed_active_run target on job.id=target.job_id),
  'a Node worker leaves a Workerd routing claim queued without spending an attempt');
create temp table reviewed_workerd_claim as
select * from public.claim_next_worker_dispatch(false,100,2,1800000);
select ok((select job.status='running' and job.attempt_count=1 and job.claimed_worker_runtime='workerd'
  from reviewed_workerd_claim dispatch join reviewed_active_run target using(job_id)
  join public.agent_jobs job on job.id=target.job_id and job.attempt_count=dispatch.attempt_count),
  'the Workerd dispatcher acquires the routed job and its exact runtime');
select throws_ok($$select public.start_session_job_attempt(job_id,1,pg_temp.live_id(41),0,
  'codex','gpt-5.5','project','wallie/routed') from reviewed_active_run$$,
  '23514','The claimed attempt does not match the pinned routing configuration.',
  'attempt start refuses a model other than the admitted native model');
select is(public.start_session_job_attempt(job_id,1,pg_temp.live_id(41),0,
  'codex','gpt-4.1-2025-04-14','project','wallie/routed'),run_id,
  'the exact routed attempt starts against its original base stage') from reviewed_active_run;
select public.pin_session_job_git_input(job_id,1,run_id,pg_temp.live_id(42),'main',repeat('a',40))
from reviewed_active_run;
update public.agent_runs set sandbox_provider='vercel',sandbox_connection_revision=pg_temp.live_id(50),
  sandbox_id='sbx_reviewed_worker',sandbox_vercel_team_id='team_live',sandbox_vercel_project_id='prj_live'
where id=(select run_id from reviewed_active_run);
select throws_ok($$select public.pin_session_attempt_manifest(job_id,run_id,1,repeat('b',64),24,3,
  repeat('a',40),'[]','node',null,'high',pg_temp.live_id(21)) from reviewed_active_run$$,
  '23514','The attempt manifest does not match the pinned routing configuration.',
  'a manifest from the wrong runtime cannot authorize this attempt');
update public.agent_runs set sandbox_connection_revision=pg_temp.live_id(299)
where id=(select run_id from reviewed_active_run);
select throws_ok($$select public.pin_session_attempt_manifest(job_id,run_id,1,repeat('b',64),24,3,
  repeat('a',40),'[]','workerd',null,'high',pg_temp.live_id(21)) from reviewed_active_run$$,
  '23514','The attempt manifest does not match the pinned routing configuration.',
  'a manifest from a different sandbox connection cannot authorize this attempt');
update public.agent_runs set sandbox_connection_revision=pg_temp.live_id(50)
where id=(select run_id from reviewed_active_run);
select throws_ok($$select public.pin_session_attempt_manifest(job_id,run_id,1,repeat('b',64),24,3,
  repeat('a',40),'[]','workerd',null,'xhigh',pg_temp.live_id(21)) from reviewed_active_run$$,
  '23514','The attempt manifest does not match the pinned routing configuration.',
  'the unqualified default effort cannot replace the exact benchmarked effort');
select ok(public.pin_session_attempt_manifest(job_id,run_id,1,repeat('b',64),24,3,
  repeat('a',40),'[]','workerd',null,'high',pg_temp.live_id(21)),
  'the exact runtime, sandbox connection, and effort pin the manifest') from reviewed_active_run;
select ok((select manifest.routing_decision_session_id=target.session_id
    and manifest.definition_revision_id=admission.definition_revision_id
    and manifest.model_name=admission.routing_execution->>'modelName'
    and manifest.agent_effort=admission.routing_execution->>'effort'
    and run.agent_prompt_revision_id::text=admission.routing_execution#>>'{implementationAgent,promptRevisionId}'
  from reviewed_active_run target join public.session_attempt_manifests manifest using(run_id)
  join public.session_factory_admission_inputs admission on admission.session_id=target.session_id
  join public.agent_runs run on run.id=target.run_id),
  'attempt provenance preserves the base workflow and the qualified model/prompt together');
select is(public.fail_session_job_attempt(job_id,1,'Repeat routing proof',false,0,run_id),'error',
  'the exact routed attempt can retire normally') from reviewed_active_run;
create temp table reviewed_manual_retry as
select next.* from reviewed_active_run original cross join lateral public.enqueue_session_job_with_run(
  original.session_id,pg_temp.live_id(11),pg_temp.live_id(41),pg_temp.live_id(21),'manual_retry',
  'cursor','unrelated-model','project') as next;
select ok((select retry.created and (run.model_provider,run.model_name,run.agent_prompt_revision_id) =
    ('codex','gpt-4.1-2025-04-14',pg_temp.live_id(48))
  from reviewed_manual_retry retry join public.agent_runs run on run.id=retry.run_id),
  'a manual retry stamps the original routed execution identity over unrelated defaults');

create temp table canary_review_source as
select scope.*, existing.revision_id, (existing.result->>'activationNumber')::bigint as activation_number,
  (jsonb_set(
    jsonb_set(revision.definition_json::jsonb,'{modelRouting,rules,0,configuration}',
      pg_temp.routing_configuration(5) || jsonb_build_object('scorerRevisionId',(select id from frontier_scorer))),
    '{modelRouting,rules,0,onUnavailable}',jsonb_build_object('kind','fallback','configuration',
      pg_temp.routing_configuration(1) || jsonb_build_object('scorerRevisionId',(select id from frontier_scorer)))))::text as body
from live_scope scope cross join lateral (
  select result,(result->>'revisionId')::uuid as revision_id from reviewed_activation
) existing
join public.factory_definition_revisions revision on revision.id=existing.revision_id;
create temp table canary_review_draft as
select (public.save_factory_routing_draft(source.workspace_id,source.factory_id,source.owner_id,source.activation_number,
  source.body,encode(sha256(convert_to(source.body,'UTF8')),'hex'),'{"newStageIds":[]}'::jsonb,
  pg_temp.live_id(80),pg_temp.frontier_result(5)->>'candidateKey',(select id from live_suite),
  (select id from frontier_scorer),pg_temp.live_id(202),pg_temp.live_id(601),repeat('b',64),null)).id as draft_id
from canary_review_source source;
create function pg_temp.seed_canary_activation_checks(p_draft_id uuid, p_base bigint, p_probe_id uuid default pg_temp.live_id(51))
returns void language plpgsql as $$
begin
  insert into public.sandbox_capability_checks(workspace_id,github_repository_id,agent_provider,agent_model,
    sandbox_provider,sandbox_id,sandbox_connection_revision,sandbox_vercel_team_id,sandbox_vercel_project_id,status,
    capabilities,factory_definition_digest)
  select capability.workspace_id,capability.github_repository_id,capability.agent_provider,capability.agent_model,
    capability.sandbox_provider,capability.sandbox_id,capability.sandbox_connection_revision,
    capability.sandbox_vercel_team_id,capability.sandbox_vercel_project_id,capability.status,
    capability.capabilities,draft.canonical_digest
  from public.sandbox_capability_checks capability cross join public.factory_definition_drafts draft
  where (capability.id,draft.id) = (p_probe_id,p_draft_id);
  insert into public.factory_definition_smoke_tests(workspace_id,factory_id,target_kind,target_id,definition_digest,
    base_activation_number,sandbox_connection_revision,created_by,lease_expires_at,finished_at,status,evidence)
  select draft.workspace_id,draft.factory_id,'draft',draft.id,draft.canonical_digest,p_base,pg_temp.live_id(50),draft.created_by,
    clock_timestamp()+interval '5 minutes',clock_timestamp(),'passed','{"runtimeProfile":"vercel"}'
  from public.factory_definition_drafts draft where draft.id=p_draft_id;
end;
$$;
create function pg_temp.activate_routing_canary(
  p_expected bigint, p_draft_id uuid, p_class uuid default pg_temp.live_id(201), p_bps integer default 5000
) returns jsonb language sql as $$
  select public.activate_factory_routing_canary(scope.workspace_id,scope.factory_id,scope.owner_id,p_expected,
    p_draft_id,array['vercel'],array['agentCli'],p_class,p_bps) from live_scope scope
$$;
create temp table incompatible_canary_draft as
select pg_temp.save_frontier_routing_edit(draft_id,'{agent,concurrencyLimit}','3',4,draft_id) as draft_id from canary_review_draft;
select pg_temp.seed_canary_activation_checks(draft_id,4) from incompatible_canary_draft;
select throws_ok($$select pg_temp.activate_routing_canary(4,draft_id) from incompatible_canary_draft$$,
  'PT422','A routing canary requires the same workflow and base execution profile as its baseline.',
  'a reviewed candidate cannot start a canary with a materially different base workflow');
update canary_review_draft
set draft_id=pg_temp.save_frontier_routing_edit(incompatible.draft_id,'{agent,concurrencyLimit}','2',4,incompatible.draft_id)
from incompatible_canary_draft incompatible;
select pg_temp.seed_canary_activation_checks(draft_id,4) from canary_review_draft;
select throws_ok($$select pg_temp.activate_routing_canary(4,draft_id,p_bps=>10000) from canary_review_draft$$,
  '22023',null,'a canary cannot silently start with every task assigned to the candidate');
select throws_ok($$select pg_temp.activate_routing_canary(4,draft_id,pg_temp.live_id(299)) from canary_review_draft$$,
  'PT422',null,'canary designation requires the reviewed benchmark rule for the admitted task class');
select is((select max(activation_number) from public.factory_definition_activations where workspace_id=pg_temp.live_id(11)),
  4::bigint,'rejected canary designation leaves no broad reviewed activation behind');
create temp table routing_canary_rollout as
select pg_temp.activate_routing_canary(4,draft_id) as result from canary_review_draft;
select ok((select canary.activation_number=5 and canary.baseline_activation_number=4 and canary.candidate_bps=5000
  and canary.minimum_support=5 and canary.candidate_revision_id=(result->>'revisionId')::uuid
  and canary.baseline_revision_id=(result->>'previousRevisionId')::uuid
  from public.factory_routing_canaries canary cross join routing_canary_rollout),
  'one reviewed designation pins the exact baseline, candidate, class allocation and support');
select throws_ok($$select pg_temp.activate_routing_canary(4,draft_id) from canary_review_draft$$,'PT409',null,
  'another writer using the old expected head cannot replace the canary');

-- Select exact participant IDs for both arms to avoid a probabilistic test.
create temp table routing_canary_test_sessions as
select distinct on (arm) participant.session_id, assignment.arm, assignment.bucket
from public.factory_routing_canaries canary
cross join lateral (select pg_temp.live_id(slot) as session_id from generate_series(701,1000) slot) participant
cross join lateral (select internal.factory_routing_canary_bucket(canary,participant.session_id) as bucket) hashed
cross join lateral (select case when hashed.bucket<canary.candidate_bps then 'candidate' else 'baseline' end as arm,hashed.bucket) assignment
order by arm,participant.session_id;
insert into public.sessions(id,workspace_id,factory_id,number,title,prompt_md,creator_member_id,pipeline_id,current_stage_id,
  github_repository_id,execute_pinned_definition,factory_definition_provenance,factory_definition_revision_id,phase_status)
select assigned.session_id,canary.workspace_id,canary.factory_id,9000+row_number() over (), 'Run exact canary branch',
  'Review the same fixture task.',pg_temp.live_id(21),pg_temp.live_id(40),pg_temp.live_id(41),pg_temp.live_id(42),
  true,'pinned',canary.candidate_revision_id,'in_progress'
from routing_canary_test_sessions assigned cross join public.factory_routing_canaries canary;
insert into public.session_factory_admission_inputs(session_id,workspace_id,factory_id,activation_number,
  definition_revision_id,definition_digest,pipeline_id,github_repository_id,selected_stage_ids,
  model_provider,model_name,title_sha256,prompt_sha256,original_title,original_prompt_md)
select session.id,session.workspace_id,session.factory_id,canary.activation_number,canary.candidate_revision_id,
  (rollout.result->>'draftDigest'),session.pipeline_id,session.github_repository_id,array[session.current_stage_id],
  'codex','gpt-4.1-2025-04-14',encode(sha256(convert_to(session.title,'UTF8')),'hex'),
  encode(sha256(convert_to(session.prompt_md,'UTF8')),'hex'),session.title,session.prompt_md
from public.sessions session join routing_canary_test_sessions assigned on assigned.session_id=session.id
cross join public.factory_routing_canaries canary cross join routing_canary_rollout rollout;
select results_eq($$
  select receipt.routing_canary_arm,receipt.routing_canary_bucket,receipt.routing_canary_eligible
  from public.session_factory_admission_inputs receipt join routing_canary_test_sessions assigned using(session_id)
  order by receipt.routing_canary_arm
$$,$$select arm,bucket,true from routing_canary_test_sessions order by arm$$,
  'each new participant receives the deterministic immutable assignment before any queue');
select is((select internal.effective_factory_routing_execution(receipt.workspace_id,receipt.factory_id,receipt.session_id)
  ->>'benchmarkCandidateKey' from public.session_factory_admission_inputs receipt
  join routing_canary_test_sessions assigned using(session_id) where assigned.arm='baseline'),
  pg_temp.frontier_result(1)->>'candidateKey','the baseline executes the previous reviewed routing target');
select is((select internal.effective_factory_routing_execution(receipt.workspace_id,receipt.factory_id,receipt.session_id)
  ->>'benchmarkCandidateKey' from public.session_factory_admission_inputs receipt
  join routing_canary_test_sessions assigned using(session_id) where assigned.arm='candidate'),
  pg_temp.frontier_result(5)->>'candidateKey','the candidate executes the newly reviewed routing target');
select ok((select receipt.routing_decision->>'mode'='shadow' and receipt.routing_execution is null
  and receipt.routing_canary_baseline_execution->>'effort'='high'
  from public.session_factory_admission_inputs receipt join routing_canary_test_sessions assigned using(session_id)
  where assigned.arm='baseline'),'the prior execution overlay retains its own prompt profile without changing the current workflow pin');

create function pg_temp.submit_canary_task() returns uuid language sql as $$
  select accepted.session_id from live_scope scope cross join routing_canary_rollout rollout
  cross join lateral public.create_session_command_once(scope.workspace_id,pg_temp.live_id(21),pg_temp.live_id(602),
    repeat('b',64),rollout.result->>'draftDigest','Submit canary task','Review the same task on retries.',
    'codex','gpt-4.1-2025-04-14','{}'::uuid[],session_github_repository_id=>pg_temp.live_id(42),
    selected_pipeline_id=>pg_temp.live_id(40),selected_stage_ids=>array[pg_temp.live_id(41)],target_factory_id=>scope.factory_id)
  accepted
$$;
create temp table canary_admitted_session as select pg_temp.submit_canary_task() as session_id;
select is(pg_temp.submit_canary_task(),(select session_id from canary_admitted_session),
  'idempotent creation replay retains the original enrolled session and its exact arm');
select ok((select receipt.routing_canary_id=canary.id
  and receipt.routing_canary_bucket=internal.factory_routing_canary_bucket(canary,receipt.session_id)
  and exists (select 1 from public.agent_jobs queued where queued.session_id=receipt.session_id)
  from public.session_factory_admission_inputs receipt join canary_admitted_session admitted using(session_id)
  cross join public.factory_routing_canaries canary),'the common creation command records the assignment and queues its task atomically');
select throws_ok($$update public.session_factory_admission_inputs set routing_canary_arm='candidate'
  where session_id=(select session_id from canary_admitted_session)$$,'23514',null,
  'a committed assignment cannot move to a different cohort');

create temp table canary_override_task as
select accepted.session_id from live_scope scope cross join routing_canary_rollout rollout
cross join lateral public.create_session_command_with_routing_override(scope.workspace_id,pg_temp.live_id(21),pg_temp.live_id(603),
  repeat('b',64),rollout.result->>'draftDigest','Override canary task','Inspect the explicit execution change.',
  'codex','gpt-4.1-2025-04-14','{}'::uuid[],
  jsonb_build_object('expectedActivationNumber',5,'ruleId',pg_temp.live_id(202),'target','rule_fallback','reason','Use the reviewed alternate.'),
  session_github_repository_id=>pg_temp.live_id(42),selected_pipeline_id=>pg_temp.live_id(40),
  selected_stage_ids=>array[pg_temp.live_id(41)],target_factory_id=>scope.factory_id) accepted;
select ok((select receipt.routing_canary_arm=case when receipt.routing_canary_bucket<canary.candidate_bps then 'candidate' else 'baseline' end
  and receipt.routing_decision->>'benchmarkCandidateKey'=pg_temp.frontier_result(5)->>'candidateKey'
  and override.routing_execution->>'benchmarkCandidateKey'=pg_temp.frontier_result(1)->>'candidateKey'
  from public.session_factory_admission_inputs receipt join canary_override_task owner using(session_id)
  join public.session_factory_routing_overrides override using(session_id)
  join public.factory_routing_canaries canary on canary.id=receipt.routing_canary_id),
  'an explicit reviewed override changes execution while preserving the assigned arm and recommendation');

create temp table canary_original_attempt as
select job.id as job_id, job.session_id, run.id as run_id, receipt.routing_canary_id,
  receipt.routing_canary_arm, receipt.routing_canary_bucket,
  internal.effective_factory_routing_execution(receipt.workspace_id,receipt.factory_id,receipt.session_id) as execution
from canary_admitted_session admitted join public.agent_jobs job using(session_id)
join public.agent_runs run on run.agent_job_id=job.id
join public.session_factory_admission_inputs receipt on receipt.session_id=admitted.session_id;
update public.agent_jobs set created_at='-infinity' where id=(select job_id from canary_original_attempt);
select job_id from public.claim_next_worker_dispatch(false,100,2,1800000);
select is(public.start_session_job_attempt(job_id,1,pg_temp.live_id(41),0,
  'codex','gpt-4.1-2025-04-14','project','wallie/canary'),run_id,'the exact canary attempt can start')
from canary_original_attempt;
select is(public.fail_session_job_attempt(job_id,1,'Reopen canary task',false,0,run_id),'error',
  'the canary attempt can retire before a same-session retry') from canary_original_attempt;
create temp table canary_retried_job as
select original.session_id,next.job_id,next.created from canary_original_attempt original
cross join lateral public.enqueue_session_job_with_run(
  original.session_id,pg_temp.live_id(11),pg_temp.live_id(41),pg_temp.live_id(21),'manual_retry',
  'cursor','unrelated-model','project') next;
select ok((select retry.created
  and (receipt.routing_canary_id,receipt.routing_canary_arm,receipt.routing_canary_bucket)=
      (original.routing_canary_id,original.routing_canary_arm,original.routing_canary_bucket)
  and internal.effective_factory_routing_execution(receipt.workspace_id,receipt.factory_id,receipt.session_id)=original.execution
  from canary_retried_job retry join canary_original_attempt original using(session_id)
  join public.session_factory_admission_inputs receipt using(session_id)),
  'a same-session worker retry keeps the exact original cohort and executable pin');

create temp table later_canary_draft as
select pg_temp.save_frontier_routing_edit(draft_id,'{modelRouting,taskClasses,0,name}','"Later canary"',5,null) as draft_id
from canary_review_draft;
select pg_temp.seed_canary_activation_checks(draft_id,5) from later_canary_draft;
select throws_ok($$select pg_temp.activate_routing_canary(5,draft_id) from later_canary_draft$$,'PT422',null,
  'an already split prior activation cannot silently become a single baseline');
select is(pg_temp.submit_canary_task(),(select session_id from canary_admitted_session),
  'a rejected later canary does not change a committed cohort');

create function pg_temp.use_shadow_canary_control() returns jsonb language plpgsql as $$
declare
  designation public.factory_routing_canaries;
  receipt public.session_factory_admission_inputs;
  owner public.sessions;
  workflow jsonb;
begin
  select * into strict designation from public.factory_routing_canaries where workspace_id=pg_temp.live_id(11);
  select activation.activation_number,activation.revision_id into designation.baseline_activation_number,designation.baseline_revision_id
  from public.factory_definition_activations activation
  where (activation.workspace_id,activation.factory_id,activation.activation_number) =
    (designation.workspace_id,designation.factory_id,3);
  select admission.* into strict receipt from public.session_factory_admission_inputs admission
  join routing_canary_test_sessions assigned using(session_id) where assigned.arm='baseline';
  select session.* into strict owner from public.sessions session where session.id=receipt.session_id;
  select revision.definition_json::jsonb into strict workflow from public.factory_definition_revisions revision
  where revision.id=designation.candidate_revision_id and revision.workspace_id=designation.workspace_id;
  return internal.make_factory_routing_canary_baseline(designation,receipt,owner,workflow,'review');
end;
$$;
select is(pg_temp.use_shadow_canary_control(),null::jsonb,'a previous shadow activation retains its exact base execution');
delete from public.user_codex_credentials where user_id=pg_temp.live_id(1);
select throws_ok($$select pg_temp.use_shadow_canary_control()$$,'PT422',
  'A current personal credential is required for this agent.',
  'a shadow control must retain the actual base personal credential authority');
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values (pg_temp.live_id(1),'platform_api_key','synthetic-routing-key');

-- Observed canary outcome assertions

create temp table canary_observed_attempts as
select assigned.session_id, assigned.arm, fixture.*, scope.workspace_id,
  pg_temp.live_id(1100 + fixture.job_slot) as job_id,
  pg_temp.live_id(1100 + fixture.run_slot) as run_id,
  clock_timestamp() - interval '1 minute' as started_at,
  internal.effective_factory_routing_execution(scope.workspace_id,scope.factory_id,assigned.session_id) as execution
from (values
  ('candidate',1,11,1,'error',1,0.020::numeric,'measured'),
  ('candidate',1,12,2,'success',2,0.035::numeric,'estimated'),
  ('baseline',2,13,1,'canceled',3,null,'unavailable'),
  ('baseline',3,14,1,'running',null,1.000::numeric,'measured')
) as fixture(arm_name,job_slot,run_slot,attempt_count,status,duration_s,cost,provenance)
join routing_canary_test_sessions assigned on assigned.arm=fixture.arm_name cross join live_scope scope;
insert into public.agent_jobs(id,workspace_id,session_id,stage_id,stage_slug,trigger_type,status,attempt_count,
  started_at,finished_at,claimed_worker_runtime)
select distinct on (job_id) job_id,workspace_id,session_id,pg_temp.live_id(41),'review','manual_retry',
  status::public.agent_job_status,attempt_count,started_at,started_at + make_interval(secs=>duration_s),'workerd'
from canary_observed_attempts order by job_id,attempt_count desc;
insert into public.agent_runs(id,workspace_id,session_id,agent_job_id,stage_id,stage_slug,run_type,model_provider,
  model_name,status,started_at,finished_at,attempt_count,total_cost_usd,cost_provenance,usage_recorded_at,
  usage_finalized_at,usage_estimation_revision)
select run_id,workspace_id,session_id,job_id,pg_temp.live_id(41),'review','project','codex',execution->>'modelName',
  status::public.agent_run_status,started_at,started_at + make_interval(secs=>duration_s),attempt_count,cost,
  provenance,started_at,started_at + make_interval(secs=>duration_s),
  case when provenance='estimated' then 'canary-test-rate-v1' end
from canary_observed_attempts;
update public.sessions set phase_status='approved'
where id=(select session_id from routing_canary_test_sessions where arm='candidate');

create function pg_temp.canary_observed_report(p_id uuid default null, p_from timestamptz default null, p_to timestamptz default null)
returns jsonb language sql as $$
  select public.get_factory_routing_canary_report(pg_temp.live_id(11), (select factory_id from live_scope),p_id,p_from,p_to)
$$;
create temp table canary_observed_fixture_end as
select created_at from public.session_factory_admission_inputs join canary_admitted_session using(session_id);
grant select on live_scope,canary_observed_fixture_end to authenticated;
set local request.jwt.claim.role='authenticated';
select set_config('request.jwt.claim.sub',pg_temp.live_id(1)::text,true);
set local role authenticated;
select ok((select (report#>>'{baseline,assignedSessions}')::integer+(report#>>'{candidate,assignedSessions}')::integer=4
  and (report#>>'{baseline,overriddenSessions}')::integer+(report#>>'{candidate,overriddenSessions}')::integer=1
  and report->'reasons' @> '["exposure_deviations"]'
  from (select pg_temp.canary_observed_report() report) data),
  'the report retains all four exact members and discloses the override under its assigned arm');
select ok((select report#>'{candidate,startedAttempts}'='2'::jsonb and report#>'{candidate,failedAttempts}'='1'::jsonb
  and report#>'{candidate,succeededAttempts}'='1'::jsonb and report#>'{candidate,measuredCostAttempts}'='1'::jsonb
  and report#>'{candidate,estimatedCostAttempts}'='1'::jsonb and report#>'{candidate,knownSpendUsd}'='0.055'::jsonb
  and report#>'{candidate,meanSpendUsd}'='0.055'::jsonb and report#>'{candidate,meanLatencyMs}'='3000'::jsonb
  and report#>'{candidate,exposureMismatchSessions}'='1'::jsonb
  from (select pg_temp.canary_observed_report(p_to=>created_at) report from canary_observed_fixture_end) data),
  'a failed claim and successful retry reconcile to one candidate session, including measured and estimated cost and summed wall time');
select ok((select report#>'{baseline,canceledAttempts}'='1'::jsonb and report#>'{baseline,pendingAttempts}'='1'::jsonb
  and report#>'{baseline,unavailableCostAttempts}'='1'::jsonb and report#>'{baseline,pendingCostAttempts}'='1'::jsonb
  and report#>'{baseline,knownSpendUsd}'='null'::jsonb and report#>'{baseline,meanLatencyMs}'='null'::jsonb
  and report->>'status'='inconclusive' and report->'reasons' @> '["insufficient_quality","incomplete_usage"]'
  from (select pg_temp.canary_observed_report(p_to=>created_at) report from canary_observed_fixture_end) data),
  'terminal unknown and provisional cost remain distinct, and missing quality keeps the comparison inconclusive');
select is(pg_temp.canary_observed_report(pg_temp.live_id(299)),null::jsonb,
  'a different canary identifier cannot fall through to the latest report');
select ok((select report#>'{baseline,assignedSessions}'='0'::jsonb and report#>'{candidate,assignedSessions}'='0'::jsonb
  from (select pg_temp.canary_observed_report(null,statement_timestamp()-interval '1 day',
    statement_timestamp()-interval '1 hour') report) data), 'the enrollment window keeps other assignments out of both arms');
select set_config('request.jwt.claim.sub',pg_temp.live_id(299)::text,true);
select throws_ok($$select pg_temp.canary_observed_report()$$,'42501',null,
  'an authenticated outsider cannot query canary outcomes or confirm a designation');
reset role;
set local request.jwt.claim.role='service_role';

-- Publish the exact retry output and record one original, scoped judge result.
create temp table canary_quality_run as
select retry.job_id,retry.session_id,job.workspace_id,run.id as run_id,original.execution
from canary_retried_job retry join canary_original_attempt original using(session_id)
join public.agent_jobs job on job.id=retry.job_id join public.agent_runs run on run.agent_job_id=retry.job_id;
update public.agent_jobs set status='running',attempt_count=1,claimed_worker_runtime='workerd',
  git_continuity_release_revision=(select revision from public.get_git_continuity_release_state())
where id=(select job_id from canary_quality_run);
select is(public.start_session_job_attempt(job_id,1,pg_temp.live_id(41),0,'codex',execution->>'modelName',
  'project','wallie/canary-observed-quality'),run_id,'start the exact canary quality retry') from canary_quality_run;
select public.pin_session_job_git_input(job_id,1,run_id,pg_temp.live_id(42),'main',repeat('a',40)) from canary_quality_run;
update public.agent_runs set sandbox_provider='vercel',sandbox_connection_revision=pg_temp.live_id(50),
  sandbox_id='sbx_canary_quality',sandbox_vercel_team_id='team_live',sandbox_vercel_project_id='prj_live'
where id=(select run_id from canary_quality_run);
select ok(public.pin_session_attempt_manifest(job_id,run_id,1,repeat('c',64),24,3,repeat('a',40),'[]','workerd',
  null,execution->>'effort',pg_temp.live_id(21)),'verify exact exposure for the scored retry') from canary_quality_run;
select ok(public.prepare_session_source_and_checkpoint_publication(run_id,pg_temp.live_id(42),'main',repeat('a',40),
  repeat('a',40),'Canary quality','Exact retry output','','','',0,'Observed canary output'),
  'stage the canary retry original output') from canary_quality_run;
select ok(public.adopt_session_checkpoint_publication(run_id, public.claim_session_checkpoint_publication(run_id)),
  'retain the concrete output checkpoint for the canary') from canary_quality_run;

insert into public.session_stage_approval_receipts(workspace_id,session_id,completion_id,stage_id,
  artifact_id,artifact_version,artifact_digest,approved_by_member_id)
select artifact.workspace_id,artifact.session_id,pg_temp.live_id(1140),artifact.stage_id,artifact.id,artifact.version,
  encode(sha256(convert_to(internal.approved_predecessor_artifact_text(artifact.artifact_json),'UTF8')),'hex'),pg_temp.live_id(21)
from canary_quality_run target join public.session_git_checkpoints checkpoint using(run_id)
join public.session_artifacts artifact on artifact.id=checkpoint.artifact_id;
insert into public.factory_scorer_sampling_policies(id,workspace_id,factory_id,scorer_revision_id,
  revision_number,rate_bps,seed,terminal_statuses,stage_ids,created_by)
select pg_temp.live_id(1141),scope.workspace_id,scope.factory_id,scorer.id,1,10000,'canary-report',
  array['success'],array[pg_temp.live_id(41)],scope.owner_id from live_scope scope cross join frontier_scorer scorer;
insert into public.factory_scorer_sample_receipts(id,workspace_id,factory_id,policy_id,scorer_revision_id,
  definition_revision_id,session_id,run_id,attempt_count,run_finished_at,target_commit_sha,outcome,missing_evidence,evidence)
select pg_temp.live_id(1142),scope.workspace_id,scope.factory_id,pg_temp.live_id(1141),scorer.id,
  admission.definition_revision_id,target.session_id,target.run_id,checkpoint.attempt_count,run.finished_at,
  checkpoint.output_sha,'sampled','{}','[{"kind":"artifact"}]'
from live_scope scope cross join frontier_scorer scorer cross join canary_quality_run target
join public.session_factory_admission_inputs admission using(session_id)
join public.session_git_checkpoints checkpoint using(run_id)
join public.agent_runs run on run.id=target.run_id;
update public.factory_evaluation_jobs set status='succeeded', attempt_count=1, available_at=null, finished_at=clock_timestamp()
where sample_receipt_id=pg_temp.live_id(1142);
insert into public.factory_evaluation_attempts(id,job_id,workspace_id,factory_id,attempt_number,claimed_at,
  lease_expires_at,settled_at,outcome)
select pg_temp.live_id(1143),job.id,job.workspace_id,job.factory_id,1,job.finished_at-interval '1 second',
  job.finished_at+interval '1 minute',job.finished_at,'succeeded'
from public.factory_evaluation_jobs job where job.sample_receipt_id=pg_temp.live_id(1142);
insert into public.factory_evaluation_receipts(attempt_id,workspace_id,factory_id,job_id,session_id,run_id,scorer_revision_id,
  sample_receipt_id,target_commit_sha,attempt_number,attempt_outcome,profile_revision_id,provider_model,provider_name,
  status,result,claimed_at,finished_at,latency_ms,cost_usd,cost_provenance)
select attempt.id,job.workspace_id,job.factory_id,job.id,job.session_id,job.run_id,job.scorer_revision_id,job.sample_receipt_id,
  job.target_commit_sha,1,'succeeded',(select id from public.factory_judge_profile_revisions
    where workspace_id=job.workspace_id order by revision desc limit 1),
  'openai/gpt-example','openai','pass','{"score":{"kind":"boolean","value":true}}',
  attempt.claimed_at,attempt.settled_at,1000,12.340,'measured'
from public.factory_evaluation_attempts attempt join public.factory_evaluation_jobs job on job.id=attempt.job_id
where attempt.id=pg_temp.live_id(1143);

set local request.jwt.claim.role='authenticated';
select set_config('request.jwt.claim.sub',pg_temp.live_id(1)::text,true);
set local role authenticated;
select ok((select (report#>>'{baseline,scoredSessions}')::integer+(report#>>'{candidate,scoredSessions}')::integer=1
  and (report#>>'{baseline,scorePasses}')::integer+(report#>>'{candidate,scorePasses}')::integer=1
  and coalesce((report#>>'{baseline,knownSpendUsd}')::numeric,0)+coalesce((report#>>'{candidate,knownSpendUsd}')::numeric,0)=0.055
  from (select pg_temp.canary_observed_report() report) data),
  'the exact accepted attempt and frozen scorer contribute one pass while judge spend stays out of production spend');
reset role;
set local request.jwt.claim.role='service_role';

-- Canary alert evaluation, retention and manager access.
select ok(has_function_privilege('service_role','public.process_factory_routing_canary_alerts(integer)','execute')
  and not has_function_privilege('authenticated','public.process_factory_routing_canary_alerts(integer)','execute')
  and not has_function_privilege('authenticated','internal.build_factory_routing_canary_report(uuid,uuid,uuid,timestamptz,timestamptz)','execute'),
  'only maintenance can evaluate canary alerts and only guarded entry points can read the raw report');
select is(public.process_factory_routing_canary_alerts(1),' {"evaluated":1,"created":0}'::jsonb,
  'real incomplete or unproven canary outcomes do not emit a degradation alert');
select is(public.process_factory_routing_canary_alerts(1),' {"evaluated":0,"created":0}'::jsonb,
  'the next invocation skips the existing cooldown window');

create temp table canary_degraded_snapshot as
select canary.id as canary_id, snapshot || jsonb_build_object(
  'status','comparable','reasons','[]'::jsonb,
  'baseline', snapshot->'baseline' || '{"assignedSessions":10,"scoredSessions":10,"scorePasses":10,"scoreFailures":0,"completeSpendSessions":10,"meanSpendUsd":0.20,"knownLatencySessions":10,"meanLatencyMs":800,"overriddenSessions":0,"fallbackSessions":0,"exposureMismatchSessions":0}',
  'candidate', snapshot->'candidate' || '{"assignedSessions":10,"scoredSessions":10,"scorePasses":9,"scoreFailures":1,"completeSpendSessions":10,"meanSpendUsd":0.25,"knownLatencySessions":10,"meanLatencyMs":1000,"overriddenSessions":0,"fallbackSessions":0,"exposureMismatchSessions":0}'
) as report
from public.factory_routing_canaries canary
cross join lateral internal.build_factory_routing_canary_report(canary.workspace_id,canary.factory_id,canary.id,null,null) snapshot
where canary.workspace_id=pg_temp.live_id(11) and canary.activation_number=5;
select results_eq($$select breach.metric,breach.threshold_bps,breach.baseline_value,breach.candidate_value
  from canary_degraded_snapshot source cross join lateral internal.factory_routing_canary_breaches(source.report) breach
  order by breach.metric$$,$$values ('pass_rate'::text,1000,1.0::numeric,0.9::numeric),
    ('spend',2500,0.20,0.25),('wall_time',2500,800,1000)$$,
  'degradation thresholds are inclusive and explicit for pass rate, mean spend and attempt wall time');
select results_eq($$select breach.metric from canary_degraded_snapshot source
  cross join lateral internal.factory_routing_canary_breaches(
    jsonb_set(source.report,'{reasons}','["incomparable_scores","incomplete_usage"]')) breach$$,
  $$values ('wall_time'::text)$$,'quality or spend missingness does not hide independent wall-time degradation');
select is((select count(*) from canary_degraded_snapshot source
  cross join lateral internal.factory_routing_canary_breaches(
    jsonb_set(source.report,'{reasons}','["exposure_deviations"]')) breach),0::bigint,
  'an override, fallback or unproven execution suppresses automated degradation conclusions');
select is((select count(*) from canary_degraded_snapshot source
  cross join lateral internal.factory_routing_canary_breaches(
    jsonb_set(source.report,'{canary,minimumSupport}','11')) breach),0::bigint,
  'every alert requires minimum support in each arm');
select results_eq($$select breach.metric from canary_degraded_snapshot source
  cross join lateral internal.factory_routing_canary_breaches(
    jsonb_set(jsonb_set(source.report,'{baseline,meanSpendUsd}','0'),'{baseline,meanLatencyMs}','0')) breach$$,
  $$values ('pass_rate'::text)$$,'relative spend and latency thresholds need a positive baseline');

select is(internal.record_factory_routing_canary_alerts(canary, source.report),3,
  'each first supported degradation retains exactly one snapshot')
from canary_degraded_snapshot source join public.factory_routing_canaries canary on canary.id=source.canary_id;
select is(internal.record_factory_routing_canary_alerts(canary, source.report),0,
  'replaying the same evaluation never duplicates a breach')
from canary_degraded_snapshot source join public.factory_routing_canaries canary on canary.id=source.canary_id;
create temp table canary_alert_fixture as
select receipt.id, receipt.workspace_id, receipt.factory_id, receipt.canary_id, receipt.evidence_draft_id, receipt.report
from public.factory_routing_canary_alerts receipt join canary_degraded_snapshot source using(canary_id)
where receipt.metric='spend';
grant select on canary_alert_fixture to authenticated;
select throws_ok($$update public.factory_routing_canary_alerts set threshold_bps=1 where id=(select id from canary_alert_fixture)$$,
  '23514',null,'retained alert evidence is immutable');
select is((select max(activation_number) from public.factory_definition_activations where workspace_id=pg_temp.live_id(11)),
  5::bigint,'a degradation signal never moves the activation head');
set local request.jwt.claim.role='authenticated';
select set_config('request.jwt.claim.sub',pg_temp.live_id(1)::text,true);
set local role authenticated;
select ok((select alert->'report'=fixture.report and alert->>'metric'='spend'
  and alert->>'ruleId'=pg_temp.live_id(202)::text and alert->>'evidenceDraftId'=fixture.evidence_draft_id::text
  and alert#>>'{evidence,scorerRevisionId}'=fixture.report#>>'{canary,scorerRevisionId}'
  from canary_alert_fixture fixture cross join lateral public.get_factory_routing_canary_alert(
    fixture.workspace_id,fixture.factory_id,fixture.canary_id,fixture.id) alert),
  'a factory manager can replay the exact frozen score, rule, benchmark evidence and report');
select is(public.get_factory_routing_canary_alert(workspace_id,factory_id,pg_temp.live_id(299),id),null::jsonb,
  'an alert ID cannot be resolved in another cohort') from canary_alert_fixture;
select set_config('request.jwt.claim.sub',pg_temp.live_id(299)::text,true);
select is(public.get_factory_routing_canary_alert(workspace_id,factory_id,canary_id,id),null::jsonb,
  'an authenticated outsider cannot read the retained alert') from canary_alert_fixture;
reset role;
set local request.jwt.claim.role='service_role';

create temp table drift_probe_draft as
select pg_temp.save_frontier_routing_edit(draft_id,'{modelRouting,rules,0,configuration}',
  pg_temp.routing_configuration(5) || jsonb_build_object('scorerRevisionId',(select id from frontier_scorer),
    'modelKey','openai/gpt-drifted','harness','opencode','workerRuntime','node'),5,draft_id) as draft_id
from later_canary_draft;
select is((select public.freeze_factory_benchmark_experiment_axes_with_evaluation(
    scope.workspace_id,scope.factory_id,scope.owner_id,pg_temp.live_id(84),suite.id,policy.id,
    (select jsonb_agg(jsonb_build_object('definitionRevisionId',pg_temp.live_id(101),
       'qualificationId',pg_temp.live_id(51),'workerRuntime',runtime)) from (values ('node'),('workerd')) choices(runtime)),
    2,211,120000,jsonb_build_object('scorerRevisionIds',(select jsonb_agg(id) from frontier_scorer),'budgetLimitUsd',20)
  )->>'expectedTrialCount' from live_scope scope cross join live_suite suite cross join live_policy policy),
  '4','one frozen experiment can contain the same definition on both runtimes');
select results_eq($$
  select candidate.worker_runtime,internal.factory_routing_qualification_reasons(candidate.workspace_id,candidate.factory_id,
    pg_temp.routing_configuration(1) || jsonb_build_object('experimentId',candidate.experiment_id,
      'workerRuntime',candidate.worker_runtime,'scorerRevisionId',(select id from frontier_scorer)))
  from public.factory_benchmark_experiment_candidates candidate join live_scope using(workspace_id,factory_id)
  where candidate.experiment_id = pg_temp.live_id(84) order by candidate.worker_runtime
$$,$$values ('node'::text,'{}'::text[]),('workerd'::text,'{}'::text[])$$,
  'qualification resolves both runtime axes even when definition, model, harness, and qualification ID are identical');

create function pg_temp.routing_qualification_status(p_activation bigint default null,p_draft uuid default null)
returns jsonb language sql as $$
  select public.get_factory_routing_qualification_status(scope.workspace_id,scope.factory_id,p_activation,p_draft)
  from live_scope scope
$$;
grant select on live_scope,drift_probe_draft to authenticated;
set local request.jwt.claim.role='authenticated';
select set_config('request.jwt.claim.sub',pg_temp.live_id(1)::text,true);
set local role authenticated;
select is(pg_temp.routing_qualification_status()->>'status','current','the exact current canary keeps its current qualification evidence');
select is(pg_temp.routing_qualification_status(1)->>'status','current',
  'an ordinary shadow activation can read qualified proof from its exact inherited draft source');
select ok(pg_temp.routing_qualification_status(2)->'reasons' @> '["missing_proposal"]'::jsonb,
  'a shadow revision without a qualified source cannot borrow another draft’s evidence');
select ok((select status->>'status'='stale'
  and status->'reasons' @> '["missing_proposal","model_changed","harness_changed","runtime_changed"]'::jsonb
  from drift_probe_draft cross join lateral (select pg_temp.routing_qualification_status(p_draft=>draft_id) as status) result),
  'material model, harness, and runtime changes expose their exact drift reasons without borrowing proof');
select set_config('request.jwt.claim.sub',pg_temp.live_id(299)::text,true);
select throws_ok($$select pg_temp.routing_qualification_status()$$,'42501',null,
  'an outsider cannot inspect routing qualification or confirm its activation');
reset role;
set local request.jwt.claim.role='service_role';

create function pg_temp.restore_prior_routing(
  p_expected bigint,p_target bigint,p_revision uuid,p_actor uuid default pg_temp.live_id(1)
) returns public.factory_definition_activations language sql as $$
  select public.rollback_factory_routing_activation(scope.workspace_id,scope.factory_id,p_actor,p_expected,
    p_target,p_revision,array['vercel'],array['agentCli']) from live_scope scope
$$;
select throws_ok($$select public.rollback_factory_definition(scope.workspace_id,scope.factory_id,scope.owner_id,5,
  (prior.result->>'revisionId')::uuid,array['vercel'],array['agentCli'])
  from live_scope scope cross join reviewed_activation prior$$,'PT422',
  'Select the exact prior activation to roll back reviewed routing.','legacy rollback cannot silently restore reviewed routing in shadow mode');
select throws_ok($$select pg_temp.restore_prior_routing(4,3,pg_temp.live_id(300))$$,'PT409',null,
  'routing rollback honors the expected active head');
select throws_ok($$select pg_temp.restore_prior_routing(5,3,(result->>'revisionId')::uuid) from reviewed_activation$$,
  'P0002','The exact prior factory activation is unavailable.','a revision cannot be substituted for a different earlier activation');
select throws_ok($$select pg_temp.restore_prior_routing(5,4,(result->>'revisionId')::uuid,pg_temp.live_id(2))
  from reviewed_activation$$,'42501',null,'a factory reader cannot restore a routing activation');
delete from public.user_codex_credentials where user_id=pg_temp.live_id(1);
select throws_ok($$select pg_temp.restore_prior_routing(5,4,(result->>'revisionId')::uuid) from reviewed_activation$$,
  'PT422','The prior reviewed routing target is unavailable (credential_unavailable)',
  'rollback cannot restore an earlier reviewed configuration whose actual credential is unavailable');
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values (pg_temp.live_id(1),'platform_api_key','synthetic-routing-key');
select throws_ok($$select pg_temp.restore_prior_routing(5,4,(result->>'revisionId')::uuid) from reviewed_activation$$,
  'PT422','A current passing smoke test is required for the exact factory candidate.',
  'routing rollback retains the exact current-head revision smoke gate');
insert into public.factory_definition_smoke_tests(workspace_id,factory_id,target_kind,target_id,definition_digest,
  base_activation_number,sandbox_connection_revision,created_by,lease_expires_at,finished_at,status,evidence)
select scope.workspace_id,scope.factory_id,'revision',(prior.result->>'revisionId')::uuid,prior.result->>'draftDigest',
  5,pg_temp.live_id(50),scope.owner_id,clock_timestamp()+interval '5 minutes',clock_timestamp(),'passed','{"runtimeProfile":"vercel"}'
from live_scope scope cross join reviewed_activation prior;

create function pg_temp.stale_reviewed_rollback(p_revision uuid) returns text language plpgsql as $$
declare
  outcome text;
begin
  begin
    perform updated.id from live_scope scope cross join live_suite suite cross join live_task task
    cross join lateral public.save_factory_benchmark_suite_revision(scope.workspace_id,scope.factory_id,
      scope.owner_id,'Temporarily revised replay suite','regression',p_suite_id=>suite.suite_id,
      p_expected_revision_id=>suite.id,p_task_revision_ids=>array[task.id]) updated;
    begin
      perform pg_temp.restore_prior_routing(5,4,p_revision);
      outcome := 'incorrectly restored';
    exception when sqlstate 'PT409' then
      outcome := sqlerrm;
    end;
    raise exception using errcode='PZ631',message=outcome;
  exception when sqlstate 'PZ631' then
    return sqlerrm;
  end;
end;
$$;
select ok(pg_temp.stale_reviewed_rollback((result->>'revisionId')::uuid) like '%suite revision changed%',
  'rollback cannot restore a prior reviewed target after its original suite changes') from reviewed_activation;

create temp table live_rollback_attempt as
select admitted.* from public.create_session_with_first_job(pg_temp.live_id(11),pg_temp.live_id(21),
  'Keep running during rollback','Review the exact old assignment.','codex','gpt-4.1-2025-04-14',
  session_github_repository_id=>pg_temp.live_id(42),selected_pipeline_id=>pg_temp.live_id(40),
  selected_stage_ids=>array[pg_temp.live_id(41)]) admitted;
update public.agent_jobs set status='running',attempt_count=1,claimed_worker_runtime='workerd',
  git_continuity_release_revision=(select revision from public.get_git_continuity_release_state())
where id=(select job_id from live_rollback_attempt);
select is(public.start_session_job_attempt(job_id,1,pg_temp.live_id(41),0,
  'codex','gpt-4.1-2025-04-14','project','wallie/live-rollback'),run_id,'the old canary session is running before rollback')
from live_rollback_attempt;
select public.pin_session_job_git_input(job_id,1,run_id,pg_temp.live_id(42),'main',repeat('a',40)) from live_rollback_attempt;
update public.agent_runs set sandbox_provider='vercel',sandbox_connection_revision=pg_temp.live_id(50),
  sandbox_id='sbx_live_rollback',sandbox_vercel_team_id='team_live',sandbox_vercel_project_id='prj_live'
where id=(select run_id from live_rollback_attempt);
select ok(public.pin_session_attempt_manifest(active.job_id,active.run_id,1,repeat('b',64),24,3,
  repeat('a',40),'[]','workerd',null,internal.effective_factory_routing_execution(receipt.workspace_id,receipt.factory_id,receipt.session_id)->>'effort',
  pg_temp.live_id(21)),'the running canary attempt pins its exact pre-rollback execution')
from live_rollback_attempt active join public.session_factory_admission_inputs receipt using(session_id);
create temp table live_rollback_snapshot as
select manifest.run_id, to_jsonb(manifest) as manifest, to_jsonb(receipt) as receipt,
  internal.effective_factory_routing_execution(receipt.workspace_id,receipt.factory_id,receipt.session_id) as execution
from live_rollback_attempt active join public.session_attempt_manifests manifest using(run_id)
join public.session_factory_admission_inputs receipt on receipt.session_id=active.session_id;
select is((pg_temp.restore_prior_routing(5,4,(result->>'revisionId')::uuid)).activation_number,
  6::bigint,'reviewed rollback appends a new activation using the exact earlier reviewed revision') from reviewed_activation;
select is((select restored_mode from public.factory_routing_rollbacks where workspace_id=pg_temp.live_id(11) and activation_number=6),
  'reviewed','the immutable rollback record retains the chosen reviewed mode');
select ok((select run.status='running' and to_jsonb(manifest)=snapshot.manifest and to_jsonb(receipt)=snapshot.receipt
  and internal.effective_factory_routing_execution(receipt.workspace_id,receipt.factory_id,receipt.session_id)=snapshot.execution
  from live_rollback_snapshot snapshot join public.session_attempt_manifests manifest using(run_id)
  join public.agent_runs run on run.id=snapshot.run_id
  join public.session_factory_admission_inputs receipt on receipt.session_id=manifest.session_id),
  'rollback preserves the running attempt manifest, cohort, and effective profile byte-for-byte');
create temp table rolled_back_admission as
select session_id from public.create_session_with_first_job(pg_temp.live_id(11),pg_temp.live_id(21),
  'Run after reviewed rollback','Use the restored reviewed route.','codex','gpt-4.1-2025-04-14',
  session_github_repository_id=>pg_temp.live_id(42),selected_pipeline_id=>pg_temp.live_id(40),
  selected_stage_ids=>array[pg_temp.live_id(41)]);
select ok((select receipt.activation_number=6 and receipt.routing_canary_id is null
  and receipt.routing_decision->>'mode'='active' and receipt.routing_execution->>'benchmarkCandidateKey'=pg_temp.frontier_result(1)->>'candidateKey'
  from rolled_back_admission admitted join public.session_factory_admission_inputs receipt using(session_id)),
  'new sessions use the restored reviewed profile without inheriting the old canary');

create function pg_temp.independent_baseline_drift() returns jsonb language plpgsql as $$
declare
  scope live_scope := (select live_scope from live_scope);
  candidate public.factory_benchmark_experiment_candidates;
  body jsonb;
  draft_id uuid;
  observed jsonb;
begin
  begin
    select frozen.* into strict candidate from public.factory_benchmark_experiment_candidates frozen
    where (frozen.workspace_id,frozen.factory_id,frozen.experiment_id,frozen.comparison_position) =
      (scope.workspace_id,scope.factory_id,pg_temp.live_id(85),2);
    select jsonb_set(restored.definition_json::jsonb,'{modelRouting,rules,0,configuration}',
      pg_temp.routing_configuration(2) || jsonb_build_object('experimentId',candidate.experiment_id,
        'scorerRevisionId',(select id from frontier_scorer))) into strict body
    from public.factory_definition_activations head join public.factory_definition_revisions restored
      on (restored.workspace_id,restored.factory_id,restored.id)=(head.workspace_id,head.factory_id,head.revision_id)
    where (head.workspace_id,head.factory_id,head.activation_number) = (scope.workspace_id,scope.factory_id,6);
    body := jsonb_set(body,'{modelRouting,rules,0,constraints,maxMeanCostUsd}','0.30');
    body := jsonb_set(body,'{modelRouting,rules,0,onUnavailable}','{"kind":"escalate"}');
    draft_id := (public.save_factory_routing_draft(scope.workspace_id,scope.factory_id,scope.owner_id,6,
      body::text,encode(sha256(convert_to(body::text,'UTF8')),'hex'),'{"newStageIds":[]}',
      candidate.experiment_id,candidate.candidate_key,(select id from live_suite),(select id from frontier_scorer),
      pg_temp.live_id(202),pg_temp.live_id(645),repeat('f',64),null)).id;
    perform pg_temp.seed_canary_activation_checks(draft_id,6);
    perform pg_temp.activate_routing_canary(6,draft_id);
    perform public.revoke_factory_benchmark_replay_revision(scope.workspace_id,scope.factory_id,scope.owner_id,
      p_policy_revision_id=>(select id from live_policy));
    perform set_config('request.jwt.claim.role','authenticated',true);
    perform set_config('request.jwt.claim.sub',scope.owner_id::text,true);
    observed := pg_temp.routing_qualification_status();
    if observed is distinct from pg_temp.routing_qualification_status(7) then
      raise exception 'The exact canary lookup differs from the current activation.';
    end if;
    -- Roll back this independent rollout before continuing the shared fixture.
    raise exception using errcode='PZ632';
  exception when sqlstate 'PZ632' then
    return observed;
  end;
end;
$$;
select is(jsonb_build_object('status',status->'status','reasons',status->'reasons','baseline',status->'baseline'),
  jsonb_build_object('status','stale','reasons','[]'::jsonb,'baseline',jsonb_build_object(
    'activationNumber',6,'revisionId',prior.result->'revisionId','status','stale',
    'reasons',jsonb_build_array('replay_policy_revoked'))),
  'revoking only the reviewed control replay evidence marks the canary stale with no candidate reasons')
from reviewed_activation prior cross join lateral (select pg_temp.independent_baseline_drift() as status) observed;

create temp table post_canary_proposal as
select pg_temp.apply_routing_finding(1,20,p_activation => 6) as draft_id;
create temp table post_canary_draft as
select pg_temp.save_frontier_routing_edit(draft_id,'{modelRouting,taskClasses,0,name}','"Ordinary later revision"',6,draft_id) as draft_id
from post_canary_proposal;
select pg_temp.seed_canary_activation_checks(draft_id,6) from post_canary_draft;
select is((public.publish_factory_definition_draft(scope.workspace_id,scope.factory_id,scope.owner_id,6,
  draft.draft_id,array['vercel'],array['agentCli'])).activation_number,7::bigint,
  'an explicit later publication adds a new revision without changing the canary designation')
from live_scope scope cross join post_canary_draft draft;
select is(public.process_factory_routing_canary_alerts(1),'{"evaluated":0,"created":0}'::jsonb,
  'a superseded canary no longer emits new signals');
set local request.jwt.claim.role='authenticated';
select set_config('request.jwt.claim.sub',pg_temp.live_id(1)::text,true);
set local role authenticated;
select is(public.get_factory_routing_canary_alert(workspace_id,factory_id,canary_id,id)->'report',report,
  'the exact old alert replays its frozen report after the activation head moves') from canary_alert_fixture;
reset role;
set local request.jwt.claim.role='service_role';
select ok((select (receipt.routing_canary_id,receipt.routing_canary_arm,receipt.routing_canary_bucket)=
    (original.routing_canary_id,original.routing_canary_arm,original.routing_canary_bucket)
  and internal.effective_factory_routing_execution(receipt.workspace_id,receipt.factory_id,receipt.session_id)=original.execution
  from canary_original_attempt original join public.session_factory_admission_inputs receipt using(session_id)),
  'a later activation leaves the previously enrolled session and its execution intact');
create temp table post_canary_admission as
select session_id from public.create_session_with_first_job(pg_temp.live_id(11),pg_temp.live_id(21),
  'Create after canary','Review under the later factory definition.','codex','gpt-4.1-2025-04-14',
  session_github_repository_id=>pg_temp.live_id(42),selected_pipeline_id=>pg_temp.live_id(40),
  selected_stage_ids=>array[pg_temp.live_id(41)]);
select ok((select receipt.activation_number=7 and receipt.routing_canary_id is null
  from post_canary_admission admitted join public.session_factory_admission_inputs receipt using(session_id)),
  'new work under a later activation does not inherit the old canary assignment');

-- The reviewer can use both harnesses. Another manager can use the reviewed
-- Codex route but has no credential for the unused OpenCode shadow control.
insert into public.user_opencode_provider_credentials(user_id,provider_id,encrypted_api_key)
values (pg_temp.live_id(1),'openai','synthetic-opencode-test-key');
update public.workspace_members set role='admin' where id=pg_temp.live_id(22);
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values (pg_temp.live_id(2),'platform_api_key','synthetic-override-manager-codex-key');
create temp table opencode_control_draft as
select pg_temp.save_frontier_routing_edit(source.id,'{agent}',source.definition_json::jsonb->'agent' ||
  '{"provider":"opencode","model":"openai/gpt-4.1-2025-04-14","effort":null}'::jsonb,7,null) as draft_id
from public.factory_definition_drafts source join post_canary_draft saved on source.id=saved.draft_id;
select pg_temp.seed_canary_activation_checks(draft_id,7,pg_temp.live_id(52)) from opencode_control_draft;
select is((public.publish_factory_definition_draft(scope.workspace_id,scope.factory_id,scope.owner_id,7,
  draft.draft_id,array['vercel'],array['agentCli'])).activation_number,8::bigint,'the control publishes as an ordinary OpenCode activation')
from live_scope scope cross join opencode_control_draft draft;
create temp table codex_canary_draft as
select (public.save_factory_routing_draft(draft.workspace_id,draft.factory_id,draft.created_by,8,
  draft.definition_json,draft.canonical_digest,draft.settings_metadata,pg_temp.live_id(80),
  pg_temp.frontier_result(1)->>'candidateKey',(select id from live_suite),(select id from frontier_scorer),
  pg_temp.live_id(202),pg_temp.live_id(640),repeat('c',64),null)).id as draft_id
from public.factory_definition_drafts draft join opencode_control_draft control on control.draft_id=draft.id;
select pg_temp.seed_canary_activation_checks(draft_id,8,pg_temp.live_id(52)) from codex_canary_draft;
create temp table opencode_control_rollout as
select pg_temp.activate_routing_canary(8,draft_id) as result from codex_canary_draft;

-- Choose exact test UUIDs before the real admission path so all of these
-- commands exercise the control arm without depending on random allocation.
create function pg_temp.force_shadow_control_assignment() returns trigger language plpgsql as $$
declare designation public.factory_routing_canaries;
  offset_slot integer;
begin
  if new.workspace_id <> pg_temp.live_id(11) then return new; end if;
  offset_slot := case new.title when 'Check baseline credential' then 2000
    when 'Override unavailable baseline' then 2400 when 'Reject revoked override' then 2800
    when 'Refuse stale candidate' then 3200 when 'Reject stale override' then 3600 end;
  if offset_slot is null then return new; end if;
  select * into strict designation from public.factory_routing_canaries canary
  where (canary.workspace_id,canary.candidate_revision_id) = (new.workspace_id,new.factory_definition_revision_id);
  select pg_temp.live_id(slot) into strict new.id from generate_series(offset_slot+1,offset_slot+400) slot
  where (internal.factory_routing_canary_bucket(designation,pg_temp.live_id(slot)) < designation.candidate_bps)
    = (new.title = 'Refuse stale candidate')
  order by slot limit 1;
  return new;
end;
$$;
create trigger fixture_force_shadow_control_assignment before insert on public.sessions
  for each row execute function pg_temp.force_shadow_control_assignment();
create function pg_temp.submit_shadow_control_override(p_request integer, p_title text) returns uuid language sql as $$
  select accepted.session_id from live_scope scope cross join opencode_control_rollout rollout
  cross join lateral public.create_session_command_with_routing_override(scope.workspace_id,pg_temp.live_id(22),pg_temp.live_id(p_request),
    repeat('c',64),rollout.result->>'draftDigest',p_title,'Review exact credential scope.',
    'opencode','openai/gpt-4.1-2025-04-14','{}'::uuid[],
    jsonb_build_object('expectedActivationNumber',9,'ruleId',pg_temp.live_id(202),'target','primary','reason','Use my qualified Codex route.'),
    session_github_repository_id=>pg_temp.live_id(42),selected_pipeline_id=>pg_temp.live_id(40),
    selected_stage_ids=>array[pg_temp.live_id(41)],target_factory_id=>scope.factory_id) accepted
$$;
select throws_ok($$select public.create_session_command_once(scope.workspace_id,pg_temp.live_id(22),pg_temp.live_id(641),
  repeat('c',64),rollout.result->>'draftDigest','Check baseline credential','Review exact credential scope.',
  'opencode','openai/gpt-4.1-2025-04-14','{}'::uuid[],session_github_repository_id=>pg_temp.live_id(42),
  selected_pipeline_id=>pg_temp.live_id(40),selected_stage_ids=>array[pg_temp.live_id(41)],target_factory_id=>scope.factory_id)
from live_scope scope cross join opencode_control_rollout rollout$$,
  'PT422','A current personal credential is required for this agent.','normal control admission still requires the OpenCode credential');
create temp table eligible_control_override as
select pg_temp.submit_shadow_control_override(642,'Override unavailable baseline') as session_id;
select ok((select receipt.routing_canary_arm='baseline' and receipt.routing_canary_eligible
  and receipt.routing_canary_baseline_execution is null and override.actor_member_id=pg_temp.live_id(22)
  and override.routing_execution#>>'{configuration,harness}'='codex'
  and override.routing_execution->>'benchmarkCandidateKey'=pg_temp.frontier_result(1)->>'candidateKey'
  from public.session_factory_admission_inputs receipt join eligible_control_override using(session_id)
  join public.session_factory_routing_overrides override using(session_id)),
  'an authorized exact override uses Codex without requiring the unused OpenCode control credential');
delete from public.user_codex_credentials where user_id=pg_temp.live_id(2);
select throws_ok($$select pg_temp.submit_shadow_control_override(643,'Reject revoked override')$$,
  'PT422','The reviewed override target is unavailable (credential_unavailable)',
  'a requested override still requires its own exact credential after the control bypass');
select ok(not exists (select 1 from public.sessions where workspace_id=pg_temp.live_id(11) and title='Reject revoked override')
  and not exists (select 1 from internal.factory_routing_canary_override_requests),
  'a rejected override leaves no admission, job or private handoff');
create temp table proposal_before_suite_edit as
select pg_temp.apply_routing_finding(1,22,p_activation => 9) as draft_id;
select updated.id from live_scope scope cross join live_suite suite cross join live_task task
cross join lateral public.save_factory_benchmark_suite_revision(
  scope.workspace_id, scope.factory_id, scope.owner_id, 'Revised live replay suite', 'regression',
  p_suite_id => suite.suite_id, p_expected_revision_id => suite.id, p_task_revision_ids => array[task.id]
) updated;
select throws_ok($$select pg_temp.apply_routing_finding(1,16,
  p_expected_draft=>(select draft_id from proposal_before_suite_edit),p_activation=>9)$$,
  'PT409', 'The suite revision changed. Run a new comparison before applying it.',
  'a suite edit invalidates previously qualified evidence for new proposals');
select is(pg_temp.apply_routing_finding(1,22,p_activation=>9), (select draft_id from proposal_before_suite_edit),
  'resubmitting the same request still reads its original receipt after a suite edit');
select throws_ok($$select public.activate_reviewed_factory_routing(scope.workspace_id,scope.factory_id,scope.owner_id,9,
  saved.draft_id,array['vercel'],array['agentCli']) from live_scope scope cross join proposal_before_suite_edit saved$$,
  'PT409',null,'stale benchmark evidence cannot activate the current reviewed candidate');
select throws_ok($$select public.create_session_with_first_job(pg_temp.live_id(11),pg_temp.live_id(21),
  'Refuse stale candidate','Review under current qualification.','opencode','openai/gpt-4.1-2025-04-14',
  session_github_repository_id=>pg_temp.live_id(42),selected_pipeline_id=>pg_temp.live_id(40),
  selected_stage_ids=>array[pg_temp.live_id(41)])$$,'PT422',
  'The reviewed routing policy escalated this task (qualification_unavailable)',
  'a newly assigned candidate cannot execute against stale benchmark targets');
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values (pg_temp.live_id(2),'platform_api_key','synthetic-override-manager-codex-key');
select throws_ok($$select pg_temp.submit_shadow_control_override(644,'Reject stale override')$$,
  'PT422','The reviewed override target is unavailable (qualification_unavailable)',
  'available personal credentials cannot authorize a stale explicit target');
drop trigger fixture_force_shadow_control_assignment on public.sessions;
select ok((select run.status='running' and to_jsonb(manifest)=snapshot.manifest
  and internal.effective_factory_routing_execution(receipt.workspace_id,receipt.factory_id,receipt.session_id)=snapshot.execution
  from live_rollback_snapshot snapshot join public.session_attempt_manifests manifest using(run_id)
  join public.agent_runs run on run.id=snapshot.run_id
  join public.session_factory_admission_inputs receipt on receipt.session_id=manifest.session_id),
  'later suite invalidation does not requalify or replace the running attempt pin');

select throws_ok($$select pg_temp.restore_prior_routing(9,5,(result->>'revisionId')::uuid) from routing_canary_rollout$$,
  'PT422','The selected activation contains a canary. Select its earlier baseline activation 4.',
  'rollback of a heterogeneous historical canary names its exact earlier baseline');
insert into public.factory_definition_smoke_tests(workspace_id,factory_id,target_kind,target_id,definition_digest,
  base_activation_number,sandbox_connection_revision,created_by,lease_expires_at,finished_at,status,evidence)
select scope.workspace_id,scope.factory_id,'revision',(rollout.result->>'previousRevisionId')::uuid,baseline.canonical_digest,
  9,pg_temp.live_id(50),scope.owner_id,clock_timestamp()+interval '5 minutes',clock_timestamp(),'passed','{"runtimeProfile":"vercel"}'
from live_scope scope cross join opencode_control_rollout rollout
join public.factory_definition_revisions baseline on baseline.id=(rollout.result->>'previousRevisionId')::uuid;
select is((pg_temp.restore_prior_routing(9,8,(result->>'previousRevisionId')::uuid)).activation_number,
  10::bigint,'exact rollback can restore the prior compatible shadow baseline') from opencode_control_rollout;
create temp table restored_shadow_admission as
select session_id from public.create_session_with_first_job(pg_temp.live_id(11),pg_temp.live_id(21),
  'Run after shadow rollback','Use the restored base profile.','opencode','openai/gpt-4.1-2025-04-14',
  session_github_repository_id=>pg_temp.live_id(42),selected_pipeline_id=>pg_temp.live_id(40),
  selected_stage_ids=>array[pg_temp.live_id(41)]);
select ok((select receipt.activation_number=10 and receipt.routing_canary_id is null
  and receipt.routing_decision->>'mode'='shadow' and receipt.routing_execution is null
  and receipt.model_provider='opencode'
  from restored_shadow_admission admitted join public.session_factory_admission_inputs receipt using(session_id)),
  'restoring shadow does not promote its stale recommendation or retain the candidate assignment');

select revised.id from live_scope scope cross join frontier_scorer scorer
cross join lateral public.save_factory_scorer_revision(scope.workspace_id,scope.factory_id,scope.owner_id,
  scorer.scorer_id,scorer.revision_number,jsonb_set(scorer.definition,'{rubric}','"Use the revised rubric."')) revised;
select public.revoke_factory_benchmark_replay_revision(scope.workspace_id,scope.factory_id,scope.owner_id,p_policy_revision_id=>policy.id)
from live_scope scope cross join live_policy policy;
set local request.jwt.claim.role='authenticated';
select set_config('request.jwt.claim.sub',pg_temp.live_id(1)::text,true);
set local role authenticated;
select ok(pg_temp.routing_qualification_status(4)->'reasons'
  @> '["suite_revision_changed","scorer_revision_changed","replay_policy_revoked"]'::jsonb,
  'qualification reports distinct suite, scorer and replay drift against the exact historical activation');
reset role;
set local request.jwt.claim.role='service_role';

update public.workspaces set deletion_requested_at = clock_timestamp() where id = pg_temp.live_id(11);
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'session-source-checkpoints'
  and split_part(name,'/',1) = pg_temp.live_id(11)::text;
delete from public.workspaces where id = pg_temp.live_id(11);
set constraints factory_definition_drafts_routing_evidence_source_fk immediate;
set constraints all immediate;
select is((select count(*) from public.factory_definition_drafts where workspace_id = pg_temp.live_id(11)) +
  (select count(*) from public.factory_routing_draft_evidence where workspace_id = pg_temp.live_id(11)),
  0::bigint,'workspace teardown removes both the derived draft and its retained proposal');

select * from finish();
rollback;
