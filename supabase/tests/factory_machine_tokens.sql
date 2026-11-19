begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.fixture_id(slot integer) returns uuid language sql immutable as $$
  select ('56700000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
create function pg_temp.factory_id() returns uuid language sql stable as $$
  select id from public.factories where workspace_id = pg_temp.fixture_id(4) and is_default
$$;
insert into auth.users(id, email) values
  (pg_temp.fixture_id(1), 'machine-token-owner@example.test'),
  (pg_temp.fixture_id(2), 'machine-token-user@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.fixture_id(4), 'machine-token-fixture', 'Machine tokens'),
  (pg_temp.fixture_id(5), 'machine-token-neighbor', 'Machine token neighbor');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.fixture_id(11), pg_temp.fixture_id(4), pg_temp.fixture_id(1), 'human', 'owner'),
  (pg_temp.fixture_id(12), pg_temp.fixture_id(4), pg_temp.fixture_id(2), 'human', 'member');
insert into public.factories(id, workspace_id, name, slug, is_default) values
  (pg_temp.fixture_id(13), pg_temp.fixture_id(4), 'Sibling', 'sibling', false);
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id,
  target_type, target_name, permissions) values
  (pg_temp.fixture_id(21), pg_temp.fixture_id(4), 56700001, 'https://github.test/installations/56700001', 56700,
    'Organization', 'fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name,
  full_name, private, html_url, default_branch) values
  (pg_temp.fixture_id(22), pg_temp.fixture_id(4), pg_temp.factory_id(), pg_temp.fixture_id(21),
    567001, 'writer', 'fixture/writer', true, 'https://github.test/fixture/writer', 'main');

select public.save_execution_policy(pg_temp.fixture_id(4), pg_temp.fixture_id(1), 0,
  '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":30000,"maxTotalTokens":1000,"maxCostUsd":1}');
select public.create_service_principal(pg_temp.fixture_id(4), pg_temp.factory_id(), pg_temp.fixture_id(1),
  'Integration runner', 'integration-runner');

create function pg_temp.approve(
  scopes public.factory_command_scope[] default '{}', grant_id uuid default null, version bigint default 0
) returns public.factory_execution_grants language sql as $$
  select public.approve_factory_execution_grant(
    pg_temp.fixture_id(4), pg_temp.factory_id(), pg_temp.fixture_id(1),
    (select id from public.service_principals where workspace_id = pg_temp.fixture_id(4)),
    pg_temp.fixture_id(22), '{}', '{}',
    (select current_revision_id from public.execution_policies where workspace_id = pg_temp.fixture_id(4)),
    pg_temp.fixture_id(11), clock_timestamp() + interval '1 hour', version, grant_id, scopes);
$$;
create temp table approved on commit preserve rows as
select * from pg_temp.approve(array['sessions:read', 'sessions:cancel']::public.factory_command_scope[]);
create function pg_temp.issue(
  slot integer, actor_slot integer default 1, grant_id uuid default null,
  scopes public.factory_command_scope[] default '{sessions:read}', expiry timestamptz default null,
  factory_id uuid default pg_temp.factory_id()
) returns public.factory_machine_tokens language sql as $$
  select public.issue_factory_machine_token(pg_temp.fixture_id(4), factory_id, pg_temp.fixture_id(actor_slot),
    coalesce(grant_id, (select id from approved)), 1, pg_temp.fixture_id(slot), repeat('a', 64), 'Fixture credential', scopes, expiry)
$$;
create function pg_temp.use_token(
  slot integer, scope public.factory_command_scope default 'sessions:read', digest text default repeat('a', 64),
  factory_id uuid default pg_temp.factory_id(), workspace_id uuid default pg_temp.fixture_id(4)
) returns public.factory_machine_tokens language sql as $$
  select internal.require_factory_machine_token(workspace_id, factory_id, pg_temp.fixture_id(slot), digest, scope)
$$;

-- Leave one token visible to the two independent transactions below.
select pg_temp.issue(31);
commit;

begin;
set local request.jwt.claim.role = 'service_role';

create temp table legacy_grant on commit drop as select * from pg_temp.approve();
select is((select command_scopes from legacy_grant), '{}'::public.factory_command_scope[],
  'existing approval calls grant no machine commands by default');
select throws_ok($sql$select pg_temp.issue(32, grant_id => (select id from legacy_grant))$sql$,
  '42501', 'Execution grant does not authorize these command scopes.',
  'an unscoped approval cannot issue even a read-only token');
select throws_ok($sql$select pg_temp.issue(32, actor_slot => 2)$sql$,
  '42501', 'Factory manager access is required.', 'ordinary members cannot issue tokens');
select throws_ok($sql$select pg_temp.issue(32, factory_id => pg_temp.fixture_id(13))$sql$,
  '42501', 'Execution grant is unavailable.', 'a grant cannot issue credentials in a sibling factory');
select throws_ok(
  $sql$select pg_temp.issue(32, scopes => '{sessions:read,sessions:create}')$sql$,
  '42501', 'Execution grant does not authorize these command scopes.',
  'every issued scope must be a subset of the human approval');
select throws_ok($sql$select pg_temp.issue(32, expiry => clock_timestamp() + interval '2 hours')$sql$,
  '22023', 'Provide a valid name, command scopes and optional expiry within the grant.',
  'a token cannot request a later expiry than its execution grant');
select ok(not has_function_privilege('authenticated',
  'public.issue_factory_machine_token(uuid,uuid,uuid,uuid,bigint,uuid,text,text,public.factory_command_scope[],timestamptz)',
  'execute'), 'a browser cannot invoke issuance with an arbitrary manager user ID');
select ok(not has_table_privilege('authenticated', 'internal.factory_machine_token_digests', 'select'),
  'the browser database role cannot read secret hashes');
select ok(not has_table_privilege('service_role', 'internal.factory_machine_token_digests', 'select'),
  'the service role has no direct hash read permission');
select ok(not exists (select 1 from unnest(enum_range(null::public.factory_command_scope)) scope
  where scope::text like '%review%' or scope::text like '%approve%'),
  'machine command scopes do not include human review');

select throws_ok($sql$select pg_temp.use_token(31, digest => repeat('b', 64))$sql$,
  '42501', 'Machine token is unavailable or does not authorize this command.', 'the public identifier is insufficient');
select throws_ok($sql$select pg_temp.use_token(31, 'sessions:cancel')$sql$,
  '42501', 'Machine token is unavailable or does not authorize this command.', 'a token can narrow its current grant');
select throws_ok($sql$select pg_temp.use_token(31, factory_id => pg_temp.fixture_id(13))$sql$,
  '42501', 'Machine token is unavailable or does not authorize this command.', 'a token cannot cross factory boundaries');
select throws_ok($sql$select pg_temp.use_token(31, workspace_id => pg_temp.fixture_id(5),
  factory_id => (select id from public.factories where workspace_id = pg_temp.fixture_id(5)))$sql$,
  '42501', 'Machine token is unavailable or does not authorize this command.', 'a token cannot cross workspace boundaries');
select is((select last_used_at from public.factory_machine_tokens where id = pg_temp.fixture_id(31)),
  null::timestamptz, 'denied requests do not change last-use audit data');
select ok((select authorized.last_used_at >= authorized.created_at
    and authorized.last_used_scope = 'sessions:read'
    and authorized.service_principal_id = approved.service_principal_id
  from pg_temp.use_token(31) authorized cross join approved),
  'an authorized command records its scope, timestamp and exact principal');
select ok(not (to_jsonb(pg_temp.use_token(31)) ? 'digest'), 'authorization returns metadata without hashes');

savepoint expired;
select pg_temp.issue(33, expiry => clock_timestamp() + interval '15 minutes');
update public.factory_machine_tokens set created_at = clock_timestamp() - interval '2 hours',
  expires_at = clock_timestamp() - interval '1 hour' where id = pg_temp.fixture_id(33);
select throws_ok($sql$select pg_temp.use_token(33)$sql$,
  '42501', 'Machine token is unavailable or does not authorize this command.', 'token expiry denies use');
update public.factory_execution_grants set approved_at = clock_timestamp() - interval '2 hours',
  expires_at = clock_timestamp() - interval '1 hour' where id = (select id from approved);
select throws_ok($sql$select pg_temp.use_token(31)$sql$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'grant expiry denies use even without a token expiry');
rollback to savepoint expired;

savepoint superseded;
select pg_temp.approve('{}', (select id from approved), 1);
select pg_temp.approve('{sessions:read}', (select id from approved), 2);
select throws_ok($sql$select pg_temp.use_token(31)$sql$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  're-approving the same scope at a new grant version cannot revive an old token');
rollback to savepoint superseded;

savepoint revoked;
select public.revoke_factory_execution_grant(pg_temp.fixture_id(4), pg_temp.factory_id(),
  pg_temp.fixture_id(1), (select id from approved), 1);
select throws_ok($sql$select pg_temp.use_token(31)$sql$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'revoking the approved grant immediately denies its tokens');
rollback to savepoint revoked;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '56700000-0000-4000-8000-000000000002';
select is((select count(*) from public.factory_machine_tokens), 0::bigint,
  'ordinary members cannot list machine tokens');
set local request.jwt.claim.sub = '56700000-0000-4000-8000-000000000001';
select ok((select not (to_jsonb(token) ? 'digest') from public.factory_machine_tokens token
  where id = '56700000-0000-4000-8000-000000000031'), 'manager listing returns metadata without hashes');
reset role;
commit;

-- Hold an uncommitted revocation while a protected command reaches the lock.
-- The losing command must observe revocation and never execute its read.
select extensions.dblink_connect('machine_revoker', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('machine_command', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('machine_revoker', 'begin; set statement_timeout = ''15s''');
select extensions.dblink_exec('machine_command', 'set application_name = ''op567_protected_command''; set statement_timeout = ''15s''');
select ok((select decision.revoked_at is not null from extensions.dblink('machine_revoker', $sql$
  select (public.revoke_factory_machine_token(workspace_id, factory_id,
    '56700000-0000-4000-8000-000000000001', execution_grant_id, id)).revoked_at
  from public.factory_machine_tokens where id = '56700000-0000-4000-8000-000000000031'
$sql$) as decision(revoked_at timestamptz)), 'revocation holds the authority lock before commit');

select is(extensions.dblink_send_query('machine_command', $sql$
  select (internal.require_factory_machine_token(workspace_id, factory_id, id, repeat('a', 64), 'sessions:read')).id
  from public.factory_machine_tokens where id = '56700000-0000-4000-8000-000000000031'
$sql$), 1, 'start a competing protected command while revocation is pending');
do $$
declare deadline timestamptz := clock_timestamp() + interval '8 seconds';
begin
  while not exists (select 1 from pg_catalog.pg_stat_activity
    where application_name = 'op567_protected_command' and wait_event_type = 'Lock') loop
    if clock_timestamp() > deadline then raise exception 'Protected command did not wait on revocation'; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;
select extensions.dblink_exec('machine_revoker', 'commit');
select is((select count(*) from extensions.dblink_get_result('machine_command', false) as result(id uuid)), 0::bigint,
  'no authorization result can escape after the competing revocation wins');
select ok(extensions.dblink_error_message('machine_command') like '%Machine token is unavailable%',
  'the waiting command sees a stable token denial');
select extensions.dblink_disconnect('machine_revoker');
select extensions.dblink_disconnect('machine_command');

select public.revoke_factory_machine_token(pg_temp.fixture_id(4), pg_temp.factory_id(),
  pg_temp.fixture_id(1), (select id from approved), pg_temp.fixture_id(31));
select is((select count(*) from internal.factory_machine_token_digests where token_id = pg_temp.fixture_id(31)),
  0::bigint, 'revocation removes the private digest while retaining manager history');
select results_eq($sql$select action, actor_member_id from public.factory_audit_events
  where detail->>'id' = pg_temp.fixture_id(31)::text order by id$sql$,
  $sql$values ('machine_token.issued', pg_temp.fixture_id(11)), ('machine_token.revoked', pg_temp.fixture_id(11))$sql$,
  'issue and idempotent revoke leave one sanitized audit event each with the acting human');
select ok(not exists (select 1 from public.factory_audit_events where detail->>'id' = pg_temp.fixture_id(31)::text
  and (detail ? 'digest' or detail::text like '%' || repeat('a', 64) || '%')),
  'audit events never expose the digest');

select * from finish();
delete from public.workspaces where id in (pg_temp.fixture_id(4), pg_temp.fixture_id(5));
delete from auth.users where id in (pg_temp.fixture_id(1), pg_temp.fixture_id(2));
