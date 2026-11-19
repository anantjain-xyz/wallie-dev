begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

insert into auth.users(id, email) values
  ('60100000-0000-4000-8000-000000000001', 'scorer-owner@example.test'),
  ('60100000-0000-4000-8000-000000000002', 'scorer-manager@example.test'),
  ('60100000-0000-4000-8000-000000000003', 'scorer-reader@example.test'),
  ('60100000-0000-4000-8000-000000000004', 'scorer-foreign-owner@example.test');
insert into public.workspaces(id, slug, name) values
  ('60100000-1000-4000-8000-000000000001', 'scorer-primary', 'Scorer primary'),
  ('60100000-1000-4000-8000-000000000002', 'scorer-foreign', 'Scorer foreign');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  ('60100000-2000-4000-8000-000000000001', '60100000-1000-4000-8000-000000000001',
    '60100000-0000-4000-8000-000000000001', 'human', 'owner'),
  ('60100000-2000-4000-8000-000000000002', '60100000-1000-4000-8000-000000000001',
    '60100000-0000-4000-8000-000000000002', 'human', 'member'),
  ('60100000-2000-4000-8000-000000000003', '60100000-1000-4000-8000-000000000001',
    '60100000-0000-4000-8000-000000000003', 'human', 'member'),
  ('60100000-2000-4000-8000-000000000004', '60100000-1000-4000-8000-000000000002',
    '60100000-0000-4000-8000-000000000004', 'human', 'owner');
insert into public.factories(id, workspace_id, name, slug, is_default) values
  ('60100000-3000-4000-8000-000000000002', '60100000-1000-4000-8000-000000000001',
    'Restricted scorer factory', 'restricted', false);

create temporary table scorer_scope as
select case when factory.is_default then 'primary' else 'restricted' end as key,
  factory.workspace_id, factory.id as factory_id, '60100000-0000-4000-8000-000000000001'::uuid as owner_id
from public.factories factory
where factory.workspace_id = '60100000-1000-4000-8000-000000000001'
  and (factory.is_default or factory.id = '60100000-3000-4000-8000-000000000002')
union all
select 'foreign', factory.workspace_id, factory.id, '60100000-0000-4000-8000-000000000004'::uuid
from public.factories factory
where factory.workspace_id = '60100000-1000-4000-8000-000000000002' and factory.is_default;

create temporary table scorer_fixture(key text primary key, revision_id uuid not null, scorer_id uuid not null);
grant select on scorer_scope to service_role;
grant select, insert on scorer_fixture to service_role;
grant select on scorer_fixture to authenticated;

create function pg_temp.scorer_definition(p_revision integer default 1) returns jsonb language sql immutable as $$
  select case p_revision when 1 then
    '{"schemaVersion":1,"rubric":"Review the validation report.","requiredEvidence":["validation_report"],
      "scoring":{"kind":"boolean","passValue":true}}'::jsonb
  else
    '{"schemaVersion":1,"rubric":"Score the submitted change and artifact.","requiredEvidence":["code_diff","artifact"],
      "scoring":{"kind":"numeric","min":0,"max":1,"direction":"higher_is_better",
        "passThreshold":0.8,"failThreshold":0.25}}'::jsonb
  end;
$$;

create function pg_temp.create_scorer(p_scope text, p_actor_id uuid default null,
  p_definition jsonb default pg_temp.scorer_definition())
returns public.factory_scorer_revisions language sql as $$
  select public.create_factory_scorer(scope.workspace_id, scope.factory_id, coalesce(p_actor_id, scope.owner_id),
    'Delivery quality', 'delivery-quality', p_definition)
  from scorer_scope scope where scope.key = p_scope;
$$;

create function pg_temp.edit_scorer(p_scope text, p_target text, p_expected integer, p_actor_id uuid,
  p_definition jsonb default pg_temp.scorer_definition(2))
returns public.factory_scorer_revisions language sql as $$
  select public.save_factory_scorer_revision(scope.workspace_id, scope.factory_id, coalesce(p_actor_id, scope.owner_id),
    scorer.scorer_id, p_expected, p_definition)
  from scorer_scope scope cross join scorer_fixture scorer
  where scope.key = p_scope and scorer.key = p_target;
$$;

select ok(bool_and(has_function_privilege('service_role', signature, 'EXECUTE')
  and not has_function_privilege('authenticated', signature, 'EXECUTE')
  and not has_function_privilege('anon', signature, 'EXECUTE')),
  'scorer mutation commands are executable only by the service role')
from (values
  ('public.create_factory_scorer(uuid,uuid,uuid,text,text,jsonb)'),
  ('public.save_factory_scorer_revision(uuid,uuid,uuid,uuid,integer,jsonb)')
) commands(signature);
select ok(not has_table_privilege('authenticated', 'public.factory_scorers', 'INSERT')
  and not has_table_privilege('authenticated', 'public.factory_scorer_revisions', 'INSERT')
  and not has_table_privilege('service_role', 'public.factory_scorer_revisions', 'UPDATE'),
  'scorer identity and revision writes are fenced by the mutation commands');

set local role service_role;
select public.grant_factory_membership(scope.workspace_id, scope.factory_id, scope.owner_id,
  '60100000-2000-4000-8000-000000000002', 'manager')
from scorer_scope scope where scope.key = 'primary';
insert into scorer_fixture
select 'original', revision.id, revision.scorer_id from pg_temp.create_scorer('primary',
  '60100000-0000-4000-8000-000000000002') revision;
insert into scorer_fixture
select 'restricted', revision.id, revision.scorer_id from pg_temp.create_scorer('restricted') revision;
insert into scorer_fixture
select 'foreign', revision.id, revision.scorer_id from pg_temp.create_scorer('foreign') revision;
insert into scorer_fixture
select 'edited', revision.id, revision.scorer_id from pg_temp.edit_scorer('primary', 'original', 1,
  '60100000-0000-4000-8000-000000000002') revision;

select throws_ok($$select pg_temp.edit_scorer('primary', 'original', 1,
  '60100000-0000-4000-8000-000000000002')$$, 'PT409', null,
  'a stale edit cannot append against an older scorer revision');
select throws_ok($$select pg_temp.edit_scorer('primary', 'original', 2,
  '60100000-0000-4000-8000-000000000003')$$, '42501', 'Factory manager access is required.',
  'a regular factory member can read but cannot edit a rubric');
select throws_ok($$select pg_temp.edit_scorer('restricted', 'restricted', 1,
  '60100000-0000-4000-8000-000000000002')$$, '42501', 'Factory manager access is required.',
  'a manager grant is limited to the factory where it was granted');
select throws_ok($$select pg_temp.create_scorer('foreign', '60100000-0000-4000-8000-000000000002')$$,
  '42501', 'Active workspace member required.', 'a factory manager cannot create scorers in a different tenant');
select throws_ok($$select pg_temp.edit_scorer('primary', 'restricted', 1, null)$$, 'P0002', null,
  'an authorized workspace owner cannot edit a sibling scorer through the wrong factory');
select throws_ok($$select pg_temp.edit_scorer('primary', 'foreign', 1, null)$$, 'P0002', null,
  'an authorized workspace owner cannot edit a foreign tenant scorer through the local factory');
select throws_ok($$select pg_temp.edit_scorer('primary', 'original', 2, null,
  pg_temp.scorer_definition(2) - 'requiredEvidence')$$, '22023', null,
  'scorer edits must declare the evidence they require');
select throws_ok($$select pg_temp.edit_scorer('primary', 'original', 2, null,
  jsonb_set(pg_temp.scorer_definition(2), '{scoring,passThreshold}', '0.25'))$$, '22023', null,
  'the numeric fail and pass thresholds cannot overlap');
select throws_ok($$select pg_temp.edit_scorer('primary', 'original', 2, null,
  jsonb_set(jsonb_set(pg_temp.scorer_definition(2), '{scoring,failThreshold}', '0.5'),
    '{scoring,passThreshold}', '0.500000000000000000001'))$$, '22023', null,
  'pass and fail thresholds must remain distinct in the runtime score scale');
select throws_ok($$select pg_temp.edit_scorer('primary', 'original', 2, null,
  jsonb_set(pg_temp.scorer_definition(2), '{scoring,passThreshold}', '1.01'))$$, '22023', null,
  'a numeric threshold must be within the declared score scale');
reset role;

select is((select count(*) from public.factory_scorer_revisions revision
  join scorer_fixture scorer on revision.scorer_id = scorer.scorer_id where scorer.key = 'original'), 2::bigint,
  'only the authorized valid edit appends a revision to the same scorer');
select results_eq($$select revision.revision_number, revision.definition
  from public.factory_scorer_revisions revision join scorer_fixture scorer on revision.id = scorer.revision_id
  where scorer.key in ('original', 'edited') order by revision.revision_number$$,
  $$values (1, pg_temp.scorer_definition()), (2, pg_temp.scorer_definition(2))$$,
  'editing the rubric preserves the complete earlier definition and stores the new scale separately');
select throws_ok($$update public.factory_scorer_revisions set definition = pg_temp.scorer_definition(2)
  where id = (select revision_id from scorer_fixture where key = 'original')$$,
  '23514', 'Scorer identities and revisions are immutable.', 'a stored rubric cannot be rewritten in place');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60100000-0000-4000-8000-000000000003';
select results_eq($$select scorer.id from public.factory_scorers scorer
  where scorer.id in (select scorer_id from scorer_fixture)$$,
  $$select scorer_id from scorer_fixture where key = 'original'$$,
  'a workspace member sees only the accessible factory scorer identity');
select results_eq($$select revision.id, revision.definition from public.factory_scorer_revisions revision
  where revision.id in (select revision_id from scorer_fixture) order by revision.revision_number$$,
  $$select revision_id, pg_temp.scorer_definition() from scorer_fixture where key = 'original'
    union all select revision_id, pg_temp.scorer_definition(2) from scorer_fixture where key = 'edited'$$,
  'authenticated RLS exposes both local revisions and conceals restricted and foreign revisions');
set local request.jwt.claim.sub = '60100000-0000-4000-8000-000000000004';
select results_eq($$select revision.id from public.factory_scorer_revisions revision
  where revision.id in (select revision_id from scorer_fixture)$$,
  $$select revision_id from scorer_fixture where key = 'foreign'$$,
  'the other tenant can read its scorer history within its own scope');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

create function pg_temp.save_scorer_candidate(p_definition jsonb)
returns public.factory_definition_drafts language sql as $$
  select public.save_factory_definition_draft(scope.workspace_id, scope.factory_id, scope.owner_id, 0,
    p_definition::text, encode(sha256(convert_to(p_definition::text, 'UTF8')), 'hex'))
  from scorer_scope scope where scope.key = 'primary';
$$;

create function pg_temp.scorer_candidate(p_revision_ids jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('schemaVersion', 2, 'kind', 'serial', 'scorerRevisionIds', p_revision_ids);
$$;

set local role service_role;
select is((pg_temp.save_scorer_candidate('{"schemaVersion":1,"kind":"serial"}')).schema_version, 1,
  'version 1 serial candidates can be stored without scorer references');
select throws_ok($$select pg_temp.save_scorer_candidate(
  '{"schemaVersion":1,"kind":"serial","scorerRevisionIds":[]}')$$, 'PT422', null,
  'a version 1 candidate cannot introduce scorer references');
select throws_ok($$select pg_temp.save_scorer_candidate('{"schemaVersion":2,"kind":"serial"}')$$,
  'PT422', null, 'a version 2 candidate must explicitly declare its scorer references');
select throws_ok($$select pg_temp.save_scorer_candidate('{"schemaVersion":3,"kind":"serial","scorerRevisionIds":[]}')$$,
  '22023', null, 'unrecognized compiled schema versions cannot be saved');
select throws_ok($$select pg_temp.save_scorer_candidate(pg_temp.scorer_candidate('["not-a-uuid"]'))$$,
  'PT422', null, 'a malformed scorer reference is rejected at the draft RPC');
select throws_ok($$select pg_temp.save_scorer_candidate(pg_temp.scorer_candidate(
  jsonb_build_array(revision_id, revision_id))) from scorer_fixture where key = 'original'$$,
  'PT422', null, 'a scorer revision may be pinned only once in a candidate');
select throws_ok($$select pg_temp.save_scorer_candidate(pg_temp.scorer_candidate(
  '["60100000-4000-4000-8000-000000000001"]'))$$, 'PT422', null,
  'an unresolved version 2 scorer reference is rejected at the draft RPC');
select throws_ok($$select pg_temp.save_scorer_candidate(pg_temp.scorer_candidate(
  jsonb_build_array(revision_id))) from scorer_fixture where key = 'restricted'$$,
  'PT422', null, 'a version 2 definition cannot borrow scorer revisions from a restricted sibling factory');
select throws_ok($$select pg_temp.save_scorer_candidate(pg_temp.scorer_candidate(
  jsonb_build_array(revision_id))) from scorer_fixture where key = 'foreign'$$,
  'PT422', null, 'a version 2 definition cannot borrow scorer revisions from another workspace');
select is((pg_temp.save_scorer_candidate(pg_temp.scorer_candidate('[]'))).schema_version, 2,
  'a version 2 definition can explicitly opt out of scorers');
reset role;

create temporary table scorer_candidate_draft as
select draft.* from scorer_fixture old_revision
cross join lateral pg_temp.save_scorer_candidate(
  pg_temp.scorer_candidate(jsonb_build_array(old_revision.revision_id))) draft
where old_revision.key = 'original';
select is((select schema_version from scorer_candidate_draft), 2,
  'a candidate using an existing historical scorer revision stores version 2');

insert into public.factory_definition_revisions(
  id, workspace_id, factory_id, source_draft_id, schema_version, definition_json, canonical_digest, created_by
)
select '60100000-5000-4000-8000-000000000001', workspace_id, factory_id, id, schema_version,
  definition_json, canonical_digest, created_by from scorer_candidate_draft;
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, '60100000-5000-4000-8000-000000000001', 1, created_by
from scorer_candidate_draft;
select is((select scorer.definition from public.factory_definition_activations activation
  join public.factory_definition_revisions definition_revision on definition_revision.id = activation.revision_id
  join public.factory_scorer_revisions scorer
    on scorer.id = (definition_revision.definition_json::jsonb->'scorerRevisionIds'->>0)::uuid
  where activation.revision_id = '60100000-5000-4000-8000-000000000001'), pg_temp.scorer_definition(),
  'the activated definition resolves to the exact historical rubric after a newer edit');

create function pg_temp.store_scorer_snapshot(p_schema_version integer, p_definition jsonb)
returns void language sql as $$
  insert into public.factory_definition_revisions(
    id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
  ) select '60100000-5000-4000-8000-000000000002', scope.workspace_id, scope.factory_id, p_schema_version,
    p_definition::text, encode(sha256(convert_to(p_definition::text, 'UTF8')), 'hex'), scope.owner_id
  from scorer_scope scope where scope.key = 'primary';
$$;

select throws_ok($$select pg_temp.store_scorer_snapshot(1, pg_temp.scorer_candidate('[]'))$$,
  'PT422', 'The stored and compiled schema versions must match.',
  'direct revision storage enforces matching schema versions');
select throws_ok($$select pg_temp.store_scorer_snapshot(2, pg_temp.scorer_candidate(
  '["60100000-4000-4000-8000-000000000001"]'))$$,
  'PT422', 'A bound scorer revision is unavailable in this factory.',
  'direct revision storage rejects an unresolved scorer reference');

-- Seed an invalid stored snapshot so the activation guard is exercised independently.
alter table public.factory_definition_revisions disable trigger factory_definition_revisions_resource_scope;
select pg_temp.store_scorer_snapshot(2, pg_temp.scorer_candidate('["60100000-4000-4000-8000-000000000001"]'));
alter table public.factory_definition_revisions enable trigger factory_definition_revisions_resource_scope;

select throws_ok($$insert into public.factory_definition_activations(
  workspace_id, factory_id, revision_id, activation_number, created_by
) select scope.workspace_id, scope.factory_id, '60100000-5000-4000-8000-000000000002', 2, scope.owner_id
  from scorer_scope scope where scope.key = 'primary'$$,
  'PT422', 'A bound scorer revision is unavailable in this factory.',
  'activation rechecks the scorer reference even for an already stored revision');
select is((select max(activation.activation_number) from public.factory_definition_activations activation
  join scorer_scope scope on (scope.workspace_id, scope.factory_id) = (activation.workspace_id, activation.factory_id)
  where scope.key = 'primary'), 1::bigint, 'a rejected activation leaves the previous activation current');

select * from finish();
rollback;
