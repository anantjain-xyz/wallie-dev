begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

set local role service_role;
insert into public.workspaces(id, slug, name) values
  ('54000000-0000-4000-8000-000000000001', 'factory-records-primary', 'Factory records primary'),
  ('54000000-0000-4000-8000-000000000002', 'factory-records-foreign', 'Factory records foreign');
reset role;
insert into public.workspace_members(workspace_id, user_id, kind, role) values
  ('54000000-0000-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001', 'human', 'owner'),
  ('54000000-0000-4000-8000-000000000001', 'a1b2c3d4-0002-4000-8000-000000000002', 'human', 'member'),
  ('54000000-0000-4000-8000-000000000002', 'a1b2c3d4-0002-4000-8000-000000000002', 'human', 'owner');

select is(
  (select count(*) from public.workspaces w
    where (select count(*) from public.factories f where f.workspace_id = w.id and f.is_default) <> 1),
  0::bigint, 'each workspace has one default factory, including newly inserted workspaces');
select throws_ok($$insert into public.factories(workspace_id, is_default)
  values ('54000000-0000-4000-8000-000000000001', true)$$,
  '23505', null, 'a workspace cannot have two default factories');

insert into public.factories(id, workspace_id, is_default) values
  ('54000000-0001-4000-8000-000000000001', '54000000-0000-4000-8000-000000000001', false);
create temp table factory_anchors as
select case when not is_default then 'sibling'
    when workspace_id = '54000000-0000-4000-8000-000000000001' then 'primary'
    else 'foreign' end as fixture,
  id, workspace_id,
  case when workspace_id = '54000000-0000-4000-8000-000000000001'
    then 'a1b2c3d4-0001-4000-8000-000000000001'::uuid
    else 'a1b2c3d4-0002-4000-8000-000000000002'::uuid end as author
from public.factories
where workspace_id in ('54000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000002');

create function pg_temp.factory_draft(p_factory text, p_base bigint, p_id uuid, p_definition text,
  p_digest text default null)
returns uuid language sql as $$
  insert into public.factory_definition_drafts(
    id, workspace_id, factory_id, base_activation_number, schema_version, definition_json, canonical_digest, created_by
  )
  select p_id, f.workspace_id, f.id, p_base, 1, p_definition,
    coalesce(p_digest, encode(sha256(convert_to(p_definition, 'UTF8')), 'hex')), f.author
  from factory_anchors f where f.fixture = p_factory
  returning id
$$;

create function pg_temp.factory_activation(p_factory text, p_revision uuid, p_number bigint)
returns bigint language sql as $$
  insert into public.factory_definition_activations(
    workspace_id, factory_id, revision_id, activation_number, created_by
  )
  select f.workspace_id, f.id, p_revision, p_number, f.author
  from factory_anchors f where f.fixture = p_factory
  returning previous_activation_number
$$;

select is(pg_temp.factory_draft('primary', null, '54000000-0002-4000-8000-000000000001', '{"label":"Café"}'),
  '54000000-0002-4000-8000-000000000001'::uuid, 'a draft can start before the first activation');
select is(pg_temp.factory_draft('foreign', null, '54000000-0002-4000-8000-000000000002', '{"label":"Foreign draft"}'),
  '54000000-0002-4000-8000-000000000002'::uuid, 'a second tenant can create its own draft');
select throws_ok($$select pg_temp.factory_draft('primary', null,
  '54000000-0002-4000-8000-000000000003', '{"label":"wrong hash"}', repeat('0', 64))$$,
  '23514', null, 'the digest must match the exact UTF-8 bytes');
select throws_ok($$select pg_temp.factory_draft('primary', null,
  '54000000-0002-4000-8000-000000000003', '{"stages":[{"name":"one","name":"two"}]}')$$,
  '23514', null, 'duplicate keys nested in a definition are rejected');
select throws_ok($$select pg_temp.factory_draft('primary', null,
  '54000000-0002-4000-8000-000000000003', '[]')$$,
  '23514', null, 'the definition root must be an object');

insert into public.factory_definition_revisions(
  id, workspace_id, factory_id, source_draft_id, schema_version, definition_json, canonical_digest, created_by
)
select v.id, f.workspace_id, f.id, v.source_draft_id, 1, v.definition_json,
  encode(sha256(convert_to(v.definition_json, 'UTF8')), 'hex'), f.author
from (values
  ('primary', '54000000-0003-4000-8000-000000000001'::uuid, '54000000-0002-4000-8000-000000000001'::uuid,
    '{"label":"Café"}'),
  ('primary', '54000000-0003-4000-8000-000000000002', null, '{"label":"Second revision"}'),
  ('foreign', '54000000-0003-4000-8000-000000000003', '54000000-0002-4000-8000-000000000002',
    '{"label":"Foreign draft"}')
) v(factory, id, source_draft_id, definition_json)
join factory_anchors f on f.fixture = v.factory;

select throws_ok($$insert into public.factory_definition_revisions(
  workspace_id, factory_id, source_draft_id, schema_version, definition_json, canonical_digest, created_by
)
select f.workspace_id, f.id, d.id, d.schema_version, d.definition_json, d.canonical_digest, f.author
from factory_anchors f cross join public.factory_definition_drafts d
where f.fixture = 'sibling' and d.id = '54000000-0002-4000-8000-000000000001'$$,
  '23503', null, 'a revision cannot claim a draft from another factory in the same workspace');

select throws_ok($$select pg_temp.factory_activation('primary', '54000000-0003-4000-8000-000000000003', 1)$$,
  '23503', null, 'an activation cannot select a revision from another workspace');
select throws_ok($$select pg_temp.factory_activation('sibling', '54000000-0003-4000-8000-000000000001', 1)$$,
  '23503', null, 'an activation cannot select a revision from a sibling factory');
select throws_ok($$select pg_temp.factory_activation('primary', '54000000-0003-4000-8000-000000000001', 2)$$,
  '23503', null, 'a factory cannot skip its first activation');
select is(pg_temp.factory_activation('primary', '54000000-0003-4000-8000-000000000001', 1),
  null::bigint, 'the first activation has no predecessor');
select is(pg_temp.factory_activation('primary', '54000000-0003-4000-8000-000000000002', 2),
  1::bigint, 'a new activation names the previous activation number');
select is(pg_temp.factory_activation('primary', '54000000-0003-4000-8000-000000000001', 3),
  2::bigint, 'activating a prior revision gets a new activation identity');
select throws_ok($$select pg_temp.factory_activation('primary', '54000000-0003-4000-8000-000000000002', 2)$$,
  '23505', null, 'an activation based on the old head conflicts even after rolling back to the same revision');
select throws_ok($$select pg_temp.factory_activation('primary', '54000000-0003-4000-8000-000000000002', 5)$$,
  '23503', null, 'an activation cannot name an expected base that has not existed');
select throws_ok($$select pg_temp.factory_draft('sibling', 1,
  '54000000-0002-4000-8000-000000000003', '{"label":"wrong base"}')$$,
  '23503', null, 'a draft base must belong to its own factory');
select is(pg_temp.factory_draft('primary', 2, '54000000-0002-4000-8000-000000000003', '{"label":"Review candidate"}'),
  '54000000-0002-4000-8000-000000000003'::uuid, 'a draft can retain its historical base across activation');
select is(pg_temp.factory_activation('foreign', '54000000-0003-4000-8000-000000000003', 1),
  null::bigint, 'activation numbers are independent across factories');

select throws_ok($$update public.factory_definition_revisions set
  definition_json = '{}', canonical_digest = encode(sha256(convert_to('{}', 'UTF8')), 'hex')
where id = '54000000-0003-4000-8000-000000000001'$$,
  '23514', null, 'published content cannot be changed even with a matching new digest');
select throws_ok($$delete from public.factory_definition_revisions
where id = '54000000-0003-4000-8000-000000000001'$$,
  '23514', null, 'an ordinary delete cannot erase a published revision');
select throws_ok($$update public.factory_definition_drafts set base_activation_number = 3
where id = '54000000-0002-4000-8000-000000000003'$$,
  '23514', null, 'saving a draft cannot rewrite an existing draft identity');
select throws_ok($$delete from public.factory_definition_drafts
where id = '54000000-0002-4000-8000-000000000003'$$,
  '23514', null, 'an unreferenced draft is still an immutable record');
select throws_ok($$update public.factory_definition_activations
set revision_id = '54000000-0003-4000-8000-000000000002'
where workspace_id = '54000000-0000-4000-8000-000000000001' and activation_number = 3$$,
  '23514', null, 'the latest activation cannot be rewritten');
select throws_ok($$delete from public.factory_definition_activations
where workspace_id = '54000000-0000-4000-8000-000000000001' and activation_number = 3$$,
  '23514', null, 'the latest activation cannot be erased to reuse its base number');

insert into public.pipelines(id, workspace_id, name) values
  ('54000000-0004-4000-8000-000000000001', '54000000-0000-4000-8000-000000000001', 'Factory fixture pipeline');
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name) values
  ('54000000-0005-4000-8000-000000000001', '54000000-0000-4000-8000-000000000001',
    '54000000-0004-4000-8000-000000000001', 1, 'draft-review', 'Draft review');
insert into public.sessions(id, workspace_id, pipeline_id, current_stage_id, number, title) values
  ('54000000-0006-4000-8000-000000000001', '54000000-0000-4000-8000-000000000001',
    '54000000-0004-4000-8000-000000000001', '54000000-0005-4000-8000-000000000001', 1, 'Interim session');
select is(
  (select factory_definition_provenance from public.sessions where id = '54000000-0006-4000-8000-000000000001'),
  'legacy', 'unversioned session creation records explicit legacy provenance');
select is(
  (select factory_definition_revision_id from public.sessions where id = '54000000-0006-4000-8000-000000000001'),
  null::uuid, 'unversioned session creation does not infer a revision from the active factory');

create function pg_temp.factory_session(p_number integer, p_provenance text, p_revision uuid)
returns uuid language sql as $$
  insert into public.sessions(workspace_id, pipeline_id, current_stage_id, number, title,
    factory_definition_provenance, factory_definition_revision_id)
  values ('54000000-0000-4000-8000-000000000001', '54000000-0004-4000-8000-000000000001',
    '54000000-0005-4000-8000-000000000001', p_number, 'Session with explicit provenance', p_provenance, p_revision)
  returning id
$$;

select throws_ok($$select pg_temp.factory_session(2, 'pinned', null)$$,
  '23514', null, 'pinned provenance requires a revision identity');
select throws_ok($$select pg_temp.factory_session(2, 'legacy', '54000000-0003-4000-8000-000000000001')$$,
  '23514', null, 'legacy provenance cannot claim a known definition');
select throws_ok($$select pg_temp.factory_session(2, 'pinned', '54000000-0003-4000-8000-000000000003')$$,
  '23503', null, 'a session pin cannot point to a different workspace');
select lives_ok($$select pg_temp.factory_session(2, 'pinned', '54000000-0003-4000-8000-000000000001')$$,
  'a new session can persist a revision identity in its own workspace');
select throws_ok($$update public.sessions set factory_definition_provenance = 'pinned',
  factory_definition_revision_id = '54000000-0003-4000-8000-000000000001'
where id = '54000000-0006-4000-8000-000000000001'$$,
  '23514', null, 'existing legacy sessions cannot be relabelled as pinned');
select throws_ok($$update public.sessions set factory_definition_revision_id = '54000000-0003-4000-8000-000000000002'
where workspace_id = '54000000-0000-4000-8000-000000000001' and number = 2$$,
  '23514', null, 'an existing session pin cannot be pointed to another revision');
select lives_ok($$update public.sessions set title = 'Renamed pinned session'
where workspace_id = '54000000-0000-4000-8000-000000000001' and number = 2$$,
  'normal session updates remain available with a pin');

with tables(table_name) as (
  values ('public.factories'), ('public.factory_definition_drafts'), ('public.factory_definition_revisions'),
    ('public.factory_definition_activations')
)
select ok(bool_and(
    not has_table_privilege('anon', table_name, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
    and not has_table_privilege('authenticated', table_name, 'INSERT, UPDATE, DELETE, TRUNCATE')
    and not has_table_privilege('service_role', table_name, 'INSERT, UPDATE, DELETE, TRUNCATE')
  ), 'anonymous users have no access and clients and service credentials have no direct write grants')
from tables;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'a1b2c3d4-0001-4000-8000-000000000001';
select results_eq($$
  select count(*) from public.factories
    where workspace_id in ('54000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000002')
  union all select count(*) from public.factory_definition_drafts
    where workspace_id in ('54000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000002')
  union all select count(*) from public.factory_definition_revisions
    where workspace_id in ('54000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000002')
  union all select count(*) from public.factory_definition_activations
    where workspace_id in ('54000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000002')
  $$, array[2, 2, 2, 3]::bigint[], 'an owner sees only their own factories, drafts, revisions and activations');

set local request.jwt.claim.sub = 'a1b2c3d4-0002-4000-8000-000000000002';
select results_eq($$
  select count(*) from public.factories where workspace_id = '54000000-0000-4000-8000-000000000001'
  union all select count(*) from public.factory_definition_drafts
    where workspace_id = '54000000-0000-4000-8000-000000000001'
  union all select count(*) from public.factory_definition_revisions
    where workspace_id = '54000000-0000-4000-8000-000000000001'
  union all select count(*) from public.factory_definition_activations
    where workspace_id = '54000000-0000-4000-8000-000000000001'
  $$, array[2, 0, 2, 3]::bigint[], 'members see activated and published records, while drafts require a manager');
reset role;

update public.workspaces set deletion_requested_at = clock_timestamp()
where id = '54000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub = 'a1b2c3d4-0001-4000-8000-000000000001';
select results_eq($$
  select count(*) from public.factories where workspace_id = '54000000-0000-4000-8000-000000000001'
  union all select count(*) from public.factory_definition_drafts
    where workspace_id = '54000000-0000-4000-8000-000000000001'
  union all select count(*) from public.factory_definition_revisions
    where workspace_id = '54000000-0000-4000-8000-000000000001'
  union all select count(*) from public.factory_definition_activations
    where workspace_id = '54000000-0000-4000-8000-000000000001'
  $$, array[0, 0, 0, 0]::bigint[], 'workspace deletion fences member access immediately');
reset role;

select lives_ok($$delete from public.workspaces where id = '54000000-0000-4000-8000-000000000001'$$,
  'workspace deletion cascades through immutable draft, revision and activation links');
select results_eq($$
  select count(*) from public.factories where workspace_id = '54000000-0000-4000-8000-000000000001'
  union all select count(*) from public.factory_definition_drafts
    where workspace_id = '54000000-0000-4000-8000-000000000001'
  union all select count(*) from public.factory_definition_revisions
    where workspace_id = '54000000-0000-4000-8000-000000000001'
  union all select count(*) from public.factory_definition_activations
    where workspace_id = '54000000-0000-4000-8000-000000000001'
  $$, array[0, 0, 0, 0]::bigint[], 'no factory records remain in a deleted workspace');
select is((select count(*) from public.factory_definition_activations
  where workspace_id = '54000000-0000-4000-8000-000000000002'), 1::bigint, 'workspace cleanup preserves other tenants');

select * from finish();
rollback;
