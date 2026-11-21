begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.schedule_id(slot integer) returns uuid language sql immutable as $$
  select ('62100000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values
  (pg_temp.schedule_id(1), 'benchmark-comparison-owner@example.test'),
  (pg_temp.schedule_id(2), 'benchmark-comparison-reader@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.schedule_id(11), 'benchmark-comparisons-test', 'Benchmark experiments test');
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
values (pg_temp.schedule_id(35), pg_temp.schedule_id(11), 62100001, 'https://example.test/install', 6210,
  'Organization', 'Experiment fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name,
  private, html_url, default_branch)
select pg_temp.schedule_id(slot + 2), workspace_id, factory_id, pg_temp.schedule_id(35), 62100000 + slot,
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

create function pg_temp.freeze_comparison(
  p_slot integer, p_candidates integer[] default array[43,44], p_repetitions integer default 3
) returns jsonb language sql as $$
  select public.freeze_factory_benchmark_experiment_with_evaluation(scope.workspace_id, scope.factory_id, scope.owner_id,
    pg_temp.schedule_id(p_slot), suite.id, policy.id, pg_temp.experiment_configs(p_candidates),
    p_repetitions, 31, 60000, pg_temp.scoring_plan(2))
  from experiment_scope scope join experiment_suites suite using (is_default)
  join experiment_policies policy using (is_default) where scope.is_default
$$;

create function pg_temp.comparison(
  p_slot integer, p_after uuid default null, p_limit integer default 50,
  p_after_candidate text default null, p_candidate_limit integer default 50, p_actor integer default 1
) returns jsonb language sql as $$
  select public.read_factory_benchmark_comparison(scope.workspace_id, scope.factory_id, pg_temp.schedule_id(p_slot),
    pg_temp.schedule_id(p_actor), p_after, p_limit, p_after_candidate, p_candidate_limit)
  from experiment_scope scope where scope.is_default
$$;

create function pg_temp.create_comparison_export(p_slot integer, p_request integer, p_actor integer default 1)
returns jsonb language sql as $$
  select public.create_factory_benchmark_comparison_export(scope.workspace_id, scope.factory_id,
    pg_temp.schedule_id(p_slot), pg_temp.schedule_id(p_actor), pg_temp.schedule_id(p_request))
  from experiment_scope scope where scope.is_default
$$;

create function pg_temp.read_comparison_export(
  p_slot integer, p_id uuid, p_ordinal integer default null,p_kind text default 'trials',p_actor integer default 1
) returns text language sql as $$
  select public.read_factory_benchmark_comparison_export(scope.workspace_id,scope.factory_id,pg_temp.schedule_id(p_slot),
    pg_temp.schedule_id(p_actor),p_id,p_ordinal,p_kind)
  from experiment_scope scope where scope.is_default
$$;

select pg_temp.freeze_comparison(80);
select throws_ok($$select pg_temp.comparison(80,p_actor => 2)$$,'42501',null,
  'an ordinary factory reader cannot access the cost-bearing comparison');
select throws_ok($$select pg_temp.comparison(80,p_after => gen_random_uuid())$$,'22023',null,
  'an unrelated trial cannot become a comparison page cursor');
select throws_ok($$select pg_temp.comparison(80,p_after_candidate => repeat('a',64))$$,'22023',null,
  'an unrelated configuration cannot become a candidate page cursor');
select is(pg_temp.comparison(80)->'counts',
  '{"planned":12,"eligible":6,"excluded":6,"admitted":0,"started":0,"pending":6,"running":0,"succeeded":0,"failed":0,"timedOut":0,"canceled":0,"unavailable":0,"terminal":0}'::jsonb,
  'an unconfigured comparison preserves all exact frozen trial identities');
select is(pg_temp.comparison(80)->>'candidateCount','2','both planned configurations are represented before execution');
select is(jsonb_array_length(pg_temp.comparison(80)->'scorers'),3,'selected scorer revision pins survive projection');
select ok(not (pg_temp.comparison(80)::text ~ 'artifactMarkdown|checkpointStoragePath|encryptedApiKey|validation_report'),
  'comparison metadata carries no raw evidence or secret fields');
select is(pg_temp.comparison(80)->'spend'->'combined'->>'knownUsd','0','no attempt produces a zero known subtotal');
select is(jsonb_array_length(pg_temp.comparison(80,p_limit => 2,p_candidate_limit => 1)->'trialRows'),2,
  'the exact trial page is separately bounded');
select is(jsonb_array_length(pg_temp.comparison(80,p_limit => 2,p_candidate_limit => 1)->'candidates'),1,
  'candidate page size does not depend on the trial page size');

select pg_temp.configure_schedule(80,p_budget => 2,p_execution => 0.1,p_evaluation => 0.1,p_max => 6,p_cap => 1);
select is(public.reconcile_factory_benchmark_schedules(10),1,'execution admits a first comparison cell');
select ok(pg_temp.finish_fixture_trial(80,0.07),'the first result retains exact execution evidence');
create temp table succeeded_comparison_trial as select (pg_temp.last_scheduled_trial(80)).id as id;

select is(public.reconcile_factory_benchmark_schedules(10),1,'execution admits a second comparison cell');
select id from public.claim_next_agent_job(true,4);
select (public.start_factory_benchmark_trial((pg_temp.last_scheduled_trial(80)).job_id,1)).run_id;
select accepted from pg_temp.last_scheduled_trial(80) trial cross join lateral
  public.record_session_run_usage(trial.job_id,1,trial.run_id,5,5,'measured',0.1,'estimated','pricing-v1',false);
select ok(public.fail_factory_benchmark_trial(trial.id,trial.job_id,1,trial.run_id,'candidate_failed'),
  'an exact failed comparison attempt can carry estimated dollars')
from pg_temp.last_scheduled_trial(80) trial;

select is(public.reconcile_factory_benchmark_schedules(10),1,'execution admits the observed timeout case');
select id from public.claim_next_agent_job(true,4);
create function pg_temp.capture_comparison_prestart(p_expired boolean) returns jsonb language plpgsql as $$
declare trial public.factory_benchmark_trials; supplied_deadline timestamptz; saved jsonb;
begin
  select * into strict trial from pg_temp.last_scheduled_trial(80);
  supplied_deadline := clock_timestamp() + interval '1 minute';
  if p_expired then
    supplied_deadline := clock_timestamp() - interval '1 second';
  else
    perform internal.exhaust_session_execution(trial.session_id,'tokens',10,10);
  end if;
  perform public.start_factory_benchmark_trial(trial.job_id,1,supplied_deadline);
  select jsonb_build_object('status',current.status,'failureCode',current.failure_code,'started',run.started_at is not null)
    into saved from public.factory_benchmark_trials current join public.agent_runs run on run.id = current.run_id
  where current.id = trial.id;
  raise exception using errcode = 'QT001', message = 'Restore the claimed fixture before running it.';
exception when sqlstate 'QT001' then
  return saved;
end;
$$;
select is(pg_temp.capture_comparison_prestart(true),'{"status":"error","failureCode":"deadline_elapsed","started":false}'::jsonb,
  'a deadline expiring in transit records a durable cause before the attempt starts');
select is(pg_temp.capture_comparison_prestart(false),'{"status":"error","failureCode":"attempt_lost","started":false}'::jsonb,
  'a pre-start budget rejection never records a deadline cause');
select (public.start_factory_benchmark_trial((pg_temp.last_scheduled_trial(80)).job_id,1)).run_id;
select is(public.fail_deadline_session_job_attempt(trial.job_id,2,'An isolated worker clock fired.',trial.run_id),
  'stale','a different attempt cannot retire the running trial as a timeout') from pg_temp.last_scheduled_trial(80) trial;
select is(public.fail_deadline_session_job_attempt(trial.job_id,1,'An isolated worker clock fired.',pg_temp.schedule_id(999)),
  'stale','a different run cannot record a timeout for the running trial') from pg_temp.last_scheduled_trial(80) trial;
select is(public.fail_deadline_session_job_attempt(trial.job_id,1,'An isolated worker clock fired.'),
  'stale','runless timeout recovery cannot retire a job that already started') from pg_temp.last_scheduled_trial(80) trial;

-- Exercise the same running attempt through both supervisor paths, restoring
-- the fixture before the following legacy-worker report test.
create function pg_temp.capture_comparison_retirement(p_deadline boolean) returns jsonb language plpgsql as $$
declare trial public.factory_benchmark_trials; saved jsonb;
begin
  select * into strict trial from pg_temp.last_scheduled_trial(80);
  if p_deadline then
    perform public.fail_deadline_session_job_attempt(trial.job_id,1,'An isolated worker clock fired.',trial.run_id);
  else
    update public.factory_benchmark_trials set deadline_at = transaction_timestamp() - interval '1 second' where id = trial.id;
    perform public.fail_stalled_session_job_attempt(trial.job_id,1,
      'Worker attempt exceeded its 50ms deadline. Sandbox disconnected.',false,0,trial.run_id);
  end if;
  select jsonb_build_object('status',row->'status','reason',row->'reason','deadlineElapsed',row->'deadlineElapsed',
    'failureCode',(select current.failure_code from public.factory_benchmark_trials current where current.id = trial.id))
  into saved from jsonb_array_elements(pg_temp.comparison(80)->'trialRows') row where row->>'trialId' = trial.id::text;
  raise exception using errcode = 'QT001', message = 'Restore the fixture for the legacy supervisor.';
exception when sqlstate 'QT001' then
  return saved;
end;
$$;
select is(pg_temp.capture_comparison_retirement(true),
  '{"status":"timed_out","reason":"deadline_elapsed","deadlineElapsed":true,"failureCode":"deadline_elapsed"}'::jsonb,
  'typed supervisor recovery retains a durable cause even with a different diagnostic message');
select is(pg_temp.capture_comparison_retirement(false),
  '{"status":"failed","reason":"attempt_lost","deadlineElapsed":true,"failureCode":"attempt_lost"}'::jsonb,
  'time elapsed and a deadline-like provider diagnostic do not prove a timeout');
select is(public.fail_stalled_session_job_attempt(trial.job_id,1,'Worker attempt exceeded its 50ms deadline.',false,0,trial.run_id),
  'error','an exact running worker timeout retires the claimed trial')
from pg_temp.last_scheduled_trial(80) trial;
select is((pg_temp.last_scheduled_trial(80)).failure_code,'deadline_elapsed',
  'the canonical deployed worker timeout becomes durable on the terminal trial');

select is(public.reconcile_factory_benchmark_schedules(10),1,'execution admits the cancellation case');
select ok(public.cancel_factory_benchmark_trial(trial.workspace_id,trial.factory_id,trial.actor_user_id,trial.id,trial.run_id),
  'a never-started trial is independently canceled')
from pg_temp.last_scheduled_trial(80) trial;
select is(pg_temp.comparison(80)->'counts',
  '{"planned":12,"eligible":6,"excluded":6,"admitted":4,"started":3,"pending":2,"running":0,"succeeded":1,"failed":1,"timedOut":1,"canceled":1,"unavailable":0,"terminal":4}'::jsonb,
  'failure, explicit timeout, cancel, exclusion, and pending rows partition the frozen matrix');
select is(pg_temp.comparison(80)#>>'{spend,execution,measuredUsd}', '0.07', 'exact recorded execution cost is kept');
select is(pg_temp.comparison(80)#>>'{spend,execution,estimatedUsd}', '0.1', 'failed estimated execution cost stays separate');
select is(pg_temp.comparison(80)#>>'{spend,execution,unavailableAttemptCount}', '1', 'the started timeout has unavailable cost');
select is(pg_temp.comparison(80)#>>'{spend,execution,neverStartedAttemptCount}', '1', 'cancel before start contributes no measured cost');
select is(pg_temp.comparison(80)#>>'{spend,execution,unavailableHoldUsd}', '0.1', 'unavailable execution retains its hold');

select is(public.reconcile_factory_benchmark_evaluations(10),2,'the exact success gets its two compatible scoring dimensions');
create function pg_temp.score_comparison(p_status text,p_cost numeric)
returns record language plpgsql as $$
declare
  claim record;
  sample public.factory_scorer_sample_receipts;
  verdict jsonb;
begin
  select * into strict claim from public.claim_factory_judge_job();
  select * into strict sample from public.factory_scorer_sample_receipts where factory_scorer_sample_receipts.id = claim.sample_receipt_id;
  if (public.begin_factory_judge_invocation(claim.workspace_id,claim.factory_id,claim.job_id,claim.attempt_id,claim.lease_id,
    (select profile.id from judge_profile profile),repeat('a',64),'node')->>'status') is distinct from 'authorized'
  then raise exception 'The comparison scorer could not start.'; end if;
  verdict := case when p_status = 'completed' then jsonb_build_object('schemaVersion',1,'status','pass','score',
    jsonb_build_object('kind','boolean','value',true),'evidence',sample.evidence) end;
  if public.finish_factory_judge_invocation(claim.workspace_id,claim.factory_id,claim.job_id,claim.attempt_id,claim.lease_id,
    p_status,verdict,p_provider_model => case when p_status = 'completed' then 'openai/gpt-example' end,
    p_cost_usd => p_cost,p_cost_provenance => case when p_cost is not null then 'measured' else 'unavailable' end)
    is distinct from true then raise exception 'The comparison scorer could not settle.'; end if;
  return row(claim.job_id,claim.attempt_id);
end;
$$;
select * from pg_temp.score_comparison('completed',0.04) as scored(job_id uuid,attempt_id uuid);
create temp table first_unknown_score as
select * from pg_temp.score_comparison('provider_unavailable',null) as scored(job_id uuid,attempt_id uuid);
update public.factory_evaluation_jobs set available_at = clock_timestamp() where id in (select job_id from first_unknown_score);
select * from pg_temp.score_comparison('invalid_output',null) as scored(job_id uuid,attempt_id uuid);

select is(pg_temp.comparison(80)#>>'{spend,evaluation,measuredUsd}', '0.04', 'exact evaluation spend excludes fixture execution spend');
select is(pg_temp.comparison(80)#>>'{spend,evaluation,unavailableAttemptCount}', '2', 'both unknown judge attempts are counted');
select is(pg_temp.comparison(80)#>>'{spend,combined,knownUsd}', '0.21', 'combined known cost is exact decimal addition');
select is(pg_temp.comparison(80)#>>'{spend,combined,unavailableAttemptCount}', '3', 'combined unavailable attempt count is additive');
select is(pg_temp.comparison(80)#>>'{spend,costUnavailableTrialCount}', '2', 'distinct affected trial count does not add repeated evaluation attempts');
select is((select sum((dimension->>'denominator')::integer)
  from jsonb_array_elements(pg_temp.comparison(80)->'candidates') candidate
  cross join lateral jsonb_array_elements(candidate->'quality') dimension),18::bigint,
  'per-candidate score denominators cover all eligible cells of each exact rubric');
select is((select count(*) from jsonb_array_elements(pg_temp.comparison(80)->'trialRows') trial
  cross join lateral jsonb_array_elements(trial->'scores') score where score->>'status' = 'pass'),1::bigint,
  'only the exact adopted evaluator receipt supplies a pass');
select is((select count(*) from jsonb_array_elements(pg_temp.comparison(80)->'trialRows') trial
  where (trial->>'wallRuntimeMs') is not null),3::bigint,
  'latency observes exact started and finished runs, even if they failed or timed out');

-- Legacy comparison creation permits more than one hundred configurations.
-- Keep every configuration and trial in the export.
with source as (
  select revision.workspace_id,revision.factory_id,revision.created_by,
    revision.definition_json::jsonb || jsonb_build_object('operatingRulesMd','Comparison variant ' || slot) as definition,slot
  from public.factory_definition_revisions revision cross join generate_series(300,404) slot
  where revision.id = pg_temp.schedule_id(43)
)
insert into public.factory_definition_revisions(id,workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
select pg_temp.schedule_id(slot),workspace_id,factory_id,1,definition::text,
  encode(sha256(convert_to(definition::text,'UTF8')),'hex'),created_by from source;
select pg_temp.freeze_comparison(81,array(select generate_series(300,404)),1);
create temp table large_comparison_page as
select pg_temp.comparison(81,p_limit => 2,p_candidate_limit => 100) as payload;
select is((select payload->>'candidateCount' from large_comparison_page),'105','all legacy configurations contribute to the summary');
select is((select payload#>>'{counts,planned}' from large_comparison_page),'210','candidate pagination does not change global trial counts');
select is((select jsonb_array_length(payload->'candidates') from large_comparison_page),100,'legacy candidate page is bounded');
select is(jsonb_array_length(pg_temp.comparison(81,p_limit => 2,p_candidate_limit => 100,
  p_after_candidate => (select payload#>>'{nextCandidateCursor,candidateKey}' from large_comparison_page))->'candidates'),5,
  'candidate cursor reaches the remaining exact configurations');
select is(jsonb_array_length((select payload->'trialRows' from large_comparison_page)),2,
  'separate candidate paging does not change the trial page');
with page as (
  select pg_temp.comparison(81,p_limit => 2,p_candidate_limit => 1,
    p_after_candidate => (select payload#>>'{nextCandidateCursor,candidateKey}' from large_comparison_page)) as payload
)
select is((select count(*) from page
  cross join lateral jsonb_array_elements(page.payload->'trialRows') trial(value)
  join public.factory_benchmark_experiment_candidates candidate
    on candidate.experiment_id=pg_temp.schedule_id(81) and candidate.candidate_key=trial.value->>'candidateKey'
  join experiment_scope scope on (scope.workspace_id,scope.factory_id)=(candidate.workspace_id,candidate.factory_id)
  where scope.is_default and trial.value->>'plannedHarness'=candidate.harness and trial.value->>'plannedModel'=candidate.model
    and trial.value->'candidatePosition'=coalesce(to_jsonb(candidate.comparison_position),'null'::jsonb)
    and not exists (select 1 from jsonb_array_elements(page.payload->'candidates') visible(value)
      where visible.value->>'candidateKey'=candidate.candidate_key)),2::bigint,
  'off-page trial configurations retain their exact frozen harness, model, and position');

create temp table immutable_small as
select receipt->>'exportId' as id,receipt from (select pg_temp.create_comparison_export(80,900) as receipt) captured;
create temp table immutable_large as
select receipt->>'exportId' as id,receipt from (select pg_temp.create_comparison_export(81,901) as receipt) captured;
create temp table manifests as
select 80 as slot,id::uuid,pg_temp.read_comparison_export(80,id::uuid) as bytes from immutable_small
union all
select 81,id::uuid,pg_temp.read_comparison_export(81,id::uuid) from immutable_large;
select is((select (receipt->>'trialCount')::integer from immutable_large),210,'large export captures every trial identity');
select is((select (receipt->>'candidateCount')::integer from immutable_large),105,'large export captures every candidate summary');
select is((select (receipt->>'pageCount')::integer from immutable_large),7,'large export stores seven bounded trial pages');
select is((select (receipt->>'candidatePageCount')::integer from immutable_large),4,'large export stores four independent candidate pages');
select is((select jsonb_array_length(bytes::jsonb->'trialIds') from manifests where slot=81),210,
  'the downloadable manifest lists every frozen trial ID');
select ok((select not (bytes::jsonb->'summary' ? 'candidates') from manifests where slot=81),
  'the manifest does not duplicate candidate summaries stored in pages');

select results_eq($$
  select trial_id from public.factory_benchmark_experiment_trials where experiment_id = pg_temp.schedule_id(81) order by trial_id
$$, $$
  select (value#>>'{}')::uuid from manifests cross join lateral jsonb_array_elements(bytes::jsonb->'trialIds')
  where slot=81 order by 1
$$, 'manifest trial IDs exactly equal all immutable matrix identities');
select results_eq($$
  select value#>>'{}' from manifests cross join lateral
    jsonb_array_elements(bytes::jsonb->'trialIds') with ordinality expected(value,position)
  where slot=81 order by position
$$, $$
  select trial->>'trialId' from manifests
  cross join lateral jsonb_array_elements(bytes::jsonb->'pages') page
  cross join lateral jsonb_array_elements(pg_temp.read_comparison_export(81,id,(page->>'ordinal')::integer)::jsonb->'trialRows')
    with ordinality actual(trial,position)
  where slot=81 order by (page->>'ordinal')::integer,position
$$, 'ordered trial pages reproduce the manifest list exactly once');
select results_eq($$
  select candidate_key from public.factory_benchmark_experiment_candidates
  where experiment_id=pg_temp.schedule_id(81) order by candidate_key
$$, $$
  select candidate->>'candidateKey' from manifests
  cross join lateral jsonb_array_elements(bytes::jsonb->'candidatePages') page
  cross join lateral jsonb_array_elements(
    pg_temp.read_comparison_export(81,id,(page->>'ordinal')::integer,'candidates')::jsonb->'candidates') candidate
  where slot=81 order by 1
$$, 'independent candidate pages reproduce every exact configuration once');
select ok((select bool_and((descriptor->>'sizeBytes')::integer = octet_length(page_bytes)
  and descriptor->>'sha256' = encode(sha256(convert_to(page_bytes,'UTF8')),'hex'))
  from manifests cross join lateral (
    select 'trials' as kind,descriptor from jsonb_array_elements(bytes::jsonb->'pages') descriptor
    union all
    select 'candidates',descriptor from jsonb_array_elements(bytes::jsonb->'candidatePages') descriptor
  ) parts cross join lateral (
    select pg_temp.read_comparison_export(81,id,(descriptor->>'ordinal')::integer,kind) as page_bytes
  ) payload where slot=81), 'both page types serve the immutable bytes named by the manifest hashes');
select is(pg_temp.create_comparison_export(80,900),(select receipt from immutable_small),
  'idempotent retries return the original export receipt');
select throws_ok($$select pg_temp.create_comparison_export(81,900)$$,'PT409',null,
  'one request identity cannot capture a different comparison');
select throws_ok($$select pg_temp.read_comparison_export(80,(select id::uuid from immutable_small),p_actor => 2)$$,
  'P0002',null,'an ordinary factory reader cannot download someone else’s export');
select throws_ok($$update internal.factory_benchmark_comparison_exports set manifest='{}'
  where id=(select id::uuid from immutable_small)$$,'23514',null,'a captured manifest is immutable');
select throws_ok($$update internal.factory_benchmark_comparison_export_pages set payload='{}'
  where export_id=(select id::uuid from immutable_small)$$,'23514',null,'captured page bytes are immutable');

select public.grant_factory_membership(workspace_id,factory_id,owner_id,pg_temp.schedule_id(21),'manager')
from experiment_scope where is_default;
select public.grant_factory_membership(workspace_id,factory_id,owner_id,pg_temp.schedule_id(22),'manager')
from experiment_scope where is_default;
create temp table revocable_export as
select (pg_temp.create_comparison_export(80,902,p_actor => 2)->>'exportId')::uuid as id;
select is((pg_temp.read_comparison_export(80,id,p_actor => 2)::jsonb->>'exportId')::uuid,id,
  'the requester downloads a captured manifest with its current manager grant') from revocable_export;
select is(pg_temp.read_comparison_export(80,id,1,p_actor => 2)::jsonb->>'kind','trials',
  'the requester downloads trial bytes with its current manager grant') from revocable_export;
select is(pg_temp.read_comparison_export(80,id,1,'candidates',p_actor => 2)::jsonb->>'kind','candidates',
  'the requester downloads configuration bytes with its current manager grant') from revocable_export;
select throws_ok($$select pg_temp.read_comparison_export(80,(select id from revocable_export))$$,
  'P0002',null,'a different current manager cannot download the requester’s manifest');
select public.revoke_factory_membership(workspace_id,factory_id,owner_id,pg_temp.schedule_id(22),'Qualification fixture')
from experiment_scope where is_default;
select throws_ok($$select pg_temp.read_comparison_export(80,(select id from revocable_export),p_actor => 2)$$,
  'P0002',null,'the requester loses manifest access when its grant is revoked');
select throws_ok($$select pg_temp.read_comparison_export(80,(select id from revocable_export),1,p_actor => 2)$$,
  'P0002',null,'the requester loses trial part access when its grant is revoked');
select throws_ok($$select pg_temp.read_comparison_export(80,(select id from revocable_export),1,'candidates',p_actor => 2)$$,
  'P0002',null,'the requester loses configuration part access when its grant is revoked');

-- Advance the persisted capture clock in this rollback-only fixture and restore
-- its write guard before exercising the real read boundary.
alter table internal.factory_benchmark_comparison_exports disable trigger preserve_factory_benchmark_comparison_export;
update internal.factory_benchmark_comparison_exports
set captured_at = captured_at - interval '25 hours', expires_at = expires_at - interval '25 hours'
where id = (select id::uuid from immutable_large);
alter table internal.factory_benchmark_comparison_exports enable trigger preserve_factory_benchmark_comparison_export;
select throws_ok($$select pg_temp.read_comparison_export(81,(select id::uuid from immutable_large))$$,
  'PT410',null,'the current requester cannot download an expired manifest');
select throws_ok($$select pg_temp.read_comparison_export(81,(select id::uuid from immutable_large),1)$$,
  'PT410',null,'the current requester cannot download an expired trial part');
select throws_ok($$select pg_temp.read_comparison_export(81,(select id::uuid from immutable_large),1,'candidates')$$,
  'PT410',null,'the current requester cannot download an expired configuration part');

select is(pg_temp.schedule_control(80,'cancel')->>'state','canceled','the live comparison can continue after capture');
select public.save_factory_benchmark_suite_revision(previous.workspace_id,previous.factory_id,scope.owner_id,
  'Renamed benchmark suite','regression',previous.suite_id,previous.id,array(
    select task_revision_id from public.factory_benchmark_suite_members member where member.suite_revision_id=previous.id))
from experiment_suites previous join experiment_scope scope using (is_default) where scope.is_default;
select is(pg_temp.comparison(80)#>>'{counts,canceled}','3','the live comparison includes newly canceled unadmitted cells');
select is(pg_temp.comparison(80)#>>'{suite,name}','Original experiment suite','display names come from the pinned suite revision');
select is(pg_temp.read_comparison_export(80,(select id::uuid from immutable_small)),(select bytes from manifests where slot=80),
  'live schedule and name changes do not change stored result bytes');
select is((select bytes::jsonb#>>'{summary,counts,pending}' from manifests where slot=80),'2',
  'the earlier export retains its pending denominator');

select is((public.archive_factory(scope.workspace_id,scope.factory_id,scope.owner_id)).status,'archived',
  'the manager archives the tested factory')
from experiment_scope scope where is_default;
select is(pg_temp.comparison(80)#>>'{counts,planned}','12','a current manager can read an archived comparison');
select is(pg_temp.read_comparison_export(80,(select id::uuid from immutable_small)),(select bytes from manifests where slot=80),
  'the original manager can still download archived comparison manifests');
select is(jsonb_array_length(public.list_factory_benchmark_comparison_exports(scope.workspace_id,scope.factory_id,
  pg_temp.schedule_id(80),scope.owner_id)->'items'),1,'the manager can page archived export history')
from experiment_scope scope where is_default;
select is(jsonb_array_length(public.list_factory_benchmark_comparisons(scope.workspace_id,scope.factory_id,
  scope.owner_id,p_limit => 1)->'items'),1,'the comparison index is bounded for an archived factory')
from experiment_scope scope where is_default;

select * from finish();
rollback;
