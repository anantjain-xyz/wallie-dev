begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(59);
set local request.jwt.claim.role = 'service_role';

create function pg_temp.slack_id(slot integer) returns uuid language sql immutable as $$
  select ('67600000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id,email) values
  (pg_temp.slack_id(1), 'slack-install-owner@example.test'),
  (pg_temp.slack_id(2), 'slack-factory-member@example.test'),
  (pg_temp.slack_id(3), 'slack-outside-owner@example.test');
insert into public.workspaces(id,slug,name) values
  (pg_temp.slack_id(11), 'slack-installations-fixture', 'Slack test workspace'),
  (pg_temp.slack_id(12), 'slack-installations-outside', 'Slack outsider workspace');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  (pg_temp.slack_id(21), pg_temp.slack_id(11), pg_temp.slack_id(1), 'human', 'owner'),
  (pg_temp.slack_id(22), pg_temp.slack_id(11), pg_temp.slack_id(2), 'human', 'member'),
  (pg_temp.slack_id(23), pg_temp.slack_id(12), pg_temp.slack_id(3), 'human', 'owner');

select public.create_factory(pg_temp.slack_id(11), pg_temp.slack_id(1), 'Slack channels', 'slack-channels');
select public.create_factory(pg_temp.slack_id(11), pg_temp.slack_id(1), 'Unrelated channels', 'slack-sibling');
create temp table slack_scope as
select workspace_id, id as factory_id,
  case when workspace_id = pg_temp.slack_id(12) then 'outside' when slug = 'slack-sibling' then 'sibling' else 'main' end as scope,
  case when workspace_id = pg_temp.slack_id(12) then pg_temp.slack_id(3) else pg_temp.slack_id(1) end as owner_user_id
from public.factories where (workspace_id = pg_temp.slack_id(12) and is_default)
  or (workspace_id = pg_temp.slack_id(11) and slug in ('slack-channels', 'slack-sibling'));

select public.grant_factory_membership(workspace_id, factory_id, owner_user_id, pg_temp.slack_id(22), 'member')
from slack_scope where scope = 'main';

insert into public.pipelines(id,workspace_id,factory_id,name)
select pg_temp.slack_id(31), workspace_id, factory_id, 'Slack fixture pipeline' from slack_scope where scope = 'main';
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name) values
  (pg_temp.slack_id(32), pg_temp.slack_id(31), pg_temp.slack_id(11), 1, 'review', 'Review');
insert into public.sessions(id,workspace_id,factory_id,number,title,prompt_md,creator_member_id,pipeline_id,current_stage_id)
select pg_temp.slack_id(33), workspace_id, factory_id, 1, 'Retain the Slack thread', 'Keep the source after disconnect.',
  pg_temp.slack_id(21), pg_temp.slack_id(31), pg_temp.slack_id(32)
from slack_scope where scope = 'main';

grant select on slack_scope to service_role, authenticated;
set local role service_role;
set local request.jwt.claim.role = 'service_role';

create function pg_temp.start_slack(
  p_digest text, p_generation bigint, p_scope text default 'main', p_actor_user_id uuid default null,
  p_team_id text default 'T67600001', p_purpose text default 'install', p_installation_id uuid default null
) returns boolean language sql as $$
  select public.start_slack_connector_oauth(scope.workspace_id, scope.factory_id,
    coalesce(p_actor_user_id, scope.owner_user_id), p_digest, p_purpose, p_team_id, p_generation, p_installation_id)
  from slack_scope scope where scope.scope = p_scope
$$;

create function pg_temp.configure_slack(
  p_generation bigint, p_scope text default 'main', p_actor_user_id uuid default null,
  p_app_id text default 'A67600001', p_token text default 'v2.AAAAAAAAAAAAAAAA.QQ.AAAAAAAAAAAAAAAAAAAAAA',
  p_scopes text[] default array['groups:read', 'chat:write', 'groups:read']
) returns table(installation_id uuid, generation bigint) language sql as $$
  select configured.* from slack_scope scope
  cross join lateral public.configure_slack_connector_installation(scope.workspace_id, scope.factory_id,
    coalesce(p_actor_user_id, scope.owner_user_id), 'T67600001', 'Slack fixture', p_app_id,
    'U67600001', p_generation, p_token, p_scopes) configured
  where scope.scope = p_scope
$$;

select ok(has_function_privilege('service_role','public.consume_slack_connector_oauth(text,uuid)','execute')
  and not has_function_privilege('authenticated','public.consume_slack_connector_oauth(text,uuid)','execute')
  and not has_function_privilege('anon','public.start_slack_connector_oauth(uuid,uuid,uuid,text,text,text,bigint,uuid)','execute')
  and not has_function_privilege('authenticated','public.read_slack_connector_credential(uuid,uuid,uuid,uuid,bigint)','execute')
  and not has_table_privilege('service_role','internal.slack_connector_credentials','select')
  and not has_table_privilege('service_role','internal.slack_connector_oauth_states','select'),
  'OAuth state and ciphertext stay behind service-only scoped functions');
select throws_ok($$select pg_temp.start_slack('raw-state', 0)$$,
  '22023', null, 'only a state digest is retained');
select throws_ok($$select pg_temp.start_slack(repeat('a',64), 0, p_team_id => '')$$,
  '22023', null, 'OAuth cannot start without a selected Slack team');
select throws_ok($$select pg_temp.start_slack(repeat('a',64), 0, p_actor_user_id => pg_temp.slack_id(2))$$,
  '42501', null, 'an ordinary factory member cannot install Slack');
select throws_ok($$select pg_temp.start_slack(repeat('a',64), 1)$$,
  'PT409', null, 'installation start requires generation zero before a first connection');
select ok(pg_temp.start_slack(repeat('a',64), 0), 'authorized install reserves the exact state');
select throws_ok($$select pg_temp.start_slack(repeat('a',64), 0)$$,
  'PT409', null, 'the same OAuth state cannot be issued twice');
select is((select count(*) from public.consume_slack_connector_oauth(repeat('a',64), pg_temp.slack_id(3))),
  0::bigint, 'another user cannot consume this state');
select ok((select count(*) = 1 and bool_and((state.workspace_id, state.factory_id) = (scope.workspace_id,scope.factory_id)
    and purpose = 'install' and team_id = 'T67600001' and installation_id is null and expected_generation = 0)
  from public.consume_slack_connector_oauth(repeat('a',64), pg_temp.slack_id(1)) state
  cross join slack_scope scope where scope.scope = 'main'), 'the actor consumes its original workspace, factory and Slack team');
select is((select count(*) from public.consume_slack_connector_oauth(repeat('a',64), pg_temp.slack_id(1))),
  0::bigint, 'an already consumed OAuth state cannot be replayed');
select ok(pg_temp.start_slack(repeat('b',64), 0), 'reserve a state for expiration');
select ok(pg_temp.start_slack(repeat('c',64), 0, p_scope => 'outside'), 'reserve an unrelated workspace state for expiration');

reset role;
update internal.slack_connector_oauth_states set expires_at = clock_timestamp() - interval '1 second'
where state_digest in (repeat('b',64), repeat('c',64));
set local role service_role;
select is((select count(*) from public.consume_slack_connector_oauth(repeat('b',64), pg_temp.slack_id(1))),
  0::bigint, 'expired state cannot authorize a callback');
select ok(pg_temp.start_slack(repeat('d',64), 0), 'a new start cleans expired state in its scope');
reset role;
select ok(not exists (select 1 from internal.slack_connector_oauth_states where state_digest = repeat('b',64))
  and exists (select 1 from internal.slack_connector_oauth_states where state_digest = repeat('c',64)),
  'expired cleanup leaves unrelated workspace state untouched');
set local role service_role;

select throws_ok($$select * from pg_temp.configure_slack(0, p_token => 'unencrypted')$$,
  '22023', null, 'plaintext token is rejected');
select throws_ok($$select * from pg_temp.configure_slack(0, p_scopes => array['chat:write', null])$$,
  '22023', null, 'invalid granted scope elements are rejected');
create temp table slack_installation as select * from pg_temp.configure_slack(0);
select is((select generation from slack_installation), 1::bigint, 'an installation starts at generation one');
select throws_ok($$select * from pg_temp.configure_slack(0, p_scope => 'outside')$$,
  'P0002', null, 'another Wallie workspace cannot claim this exact Slack team and app');
select throws_ok($$select * from pg_temp.configure_slack(1, p_app_id => 'A67600002')$$,
  'PT409', null, 'an active installation must be disconnected before app replacement');
select throws_ok($$select pg_temp.start_slack(repeat('e',64), 0)$$,
  'PT409', null, 'reinstall state is tied to the latest connector generation');

select is((select count(*) from slack_scope scope cross join lateral public.read_slack_connector_setup(
  scope.workspace_id, scope.factory_id, pg_temp.slack_id(2)) where scope.scope = 'main'),
  0::bigint, 'an ordinary factory member cannot discover an unmapped Slack installation');
select throws_ok($$select pg_temp.start_slack(repeat('e',64), 1, p_actor_user_id => pg_temp.slack_id(2),
  p_purpose => 'link', p_installation_id => (select installation_id from slack_installation))$$,
  'P0002', null, 'an ordinary factory member cannot start a link before their factory has a mapping');

create function pg_temp.map_slack(
  p_generation bigint, p_revision bigint, p_enabled boolean default true, p_scope text default 'main',
  p_kind public.connector_resource_kind default 'channel', p_channel_id text default 'C67600001'
) returns table(resource_id uuid, revision bigint) language sql as $$
  select mapping.* from slack_scope scope cross join slack_installation installed
  cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id,
    scope.owner_user_id, installed.installation_id, p_generation, p_kind, p_channel_id, p_revision, p_enabled) mapping
  where scope.scope = p_scope
$$;

select throws_ok($$select * from pg_temp.map_slack(1, 0, p_kind => 'repository')$$,
  '22023', null, 'Slack cannot map a non-channel kind');
select throws_ok($$select * from pg_temp.map_slack(1, 0, p_channel_id => 'D67600001')$$,
  '22023', null, 'Slack cannot map a direct message as a channel');
create temp table slack_resource as select * from pg_temp.map_slack(1, 0);
grant select on slack_resource to authenticated;
select is((select revision from slack_resource), 1::bigint, 'the selected Slack channel is mapped once');
select throws_ok($$select * from pg_temp.map_slack(1, 0, p_scope => 'sibling')$$,
  'P0002', null, 'the same Slack channel cannot be claimed by a sibling factory');
select ok((select count(*) = 1 and bool_and(setup.team_id = 'T67600001' and setup.team_name = 'Slack fixture'
    and setup.app_id = 'A67600001' and setup.status = 'connected'
    and setup.granted_scopes = array['chat:write','groups:read'] and setup.actor_link_id is null)
  from slack_scope scope cross join lateral public.read_slack_connector_setup(
    scope.workspace_id, scope.factory_id, pg_temp.slack_id(2)) setup where scope.scope = 'main'),
  'authorized setup shows actual granted scopes and team/app metadata without granting a credential');
select throws_ok($$select * from slack_scope scope cross join lateral public.read_slack_connector_setup(
  scope.workspace_id, scope.factory_id, pg_temp.slack_id(2)) where scope.scope = 'sibling'$$,
  '42501', null, 'a member of the mapped factory cannot read setup via its sibling');
select is((select count(*) from slack_scope scope cross join lateral public.read_slack_connector_setup(
  scope.workspace_id, scope.factory_id, scope.owner_user_id) where scope.scope = 'outside'),
  0::bigint, 'the outside workspace cannot discover a Slack installation');
select throws_ok($$select * from slack_scope scope cross join slack_installation installed
  cross join lateral public.read_slack_connector_credential(
    scope.workspace_id, scope.factory_id, pg_temp.slack_id(2), installed.installation_id, 1)
  where scope.scope = 'main'$$,
  '42501', null, 'ordinary factory members cannot read bot ciphertext');

select throws_ok($$select pg_temp.start_slack(repeat('f',64), 1, p_actor_user_id => pg_temp.slack_id(2),
  p_purpose => 'link', p_installation_id => (select installation_id from slack_installation),
  p_team_id => 'T67600002')$$, 'P0002', null, 'a human link cannot switch the expected Slack team');
select ok(pg_temp.start_slack(repeat('f',64), 1, p_actor_user_id => pg_temp.slack_id(2),
  p_purpose => 'link', p_installation_id => (select installation_id from slack_installation)),
  'an active factory member can initiate their own link with exact installation generation');
select ok((select count(*) = 1 and bool_and(state.installation_id = installed.installation_id
    and purpose = 'link' and team_id = 'T67600001' and expected_generation = 1)
  from public.consume_slack_connector_oauth(repeat('f',64), pg_temp.slack_id(2)) state cross join slack_installation installed),
  'link callback resolves the original Slack team, installation and generation');
create temp table slack_link as
select public.link_connector_actor(scope.workspace_id, scope.factory_id, pg_temp.slack_id(2),
  installed.installation_id, 1, 'slack', 'T67600001', 'U67600002', 'human') as id
from slack_scope scope cross join slack_installation installed where scope.scope = 'main';
select throws_ok($$
  select public.link_connector_actor(scope.workspace_id, scope.factory_id, pg_temp.slack_id(2),
    installed.installation_id, 1, 'slack', 'T67600001', 'U67600003', 'human')
  from slack_scope scope cross join slack_installation installed where scope.scope = 'main'
$$, '23505', null, 'a second Slack identity cannot hide behind the same member’s active link');
select ok((select count(*) = 1 and bool_and(setup.actor_link_id = link.id and setup.actor_user_id = 'U67600002')
  from slack_scope scope cross join slack_link link cross join lateral public.read_slack_connector_setup(
    scope.workspace_id, scope.factory_id, pg_temp.slack_id(2)) setup where scope.scope = 'main'),
  'a member sees their own active provider actor link');
select is((select setup.actor_link_id from slack_scope scope cross join lateral public.read_slack_connector_setup(
  scope.workspace_id, scope.factory_id, scope.owner_user_id) setup where scope.scope = 'main'),
  null::uuid, 'the owner does not receive another human’s provider actor link');
select public.grant_factory_membership(workspace_id, factory_id, owner_user_id, pg_temp.slack_id(22), 'member')
from slack_scope where scope = 'sibling';
select is((select setup.actor_link_id from slack_scope scope cross join lateral public.read_slack_connector_setup(
  scope.workspace_id, scope.factory_id, pg_temp.slack_id(2)) setup where scope.scope = 'sibling'),
  (select id from slack_link), 'a factory member can still find their own link to revoke it even without a mapping here');
select throws_ok($$select pg_temp.start_slack(repeat('e',64), 1, p_scope => 'sibling', p_actor_user_id => pg_temp.slack_id(2),
  p_purpose => 'link', p_installation_id => (select installation_id from slack_installation))$$,
  'P0002', null, 'an existing link cannot authorize a new link from an unmapped factory');

select is((select revision from pg_temp.map_slack(1, 1, false)), 2::bigint,
  'disabling the Slack channel retains its mapping history');
select ok((select public.revoke_connector_actor_link(pg_temp.slack_id(11), pg_temp.slack_id(2), id) from slack_link),
  'the link owner can revoke their own provider identity');
select is((select setup.actor_link_id from slack_scope scope cross join lateral public.read_slack_connector_setup(
  scope.workspace_id, scope.factory_id, pg_temp.slack_id(2)) setup where scope.scope = 'main'),
  null::uuid, 'revoked identity disappears from setup');
select ok((select public.link_connector_actor(scope.workspace_id, scope.factory_id, pg_temp.slack_id(2),
  installed.installation_id, 1, 'slack', 'T67600001', 'U67600003', 'human') is not null
  from slack_scope scope cross join slack_installation installed where scope.scope = 'main'),
  'a different Slack identity can link after the prior human link is revoked');

select is((select revision from pg_temp.map_slack(1, 2)), 3::bigint,
  'the same Slack channel can be enabled on the next mapping revision');

select public.bind_session_conversation_source_once(scope.workspace_id, scope.factory_id, pg_temp.slack_id(33),
  pg_temp.slack_id(21), 'slack', resource.resource_id::text, '1732450000.000001',
  'Slack fixture thread', 'https://app.slack.com/archives/C67600001/p1732450000000001')
from slack_scope scope cross join slack_resource resource where scope.scope = 'main';

create function pg_temp.slack_subscription(p_scope text default 'main')
returns table(credential_kind text, credential_ref uuid, credential_material_revision bigint, installation_generation bigint)
language sql as $$
  select sub.credential_kind, sub.credential_ref, sub.credential_material_revision, sub.installation_generation
  from slack_scope scope cross join slack_resource resource
  cross join lateral public.read_connector_subscription(scope.workspace_id, scope.factory_id, resource.resource_id) sub
  where scope.scope = p_scope
$$;
create temp table first_slack_subscription as select * from pg_temp.slack_subscription();
select ok((select count(*) = 1 and bool_and(credential_kind = 'slack_bot' and credential_ref is not null
    and credential_material_revision is null and installation_generation = 1) from first_slack_subscription),
  'the generic subscription returns a Slack bot credential reference and no material revision');
select is((select count(*) from pg_temp.slack_subscription('sibling')), 0::bigint,
  'generic subscriptions do not expose mapped channels from sibling factories');

create temp table slack_rotation as select * from pg_temp.configure_slack(1,
  p_token => 'v2.BBBBBBBBBBBBBBBB.Qg.BBBBBBBBBBBBBBBBBBBBBB');
select ok((select installed.installation_id = rotated.installation_id and rotated.generation = 2
  from slack_installation installed cross join slack_rotation rotated),
  'rotation keeps the installation ID and advances its generation');
select ok((select live.credential_ref is distinct from original.credential_ref and live.installation_generation = 2
  from pg_temp.slack_subscription() live cross join first_slack_subscription original),
  'rotation fences the prior credential reference');
select is((select count(*) from slack_scope scope cross join slack_installation installed
  cross join lateral public.read_slack_connector_credential(
    scope.workspace_id, scope.factory_id, scope.owner_user_id, installed.installation_id, 1) where scope.scope = 'main'),
  0::bigint, 'stale generation cannot read the rotated bot token');
select is((select credential.encrypted_token from slack_scope scope cross join slack_installation installed
  cross join lateral public.read_slack_connector_credential(
    scope.workspace_id, scope.factory_id, scope.owner_user_id, installed.installation_id, 2) credential where scope.scope = 'main'),
  'v2.BBBBBBBBBBBBBBBB.Qg.BBBBBBBBBBBBBBBBBBBBBB', 'the scoped owner gets the current generation ciphertext only');

select is((select public.disconnect_connector_installation(scope.workspace_id, scope.factory_id, scope.owner_user_id,
  installed.installation_id, 2) from slack_scope scope cross join slack_installation installed where scope.scope = 'main'),
  3::bigint, 'generic disconnect advances and clears Slack authority');
select is((select count(*) from pg_temp.slack_subscription()), 0::bigint,
  'a disconnected channel cannot acquire a connector subscription');
select ok((select count(*) = 1 and bool_and(setup.status = 'disconnected' and setup.team_name = 'Slack fixture'
    and setup.granted_scopes = array['chat:write','groups:read'])
  from slack_scope scope cross join lateral public.read_slack_connector_setup(
    scope.workspace_id, scope.factory_id, scope.owner_user_id) setup where scope.scope = 'main'),
  'disconnect retains safe installation metadata and actual previous scopes');
reset role;
select ok((select credential.encrypted_token is null and credential.credential_id is null
  from internal.slack_connector_credentials credential join slack_installation installed using (installation_id)),
  'disconnect scrubs the private ciphertext and credential reference');
select ok(exists (select 1 from public.session_conversation_sources
  where session_id = pg_temp.slack_id(33) and provider = 'slack' and external_thread_id = '1732450000.000001'),
  'the same retained Slack source thread survives disconnected credentials');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select set_config('request.jwt.claim.sub', pg_temp.slack_id(2)::text, true);
select ok(exists (select 1 from public.session_conversation_sources
  where session_id = pg_temp.slack_id(33) and provider = 'slack'),
  'an authorized factory human can still read the linked source after disconnect');
select set_config('request.jwt.claim.sub', pg_temp.slack_id(3)::text, true);
select is((select count(*) from public.factory_connector_resources resource
  join slack_resource scoped on scoped.resource_id = resource.id), 0::bigint,
  'Slack channel metadata stays behind factory RLS');

reset role;
set local role service_role;
set local request.jwt.claim.role = 'service_role';
create temp table slack_reconnect as select * from pg_temp.configure_slack(3);
select ok((select installed.installation_id = reconnected.installation_id and reconnected.generation = 4
  from slack_installation installed cross join slack_reconnect reconnected),
  'reconnection preserves installation identity and advances the generation');
select ok((select resource.current_revision = 3
  from public.factory_connector_resources resource join slack_resource old on old.resource_id = resource.id),
  'reconnection retains the channel and its current mapping revision');

select * from finish();
rollback;
