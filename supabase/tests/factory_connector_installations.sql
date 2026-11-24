begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(54);

create function pg_temp.connector_fixture_id(slot integer) returns uuid
language sql immutable as $$
  select ('66900000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values
  (pg_temp.connector_fixture_id(1), 'connector-owner@example.test'),
  (pg_temp.connector_fixture_id(2), 'connector-sibling-member@example.test'),
  (pg_temp.connector_fixture_id(3), 'connector-outsider@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.connector_fixture_id(11), 'connector-fixture', 'Connector fixture'),
  (pg_temp.connector_fixture_id(12), 'connector-outsider', 'Connector outsider');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.connector_fixture_id(21), pg_temp.connector_fixture_id(11), pg_temp.connector_fixture_id(1), 'human', 'owner'),
  (pg_temp.connector_fixture_id(22), pg_temp.connector_fixture_id(11), pg_temp.connector_fixture_id(2), 'human', 'member'),
  (pg_temp.connector_fixture_id(23), pg_temp.connector_fixture_id(12), pg_temp.connector_fixture_id(3), 'human', 'owner');
select public.create_factory(pg_temp.connector_fixture_id(11), pg_temp.connector_fixture_id(1),
  'Connectors', 'connectors');

create temp table connector_scope as
select workspace_id, id as factory_id, slug,
  case workspace_id when pg_temp.connector_fixture_id(11) then pg_temp.connector_fixture_id(1)
    else pg_temp.connector_fixture_id(3) end as actor_id
from public.factories where workspace_id in (pg_temp.connector_fixture_id(11), pg_temp.connector_fixture_id(12));
grant select on connector_scope to service_role;

insert into public.workspace_secrets(id, workspace_id, key, encrypted_value) values (
  pg_temp.connector_fixture_id(34), pg_temp.connector_fixture_id(11), 'LINEAR_API_KEY',
  'v2.AAAAAAAAAAAAAAAA.QQ.AAAAAAAAAAAAAAAAAAAAAA');

set local role service_role;
set local request.jwt.claim.role = 'service_role';

create function pg_temp.configure_linear(p_generation bigint, p_material_revision bigint, p_actor uuid default null)
returns table(installation_id uuid, generation bigint) language sql as $$
  select configured.* from connector_scope scope
  cross join lateral public.configure_connector_installation(scope.workspace_id, scope.factory_id,
    coalesce(p_actor, scope.actor_id), 'linear', pg_temp.connector_fixture_id(35)::text,
    pg_temp.connector_fixture_id(35)::text, p_generation,
    p_linear_secret_id => pg_temp.connector_fixture_id(34), p_linear_material_revision => p_material_revision) configured
  where scope.slug = 'connectors'
$$;

select throws_ok($$select * from pg_temp.configure_linear(0, null)$$,
  '22023', null, 'Linear setup requires both the verified secret and its material revision');
select throws_ok($$select * from pg_temp.configure_linear(0, 1, pg_temp.connector_fixture_id(2))$$,
  '42501', null, 'a sibling-only workspace member cannot manage the installation');

create temp table linear_installation as select * from pg_temp.configure_linear(0, 1);
select is((select generation from linear_installation), 1::bigint, 'the installation starts at generation one');
select throws_ok($$select * from pg_temp.configure_linear(0, 1)$$,
  'PT409', null, 'a duplicate initial claim cannot replace or advance the existing installation');

create function pg_temp.publish_linear_mapping(
  p_generation bigint, p_revision bigint, p_enabled boolean,
  p_external_resource_id text default pg_temp.connector_fixture_id(36)::text,
  p_resource_kind public.connector_resource_kind default 'project'
) returns table(resource_id uuid, revision bigint) language sql as $$
  select mapping.* from connector_scope scope cross join linear_installation installation
  cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id,
    scope.actor_id, installation.installation_id, p_generation, p_resource_kind,
    p_external_resource_id, p_revision, p_enabled) mapping
  where scope.slug = 'connectors'
$$;

select throws_ok($$select * from pg_temp.publish_linear_mapping(1, 0, true, p_resource_kind => 'repository')$$,
  '22023', null, 'Linear cannot bind the external project identity as a repository');
create temp table linear_resource as select * from pg_temp.publish_linear_mapping(1, 0, true);
select is((select revision from linear_resource), 1::bigint, 'the resource has an initial mapping revision');

insert into public.pipelines(id, workspace_id, factory_id, name)
select pg_temp.connector_fixture_id(41), workspace_id, factory_id, 'Connector pipeline'
from connector_scope where slug = 'connectors';
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name) values (
  pg_temp.connector_fixture_id(42), pg_temp.connector_fixture_id(41), pg_temp.connector_fixture_id(11),
  1, 'plan', 'Plan');
insert into public.sessions(id, workspace_id, factory_id, number, title, prompt_md, creator_member_id,
  pipeline_id, current_stage_id)
select pg_temp.connector_fixture_id(43), workspace_id, factory_id, 1, 'Connector session', 'Keep the original thread.',
  pg_temp.connector_fixture_id(21), pg_temp.connector_fixture_id(41), pg_temp.connector_fixture_id(42)
from connector_scope where slug = 'connectors';
select public.bind_session_conversation_source_once(scope.workspace_id, scope.factory_id,
  pg_temp.connector_fixture_id(43), pg_temp.connector_fixture_id(21), 'linear', resource.resource_id::text,
  pg_temp.connector_fixture_id(44)::text, 'Original Linear issue',
  'https://linear.app/connector-fixture/issue/CONNECT-42/original-issue')
from connector_scope scope cross join linear_resource resource where scope.slug = 'connectors';

select throws_ok($$
  select public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, scope.actor_id,
    installation.installation_id, 1, 'project', pg_temp.connector_fixture_id(36)::text, 0, true)
  from connector_scope scope cross join linear_installation installation
  where scope.workspace_id = pg_temp.connector_fixture_id(11) and scope.slug = 'default'
$$, 'P0002', null, 'a workspace owner cannot claim the mapped Linear project for a sibling factory');

create function pg_temp.advance_linear_cursor(p_installation_generation bigint, p_mapping_revision bigint,
  p_cursor_generation bigint, p_position text, p_stream text default 'intake') returns bigint language sql as $$
  select public.advance_connector_subscription_cursor(scope.workspace_id, scope.factory_id, resource.resource_id,
    p_installation_generation, p_mapping_revision, p_stream, p_cursor_generation, p_position)
  from connector_scope scope cross join linear_resource resource
  where scope.slug = 'connectors'
$$;

select ok((select count(*) = 1 and bool_and(subscription.installation_generation = 1
  and subscription.mapping_revision = 1 and subscription.cursor_generation = 0
  and subscription.cursor_position is null and subscription.credential_kind = 'workspace_secret'
  and subscription.credential_ref = pg_temp.connector_fixture_id(34) and subscription.credential_material_revision = 1)
  from connector_scope scope cross join linear_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 'trusted intake resolves the exact active mapping, credential reference and empty cursor');
select is((select count(*) from connector_scope scope cross join linear_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'default'), 0::bigint, 'subscription lookup does not cross factory or workspace scope');
select is(pg_temp.advance_linear_cursor(1, 1, 0, 'page-2'), 1::bigint,
  'the first cursor update advances the generation');
select is(pg_temp.advance_linear_cursor(1, 1, 0, 'outbound-page', 'outbound'), 1::bigint,
  'a separate stream gets an independent cursor on the same resource');
select throws_ok($$select pg_temp.advance_linear_cursor(1, 1, 0, 'stale-page')$$,
  'PT409', null, 'a stale worker cannot replace a committed cursor');
select throws_ok($$
  select public.advance_connector_subscription_cursor(scope.workspace_id, scope.factory_id, resource.resource_id,
    1, 1, 'intake', 1, 'other-workspace-page')
  from connector_scope scope cross join linear_resource resource
  where scope.workspace_id = pg_temp.connector_fixture_id(12)
$$, 'P0002', null, 'a worker cannot advance a resource under a different workspace and factory');
select ok((select bool_and(subscription.cursor_generation = 1 and subscription.cursor_position = 'page-2')
  from connector_scope scope cross join linear_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 'a fresh worker resumes at the durable cursor after a stale attempt');

update public.workspace_secrets set encrypted_value = 'v2.BBBBBBBBBBBBBBBB.Qg.BBBBBBBBBBBBBBBBBBBBBA'
where id = pg_temp.connector_fixture_id(34);
select is((select count(*) from connector_scope scope cross join linear_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 0::bigint, 'rotating the shared Linear key fences the old credential revision immediately');
select throws_ok($$select * from pg_temp.configure_linear(1, 1)$$,
  'PT409', null, 'Linear setup cannot attach an organization verified against the previous key');
select throws_ok($$select pg_temp.advance_linear_cursor(1, 1, 1, 'pre-rotation-page')$$,
  'P0002', null, 'an unverified replacement key also blocks cursor writes');
create temp table linear_rotated as select * from pg_temp.configure_linear(1, 2);
select ok((select rotated.installation_id = initial.installation_id and rotated.generation = 2
  from linear_rotated rotated cross join linear_installation initial), 'rotation preserves installation identity and advances its generation');
select throws_ok($$select * from pg_temp.configure_linear(1, 2)$$,
  'PT409', null, 'a stale installation generation cannot apply a second rotation');
select throws_ok($$select pg_temp.advance_linear_cursor(1, 1, 1, 'pre-rotation-page')$$,
  'PT409', null, 'rotation fences the old connection generation');
select ok((select count(*) = 1 and bool_and(subscription.installation_generation = 2
  and subscription.mapping_revision = 1 and subscription.credential_ref = pg_temp.connector_fixture_id(34)
  and subscription.credential_material_revision = 2)
  from connector_scope scope cross join linear_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 'rotation retains the pinned resource mapping and exposes the current credential revision');

select is((select revision from pg_temp.publish_linear_mapping(2, 1, false)), 2::bigint,
  'disabling the resource publishes a second revision');
select throws_ok($$select pg_temp.advance_linear_cursor(2, 1, 1, 'disabled-page')$$,
  'PT409', null, 'publishing a mapping revision fences workers on the old revision');
select is((select count(*) from connector_scope scope cross join linear_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 0::bigint, 'a disabled mapping produces no subscription');
select throws_ok($$select * from pg_temp.publish_linear_mapping(2, 1, true)$$,
  'PT409', null, 'a stale mapping update cannot reenable subscriptions');
select ok((select mapping.resource_id = resource.resource_id and mapping.revision = 3
  from pg_temp.publish_linear_mapping(2, 2, true) mapping cross join linear_resource resource),
  'reenabling the mapping preserves the stable resource identity');

select is((select public.disconnect_connector_installation(scope.workspace_id, scope.factory_id, scope.actor_id,
  installation.installation_id, 2) from connector_scope scope cross join linear_installation installation
  where scope.slug = 'connectors'), 3::bigint, 'disconnect invalidates the current generation');
select ok((select state.generation = 3 and state.status = 'disconnected'
  and not (to_jsonb(state) ? 'credential_ref')
  from connector_scope scope cross join linear_installation installation
  cross join lateral public.read_connector_installation_state(scope.workspace_id, scope.factory_id,
    scope.actor_id, installation.installation_id) state where scope.slug = 'connectors'),
  'the authorized setup read exposes disconnected status with no credential material');
select is((select public.disconnect_connector_installation(scope.workspace_id, scope.factory_id, scope.actor_id,
  installation.installation_id, 3) from connector_scope scope cross join linear_installation installation
  where scope.slug = 'connectors'), 3::bigint, 'retrying a completed disconnect does not advance its generation');
select is((select count(*) from connector_scope scope cross join linear_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 0::bigint, 'disconnect stops new and existing intake subscriptions');
select throws_ok($$select * from pg_temp.publish_linear_mapping(3, 0, true, pg_temp.connector_fixture_id(39)::text)$$,
  'P0002', null, 'a disconnected installation cannot map a new project');
select throws_ok($$select pg_temp.advance_linear_cursor(2, 3, 1, 'disconnected-page')$$,
  'PT409', null, 'disconnect prevents an in-flight worker from committing old work');
select throws_ok($$select pg_temp.advance_linear_cursor(3, 3, 1, 'disconnected-page')$$,
  'P0002', null, 'current generations cannot write a cursor without an active connection');

reset role;
select ok((select current_installation.legacy_credential_id is null
  and current_installation.linear_material_revision is null and current_installation.disconnected_at is not null
  from internal.connector_installations current_installation
  join linear_installation initial on initial.installation_id = current_installation.id),
  'disconnect clears the connector credential reference while retaining its installation identity');
select results_eq($$select material_revision, encrypted_value from public.workspace_secrets
  where id = pg_temp.connector_fixture_id(34) and key = 'LINEAR_API_KEY'$$,
  $$values (2::bigint, 'v2.BBBBBBBBBBBBBBBB.Qg.BBBBBBBBBBBBBBBBBBBBBA'::text)$$,
  'disconnect leaves the existing Linear integration key and revision available to its native owner');
select ok(not has_function_privilege('authenticated', 'public.read_connector_subscription(uuid,uuid,uuid,text)', 'execute')
  and not has_function_privilege('anon', 'public.read_connector_subscription(uuid,uuid,uuid,text)', 'execute')
  and not has_table_privilege('authenticated', 'internal.connector_installations', 'select'),
  'browser and anonymous roles cannot resolve or read connector credentials');
select ok(not has_table_privilege('authenticated', 'public.factory_connector_mapping_revisions', 'insert,update,delete')
  and not has_table_privilege('anon', 'public.factory_connector_resources', 'select'),
  'mapping history is read-only for factory readers and unavailable to anonymous callers');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select set_config('request.jwt.claim.sub', pg_temp.connector_fixture_id(1)::text, true);
select is((select count(*) from public.factory_connector_resources where workspace_id = pg_temp.connector_fixture_id(11)),
  1::bigint, 'the authorized factory can still read resource metadata after disconnect');
select is((select source.source_url from public.session_conversation_sources source
  join public.factory_connector_resources resource on (resource.workspace_id, resource.factory_id, resource.id::text) =
    (source.workspace_id, source.factory_id, source.source_namespace)
  where source.session_id = pg_temp.connector_fixture_id(43) and source.provider = 'linear'
    and source.external_thread_id = pg_temp.connector_fixture_id(44)::text),
  'https://linear.app/connector-fixture/issue/CONNECT-42/original-issue',
  'an authenticated factory reader retains the original conversation source link after disconnect');
select results_eq($$select revision, enabled from public.factory_connector_mapping_revisions
  where workspace_id = pg_temp.connector_fixture_id(11) order by revision$$,
  $$values (1::bigint, true), (2::bigint, false), (3::bigint, true)$$,
  'disconnect preserves the ordered history of authorized mapping decisions');
select set_config('request.jwt.claim.sub', pg_temp.connector_fixture_id(2)::text, true);
select is((select count(*) from public.factory_connector_resources where workspace_id = pg_temp.connector_fixture_id(11)),
  0::bigint, 'an authenticated member of a sibling factory cannot read the resource');
select is((select count(*) from public.session_conversation_sources where session_id = pg_temp.connector_fixture_id(43)),
  0::bigint, 'the retained conversation source remains hidden from a sibling factory member');
select set_config('request.jwt.claim.sub', pg_temp.connector_fixture_id(3)::text, true);
select is((select count(*) from public.factory_connector_mapping_revisions where workspace_id = pg_temp.connector_fixture_id(11)),
  0::bigint, 'an authenticated owner of another workspace cannot read mapping history');

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select ok((select reconnected.installation_id = initial.installation_id and reconnected.generation = 4
  from pg_temp.configure_linear(3, 2) reconnected
  cross join linear_installation initial), 'explicit reconnect uses the original installation identity at a new generation');
select ok((select count(*) = 1 and bool_and(subscription.installation_generation = 4 and subscription.mapping_revision = 3
  and subscription.credential_ref = pg_temp.connector_fixture_id(34) and subscription.credential_material_revision = 2)
  from connector_scope scope cross join linear_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 'reconnect reuses the retained mapping with a verified reference to the current key');
select throws_ok($$select pg_temp.advance_linear_cursor(2, 3, 1, 'resumed-obsolete-page')$$,
  'PT409', null, 'reconnect does not revive old work leases');

reset role;
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id,
  target_type, target_name, permissions)
values (pg_temp.connector_fixture_id(31), pg_temp.connector_fixture_id(11), 669001,
  'https://github.com/settings/installations/669001', 6690, 'Organization', 'connector-fixture',
  '{"contents":"read","issues":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url)
select pg_temp.connector_fixture_id(repository.slot), scope.workspace_id, scope.factory_id,
  pg_temp.connector_fixture_id(31), 669000 + repository.slot,
  repository.name, 'connector-fixture/' || repository.name, true,
  'https://github.com/connector-fixture/' || repository.name
from connector_scope scope join (values (32, 'connectors', 'mapped'), (33, 'default', 'sibling'))
  as repository(slot, slug, name) on scope.slug = repository.slug
where scope.workspace_id = pg_temp.connector_fixture_id(11);

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select throws_ok($$
  select public.configure_connector_installation(workspace_id, factory_id, actor_id, 'github', '6690', '669001', 0)
  from connector_scope where workspace_id = pg_temp.connector_fixture_id(12)
$$, 'P0002', null, 'a different workspace cannot claim the existing GitHub App installation');
create temp table github_connector as
select configured.* from connector_scope scope
cross join lateral public.configure_connector_installation(scope.workspace_id, scope.factory_id,
  scope.actor_id, 'github', '6690', '669001', 0) configured
where scope.slug = 'connectors';
select is((select generation from github_connector), 1::bigint,
  'the GitHub connector reuses the workspace-owned App installation');
select throws_ok($$
  select public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, scope.actor_id,
    connector.installation_id, 1, 'repository', '669033', 0, true)
  from connector_scope scope cross join github_connector connector where scope.slug = 'connectors'
$$, 'P0002', null, 'a GitHub repository on the right App installation must still belong to the mapped factory');
create temp table github_connector_resource as
select mapping.* from connector_scope scope cross join github_connector connector
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, scope.actor_id,
  connector.installation_id, 1, 'repository', '669032', 0, true) mapping
where scope.slug = 'connectors';
select ok((select count(*) = 1 and bool_and(subscription.credential_ref = pg_temp.connector_fixture_id(31)
  and subscription.credential_kind = 'github_installation' and subscription.credential_material_revision is null)
  from connector_scope scope cross join github_connector_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 'GitHub subscribes using the native installation reference without copying credential material');
update public.github_installations set suspended = true where id = pg_temp.connector_fixture_id(31);
select is((select count(*) from connector_scope scope cross join github_connector_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 0::bigint, 'suspending the native GitHub installation removes active connector access');
select is((select state.status from connector_scope scope cross join github_connector installation
  cross join lateral public.read_connector_installation_state(scope.workspace_id, scope.factory_id,
    scope.actor_id, installation.installation_id) state where scope.slug = 'connectors'),
  'credential_unavailable', 'setup can distinguish a suspended native credential from an intentional disconnect');

reset role;
delete from public.github_installations where id = pg_temp.connector_fixture_id(31);
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id,
  target_type, target_name, permissions)
values (pg_temp.connector_fixture_id(37), pg_temp.connector_fixture_id(11), 669002,
  'https://github.com/settings/installations/669002', 6690, 'Organization', 'connector-fixture',
  '{"contents":"read","issues":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url)
select pg_temp.connector_fixture_id(38), workspace_id, factory_id, pg_temp.connector_fixture_id(37), 669032,
  'mapped', 'connector-fixture/mapped', true, 'https://github.com/connector-fixture/mapped'
from connector_scope where slug = 'connectors';

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select ok((select configured.installation_id = original.installation_id and configured.generation = 2
  from connector_scope scope cross join github_connector original
  cross join lateral public.configure_connector_installation(scope.workspace_id, scope.factory_id,
    scope.actor_id, 'github', '6690', '669002', 1) configured
  where scope.slug = 'connectors'), 'verified GitHub reinstall recovers the same connector under a replacement App installation ID');
select ok((select count(*) = 1 and bool_and(subscription.installation_generation = 2
  and subscription.mapping_revision = 1 and subscription.credential_ref = pg_temp.connector_fixture_id(37))
  from connector_scope scope cross join github_connector_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 'GitHub reinstall resumes the original resource mapping with the new native credential reference');

select * from finish();
rollback;
