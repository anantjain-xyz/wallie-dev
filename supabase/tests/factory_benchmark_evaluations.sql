begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.schedule_id(slot integer) returns uuid language sql immutable as $$
  select ('62000000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values
  (pg_temp.schedule_id(1), 'benchmark-evaluation-owner@example.test'),
  (pg_temp.schedule_id(2), 'benchmark-evaluation-reader@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.schedule_id(11), 'benchmark-evaluations-test', 'Benchmark experiments test');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.schedule_id(21), pg_temp.schedule_id(11), pg_temp.schedule_id(1), 'human', 'owner'),
  (pg_temp.schedule_id(22), pg_temp.schedule_id(11), pg_temp.schedule_id(2), 'human', 'member');
insert into public.factories(id, workspace_id, name, slug, is_default)
values (pg_temp.schedule_id(30), pg_temp.schedule_id(11), 'Experiment sibling', 'schedule-sibling', false);

create temp table experiment_scope as
select workspace_id, id as factory_id, is_default, pg_temp.schedule_id(1) as owner_id,
  case when is_default then 40 else 60 end as slot
from public.factories where workspace_id = pg_temp.schedule_id(11);
select public.grant_factory_membership(workspace_id, factory_id, owner_id, pg_temp.schedule_id(22), 'member')
from experiment_scope where is_default;

insert into public.pipelines(id, workspace_id, factory_id, name)
select pg_temp.schedule_id(slot), workspace_id, factory_id, 'Experiment pipeline' from experiment_scope;
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name, prompt_template_md)
select pg_temp.schedule_id(slot + 1), workspace_id, pg_temp.schedule_id(slot), 1, 'review', 'Review', 'Review the task.'
from experiment_scope;
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.schedule_id(35), pg_temp.schedule_id(11), 62000001, 'https://example.test/install', 6200,
  'Organization', 'Experiment fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name,
  private, html_url, default_branch)
select pg_temp.schedule_id(slot + 2), workspace_id, factory_id, pg_temp.schedule_id(35), 62000000 + slot,
  'schedule-fixture', 'fixture/schedule-' || slot, true, 'https://example.test/fixture', 'main'
from experiment_scope;

with configs as (
  select scope.*, candidate.offset_slot, candidate.model, candidate.harness, candidate.stage_offset
  from experiment_scope scope cross join (values
    (3, 'gpt-5.5', 'codex', 1), (4, 'gpt-5-mini', 'codex', 1),
    (5, 'claude-sonnet-4-6', 'claude-code', 1), (6, 'gpt-5.5', 'codex', 99)
  ) candidate(offset_slot, model, harness, stage_offset) where scope.is_default or candidate.offset_slot = 3
), definitions as (
  select configs.*, jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.schedule_id(slot),
    'repositoryId', pg_temp.schedule_id(slot + 2), 'sandboxProvider', 'vercel',
    'agent', jsonb_build_object('provider', harness, 'model', model, 'effort', null, 'concurrencyLimit', case when offset_slot = 5 then 1 else 2 end,
      'stallTimeoutMs', 120000, 'maxRetries', 1, 'maxTurns', 24),
    'executionPolicyRevisionId', null, 'deliveryPolicyRevisionId', null,
    'skillIds', '[]'::jsonb, 'toolIds', '[]'::jsonb, 'operatingRulesMd', '', 'operatingRuleStageIds', '[]'::jsonb,
    'stages', jsonb_build_array(jsonb_build_object('id', pg_temp.schedule_id(slot + stage_offset), 'slug', 'review',
      'name', 'Review', 'description', '', 'promptTemplateMd', 'Review the task.', 'anyoneCanApprove', false,
      'approverMemberIds', '[]'::jsonb, 'previousStageIds', '[]'::jsonb))
  )::text as compiled from configs
)
insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json,
  canonical_digest, created_by)
select pg_temp.schedule_id(slot + offset_slot), workspace_id, factory_id, 1, compiled,
  encode(sha256(convert_to(compiled, 'UTF8')), 'hex'), owner_id from definitions;

insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id,
  factory_definition_provenance, factory_definition_revision_id)
select pg_temp.schedule_id(slot + 7), workspace_id, factory_id, case when is_default then 1 else 2 end,
  'Original replay source', pg_temp.schedule_id(slot), pg_temp.schedule_id(slot + 1), 'pinned', pg_temp.schedule_id(slot + 3)
from experiment_scope;
insert into public.agent_jobs(id, workspace_id, session_id, stage_id, stage_slug, trigger_type, status, attempt_count, finished_at)
select pg_temp.schedule_id(slot + 13), workspace_id, pg_temp.schedule_id(slot + 7), pg_temp.schedule_id(slot + 1),
  'review', 'manual_run', 'success', 1, clock_timestamp()
from experiment_scope;
insert into public.agent_runs(id, workspace_id, session_id, agent_job_id, stage_id, stage_slug, run_type,
  model_provider, model_name, status, attempt_count, finished_at)
select pg_temp.schedule_id(slot + source.offset_slot), workspace_id, pg_temp.schedule_id(slot + 7),
  case when source.offset_slot = 8 then pg_temp.schedule_id(slot + 13) end, pg_temp.schedule_id(slot + 1), 'review', 'project', 'codex', 'gpt-5.5', 'success', 1, clock_timestamp()
from experiment_scope cross join (values (8), (9), (10)) source(offset_slot) where is_default or source.offset_slot = 8;
create temp table experiment_tasks as
select source.key, revision.* from experiment_scope scope
cross join (values
  ('eligible', 48, 'eligible', null::text), ('ineligible', 49, 'ineligible', 'Exact source was not retained.'),
  ('unverified', 50, 'unverified', 'Waiting for source verification.'), ('sibling', 68, 'eligible', null::text)
) source(key, run_slot, eligibility, reason)
cross join lateral public.create_factory_benchmark_task(scope.workspace_id, scope.factory_id, scope.owner_id,
  pg_temp.schedule_id(source.run_slot), source.key, 'Keep the frozen acceptance criteria.',
  '{}', source.eligibility, source.reason) revision
where scope.is_default = (source.key <> 'sibling');
create temp table experiment_suites as
select scope.is_default, suite.* from experiment_scope scope
cross join lateral public.save_factory_benchmark_suite_revision(scope.workspace_id, scope.factory_id, scope.owner_id,
  'Original experiment suite', 'regression', p_task_revision_ids => array(
    select id from experiment_tasks task
    where task.factory_id = scope.factory_id and task.key <> 'unverified'
  )) suite;
insert into public.factory_benchmark_task_inputs(task_id, workspace_id, factory_id, source_run_id, source_session_id,
  source_job_id, source_attempt_count, definition_revision_id, checkout_sha)
select task.task_id, task.workspace_id, task.factory_id, pg_temp.schedule_id(scope.slot + 8),
  pg_temp.schedule_id(scope.slot + 7), pg_temp.schedule_id(scope.slot + 13), 1, pg_temp.schedule_id(scope.slot + 3), repeat('a', 40)
from experiment_tasks task join experiment_scope scope on task.factory_id = scope.factory_id
where task.replay_eligibility = 'eligible';
insert into public.workspace_vercel_sandbox_connections(workspace_id, connection_revision, encrypted_token, team_id, project_id)
values (pg_temp.schedule_id(11), pg_temp.schedule_id(38), 'synthetic-encrypted-token', 'team_fixture', 'prj_fixture');

create temp table experiment_policies as
with fixtures as (
  select scope.is_default, fixture.id from experiment_scope scope
  cross join lateral public.publish_factory_benchmark_replay_fixture(
    scope.workspace_id, scope.factory_id, scope.owner_id, 'tool_read', repeat('f',64), '{"answer":"frozen"}'
  ) fixture
), blocked as (
  select scope.is_default, policy.id from experiment_scope scope
  cross join lateral public.publish_factory_benchmark_replay_policy(scope.workspace_id, scope.factory_id, scope.owner_id, 'blocked') policy
)
select scope.is_default, policy.* from experiment_scope scope
join fixtures fixture using (is_default)
join blocked prior using (is_default)
cross join lateral public.publish_factory_benchmark_replay_policy(
  scope.workspace_id, scope.factory_id, scope.owner_id, 'recorded_fixtures', prior.id, array[fixture.id]
) policy;

create function pg_temp.experiment_configs(p_slots integer[], p_runtime text default 'node')
returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('definitionRevisionId', revision.id, 'definitionDigest', revision.canonical_digest,
    'harness', revision.definition_json::jsonb#>>'{agent,provider}', 'model', revision.definition_json::jsonb#>>'{agent,model}',
    'sandboxProvider', revision.definition_json::jsonb->>'sandboxProvider', 'workerRuntime', p_runtime)
    order by selection.position)
  from unnest(p_slots) with ordinality selection(slot, position)
  join public.factory_definition_revisions revision on revision.id = pg_temp.schedule_id(selection.slot)
$$;
create function pg_temp.freeze_schedule(p_slot integer, p_primary boolean default true)
returns jsonb language sql as $$
  select public.freeze_factory_benchmark_experiment(scope.workspace_id, scope.factory_id, scope.owner_id,
    pg_temp.schedule_id(p_slot), suite.id, policy.id,
    pg_temp.experiment_configs(case when p_primary then array[43] else array[63] end, 'node'), 3, 31, 60000)
  from experiment_scope scope
  join experiment_suites suite using (is_default)
  join experiment_policies policy using (is_default)
  where scope.is_default = p_primary
$$;

create function pg_temp.configure_schedule(
  p_slot integer, p_budget numeric default 0.9, p_execution numeric default 0.6,
  p_max integer default 10, p_cap integer default 4, p_actor integer default 1,
  p_runner text default 'recorded-fixture-v1', p_primary boolean default true, p_evaluation numeric default 0.1
) returns jsonb language sql as $$
  select public.configure_factory_benchmark_schedule(scope.workspace_id, scope.factory_id, pg_temp.schedule_id(p_slot),
    pg_temp.schedule_id(p_actor), p_runner, pg_temp.schedule_id(38),
    jsonb_build_array(jsonb_build_object('taskRevisionId', task.id, 'fixtureKey', repeat('f', 64))),
    p_execution, p_evaluation, p_budget, p_cap, p_max)
  from experiment_scope scope join experiment_tasks task using (factory_id)
  where scope.is_default = p_primary and task.replay_eligibility = 'eligible'
$$;

create function pg_temp.schedule_control(p_slot integer, p_action text, p_primary boolean default true)
returns jsonb language sql as $$
  select public.control_factory_benchmark_schedule(
    scope.workspace_id, scope.factory_id, pg_temp.schedule_id(p_slot), scope.owner_id, p_action)
  from experiment_scope scope where scope.is_default = p_primary
$$;

create function pg_temp.schedule_snapshot(p_slot integer, p_primary boolean default true)
returns jsonb language sql as $$
  select public.read_factory_benchmark_schedule(
    scope.workspace_id, scope.factory_id, pg_temp.schedule_id(p_slot), scope.owner_id)
  from experiment_scope scope where scope.is_default = p_primary
$$;

create function pg_temp.last_scheduled_trial(p_slot integer)
returns public.factory_benchmark_trials language sql as $$
  select trial.* from public.factory_benchmark_trials trial
  join public.factory_benchmark_schedule_trials scheduled on trial.id = scheduled.trial_id
  where scheduled.experiment_id = pg_temp.schedule_id(p_slot) order by trial.created_at desc limit 1
$$;

create temp table selected_scorers as
select recipe.key, scorer.*
from experiment_scope scope
cross join (values ('artifact', '["artifact"]'), ('validation', '["artifact","validation_report"]'), ('diff', '["code_diff"]'))
  recipe(key, evidence)
cross join lateral public.create_factory_scorer(scope.workspace_id, scope.factory_id, scope.owner_id,
  initcap(recipe.key), recipe.key, jsonb_build_object('schemaVersion', 1, 'rubric', 'Check the isolated result.',
    'requiredEvidence', recipe.evidence::jsonb, 'scoring', jsonb_build_object('kind', 'boolean', 'passValue', true))) scorer
where scope.is_default;
create temp table judge_profile as
select * from public.configure_factory_judge_profile(pg_temp.schedule_id(11), pg_temp.schedule_id(1), 0,
  'openai/gpt-example', 'openai', false, false, 'v2.' || repeat('a',16) || '.synthetic.' || repeat('b',22));

create function pg_temp.scoring_plan(p_budget numeric, p_keys text[] default array['artifact','validation','diff'])
returns jsonb language sql as $$
  select jsonb_build_object('scorerRevisionIds', array(select scorer.id from unnest(p_keys) keys(key)
    join selected_scorers scorer using (key)), 'budgetLimitUsd', p_budget)
$$;

create function pg_temp.freeze_scored(p_slot integer, p_plan jsonb, p_actor integer default 1, p_primary boolean default true)
returns jsonb language sql as $$
  select public.freeze_factory_benchmark_experiment_with_evaluation(scope.workspace_id, scope.factory_id, pg_temp.schedule_id(p_actor),
    pg_temp.schedule_id(p_slot), suite.id, policy.id, pg_temp.experiment_configs(case when p_primary then array[43] else array[63] end),
    3, 31, 60000, p_plan)
  from experiment_scope scope join experiment_suites suite using (is_default)
  join experiment_policies policy using (is_default) where scope.is_default = p_primary
$$;

create function pg_temp.retry_scored(p_slot integer, p_plan jsonb) returns jsonb language sql as $$
  select public.find_factory_benchmark_experiment_retry_with_evaluation(scope.workspace_id, scope.factory_id, scope.owner_id,
    pg_temp.schedule_id(p_slot), suite.id, policy.id, array[pg_temp.schedule_id(43)], 3, 31, 60000, 'node', p_plan)
  from experiment_scope scope join experiment_suites suite using (is_default)
  join experiment_policies policy using (is_default) where scope.is_default
$$;

create function pg_temp.read_scores(p_slot integer, p_limit integer default 50, p_after jsonb default null)
returns jsonb language sql as $$
  select public.read_factory_benchmark_evaluation(scope.workspace_id, scope.factory_id, pg_temp.schedule_id(p_slot),
    scope.owner_id, (p_after->>'trialId')::uuid, (p_after->>'scorerRevisionId')::uuid, p_limit)
  from experiment_scope scope where scope.is_default
$$;

create function pg_temp.finish_fixture_trial(p_slot integer, p_cost numeric)
returns boolean language plpgsql as $$
declare
  trial public.factory_benchmark_trials := pg_temp.last_scheduled_trial(p_slot);
  fixture_operation_id uuid := gen_random_uuid();
  path text;
  upload_id uuid;
begin
  perform id from public.claim_next_agent_job(true, 4);
  trial := public.start_factory_benchmark_trial(trial.job_id, 1);
  if trial.id is null then raise exception 'The fixture trial was not started.'; end if;
  perform public.record_session_run_usage(trial.job_id, 1, trial.run_id, 3, 5, 'measured', p_cost, 'measured', null, false);
  perform public.open_factory_benchmark_replay_execution(trial.workspace_id, trial.factory_id, trial.actor_user_id,
    trial.replay_execution_id, trial.task_revision_id, trial.policy_revision_id, trial.policy_digest, repeat('d', 64));
  perform public.record_factory_benchmark_replay_operation(trial.workspace_id, trial.factory_id, trial.replay_execution_id,
    fixture_operation_id, 'tool_read', trial.fixture_key);
  path := trial.workspace_id::text || '/benchmark/' || trial.id::text || '/' || trial.run_id::text || '/' || repeat('e', 64) || '.bundle';
  upload_id := public.begin_workspace_resource_operation(trial.workspace_id, 'upload', '', path,
    'session-source-checkpoints', clock_timestamp() + interval '5 minutes');
  -- Synthetic private storage metadata in this rollback-only fixture.
  insert into storage.objects(bucket_id, name, metadata)
  values ('session-source-checkpoints', path, '{"mimetype":"application/octet-stream","size":8}');
  return public.finish_factory_benchmark_trial(trial.id, trial.job_id, 1, trial.run_id, jsonb_build_object(
    'restorationReceiptSha256', repeat('d', 64), 'inputBundleSha256', repeat('c', 64),
    'inputCommitSha', repeat('a', 40), 'inputTreeSha', repeat('a', 40),
    'outputCommitSha', repeat('b', 40), 'outputTreeSha', repeat('b', 40),
    'fixtureOperationId', fixture_operation_id, 'artifactMarkdown', '# Isolated fixture result',
    'checkpointBundleSha256', repeat('e', 64), 'checkpointStoragePath', path, 'checkpointUploadOperationId', upload_id,
    'validation', jsonb_build_object('version',1,'key','recorded-fixture-output','status','passed',
      'commitSha',repeat('b',40),'treeSha',repeat('b',40),'outputSha256',repeat('f',64)),
    'runtime', 'node'
  ));
end;
$$;

select ok(not has_table_privilege('service_role', 'public.factory_benchmark_evaluation_plans', 'UPDATE')
  and not has_function_privilege('authenticated',
    'public.read_factory_benchmark_evaluation(uuid,uuid,uuid,uuid,uuid,uuid,integer)', 'EXECUTE'),
  'frozen scoring plans have no direct app write and reads use service scope checks');
select throws_ok($$select pg_temp.freeze_scored(80, pg_temp.scoring_plan(0.7), p_actor => 2)$$,
  '42501', null, 'a reader cannot freeze scoring dimensions');
select throws_ok($$select pg_temp.freeze_scored(80, pg_temp.scoring_plan(0.7), p_primary => false)$$,
  'PT422', null, 'a scorer revision in a sibling factory cannot be selected');
select throws_ok($$select pg_temp.freeze_scored(80, pg_temp.scoring_plan(0.7000001))$$,
  '22023', null, 'precision beyond six decimals cannot round into an evaluation ceiling');
select throws_ok($$select pg_temp.freeze_scored(80, pg_temp.scoring_plan(0.7, array['artifact','artifact']))$$,
  '22023', null, 'duplicate scorer pins do not duplicate the denominator');

create temp table frozen_scores as select pg_temp.freeze_scored(80, pg_temp.scoring_plan(0.7)) as receipt;
select is((select receipt#>>'{evaluation,budgetLimitUsd}' from frozen_scores), '0.700000', 'freeze binds an independent evaluation ceiling');
select is(pg_temp.retry_scored(80, pg_temp.scoring_plan(0.7, array['diff','validation','artifact'])),
  (select receipt from frozen_scores), 'normalized retry returns the exact scored receipt');
select throws_ok($$select pg_temp.freeze_scored(80, pg_temp.scoring_plan(0.8))$$,
  'PT409', null, 'a retry cannot change the scoring ceiling');
select throws_ok($$select pg_temp.freeze_schedule(80)$$, 'PT409', null, 'the old method cannot omit an existing scored plan');
select is(pg_temp.read_scores(80)->>'denominator', '9', 'the initial denominator is the full eligible trial-by-dimension set');
select is(pg_temp.read_scores(80)->>'scheduleState', 'unconfigured', 'scoring plans are readable before scheduling');
select is(jsonb_array_length(pg_temp.read_scores(80, 2)->'cells'), 2, 'the scoring grid is paginated');
select ok((pg_temp.read_scores(80, 2)->'cells') <> (pg_temp.read_scores(80, 2, pg_temp.read_scores(80,2)->'nextCursor')->'cells'),
  'trial and scorer cursor advances to different cells');

select public.save_factory_scorer_revision(workspace_id, factory_id, created_by, scorer_id, 1,
  jsonb_set(definition, '{rubric}', '"A newer task rubric."'::jsonb)) from selected_scorers where key = 'artifact';
select is(pg_temp.retry_scored(80, pg_temp.scoring_plan(0.7)), (select receipt from frozen_scores),
  'a later rubric revision leaves frozen scorer identities untouched');
select pg_temp.configure_schedule(80, p_budget => 2, p_execution => 0.1, p_evaluation => 0.4, p_max => 3, p_cap => 1);
select is(public.reconcile_factory_benchmark_schedules(10), 1, 'the scheduled comparison admits its first exact trial');
select ok(pg_temp.finish_fixture_trial(80, 0.2), 'an exact successful fixture retains its canonical output');
create temp table scored_trial as select (pg_temp.last_scheduled_trial(80)).id as id;

select is(public.reconcile_factory_benchmark_schedules(10), 1, 'the second execution is admitted');
select id from public.claim_next_agent_job(true, 4);
select (public.start_factory_benchmark_trial((pg_temp.last_scheduled_trial(80)).job_id, 1)).run_id;
select accepted from pg_temp.last_scheduled_trial(80) trial cross join lateral
  public.record_session_run_usage(trial.job_id,1,trial.run_id,5,5,'measured',0.1,'measured',null,false);
select ok(public.fail_factory_benchmark_trial(trial.id, trial.job_id, 1, trial.run_id, 'candidate_failed'),
  'paid failed execution keeps its exact run')
from pg_temp.last_scheduled_trial(80) trial;
select is(public.reconcile_factory_benchmark_schedules(10), 1, 'the final execution is admitted');
select ok(public.cancel_factory_benchmark_trial(trial.workspace_id, trial.factory_id, trial.actor_user_id, trial.id, trial.run_id),
  'a never-started execution reaches the canceled denominator')
from pg_temp.last_scheduled_trial(80) trial;

select is(public.reconcile_factory_benchmark_evaluations(10), 2,
  'the exact successful result enqueues its two supported selected dimensions');
select is(public.reconcile_factory_benchmark_evaluations(10), 0,
  'enqueue retries cannot duplicate a trial and scorer-revision pair');
select is((select count(*) from public.factory_scorer_sample_receipts sample
  join public.factory_benchmark_trial_results result on (result.trial_id, result.result_digest) =
    (sample.benchmark_trial_id, sample.benchmark_result_digest)
  where sample.benchmark_trial_id in (select id from scored_trial) and sample.policy_id is null),
  2::bigint, 'benchmark samples pin neutral output receipts outside production cohorts');
select is((select count(*) from public.claim_factory_evaluation_job()), 0::bigint,
  'the old queue-only production worker cannot claim a benchmark evaluation');

create temp table first_claim as select * from public.claim_factory_judge_job();
select is((select count(*) from first_claim), 1::bigint, 'the judge worker claims the benchmark dimension');
select is((select count(*) from public.claim_factory_judge_job()), 0::bigint,
  'another claimant waits until the current attempt can publish its exact reservation');
create function pg_temp.authorize_evaluation(
  p_workspace_id uuid, p_factory_id uuid, p_job_id uuid, p_attempt_id uuid, p_lease_id uuid
) returns jsonb language sql as $$
  select public.begin_factory_judge_invocation(p_workspace_id, p_factory_id, p_job_id, p_attempt_id, p_lease_id,
    (select id from judge_profile), repeat('a',64), 'node')
$$;
select is((public.prepare_factory_judge_invocation(workspace_id, factory_id, job_id, attempt_id, lease_id)
  #>>'{benchmark_source,trial_id}')::uuid, (select id from scored_trial),
  'judge preparation returns evidence from the scheduled canonical benchmark run')
from first_claim;
select is(pg_temp.authorize_evaluation(workspace_id, factory_id, job_id, attempt_id, gen_random_uuid())->>'status', 'stale_claim',
  'a stale attempt lease cannot reserve or acquire the credential')
from first_claim;
select is(public.reserve_factory_benchmark_evaluation_attempt((select id from scored_trial), attempt_id),
  false, 'the old bridge cannot reserve scored dispatch ahead of the exact begin boundary')
from first_claim;
select is(pg_temp.authorize_evaluation(workspace_id, factory_id, job_id, attempt_id, lease_id)->>'status', 'authorized',
  'begin binds the first exact reservation and its judge credential')
from first_claim;
select is(pg_temp.authorize_evaluation(workspace_id, factory_id, job_id, attempt_id, lease_id)->>'status', 'already_started',
  'a duplicate begin cannot get another credential or reserve twice')
from first_claim;
select is((select count(*) from public.claim_factory_judge_job()), 0::bigint,
  'a second dimension waits while the first attempt holds the available evaluation capacity');
select ok(public.finish_factory_judge_invocation(workspace_id, factory_id, job_id, attempt_id, lease_id, 'provider_unavailable',
    p_cost_usd => 0.2, p_cost_provenance => 'measured'),
  'a failed paid evaluation records exact immutable spend for retry')
from first_claim;

select public.reconcile_factory_benchmark_schedules(10);
create temp table second_claim as select * from public.claim_factory_judge_job();
select is((select count(*) from second_claim), 1::bigint, 'settling the first hold makes room for the other dimension');
select is(pg_temp.authorize_evaluation(workspace_id, factory_id, job_id, attempt_id, lease_id)->>'status', 'authorized',
  'the other supported scorer may use the remaining capacity')
from second_claim;
select ok(public.finish_factory_judge_invocation(claim.workspace_id, claim.factory_id, claim.job_id, claim.attempt_id, claim.lease_id,
    'completed', jsonb_build_object('schemaVersion',1,'status','pass','score',jsonb_build_object('kind','boolean','value',true),
      'evidence',sample.evidence), p_provider_model => 'openai/gpt-example', p_cost_usd => 0.3, p_cost_provenance => 'measured'),
  'the exact successful evaluation adopts the pinned rubric result')
from second_claim claim join public.factory_scorer_sample_receipts sample on sample.id = claim.sample_receipt_id;
select is(public.finish_factory_judge_invocation(workspace_id, factory_id, job_id, attempt_id, lease_id, 'provider_unavailable'),
  false, 'a late duplicate callback cannot adopt another receipt')
from first_claim;

select public.reconcile_factory_benchmark_schedules(10);
update public.factory_evaluation_jobs set available_at = clock_timestamp() where id = (select job_id from first_claim);
create temp table retry_claim as select * from public.claim_factory_judge_job();
select is((select job_id from retry_claim), (select job_id from first_claim),
  'the failed evaluation retains its identity on a later attempt');
select is(pg_temp.authorize_evaluation(workspace_id, factory_id, job_id, attempt_id, lease_id),
  '{"status":"benchmark_blocked","reason":"evaluation_budget_exhausted"}'::jsonb,
  'evaluation-only spend blocks the exact retry even with shared cap headroom')
from retry_claim;
select is((pg_temp.read_scores(80)#>>'{spend,execution,spentUsd}')::numeric, 0.3::numeric, 'all paid execution costs are attributed once');
select is((pg_temp.read_scores(80)#>>'{spend,evaluation,spentUsd}')::numeric, 0.5::numeric,
  'both successful and failed evaluation spend appear separately');
select is((pg_temp.read_scores(80)#>>'{spend,combined,spentUsd}')::numeric, 0.8::numeric, 'combined cost is the sum of the two actual axes');
select is((select count(*) from jsonb_array_elements(pg_temp.read_scores(80)->'cells') cell where cell->>'status' = 'pass'),
  1::bigint, 'only the terminal score contributes its pass result');
select is((select count(*) from jsonb_array_elements(pg_temp.read_scores(80)->'cells') cell where cell->>'reason' = 'missing_evidence'),
  1::bigint, 'an unsupported exact evidence dimension remains visible');
select is((select count(*) from jsonb_array_elements(pg_temp.read_scores(80)->'cells') cell where cell->>'reason' = 'trial_failed'),
  3::bigint, 'a failed trial remains in each selected rubric denominator');
select is((select count(*) from jsonb_array_elements(pg_temp.read_scores(80)->'cells') cell where cell->>'reason' = 'trial_canceled'),
  3::bigint, 'a canceled trial remains in each selected rubric denominator');

select is(jsonb_array_length(public.list_factory_evaluation_receipts(workspace_id, factory_id, owner_id)->'receipts'),
  0, 'benchmark receipts never enter the production evaluation listing')
from experiment_scope where is_default;

select pg_temp.freeze_scored(81, pg_temp.scoring_plan(1, array['artifact']));
select pg_temp.configure_schedule(81, p_budget => 0.25, p_execution => 0.1, p_evaluation => 0.2, p_max => 1);
select is(public.reconcile_factory_benchmark_schedules(10), 1, 'another experiment reserves an execution');
select ok(pg_temp.finish_fixture_trial(81, 0.1), 'the second experiment retains its output');
select public.reconcile_factory_benchmark_schedules(10);
select is(public.reconcile_factory_benchmark_evaluations(10), 1, 'the other experiment queues its selected dimension');
create temp table aggregate_claim as select * from public.claim_factory_judge_job();
select is((select count(*) from aggregate_claim), 1::bigint, 'the aggregate ceiling case receives a claim before authorization');
select pg_temp.schedule_control(81, 'pause');
select is(public.prepare_factory_judge_invocation(workspace_id, factory_id, job_id, attempt_id, lease_id),
  '{"status":"benchmark_blocked","reason":"schedule_paused"}'::jsonb,
  'pause after claim settles the exact unstarted evaluation without issuing a credential')
from aggregate_claim;
select pg_temp.schedule_control(81, 'resume');
update public.factory_evaluation_jobs set available_at = clock_timestamp() where id = (select job_id from aggregate_claim);
create temp table aggregate_retry as select * from public.claim_factory_judge_job();
select is((select job_id from aggregate_retry), (select job_id from aggregate_claim),
  'resume recovers the paused evaluation by its existing job identity');
select is(pg_temp.authorize_evaluation(workspace_id, factory_id, job_id, attempt_id, lease_id),
  '{"status":"benchmark_blocked","reason":"evaluation_budget_exhausted"}'::jsonb,
  'the shared experiment ceiling applies even when the evaluation-only ceiling has headroom')
from aggregate_retry;
select is((pg_temp.read_scores(81)#>>'{spend,evaluation,reservedUsd}')::numeric, 0::numeric,
  'denied and paused attempts have no reservation');

select pg_temp.freeze_scored(82, pg_temp.scoring_plan(1, array['artifact']));
select pg_temp.configure_schedule(82, p_budget => 1, p_execution => 0.1, p_evaluation => 0.3, p_max => 1);
select is(public.reconcile_factory_benchmark_schedules(10), 1, 'an isolated cancellation case queues execution');
select ok(pg_temp.finish_fixture_trial(82, 0.05), 'the cancellation case retains its benchmark output');
select is(public.reconcile_factory_benchmark_evaluations(10), 1, 'the cancellation case queues its exact evaluation');
create temp table canceled_claim as select * from public.claim_factory_judge_job();
select is((select count(*) from canceled_claim), 1::bigint, 'the cancellation case reaches a real judge claim');
select is(pg_temp.authorize_evaluation(workspace_id, factory_id, job_id, attempt_id, lease_id)->>'status', 'authorized',
  'the started cancellation case owns an evaluation hold')
from canceled_claim;
select pg_temp.schedule_control(82, 'cancel');
select is(public.reconcile_factory_benchmark_evaluations(10), 0, 'cancellation reconciles without admitting new evaluation work');
select is((select status from public.factory_evaluation_jobs where id = (select job_id from canceled_claim)), 'canceled',
  'the exact started evaluation job reaches cancellation');
select is((pg_temp.read_scores(82)#>>'{spend,evaluation,reservedUsd}')::numeric, 0.3::numeric,
  'a started canceled evaluation preserves its unknown hold');
select is(pg_temp.read_scores(82)#>>'{spend,evaluation,unavailableCount}', '1',
  'started canceled evaluation cost stays unavailable rather than zero');
select is((select count(*) from jsonb_array_elements(pg_temp.read_scores(82)->'cells') cell
  where cell->>'status' = 'skipped'), 3::bigint, 'finished and unadmitted canceled cells remain in the denominator');

select is(pg_temp.freeze_scored(83, pg_temp.scoring_plan(0, array['artifact']))#>>'{evaluation,budgetLimitUsd}',
  '0.000000', 'zero is an explicit evaluation ceiling');
select * from finish();
rollback;
