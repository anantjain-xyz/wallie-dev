begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.benchmark_id(slot integer) returns uuid language sql immutable as $$
  select ('61100000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values
  (pg_temp.benchmark_id(1), 'benchmark-owner@example.test'),
  (pg_temp.benchmark_id(2), 'benchmark-reader@example.test'),
  (pg_temp.benchmark_id(3), 'benchmark-other-owner@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.benchmark_id(11), 'benchmark-primary', 'Benchmark primary'),
  (pg_temp.benchmark_id(12), 'benchmark-other', 'Benchmark other');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.benchmark_id(21), pg_temp.benchmark_id(11), pg_temp.benchmark_id(1), 'human', 'owner'),
  (pg_temp.benchmark_id(22), pg_temp.benchmark_id(11), pg_temp.benchmark_id(2), 'human', 'member'),
  (pg_temp.benchmark_id(23), pg_temp.benchmark_id(12), pg_temp.benchmark_id(3), 'human', 'owner');
insert into public.factories(id, workspace_id, name, slug, is_default) values
  (pg_temp.benchmark_id(30), pg_temp.benchmark_id(11), 'Benchmark sibling', 'sibling', false);

create temp table benchmark_scope as
select 'primary'::text as key, workspace_id, id as factory_id,
  pg_temp.benchmark_id(1) as owner_id, 40 as pipeline_slot, 1 as session_number
from public.factories where workspace_id = pg_temp.benchmark_id(11) and is_default
union all
select 'sibling', workspace_id, id, pg_temp.benchmark_id(1), 50, 2
from public.factories where id = pg_temp.benchmark_id(30)
union all
select 'foreign', workspace_id, id, pg_temp.benchmark_id(3), 60, 1
from public.factories where workspace_id = pg_temp.benchmark_id(12) and is_default;

insert into public.pipelines(id, workspace_id, factory_id, name)
select pg_temp.benchmark_id(pipeline_slot), workspace_id, factory_id, 'Benchmark fixture pipeline'
from benchmark_scope;
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name)
select pg_temp.benchmark_id(pipeline_slot + 1), workspace_id, pg_temp.benchmark_id(pipeline_slot),
  1, 'review', 'Review' from benchmark_scope;
insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id)
select pg_temp.benchmark_id(pipeline_slot + 2), workspace_id, factory_id, session_number, 'Benchmark fixture source',
  pg_temp.benchmark_id(pipeline_slot), pg_temp.benchmark_id(pipeline_slot + 1) from benchmark_scope;
insert into public.agent_jobs(id, workspace_id, session_id, stage_id, stage_slug, trigger_type, status, attempt_count,
  started_at, finished_at)
select pg_temp.benchmark_id(45), workspace_id, pg_temp.benchmark_id(42), pg_temp.benchmark_id(41),
  'review', 'manual_run', 'success', 1, clock_timestamp() - interval '1 minute', clock_timestamp()
from benchmark_scope where key = 'primary';
insert into public.agent_runs(id, workspace_id, session_id, agent_job_id, stage_id, stage_slug, run_type, model_provider,
  model_name, status, attempt_count, started_at, finished_at)
select pg_temp.benchmark_id(pipeline_slot + target.offset_slot), workspace_id, pg_temp.benchmark_id(pipeline_slot + 2),
  case when key = 'primary' and target.offset_slot = 3 then pg_temp.benchmark_id(45) end,
  pg_temp.benchmark_id(pipeline_slot + 1), 'review', 'project', 'codex', 'gpt-5.5', 'success', 1,
  clock_timestamp() - interval '1 minute', clock_timestamp()
from benchmark_scope cross join (values (3), (4)) target(offset_slot)
where key = 'primary' or target.offset_slot = 3;

with definition as (
  select workspace_id, factory_id, owner_id,
    jsonb_build_object('schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.benchmark_id(pipeline_slot))::text as body
  from benchmark_scope where key = 'primary'
), revision as (
  insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version,
    definition_json, canonical_digest, created_by)
  select pg_temp.benchmark_id(46), workspace_id, factory_id, 1, body,
    encode(sha256(convert_to(body, 'UTF8')), 'hex'), owner_id from definition
  returning id, workspace_id, canonical_digest
)
insert into public.session_attempt_manifests(run_id, workspace_id, session_id, job_id, attempt_count, stage_id,
  definition_provenance, definition_revision_id, definition_digest, definition_skill_ids, definition_tool_ids,
  repository_id, repository_full_name, base_branch, initial_base_sha, input_sha, checkout_sha, prompt_sha256,
  prompt_utf8_bytes, renderer_version, predecessors, worker_runtime, run_type, model_provider, model_name)
select run.id, run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count, run.stage_id,
  'pinned', revision.id, revision.canonical_digest, '{}', '{}',
  pg_temp.benchmark_id(47), 'fixture/benchmark', 'main', repeat('a', 40), repeat('b', 40), repeat('b', 40),
  repeat('c', 64), 24, 3, '[]', 'node', run.run_type, run.model_provider, run.model_name
from revision join public.agent_runs run on (run.workspace_id, run.id) = (revision.workspace_id, pg_temp.benchmark_id(43));

insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name)
values (pg_temp.benchmark_id(48), pg_temp.benchmark_id(11), pg_temp.benchmark_id(40), 2, 'next', 'Next');
update public.sessions set current_stage_id = pg_temp.benchmark_id(48) where id = pg_temp.benchmark_id(42);
delete from public.pipeline_stages where id = pg_temp.benchmark_id(41);
select results_eq($$select run.stage_id, manifest.stage_id from public.agent_runs run
  join public.session_attempt_manifests manifest on manifest.run_id = run.id where run.id = pg_temp.benchmark_id(43)$$,
  $$select null::uuid, pg_temp.benchmark_id(41)$$,
  'stage deletion clears the live run stage while retaining the exact attempt manifest');

create temp table benchmark_task_keys(key text primary key, revision_id uuid not null, task_id uuid not null);
create temp table benchmark_suite_keys(key text primary key, revision_id uuid not null, suite_id uuid not null);
grant select on benchmark_scope to service_role;
grant select, insert on benchmark_task_keys, benchmark_suite_keys to service_role;
grant select on benchmark_task_keys, benchmark_suite_keys to authenticated;

create function pg_temp.create_benchmark_task(p_scope text, p_run_slot integer, p_tags text[], p_actor_id uuid default null)
returns public.factory_benchmark_task_revisions language sql as $$
  select task.* from benchmark_scope scope
  cross join lateral public.create_factory_benchmark_task(scope.workspace_id, scope.factory_id,
    coalesce(p_actor_id, scope.owner_id), pg_temp.benchmark_id(p_run_slot), 'Verify review behavior',
    'All checks pass.', p_tags) task where scope.key = p_scope
$$;

create function pg_temp.edit_benchmark_task(p_base_key text, p_tags text[])
returns public.factory_benchmark_task_revisions language sql as $$
  select task.* from benchmark_scope scope cross join benchmark_task_keys base
  cross join lateral public.save_factory_benchmark_task_revision(scope.workspace_id, scope.factory_id, scope.owner_id,
    base.task_id, base.revision_id, 'Verify review behavior', 'All checks pass and results are retained.',
    p_tags, 'ineligible', 'Source reference unavailable.') task
  where scope.key = 'primary' and base.key = p_base_key
$$;

create function pg_temp.save_benchmark_suite(p_scope text, p_base_key text, p_purpose text,
  p_revisions uuid[] default null, p_tags text[] default null)
returns public.factory_benchmark_suite_revisions language sql as $$
  select revision.* from benchmark_scope scope left join benchmark_suite_keys base on base.key = p_base_key
  cross join lateral public.save_factory_benchmark_suite_revision(scope.workspace_id, scope.factory_id, scope.owner_id,
    'Review behavior suite', p_purpose, base.suite_id, base.revision_id, p_revisions, p_tags) revision
  where scope.key = p_scope
$$;

select ok(bool_and(has_function_privilege('service_role', signature, 'EXECUTE')
    and not has_function_privilege('authenticated', signature, 'EXECUTE')
    and not has_function_privilege('anon', signature, 'EXECUTE')),
  'every benchmark mutation is callable only by the service role')
from (values
  ('public.create_factory_benchmark_task(uuid,uuid,uuid,uuid,text,text,text[],text,text)'),
  ('public.save_factory_benchmark_task_revision(uuid,uuid,uuid,uuid,uuid,text,text,text[],text,text)'),
  ('public.save_factory_benchmark_suite_revision(uuid,uuid,uuid,text,text,uuid,uuid,uuid[],text[])')
) commands(signature);
select ok(bool_and(not has_table_privilege('anon', relation, 'SELECT')
    and has_table_privilege('authenticated', relation, 'SELECT')
    and not has_table_privilege('authenticated', relation, 'INSERT, UPDATE, DELETE')
    and not has_table_privilege('service_role', relation, 'INSERT, UPDATE, DELETE')),
  'benchmark tables have factory-scoped read access and fenced writes')
from (values ('public.factory_benchmark_tasks'), ('public.factory_benchmark_task_revisions'),
  ('public.factory_benchmark_suites'), ('public.factory_benchmark_suite_revisions'),
  ('public.factory_benchmark_suite_members')) relations(relation);

set local role service_role;
select public.grant_factory_membership(workspace_id, factory_id, owner_id, pg_temp.benchmark_id(22), 'member')
from benchmark_scope where key = 'primary';

insert into benchmark_task_keys
select 'review-v1', revision.id, revision.task_id from pg_temp.create_benchmark_task('primary', 43, '{ui,triage}') revision
union all
select 'ui-only', revision.id, revision.task_id from pg_temp.create_benchmark_task('primary', 44, '{ui}') revision
union all
select 'sibling-task', revision.id, revision.task_id from pg_temp.create_benchmark_task('sibling', 53, '{ui,triage}') revision
union all
select 'foreign-task', revision.id, revision.task_id from pg_temp.create_benchmark_task('foreign', 63, '{ui,triage}') revision;

select throws_ok($$select pg_temp.create_benchmark_task('primary', 44, '{ui}', pg_temp.benchmark_id(2))$$,
  '42501', null, 'read access to a factory cannot create or revise benchmark data');
select throws_ok($$select pg_temp.create_benchmark_task('primary', 53, '{ui}')$$,
  'P0002', null, 'benchmark tasks cannot capture source runs from a sibling factory');
select throws_ok($$select pg_temp.create_benchmark_task('primary', 63, '{ui}')$$,
  'P0002', null, 'benchmark tasks cannot capture source runs from another workspace');

insert into benchmark_suite_keys
select 'tag-v1', revision.id, revision.suite_id
from pg_temp.save_benchmark_suite('primary', null, 'regression', p_tags => '{ui,triage}') revision;
insert into benchmark_suite_keys
select 'explicit', revision.id, revision.suite_id
from pg_temp.save_benchmark_suite('primary', null, 'holdout',
  array(select revision_id from benchmark_task_keys where key = 'ui-only')) revision;
insert into benchmark_suite_keys
select 'sibling-suite', revision.id, revision.suite_id
from pg_temp.save_benchmark_suite('sibling', null, 'regression', p_tags => '{ui,triage}') revision
union all
select 'foreign-suite', revision.id, revision.suite_id
from pg_temp.save_benchmark_suite('foreign', null, 'holdout', p_tags => '{ui,triage}') revision;

insert into benchmark_task_keys
select 'review-v2', revision.id, revision.task_id from pg_temp.edit_benchmark_task('review-v1', '{ui}') revision;
select throws_ok($$select pg_temp.edit_benchmark_task('review-v1', '{triage}')$$,
  'PT409', null, 'a stale task edit cannot append a revision');

insert into benchmark_suite_keys
select 'tag-v2', revision.id, revision.suite_id
from pg_temp.save_benchmark_suite('primary', 'tag-v1', 'regression', p_tags => '{ui,triage}') revision;
insert into benchmark_suite_keys
select 'explicit-history', revision.id, revision.suite_id
from pg_temp.save_benchmark_suite('primary', 'explicit', 'holdout',
  array(select revision_id from benchmark_task_keys where key = 'review-v1')) revision;
select throws_ok($$select pg_temp.save_benchmark_suite('primary', 'tag-v1', 'holdout', p_tags => '{ui}')$$,
  'PT409', null, 'a stale suite edit cannot replace current membership');
select throws_ok($$select pg_temp.save_benchmark_suite('primary', 'explicit-history', 'holdout',
  array(select revision_id from benchmark_task_keys where key = 'sibling-task'))$$,
  'PT422', null, 'an explicit suite edit rejects a task revision from a sibling factory');
select throws_ok($$select pg_temp.save_benchmark_suite('primary', 'explicit-history', 'holdout',
  array(select revision_id from benchmark_task_keys where key = 'foreign-task'))$$,
  'PT422', null, 'an explicit suite edit rejects a task revision from another workspace');
select throws_ok($$select pg_temp.save_benchmark_suite('primary', 'explicit-history', 'holdout',
  array(select revision_id from benchmark_task_keys where key in ('review-v1', 'review-v2')))$$,
  '22023', null, 'one suite revision cannot contain two versions of the same task');
select throws_ok($$select pg_temp.save_benchmark_suite('primary', 'explicit-history', 'holdout', '{}', '{ui}')$$,
  '22023', null, 'a suite revision cannot mix explicit and tag selection modes');
reset role;

select results_eq($$select task.key, task_revision.revision_number, task_revision.acceptance_criteria,
    task_revision.replay_eligibility, task_revision.eligibility_reason
  from benchmark_task_keys task join public.factory_benchmark_task_revisions task_revision
    on task.revision_id = task_revision.id where task.key in ('review-v1', 'review-v2') order by task.key$$,
  $$values ('review-v1', 1, 'All checks pass.', 'unverified', null::text),
    ('review-v2', 2, 'All checks pass and results are retained.', 'ineligible', 'Source reference unavailable.')$$,
  'each task revision retains its own criteria, replay eligibility, and reason');
select is((select count(distinct task_id) from benchmark_task_keys where key in ('review-v1', 'review-v2')),
  1::bigint, 'editing a task preserves its stable identity');
select is((select count(distinct suite_id) from benchmark_suite_keys where key in ('tag-v1', 'tag-v2')),
  1::bigint, 'editing a suite preserves its stable identity');
select results_eq($$select suite.key, revision.revision_number, revision.purpose, revision.selection_tags
  from benchmark_suite_keys suite join public.factory_benchmark_suite_revisions revision on revision.id = suite.revision_id
  where suite.key in ('explicit', 'explicit-history', 'tag-v1', 'tag-v2') order by suite.key$$,
  $$values ('explicit', 1, 'holdout', null::text[]), ('explicit-history', 2, 'holdout', null::text[]),
    ('tag-v1', 1, 'regression', array['triage', 'ui']), ('tag-v2', 2, 'regression', array['triage', 'ui'])$$,
  'suite revisions retain purpose and selection metadata');
select results_eq($$select suite.key, task.key from benchmark_suite_keys suite
  left join public.factory_benchmark_suite_members member on member.suite_revision_id = suite.revision_id
  left join benchmark_task_keys task on member.task_revision_id = task.revision_id
  where suite.key in ('explicit', 'explicit-history', 'tag-v1', 'tag-v2') order by suite.key, task.key$$,
  $$values ('explicit', 'ui-only'), ('explicit-history', 'review-v1'),
    ('tag-v1', 'review-v1'), ('tag-v2', null::text)$$,
  'tag selection freezes all-tag matches, reevaluates latest tasks for new revisions and preserves explicitly pinned history');
select is((select count(*) from public.factory_benchmark_suite_revisions
  where suite_id = (select suite_id from benchmark_suite_keys where key = 'explicit')),
  2::bigint, 'failed suite edits leave no partial revision');

select throws_ok($$update public.factory_benchmark_task_revisions set acceptance_criteria = 'Rewritten criteria'
  where id = (select revision_id from benchmark_task_keys where key = 'review-v1')$$,
  '23514', null, 'a persisted task revision cannot be rewritten');
select throws_ok($$delete from public.factory_benchmark_suite_members
  where suite_revision_id = (select revision_id from benchmark_suite_keys where key = 'tag-v1')$$,
  '23514', null, 'a persisted suite member cannot be removed');
select throws_ok($$insert into public.factory_benchmark_suite_members(workspace_id, factory_id, suite_revision_id,
  task_id, task_revision_id)
  select scope.workspace_id, scope.factory_id, suite.revision_id, task.task_id, task.revision_id
  from benchmark_scope scope cross join benchmark_suite_keys suite cross join benchmark_task_keys task
  where scope.key = 'primary' and suite.key = 'tag-v2' and task.key = 'sibling-task'$$,
  '23503', null, 'the database rejects cross-factory membership even through a direct insert');

update public.agent_runs set stage_slug = 'edited-review' where id = pg_temp.benchmark_id(43);
select results_eq($$select task.source_run_id, task.source_session_id, task.source_provenance->>'stageSlug',
    task.source_provenance->>'attempt', revision.acceptance_criteria
  from public.factory_benchmark_tasks task join public.factory_benchmark_task_revisions revision on revision.task_id = task.id
    and revision.revision_number = 1 where task.source_run_id = pg_temp.benchmark_id(43)$$,
  $$select pg_temp.benchmark_id(43), pg_temp.benchmark_id(42), 'review'::text, '1'::text, 'All checks pass.'::text$$,
  'a changed historical run cannot rewrite captured provenance or task acceptance criteria');
delete from public.sessions where id = pg_temp.benchmark_id(42);
select is((select count(*) from public.session_attempt_manifests where run_id = pg_temp.benchmark_id(43)),
  0::bigint, 'removing the original session also removes its run attempt manifest');
select results_eq($$select source_provenance->>'definitionRevisionId', source_provenance->>'definitionDigest',
    source_provenance->>'inputSha', source_provenance->>'promptSha256'
  from public.factory_benchmark_tasks where source_run_id = pg_temp.benchmark_id(43)$$,
  $$select id::text, canonical_digest, repeat('b', 40), repeat('c', 64)
    from public.factory_definition_revisions where id = pg_temp.benchmark_id(46)$$,
  'capture retains exact attempt digests through stage deletion and subsequent source removal');
select is((select count(*) from public.factory_benchmark_tasks task
  join public.factory_benchmark_suite_members member on member.task_id = task.id
  where task.source_run_id = pg_temp.benchmark_id(43)), 2::bigint,
  'removing the original run does not remove its frozen task or suite memberships');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '61100000-0000-4000-8000-000000000002';
select results_eq($$select task.key from public.factory_benchmark_task_revisions revision
  join benchmark_task_keys task on task.revision_id = revision.id order by task.key$$,
  $$values ('review-v1'), ('review-v2'), ('ui-only')$$,
  'a factory member sees only task revisions within the authorized factory');
select results_eq($$select suite.key from public.factory_benchmark_suite_revisions revision
  join benchmark_suite_keys suite on suite.revision_id = revision.id order by suite.key$$,
  $$values ('explicit'), ('explicit-history'), ('tag-v1'), ('tag-v2')$$,
  'a factory member can inspect old suite revisions, with sibling and foreign revisions concealed');
select results_eq($$select suite.key from public.factory_benchmark_suite_members member
  join benchmark_suite_keys suite on suite.revision_id = member.suite_revision_id order by suite.key$$,
  $$values ('explicit'), ('explicit-history'), ('tag-v1')$$,
  'an authenticated member sees exact frozen members only for authorized suites');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

create function pg_temp.curate_benchmark_suite(
  p_name text, p_base_key text default null, p_tags text[] default null,
  p_preview uuid[] default null, p_allow_empty boolean default false,
  p_preserve boolean default false, p_actor uuid default null,
  p_purpose text default 'holdout', p_explicit uuid[] default null
) returns public.factory_benchmark_suite_revisions language sql as $$
  select revision.* from benchmark_scope scope left join benchmark_suite_keys base on base.key = p_base_key
  cross join lateral public.curate_factory_benchmark_suite(scope.workspace_id, scope.factory_id,
    coalesce(p_actor, scope.owner_id), p_name, p_purpose, base.suite_id, base.revision_id,
    p_explicit, p_tags, p_preview, p_allow_empty, p_preserve) revision
  where scope.key = 'primary'
$$;

select ok(not has_function_privilege('authenticated',
  'public.curate_factory_benchmark_suite(uuid,uuid,uuid,text,text,uuid,uuid,uuid[],text[],uuid[],boolean,boolean)',
  'EXECUTE'), 'guarded curation remains a privileged write');

set local role service_role;
select throws_ok($$select pg_temp.curate_benchmark_suite('Empty by accident', p_tags => array['missing'], p_preview => '{}')$$,
  'PT428', null, 'a tag query cannot accidentally create an empty suite');
select throws_ok($$select pg_temp.curate_benchmark_suite('Empty explicit', p_explicit => '{}')$$,
  'PT428', null, 'an empty explicit selection also requires confirmation');
select throws_ok($$select pg_temp.curate_benchmark_suite('Stale preview', p_tags => array['ui'],
  p_preview => array(select revision_id from benchmark_task_keys where key in ('review-v1', 'ui-only')))$$,
  'PT412', null, 'a changed task revision rejects a preview even when the match count is unchanged');
select throws_ok($$select pg_temp.curate_benchmark_suite('Now matching', p_tags => array['ui'],
  p_preview => '{}', p_allow_empty => true)$$, 'PT412', null,
  'empty consent does not authorize freezing newly matching revisions');
select throws_ok($$select pg_temp.curate_benchmark_suite('Cannot edit', p_base_key => 'tag-v2',
  p_preserve => true, p_actor => pg_temp.benchmark_id(2))$$,
  '42501', null, 'a read-only factory member cannot preserve membership by creating a revision');
select throws_ok($$select pg_temp.curate_benchmark_suite('Stale rename', p_base_key => 'tag-v1', p_preserve => true)$$,
  'PT409', null, 'preserving selection still requires the exact current revision');

insert into benchmark_suite_keys
select 'tag-refresh', revision.id, revision.suite_id
from pg_temp.curate_benchmark_suite('Cannot find this past name', p_base_key => 'tag-v2', p_tags => array['UI'],
  p_preview => array(select revision_id from benchmark_task_keys where key in ('review-v2', 'ui-only')),
  p_purpose => 'regression') revision;

insert into benchmark_task_keys
select 'review-v3', revision.id, revision.task_id from pg_temp.edit_benchmark_task('review-v2', '{triage}') revision;

insert into benchmark_suite_keys
select 'tag-rename', revision.id, revision.suite_id
from pg_temp.curate_benchmark_suite('Invoice %_ checks', p_base_key => 'tag-refresh', p_preserve => true) revision;

insert into benchmark_suite_keys
select 'intentional-empty', revision.id, revision.suite_id
from pg_temp.curate_benchmark_suite('Invoice empty', p_tags => array['missing'], p_preview => '{}',
  p_allow_empty => true) revision;

do $$
begin
  for i in 1..34 loop
    perform pg_temp.curate_benchmark_suite('A duplicate', p_explicit => '{}',
      p_allow_empty => true, p_purpose => 'regression');
  end loop;
end;
$$;
reset role;

select results_eq($$select name, purpose, selection_tags from public.factory_benchmark_suite_revisions
  where id = (select revision_id from benchmark_suite_keys where key = 'tag-rename')$$,
  $$select 'Invoice %_ checks'::text, 'holdout'::text, array['ui']$$,
  'renaming and changing purpose preserves the original tag rule');
select results_eq($$select task.key from public.factory_benchmark_suite_members member
  join benchmark_task_keys task on task.revision_id = member.task_revision_id
  where member.suite_revision_id = (select revision_id from benchmark_suite_keys where key = 'tag-rename')
  order by task.key$$, $$values ('review-v2'), ('ui-only')$$,
  'a metadata edit retains exact frozen tasks after new task revisions stop matching');
select is((select count(*) from public.factory_benchmark_suite_members
  where suite_revision_id = (select revision_id from benchmark_suite_keys where key = 'intentional-empty')),
  0::bigint, 'explicit confirmation can freeze an empty tag-selected suite');

grant select on benchmark_scope to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '61100000-0000-4000-8000-000000000002';
select results_eq($$select entry.name, entry.task_count from benchmark_scope scope
  cross join lateral public.list_factory_benchmark_suites(scope.workspace_id, scope.factory_id, 'INVOICE', 'holdout') entry
  where scope.key = 'primary'$$, $$values ('Invoice %_ checks', 2::bigint), ('Invoice empty', 0::bigint)$$,
  'name and purpose filters apply before paging and show exact latest member counts');
select results_eq($$select entry.name from benchmark_scope scope
  cross join lateral public.list_factory_benchmark_suites(scope.workspace_id, scope.factory_id, '%_') entry
  where scope.key = 'primary'$$, $$values ('Invoice %_ checks')$$,
  'catalog search treats wildcard characters literally');
select is((select count(*) from benchmark_scope scope
  cross join lateral public.list_factory_benchmark_suites(scope.workspace_id, scope.factory_id, 'past name') entry
  where scope.key = 'primary'), 0::bigint, 'only the current revision is searchable');
select is((select count(*) from benchmark_scope scope
  cross join lateral public.list_factory_benchmark_suites(scope.workspace_id, scope.factory_id) entry
  where scope.key in ('sibling', 'foreign')), 0::bigint,
  'catalog RLS conceals sibling factories and other workspaces');
select is((select count(*) from benchmark_scope scope
  cross join lateral public.list_factory_benchmark_suites(scope.workspace_id, scope.factory_id, 'duplicate') entry
  where scope.key = 'primary'), 31::bigint, 'catalog returns one lookahead row');
with duplicate_page as (
  select entry.suite_id from benchmark_scope scope
  cross join lateral public.list_factory_benchmark_suites(scope.workspace_id, scope.factory_id, 'duplicate') entry
  where scope.key = 'primary' order by entry.suite_id limit 30
)
select is((select count(*) from benchmark_scope scope
  cross join lateral public.list_factory_benchmark_suites(scope.workspace_id, scope.factory_id, 'duplicate',
    p_after => (select suite_id from duplicate_page order by suite_id desc limit 1)) entry
  where scope.key = 'primary' and entry.suite_id not in (select suite_id from duplicate_page)),
  4::bigint, 'duplicate names page once each with the stable internal tie-breaker');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

delete from public.workspaces where id = pg_temp.benchmark_id(11);
select results_eq($$select workspace_id from public.factory_benchmark_tasks
    where workspace_id in (pg_temp.benchmark_id(11), pg_temp.benchmark_id(12))
  union all select workspace_id from public.factory_benchmark_task_revisions
    where workspace_id in (pg_temp.benchmark_id(11), pg_temp.benchmark_id(12))
  union all select workspace_id from public.factory_benchmark_suites
    where workspace_id in (pg_temp.benchmark_id(11), pg_temp.benchmark_id(12))
  union all select workspace_id from public.factory_benchmark_suite_revisions
    where workspace_id in (pg_temp.benchmark_id(11), pg_temp.benchmark_id(12))
  union all select workspace_id from public.factory_benchmark_suite_members
    where workspace_id in (pg_temp.benchmark_id(11), pg_temp.benchmark_id(12))$$,
  $$select pg_temp.benchmark_id(12) from generate_series(1, 5)$$,
  'workspace deletion cascades through frozen history without affecting another tenant');

select * from finish();
rollback;
