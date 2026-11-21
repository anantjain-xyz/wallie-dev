begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.schedule_id(slot integer) returns uuid language sql immutable as $$
  select ('61800000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values
  (pg_temp.schedule_id(1), 'benchmark-schedule-owner@example.test'),
  (pg_temp.schedule_id(2), 'benchmark-schedule-reader@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.schedule_id(11), 'benchmark-schedules-test', 'Benchmark experiments test');
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
values (pg_temp.schedule_id(35), pg_temp.schedule_id(11), 61800001, 'https://example.test/install', 6180,
  'Organization', 'Experiment fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name,
  private, html_url, default_branch)
select pg_temp.schedule_id(slot + 2), workspace_id, factory_id, pg_temp.schedule_id(35), 61800000 + slot,
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
    pg_temp.experiment_configs(case when p_primary then array[43,44] else array[63] end, 'workerd'), 4, 31, 1000)
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

select ok(
  not has_table_privilege('authenticated', 'public.factory_benchmark_schedules', 'SELECT')
  and not has_table_privilege('service_role', 'public.factory_benchmark_schedule_trials', 'INSERT')
  and not has_function_privilege('authenticated', 'public.reconcile_factory_benchmark_schedules(integer)', 'EXECUTE')
  and not has_function_privilege('service_role', 'internal.admit_factory_benchmark_trial(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)', 'EXECUTE'),
  'only scoped service operations can write schedules or bypass standalone admission internally');
select is(pg_temp.freeze_schedule(80)->>'expectedTrialCount', '16', 'planned matrix includes ineligible cells');
select throws_ok($$select pg_temp.schedule_snapshot(80)$$, 'P0002', null, 'unconfigured experiment has no schedule');
select throws_ok($$select pg_temp.configure_schedule(80, p_actor => 2)$$, '42501', null, 'a factory reader cannot schedule');
select throws_ok($$select pg_temp.configure_schedule(80, p_runner => 'unsupported')$$, '22023', null,
  'the scheduler requires an explicitly selected supported execution adapter');
select throws_ok($$select pg_temp.configure_schedule(80, p_budget => 0.599999)$$, '22023', null,
  'a schedule must fit at least one execution estimate');
select throws_ok($$select pg_temp.configure_schedule(80, p_budget => 0.8999999)$$, '22023', null,
  'a cap cannot silently round from unsupported precision');
select throws_ok($$select pg_temp.configure_schedule(80, p_primary => false)$$, 'P0002', null,
  'the same workspace does not confer schedule access to a foreign factory experiment');
select is(pg_temp.configure_schedule(80)->>'eligibleTrialCount', '8', 'only eligible frozen cells enter the schedule');
select is(pg_temp.configure_schedule(80), pg_temp.schedule_snapshot(80), 'exact configure retry returns the same schedule');
select throws_ok($$select pg_temp.configure_schedule(80, p_max => 1)$$, 'PT409', null,
  'an exact experiment cannot acquire a second cap via configuration retry');
select throws_ok($$
  select public.admit_factory_benchmark_trial(scope.workspace_id, scope.factory_id, scope.owner_id,
    cell.trial_id, cell.task_revision_id, policy.id, policy.policy_digest, repeat('f',64), pg_temp.schedule_id(38))
  from experiment_scope scope join experiment_policies policy using (is_default)
  join public.factory_benchmark_experiment_trials cell on cell.factory_id = scope.factory_id
  where scope.is_default and cell.replay_eligibility = 'eligible' limit 1
$$, 'PT409', null, 'an old explicit trial API cannot skip a frozen cell reservation');

select pg_temp.freeze_schedule(81, false);
select is(pg_temp.configure_schedule(81, p_max => 1, p_primary => false)->>'maxAdmittedTrials', '1',
  'another factory in the same workspace has an independent schedule');
commit;

select extensions.dblink_connect('benchmark_admission_winner',
  coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
    'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('benchmark_admission_winner',
  'set statement_timeout = ''10s''; set request.jwt.claim.role = ''service_role''; begin');
select is((select admitted from extensions.dblink('benchmark_admission_winner',
  'select public.reconcile_factory_benchmark_schedules(1)') as isolated(admitted integer)), 1,
  'the first worker reserves and queues exactly one frozen cell');

begin;
set local request.jwt.claim.role = 'service_role';
select is(public.reconcile_factory_benchmark_schedules(10), 0,
  'a concurrent worker cannot reserve from the same experiment before the winner commits');
select is((select count(*) from public.factory_benchmark_schedule_trials where experiment_id = pg_temp.schedule_id(80)), 0::bigint,
  'no reservation or queued work is visible before the transaction commits');
commit;

select extensions.dblink_exec('benchmark_admission_winner', 'commit');
select extensions.dblink_exec('benchmark_admission_winner', 'begin');
select locked.id from extensions.dblink('benchmark_admission_winner', format(
  'select id from public.factories where id = %L for update', (select factory_id from experiment_scope where is_default)
)) as locked(id uuid);
set request.jwt.claim.role = 'service_role';
set statement_timeout = '5s';
select is(public.reconcile_factory_benchmark_schedules(10), 1,
  'one factory lock cannot stall reconciliation and admission for an independent factory');
reset statement_timeout;
reset request.jwt.claim.role;
select extensions.dblink_exec('benchmark_admission_winner', 'rollback');
select extensions.dblink_disconnect('benchmark_admission_winner');

begin;
set local request.jwt.claim.role = 'service_role';
select pg_temp.schedule_control(81, 'pause', false);
select is(public.reconcile_factory_benchmark_schedules(10), 0, 'retry respects outstanding capacity and the aggregate reserve');
select is(pg_temp.schedule_snapshot(80)->>'reservedUsd', '0.600000', 'the exact execution reserve is visible');
select ok((select candidate.model in ('gpt-5.5','gpt-5-mini') and candidate.worker_runtime = 'workerd'
  and trial.runner_revision = 'recorded-fixture-v1'
  from public.factory_benchmark_trials trial
  join public.factory_benchmark_experiment_trials cell on cell.trial_id = trial.id
  join public.factory_benchmark_experiment_candidates candidate on
    (candidate.workspace_id, candidate.factory_id, candidate.experiment_id, candidate.candidate_key) =
    (cell.workspace_id, cell.factory_id, cell.experiment_id, cell.candidate_key)
  where cell.experiment_id = pg_temp.schedule_id(80)),
  'the frozen planned model and runtime stay distinct from the recorded execution runner');
select is(pg_temp.schedule_control(80, 'pause')->>'state', 'paused', 'pause persists across worker reconciliation');
select is((select count(*) from public.claim_next_agent_job(true, 3)), 0::bigint, 'paused scheduled jobs cannot be claimed');
select is(pg_temp.schedule_control(80, 'resume')->>'queuedTrialCount', '1', 'resume keeps the same queued trial');

-- A newer production job must claim first, leaving benchmark work queued.
select revision from public.set_git_continuity_release(true,
  (select revision from internal.git_continuity_release_control where singleton), 'Scheduler production fairness fixture');
insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id)
select pg_temp.schedule_id(101), workspace_id, factory_id, 3, 'Production work',
  pg_temp.schedule_id(40), pg_temp.schedule_id(41) from experiment_scope where is_default;
insert into public.agent_jobs(id, workspace_id, session_id, stage_id, stage_slug, trigger_type)
values (pg_temp.schedule_id(102), pg_temp.schedule_id(11), pg_temp.schedule_id(101), pg_temp.schedule_id(41), 'review', 'manual_run');
select is((select id from public.claim_next_agent_job(true, 3)), pg_temp.schedule_id(102),
  'ready production claims precede older benchmark jobs');
select is((select count(*) from public.claim_next_worker_dispatch(true, 2, 4)), 0::bigint,
  'native dispatch preserves its final slot under benchmark backlog');
select is((select count(*) from public.claim_next_agent_job(true, 2)), 0::bigint,
  'benchmark dispatch preserves the final workspace slot');
select is((select job_id from public.claim_next_worker_dispatch(true, 3, 4)), (pg_temp.last_scheduled_trial(80)).job_id,
  'native dispatch can claim the exact frozen job when there is headroom');
select is((public.start_factory_benchmark_trial((pg_temp.last_scheduled_trial(80)).job_id, 2)).run_id, null::uuid,
  'a stale attempt cannot start even after the scheduler has admitted it');
select is((public.start_factory_benchmark_trial((pg_temp.last_scheduled_trial(80)).job_id, 1)).run_id,
  (pg_temp.last_scheduled_trial(80)).run_id, 'the exact attempt starts');
select ok((pg_temp.last_scheduled_trial(80)).deadline_at <= clock_timestamp() + interval '1 second',
  'the immutable matrix caps the run deadline');

-- A lower factory cap applies across simultaneously active schedules.
select pg_temp.freeze_schedule(83);
select pg_temp.configure_schedule(83, p_max => 1, p_cap => 1);
select is(public.reconcile_factory_benchmark_schedules(10), 1, 'another schedule can queue independent work in the same factory');
select is((select count(*) from public.claim_next_agent_job(true, 4)), 0::bigint,
  'the running benchmark holds the effective factory slot shared by independent schedules');
select pg_temp.schedule_control(83, 'cancel');

-- With today's default at four, this historical production pin will wait
-- until the active benchmark drains. The sibling queue must stop refilling.
select is(pg_temp.schedule_control(81, 'resume', false)->>'queuedTrialCount', '1',
  'the independent factory can resume benchmark claims while the first factory has an active run');
insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id,
  factory_definition_provenance, factory_definition_revision_id, execute_pinned_definition, github_repository_id)
select pg_temp.schedule_id(103), workspace_id, factory_id, 4, 'Production work with a pinned limit',
  pg_temp.schedule_id(40), pg_temp.schedule_id(41), 'pinned', pg_temp.schedule_id(45), true, pg_temp.schedule_id(42)
from experiment_scope where is_default;
insert into public.agent_jobs(id, workspace_id, session_id, stage_id, stage_slug, trigger_type)
values (pg_temp.schedule_id(104), pg_temp.schedule_id(11), pg_temp.schedule_id(103), pg_temp.schedule_id(41), 'review', 'manual_run');
select is((select count(*) from public.claim_next_agent_job(true, 4)), 0::bigint,
  'queued production with a tighter historical pin stops benchmarks refilling in the workspace');
update public.agent_jobs set scheduled_at = clock_timestamp() + interval '1 hour' where id = pg_temp.schedule_id(104);
select is(pg_temp.schedule_control(81, 'pause', false)->>'queuedTrialCount', '1', 'a paused sibling keeps its queued reservation');

select ok(result.accepted, 'paid usage survives a subsequent execution failure')
from pg_temp.last_scheduled_trial(80) trial
cross join lateral public.record_session_run_usage(trial.job_id, 1, trial.run_id, 12, 15, 'measured', 0.2, 'measured', null, false) result;
select ok(public.fail_factory_benchmark_trial(trial.id, trial.job_id, 1, trial.run_id, 'candidate_failed'),
  'the admitted execution fails within its exact attempt fence')
from pg_temp.last_scheduled_trial(80) trial;
select is(public.reconcile_factory_benchmark_schedules(10), 1, 'recovery releases the unused reserve and advances to a distinct cell');
select is(pg_temp.schedule_snapshot(80)->>'executionSpentUsd', '0.200000', 'failed measured cost is charged exactly once');
select is(pg_temp.schedule_snapshot(80)->>'admittedTrialCount', '2', 'completed trial identity is not requeued');

select is((select id from public.claim_next_agent_job(true, 4)), (pg_temp.last_scheduled_trial(80)).job_id,
  'the subsequent admitted execution is claimable');
select is((public.start_factory_benchmark_trial((pg_temp.last_scheduled_trial(80)).job_id, 1)).run_id,
  (pg_temp.last_scheduled_trial(80)).run_id, 'subsequent exact execution starts');
select ok(public.fail_factory_benchmark_trial(trial.id, trial.job_id, 1, trial.run_id, 'sandbox_unavailable'),
  'the exact failed attempt can finish with unavailable cost')
from pg_temp.last_scheduled_trial(80) trial;
select is(public.reconcile_factory_benchmark_schedules(10), 0, 'unknown paid cost holds its reserve and blocks oversubscription');
select is(pg_temp.schedule_snapshot(80)->>'unavailableExecutionCount', '1', 'started unavailable usage stays explicit');
select is(pg_temp.schedule_snapshot(80)->>'reservedUsd', '0.600000', 'started unavailable usage keeps its full reserve');
select is(pg_temp.schedule_snapshot(80)->>'executionSpentUsd', '0.200000', 'reconciliation does not apply existing cost twice');

select is(pg_temp.schedule_control(81, 'cancel', false)->>'reservedUsd', '0', 'cancel releases never-started execution');
select ok((select cost_provenance = 'never_started' and actual_usd is null
  from public.factory_benchmark_schedule_trials where experiment_id = pg_temp.schedule_id(81)),
  'the never-started release remains distinct from a zero-dollar measured run');
select is(pg_temp.schedule_control(81, 'cancel', false)->>'terminalTrialCount', '1', 'cancel retry preserves terminal identity');
select throws_ok($$select pg_temp.schedule_control(81, 'resume', false)$$, 'PT409', null, 'canceled schedules cannot resume');
select is(public.reconcile_factory_benchmark_schedules(10), 0, 'maintenance cannot recreate canceled or exhausted cells');
select is(pg_temp.schedule_control(80, 'cancel')->>'admittedTrialCount', '2', 'cancel preserves admitted and frozen counts across recovery');
select is(pg_temp.schedule_snapshot(80)->>'reservedUsd', '0.600000', 'cancel preserves unknown holds from started failures');
-- Model the exact future evaluation attachment with synthetic terminal receipts.
-- The existing production scorer must still ignore the benchmark run.
select pg_temp.freeze_schedule(82);
select pg_temp.configure_schedule(82, p_budget => 0.7, p_execution => 0.2, p_max => 1, p_evaluation => 0.4);
select is(public.reconcile_factory_benchmark_schedules(10), 1, 'a second experiment reserves its one permitted cell');
select id from public.claim_next_agent_job(true, 4);
select (public.start_factory_benchmark_trial((pg_temp.last_scheduled_trial(82)).job_id, 1)).run_id;
select result.accepted from pg_temp.last_scheduled_trial(82) trial
cross join lateral public.record_session_run_usage(trial.job_id, 1, trial.run_id, 0, 0, 'measured', 0, 'measured', null, false) result;
update public.agent_runs set status = 'success', finished_at = clock_timestamp() where id = (pg_temp.last_scheduled_trial(82)).run_id;
update public.agent_jobs set status = 'success', finished_at = clock_timestamp() where id = (pg_temp.last_scheduled_trial(82)).job_id;
update public.factory_benchmark_trials set status = 'success', finished_at = clock_timestamp() where id = (pg_temp.last_scheduled_trial(82)).id;

create temp table benchmark_scorer as
select trial.workspace_id, trial.factory_id, trial.actor_user_id, scorer.id as scorer_revision_id
from pg_temp.last_scheduled_trial(82) trial
cross join lateral public.create_factory_scorer(trial.workspace_id, trial.factory_id, trial.actor_user_id,
  'Benchmark receipt proof', 'benchmark-receipt-proof',
  '{"schemaVersion":1,"rubric":"Read the retained diff.","requiredEvidence":["code_diff"],"scoring":{"kind":"boolean","passValue":true}}') scorer;
create temp table benchmark_scorer_policy as
select policy.id, scorer.*
from benchmark_scorer scorer cross join lateral public.save_factory_scorer_sampling_policy(
  scorer.workspace_id, scorer.factory_id, scorer.actor_user_id, scorer.scorer_revision_id, 0, 10000, 'benchmark-fixture') policy;
select public.configure_factory_evaluation_lane(workspace_id, actor_user_id, 0, false, 1) from benchmark_scorer;

insert into public.factory_scorer_sample_receipts(
  id, workspace_id, factory_id, policy_id, scorer_revision_id, definition_revision_id, session_id,
  run_id, attempt_count, run_finished_at, target_commit_sha, outcome, reason, missing_evidence, evidence
)
select pg_temp.schedule_id(159), trial.workspace_id, trial.factory_id, policy.id, policy.scorer_revision_id,
  pg_temp.schedule_id(43), trial.session_id, run.id, 1, run.finished_at, repeat('a',40), 'excluded', 'unsupported_run', '{}', '[]'
from pg_temp.last_scheduled_trial(82) trial join public.agent_runs run on run.id = trial.run_id
join benchmark_scorer_policy policy on policy.factory_id = trial.factory_id;
select is((select count(*) from public.factory_evaluation_jobs where run_id = (pg_temp.last_scheduled_trial(82)).run_id),
  0::bigint, 'scheduler accounting does not queue production scoring for benchmark executions');
insert into public.factory_evaluation_jobs(
  id, workspace_id, factory_id, session_id, run_id, scorer_revision_id, sample_receipt_id, target_commit_sha, status, attempt_count, available_at
)
select pg_temp.schedule_id(160), trial.workspace_id, trial.factory_id, trial.session_id, trial.run_id,
  scorer.scorer_revision_id, pg_temp.schedule_id(159), repeat('a',40), 'claimed', 1, null
from pg_temp.last_scheduled_trial(82) trial join benchmark_scorer scorer using (factory_id);

create function pg_temp.allocate_benchmark_evaluation(p_number integer) returns uuid language sql as $$
  insert into public.factory_evaluation_attempts(id, job_id, workspace_id, factory_id, attempt_number, claimed_at, lease_expires_at)
  select pg_temp.schedule_id(160 + p_number), job.id, job.workspace_id, job.factory_id, p_number,
    clock_timestamp(), clock_timestamp() + interval '5 minutes'
  from public.factory_evaluation_jobs job where job.id = pg_temp.schedule_id(160) returning id;
$$;
insert into public.factory_judge_profile_revisions(
  id, workspace_id, revision, enabled, model_id, provider_route, allow_images, allow_video, approved_by_member_id
) values (pg_temp.schedule_id(158), pg_temp.schedule_id(11), 1, true, 'openai/example', 'openai',
  false, false, pg_temp.schedule_id(21));

create function pg_temp.record_benchmark_evaluation(p_number integer, p_started boolean, p_cost numeric)
returns void language plpgsql as $$
declare terminal public.factory_evaluation_attempts;
begin
  if p_started then
    insert into public.factory_judge_invocations(
      attempt_id, workspace_id, factory_id, job_id, profile_revision_id, status, evidence_digest, worker_runtime, started_at, finished_at
    )
    select attempt.id, attempt.workspace_id, attempt.factory_id, attempt.job_id, pg_temp.schedule_id(158),
      'provider_unavailable', repeat('a',64), 'node', attempt.claimed_at, clock_timestamp()
    from public.factory_evaluation_attempts attempt where attempt.id = pg_temp.schedule_id(160 + p_number);
  end if;
  update public.factory_evaluation_attempts set settled_at = clock_timestamp(), outcome = 'retryable_failure'
  where id = pg_temp.schedule_id(160 + p_number) returning * into strict terminal;
  if p_started then
    perform internal.record_factory_evaluation_receipt(terminal,
      p_cost_usd => p_cost, p_cost_provenance => case when p_cost is null then 'unavailable' else 'measured' end);
  end if;
end;
$$;

select pg_temp.allocate_benchmark_evaluation(1);
select is(public.reserve_factory_benchmark_evaluation_attempt((pg_temp.last_scheduled_trial(80)).id, pg_temp.schedule_id(161)),
  false, 'another trial cannot attach an evaluation attempt for this run');
select pg_temp.schedule_control(82, 'pause');
select is(public.reserve_factory_benchmark_evaluation_attempt((pg_temp.last_scheduled_trial(82)).id, pg_temp.schedule_id(161)),
  false, 'a paused experiment cannot attach new evaluation work');
select pg_temp.schedule_control(82, 'resume');
select ok(public.reserve_factory_benchmark_evaluation_attempt((pg_temp.last_scheduled_trial(82)).id, pg_temp.schedule_id(161)),
  'the exact upcoming evaluation attempt reserves against the shared experiment budget');
select ok(public.reserve_factory_benchmark_evaluation_attempt((pg_temp.last_scheduled_trial(82)).id, pg_temp.schedule_id(161)),
  'repeating the attachment restores the same reservation');
select is(pg_temp.schedule_snapshot(82)->>'reservedUsd', '0.400000', 'evaluation reserves are held once');
select pg_temp.record_benchmark_evaluation(1, true, 0.2);
select is(public.reconcile_factory_benchmark_schedules(10), 0, 'evaluation settlement respects the trial expansion cap');
select is((pg_temp.schedule_snapshot(82)->>'evaluationSpentUsd')::numeric, 0.2::numeric, 'measured cost survives a failed evaluation');

select pg_temp.allocate_benchmark_evaluation(2);
select ok(public.reserve_factory_benchmark_evaluation_attempt((pg_temp.last_scheduled_trial(82)).id, pg_temp.schedule_id(162)),
  'an independent attempt may reserve remaining capacity');
select pg_temp.record_benchmark_evaluation(2, false, null);
select is(public.reconcile_factory_benchmark_schedules(10), 0, 'restart releases an unstarted evaluation reservation');
select is(pg_temp.schedule_snapshot(82)->>'reservedUsd', '0', 'unstarted evaluation cost does not hold any USD');

select pg_temp.allocate_benchmark_evaluation(3);
select ok(public.reserve_factory_benchmark_evaluation_attempt((pg_temp.last_scheduled_trial(82)).id, pg_temp.schedule_id(163)),
  'a later evaluation owns another exact reservation');
select pg_temp.record_benchmark_evaluation(3, true, null);
select is(public.reconcile_factory_benchmark_schedules(10), 0, 'restart records unknown spend without estimating the receipt');
select is(pg_temp.schedule_snapshot(82)->>'unavailableEvaluationCount', '1', 'started unavailable evaluation usage stays explicit');
select is(pg_temp.schedule_snapshot(82)->>'reservedUsd', '0.400000', 'started unavailable evaluation retains its estimate');

select pg_temp.allocate_benchmark_evaluation(4);
select is(public.reserve_factory_benchmark_evaluation_attempt((pg_temp.last_scheduled_trial(82)).id, pg_temp.schedule_id(164)),
  false, 'actual evaluation charges and unknown holds block reservations beyond the shared cap');
select is((pg_temp.schedule_snapshot(82)->>'evaluationSpentUsd')::numeric, 0.2::numeric,
  'receipt retries and subsequent attempts do not reapply measured cost');

select * from finish();
rollback;
delete from public.workspaces where id = pg_temp.schedule_id(11);
delete from auth.users where id in (pg_temp.schedule_id(1), pg_temp.schedule_id(2));
