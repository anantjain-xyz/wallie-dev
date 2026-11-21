begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.experiment_id(slot integer) returns uuid language sql immutable as $$
  select ('61700000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values
  (pg_temp.experiment_id(1), 'benchmark-experiment-owner@example.test'),
  (pg_temp.experiment_id(2), 'benchmark-experiment-reader@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.experiment_id(11), 'benchmark-experiments-test', 'Benchmark experiments test');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.experiment_id(21), pg_temp.experiment_id(11), pg_temp.experiment_id(1), 'human', 'owner'),
  (pg_temp.experiment_id(22), pg_temp.experiment_id(11), pg_temp.experiment_id(2), 'human', 'member');
insert into public.factories(id, workspace_id, name, slug, is_default)
values (pg_temp.experiment_id(30), pg_temp.experiment_id(11), 'Experiment sibling', 'experiment-sibling', false);

create temp table experiment_scope as
select workspace_id, id as factory_id, is_default, pg_temp.experiment_id(1) as owner_id,
  case when is_default then 40 else 60 end as slot
from public.factories where workspace_id = pg_temp.experiment_id(11);
select public.grant_factory_membership(workspace_id, factory_id, owner_id, pg_temp.experiment_id(22), 'member')
from experiment_scope where is_default;

insert into public.pipelines(id, workspace_id, factory_id, name)
select pg_temp.experiment_id(slot), workspace_id, factory_id, 'Experiment pipeline' from experiment_scope;
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name, prompt_template_md)
select pg_temp.experiment_id(slot + 1), workspace_id, pg_temp.experiment_id(slot), 1, 'review', 'Review', 'Review the task.'
from experiment_scope;
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.experiment_id(35), pg_temp.experiment_id(11), 61700001, 'https://example.test/install', 6170,
  'Organization', 'Experiment fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name,
  private, html_url, default_branch)
select pg_temp.experiment_id(slot + 2), workspace_id, factory_id, pg_temp.experiment_id(35), 61700000 + slot,
  'experiment-fixture', 'fixture/experiment-' || slot, true, 'https://example.test/fixture', 'main'
from experiment_scope;

with configs as (
  select scope.*, candidate.offset_slot, candidate.model, candidate.harness, candidate.stage_offset
  from experiment_scope scope cross join (values
    (3, 'gpt-5.5', 'codex', 1), (4, 'gpt-5-mini', 'codex', 1),
    (5, 'claude-sonnet-4-6', 'claude-code', 1), (6, 'gpt-5.5', 'codex', 99)
  ) candidate(offset_slot, model, harness, stage_offset) where scope.is_default or candidate.offset_slot = 3
), definitions as (
  select configs.*, jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.experiment_id(slot),
    'repositoryId', pg_temp.experiment_id(slot + 2), 'sandboxProvider', 'vercel',
    'agent', jsonb_build_object('provider', harness, 'model', model, 'effort', null, 'concurrencyLimit', 2,
      'stallTimeoutMs', 120000, 'maxRetries', 1, 'maxTurns', 24),
    'executionPolicyRevisionId', null, 'deliveryPolicyRevisionId', null,
    'skillIds', '[]'::jsonb, 'toolIds', '[]'::jsonb, 'operatingRulesMd', '', 'operatingRuleStageIds', '[]'::jsonb,
    'stages', jsonb_build_array(jsonb_build_object('id', pg_temp.experiment_id(slot + stage_offset), 'slug', 'review',
      'name', 'Review', 'description', '', 'promptTemplateMd', 'Review the task.', 'anyoneCanApprove', false,
      'approverMemberIds', '[]'::jsonb, 'previousStageIds', '[]'::jsonb))
  )::text as compiled from configs
)
insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json,
  canonical_digest, created_by)
select pg_temp.experiment_id(slot + offset_slot), workspace_id, factory_id, 1, compiled,
  encode(sha256(convert_to(compiled, 'UTF8')), 'hex'), owner_id from definitions;

insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id)
select pg_temp.experiment_id(slot + 7), workspace_id, factory_id, case when is_default then 1 else 2 end,
  'Experiment source', pg_temp.experiment_id(slot), pg_temp.experiment_id(slot + 1)
from experiment_scope;
insert into public.agent_runs(id, workspace_id, session_id, stage_id, stage_slug, run_type, model_provider, model_name,
  status, finished_at)
select pg_temp.experiment_id(slot + source.offset_slot), workspace_id, pg_temp.experiment_id(slot + 7),
  pg_temp.experiment_id(slot + 1), 'review', 'project', 'codex', 'gpt-5.5', 'success', clock_timestamp()
from experiment_scope cross join (values (8), (9), (10)) source(offset_slot) where is_default or source.offset_slot = 8;

create temp table experiment_tasks as
select source.key, revision.* from experiment_scope scope
cross join (values
  ('eligible', 48, 'eligible', null::text), ('ineligible', 49, 'ineligible', 'Exact source was not retained.'),
  ('unverified', 50, 'unverified', 'Waiting for source verification.'), ('sibling', 68, 'eligible', null::text)
) source(key, run_slot, eligibility, reason)
cross join lateral public.create_factory_benchmark_task(scope.workspace_id, scope.factory_id, scope.owner_id,
  pg_temp.experiment_id(source.run_slot), source.key, 'Keep the frozen acceptance criteria.',
  '{}', source.eligibility, source.reason) revision
where scope.is_default = (source.key <> 'sibling');
create temp table experiment_suites as
select scope.is_default, suite.* from experiment_scope scope
cross join lateral public.save_factory_benchmark_suite_revision(scope.workspace_id, scope.factory_id, scope.owner_id,
  'Original experiment suite', 'regression', p_task_revision_ids => array(
    select id from experiment_tasks task
    where task.factory_id = scope.factory_id and task.key <> 'unverified'
  )) suite;
create temp table experiment_policies as
select scope.is_default, policy.* from experiment_scope scope
cross join lateral public.publish_factory_benchmark_replay_policy(scope.workspace_id, scope.factory_id, scope.owner_id,
  'blocked') policy;

create function pg_temp.experiment_configs(p_slots integer[], p_runtime text default 'node')
returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('definitionRevisionId', revision.id, 'definitionDigest', revision.canonical_digest,
    'harness', revision.definition_json::jsonb#>>'{agent,provider}', 'model', revision.definition_json::jsonb#>>'{agent,model}',
    'sandboxProvider', revision.definition_json::jsonb->>'sandboxProvider', 'workerRuntime', p_runtime)
    order by selection.position)
  from unnest(p_slots) with ordinality selection(slot, position)
  join public.factory_definition_revisions revision on revision.id = pg_temp.experiment_id(selection.slot)
$$;
-- End of disposable fixture setup.

create function pg_temp.freeze_experiment(
  p_slot integer, p_configs jsonb, p_repetitions integer default 3, p_seed integer default 2147483647,
  p_timeout_ms integer default 120000, p_actor integer default 1, p_primary boolean default true,
  p_suite uuid default null, p_policy uuid default null
) returns jsonb language sql as $$
  select public.freeze_factory_benchmark_experiment(scope.workspace_id, scope.factory_id, pg_temp.experiment_id(p_actor),
    pg_temp.experiment_id(p_slot), coalesce(p_suite, suite.id), coalesce(p_policy, policy.id),
    p_configs, p_repetitions, p_seed, p_timeout_ms)
  from experiment_scope scope
  join experiment_suites suite on suite.is_default = scope.is_default
  join experiment_policies policy on policy.is_default = scope.is_default
  where scope.is_default = p_primary and suite.revision_number = 1
$$;
create function pg_temp.retry_experiment(
  p_slot integer, p_config_ids integer[], p_repetitions integer default 3, p_runtime text default 'node'
) returns jsonb language sql as $$
  select public.find_factory_benchmark_experiment_retry(scope.workspace_id, scope.factory_id, scope.owner_id,
    pg_temp.experiment_id(p_slot), suite.id, policy.id, array(select pg_temp.experiment_id(slot) from unnest(p_config_ids) slot),
    p_repetitions, 2147483647, 120000, p_runtime)
  from experiment_scope scope
  join experiment_suites suite on suite.is_default = scope.is_default
  join experiment_policies policy on policy.is_default = scope.is_default
  where scope.is_default and suite.revision_number = 1
$$;

select ok(
  not has_function_privilege('authenticated',
    'public.freeze_factory_benchmark_experiment(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.find_factory_benchmark_experiment_retry(uuid,uuid,uuid,uuid,uuid,uuid,uuid[],integer,integer,integer,text)', 'EXECUTE')
  and not has_table_privilege('service_role', 'public.factory_benchmark_experiment_trials', 'INSERT'),
  'only scoped service commands may write a matrix');
select throws_ok($$select pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[43,44]), p_actor => 2)$$,
  '42501', null, 'a factory reader cannot freeze an experiment');
select is(pg_temp.retry_experiment(80, array[43,44]), null::jsonb, 'a missing experiment has no retry receipt');
select throws_ok($$select pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[43,43]))$$,
  '22023', null, 'a repeated definition revision is invalid');
select throws_ok($$select pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[43,63]))$$,
  'PT422', null, 'a sibling factory revision cannot become a candidate');
select throws_ok($$select pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[43,46]))$$,
  'PT422', null, 'a definition with an unresolved stage cannot become a candidate');
select throws_ok($$select pg_temp.freeze_experiment(80,
  jsonb_set(pg_temp.experiment_configs(array[43,44]), '{0,model}', '"unverified-model"'))$$,
  'PT422', null, 'candidate model must match the stored revision');
select throws_ok($$select pg_temp.freeze_experiment(80,
  jsonb_set(pg_temp.experiment_configs(array[43,44]), '{0,definitionDigest}', to_jsonb(repeat('f', 64))))$$,
  'PT422', null, 'candidate digest must match the stored revision');
select throws_ok($$select pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[43]), p_suite =>
  (select id from experiment_suites where not is_default))$$,
  'PT422', null, 'a suite belongs to its factory');
select throws_ok($$select pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[43]), p_policy =>
  (select id from experiment_policies where not is_default))$$,
  'PT422', null, 'a replay policy revision belongs to its factory');
select throws_ok($$select pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[43]), p_timeout_ms => 999)$$,
  '22023', null, 'too short a timeout is invalid');
select throws_ok($$select pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[43]), p_repetitions => 101)$$,
  '22023', null, 'too many repetitions are invalid');
select throws_ok($$select pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[43]), p_seed => -1)$$,
  '22023', null, 'negative seeds are invalid');
select throws_ok($$select pg_temp.freeze_experiment(80, (select jsonb_agg(
  pg_temp.experiment_configs(array[43])->0 || jsonb_build_object('definitionRevisionId', pg_temp.experiment_id(slot))
  ) from generate_series(1000, 1100) slot), p_repetitions => 100)$$,
  'PT422', 'The frozen experiment requires between 1 and 10000 planned trials.', 'the whole product is bounded before materialization');
select is((select count(*) from public.factory_benchmark_experiments where workspace_id = pg_temp.experiment_id(11)),
  0::bigint, 'rejected requests leave no partially frozen header');

create temp table execution_counts_before as select
  (select count(*) from public.sessions where workspace_id = pg_temp.experiment_id(11)) as sessions,
  (select count(*) from public.agent_jobs where workspace_id = pg_temp.experiment_id(11)) as jobs,
  (select count(*) from public.factory_benchmark_trials where workspace_id = pg_temp.experiment_id(11)) as trials;
create temp table first_freeze as
select pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[43,44])) as receipt;
select is((select receipt from first_freeze), jsonb_build_object(
  'experimentId', pg_temp.experiment_id(80), 'suiteRevisionId', (select id from experiment_suites where is_default),
  'policyRevisionId', (select id from experiment_policies where is_default),
  'taskCount', 2, 'candidateCount', 2, 'repetitions', 3, 'expectedTrialCount', 12, 'materializedTrialCount', 12,
  'eligibleTrialCount', 6, 'ineligibleTrialCount', 6
), 'two tasks by two configurations by three repetitions freeze all twelve planned rows');

create temp table planned_trial_ids as
select trial_id from public.factory_benchmark_experiment_trials where experiment_id = pg_temp.experiment_id(80);
select is((select count(*) from planned_trial_ids), 12::bigint, 'all twelve identities were actually materialized');
select ok((select bool_and(trial_id::text ~ '^[a-f0-9-]{14}8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$')
  from planned_trial_ids), 'deterministic trial IDs use UUIDv8');
select results_eq($$select task.key, count(*), min(planned.eligibility_reason)
  from public.factory_benchmark_experiment_trials planned join experiment_tasks task on task.id = planned.task_revision_id
  where planned.experiment_id = pg_temp.experiment_id(80) group by task.key order by task.key$$,
  $$values ('eligible', 6::bigint, null::text), ('ineligible', 6::bigint, 'Exact source was not retained.')$$,
  'ineligible members remain in the planned matrix with frozen reasons');
select ok((select count(*) = 6 and bool_and(cells = 2 and seeds = 1 and timeouts = 1)
  from (select count(*) as cells, count(distinct seed) as seeds, count(distinct timeout_ms) as timeouts
    from public.factory_benchmark_experiment_trials where experiment_id = pg_temp.experiment_id(80)
    group by task_id, repetition) groups), 'each task repetition pairs the same seed and timeout across candidate configurations');
select is((select array_agg(distinct seed order by seed) from public.factory_benchmark_experiment_trials
  where experiment_id = pg_temp.experiment_id(80)), array[0,1,2,3,4,2147483647],
  'paired seeds stay distinct across task repetitions and wrap safely at the int32 boundary');
select results_eq($$select
  (select count(*) from public.sessions where workspace_id = pg_temp.experiment_id(11)),
  (select count(*) from public.agent_jobs where workspace_id = pg_temp.experiment_id(11)),
  (select count(*) from public.factory_benchmark_trials where workspace_id = pg_temp.experiment_id(11))$$,
  $$select sessions, jobs, trials from execution_counts_before$$, 'freezing the matrix schedules no executions');
select is(pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[44,43])),
  (select receipt from first_freeze), 'candidate reordering returns the same immutable receipt');
select is(pg_temp.retry_experiment(80, array[44,43]), (select receipt from first_freeze),
  'retry lookup matches the same normalized request');
select results_eq($$select trial_id from public.factory_benchmark_experiment_trials
  where experiment_id = pg_temp.experiment_id(80) order by trial_id$$,
  $$select trial_id from planned_trial_ids order by trial_id$$, 'retry retains every planned trial identity');
select throws_ok($$select pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[43,45]))$$,
  'PT409', null, 'same identity cannot change candidates');
select throws_ok($$select pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[43,44]), p_seed => 1)$$,
  'PT409', null, 'same identity cannot change the intended seed');
select throws_ok($$select pg_temp.retry_experiment(80, array[44,43], p_runtime => 'workerd')$$,
  'PT409', null, 'retry identity includes the frozen worker runtime');
select throws_ok($$update public.factory_benchmark_experiment_trials set seed = 1
  where experiment_id = pg_temp.experiment_id(80)$$, '23514', null, 'planned rows are immutable');

select pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[63]), 1, p_primary => false);
select is((select count(*) from public.factory_benchmark_experiments where id = pg_temp.experiment_id(80)),
  2::bigint, 'experiment identities are scoped to the factory');
select is((select count(*) from public.factory_benchmark_experiment_trials where experiment_id = pg_temp.experiment_id(80)),
  13::bigint, 'equal client IDs in two factories generate distinct trial namespaces');

insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, pg_temp.experiment_id(43), 1, owner_id from experiment_scope where is_default;
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, pg_temp.experiment_id(45), 2, owner_id from experiment_scope where is_default;
create temp table revised_task as
select saved.* from experiment_tasks task cross join experiment_scope scope
cross join lateral public.save_factory_benchmark_task_revision(task.workspace_id, task.factory_id, scope.owner_id,
  task.task_id, task.id, 'Verified after freeze', 'New criteria.', '{}', 'eligible') saved
where task.key = 'ineligible' and scope.is_default;
create temp table revised_suite as
select next.* from experiment_suites previous cross join experiment_scope scope cross join revised_task task
cross join lateral public.save_factory_benchmark_suite_revision(previous.workspace_id, previous.factory_id, scope.owner_id,
  'Updated experiment suite', 'regression', previous.suite_id, previous.id,
  array[task.id, (select id from experiment_tasks where key = 'unverified')]) next
where previous.is_default and scope.is_default;
select is(pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[43,44])),
  (select receipt from first_freeze), 'a new suite revision and active definition leave the frozen comparison unchanged');
select results_eq($$select definition_revision_id from public.factory_benchmark_experiment_candidates candidate
  join experiment_scope scope using (workspace_id, factory_id)
  where candidate.experiment_id = pg_temp.experiment_id(80) and scope.is_default order by definition_revision_id$$,
  $$select pg_temp.experiment_id(slot) from (values (43),(44)) configured(slot)$$,
  'candidate references remain the originally verified definitions');
select is(pg_temp.freeze_experiment(81, pg_temp.experiment_configs(array[45]), 1,
  p_suite => (select id from revised_suite))->>'ineligibleTrialCount',
  '1', 'unverified cases count among the planned rows without replay eligibility');
select is((select eligibility_reason from public.factory_benchmark_experiment_trials
  where experiment_id = pg_temp.experiment_id(81) and replay_eligibility = 'unverified'),
  'Waiting for source verification.', 'unverified status and reason survive planning');

select public.revoke_factory_benchmark_replay_revision(workspace_id, factory_id, created_by, p_policy_revision_id => id)
from experiment_policies where is_default;
select is(pg_temp.retry_experiment(80, array[44,43]), (select receipt from first_freeze),
  'an exact retry reads the immutable receipt after policy revocation');
select is(pg_temp.freeze_experiment(80, pg_temp.experiment_configs(array[44,43])),
  (select receipt from first_freeze), 'the mutation is itself idempotent after revocation');
select throws_ok($$select pg_temp.freeze_experiment(82, pg_temp.experiment_configs(array[43]))$$,
  'PT422', null, 'a revoked replay policy cannot freeze a new experiment');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '61700000-0000-4000-8000-000000000002';
select is((select count(*) from public.factory_benchmark_experiments where id = pg_temp.experiment_id(80)),
  1::bigint, 'reader sees only the matching factory header even under a shared workspace and experiment ID');
select is((select count(*) from public.factory_benchmark_experiment_trials where experiment_id = pg_temp.experiment_id(80)),
  12::bigint, 'reader sees only the matching factory trial rows');
select is((select count(*) from public.factory_benchmark_experiment_candidates where experiment_id = pg_temp.experiment_id(80)),
  2::bigint, 'reader sees only the matching factory candidates');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

delete from public.workspaces where id = pg_temp.experiment_id(11);
select is((select count(*) from public.factory_benchmark_experiment_trials where workspace_id = pg_temp.experiment_id(11)),
  0::bigint, 'workspace deletion purges its immutable experiment records');

select * from finish();
rollback;
