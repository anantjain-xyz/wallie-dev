begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- These are inert ciphertext fixtures, never usable provider credentials.
insert into public.user_codex_credentials (user_id, credential_type, encrypted_credential)
values ('a1b2c3d4-0002-4000-8000-000000000002', 'platform_api_key', 'test-codex-ciphertext');
insert into public.user_claude_code_credentials (user_id, encrypted_api_key)
values ('a1b2c3d4-0002-4000-8000-000000000002', 'test-claude-ciphertext');
insert into public.user_cursor_credentials (user_id, encrypted_api_key, api_key_expires_at)
values ('a1b2c3d4-0002-4000-8000-000000000002', 'test-cursor-ciphertext', now() + interval '1 day');
insert into public.user_opencode_credentials (user_id, encrypted_api_key)
values ('a1b2c3d4-0002-4000-8000-000000000002', 'test-zen-ciphertext');
insert into public.user_opencode_provider_credentials (user_id, provider_id, encrypted_api_key)
values
  ('a1b2c3d4-0002-4000-8000-000000000002', 'opencode-go', 'test-custom-ciphertext'),
  ('a1b2c3d4-0002-4000-8000-000000000002', 'openrouter', 'test-other-provider-ciphertext');

-- The same person remains authorized in another workspace after revocation.
insert into public.workspaces (id, slug, name)
values ('ca530000-0000-4000-8000-000000000001', 'credential-authorization-proof', 'Credential proof');
insert into public.workspace_members (id, workspace_id, user_id, kind, role)
values (
  'ca530000-0000-4000-8000-000000000002',
  'ca530000-0000-4000-8000-000000000001',
  'a1b2c3d4-0002-4000-8000-000000000002', 'human', 'member'
);

create temp table credential_cases (provider text, function_signature text, read_sql text, ciphertext text);
insert into credential_cases values
  ('Codex', 'public.load_session_codex_credential(uuid,uuid,uuid)',
   'select user_id, encrypted_credential from public.load_session_codex_credential(%L::uuid, %L::uuid)',
   'test-codex-ciphertext'),
  ('Claude Code', 'public.load_session_claude_code_credential(uuid,uuid)',
   'select user_id, encrypted_api_key from public.load_session_claude_code_credential(%L::uuid, %L::uuid)',
   'test-claude-ciphertext'),
  ('Cursor', 'public.load_session_cursor_credential(uuid,uuid)',
   'select user_id, encrypted_api_key from public.load_session_cursor_credential(%L::uuid, %L::uuid)',
   'test-cursor-ciphertext'),
  ('OpenCode Zen', 'public.load_session_opencode_credentials(uuid,uuid,text)',
   'select user_id, encrypted_api_key from public.load_session_opencode_credentials(%L::uuid, %L::uuid, ''opencode'')',
   'test-zen-ciphertext'),
  ('OpenCode custom provider', 'public.load_session_opencode_credentials(uuid,uuid,text)',
   'select user_id, encrypted_api_key from public.load_session_opencode_credentials(%L::uuid, %L::uuid, ''opencode-go'')',
   'test-custom-ciphertext');
grant select on credential_cases to service_role, authenticated, anon;

select ok(has_function_privilege('service_role', function_signature, 'EXECUTE'),
  function_signature || ' allows service-role execution')
from (select distinct function_signature from credential_cases) functions;
select ok(not has_function_privilege('authenticated', function_signature, 'EXECUTE'),
  function_signature || ' denies authenticated execution')
from (select distinct function_signature from credential_cases) functions;
select ok(not has_function_privilege('anon', function_signature, 'EXECUTE'),
  function_signature || ' denies anonymous execution')
from (select distinct function_signature from credential_cases) functions;

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';

select results_eq(
  format(read_sql, 'c1b2c3d4-0002-4000-8000-000000000002', 'b1b2c3d4-0001-4000-8000-000000000001'),
  format('values (%L::uuid, %L::text)', 'a1b2c3d4-0002-4000-8000-000000000002', ciphertext),
  provider || ' returns only the active human member''s credential'
) from credential_cases;

select is_empty(
  format(read_sql, 'c1b2c3d4-0002-4000-8000-000000000002', 'ca530000-0000-4000-8000-000000000001'),
  provider || ' rejects a member ID from a different workspace even when its user belongs to both'
) from credential_cases;
select is_empty(
  format(read_sql, 'c1b2c3d4-0003-4000-8000-000000000003', 'b1b2c3d4-0001-4000-8000-000000000001'),
  provider || ' rejects a system member'
) from credential_cases;
select is_empty(
  format(read_sql, 'ca530000-0000-4000-8000-000000000099', 'b1b2c3d4-0001-4000-8000-000000000001'),
  provider || ' rejects a missing member'
) from credential_cases;
select is_empty(
  format(read_sql, null, 'b1b2c3d4-0001-4000-8000-000000000001'),
  provider || ' rejects a session without a creator'
) from credential_cases;
select is_empty(
  format(read_sql, 'c1b2c3d4-0001-4000-8000-000000000001', 'b1b2c3d4-0001-4000-8000-000000000001'),
  provider || ' returns no credential for an active owner who has not connected this provider'
) from credential_cases;

select is_empty($$
  select * from public.load_session_codex_credential(
    'c1b2c3d4-0002-4000-8000-000000000002', 'b1b2c3d4-0001-4000-8000-000000000001',
    'a1b2c3d4-0001-4000-8000-000000000001')
$$, 'Codex reload rejects a user ID that does not match the session member');
select results_eq($$
  select user_id, encrypted_credential from public.load_session_codex_credential(
    'c1b2c3d4-0002-4000-8000-000000000002', 'b1b2c3d4-0001-4000-8000-000000000001',
    'a1b2c3d4-0002-4000-8000-000000000002')
$$, $$values ('a1b2c3d4-0002-4000-8000-000000000002'::uuid, 'test-codex-ciphertext'::text)$$,
  'Codex reload returns the credential for the matching expected user');

select results_eq($$
  select user_id, encrypted_api_key, zen_encrypted_api_key
  from public.load_session_opencode_credentials(
    'c1b2c3d4-0002-4000-8000-000000000002', 'b1b2c3d4-0001-4000-8000-000000000001', 'opencode-go')
$$, $$values ('a1b2c3d4-0002-4000-8000-000000000002'::uuid,
  'test-custom-ciphertext'::text, 'test-zen-ciphertext'::text)$$,
  'custom OpenCode authentication returns only its selected provider and optional Zen credential');
select is_empty($$
  select * from public.load_session_opencode_credentials(
    'c1b2c3d4-0002-4000-8000-000000000002', 'b1b2c3d4-0001-4000-8000-000000000001', 'unconnected')
$$, 'OpenCode does not substitute Zen for a missing custom provider credential');

delete from public.user_opencode_credentials
where user_id = 'a1b2c3d4-0002-4000-8000-000000000002';
select results_eq($$
  select encrypted_api_key, zen_encrypted_api_key from public.load_session_opencode_credentials(
    'c1b2c3d4-0002-4000-8000-000000000002', 'b1b2c3d4-0001-4000-8000-000000000001', 'opencode-go')
$$, $$values ('test-custom-ciphertext'::text, null::text)$$,
  'a custom OpenCode provider still works without optional Zen credentials');
select is_empty($$
  select * from public.load_session_opencode_credentials(
    'c1b2c3d4-0002-4000-8000-000000000002', 'b1b2c3d4-0001-4000-8000-000000000001', 'opencode')
$$, 'OpenCode Zen returns no credential when only custom provider keys exist');
insert into public.user_opencode_credentials (user_id, encrypted_api_key)
values ('a1b2c3d4-0002-4000-8000-000000000002', 'test-zen-ciphertext');

-- Even the credential owner cannot call these privileged worker entry points.
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'a1b2c3d4-0002-4000-8000-000000000002';
select throws_ok(
  format(read_sql, 'c1b2c3d4-0002-4000-8000-000000000002', 'b1b2c3d4-0001-4000-8000-000000000001'),
  '42501', null,
  provider || ' denies direct authenticated execution by the credential owner'
) from credential_cases;

set local role anon;
set local "request.jwt.claim.role" = 'anon';
select throws_ok(
  format(read_sql, 'c1b2c3d4-0002-4000-8000-000000000002', 'b1b2c3d4-0001-4000-8000-000000000001'),
  '42501', null,
  provider || ' denies direct anonymous execution'
) from credential_cases;

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';
create temp table removed_session_owner as
select * from public.remove_workspace_member(
  'c1b2c3d4-0002-4000-8000-000000000002', 'b1b2c3d4-0001-4000-8000-000000000001');
select is((select count(*) from removed_session_owner), 1::bigint,
  'the normal member-removal transaction revokes the fixture membership');

select is_empty(
  format(read_sql, 'c1b2c3d4-0002-4000-8000-000000000002', 'b1b2c3d4-0001-4000-8000-000000000001'),
  provider || ' denies the former member after revocation'
) from credential_cases;
select results_eq(
  format(read_sql, 'ca530000-0000-4000-8000-000000000002', 'ca530000-0000-4000-8000-000000000001'),
  format('values (%L::uuid, %L::text)', 'a1b2c3d4-0002-4000-8000-000000000002', ciphertext),
  provider || ' remains usable through the same user''s other active workspace membership'
) from credential_cases;
select results_eq($$
  select 'codex', encrypted_credential from public.user_codex_credentials
    where user_id = 'a1b2c3d4-0002-4000-8000-000000000002'
  union all select 'claude', encrypted_api_key from public.user_claude_code_credentials
    where user_id = 'a1b2c3d4-0002-4000-8000-000000000002'
  union all select 'cursor', encrypted_api_key from public.user_cursor_credentials
    where user_id = 'a1b2c3d4-0002-4000-8000-000000000002'
  union all select 'zen', encrypted_api_key from public.user_opencode_credentials
    where user_id = 'a1b2c3d4-0002-4000-8000-000000000002'
  union all select provider_id, encrypted_api_key from public.user_opencode_provider_credentials
    where user_id = 'a1b2c3d4-0002-4000-8000-000000000002'
  order by 1
$$, $$values
  ('claude'::text, 'test-claude-ciphertext'::text),
  ('codex', 'test-codex-ciphertext'),
  ('cursor', 'test-cursor-ciphertext'),
  ('opencode-go', 'test-custom-ciphertext'),
  ('openrouter', 'test-other-provider-ciphertext'),
  ('zen', 'test-zen-ciphertext')
$$, 'workspace revocation preserves every global credential row unchanged');

reset role;
select * from finish();
rollback;
