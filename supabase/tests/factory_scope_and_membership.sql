begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local role service_role;

-- The seeded workspace predates this migration. Every existing resource must
-- have been adopted by exactly its workspace default factory.
select is(
  (select count(*) from public.pipelines pipeline
    join public.factories factory
      on factory.workspace_id = pipeline.workspace_id and factory.id = pipeline.factory_id
    where factory.is_default),
  (select count(*) from public.pipelines),
  'every seeded pipeline belongs to a default factory in its workspace'
);
select is(
  (select count(*) from public.github_repositories repository
    join public.factories factory
      on factory.workspace_id = repository.workspace_id and factory.id = repository.factory_id
    where factory.is_default),
  (select count(*) from public.github_repositories),
  'every seeded repository belongs to a default factory in its workspace'
);
select is(
  (select count(*) from public.sessions session
    join public.factories factory
      on factory.workspace_id = session.workspace_id and factory.id = session.factory_id
    where factory.is_default),
  (select count(*) from public.sessions),
  'every seeded session belongs to a default factory in its workspace'
);
select is(
  (select count(*) from public.factories factory
    where factory.is_default and (factory.name <> 'Default factory' or factory.slug <> 'default')),
  0::bigint,
  'default factories receive the stable name and slug'
);

insert into public.workspaces(id, slug, name) values
  ('55000000-0000-4000-8000-000000000001', 'factory-scope-primary', 'Factory scope primary'),
  ('55000000-0000-4000-8000-000000000002', 'factory-scope-foreign', 'Factory scope foreign');
reset role;
insert into auth.users(id, email) values
  ('b1b2c3d4-0001-4000-8000-000000000001', 'scope-owner@example.test'),
  ('b1b2c3d4-0002-4000-8000-000000000002', 'scope-member@example.test'),
  ('b1b2c3d4-0003-4000-8000-000000000003', 'scope-single@example.test'),
  ('b1b2c3d4-0004-4000-8000-000000000004', 'scope-foreign@example.test');
set local role service_role;
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  ('c1b2c3d4-1000-4000-8000-000000000001', '55000000-0000-4000-8000-000000000001',
    'b1b2c3d4-0001-4000-8000-000000000001', 'human', 'owner'),
  ('c1b2c3d4-1000-4000-8000-000000000002', '55000000-0000-4000-8000-000000000001',
    'b1b2c3d4-0002-4000-8000-000000000002', 'human', 'member'),
  ('c1b2c3d4-1000-4000-8000-000000000003', '55000000-0000-4000-8000-000000000001',
    'b1b2c3d4-0003-4000-8000-000000000003', 'human', 'member'),
  ('c1b2c3d4-1000-4000-8000-000000000004', '55000000-0000-4000-8000-000000000002',
    'b1b2c3d4-0004-4000-8000-000000000004', 'human', 'owner');
set local role service_role;

select is(
  (select count(*) from public.factories factory
    join public.factory_members member
      on member.workspace_id = factory.workspace_id and member.factory_id = factory.id
    where factory.workspace_id = '55000000-0000-4000-8000-000000000001'
      and factory.is_default and member.revoked_at is null),
  3::bigint,
  'existing workspace members inherit the default factory'
);
select is(
  (select role from public.factory_members member
    where member.member_id = (
      select id from public.workspace_members
      where workspace_id = '55000000-0000-4000-8000-000000000001'
        and user_id = 'b1b2c3d4-0001-4000-8000-000000000001'
    )),
  'manager',
  'workspace owners inherit factory manager access'
);

-- Factory lifecycle is an audited operator action. The creator becomes manager.
select lives_ok($$select public.create_factory(
  '55000000-0000-4000-8000-000000000001',
  'b1b2c3d4-0001-4000-8000-000000000001',
  'Payments', 'payments')$$,
  'a workspace manager can create a second factory');
select is(
  (select count(*) from public.factory_audit_events event
    where event.workspace_id = '55000000-0000-4000-8000-000000000001'
      and event.action = 'factory.created'),
  1::bigint,
  'factory creation records an audit event'
);
select is(
  (select member.role from public.factory_members member
    join public.factories factory on factory.id = member.factory_id and factory.workspace_id = member.workspace_id
    where factory.workspace_id = '55000000-0000-4000-8000-000000000001'
      and factory.slug = 'payments'
      and member.member_id = (
        select id from public.workspace_members
        where workspace_id = '55000000-0000-4000-8000-000000000001'
          and user_id = 'b1b2c3d4-0001-4000-8000-000000000001'
      )),
  'manager',
  'the factory creator is recorded as a manager'
);

create temp table scope_fixtures as
select factory.slug, factory.id as factory_id, factory.workspace_id
from public.factories factory
where factory.workspace_id = '55000000-0000-4000-8000-000000000001';

-- A pinned session in the payments factory proves archive and membership
-- removal never rewrite historical work. Definition tables have no write grant
-- for service credentials, so the fixture inserts them as the database owner.
reset role;
insert into public.factory_definition_revisions(
  id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
)
select '55000000-1500-4000-8000-000000000001', factory.workspace_id, factory.factory_id, 1,
  '{"label":"pinned payments"}',
  encode(sha256(convert_to('{"label":"pinned payments"}', 'UTF8')), 'hex'),
  'b1b2c3d4-0001-4000-8000-000000000001'
from scope_fixtures factory where factory.slug = 'payments';
insert into public.factory_definition_activations(
  workspace_id, factory_id, revision_id, activation_number, created_by
)
select factory.workspace_id, factory.factory_id, '55000000-1500-4000-8000-000000000001', 1,
  'b1b2c3d4-0001-4000-8000-000000000001'
from scope_fixtures factory where factory.slug = 'payments';
set local role service_role;

insert into public.pipelines(id, workspace_id, factory_id, name)
select fixture.pipeline_id, fixture_scope.workspace_id, fixture_scope.factory_id, fixture.name
from (values
  ('55000000-1000-4000-8000-000000000001'::uuid, 'default', 'Default scope pipeline'),
  ('55000000-1000-4000-8000-000000000002', 'payments', 'Payments scope pipeline')
) fixture(pipeline_id, slug, name)
join scope_fixtures fixture_scope on fixture_scope.slug = fixture.slug
where fixture.slug is not null;

insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name)
values
  ('55000000-1100-4000-8000-000000000001', '55000000-0000-4000-8000-000000000001',
    '55000000-1000-4000-8000-000000000001', 1, 'plan', 'Plan'),
  ('55000000-1100-4000-8000-000000000002', '55000000-0000-4000-8000-000000000001',
    '55000000-1000-4000-8000-000000000002', 1, 'plan', 'Plan');

insert into public.github_installations(
  id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions
) values
  ('55000000-1200-4000-8000-000000000001', '55000000-0000-4000-8000-000000000001',
    55000001, 'https://github.com/settings/installations/55000001', 55000, 'Organization',
    'scope-primary', '{"contents":"write"}'),
  ('55000000-1200-4000-8000-000000000002', '55000000-0000-4000-8000-000000000002',
    55000002, 'https://github.com/settings/installations/55000002', 55000, 'Organization',
    'scope-foreign', '{"contents":"write"}');

insert into public.github_repositories(
  id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name,
  private, html_url
)
select fixture.repository_id, fixture.workspace_id, built.factory_id, fixture.installation_id,
  fixture.repo_id, fixture.name, fixture.full_name, true, fixture.html_url
from (values
  ('55000000-1300-4000-8000-000000000001'::uuid, '55000000-0000-4000-8000-000000000001'::uuid,
    '55000000-1200-4000-8000-000000000001'::uuid, 550001, 'default', 'scope/default', 'https://github.com/scope/default'),
  ('55000000-1300-4000-8000-000000000002'::uuid, '55000000-0000-4000-8000-000000000001'::uuid,
    '55000000-1200-4000-8000-000000000001'::uuid, 550002, 'payments', 'scope/payments', 'https://github.com/scope/payments'),
  ('55000000-1300-4000-8000-000000000003'::uuid, '55000000-0000-4000-8000-000000000002'::uuid,
    '55000000-1200-4000-8000-000000000002'::uuid, 550003, 'foreign', 'scope/foreign', 'https://github.com/scope/foreign')
) fixture(repository_id, workspace_id, installation_id, repo_id, name, full_name, html_url)
join lateral (
  select factory.id as factory_id from public.factories factory
  where factory.workspace_id = fixture.workspace_id
    and factory.slug = case when fixture.name = 'payments' then 'payments' else 'default' end
) built on true;

insert into public.sessions(
  id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id,
  factory_definition_provenance, factory_definition_revision_id
)
select fixture.session_id, fixture.workspace_id, built.factory_id, fixture.number, fixture.title,
  fixture.creator_member_id, fixture.pipeline_id, fixture.current_stage_id,
  fixture.provenance, fixture.revision_id
from (values
  ('55000000-1400-4000-8000-000000000001'::uuid, '55000000-0000-4000-8000-000000000001'::uuid,
    '55000000-1000-4000-8000-000000000001'::uuid, '55000000-1100-4000-8000-000000000001'::uuid, 1,
    'Default factory session',
    'c1b2c3d4-1000-4000-8000-000000000001'::uuid, 'legacy', null::uuid),
  ('55000000-1400-4000-8000-000000000002'::uuid, '55000000-0000-4000-8000-000000000001'::uuid,
    '55000000-1000-4000-8000-000000000002'::uuid, '55000000-1100-4000-8000-000000000002'::uuid, 2,
    'Payments factory pinned session',
    'c1b2c3d4-1000-4000-8000-000000000001'::uuid, 'pinned',
    '55000000-1500-4000-8000-000000000001'::uuid)
) fixture(session_id, workspace_id, pipeline_id, current_stage_id, number, title, creator_member_id,
  provenance, revision_id)
join lateral (
  select factory.id as factory_id from public.factories factory
  where factory.workspace_id = fixture.workspace_id
    and factory.slug = case when fixture.number = 1 then 'default' else 'payments' end
) built on true
join public.workspace_members member
  on member.workspace_id = fixture.workspace_id
 and member.user_id = 'b1b2c3d4-0001-4000-8000-000000000001'
where member.id = fixture.creator_member_id;

insert into public.session_artifacts(session_id, workspace_id, stage_slug, version, artifact_json)
values
  ('55000000-1400-4000-8000-000000000001', '55000000-0000-4000-8000-000000000001', 'plan', 1,
    '{"markdown":"default"}'),
  ('55000000-1400-4000-8000-000000000002', '55000000-0000-4000-8000-000000000001', 'plan', 1,
    '{"markdown":"payments"}');

select is(
  (select factory_id from public.sessions where id = '55000000-1400-4000-8000-000000000001'),
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'default'),
  'a legacy caller omitting factory scope lands in the default factory without changing its id'
);

-- Grant the ordinary member one factory only. A workspace manager remains an
-- operator over both factories.
select lives_ok($$select public.grant_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from public.workspace_members where workspace_id = '55000000-0000-4000-8000-000000000001'
    and user_id = 'b1b2c3d4-0002-4000-8000-000000000002'),
  'member')$$,
  'a factory manager can grant membership to another workspace member');
select ok(
  (select count(*) from public.factory_audit_events
    where workspace_id = '55000000-0000-4000-8000-000000000001'
      and action = 'membership.granted'
      and subject_member_id = 'c1b2c3d4-1000-4000-8000-000000000002') >= 2,
  'membership grants are audited, including the default-factory inheritance'
);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'b1b2c3d4-0003-4000-8000-000000000003';
select results_eq($$
  select count(*) from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.sessions where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.pipelines where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.github_repositories where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.session_artifacts where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.factories where workspace_id = '55000000-0000-4000-8000-000000000002'
  $$, array[1, 1, 1, 1, 1, 0]::bigint[],
  'a single-factory member cannot enumerate sibling-factory or foreign-workspace resources');

select results_eq($$update public.sessions set title = 'Allowed rename'
  where id = '55000000-1400-4000-8000-000000000001'
  returning id$$,
  array['55000000-1400-4000-8000-000000000001']::uuid[],
  'a single-factory member can mutate a session in their own factory');
select is_empty($$update public.sessions set title = 'Restricted rename'
  where id = '55000000-1400-4000-8000-000000000002'
  returning id$$,
  'a single-factory member cannot mutate a sibling factory session');
select throws_ok($$insert into public.pipelines(workspace_id, factory_id, name)
  values ('55000000-0000-4000-8000-000000000001',
    (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
    'Denied pipeline')$$,
  '42501', null,
  'a single-factory member cannot create resources in a sibling factory');
select results_eq($$
  select count(*) from public.factory_members where workspace_id = '55000000-0000-4000-8000-000000000001'
  $$, array[3]::bigint[],
  'a member sees only membership rows in factories they can access');
reset role;

-- Workspace manager operator view across both factories in the workspace.
set local role authenticated;
set local request.jwt.claim.sub = 'b1b2c3d4-0001-4000-8000-000000000001';
select results_eq($$
  select count(*) from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.sessions where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.session_artifacts where workspace_id = '55000000-0000-4000-8000-000000000001'
  $$, array[2, 2, 2]::bigint[],
  'a workspace manager retains authorized access to both factories and all sessions');
reset role;

set local role service_role;
select is(
  (select count(*) from public.read_factory_scope(
    '55000000-0000-4000-8000-000000000001', 'b1b2c3d4-0001-4000-8000-000000000001')),
  2::bigint,
  'the operator scope read returns both factories for a workspace manager');
select is(
  (select count(*) from public.read_factory_scope(
    '55000000-0000-4000-8000-000000000001', 'b1b2c3d4-0003-4000-8000-000000000003')),
  1::bigint,
  'the scope read returns one factory for an ordinary member');

-- Membership removal takes effect immediately, including against an existing
-- session and its artifact, while the factory history remains available.
select lives_ok($$select public.revoke_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'default'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from public.workspace_members where workspace_id = '55000000-0000-4000-8000-000000000001'
    and user_id = 'b1b2c3d4-0003-4000-8000-000000000003'),
  'moved teams')$$,
  'membership removal is recorded as an audited operator action');
reset role;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'b1b2c3d4-0003-4000-8000-000000000003';
select results_eq($$
  select count(*) from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.sessions where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.session_artifacts where workspace_id = '55000000-0000-4000-8000-000000000001'
  $$, array[0, 0, 0]::bigint[],
  'a removed member immediately loses the migrated session and its evidence');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'b1b2c3d4-0001-4000-8000-000000000001';
select results_eq($$
  select count(*) from public.sessions where id = '55000000-1400-4000-8000-000000000001'
  union all select count(*) from public.session_artifacts
    where session_id = '55000000-1400-4000-8000-000000000001'
  $$, array[1, 1]::bigint[],
  'authorized managers still inspect the historical session after membership removal');
reset role;

-- Archive the pinned factory: new admission stops, historical inspection stays,
-- and an authorized operator can restore it. The last-manager guard is tested
-- on the payments factory before archiving.
set local role service_role;
select throws_ok($$select public.grant_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from public.workspace_members where workspace_id = '55000000-0000-4000-8000-000000000001'
    and user_id = 'b1b2c3d4-0001-4000-8000-000000000001'),
  'member')$$,
  '23514', null,
  'a factory cannot demote its last manager');

select throws_ok($$select public.revoke_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from public.workspace_members where workspace_id = '55000000-0000-4000-8000-000000000001'
    and user_id = 'b1b2c3d4-0001-4000-8000-000000000001'))$$,
  '23514', null,
  'a factory cannot lose its last manager');

select lives_ok($$select public.archive_factory(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  'Product sunset')$$,
  'an authorized manager can archive a factory');
select is(
  (select status from public.factories
    where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'archived',
  'the factory reports archived');
select is(
  (select count(*) from public.factory_audit_events
    where workspace_id = '55000000-0000-4000-8000-000000000001' and action = 'factory.archived'),
  1::bigint,
  'archiving records an audit event with the operator and reason');
select throws_ok($$insert into public.sessions(
  id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id
) values (
  '55000000-1400-4000-8000-000000000003', '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  3, 'Blocked admission', 'c1b2c3d4-1000-4000-8000-000000000001',
  '55000000-1000-4000-8000-000000000002', '55000000-1100-4000-8000-000000000002'
)$$, 'P0011', null, 'an archived factory rejects new session admission');
reset role;

-- The pinned historical session and its factory stay inspectable by an
-- authorized factory member while archived.
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'b1b2c3d4-0002-4000-8000-000000000002';
select results_eq($$
  select count(*) from public.factories
    where workspace_id = '55000000-0000-4000-8000-000000000001' and status = 'archived'
  union all select count(*) from public.sessions where id = '55000000-1400-4000-8000-000000000002'
  union all select count(*) from public.session_artifacts where session_id = '55000000-1400-4000-8000-000000000002'
  $$, array[1, 1, 1]::bigint[],
  'an authorized member retains historical inspection of the archived factory and pinned session');
reset role;

set local role service_role;
set local request.jwt.claim.sub = 'b1b2c3d4-0001-4000-8000-000000000001';
select lives_ok($$select public.restore_factory(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001')$$,
  'an authorized manager can restore an archived factory');
select lives_ok($$insert into public.sessions(
  id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id
) values (
  '55000000-1400-4000-8000-000000000003', '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  3, 'Restored admission', 'c1b2c3d4-1000-4000-8000-000000000001',
  '55000000-1000-4000-8000-000000000002', '55000000-1100-4000-8000-000000000002'
)$$, 'restored factories accept new admission again');
select is(
  (select count(*) from public.factory_audit_events
    where workspace_id = '55000000-0000-4000-8000-000000000001' and action = 'factory.restored'),
  1::bigint,
  'restoring records an audit event');

select * from finish();
rollback;