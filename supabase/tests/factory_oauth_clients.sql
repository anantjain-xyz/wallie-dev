begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.oauth_id(slot integer) returns uuid language sql immutable as $$
  select ('56800000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
create function pg_temp.default_factory() returns uuid language sql stable as $$
  select id from public.factories where workspace_id = pg_temp.oauth_id(4) and is_default
$$;
insert into auth.users(id, email) values
  (pg_temp.oauth_id(1), 'oauth-fixture-owner@example.test'), (pg_temp.oauth_id(2), 'oauth-fixture-member@example.test');
insert into auth.sessions(id, user_id, created_at, updated_at) values
  (pg_temp.oauth_id(7), pg_temp.oauth_id(1), now(), now()),
  (pg_temp.oauth_id(8), pg_temp.oauth_id(2), now(), now()),
  (pg_temp.oauth_id(9), pg_temp.oauth_id(2), now(), now());
insert into public.workspaces(id, slug, name) values (pg_temp.oauth_id(4), 'oauth-fixture', 'OAuth fixture');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.oauth_id(11), pg_temp.oauth_id(4), pg_temp.oauth_id(1), 'human', 'owner'),
  (pg_temp.oauth_id(12), pg_temp.oauth_id(4), pg_temp.oauth_id(2), 'human', 'member');
insert into public.factories(id, workspace_id, name, slug, is_default) values
  (pg_temp.oauth_id(13), pg_temp.oauth_id(4), 'Sibling', 'sibling', false);
select public.grant_factory_membership(pg_temp.oauth_id(4), pg_temp.oauth_id(13), pg_temp.oauth_id(1), pg_temp.oauth_id(12), 'member');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id,
  target_type, target_name, permissions) values
  (pg_temp.oauth_id(21), pg_temp.oauth_id(4), 56800001, 'https://github.test/installations/56800001', 56800,
    'Organization', 'oauth-fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name,
  full_name, private, html_url, default_branch) values
  (pg_temp.oauth_id(22), pg_temp.oauth_id(4), pg_temp.default_factory(), pg_temp.oauth_id(21),
    568001, 'primary', 'fixture/primary', true, 'https://github.test/fixture/primary', 'main'),
  (pg_temp.oauth_id(23), pg_temp.oauth_id(4), pg_temp.oauth_id(13), pg_temp.oauth_id(21),
    568002, 'sibling', 'fixture/sibling', true, 'https://github.test/fixture/sibling', 'main');
select public.save_execution_policy(pg_temp.oauth_id(4), pg_temp.oauth_id(1), 0,
  '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":30000,"maxTotalTokens":1000,"maxCostUsd":1}');
select public.create_service_principal(pg_temp.oauth_id(4), pg_temp.default_factory(), pg_temp.oauth_id(1), 'Primary client', 'primary-client');
select public.create_service_principal(pg_temp.oauth_id(4), pg_temp.oauth_id(13), pg_temp.oauth_id(1), 'Sibling client', 'sibling-client');
create temp table oauth_execution_grants as select approved.*
from public.service_principals principal
join public.github_repositories repository on (repository.workspace_id, repository.factory_id) = (principal.workspace_id, principal.factory_id)
join public.execution_policies policy on policy.workspace_id = principal.workspace_id
cross join lateral public.approve_factory_execution_grant(
  pg_temp.oauth_id(4), principal.factory_id, pg_temp.oauth_id(1), principal.id, repository.id, '{}', '{}',
  policy.current_revision_id, pg_temp.oauth_id(11), clock_timestamp() + interval '1 hour', 0, null,
  case when principal.factory_id = pg_temp.default_factory() then '{sessions:read}'::public.factory_command_scope[]
    else '{sessions:cancel}'::public.factory_command_scope[] end
) approved
where principal.workspace_id = pg_temp.oauth_id(4);
create function pg_temp.register_oauth(
  redirects text[] default array['http://127.0.0.1:8123/callback'], actor_slot integer default 1,
  scopes public.factory_command_scope[] default '{sessions:read,sessions:cancel}'
) returns public.factory_oauth_clients language sql as $$
  select public.register_factory_oauth_client(pg_temp.oauth_id(4), pg_temp.oauth_id(actor_slot),
    'Qualified client', redirects, scopes, (select jsonb_agg(jsonb_build_object(
      'factory_id', factory_id, 'execution_grant_id', id, 'execution_grant_version', version)) from oauth_execution_grants))
$$;

select throws_ok($q$select pg_temp.register_oauth(array['https://trusted.example@evil.test/callback'])$q$,
  '22023', null, 'registration rejects redirects that contain credentials');
select throws_ok($q$select pg_temp.register_oauth(array['https://example.test/callback#fragment'])$q$,
  '22023', null, 'registration rejects redirects with fragments');
select throws_ok($q$select pg_temp.register_oauth(array['https://example.test/callback?state=ignored'])$q$,
  '22023', null, 'registration rejects reserved response query keys');
select throws_ok($q$select pg_temp.register_oauth(array['https://example.test/callback?filter=one?two&code=ignored'])$q$,
  '22023', null, 'a question mark in a query value cannot hide a reserved response key');
select throws_ok($q$select pg_temp.register_oauth(array['https://example.test/callback?st%61te=ignored'])$q$,
  '22023', null, 'registration rejects percent-encoded response keys recognized by the browser');
select ok(internal.valid_factory_oauth_redirect('https://example.test/callback?f%69lter=state?code%3Dtext'),
  'unrelated query keys and values retain exact spelling');
select throws_ok($q$select pg_temp.register_oauth(array['http://not-local.example:8123/callback'])$q$,
  '22023', null, 'plaintext redirects require an exact numeric loopback address');
select throws_ok($q$select pg_temp.register_oauth(actor_slot => 2)$q$,
  '42501', 'Workspace manager required.', 'an ordinary member cannot register delegated factory authority');
select throws_ok($q$select pg_temp.register_oauth(scopes => '{sessions:read,sessions:cancel,sessions:create}')$q$,
  '42501', 'Registered commands must be covered by approved factory grants.', 'registered scopes cannot exceed approved execution grants');
create temp table oauth_client as select (pg_temp.register_oauth()).*;
select is((select count(distinct service_principal_id) from public.factory_oauth_client_bindings
  where client_id = (select id from oauth_client)), 2::bigint, 'each factory uses its own approved principal');
select ok(not has_table_privilege('authenticated', 'internal.factory_oauth_authorizations', 'select')
  and not has_table_privilege('service_role', 'internal.factory_oauth_token_pairs', 'select'),
  'interactive and edge database roles cannot directly read credential digests');

create function pg_temp.begin_oauth(
  p_redirect text default 'http://127.0.0.1:8123/callback', p_browser_slot integer default 8,
  p_challenge text default repeat('a',42) || 'A', p_resource text default null
) returns table(authorization_id uuid, client_name text, workspace_id uuid, workspace_name text,
  scopes public.factory_command_scope[], factories jsonb, expires_at timestamptz) language sql as $$
  select * from public.begin_factory_oauth_authorization((select id from oauth_client), pg_temp.oauth_id(2),
    pg_temp.oauth_id(p_browser_slot), p_redirect, p_challenge, '{sessions:read,sessions:cancel}', 'round-trip-state', p_resource);
$$;
select throws_ok($q$select * from pg_temp.begin_oauth('http://127.0.0.1:8124/callback')$q$,
  '42501', null, 'an unregistered redirect change is denied before consent');
select throws_ok($q$select * from pg_temp.begin_oauth(p_browser_slot => 7)$q$,
  '42501', 'Browser session is unavailable.', 'a browser session must belong to the consenting actor');
select throws_ok($q$select * from pg_temp.begin_oauth(p_challenge => 'plain')$q$,
  '22023', null, 'a non-S256-sized challenge is rejected');
create temp table oauth_consent as select * from pg_temp.begin_oauth();
select ok((select jsonb_array_length(factories) = 2 and workspace_name = 'OAuth fixture' from oauth_consent),
  'consent displays the workspace and both currently authorized factories');
select ok((select factories @> jsonb_build_array(
  jsonb_build_object('factory_id', pg_temp.default_factory(), 'scopes', jsonb_build_array('sessions:read')),
  jsonb_build_object('factory_id', pg_temp.oauth_id(13), 'scopes', jsonb_build_array('sessions:cancel')))
  from oauth_consent), 'consent offers each factory’s exact intersection of requested and approved scopes');

create function pg_temp.accept_oauth(p_browser_slot integer default 8, p_factories uuid[] default null,
  p_code_slot integer default 30, p_authorization_id uuid default null)
returns table(redirect_uri text, state text, approved boolean) language sql as $$
  select * from public.decide_factory_oauth_authorization(coalesce(p_authorization_id, (select authorization_id from oauth_consent)),
    pg_temp.oauth_id(2), pg_temp.oauth_id(p_browser_slot), true,
    coalesce(p_factories, array[pg_temp.default_factory(),pg_temp.oauth_id(13)]), pg_temp.oauth_id(p_code_slot), repeat('c', 64));
$$;
create temp table mcp_oauth_consent as select * from pg_temp.begin_oauth(p_resource=>
  format('https://wallie.example.test/api/v1/workspaces/%s/factories/%s/mcp',pg_temp.oauth_id(4),pg_temp.oauth_id(13)));
select ok((select jsonb_array_length(factories)=1 and factories @> jsonb_build_array(
  jsonb_build_object('factory_id',pg_temp.oauth_id(13),'scopes',jsonb_build_array('sessions:cancel')))
  from mcp_oauth_consent),'MCP offers only the scopes of its resource even when the client covers two factories');
select throws_ok($q$select * from pg_temp.accept_oauth(p_factories=>array[pg_temp.default_factory()],
  p_authorization_id=>(select authorization_id from mcp_oauth_consent))$q$,'22023',null,
  'MCP consent cannot replace its resource with another factory registered to the same client');
select throws_ok($q$select * from pg_temp.accept_oauth(9)$q$, '42501', null, 'consent is bound to its initiating browser login');
select throws_ok($q$select * from pg_temp.accept_oauth(p_factories => array[pg_temp.oauth_id(99)])$q$,
  '22023', null, 'consent cannot add a factory outside the offered set');
select results_eq('select * from pg_temp.accept_oauth()',
  $v$values ('http://127.0.0.1:8123/callback'::text, 'round-trip-state'::text, true)$v$,
  'approved consent returns the exact registered redirect and bound state');
select throws_ok('select * from pg_temp.accept_oauth()', '42501', null, 'a consent transaction can issue only one authorization code');
select is((select count(*) from public.factory_oauth_grants where client_id = (select id from oauth_client)),
  0::bigint, 'consent alone has no usable grant');
create temp table denied_oauth_consent as select * from pg_temp.begin_oauth();
select results_eq($q$select * from public.decide_factory_oauth_authorization(
  (select authorization_id from denied_oauth_consent), pg_temp.oauth_id(2), pg_temp.oauth_id(8), false)$q$,
  $v$values ('http://127.0.0.1:8123/callback'::text, 'round-trip-state'::text, false)$v$,
  'denied consent returns the bound redirect and state without issuing a code');
select throws_ok($q$select * from pg_temp.accept_oauth(p_authorization_id => (select authorization_id from denied_oauth_consent))$q$,
  '42501', null, 'a previously denied request cannot later be approved');

create function pg_temp.exchange_oauth(
  p_slot integer default 31, p_code integer default 30, p_challenge text default repeat('a',42) || 'A',
  p_redirect text default 'http://127.0.0.1:8123/callback'
) returns table(status text, expires_in integer, scopes public.factory_command_scope[]) language sql as $$
  select * from public.exchange_factory_oauth_code((select id from oauth_client), p_redirect, pg_temp.oauth_id(p_code),
    repeat('c',64), p_challenge, pg_temp.oauth_id(p_slot), repeat('a',64), pg_temp.oauth_id(p_slot + 1), repeat('b',64));
$$;
select is((select status from pg_temp.exchange_oauth(p_challenge => repeat('d',43))), 'invalid_grant',
  'incorrect PKCE verifier cannot redeem a known code');
select is((select status from pg_temp.exchange_oauth(p_redirect => 'http://127.0.0.1:8123/callback/')), 'invalid_grant',
  'code exchange requires the exact originally consented redirect rather than a similar target');
create temp table expired_oauth_consent as select * from pg_temp.begin_oauth();
select * from pg_temp.accept_oauth(p_code_slot => 28, p_authorization_id => (select authorization_id from expired_oauth_consent));
update internal.factory_oauth_authorizations set code_expires_at = clock_timestamp() - interval '1 second'
where code_id = pg_temp.oauth_id(28);
select is((select status from pg_temp.exchange_oauth(26, 28)), 'invalid_grant', 'an expired authorization code grants nothing');
select is((select status from pg_temp.exchange_oauth()), 'issued', 'the exact code and S256 proof yield one grant');
select is((select status from pg_temp.exchange_oauth(41)), 'invalid_grant', 'an exchanged authorization code cannot mint another grant');
create temp table oauth_grant as select * from public.factory_oauth_grants where client_id = (select id from oauth_client);
select is((select count(*) from oauth_grant), 1::bigint, 'exactly one grant commits for one code');
select is((select count(distinct service_principal_id) from public.factory_oauth_grant_bindings where grant_id = (select id from oauth_grant)),
  2::bigint, 'the grant preserves each factory’s exact principal');
select results_eq($q$select scopes from public.factory_oauth_grant_bindings
  where grant_id = (select id from oauth_grant) order by scopes$q$,
  $v$values ('{sessions:read}'::public.factory_command_scope[]), ('{sessions:cancel}'::public.factory_command_scope[])$v$,
  'the grant durably pins the approved command scopes of both factories');

create function pg_temp.use_oauth(p_slot integer, p_scope public.factory_command_scope default 'sessions:read',
  p_factory uuid default pg_temp.default_factory()) returns boolean language sql as $$
  select exists (select 1 from public.authorize_factory_oauth_access_token(pg_temp.oauth_id(4), p_factory,
    pg_temp.oauth_id(p_slot), repeat('a',64), p_scope));
$$;
select ok(pg_temp.use_oauth(31) and pg_temp.use_oauth(31, 'sessions:cancel', pg_temp.oauth_id(13)),
  'one grant authorizes the approved command in each selected factory');
select results_eq($q$select * from public.inspect_factory_mcp_identity(pg_temp.oauth_id(4),pg_temp.default_factory(),
  'oauth_access_token',pg_temp.oauth_id(31),repeat('a',64),
  format('https://wallie.example.test/api/v1/workspaces/%s/factories/%s/mcp',pg_temp.oauth_id(4),pg_temp.default_factory()))$q$,
  $q$values ('unauthorized'::text,'{}'::public.factory_command_scope[])$q$,
  'an existing API OAuth token is valid for its API audience and cannot discover MCP tools');
select throws_ok($q$select pg_temp.use_oauth(31, 'sessions:cancel')$q$,
  '42501', null, 'the cancel scope of a sibling factory does not extend the read-only factory');
select throws_ok($q$select pg_temp.use_oauth(31, 'sessions:read', pg_temp.oauth_id(13))$q$,
  '42501', null, 'the read scope of the default factory does not extend the cancel-only factory');
select throws_ok($q$select pg_temp.use_oauth(31, 'sessions:create')$q$,
  '42501', null, 'an access token cannot invoke a command outside consent');

create function pg_temp.rotate_oauth(p_refresh integer, p_next integer, p_scopes public.factory_command_scope[] default null,
  p_digest text default repeat('b',64), p_client uuid default null)
returns table(status text, expires_in integer, scopes public.factory_command_scope[]) language sql as $$
  select * from public.rotate_factory_oauth_refresh_token(coalesce(p_client, (select id from oauth_client)), pg_temp.oauth_id(p_refresh),
    p_digest, pg_temp.oauth_id(p_next), repeat('a',64), pg_temp.oauth_id(p_next + 1), repeat('b',64), p_scopes);
$$;
select is((select status from pg_temp.rotate_oauth(32, 41, '{sessions:create}')), 'invalid_scope', 'refresh cannot broaden original consent');
select is((select scopes from pg_temp.rotate_oauth(32, 41, '{sessions:read}')), '{sessions:read}'::public.factory_command_scope[],
  'refresh may narrow access scopes and rotates access and refresh credentials');
create temp table expired_pending_oauth as select * from pg_temp.begin_oauth();
update internal.factory_oauth_authorizations set expires_at = clock_timestamp() - interval '1 second'
where id = (select authorization_id from expired_pending_oauth);
update internal.factory_oauth_authorizations set code_expires_at = clock_timestamp() - interval '1 second'
where code_id = pg_temp.oauth_id(30);
select results_eq('select * from public.prune_factory_oauth_credentials(1)', 'values (1, 0)',
  'the pruner bounds its authorization batch and leaves all credentials in a live family');
select results_eq('select * from public.prune_factory_oauth_credentials(200)', 'values (2, 0)',
  'the pruner removes expired pending, unredeemed and consumed code rows');
select ok(not has_function_privilege('authenticated', 'public.prune_factory_oauth_credentials(integer)', 'execute')
  and has_function_privilege('service_role', 'public.prune_factory_oauth_credentials(integer)', 'execute'),
  'credential pruning is service-only');
select is((select count(*) from internal.factory_oauth_token_pairs where grant_id = (select id from oauth_grant)),
  2::bigint, 'both the active and spent credential pairs remain available for live-family replay checks');
select throws_ok($q$select pg_temp.use_oauth(31)$q$, '42501', null, 'old access credential is invalidated by rotation');
select throws_ok($q$select pg_temp.use_oauth(41, 'sessions:cancel')$q$, '42501', null, 'the replacement access token respects narrowed scopes');
select is((select status from pg_temp.rotate_oauth(32, 51, p_digest => repeat('e',64))), 'invalid_grant',
  'a guessed digest cannot trigger token reuse protection');
select is((select status from pg_temp.rotate_oauth(32, 51, p_client => pg_temp.oauth_id(99))), 'invalid_grant',
  'the prior refresh secret cannot revoke another client registration');
select ok(pg_temp.use_oauth(41), 'a failed stale credential guess leaves the family live');
select is((select status from pg_temp.rotate_oauth(32, 51)), 'invalid_grant', 'verified refresh reuse rejects and revokes the entire family');
select is((select revocation_reason from public.factory_oauth_grants where id = (select id from oauth_grant)),
  'refresh_reuse', 'a structured refresh-reuse error commits the family revocation');
select throws_ok($q$select pg_temp.use_oauth(41)$q$, '42501', null, 'verified replay also invalidates the latest access token');
select is((select status from pg_temp.rotate_oauth(42, 51)), 'invalid_grant', 'verified replay also invalidates the latest refresh token');
select is((select count(*) from public.factory_audit_events where action = 'oauth_grant.revoked'
  and detail->>'oauthGrantId' = (select id::text from oauth_grant) and detail->>'reason' = 'refresh_reuse'),
  2::bigint, 'a replay writes one revocation audit event per affected factory');
select results_eq('select * from public.prune_factory_oauth_credentials(1)', 'values (0, 1)',
  'the pruner bounds the token-pair batch for revoked families');
select results_eq('select * from public.prune_factory_oauth_credentials(200)', 'values (0, 1)',
  'the remaining revoked-family credential is pruned without its grant history');
select is((select revocation_reason from public.factory_oauth_grants where id = (select id from oauth_grant)),
  'refresh_reuse', 'cleanup retains the revoked family’s audit metadata');

create temp table disconnected_consent as select * from pg_temp.begin_oauth();
select * from pg_temp.accept_oauth(p_code_slot => 60, p_factories => array[pg_temp.default_factory()],
  p_authorization_id => (select authorization_id from disconnected_consent));
select results_eq('select status, scopes from pg_temp.exchange_oauth(61, 60)',
  $v$values ('issued'::text, '{sessions:read}'::public.factory_command_scope[])$v$,
  'consenting only to the read-only factory downscopes the issued token to its offered union');
select is((select status from pg_temp.rotate_oauth(62, 63, '{sessions:cancel}')), 'invalid_scope',
  'refresh cannot restore a registered scope that consent excluded');
select public.revoke_factory_oauth_grant(pg_temp.oauth_id(4), pg_temp.oauth_id(2),
  (select grant_id from internal.factory_oauth_token_pairs where access_token_id = pg_temp.oauth_id(61)));
select throws_ok($q$select pg_temp.use_oauth(61)$q$, '42501', null, 'consenting actor can disconnect an existing grant');
select ok(exists (select 1 from auth.sessions where id = pg_temp.oauth_id(8)), 'disconnecting leaves browser sessions usable');

create temp table removed_consent as select * from pg_temp.begin_oauth();
select * from pg_temp.accept_oauth(p_code_slot => 70, p_authorization_id => (select authorization_id from removed_consent));
select is((select status from pg_temp.exchange_oauth(71, 70)), 'issued', 'valid prior membership authorizes the initial factory grant');
select public.revoke_factory_membership(pg_temp.oauth_id(4), pg_temp.oauth_id(13), pg_temp.oauth_id(1), pg_temp.oauth_id(12));
select throws_ok($q$select pg_temp.use_oauth(71, 'sessions:cancel', pg_temp.oauth_id(13))$q$,
  '42501', null, 'removed factory access immediately fences access credentials');
select is((select status from pg_temp.rotate_oauth(72, 81)), 'invalid_grant', 'refresh cannot restore a removed factory');
create temp table already_expired_consent as select * from pg_temp.begin_oauth();
select * from pg_temp.accept_oauth(p_code_slot => 82, p_factories => array[pg_temp.default_factory()],
  p_authorization_id => (select authorization_id from already_expired_consent));
select is((select status from pg_temp.exchange_oauth(83, 82)), 'issued', 'an additional live family can be independently consented');
create temp table expired_family as select grant_id from internal.factory_oauth_token_pairs where access_token_id = pg_temp.oauth_id(83);
update public.factory_oauth_grants set created_at = clock_timestamp() - interval '1 hour',
  expires_at = clock_timestamp() - interval '1 second' where id = (select grant_id from expired_family);
select results_eq('select * from public.prune_factory_oauth_credentials(200)', 'values (0, 2)',
  'cleanup prunes expired and disconnected pairs without deleting a live unrelated pair');
select ok(exists (select 1 from public.factory_oauth_grants where id = (select grant_id from expired_family))
  and exists (select 1 from internal.factory_oauth_token_pairs where access_token_id = pg_temp.oauth_id(71)),
  'cleanup preserves expired grant history and unrelated active credentials');
select public.revoke_factory_oauth_client(pg_temp.oauth_id(4), pg_temp.oauth_id(1), (select id from oauth_client));
select throws_ok($q$select pg_temp.use_oauth(71)$q$, '42501', null, 'revoking a registered client invalidates all of its grants');
select throws_ok($q$select * from pg_temp.begin_oauth()$q$, '42501', null, 'revoking a registration stops new authorization');

-- Commit a fresh consent so both token endpoints can be exercised by separate
-- authenticated connections holding real overlapping transactions.
truncate oauth_client;
insert into oauth_client select (pg_temp.register_oauth()).*;
create temp table concurrent_oauth_consent as select * from pg_temp.begin_oauth();
select * from pg_temp.accept_oauth(p_code_slot => 90, p_factories => array[pg_temp.default_factory()],
  p_authorization_id => (select authorization_id from concurrent_oauth_consent));
commit;
begin;

select extensions.dblink_connect('oauth_first', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('oauth_second', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('oauth_second', 'set application_name = ''oauth_contender''; set statement_timeout = ''15s''');
create function pg_temp.wait_for_oauth_lock() returns boolean language plpgsql as $$
declare deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists(select 1 from pg_stat_activity where application_name = 'oauth_contender' and wait_event_type = 'Lock') then
      return true;
    end if;
    if clock_timestamp() >= deadline then return false; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;
create temp table oauth_race_calls as select
  format($q$select status from public.exchange_factory_oauth_code(%L, 'http://127.0.0.1:8123/callback', %L,
    repeat('c',64), repeat('a',42) || 'A', %L, repeat('a',64), %L, repeat('b',64))$q$,
    id, pg_temp.oauth_id(90), pg_temp.oauth_id(91), pg_temp.oauth_id(92)) as exchange,
  format($q$select status from public.rotate_factory_oauth_refresh_token(%L, %L, repeat('b',64),
    %L, repeat('a',64), %L, repeat('b',64))$q$,
    id, pg_temp.oauth_id(92), pg_temp.oauth_id(101), pg_temp.oauth_id(102)) as rotate
from oauth_client;

select extensions.dblink_exec('oauth_first', 'begin');
select is((select status from extensions.dblink('oauth_first', (select exchange from oauth_race_calls)) result(status text)),
  'issued', 'first code exchange claims a grant before its transaction commits');
select extensions.dblink_send_query('oauth_second', (select exchange from oauth_race_calls));
select ok(pg_temp.wait_for_oauth_lock(), 'concurrent exchange waits for the authorization-code owner');
select extensions.dblink_exec('oauth_first', 'commit');
select is((select status from extensions.dblink_get_result('oauth_second') result(status text)),
  'invalid_grant', 'concurrent code retry cannot mint a competing grant');
select count(*) from extensions.dblink_get_result('oauth_second') result(status text);
select is((select count(*) from public.factory_oauth_grants where client_id = (select id from oauth_client)),
  1::bigint, 'only one issued grant exists after the overlapping exchange');

select extensions.dblink_exec('oauth_first', 'begin');
select is((select status from extensions.dblink('oauth_first', (select rotate from oauth_race_calls)) result(status text)),
  'issued', 'first refresh claims the replacement credential before its transaction commits');
select extensions.dblink_send_query('oauth_second', (select rotate from oauth_race_calls));
select ok(pg_temp.wait_for_oauth_lock(), 'overlapping refresh is serialized by its token family');
select extensions.dblink_exec('oauth_first', 'commit');
select is((select status from extensions.dblink_get_result('oauth_second') result(status text)),
  'invalid_grant', 'the competing request detects verified secret reuse');
select count(*) from extensions.dblink_get_result('oauth_second') result(status text);
select is((select revocation_reason from public.factory_oauth_grants where client_id = (select id from oauth_client)),
  'refresh_reuse', 'concurrent replay commits the family-wide revocation');
select throws_ok($q$select pg_temp.use_oauth(101)$q$, '42501', null, 'replayed concurrent rotation cannot leave usable replacement authority');
select extensions.dblink_disconnect('oauth_second');
select extensions.dblink_disconnect('oauth_first');
delete from public.workspaces where id = pg_temp.oauth_id(4);
delete from auth.users where id in (pg_temp.oauth_id(1), pg_temp.oauth_id(2));
select * from finish();
commit;
