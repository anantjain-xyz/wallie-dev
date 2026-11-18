begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '55500000-0000-4000-8000-000000000001';

create function pg_temp.fixture_id(category integer, slot integer default 1) returns uuid
language sql immutable as $$
  select ('55500000-' || lpad(category::text, 4, '0') || '-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values
  (pg_temp.fixture_id(0, 1), 'factory-grant-owner@example.test'),
  (pg_temp.fixture_id(0, 2), 'factory-grant-payer@example.test'),
  (pg_temp.fixture_id(0, 3), 'factory-grant-manager@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.fixture_id(1), 'execution-grants-fixture', 'Execution grants'),
  (pg_temp.fixture_id(1, 2), 'foreign-budget-fixture', 'Foreign budget');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.fixture_id(2, 1), pg_temp.fixture_id(1), pg_temp.fixture_id(0, 1), 'human', 'owner'),
  (pg_temp.fixture_id(2, 2), pg_temp.fixture_id(1), pg_temp.fixture_id(0, 2), 'human', 'member'),
  (pg_temp.fixture_id(2, 3), pg_temp.fixture_id(1), pg_temp.fixture_id(0, 3), 'human', 'member'),
  (pg_temp.fixture_id(2, 4), pg_temp.fixture_id(1, 2), pg_temp.fixture_id(0, 1), 'human', 'owner');

create function pg_temp.fixture_factory() returns uuid language sql stable as $$
  select id from public.factories where workspace_id = pg_temp.fixture_id(1) and is_default
$$;

insert into public.factories(id, workspace_id, name, slug, is_default) values
  (pg_temp.fixture_id(3, 2), pg_temp.fixture_id(1), 'Sibling', 'sibling', false);
select public.grant_factory_membership(pg_temp.fixture_id(1), pg_temp.fixture_factory(),
  pg_temp.fixture_id(0, 1), pg_temp.fixture_id(2, 3), 'manager');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id,
  target_type, target_name, permissions) values
  (pg_temp.fixture_id(4), pg_temp.fixture_id(1), 55500001, 'https://github.test/installations/55500001', 55500,
    'Organization', 'fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
select pg_temp.fixture_id(5, slot), pg_temp.fixture_id(1),
  case when slot = 3 then pg_temp.fixture_id(3, 2) else pg_temp.fixture_factory() end,
  pg_temp.fixture_id(4), 55500 + slot, name, 'fixture/' || name, true, 'https://github.test/fixture/' || name, 'main'
from (values (1, 'writer'), (2, 'context'), (3, 'sibling'), (4, 'unbound')) as repository(slot, name);
select public.save_execution_policy(workspace_id, pg_temp.fixture_id(0), 0,
  '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":30000,"maxTotalTokens":1000,"maxCostUsd":1}')
from (values (pg_temp.fixture_id(1)), (pg_temp.fixture_id(1, 2))) as workspace(workspace_id);

select throws_ok($sql$select public.create_service_principal(pg_temp.fixture_id(1), pg_temp.fixture_factory(),
  pg_temp.fixture_id(0, 2), 'Unauthorized', 'unauthorized')$sql$,
  '42501', 'Factory manager access is required.', 'an ordinary workspace member cannot create a principal');
select throws_ok($sql$select public.create_service_principal(pg_temp.fixture_id(1), pg_temp.fixture_id(3, 2),
  pg_temp.fixture_id(0, 3), 'Sibling', 'sibling')$sql$,
  '42501', 'Factory manager access is required.', 'delegation is scoped to its own factory');
select is((public.create_service_principal(pg_temp.fixture_id(1), pg_temp.fixture_factory(),
  pg_temp.fixture_id(0, 3), ' Release runner ', ' release-runner ')).created_by_member_id,
  pg_temp.fixture_id(2, 3), 'the named service principal records the approving human operator');
select throws_ok($sql$select public.create_service_principal(pg_temp.fixture_id(1), pg_temp.fixture_factory(),
  pg_temp.fixture_id(0, 1), 'Duplicate', 'release-runner')$sql$,
  'PT409', 'A service principal already uses this slug in the factory.', 'principal slugs are unique in the factory');
select is((select count(*) from public.workspace_members where workspace_id = pg_temp.fixture_id(1)),
  3::bigint, 'creating a principal does not create a workspace or human actor');

create function pg_temp.fixture_principal() returns uuid language sql stable as $$
  select id from public.service_principals where workspace_id = pg_temp.fixture_id(1) and slug = 'release-runner'
$$;
create function pg_temp.fixture_policy(workspace_slot integer default 1) returns uuid language sql stable as $$
  select current_revision_id from public.execution_policies where workspace_id = pg_temp.fixture_id(1, workspace_slot)
$$;
create function pg_temp.approve_fixture_grant(
  p_grant_id uuid default null, p_version bigint default 0,
  p_writer uuid default pg_temp.fixture_id(5, 1),
  p_context uuid[] default array[pg_temp.fixture_id(5, 2)],
  p_tools text[] default array['files@1'],
  p_budget uuid default pg_temp.fixture_policy(),
  p_payer uuid default pg_temp.fixture_id(2, 2),
  p_expiry timestamptz default clock_timestamp() + interval '1 hour',
  p_actor uuid default pg_temp.fixture_id(0, 3)
) returns public.factory_execution_grants language sql as $$
  select public.approve_factory_execution_grant(pg_temp.fixture_id(1), pg_temp.fixture_factory(),
    p_actor, pg_temp.fixture_principal(), p_writer, p_context, p_tools, p_budget, p_payer, p_expiry,
    p_version, p_grant_id)
$$;

select throws_ok($sql$select pg_temp.approve_fixture_grant(p_actor => pg_temp.fixture_id(0, 2))$sql$,
  '42501', 'Factory manager access is required.', 'knowing the grant subjects does not authorize approval');
select throws_ok($sql$select pg_temp.approve_fixture_grant(p_writer => pg_temp.fixture_id(5, 3))$sql$,
  '22023', 'Execution grant scope must name live repositories, explicit tools, a workspace budget and an active payer.',
  'approval cannot give write scope to a sibling repository');
select throws_ok($sql$select pg_temp.approve_fixture_grant(p_context => array[pg_temp.fixture_id(5, 3)])$sql$,
  '22023', 'Execution grant scope must name live repositories, explicit tools, a workspace budget and an active payer.',
  'approval cannot give read scope to a sibling repository');
select throws_ok($sql$select pg_temp.approve_fixture_grant(p_context => array[pg_temp.fixture_id(5, 1)])$sql$,
  '22023', 'Execution grant scope must name live repositories, explicit tools, a workspace budget and an active payer.',
  'a writable repository cannot also be read context');
select throws_ok($sql$select pg_temp.approve_fixture_grant(p_tools => array['*'])$sql$,
  '22023', 'Execution grant scope must name live repositories, explicit tools, a workspace budget and an active payer.',
  'approval never gives wildcard tool access');
select throws_ok($sql$select pg_temp.approve_fixture_grant(p_budget => pg_temp.fixture_policy(2))$sql$,
  '22023', 'Execution grant scope must name live repositories, explicit tools, a workspace budget and an active payer.',
  'approval cannot use a foreign budget');
select throws_ok($sql$select pg_temp.approve_fixture_grant(p_payer => pg_temp.fixture_id(2, 4))$sql$,
  '22023', 'Execution grant scope must name live repositories, explicit tools, a workspace budget and an active payer.',
  'approval cannot attribute the budget to a foreign payer');
select throws_ok($sql$select pg_temp.approve_fixture_grant(p_expiry => 'infinity')$sql$,
  '22023', 'Execution grant expiry must be a finite future time.', 'grants require an explicit finite expiry');

create temp table approved_grant as select * from pg_temp.approve_fixture_grant();
select is((select version from approved_grant), 1::bigint, 'approval creates version one');
select ok((select approved_by_member_id = pg_temp.fixture_id(2, 3)
    and budget_payer_member_id = pg_temp.fixture_id(2, 2)
    and service_principal_id = pg_temp.fixture_principal() from approved_grant),
  'the principal, human payer, and approving manager remain distinct identities');

create function pg_temp.require_fixture_grant(
  p_version bigint default 1,
  p_writer uuid default pg_temp.fixture_id(5, 1),
  p_context uuid[] default array[pg_temp.fixture_id(5, 2)],
  p_tools text[] default array['files@1'],
  p_budget uuid default pg_temp.fixture_policy()
) returns public.factory_execution_grants language sql as $$
  select internal.require_current_factory_execution_grant(pg_temp.fixture_id(1), pg_temp.fixture_factory(),
    (select id from approved_grant), p_version, p_writer, p_context, p_tools, p_budget)
$$;
select is((pg_temp.require_fixture_grant()).id, (select id from approved_grant), 'the exact approved scope is usable');
select is((pg_temp.require_fixture_grant(p_context => '{}', p_tools => '{}')).id, (select id from approved_grant),
  'execution can use fewer approved resources');
select throws_ok($sql$select pg_temp.require_fixture_grant(p_writer => pg_temp.fixture_id(5, 2))$sql$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.', 'read context cannot become a source writer');
select throws_ok($sql$select pg_temp.require_fixture_grant(p_context => array[pg_temp.fixture_id(5, 4)])$sql$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.', 'unapproved read context is denied');
select throws_ok($sql$select pg_temp.require_fixture_grant(p_tools => array['files@2'])$sql$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.', 'an unapproved tool revision is denied');
select throws_ok($sql$select pg_temp.require_fixture_grant(p_budget => null)$sql$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.', 'execution requires the exact pinned budget policy');

update public.github_installations set suspended = true where id = pg_temp.fixture_id(4);
select throws_ok($sql$select pg_temp.require_fixture_grant()$sql$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.', 'execution checks live repository installation authority');
update public.github_installations set suspended = false where id = pg_temp.fixture_id(4);
update public.workspace_members set is_active = false where id = pg_temp.fixture_id(2, 2);
select throws_ok($sql$select pg_temp.require_fixture_grant()$sql$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.', 'execution rechecks the live payer identity');
update public.workspace_members set is_active = true where id = pg_temp.fixture_id(2, 2);

select is((pg_temp.approve_fixture_grant((select id from approved_grant), 1, p_tools => '{}')).version,
  2::bigint, 'an update advances the version exactly once');
select throws_ok($sql$select pg_temp.require_fixture_grant()$sql$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.', 'an old definition cannot reuse superseded authority');
select throws_ok($sql$select pg_temp.approve_fixture_grant((select id from approved_grant), 1)$sql$,
  'PT409', 'Execution grant changed. Reload before saving.', 'a stale update cannot restore removed tools');
select throws_ok($sql$select pg_temp.require_fixture_grant(2)$sql$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.', 'the current revision no longer authorizes the removed tool');
select is((pg_temp.require_fixture_grant(2, p_tools => '{}')).version, 2::bigint, 'the reduced current scope is usable');

savepoint simulate_expiry;
update public.factory_execution_grants set approved_at = clock_timestamp() - interval '2 hours',
  expires_at = clock_timestamp() - interval '1 hour' where id = (select id from approved_grant);
select throws_ok($sql$select pg_temp.require_fixture_grant(2, p_tools => '{}')$sql$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.', 'the database clock denies expired grants');
rollback to savepoint simulate_expiry;

select throws_ok($sql$select public.revoke_factory_execution_grant(pg_temp.fixture_id(1), pg_temp.fixture_factory(),
  pg_temp.fixture_id(0, 1), (select id from approved_grant), 1)$sql$,
  'PT409', 'Execution grant changed. Reload before revoking.', 'revoke also requires the current version');
select is((public.revoke_factory_execution_grant(pg_temp.fixture_id(1), pg_temp.fixture_factory(),
  pg_temp.fixture_id(0, 1), (select id from approved_grant), 2, 'Owner decision')).version, 3::bigint,
  'revocation is a new audited version');
select throws_ok($sql$select pg_temp.require_fixture_grant(3, p_tools => '{}')$sql$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.', 'no version of a revoked grant can execute');
select throws_ok($sql$select pg_temp.approve_fixture_grant((select id from approved_grant), 3)$sql$,
  'PT409', 'A revoked execution grant cannot be changed.', 'even a current version cannot restore a revoked grant');
select results_eq($sql$select action, actor_member_id, (detail->>'version')::integer from public.factory_audit_events
  where workspace_id = pg_temp.fixture_id(1) and detail->>'id' = (select id::text from approved_grant) order by id$sql$,
  $sql$values ('execution_grant.approved', pg_temp.fixture_id(2, 3), 1),
    ('execution_grant.updated', pg_temp.fixture_id(2, 3), 2), ('execution_grant.revoked', pg_temp.fixture_id(2, 1), 3)$sql$,
  'every winning decision has an append-only audit snapshot and the acting human');

select ok(not has_table_privilege('service_role', 'public.factory_execution_grants', 'UPDATE'),
  'service role cannot change the grant outside the audited decision functions');
select ok(not has_function_privilege('authenticated', 'public.revoke_factory_execution_grant(uuid, uuid, uuid, uuid, bigint, text)', 'EXECUTE'),
  'authenticated clients cannot spoof a human actor in a privileged function');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '55500000-0000-4000-8000-000000000002';
select is((select count(*) from public.factory_execution_grants where workspace_id = '55500000-0001-4000-8000-000000000001'),
  0::bigint, 'an ordinary member cannot read grant authority');
set local request.jwt.claim.sub = '55500000-0000-4000-8000-000000000003';
select is((select count(*) from public.factory_execution_grants where workspace_id = '55500000-0001-4000-8000-000000000001'),
  1::bigint, 'a delegated manager can inspect their own factory grant');
reset role;

select * from finish();
rollback;
