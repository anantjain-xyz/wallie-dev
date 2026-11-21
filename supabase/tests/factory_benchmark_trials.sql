begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.replay_id(slot integer) returns uuid language sql immutable as $$
  select ('61600000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values
  (pg_temp.replay_id(1), 'benchmark-trial-owner@example.test'),
  (pg_temp.replay_id(2), 'benchmark-trial-reader@example.test'),
  (pg_temp.replay_id(3), 'benchmark-trial-other-owner@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.replay_id(11), 'benchmark-trial-primary', 'Benchmark policy primary'),
  (pg_temp.replay_id(12), 'benchmark-trial-other', 'Benchmark policy other');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.replay_id(21), pg_temp.replay_id(11), pg_temp.replay_id(1), 'human', 'owner'),
  (pg_temp.replay_id(22), pg_temp.replay_id(11), pg_temp.replay_id(2), 'human', 'member'),
  (pg_temp.replay_id(23), pg_temp.replay_id(12), pg_temp.replay_id(3), 'human', 'owner');
insert into public.factories(id, workspace_id, name, slug, is_default)
values (pg_temp.replay_id(30), pg_temp.replay_id(11), 'Benchmark policy sibling', 'policy-sibling', false);

create temp table replay_scope as
select 'primary'::text as key, workspace_id, id as factory_id, pg_temp.replay_id(1) as owner_id
from public.factories where workspace_id = pg_temp.replay_id(11) and is_default
union all
select 'sibling', workspace_id, id, pg_temp.replay_id(1)
from public.factories where id = pg_temp.replay_id(30)
union all
select 'foreign', workspace_id, id, pg_temp.replay_id(3)
from public.factories where workspace_id = pg_temp.replay_id(12) and is_default;

insert into public.pipelines(id, workspace_id, factory_id, name)
select pg_temp.replay_id(40), workspace_id, factory_id, 'Replay source pipeline' from replay_scope where key = 'primary';
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name)
values (pg_temp.replay_id(41), pg_temp.replay_id(11), pg_temp.replay_id(40), 1, 'review', 'Review');
with definition as (
  select workspace_id, factory_id, owner_id,
    jsonb_build_object('schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.replay_id(40))::text as body
  from replay_scope where key = 'primary'
)
insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version,
  definition_json, canonical_digest, created_by)
select pg_temp.replay_id(49), workspace_id, factory_id, 1, body,
  encode(sha256(convert_to(body, 'UTF8')), 'hex'), owner_id from definition;

insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id,
  factory_definition_provenance, factory_definition_revision_id)
select pg_temp.replay_id(42), workspace_id, factory_id, 1, 'Replay source', pg_temp.replay_id(40), pg_temp.replay_id(41),
  'pinned', pg_temp.replay_id(49) from replay_scope where key = 'primary';
insert into public.agent_jobs(id, workspace_id, session_id, stage_id, stage_slug, trigger_type, status, attempt_count, finished_at)
values (pg_temp.replay_id(44), pg_temp.replay_id(11), pg_temp.replay_id(42), pg_temp.replay_id(41), 'review',
  'manual_run', 'success', 1, clock_timestamp());
insert into public.agent_runs(id, workspace_id, session_id, agent_job_id, stage_id, stage_slug, run_type,
  model_provider, model_name, status, attempt_count, finished_at)
values (pg_temp.replay_id(43), pg_temp.replay_id(11), pg_temp.replay_id(42), pg_temp.replay_id(44), pg_temp.replay_id(41),
  'review', 'project', 'codex', 'gpt-5.5', 'success', 1, clock_timestamp());
create temp table replay_task as
select revision.id, revision.task_id, revision.workspace_id, revision.factory_id from replay_scope scope
cross join lateral public.create_factory_benchmark_task(scope.workspace_id, scope.factory_id, scope.owner_id,
  pg_temp.replay_id(43), 'Replay fixture', 'Retain the result.', '{}', 'eligible') revision
where scope.key = 'primary';
insert into public.factory_benchmark_task_inputs(task_id, workspace_id, factory_id, source_run_id, source_session_id,
  source_job_id, source_attempt_count, definition_revision_id, checkout_sha)
select task_id, workspace_id, factory_id, pg_temp.replay_id(43), pg_temp.replay_id(42), pg_temp.replay_id(44),
  1, pg_temp.replay_id(49), repeat('a', 40) from replay_task;

insert into public.workspace_vercel_sandbox_connections(workspace_id, connection_revision, encrypted_token, team_id, project_id)
values (pg_temp.replay_id(11), pg_temp.replay_id(50), 'synthetic-encrypted-token', 'team_fixture', 'prj_fixture');
update public.agent_jobs set scheduled_at = clock_timestamp() + interval '1 hour' where status = 'queued';

create temp table trial_policies as
with fixture as (
  select published.id from replay_scope scope cross join lateral public.publish_factory_benchmark_replay_fixture(
    scope.workspace_id, scope.factory_id, scope.owner_id, 'tool_read', repeat('f', 64), '{"answer":"frozen"}'
  ) published where scope.key = 'primary'
), blocked as (
  select published.* from replay_scope scope cross join lateral public.publish_factory_benchmark_replay_policy(
    scope.workspace_id, scope.factory_id, scope.owner_id, 'blocked'
  ) published where scope.key = 'primary'
)
select 'blocked'::text as key, id, policy_digest from blocked
union all
select 'recorded', published.id, published.policy_digest
from replay_scope scope cross join blocked cross join fixture
cross join lateral public.publish_factory_benchmark_replay_policy(
  scope.workspace_id, scope.factory_id, scope.owner_id, 'recorded_fixtures', blocked.id, array[fixture.id]
) published where scope.key = 'primary';

create function pg_temp.admit_trial(
  p_slot integer, p_policy text default 'recorded', p_actor integer default 1, p_connection integer default 50,
  p_fixture text default 'f'
) returns public.factory_benchmark_trials language sql as $$
  select saved.* from replay_task task cross join trial_policies policy
  cross join lateral public.admit_factory_benchmark_trial(task.workspace_id, task.factory_id, pg_temp.replay_id(p_actor),
    pg_temp.replay_id(p_slot), task.id, policy.id, policy.policy_digest, repeat(p_fixture, 64), pg_temp.replay_id(p_connection)
  ) saved where policy.key = p_policy
$$;
create function pg_temp.cancel_trial(p_slot integer, p_wrong_run boolean default false)
returns boolean language sql as $$
  select public.cancel_factory_benchmark_trial(t.workspace_id, t.factory_id, t.actor_user_id, t.id,
    case when p_wrong_run then pg_temp.replay_id(1000) else t.run_id end)
  from public.factory_benchmark_trials t where t.id = pg_temp.replay_id(p_slot)
$$;
create function pg_temp.start_trial(p_slot integer, p_attempt integer default 1, p_deadline timestamptz default null)
returns uuid language sql as $$
  select (public.start_factory_benchmark_trial(t.job_id, p_attempt, p_deadline)).run_id
  from public.factory_benchmark_trials t where t.id = pg_temp.replay_id(p_slot)
$$;

select ok(
  not has_table_privilege('authenticated', 'public.factory_benchmark_trials', 'SELECT')
  and not has_table_privilege('authenticated', 'public.factory_benchmark_trial_results', 'SELECT')
  and not has_function_privilege('authenticated', 'public.start_factory_benchmark_trial(uuid,integer,timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.finish_factory_benchmark_trial(uuid,uuid,integer,uuid,jsonb)', 'EXECUTE'),
  'internal trial rows and attempt controls are service-only');
select throws_ok($$select pg_temp.admit_trial(60, p_actor => 2)$$, '42501', null,
  'only a factory manager can admit a trial');
select throws_ok($$select pg_temp.admit_trial(60, 'blocked')$$, 'PT422', null,
  'a blocked policy cannot admit the recorded fixture runner');
select throws_ok($$select pg_temp.admit_trial(60, p_connection => 51)$$, 'PT422', null,
  'a trial cannot admit an unpinned sandbox connection');
update public.agent_runs set stage_id = null where id = pg_temp.replay_id(43);
select throws_ok($$select pg_temp.admit_trial(60)$$, 'PT422', null,
  'missing historical stage provenance cannot fall back to the source session current stage');
update public.agent_runs set stage_id = pg_temp.replay_id(41) where id = pg_temp.replay_id(43);

select pg_temp.admit_trial(60);
select is((pg_temp.admit_trial(60)).id, pg_temp.replay_id(60), 'admission exact retry returns the same trial');
select throws_ok($$select pg_temp.admit_trial(60, p_fixture => 'a')$$, 'PT409', null,
  'a trial identity cannot change its pinned request');
select ok((select owner.number < 0 and owner.execution_purpose = 'benchmark'
  and owner.github_repository_id is null and not owner.execute_pinned_definition
  from public.factory_benchmark_trials trial join public.sessions owner on owner.id = trial.session_id
  where trial.id = pg_temp.replay_id(60)), 'trial admission creates an isolated internal session without a writer repository');
select is((select count(*) from public.session_git_continuity_enrollments e
  join public.factory_benchmark_trials t on t.session_id = e.session_id where t.id = pg_temp.replay_id(60)), 0::bigint,
  'the internal session does not enter Git continuity publication enrollment');
select throws_ok($$update public.sessions set execution_purpose = 'production'
  where id = (select session_id from public.factory_benchmark_trials where id = pg_temp.replay_id(60))$$, '23514', null,
  'purpose cannot change after creating a session');
select is((select count(*) from public.claim_next_agent_job()), 0::bigint, 'an older Node worker does not claim the trial');
select is((select count(*) from public.claim_next_worker_dispatch()), 0::bigint, 'an older native worker does not claim the trial');
select is(pg_temp.start_trial(60), null::uuid, 'an unclaimed trial cannot start');
select is((select id from public.claim_next_agent_job(true)),
  (select job_id from public.factory_benchmark_trials where id = pg_temp.replay_id(60)),
  'the opt-in worker claims the existing session job');
select is(pg_temp.start_trial(60, 2), null::uuid, 'a stale attempt cannot start the trial');
select is(pg_temp.start_trial(60, 1, clock_timestamp() - interval '1 second'), null::uuid,
  'an already expired worker deadline supplies no execution authority');
select is(pg_temp.start_trial(60, 1, clock_timestamp() + interval '60 seconds'),
  (select run_id from public.factory_benchmark_trials where id = pg_temp.replay_id(60)),
  'exact start binds the admitted session, job, and queued run');
select is(pg_temp.start_trial(60), null::uuid, 'a duplicate start cannot acquire a second isolated execution');
select ok((select attempt_count = 1 and deadline_at > clock_timestamp()
  and deadline_at < clock_timestamp() + interval '61 seconds' from public.factory_benchmark_trials where id = pg_temp.replay_id(60)),
  'the trial freezes the shorter worker deadline');
select is((select max_retries from public.pinned_job_recovery_settings where job_id =
  (select job_id from public.factory_benchmark_trials where id = pg_temp.replay_id(60))), 0,
  'shared stall recovery does not retry an isolated trial');

select opened.id
from public.factory_benchmark_trials trial cross join lateral public.open_factory_benchmark_replay_execution(
  trial.workspace_id, trial.factory_id, trial.actor_user_id, trial.replay_execution_id, trial.task_revision_id,
  trial.policy_revision_id, trial.policy_digest, repeat('d', 64)
) opened where trial.id = pg_temp.replay_id(60);
select is(public.record_factory_benchmark_replay_operation(
    workspace_id, factory_id, replay_execution_id, pg_temp.replay_id(700), 'tool_read', fixture_key
  )->>'decision', 'stubbed', 'the isolated result uses the exact pinned fixture operation')
from public.factory_benchmark_trials where id = pg_temp.replay_id(60);

create temp table trial_upload as
select trial.workspace_id::text || '/benchmark/' || trial.id::text || '/' || trial.run_id::text ||
  '/' || repeat('e', 64) || '.bundle' as path, trial.workspace_id
from public.factory_benchmark_trials trial where id = pg_temp.replay_id(60);
create temp table result_fixture as
select jsonb_build_object(
  'restorationReceiptSha256', repeat('d', 64), 'inputBundleSha256', repeat('c', 64),
  'inputCommitSha', repeat('a', 40), 'inputTreeSha', repeat('a', 40),
  'outputCommitSha', repeat('b', 40), 'outputTreeSha', repeat('b', 40),
  'fixtureOperationId', pg_temp.replay_id(700), 'artifactMarkdown', '# Isolated fixture result',
  'checkpointBundleSha256', repeat('e', 64), 'checkpointStoragePath', upload.path,
  'checkpointUploadOperationId', public.begin_workspace_resource_operation(workspace_id, 'upload', '',
    upload.path, 'session-source-checkpoints', clock_timestamp() + interval '5 minutes'),
  'validation', jsonb_build_object('version',1,'key','recorded-fixture-output','status','passed',
    'commitSha',repeat('b',40),'treeSha',repeat('b',40),'outputSha256',repeat('f',64)),
  'runtime', 'node'
) as payload from trial_upload upload;
create function pg_temp.finish_trial(p_slot integer, patch jsonb default '{}')
returns boolean language sql as $$
  select public.finish_factory_benchmark_trial(t.id, t.job_id, 1, t.run_id, fixture.payload || patch)
  from public.factory_benchmark_trials t cross join result_fixture fixture where t.id = pg_temp.replay_id(p_slot)
$$;

select throws_ok($$select public.begin_workspace_resource_operation(workspace_id, 'upload', '', path,
  'session-source-checkpoints', clock_timestamp() + interval '5 minutes') from trial_upload$$, '23505', null,
  'there is one cleanup reservation per exact benchmark upload');
select throws_ok($$insert into storage.objects(bucket_id, name, metadata)
  select 'session-source-checkpoints', replace(path, repeat('e', 64), repeat('f', 64)),
    '{"mimetype":"application/octet-stream","size":8}'::jsonb from trial_upload$$, '23514', null,
  'a write without an exact checkpoint reservation cannot create a delayed object');
select throws_ok($$select pg_temp.finish_trial(60)$$, '23514', null, 'the checkpoint must exist before the result can own it');
-- Synthetic metadata for this rollback-only storage fixture.
insert into storage.objects(bucket_id, name, metadata)
select 'session-source-checkpoints', path, '{"mimetype":"application/octet-stream","size":8}'::jsonb from trial_upload;
select throws_ok($$select pg_temp.finish_trial(60, jsonb_build_object('fixtureOperationId', pg_temp.replay_id(701)))$$,
  '23514', null, 'another operation cannot supply this trial evidence');
select throws_ok($$select pg_temp.finish_trial(60, jsonb_build_object('restorationReceiptSha256', repeat('a', 64)))$$,
  '23514', null, 'the result requires the exact opened restoration digest');
select ok(pg_temp.finish_trial(60), 'the exact worker attempt atomically completes and retains its output');
select ok(pg_temp.finish_trial(60), 'a duplicate finish returns the same result without changing its checkpoint');
select is(pg_temp.finish_trial(60, '{"artifactMarkdown":"other"}'), false, 'a completed trial rejects a changed result');
select is((select count(*) from public.workspace_resource_operations op
  join trial_upload upload on upload.path = op.resource_id), 0::bigint,
  'successful retention settles the temporary guarded checkpoint upload');
select throws_ok($$select public.begin_workspace_resource_operation(workspace_id, 'upload', '', path,
  'session-source-checkpoints', clock_timestamp() + interval '5 minutes') from trial_upload$$, '23514', null,
  'a retry cannot create a cleanup reservation for a retained object');
set local storage.allow_delete_query = 'true';
select throws_ok($$delete from storage.objects where bucket_id = 'session-source-checkpoints'
  and name = (select path from trial_upload)$$, '23514', null,
  'a stale cleanup cannot delete the checkpoint owned by a successful trial');
reset storage.allow_delete_query;
select results_eq($$select t.status, j.status::text, run.status::text, result.input_commit_sha,
  result.output_commit_sha, result.fixture_operation_id
from public.factory_benchmark_trials t join public.factory_benchmark_trial_results result on result.trial_id = t.id
join public.agent_jobs j on j.id = t.job_id join public.agent_runs run on run.id = t.run_id
where t.id = pg_temp.replay_id(60)$$,
$$select 'success'::text, 'success'::text, 'success'::text, repeat('a', 40), repeat('b', 40), pg_temp.replay_id(700)$$,
 'retained output binds the complete job and run to their exact input, checkpoint, and fixture evidence');

select pg_temp.admit_trial(61);
select is((select job_id from public.claim_next_worker_dispatch(true, 100, 5, 60000)),
  (select job_id from public.factory_benchmark_trials where id = pg_temp.replay_id(61)),
  'native opt-in claims the exact observed trial job');
select pg_temp.start_trial(61);
select ok((select t.deadline_at <= d.deadline_at from public.factory_benchmark_trials t
  join public.worker_dispatches d on d.job_id = t.job_id and d.attempt_count = t.attempt_count
  where t.id = pg_temp.replay_id(61)), 'trial expiration also respects the exact native dispatch deadline');
select is(pg_temp.cancel_trial(61, true), false, 'a stale cancellation does not own the active run');
select ok(pg_temp.cancel_trial(61), 'the exact admitted run can be canceled');
select is(pg_temp.finish_trial(61), false, 'cancellation wins against a late completion');
select is((select status from public.factory_benchmark_trials where id = pg_temp.replay_id(61)), 'canceled',
  'the common cancellation fence persists the trial terminal receipt');

select pg_temp.admit_trial(62);
select id from public.claim_next_agent_job(true);
select pg_temp.start_trial(62);
select ok(public.fail_factory_benchmark_trial(id, job_id, attempt_count, run_id, 'validation_failed'),
  'the exact running attempt records a worker failure')
from public.factory_benchmark_trials where id = pg_temp.replay_id(62);
select is((select failure_code from public.factory_benchmark_trials where id = pg_temp.replay_id(62)), 'validation_failed',
  'worker failure persists a bounded terminal reason for the exact trial');
select is(pg_temp.finish_trial(62), false, 'stale success cannot rewrite a failed trial');

select pg_temp.admit_trial(63);
select id from public.claim_next_agent_job(true);
select is(public.fail_stalled_session_job_attempt(job_id, 1, 'Worker did not start.', true, 0), 'error',
  'an unstarted trial is failed rather than deferred to a production release')
from public.factory_benchmark_trials where id = pg_temp.replay_id(63);
select results_eq($$select t.failure_code, j.status::text, r.status::text from public.factory_benchmark_trials t
  join public.agent_jobs j on j.id = t.job_id join public.agent_runs r on r.id = t.run_id where t.id = pg_temp.replay_id(63)$$,
  $$values ('attempt_lost', 'error', 'error')$$,
  'the common stall recovery retires the trial, claimed job, and unbound run');
select is(pg_temp.start_trial(63), null::uuid, 'a recovered trial claim cannot execute later');

select * from finish();
rollback;
