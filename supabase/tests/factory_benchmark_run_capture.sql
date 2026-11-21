begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.capture_id(slot integer) returns uuid language sql immutable as $$
  select ('61200000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values
  (pg_temp.capture_id(1), 'benchmark-capture-owner@example.test'),
  (pg_temp.capture_id(2), 'benchmark-capture-reader@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.capture_id(11), 'benchmark-capture', 'Benchmark capture');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.capture_id(21), pg_temp.capture_id(11), pg_temp.capture_id(1), 'human', 'owner'),
  (pg_temp.capture_id(22), pg_temp.capture_id(11), pg_temp.capture_id(2), 'human', 'member');
insert into public.factories(id, workspace_id, name, slug, is_default)
values (pg_temp.capture_id(31), pg_temp.capture_id(11), 'Other factory', 'other', false);
create temp table capture_scope as
select workspace_id, id as factory_id from public.factories where workspace_id = pg_temp.capture_id(11) and is_default;

insert into public.pipelines(id, workspace_id, factory_id, name)
select pg_temp.capture_id(40), workspace_id, factory_id, 'Benchmark source pipeline' from capture_scope;
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name)
values (pg_temp.capture_id(41), pg_temp.capture_id(11), pg_temp.capture_id(40), 1, 'review', 'Review');

with definition as (
  select workspace_id, factory_id,
    jsonb_build_object('schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.capture_id(40))::text as body
  from capture_scope
), revision as (
  insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version,
    definition_json, canonical_digest, created_by)
  select pg_temp.capture_id(60), workspace_id, factory_id, 1, body,
    encode(sha256(convert_to(body, 'UTF8')), 'hex'), pg_temp.capture_id(1) from definition
  returning id, workspace_id, factory_id, created_by
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 1, created_by from revision;

insert into public.sessions(id, workspace_id, factory_id, number, title, prompt_md, pipeline_id, current_stage_id,
  factory_definition_provenance, factory_definition_revision_id)
select pg_temp.capture_id(42), workspace_id, factory_id, 1, 'Current title', 'Current prompt', pg_temp.capture_id(40),
  pg_temp.capture_id(41), 'pinned', pg_temp.capture_id(60) from capture_scope;
insert into public.session_factory_admission_inputs(session_id, workspace_id, factory_id, activation_number,
  definition_revision_id, definition_digest, pipeline_id, selected_stage_ids, model_provider, model_name,
  title_sha256, prompt_sha256, original_title, original_prompt_md)
select pg_temp.capture_id(42), workspace_id, factory_id, 1, id, canonical_digest, pg_temp.capture_id(40),
  array[pg_temp.capture_id(41)], 'codex', 'gpt-5.5',
  encode(sha256(convert_to('Original title', 'UTF8')), 'hex'), encode(sha256(convert_to('Original request', 'UTF8')), 'hex'),
  'Original title', 'Original request'
from public.factory_definition_revisions where id = pg_temp.capture_id(60);

insert into public.agent_jobs(id, workspace_id, session_id, stage_id, stage_slug, trigger_type, status, attempt_count,
  started_at, finished_at)
select pg_temp.capture_id(job_slot), pg_temp.capture_id(11), pg_temp.capture_id(42), pg_temp.capture_id(41), 'review',
  'manual_run', 'success', 1, clock_timestamp() - interval '1 minute', clock_timestamp()
from (values (47), (65), (66)) fixtures(job_slot);
insert into public.agent_runs(id, workspace_id, session_id, agent_job_id, stage_id, stage_slug, run_type,
  model_provider, model_name, status, attempt_count, started_at, finished_at)
select pg_temp.capture_id(slot), pg_temp.capture_id(11), pg_temp.capture_id(42), pg_temp.capture_id(job_slot),
  pg_temp.capture_id(41), 'review', 'project', 'codex', 'gpt-5.5',
  case when slot = 45 then 'queued'::public.agent_run_status else 'success' end, 1,
  clock_timestamp() - interval '1 minute', case when slot <> 45 then clock_timestamp() end
from (values (43, null), (44, 47), (45, null), (46, null), (48, null), (49, 65), (50, 66)) fixtures(slot, job_slot);
insert into public.session_attempt_manifests(run_id, workspace_id, session_id, job_id, attempt_count, stage_id,
  definition_provenance, definition_revision_id, definition_digest, definition_skill_ids, definition_tool_ids,
  repository_id, repository_full_name, base_branch, initial_base_sha, input_sha, input_ref, checkout_sha,
  prompt_sha256, prompt_utf8_bytes, renderer_version, predecessors, worker_runtime, run_type, model_provider, model_name)
select run.id, run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count, run.stage_id,
  'pinned', revision.id, revision.canonical_digest, '{}', '{}', pg_temp.capture_id(61), 'fixture/benchmark', 'main',
  repeat('a', 40), repeat('b', 40), 'refs/heads/wallie/checkpoints/fixture', repeat('b', 40), repeat('c', 64),
  16, 3, '[]', 'node', run.run_type, run.model_provider, run.model_name
from public.agent_runs run cross join public.factory_definition_revisions revision
where run.id in (pg_temp.capture_id(44), pg_temp.capture_id(49), pg_temp.capture_id(50))
  and revision.id = pg_temp.capture_id(60);
with proof as (
  select run_slot, job_slot, jsonb_build_object('version', version, 'required', '[]'::jsonb,
    'documents', documents, 'conversation', '{"throughSequence":0,"olderOmitted":0,"messages":[]}'::jsonb,
    'budget', jsonb_build_object('maxUtf8Bytes', 131072, 'maxEstimatedTokens', 32768,
      'usedUtf8Bytes', used, 'estimatedTokens', used)) || extra as manifest
  from (values
    (44, 47, 1, '[]'::jsonb, 0, '{}'::jsonb),
    (49, 65, 1, jsonb_build_array(jsonb_build_object(
      'sourceId', pg_temp.capture_id(71), 'revisionId', pg_temp.capture_id(72), 'status', 'selected',
      'reason', 'exact_revision', 'filePath', 'docs/removed.md', 'upstreamRevision', repeat('d', 40),
      'contentSha256', repeat('e', 64), 'contentBytes', 10, 'stale', false, 'sha256', repeat('f', 64), 'utf8Bytes', 50
    )), 50, '{}'::jsonb),
    (50, 66, 2, '[]'::jsonb, 4, jsonb_build_object('memories', jsonb_build_array(jsonb_build_object(
      'memoryId', pg_temp.capture_id(73), 'revisionId', pg_temp.capture_id(74), 'status', 'selected',
      'approvalId', pg_temp.capture_id(75), 'sha256', repeat('d', 64), 'utf8Bytes', 4
    ))))
  ) context(run_slot, job_slot, version, documents, used, extra)
)
insert into public.session_run_context_manifests(run_id, workspace_id, session_id, job_id, attempt_count, manifest, manifest_sha256)
select pg_temp.capture_id(run_slot), pg_temp.capture_id(11), pg_temp.capture_id(42), pg_temp.capture_id(job_slot), 1,
  manifest, encode(sha256(convert_to(manifest::text, 'UTF8')), 'hex') from proof;

create temp table capture_results(key text primary key, receipt jsonb not null);
grant select on capture_scope to service_role;
grant select, insert on capture_results to service_role;

create function pg_temp.capture(
  p_run integer, p_suite integer, p_expected uuid default null, p_new_name text default null,
  p_new_purpose text default null, p_actor integer default 1, p_factory_id uuid default null,
  p_criteria text default 'Original benchmark criteria.', p_expected_task uuid default null
) returns jsonb language sql as $$
  select public.capture_factory_benchmark_run(workspace_id, coalesce(p_factory_id, factory_id), pg_temp.capture_id(p_actor),
    pg_temp.capture_id(p_run), p_criteria, 'Review behavior', 'eligible', pg_temp.capture_id(p_suite),
    null, p_expected, p_new_name, p_new_purpose, p_expected_task) from capture_scope
$$;

create function pg_temp.replay_access(
  p_capture text, p_actor integer default 1, p_factory_id uuid default null
) returns boolean language sql as $$
  select public.assert_factory_benchmark_replay_access(workspace_id, coalesce(p_factory_id, factory_id),
    pg_temp.capture_id(p_actor), (receipt->>'taskRevisionId')::uuid)
  from capture_scope cross join capture_results where key = p_capture
$$;

select ok(has_function_privilege('service_role', command, 'EXECUTE')
  and not has_function_privilege('authenticated', command, 'EXECUTE')
  and not has_function_privilege('anon', command, 'EXECUTE'), 'replay access assertion is service-only')
from (values ('public.assert_factory_benchmark_replay_access(uuid,uuid,uuid,uuid)')) access(command);

select ok(not has_table_privilege('authenticated', 'public.factory_benchmark_task_inputs', 'SELECT')
  and not has_table_privilege('anon', 'public.factory_benchmark_task_inputs', 'SELECT')
  and has_table_privilege('service_role', 'public.factory_benchmark_task_inputs', 'SELECT')
  and not has_table_privilege('service_role', 'public.factory_benchmark_task_inputs', 'INSERT, UPDATE, DELETE'),
  'exact capture receipts are service-readable and writable only through the mutation');
select ok(has_function_privilege('service_role', command, 'EXECUTE')
  and not has_function_privilege('authenticated', command, 'EXECUTE')
  and not has_function_privilege('anon', command, 'EXECUTE'), 'capture command is service-only')
from (values ('public.capture_factory_benchmark_run(uuid,uuid,uuid,uuid,text,text,text,uuid,text,uuid,text,text,uuid)')) access(command);

set local role service_role;
select public.grant_factory_membership(workspace_id, factory_id, pg_temp.capture_id(1), pg_temp.capture_id(22), 'member')
from capture_scope;
select throws_ok($$select pg_temp.capture(44, 91, p_new_name => 'Reader suite', p_new_purpose => 'holdout', p_actor => 2)$$,
  '42501', null, 'a factory member cannot capture a benchmark without manager access');
select throws_ok($$select pg_temp.capture(44, 91, p_new_name => 'Other suite', p_new_purpose => 'holdout',
  p_factory_id => pg_temp.capture_id(31))$$, 'P0002', null, 'capture cannot consume a run in another factory');
select throws_ok($$select pg_temp.capture(45, 91, p_new_name => 'Pending suite', p_new_purpose => 'holdout')$$,
  'PT422', null, 'a pending run cannot be captured');
select throws_ok($$select pg_temp.capture(44, 91, p_new_name => 'Criteria suite', p_new_purpose => 'holdout', p_criteria => '')$$,
  '22023', null, 'a new task requires acceptance criteria');
select throws_ok($$select pg_temp.capture(44, 91, p_new_name => 'Unknown revision', p_new_purpose => 'holdout',
  p_expected_task => pg_temp.capture_id(99))$$,
  'PT409', 'The benchmark task changed. Reload its revision before saving.',
  'a task that no longer matches the preview cannot be recreated implicitly');

insert into capture_results values ('created', pg_temp.capture(44, 90, p_new_name => 'Frozen run suite', p_new_purpose => 'regression'));
select is((select receipt->>'suiteId' from capture_results where key = 'created'), pg_temp.capture_id(90)::text,
  'creating a suite uses the supplied stable request identity');
select results_eq($$select revision.acceptance_criteria, revision.replay_eligibility
  from public.factory_benchmark_task_revisions revision
  join capture_results result on revision.id = (result.receipt->>'taskRevisionId')::uuid where result.key = 'created'$$,
  $$values ('Original benchmark criteria.', 'eligible')$$,
  'complete retained inputs keep the positive assessment and task-specific criteria');
select is(pg_temp.capture(44, 90, p_new_name => 'Frozen run suite', p_new_purpose => 'regression', p_criteria => 'Replacement'),
  (select jsonb_set(receipt, '{added}', 'false') from capture_results where key = 'created'),
  'repeating a create/add returns the pinned membership without changing frozen acceptance');
select throws_ok($$select pg_temp.capture(48, 90, p_new_name => 'Wrong request', p_new_purpose => 'holdout')$$,
  'PT409', null, 'a different run cannot reuse an existing create request identity');

insert into capture_results
select 'tagged-task', jsonb_build_object('taskId', task.task_id, 'taskRevisionId', task.id)
from capture_scope cross join lateral public.create_factory_benchmark_task(workspace_id, factory_id, pg_temp.capture_id(1),
  pg_temp.capture_id(43), 'Existing task', 'Frozen earlier criteria.', '{ui}') task;
insert into capture_results
select 'tagged-suite', jsonb_build_object('suiteId', suite.suite_id, 'suiteRevisionId', suite.id)
from capture_scope cross join lateral public.save_factory_benchmark_suite_revision(workspace_id, factory_id, pg_temp.capture_id(1),
  'Tagged suite', 'holdout', p_selection_tags => '{ui}') suite;
select public.save_factory_benchmark_task_revision(workspace_id, factory_id, pg_temp.capture_id(1),
  (receipt->>'taskId')::uuid, (receipt->>'taskRevisionId')::uuid, 'Changed task', 'New criteria.', '{}', 'unverified')
from capture_scope cross join capture_results where key = 'tagged-task';

select throws_ok($$select public.capture_factory_benchmark_run(workspace_id, factory_id, pg_temp.capture_id(1), pg_temp.capture_id(44),
  'An unsaved task', 'Review behavior', 'eligible', (receipt->>'suiteId')::uuid,
  p_expected_revision_id => (receipt->>'suiteRevisionId')::uuid)
from capture_scope cross join capture_results where key = 'tagged-suite'$$,
  'PT409', 'The benchmark task changed. Reload its revision before saving.',
  'a task created after preview cannot replace the criteria entered for a new task');

insert into capture_results
select 'edited', jsonb_build_object('taskId', revision.task_id, 'taskRevisionId', revision.id)
from capture_scope join capture_results original on original.key = 'created'
cross join lateral public.save_factory_benchmark_task_revision(workspace_id, factory_id, pg_temp.capture_id(1),
  (original.receipt->>'taskId')::uuid, (original.receipt->>'taskRevisionId')::uuid, 'Review behavior',
  'Updated benchmark criteria.', '{}', 'eligible') revision;
select throws_ok($$select public.capture_factory_benchmark_run(workspace_id, factory_id, pg_temp.capture_id(1), pg_temp.capture_id(44),
  'Outdated criteria', 'Review behavior', 'eligible', (suite.receipt->>'suiteId')::uuid,
  p_expected_revision_id => (suite.receipt->>'suiteRevisionId')::uuid,
  p_expected_task_revision_id => (original.receipt->>'taskRevisionId')::uuid)
from capture_scope join capture_results suite on suite.key = 'tagged-suite'
join capture_results original on original.key = 'created'$$,
  'PT409', 'The benchmark task changed. Reload its revision before saving.',
  'a stale preview cannot add an edited task to an otherwise current suite');
select is((select count(*) from public.factory_benchmark_suite_revisions revision
  join capture_results suite on revision.suite_id = (suite.receipt->>'suiteId')::uuid where suite.key = 'tagged-suite'),
  1::bigint, 'stale task conflicts leave the selected suite revision unchanged');
select results_eq($$select revision.revision_number, revision.acceptance_criteria
  from public.factory_benchmark_task_revisions revision
  join capture_results original on revision.task_id = (original.receipt->>'taskId')::uuid
  where original.key = 'created' order by revision.revision_number$$,
  $$values (1, 'Original benchmark criteria.'), (2, 'Updated benchmark criteria.')$$,
  'stale task conflicts preserve the original and edited acceptance criteria');
select is(pg_temp.capture(44, 90, p_new_name => 'Frozen run suite', p_new_purpose => 'regression',
  p_expected_task => (select (receipt->>'taskRevisionId')::uuid from capture_results where key = 'created')),
  (select jsonb_set(receipt, '{added}', 'false') from capture_results where key = 'created'),
  'retrying a committed add returns the original frozen member despite a subsequent task revision');

insert into capture_results
select 'appended', public.capture_factory_benchmark_run(workspace_id, factory_id, pg_temp.capture_id(1), pg_temp.capture_id(44),
  'Unused criteria', 'Review behavior', 'eligible', (suite.receipt->>'suiteId')::uuid,
  p_expected_revision_id => (suite.receipt->>'suiteRevisionId')::uuid,
  p_expected_task_revision_id => (current_task.receipt->>'taskRevisionId')::uuid)
from capture_scope join capture_results suite on suite.key = 'tagged-suite'
join capture_results current_task on current_task.key = 'edited';
select throws_ok($$select public.capture_factory_benchmark_run(workspace_id, factory_id, pg_temp.capture_id(1), pg_temp.capture_id(48),
  'No orphan criteria', 'Review behavior', 'eligible', (receipt->>'suiteId')::uuid,
  p_expected_revision_id => (receipt->>'suiteRevisionId')::uuid)
from capture_scope cross join capture_results where key = 'tagged-suite'$$,
  'PT409', null, 'a true add rejects a stale suite base');
select is((select appended.receipt->>'taskId' from capture_results appended where appended.key = 'appended'),
  (select receipt->>'taskId' from capture_results where key = 'created'), 'a second suite reuses the stable task identity');
select set_eq($$select member.task_revision_id from public.factory_benchmark_suite_members member
  join capture_results suite on member.suite_revision_id = (suite.receipt->>'suiteRevisionId')::uuid
  where suite.key = 'appended'$$,
  $$select (receipt->>'taskRevisionId')::uuid from capture_results where key in ('tagged-task', 'edited')$$,
  'manual add copies exact earlier member revisions even when the prior tag no longer matches');
select is((select count(*) from public.factory_benchmark_tasks where source_run_id = pg_temp.capture_id(48)),
  0::bigint, 'conflicting or stale requests leave no orphan task');

insert into capture_results values ('missing', pg_temp.capture(46, 92, p_new_name => 'Incomplete run', p_new_purpose => 'holdout'));
select ok((select revision.replay_eligibility = 'ineligible' and revision.eligibility_reason is not null
  from public.factory_benchmark_task_revisions revision join capture_results result on revision.id = (result.receipt->>'taskRevisionId')::uuid
  where result.key = 'missing'), 'declared eligibility cannot override missing exact input receipts');
insert into capture_results values
  ('unavailable-document', pg_temp.capture(49, 93, p_new_name => 'Removed document', p_new_purpose => 'holdout')),
  ('unavailable-memory', pg_temp.capture(50, 94, p_new_name => 'Removed memory', p_new_purpose => 'holdout'));
select results_eq($$select result.key, revision.replay_eligibility, revision.eligibility_reason
  from public.factory_benchmark_task_revisions revision join capture_results result on revision.id = (result.receipt->>'taskRevisionId')::uuid
  where result.key like 'unavailable-%' order by result.key$$,
  $$values ('unavailable-document', 'ineligible', 'A recorded context document was deleted or is unavailable.'),
    ('unavailable-memory', 'ineligible', 'A recorded memory revision is no longer available to this factory.')$$,
  'capture rechecks retained documents and memories before accepting a positive assessment');
reset role;

insert into public.session_attachments(id, workspace_id, session_id, uploaded_by_member_id,
  original_filename, content_type, size_bytes, storage_path, position, status, attached_at)
values (pg_temp.capture_id(80), pg_temp.capture_id(11), pg_temp.capture_id(42), pg_temp.capture_id(21),
  'benchmark-fixture.png', 'image/png', 12, pg_temp.capture_id(11)::text || '/benchmark-fixture.png',
  1, 'attached', clock_timestamp());
set local role service_role;
insert into capture_results
select 'image', pg_temp.capture(44, 95, p_new_name => 'Image input', p_new_purpose => 'holdout',
  p_expected_task => (receipt->>'taskRevisionId')::uuid)
from capture_results where key = 'edited';
select results_eq($$select revision.acceptance_criteria, revision.replay_eligibility, revision.eligibility_reason
  from public.factory_benchmark_task_revisions revision
  join capture_results result on revision.id = (result.receipt->>'taskRevisionId')::uuid where result.key = 'image'$$,
  $$values ('Updated benchmark criteria.', 'ineligible',
    'The original session image inputs do not have a retained integrity receipt.')$$,
  'an otherwise eligible capture with an unverified image input preserves its criteria and records the limit');
select ok(pg_temp.replay_access('created'),
  'the original eligible task revision can pass authorization after a later ineligible revision');
select throws_ok($$select pg_temp.replay_access('image')$$, 'P0002', null,
  'replay cannot use an ineligible revision of an otherwise captured task');
select throws_ok($$select pg_temp.replay_access('created', p_actor => 2)$$, '42501', null,
  'a factory reader cannot authorize retained replay inputs');
select throws_ok($$select pg_temp.replay_access('created', p_factory_id => pg_temp.capture_id(31))$$, 'P0002', null,
  'a workspace owner cannot authorize replay through another factory scope');
reset role;

select results_eq($$select input.source_job_id, input.source_attempt_count, input.checkout_sha, input.input_ref,
    input.original_prompt_sha256, input.rendered_prompt_sha256, input.definition_revision_id, input.context_manifest_sha256
  from public.factory_benchmark_task_inputs input where input.source_run_id = pg_temp.capture_id(44)$$,
  $$select pg_temp.capture_id(47), 1, repeat('b', 40), 'refs/heads/wallie/checkpoints/fixture'::text,
    encode(sha256(convert_to('Original request', 'UTF8')), 'hex'), repeat('c', 64), pg_temp.capture_id(60),
    manifest_sha256 from public.session_run_context_manifests where run_id = pg_temp.capture_id(44)$$,
  'the private receipt pins exact dispatch and admission references instead of the current session prompt');
select throws_ok($$update public.factory_benchmark_task_inputs set checkout_sha = repeat('a', 40)
  where source_run_id = pg_temp.capture_id(44)$$, '23514', null, 'capture receipts are immutable');
select public.archive_session_job_attempts(pg_temp.capture_id(42), pg_temp.capture_id(11),
  'Archive the replay source to erase retained inputs');
create temp table captured_source_archive as
select workspace_id, factory_id, id as session_id, archived_at from public.sessions
where id = pg_temp.capture_id(42);
grant select on captured_source_archive to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '61200000-0000-4000-8000-000000000001';
select is((select (public.erase_session_retained_content(workspace_id, factory_id, session_id, archived_at)).session_id
  from captured_source_archive), pg_temp.capture_id(42), 'the owner erases retained source content');
reset role;
set local request.jwt.claim.role = 'service_role';
set local role service_role;
select throws_ok($$select pg_temp.replay_access('created')$$, 'P0002', null,
  'erasure blocks replay of the previously eligible historical task revision');
reset role;

delete from public.sessions where id = pg_temp.capture_id(42);
select is(pg_temp.capture(44, 90, p_new_name => 'Frozen run suite', p_new_purpose => 'regression'),
  (select jsonb_set(receipt, '{added}', 'false') from capture_results where key = 'created'),
  'a retry after source removal returns the already committed capture');
select is((select checkout_sha from public.factory_benchmark_task_inputs where source_run_id = pg_temp.capture_id(44)),
  repeat('b', 40), 'source deletion preserves the captured reference for attribution');

select * from finish();
rollback;
