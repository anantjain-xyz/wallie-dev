begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(39);
set local request.jwt.claim.role = 'service_role';

create function pg_temp.connector_actor_id(slot integer) returns uuid
language sql immutable as $$
  select ('67000000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values
  (pg_temp.connector_actor_id(1), 'connector-identity-owner@example.test'),
  (pg_temp.connector_actor_id(2), 'connector-identity-human@example.test'),
  (pg_temp.connector_actor_id(3), 'connector-identity-competitor@example.test'),
  (pg_temp.connector_actor_id(4), 'connector-identity-other-tenant@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.connector_actor_id(11), 'connector-identity-main', 'Connector identities'),
  (pg_temp.connector_actor_id(12), 'connector-identity-other', 'Other connector tenant');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.connector_actor_id(21), pg_temp.connector_actor_id(11), pg_temp.connector_actor_id(1), 'human', 'owner'),
  (pg_temp.connector_actor_id(22), pg_temp.connector_actor_id(11), pg_temp.connector_actor_id(2), 'human', 'member'),
  (pg_temp.connector_actor_id(23), pg_temp.connector_actor_id(11), pg_temp.connector_actor_id(3), 'human', 'member'),
  (pg_temp.connector_actor_id(24), pg_temp.connector_actor_id(12), pg_temp.connector_actor_id(4), 'human', 'owner');
select public.create_factory(pg_temp.connector_actor_id(11), pg_temp.connector_actor_id(1), 'Sibling', 'sibling');

insert into public.workspace_secrets(id, workspace_id, key, encrypted_value) values
  (pg_temp.connector_actor_id(31), pg_temp.connector_actor_id(11), 'LINEAR_API_KEY', 'connector-actor-fixture-one'),
  (pg_temp.connector_actor_id(32), pg_temp.connector_actor_id(12), 'LINEAR_API_KEY', 'connector-actor-fixture-two');

create temp table connector_actor_scopes as
select fixture.slot, factory.workspace_id, factory.id as factory_id, fixture.owner_id,
  fixture.tenant_id, fixture.secret_id, fixture.project_id, configured.installation_id,
  configured.generation, mapping.resource_id, mapping.revision
from (values
  (1, pg_temp.connector_actor_id(11), pg_temp.connector_actor_id(1), pg_temp.connector_actor_id(31),
    pg_temp.connector_actor_id(33)::text, pg_temp.connector_actor_id(35)::text),
  (2, pg_temp.connector_actor_id(12), pg_temp.connector_actor_id(4), pg_temp.connector_actor_id(32),
    pg_temp.connector_actor_id(34)::text, pg_temp.connector_actor_id(36)::text)
) fixture(slot, workspace_id, owner_id, secret_id, tenant_id, project_id)
join public.factories factory on factory.workspace_id = fixture.workspace_id and factory.is_default
cross join lateral public.configure_connector_installation(factory.workspace_id, factory.id, fixture.owner_id,
  'linear', fixture.tenant_id, fixture.tenant_id, 0, fixture.secret_id, 1) configured
cross join lateral public.publish_connector_resource_mapping(factory.workspace_id, factory.id, fixture.owner_id,
  configured.installation_id, configured.generation, 'project', fixture.project_id, 0, true) mapping;

insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id,
  target_type, target_name, permissions) values
  (pg_temp.connector_actor_id(41), pg_temp.connector_actor_id(11), 67000001,
    'https://github.com/settings/installations/67000001', 67000, 'Organization', 'connector-actor-fixture',
    '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
select pg_temp.connector_actor_id(repository.slot), scope.workspace_id, scope.factory_id,
  pg_temp.connector_actor_id(41), repository.provider_id, repository.name, 'connector-actor-fixture/' || repository.name,
  true, 'https://github.com/connector-actor-fixture/' || repository.name, 'main'
from connector_actor_scopes scope cross join (values (42, 67000002, 'writer'), (44, 67000003, 'other-writer'))
  repository(slot, provider_id, name) where scope.slot = 1;
insert into public.execution_policy_revisions(id, workspace_id, revision, requirements, created_by) values
  (pg_temp.connector_actor_id(43), pg_temp.connector_actor_id(11), 1,
    '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":300000,"maxTotalTokens":10000,"maxCostUsd":5}',
    pg_temp.connector_actor_id(1));

create temp table connector_actor_principals as
select fixture.slot, principal.workspace_id, principal.factory_id, principal.id, principal.slug
from (values (1, 'robot'), (1, 'other-robot'), (2, 'foreign-robot')) fixture(slot, slug)
join connector_actor_scopes scope using (slot)
cross join lateral public.create_service_principal(scope.workspace_id, scope.factory_id, scope.owner_id,
  fixture.slug, fixture.slug) principal;
create temp table connector_actor_grants as
select fixture.slug, approved.id, approved.version, approved.service_principal_id
from connector_actor_principals principal
join (values ('robot', 'robot', 'sessions:create'), ('other-robot', 'other-robot', 'sessions:create'),
  ('robot', 'read-only', 'sessions:read')) fixture(principal_slug, slug, command) on fixture.principal_slug = principal.slug
cross join lateral public.approve_factory_execution_grant(principal.workspace_id, principal.factory_id,
  pg_temp.connector_actor_id(1), principal.id, pg_temp.connector_actor_id(42), '{}', '{}', pg_temp.connector_actor_id(43),
  pg_temp.connector_actor_id(21), clock_timestamp() + interval '10 minutes', 0,
  p_command_scopes => array[fixture.command::public.factory_command_scope]) approved
where principal.slot = 1;
grant select, update on connector_actor_scopes to service_role;
grant select on connector_actor_principals, connector_actor_grants to service_role;

select ok(has_function_privilege('service_role', 'public.resolve_connector_review_actor(uuid,uuid,uuid,bigint,bigint,public.connector_provider,text,text,public.connector_actor_kind)', 'execute')
  and not has_function_privilege('authenticated', 'public.resolve_connector_review_actor(uuid,uuid,uuid,bigint,bigint,public.connector_provider,text,text,public.connector_actor_kind)', 'execute')
  and not has_function_privilege('authenticated', 'public.link_connector_actor(uuid,uuid,uuid,uuid,bigint,public.connector_provider,text,text,public.connector_actor_kind,uuid)', 'execute')
  and not has_table_privilege('service_role', 'internal.connector_actor_links', 'select,insert,update,delete'),
  'only the trusted service commands can link or resolve external actors');

set local role service_role;

create function pg_temp.link_fixture_actor(p_user uuid, p_actor_slot integer default 51,
  p_kind public.connector_actor_kind default 'human', p_principal uuid default null,
  p_scope integer default 1, p_tenant text default null, p_generation bigint default null) returns uuid
language sql as $$
  select public.link_connector_actor(scope.workspace_id, scope.factory_id, p_user, scope.installation_id,
    coalesce(p_generation, scope.generation), 'linear', coalesce(p_tenant, scope.tenant_id),
    pg_temp.connector_actor_id(p_actor_slot)::text, p_kind, p_principal)
  from connector_actor_scopes scope where scope.slot = p_scope
$$;

create function pg_temp.resolve_fixture_review(p_actor_slot integer default 51,
  p_kind public.connector_actor_kind default 'human', p_scope integer default 1, p_tenant text default null,
  p_mapping_revision bigint default null, p_generation bigint default null) returns uuid
language sql as $$
  select public.resolve_connector_review_actor(scope.workspace_id, scope.factory_id, scope.resource_id,
    coalesce(p_generation, scope.generation), coalesce(p_mapping_revision, scope.revision),
    'linear', coalesce(p_tenant, scope.tenant_id), pg_temp.connector_actor_id(p_actor_slot)::text, p_kind)
  from connector_actor_scopes scope where scope.slot = p_scope
$$;

create function pg_temp.resolve_fixture_event(p_actor_slot integer default 51,
  p_kind public.connector_actor_kind default 'human', p_grant text default 'robot',
  p_grant_version bigint default null) returns jsonb language sql as $$
  select to_jsonb(resolved) from connector_actor_scopes scope cross join connector_actor_grants approved
  cross join lateral public.resolve_connector_event_authority(scope.workspace_id, scope.factory_id, scope.resource_id,
    scope.generation, scope.revision, 'linear', scope.tenant_id, pg_temp.connector_actor_id(p_actor_slot)::text,
    p_kind, approved.id, coalesce(p_grant_version, approved.version)) resolved
  where scope.slot = 1 and approved.slug = p_grant
$$;

select throws_ok($$select pg_temp.resolve_fixture_review()$$,
  '42501', null, 'an unlinked external actor has no human review identity');
select throws_ok($$select pg_temp.link_fixture_actor(pg_temp.connector_actor_id(2),
    p_tenant => pg_temp.connector_actor_id(34)::text)$$,
  '42501', null, 'a callback for a different verified tenant cannot claim this installation');
select throws_ok($$select pg_temp.link_fixture_actor(pg_temp.connector_actor_id(4))$$,
  '42501', null, 'a local user from a different workspace cannot link here');
select throws_ok($$
  select public.link_connector_actor(scope.workspace_id, sibling.id, pg_temp.connector_actor_id(2),
    scope.installation_id, scope.generation, 'linear', scope.tenant_id, pg_temp.connector_actor_id(51)::text, 'human')
  from connector_actor_scopes scope join public.factories sibling using (workspace_id)
  where scope.slot = 1 and sibling.slug = 'sibling'
$$, '42501', null, 'a signed-in member cannot link through a sibling factory they cannot access');

create temp table first_human as select pg_temp.link_fixture_actor(pg_temp.connector_actor_id(2)) as id;
select ok((select id is not null from first_human), 'the signed-in factory member establishes a verified human link');
select is(pg_temp.link_fixture_actor(pg_temp.connector_actor_id(2)), (select id from first_human),
  'an exact retry returns the original link identity');
select throws_ok($$select pg_temp.link_fixture_actor(pg_temp.connector_actor_id(3))$$,
  'PT409', null, 'another signed-in human cannot claim the same actor in the same tenant');
select is(pg_temp.resolve_fixture_review(), pg_temp.connector_actor_id(22),
  'review resolves the exact linked human workspace member');

select ok(pg_temp.link_fixture_actor(pg_temp.connector_actor_id(4), p_scope => 2) <> (select id from first_human),
  'the same external actor identifier in another tenant gets its own link');
select is(pg_temp.resolve_fixture_review(p_scope => 2), pg_temp.connector_actor_id(24),
  'the second tenant resolves only its own linked member');
select throws_ok($$select pg_temp.resolve_fixture_review(p_tenant => pg_temp.connector_actor_id(34)::text)$$,
  '42501', null, 'replacing the callback tenant cannot resolve a human through the first resource');
select throws_ok($$select pg_temp.resolve_fixture_review(p_kind => 'service')$$,
  '42501', null, 'a human actor identifier supplied as a service event cannot approve');

select throws_ok($$
  select pg_temp.link_fixture_actor(pg_temp.connector_actor_id(2), 52, 'service', id)
  from connector_actor_principals where slug = 'robot'
$$, '42501', null, 'an ordinary human cannot delegate an external bot to a factory principal');
select throws_ok($$
  select pg_temp.link_fixture_actor(pg_temp.connector_actor_id(1), 52, 'service', id)
  from connector_actor_principals where slug = 'foreign-robot'
$$, '42501', null, 'the service actor cannot point at a different tenant principal');
create temp table service_actor as
select pg_temp.link_fixture_actor(pg_temp.connector_actor_id(1), 52, 'service', id) as id
from connector_actor_principals where slug = 'robot';
select ok((select id is not null from service_actor), 'the workspace owner establishes the scoped service actor');
select throws_ok($$select pg_temp.resolve_fixture_review(52, 'service')$$,
  '42501', null, 'a linked bot cannot supply human review authority');
select throws_ok($$select pg_temp.resolve_fixture_review(52, 'human')$$,
  '42501', null, 'changing the actor kind cannot convert a bot link to a human');

select is(pg_temp.resolve_fixture_event(), (select jsonb_build_object(
  'actor_link_id', human.id, 'actor_kind', 'human', 'initiating_member_id', pg_temp.connector_actor_id(22),
  'initiating_service_principal_id', null, 'execution_grant_id', approved.id, 'execution_grant_version', approved.version,
  'service_principal_id', approved.service_principal_id, 'budget_payer_member_id', pg_temp.connector_actor_id(21))
  from first_human human cross join connector_actor_grants approved where approved.slug = 'robot'),
  'human intake retains the initiator, executing service and budget payer as distinct identities');
select is(pg_temp.resolve_fixture_event(52, 'service'), (select jsonb_build_object(
  'actor_link_id', bot.id, 'actor_kind', 'service', 'initiating_member_id', null,
  'initiating_service_principal_id', approved.service_principal_id, 'execution_grant_id', approved.id,
  'execution_grant_version', approved.version, 'service_principal_id', approved.service_principal_id,
  'budget_payer_member_id', pg_temp.connector_actor_id(21))
  from service_actor bot cross join connector_actor_grants approved where approved.slug = 'robot'),
  'a bot initiates as its real service actor with separately attributed human billing');
select throws_ok($$select pg_temp.resolve_fixture_event(52, 'service', 'other-robot')$$,
  '42501', null, 'the linked bot cannot borrow a different same-factory service grant');
select throws_ok($$select pg_temp.resolve_fixture_event(52, 'service', 'read-only')$$,
  '42501', null, 'the linked bot needs explicit session creation authority');
select throws_ok($$select pg_temp.resolve_fixture_event(p_grant_version => 2)$$,
  '42501', null, 'connector intake requires the exact approved grant version');

create temp table github_actor_scope as
select scope.workspace_id, scope.factory_id, configured.installation_id, configured.generation,
  mapping.resource_id, mapping.revision
from connector_actor_scopes scope
cross join lateral public.configure_connector_installation(scope.workspace_id, scope.factory_id, scope.owner_id,
  'github', '6700', '67000001', 0) configured
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, scope.owner_id,
  configured.installation_id, configured.generation, 'repository', '67000003', 0, true) mapping
where scope.slot = 1;
select public.link_connector_actor(scope.workspace_id, scope.factory_id, pg_temp.connector_actor_id(2),
  scope.installation_id, scope.generation, 'github', '6700', '6701', 'human') from github_actor_scope scope;
select throws_ok($$
  select public.resolve_connector_event_authority(scope.workspace_id, scope.factory_id, scope.resource_id,
    scope.generation, scope.revision, 'github', '6700', '6701', 'human', approved.id, approved.version)
  from github_actor_scope scope cross join connector_actor_grants approved where approved.slug = 'robot'
$$, '42501', 'Connector execution does not match the GitHub repository.',
  'a grant for another writer in the same factory cannot execute work from a mapped GitHub repository');

update connector_actor_scopes scope set revision = published.revision
from (select current.slot, mapping.revision from connector_actor_scopes current
  cross join lateral public.publish_connector_resource_mapping(current.workspace_id, current.factory_id,
    current.owner_id, current.installation_id, current.generation, 'project', current.project_id, current.revision, true) mapping
  where current.slot = 1) published where scope.slot = published.slot;
select throws_ok($$select pg_temp.resolve_fixture_review(p_mapping_revision => 1)$$,
  'PT409', null, 'the old resource mapping revision cannot authorize an external review');
select is(pg_temp.resolve_fixture_review(), pg_temp.connector_actor_id(22),
  'a current mapping still resolves the same verified human link');
update connector_actor_scopes scope set generation = refreshed.generation
from (select current.slot, configured.generation from connector_actor_scopes current
  cross join lateral public.configure_connector_installation(current.workspace_id, current.factory_id, current.owner_id,
    'linear', current.tenant_id, current.tenant_id, current.generation, current.secret_id, 1) configured
  where current.slot = 1) refreshed where scope.slot = refreshed.slot;
select throws_ok($$select pg_temp.resolve_fixture_review(p_generation => 1)$$,
  'PT409', null, 'the old installation generation cannot authorize an external review');
select throws_ok($$select pg_temp.link_fixture_actor(pg_temp.connector_actor_id(2), p_generation => 1)$$,
  'PT409', null, 'an old installation generation cannot verify a callback retry');
select is(pg_temp.resolve_fixture_review(), pg_temp.connector_actor_id(22),
  'the current generation retains the existing verified human identity');

update public.workspace_members set is_active = false where id = pg_temp.connector_actor_id(22);
select throws_ok($$select pg_temp.resolve_fixture_review()$$,
  '42501', null, 'a retained actor link cannot confer authority after local membership is deactivated');
update public.workspace_members set is_active = true where id = pg_temp.connector_actor_id(22);
select throws_ok($$select public.revoke_connector_actor_link(pg_temp.connector_actor_id(11),
  pg_temp.connector_actor_id(1), pg_temp.connector_actor_id(99))$$,
  'P0002', null, 'revoking a missing link does not manufacture a revocation receipt');
select throws_ok($$select public.revoke_connector_actor_link(pg_temp.connector_actor_id(11), pg_temp.connector_actor_id(3), id)
  from first_human$$, '42501', null, 'one ordinary member cannot revoke another human actor link');
select ok((select public.revoke_connector_actor_link(pg_temp.connector_actor_id(11), pg_temp.connector_actor_id(2), id)
  from first_human), 'the linked human can revoke their own actor link');
select is((select public.revoke_connector_actor_link(pg_temp.connector_actor_id(11), pg_temp.connector_actor_id(2), id)
  from first_human), false, 'retrying a completed revocation leaves its decision unchanged');
select throws_ok($$select pg_temp.resolve_fixture_review()$$,
  '42501', null, 'a revoked external human cannot supply review authority');
select throws_ok($$select pg_temp.resolve_fixture_event()$$,
  '42501', null, 'a revoked human link cannot initiate new work');
select ok((select public.revoke_connector_actor_link(pg_temp.connector_actor_id(11), pg_temp.connector_actor_id(1), id)
  from service_actor), 'the workspace owner can revoke the service actor');
select throws_ok($$select pg_temp.resolve_fixture_event(52, 'service')$$,
  '42501', null, 'a current execution grant cannot restore a revoked service actor');

reset role;
select results_eq($$select link.member_id, link.verified_by_member_id, link.revoked_by_member_id
  from internal.connector_actor_links link join first_human human using (id) where link.revoked_at is not null$$,
  $$values (pg_temp.connector_actor_id(22), pg_temp.connector_actor_id(22), pg_temp.connector_actor_id(22))$$,
  'revocation retains the original verified actor and records the revoking member');

select * from finish();
rollback;
