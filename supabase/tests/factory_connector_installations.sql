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

set local role service_role;
set local request.jwt.claim.role = 'service_role';

create function pg_temp.configure_slack(p_generation bigint, p_material text, p_actor uuid default null)
returns table(installation_id uuid, generation bigint) language sql as $$
  select configured.* from connector_scope scope
  cross join lateral public.configure_connector_installation(scope.workspace_id, scope.factory_id,
    coalesce(p_actor, scope.actor_id), 'slack', 'T66901', 'A66901', p_generation, p_material) configured
  where scope.slug = 'connectors'
$$;

select throws_ok($$select * from pg_temp.configure_slack(0, 'plaintext-token')$$,
  '22023', null, 'installation setup rejects unencrypted Slack credential material');
select throws_ok($$select * from pg_temp.configure_slack(0, 'v2.AAAAAAAAAAAAAAAA.QQ.AAAAAAAAAAAAAAAAAAAAAA',
    pg_temp.connector_fixture_id(2))$$,
  '42501', null, 'a sibling-only workspace member cannot manage the installation');

create temp table slack_installation as
select * from pg_temp.configure_slack(0, 'v2.AAAAAAAAAAAAAAAA.QQ.AAAAAAAAAAAAAAAAAAAAAA');
select is((select generation from slack_installation), 1::bigint, 'the installation starts at generation one');

create function pg_temp.publish_slack_mapping(
  p_generation bigint, p_revision bigint, p_enabled boolean,
  p_external_resource_id text default 'C66901', p_resource_kind public.connector_resource_kind default 'channel'
) returns table(resource_id uuid, revision bigint) language sql as $$
  select mapping.* from connector_scope scope cross join slack_installation installation
  cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id,
    scope.actor_id, installation.installation_id, p_generation, p_resource_kind,
    p_external_resource_id, p_revision, p_enabled) mapping
  where scope.slug = 'connectors'
$$;

select throws_ok($$select * from pg_temp.publish_slack_mapping(1, 0, true, 'C66901', 'repository')$$,
  '22023', null, 'Slack cannot bind the external identity as a repository');
create temp table slack_resource as select * from pg_temp.publish_slack_mapping(1, 0, true);
select is((select revision from slack_resource), 1::bigint, 'the resource has an initial mapping revision');

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
  pg_temp.connector_fixture_id(43), pg_temp.connector_fixture_id(21), 'slack', resource.resource_id::text,
  '1710000000.000001', 'Original Slack thread', 'https://app.slack.com/archives/C66901/p1710000000000001')
from connector_scope scope cross join slack_resource resource where scope.slug = 'connectors';

select throws_ok($$
  select public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, scope.actor_id,
    installation.installation_id, 1, 'channel', 'C66901', 0, true)
  from connector_scope scope cross join slack_installation installation
  where scope.workspace_id = pg_temp.connector_fixture_id(11) and scope.slug = 'default'
$$, 'P0002', null, 'even a shared workspace owner cannot reuse the installation in a sibling factory');

create function pg_temp.advance_slack_cursor(p_installation_generation bigint, p_mapping_revision bigint,
  p_cursor_generation bigint, p_position text, p_stream text default 'intake') returns bigint language sql as $$
  select public.advance_connector_subscription_cursor(scope.workspace_id, scope.factory_id, resource.resource_id,
    p_installation_generation, p_mapping_revision, p_stream, p_cursor_generation, p_position)
  from connector_scope scope cross join slack_resource resource
  where scope.slug = 'connectors'
$$;

select ok((select count(*) = 1 and bool_and(subscription.installation_generation = 1
  and subscription.mapping_revision = 1 and subscription.cursor_generation = 0
  and subscription.cursor_position is null and subscription.credential_ref = installation.installation_id
  and subscription.encrypted_credential = 'v2.AAAAAAAAAAAAAAAA.QQ.AAAAAAAAAAAAAAAAAAAAAA')
  from connector_scope scope cross join slack_resource resource cross join slack_installation installation
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 'trusted intake resolves the exact active mapping, credential reference and empty cursor');
select is((select count(*) from connector_scope scope cross join slack_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'default'), 0::bigint, 'subscription lookup does not cross factory or workspace scope');
select is(pg_temp.advance_slack_cursor(1, 1, 0, 'page-2'), 1::bigint,
  'the first cursor update advances the generation');
select is(pg_temp.advance_slack_cursor(1, 1, 0, 'outbound-page', 'outbound'), 1::bigint,
  'a separate stream gets an independent cursor on the same resource');
select throws_ok($$select pg_temp.advance_slack_cursor(1, 1, 0, 'stale-page')$$,
  'PT409', null, 'a stale worker cannot replace a committed cursor');
select throws_ok($$
  select public.advance_connector_subscription_cursor(scope.workspace_id, scope.factory_id, resource.resource_id,
    1, 1, 'intake', 1, 'other-workspace-page')
  from connector_scope scope cross join slack_resource resource
  where scope.workspace_id = pg_temp.connector_fixture_id(12)
$$, 'P0002', null, 'a worker cannot advance a resource under a different workspace and factory');
select ok((select bool_and(subscription.cursor_generation = 1 and subscription.cursor_position = 'page-2')
  from connector_scope scope cross join slack_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 'a fresh worker resumes at the durable cursor after a stale attempt');

create temp table slack_rotated as
select * from pg_temp.configure_slack(1, 'v2.BBBBBBBBBBBBBBBB.Qg.BBBBBBBBBBBBBBBBBBBBBA');
select ok((select rotated.installation_id = initial.installation_id and rotated.generation = 2
  from slack_rotated rotated cross join slack_installation initial), 'rotation preserves installation identity and advances its generation');
select throws_ok($$select * from pg_temp.configure_slack(1, 'v2.AAAAAAAAAAAAAAAA.QQ.AAAAAAAAAAAAAAAAAAAAAA')$$,
  'PT409', null, 'a stale credential replacement cannot restore obsolete material');
select throws_ok($$select pg_temp.advance_slack_cursor(1, 1, 1, 'pre-rotation-page')$$,
  'PT409', null, 'rotation fences the old connection generation');
select ok((select count(*) = 1 and bool_and(subscription.installation_generation = 2
  and subscription.mapping_revision = 1 and subscription.encrypted_credential = 'v2.BBBBBBBBBBBBBBBB.Qg.BBBBBBBBBBBBBBBBBBBBBA')
  from connector_scope scope cross join slack_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 'rotation retains the pinned resource mapping and exposes the replacement material');

select is((select revision from pg_temp.publish_slack_mapping(2, 1, false)), 2::bigint,
  'disabling the resource publishes a second revision');
select throws_ok($$select pg_temp.advance_slack_cursor(2, 1, 1, 'disabled-page')$$,
  'PT409', null, 'publishing a mapping revision fences workers on the old revision');
select is((select count(*) from connector_scope scope cross join slack_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 0::bigint, 'a disabled mapping produces no subscription');
select throws_ok($$select * from pg_temp.publish_slack_mapping(2, 1, true)$$,
  'PT409', null, 'a stale mapping update cannot reenable subscriptions');
select ok((select mapping.resource_id = resource.resource_id and mapping.revision = 3
  from pg_temp.publish_slack_mapping(2, 2, true) mapping cross join slack_resource resource),
  'reenabling the mapping preserves the stable resource identity');

select is((select public.disconnect_connector_installation(scope.workspace_id, scope.factory_id, scope.actor_id,
  installation.installation_id, 2) from connector_scope scope cross join slack_installation installation
  where scope.slug = 'connectors'), 3::bigint, 'disconnect invalidates the current generation');
select ok((select state.generation = 3 and state.status = 'disconnected'
  and not (to_jsonb(state) ? 'encrypted_credential')
  from connector_scope scope cross join slack_installation installation
  cross join lateral public.read_connector_installation_state(scope.workspace_id, scope.factory_id,
    scope.actor_id, installation.installation_id) state where scope.slug = 'connectors'),
  'the authorized setup read exposes disconnected status with no credential material');
select is((select public.disconnect_connector_installation(scope.workspace_id, scope.factory_id, scope.actor_id,
  installation.installation_id, 3) from connector_scope scope cross join slack_installation installation
  where scope.slug = 'connectors'), 3::bigint, 'retrying a completed disconnect does not advance its generation');
select is((select count(*) from connector_scope scope cross join slack_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 0::bigint, 'disconnect stops new and existing intake subscriptions');
select throws_ok($$select * from pg_temp.publish_slack_mapping(3, 0, true, 'C66902')$$,
  'P0002', null, 'a disconnected installation cannot map a new channel');
select throws_ok($$select pg_temp.advance_slack_cursor(2, 3, 1, 'disconnected-page')$$,
  'PT409', null, 'disconnect prevents an in-flight worker from committing old work');
select throws_ok($$select pg_temp.advance_slack_cursor(3, 3, 1, 'disconnected-page')$$,
  'P0002', null, 'current generations cannot write a cursor without an active connection');

reset role;
select ok((select current_installation.encrypted_credential is null
  from internal.connector_installations current_installation
  join slack_installation initial on initial.installation_id = current_installation.id),
  'disconnect discards the local credential ciphertext while retaining the installation identity');
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
  where source.session_id = pg_temp.connector_fixture_id(43) and source.provider = 'slack'
    and source.external_thread_id = '1710000000.000001'),
  'https://app.slack.com/archives/C66901/p1710000000000001',
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
  from pg_temp.configure_slack(3, 'v2.CCCCCCCCCCCCCCCC.Qw.CCCCCCCCCCCCCCCCCCCCCA') reconnected
  cross join slack_installation initial), 'explicit reconnect uses the original installation identity at a new generation');
select ok((select count(*) = 1 and bool_and(subscription.installation_generation = 4 and subscription.mapping_revision = 3
  and subscription.encrypted_credential = 'v2.CCCCCCCCCCCCCCCC.Qw.CCCCCCCCCCCCCCCCCCCCCA')
  from connector_scope scope cross join slack_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 'reconnect reuses the retained mapping with only the newly supplied material');
select throws_ok($$select pg_temp.advance_slack_cursor(2, 3, 1, 'resumed-obsolete-page')$$,
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
insert into public.workspace_secrets(id, workspace_id, key, encrypted_value) values (
  pg_temp.connector_fixture_id(34), pg_temp.connector_fixture_id(11), 'LINEAR_API_KEY',
  'v2.AAAAAAAAAAAAAAAA.QQ.AAAAAAAAAAAAAAAAAAAAAA');

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
  and subscription.encrypted_credential is null)
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

create function pg_temp.configure_linear(p_generation bigint, p_material_revision bigint)
returns table(installation_id uuid, generation bigint)
language sql as $$
  select configured.* from connector_scope scope
  cross join lateral public.configure_connector_installation(scope.workspace_id, scope.factory_id, scope.actor_id,
    'linear', pg_temp.connector_fixture_id(35)::text, pg_temp.connector_fixture_id(35)::text, p_generation,
    p_linear_secret_id => pg_temp.connector_fixture_id(34), p_linear_material_revision => p_material_revision) configured
  where scope.slug = 'connectors'
$$;
create temp table linear_connector as select * from pg_temp.configure_linear(0, 1);
create temp table linear_connector_resource as
select mapping.* from connector_scope scope cross join linear_connector connector
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, scope.actor_id,
  connector.installation_id, 1, 'project', pg_temp.connector_fixture_id(36)::text, 0, true) mapping
where scope.slug = 'connectors';
select ok((select count(*) = 1 and bool_and(subscription.credential_ref = pg_temp.connector_fixture_id(34)
  and subscription.credential_material_revision = 1
  and subscription.encrypted_credential is null)
  from connector_scope scope cross join linear_connector_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 'Linear intake resolves the existing workspace secret for the verified organization');
update public.workspace_secrets set encrypted_value = 'v2.BBBBBBBBBBBBBBBB.Qg.BBBBBBBBBBBBBBBBBBBBBA'
where id = pg_temp.connector_fixture_id(34);
select is((select count(*) from connector_scope scope cross join linear_connector_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 0::bigint, 'rotating the workspace key fences the older Linear credential revision');
select throws_ok($$select * from pg_temp.configure_linear(1, 1)$$,
  'PT409', null, 'Linear setup cannot attach an organization verified against the previous key');
select ok((select configured.installation_id = connector.installation_id and configured.generation = 2
  from pg_temp.configure_linear(1, 2) configured cross join linear_connector connector),
  'verified Linear setup can reconnect the same installation after key rotation');
select ok((select count(*) = 1 and bool_and(subscription.installation_generation = 2
  and subscription.mapping_revision = 1 and subscription.credential_ref = pg_temp.connector_fixture_id(34)
  and subscription.credential_material_revision = 2 and subscription.encrypted_credential is null)
  from connector_scope scope cross join linear_connector_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) subscription
  where scope.slug = 'connectors'), 'verified Linear rotation preserves the mapped source and returns only the current reference');

select * from finish();
rollback;
