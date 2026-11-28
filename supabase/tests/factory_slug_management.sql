begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

insert into auth.users(id, email) values
  ('55b00000-0000-4000-8000-000000000001', 'slug-owner@example.test'),
  ('55b00000-0000-4000-8000-000000000002', 'slug-member@example.test');
insert into public.workspaces(id, name, slug) values
  ('55b00000-0001-4000-8000-000000000001', 'Slug workspace', 'slug-workspace-fixture'),
  ('55b00000-0001-4000-8000-000000000002', 'Other workspace', 'other-slug-workspace-fixture');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  ('55b00000-0002-4000-8000-000000000001', '55b00000-0001-4000-8000-000000000001',
    '55b00000-0000-4000-8000-000000000001', 'human', 'owner'),
  ('55b00000-0002-4000-8000-000000000002', '55b00000-0001-4000-8000-000000000001',
    '55b00000-0000-4000-8000-000000000002', 'human', 'member'),
  ('55b00000-0002-4000-8000-000000000003', '55b00000-0001-4000-8000-000000000002',
    '55b00000-0000-4000-8000-000000000001', 'human', 'owner');

select public.create_factory('55b00000-0001-4000-8000-000000000001',
  '55b00000-0000-4000-8000-000000000001', 'Payments', 'payments');

create temp table slug_fixture as
select slug, id, workspace_id from public.factories
where workspace_id = '55b00000-0001-4000-8000-000000000001';

select ok(not has_function_privilege('authenticated', 'public.set_factory_slug(uuid, uuid, uuid, text, text)', 'EXECUTE'),
  'a browser cannot call the privileged slug command directly');
select ok(not has_table_privilege('authenticated', 'internal.factory_slug_reservations', 'SELECT'),
  'slug reservations are not exposed as a lookup');

select results_eq($sql$
  select id, name, slug, is_default from public.rename_factory(
    '55b00000-0001-4000-8000-000000000001', (select id from slug_fixture where slug = 'default'),
    '55b00000-0000-4000-8000-000000000001', 'Default factory', 'Studio'
  )
$sql$, $sql$
  select id, 'Studio'::text, slug, true from slug_fixture where slug = 'default'
$sql$, 'renaming the default preserves its ID, slug, and default status');

select results_eq($sql$
  select id, name, slug, is_default from public.set_factory_slug(
    '55b00000-0001-4000-8000-000000000001', (select id from slug_fixture where slug = 'default'),
    '55b00000-0000-4000-8000-000000000001', 'default', ' studio '
  )
$sql$, $sql$
  select id, 'Studio'::text, 'studio'::text, true from slug_fixture where slug = 'default'
$sql$, 'changing the default slug changes neither its display name nor its identity');

select throws_ok($sql$
  select public.create_factory('55b00000-0001-4000-8000-000000000001',
    '55b00000-0000-4000-8000-000000000001', 'Impostor default', 'default')
$sql$, '23505', 'Factory slug is reserved in this workspace.', 'creation cannot take the old default slug');
select throws_ok($sql$
  select public.set_factory_slug(
    '55b00000-0001-4000-8000-000000000001', (select id from slug_fixture where slug = 'payments'),
    '55b00000-0000-4000-8000-000000000001', 'payments', 'default'
  )
$sql$, '23505', 'Factory slug is reserved in this workspace.', 'edits cannot take another factory''s previous slug');
select throws_ok($sql$
  select public.set_factory_slug(
    '55b00000-0001-4000-8000-000000000001', (select id from slug_fixture where slug = 'payments'),
    '55b00000-0000-4000-8000-000000000002', 'payments', 'other'
  )
$sql$, '42501', 'Factory manager access is required.', 'an ordinary workspace member cannot change a factory slug');
select throws_ok($sql$
  select public.set_factory_slug(
    '55b00000-0001-4000-8000-000000000002', (select id from slug_fixture where slug = 'payments'),
    '55b00000-0000-4000-8000-000000000001', 'payments', 'other'
  )
$sql$, 'P0002', 'Factory is unavailable.', 'even an owner of both workspaces cannot cross the tenant key');

select public.grant_factory_membership('55b00000-0001-4000-8000-000000000001',
  (select id from slug_fixture where slug = 'payments'), '55b00000-0000-4000-8000-000000000001',
  '55b00000-0002-4000-8000-000000000002', 'manager');
select is((select slug from public.set_factory_slug(
  '55b00000-0001-4000-8000-000000000001', (select id from slug_fixture where slug = 'payments'),
  '55b00000-0000-4000-8000-000000000002', 'payments', 'payments-lab'
)), 'payments-lab', 'a delegated manager can change their factory slug');
select results_eq($sql$
  select factory_id, role, slug from public.read_factory_scope(
    '55b00000-0001-4000-8000-000000000001', '55b00000-0000-4000-8000-000000000002'
  ) where not is_default
$sql$, $sql$
  select id, 'manager'::text, 'payments-lab'::text from slug_fixture where slug = 'payments'
$sql$, 'the same grant is still scoped to the same factory ID');
select throws_ok($sql$
  select public.set_factory_slug(
    '55b00000-0001-4000-8000-000000000001', (select id from slug_fixture where slug = 'payments'),
    '55b00000-0000-4000-8000-000000000002', 'payments', 'stale'
  )
$sql$, 'PT409', 'The factory slug changed.', 'stale edits do not overwrite the current slug');
select is(
  (select detail from public.factory_audit_events
   where factory_id = (select id from slug_fixture where slug = 'payments') and action = 'factory.slug_changed'),
  '{"previousSlug":"payments","slug":"payments-lab"}'::jsonb,
  'successful edits record the old and new slug');
select is((select slug from public.create_factory(
  '55b00000-0001-4000-8000-000000000002', '55b00000-0000-4000-8000-000000000001', 'Other payments', 'payments'
)), 'payments', 'another workspace can use the same text');

select is((select slug from public.set_factory_slug(
  '55b00000-0001-4000-8000-000000000001', (select id from slug_fixture where slug = 'payments'),
  '55b00000-0000-4000-8000-000000000002', 'payments-lab', 'payments'
)), 'payments', 'a factory can reclaim one of its own former slugs');
select public.archive_additional_factory('55b00000-0001-4000-8000-000000000001',
  (select id from slug_fixture where slug = 'payments'), '55b00000-0000-4000-8000-000000000001');
select throws_ok($sql$
  select public.set_factory_slug(
    '55b00000-0001-4000-8000-000000000001', (select id from slug_fixture where slug = 'payments'),
    '55b00000-0000-4000-8000-000000000001', 'payments', 'archived'
  )
$sql$, 'P0011', 'Factory is archived.', 'no slug updates are admitted while archived');

select * from finish();
rollback;
