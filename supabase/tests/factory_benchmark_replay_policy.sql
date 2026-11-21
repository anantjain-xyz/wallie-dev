begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.replay_id(slot integer) returns uuid language sql immutable as $$
  select ('61500000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values
  (pg_temp.replay_id(1), 'benchmark-policy-owner@example.test'),
  (pg_temp.replay_id(2), 'benchmark-policy-reader@example.test'),
  (pg_temp.replay_id(3), 'benchmark-policy-other-owner@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.replay_id(11), 'benchmark-policy-primary', 'Benchmark policy primary'),
  (pg_temp.replay_id(12), 'benchmark-policy-other', 'Benchmark policy other');
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
  source_job_id, source_attempt_count, definition_revision_id)
select task_id, workspace_id, factory_id, pg_temp.replay_id(43), pg_temp.replay_id(42), pg_temp.replay_id(44),
  1, pg_temp.replay_id(49) from replay_task;

create temp table replay_fixtures(key text primary key, id uuid not null, response_sha256 text not null);
create temp table replay_policies(key text primary key, id uuid not null, policy_digest text not null);
create temp table replay_evidence(key text primary key, receipt jsonb not null);
grant select on replay_scope, replay_task to service_role;
grant select, insert on replay_fixtures, replay_policies, replay_evidence to service_role;

create function pg_temp.fixture(p_scope text, p_operation public.benchmark_replay_operation,
  p_key text, p_response text, p_expected uuid default null)
returns table (id uuid, revision_number integer, response_sha256 text) language sql as $$
  select stored.* from replay_scope scope cross join lateral public.publish_factory_benchmark_replay_fixture(
    scope.workspace_id, scope.factory_id, scope.owner_id, p_operation, repeat(p_key, 64), p_response, p_expected) stored
  where scope.key = p_scope
$$;
create function pg_temp.policy(p_scope text, p_profile public.benchmark_replay_profile,
  p_base text default null, p_fixtures uuid[] default '{}', p_actor integer default null)
returns public.factory_benchmark_replay_policy_revisions language sql as $$
  select revision.* from replay_scope scope left join replay_policies base on base.key = p_base
  cross join lateral public.publish_factory_benchmark_replay_policy(scope.workspace_id, scope.factory_id,
    coalesce(pg_temp.replay_id(p_actor), scope.owner_id), p_profile, base.id, p_fixtures) revision
  where scope.key = p_scope
$$;
create function pg_temp.open_replay(p_policy text, p_slot integer, p_restoration_sha text default repeat('d', 64),
  p_digest text default null)
returns public.factory_benchmark_replay_executions language sql as $$
  select execution.* from replay_scope scope cross join replay_task task cross join replay_policies policy
  cross join lateral public.open_factory_benchmark_replay_execution(scope.workspace_id, scope.factory_id, scope.owner_id,
    pg_temp.replay_id(p_slot), task.id, policy.id, coalesce(p_digest, policy.policy_digest), p_restoration_sha) execution
  where scope.key = 'primary' and policy.key = p_policy
$$;
create function pg_temp.replay_operation(p_execution integer, p_slot integer,
  p_operation public.benchmark_replay_operation, p_key text default null, p_scope text default 'primary')
returns jsonb language sql as $$
  select public.record_factory_benchmark_replay_operation(workspace_id, factory_id, pg_temp.replay_id(p_execution),
    pg_temp.replay_id(p_slot), p_operation, repeat(p_key, 64)) from replay_scope where key = p_scope
$$;

select ok(not has_table_privilege('authenticated', 'public.factory_benchmark_replay_fixture_revisions', 'SELECT')
  and not has_table_privilege('service_role', 'public.factory_benchmark_replay_fixture_revisions', 'SELECT')
  and not has_column_privilege('authenticated', 'public.factory_benchmark_replay_operations', 'fixture_key', 'SELECT')
  and has_column_privilege('authenticated', 'public.factory_benchmark_replay_operations', 'decision', 'SELECT'),
  'fixture bodies and raw fingerprints cannot be queried through the evidence surface');
select ok(has_function_privilege('service_role', signature, 'EXECUTE')
  and not has_function_privilege('authenticated', signature, 'EXECUTE')
  and not has_function_privilege('anon', signature, 'EXECUTE'), 'only the service operation command can release fixture bytes')
from (values ('public.record_factory_benchmark_replay_operation(uuid,uuid,uuid,uuid,public.benchmark_replay_operation,text)')) rpc(signature);

set local role service_role;
select public.grant_factory_membership(workspace_id, factory_id, owner_id, pg_temp.replay_id(22), 'member')
from replay_scope where key = 'primary';
select throws_ok($$select pg_temp.policy('primary', 'blocked', p_actor => 2)$$, '42501', null,
  'a factory member cannot publish a replay policy');
select throws_ok($$select pg_temp.fixture('primary', 'external_tool', 'a', '{}')$$, '22023', null,
  'generic external tools can never receive an approved fixture');
select throws_ok($$select pg_temp.fixture('primary', 'tool_read', 'a', '{"value":1,"value":2}')$$, '22023', null,
  'fixture JSON with ambiguous keys is rejected');

insert into replay_fixtures select 'read-original', id, response_sha256
from pg_temp.fixture('primary', 'tool_read', 'a', E'{"answer":"captured"}\n');
insert into replay_fixtures select 'read-later', id, response_sha256
from pg_temp.fixture('primary', 'tool_read', 'a', '{"answer":"later"}',
  (select id from replay_fixtures where key = 'read-original'));
insert into replay_fixtures select 'local-test', id, response_sha256
from pg_temp.fixture('primary', 'git_write', 'b', '{"simulation":"accepted"}');
insert into replay_fixtures select 'foreign', id, response_sha256
from pg_temp.fixture('foreign', 'tool_read', 'c', '{"answer":"other factory"}');
insert into replay_fixtures select 'sibling', id, response_sha256
from pg_temp.fixture('sibling', 'tool_read', 'd', '{"answer":"sibling factory"}');
select throws_ok($$select pg_temp.fixture('primary', 'tool_read', 'a', '{}',
  (select id from replay_fixtures where key = 'read-original'))$$, 'PT409', null, 'stale fixture edits are rejected');

insert into replay_policies select 'blocked', id, policy_digest from pg_temp.policy('primary', 'blocked');
insert into replay_policies select 'foreign', id, policy_digest from pg_temp.policy('foreign', 'blocked');
insert into replay_policies select 'sibling', id, policy_digest from pg_temp.policy('sibling', 'blocked');
select throws_ok($$select pg_temp.policy('primary', 'recorded_fixtures')$$, 'PT409', null,
  'a stale policy base cannot advance the revision');
select throws_ok($$select pg_temp.policy('primary', 'recorded_fixtures', 'blocked',
  array(select id from replay_fixtures where key = 'foreign'))$$, 'PT422', null,
  'a policy cannot approve a fixture revision across factory boundaries');
select throws_ok($$select pg_temp.policy('primary', 'recorded_fixtures', 'blocked',
  array(select id from replay_fixtures where key = 'sibling'))$$, 'PT422', null,
  'a policy cannot approve a fixture from a sibling factory in the same workspace');
select throws_ok($$select pg_temp.policy('primary', 'recorded_fixtures', 'blocked',
  array(select id from replay_fixtures where key = 'local-test'))$$, 'PT422', null,
  'recorded-read mode cannot approve a write-like fixture');
select throws_ok($$select pg_temp.policy('primary', 'recorded_fixtures', 'blocked',
  array(select id from replay_fixtures where key in ('read-original', 'read-later')))$$, 'PT422', null,
  'a policy cannot bind two revisions of the same exact fixture request');

insert into replay_policies select 'recorded', id, policy_digest from pg_temp.policy('primary', 'recorded_fixtures', 'blocked',
  array(select id from replay_fixtures where key = 'read-original'));
insert into replay_policies select 'isolated', id, policy_digest from pg_temp.policy('primary', 'isolated_test', 'recorded',
  array(select id from replay_fixtures where key in ('local-test', 'read-later') order by key));
insert into replay_policies select 'reordered', id, policy_digest from pg_temp.policy('primary', 'isolated_test', 'isolated',
  array(select id from replay_fixtures where key in ('local-test', 'read-later') order by key desc));
select is((select policy_digest from replay_policies where key = 'isolated'),
  (select policy_digest from replay_policies where key = 'reordered'), 'fixture array order does not change the canonical digest');

select pg_temp.open_replay('blocked', 70);
select pg_temp.open_replay('recorded', 71);
select pg_temp.open_replay('isolated', 72);
select is((pg_temp.open_replay('recorded', 71)).id, pg_temp.replay_id(71), 'an exact retry joins its existing replay execution');
select throws_ok($$select pg_temp.open_replay('recorded', 71, repeat('e', 64))$$, 'PT409', null,
  'a replay execution identity cannot bind a different restoration');
select throws_ok($$select pg_temp.open_replay('recorded', 73, p_digest => repeat('e', 64))$$, 'PT409', null,
  'a new execution must use the exact selected policy digest');
select throws_ok($$select pg_temp.open_replay('foreign', 73)$$, 'P0002', null,
  'an execution cannot pin a foreign policy');
select throws_ok($$select pg_temp.replay_operation(71, 80, 'tool_read', 'a', 'foreign')$$, 'P0002', null,
  'an operation cannot reuse an execution in another factory');

insert into replay_evidence values
  ('blocked', pg_temp.replay_operation(70, 80, 'tool_read', 'a')),
  ('recorded-read', pg_temp.replay_operation(71, 81, 'tool_read', 'a')),
  ('foreign-request', pg_temp.replay_operation(71, 82, 'tool_read', 'c')),
  ('production-write', pg_temp.replay_operation(71, 83, 'git_write', 'b')),
  ('isolated-test', pg_temp.replay_operation(72, 84, 'git_write', 'b')),
  ('external-tool', pg_temp.replay_operation(72, 85, 'external_tool', 'b'));
select results_eq($$select key, receipt->>'decision', receipt->>'reason', receipt->>'responseJson' from replay_evidence order by key$$,
  $$values ('blocked', 'denied', 'policy_blocked', null::text),
    ('external-tool', 'denied', 'operation_blocked', null::text),
    ('foreign-request', 'denied', 'fixture_unavailable', null::text),
    ('isolated-test', 'stubbed', 'fixture_matched', '{"simulation":"accepted"}'),
    ('production-write', 'denied', 'operation_blocked', null::text),
    ('recorded-read', 'stubbed', 'fixture_matched', E'{"answer":"captured"}\n')$$,
  'only the pinned recorded read and explicitly approved isolated simulation return exact fixture bytes');
select results_eq($$select receipt->>'fixtureRevisionId', receipt->>'fixtureResponseSha256' from replay_evidence where key = 'recorded-read'$$,
  $$select id::text, response_sha256 from replay_fixtures where key = 'read-original'$$,
  'fixture provenance pins the original revision and SHA despite later fixture edits');
select is(pg_temp.replay_operation(71, 81, 'tool_read', 'a'),
  (select receipt from replay_evidence where key = 'recorded-read'), 'an operation retry returns the original decision and fixture');
select throws_ok($$select pg_temp.replay_operation(71, 81, 'tool_read', 'c')$$, 'PT409', null,
  'an operation UUID cannot change its canonical request');

select public.revoke_factory_benchmark_replay_revision(scope.workspace_id, scope.factory_id, scope.owner_id,
  p_fixture_revision_id => fixture.id) from replay_scope scope cross join replay_fixtures fixture
where scope.key = 'primary' and fixture.key = 'read-original';
select throws_ok($$select pg_temp.replay_operation(71, 81, 'tool_read', 'a')$$, '42501', null,
  'a committed duplicate cannot re-serve fixture bytes after revocation');
select is(pg_temp.replay_operation(71, 86, 'tool_read', 'a')->>'reason', 'fixture_revoked',
  'a fresh operation records the revoked fixture denial');
select public.revoke_factory_benchmark_replay_revision(scope.workspace_id, scope.factory_id, scope.owner_id,
  p_policy_revision_id => policy.id) from replay_scope scope cross join replay_policies policy
where scope.key = 'primary' and policy.key = 'isolated';
select throws_ok($$select pg_temp.open_replay('isolated', 73)$$, '42501', null,
  'a revoked policy cannot open another execution');
select is(pg_temp.replay_operation(72, 87, 'git_write', 'b')->>'reason', 'policy_blocked',
  'revocation also blocks fixture release to an already opened execution');
reset role;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '61500000-0000-4000-8000-000000000002';
select results_eq($$select workspace_id from public.factory_benchmark_replay_policy_revisions
  where workspace_id in (pg_temp.replay_id(11), pg_temp.replay_id(12))$$,
  $$select pg_temp.replay_id(11) from generate_series(1, 4)$$,
  'factory members see only scoped policy revisions, including within the same workspace');
select results_eq($$select decision, reason from public.factory_benchmark_replay_operations
  where execution_id = pg_temp.replay_id(71) and operation_id = pg_temp.replay_id(81)$$,
  $$values ('stubbed', 'fixture_matched')$$,
  'retained safe evidence remains readable after revocation');
select throws_ok($$select fixture_key from public.factory_benchmark_replay_operations$$, '42501', null,
  'the authenticated evidence surface cannot read exact request fingerprints');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

delete from public.sessions where id = pg_temp.replay_id(42);
select throws_ok($$select pg_temp.replay_operation(70, 89, 'tool_read', 'a')$$, 'P0002', null,
  'an opened execution cannot authorize a fresh operation after source deletion');
select is((select count(*) from public.factory_benchmark_replay_executions where workspace_id = pg_temp.replay_id(11)),
  3::bigint, 'source deletion retains redacted replay execution history');
delete from public.workspaces where id = pg_temp.replay_id(11);
select results_eq($$select workspace_id from public.factory_benchmark_replay_policy_revisions
  where workspace_id in (pg_temp.replay_id(11), pg_temp.replay_id(12))$$,
  $$select pg_temp.replay_id(12)$$, 'workspace deletion removes owned replay history and preserves other scopes');

select * from finish();
rollback;
