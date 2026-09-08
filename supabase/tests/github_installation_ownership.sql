begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
grant usage on schema extensions to anon, authenticated, service_role;

select plan(29);
set local "request.jwt.claim.role" = 'service_role';

insert into auth.users (id, email) values
  ('ad020000-0000-4000-8000-000000000001', 'github-claim-a@example.test'),
  ('ad020000-0000-4000-8000-000000000002', 'github-claim-b@example.test');
insert into public.workspaces (id, slug, name) values
  ('ad020000-0000-4000-8000-000000000011', 'github-claim-a', 'GitHub claim A'),
  ('ad020000-0000-4000-8000-000000000012', 'github-claim-b', 'GitHub claim B');
insert into public.github_installations (
  id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions
) values (
  'ad020000-0000-4000-8000-000000000021',
  'ad020000-0000-4000-8000-000000000011',
  9020001, 'https://github.com/settings/installations/9020001',
  9020, 'Organization', 'Original owner', '{}'
);
insert into public.github_repositories (
  id, workspace_id, github_installation_id, repo_id, name, full_name, private, html_url
) values (
  'ad020000-0000-4000-8000-000000000031',
  'ad020000-0000-4000-8000-000000000011',
  'ad020000-0000-4000-8000-000000000021',
  9020001, 'private', 'original/private', true, 'https://github.com/original/private'
);

set local role service_role;

select lives_ok(
  $$update public.github_installations
    set target_name = 'Updated owner name', suspended = true
    where id = 'ad020000-0000-4000-8000-000000000021'$$,
  'service role can refresh metadata and suspension without replacing ownership'
);
select lives_ok(
  $$update public.github_installations
    set workspace_id = 'ad020000-0000-4000-8000-000000000011', installation_id = 9020001
    where id = 'ad020000-0000-4000-8000-000000000021'$$,
  'an unchanged identity update remains compatible with existing callers'
);
select throws_ok(
  $$update public.github_installations
    set workspace_id = 'ad020000-0000-4000-8000-000000000012'
    where id = 'ad020000-0000-4000-8000-000000000021'$$,
  '23514',
  'GitHub installation ownership is immutable; disconnect before reconnecting',
  'even service role cannot transfer an existing installation to another workspace'
);
select throws_ok(
  $$update public.github_installations set installation_id = 9020002
    where id = 'ad020000-0000-4000-8000-000000000021'$$,
  '23514',
  'GitHub installation ownership is immutable; disconnect before reconnecting',
  'even service role cannot retarget a connection while retaining its repositories'
);
select throws_ok(
  $$insert into public.github_installations (
      workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions
    ) values (
      'ad020000-0000-4000-8000-000000000012', 9020001,
      'https://github.com/settings/installations/9020001', 9020, 'Organization', 'Other', '{}'
    )$$,
  '23505', null,
  'the unique installation constraint rejects a competing initial workspace claim'
);
select throws_ok(
  $$insert into public.github_installations (
      workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions
    ) values (
      'ad020000-0000-4000-8000-000000000011', 9020002,
      'https://github.com/settings/installations/9020002', 9020, 'Organization', 'Other', '{}'
    )$$,
  '23505', null,
  'the unique workspace constraint rejects a competing replacement connection'
);
select results_eq(
  $$select repository.workspace_id, installation.installation_id
    from public.github_repositories repository
    join public.github_installations installation on installation.id = repository.github_installation_id
    where repository.id = 'ad020000-0000-4000-8000-000000000031'$$,
  $$values ('ad020000-0000-4000-8000-000000000011'::uuid, 9020001::bigint)$$,
  'failed claims preserve the original private repository and connection'
);

reset role;

select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.github_install_flows'::regclass),
  'GitHub install flows enable RLS'
);
select ok(
  not has_table_privilege('anon', 'public.github_install_flows', 'select,insert,update,delete'),
  'anonymous callers have no flow grants'
);
select ok(
  not has_table_privilege('authenticated', 'public.github_install_flows', 'select,insert,update,delete'),
  'authenticated callers have no flow grants'
);
select ok(
  has_table_privilege('service_role', 'public.github_install_flows', 'select')
  and has_table_privilege('service_role', 'public.github_install_flows', 'insert')
  and has_table_privilege('service_role', 'public.github_install_flows', 'update')
  and has_table_privilege('service_role', 'public.github_install_flows', 'delete'),
  'service role can manage OAuth flows'
);

set local role service_role;

insert into public.github_install_flows (
  state_hash, user_id, workspace_id, source, encrypted_code_verifier, expires_at
) values (
  repeat('a', 64),
  'ad020000-0000-4000-8000-000000000001',
  'ad020000-0000-4000-8000-000000000011',
  'settings', 'encrypted-test-verifier', now() + interval '10 minutes'
);

select throws_ok(
  $$update public.github_install_flows set state_hash = 'not-a-sha256'$$,
  '23514', null, 'flow state must be a SHA256 hex digest'
);
select throws_ok(
  $$update public.github_install_flows set source = 'untrusted'$$,
  '23514', null, 'flow source must be an allowed return destination'
);
select throws_ok(
  $$update public.github_install_flows set phase = 'authorize', installation_id = -1$$,
  '23514', null, 'flow installation identifiers must be positive'
);
select throws_ok(
  $$update public.github_install_flows set installation_id = 9020001$$,
  '23514', null, 'install-phase flows cannot already have an installation'
);
select throws_ok(
  $$update public.github_install_flows set phase = 'authorize'$$,
  '23514', null, 'authorize-phase flows must identify the installation'
);

set local role anon;
set local "request.jwt.claim.role" = 'anon';

select throws_ok(
  $$select encrypted_code_verifier from public.github_install_flows$$,
  '42501', null, 'anonymous callers cannot read flow verifiers'
);
select throws_ok(
  $$insert into public.github_install_flows select * from public.github_install_flows$$,
  '42501', null, 'anonymous callers cannot create flows'
);
select throws_ok(
  $$update public.github_install_flows set source = 'onboarding'$$,
  '42501', null, 'anonymous callers cannot alter flows'
);
select throws_ok(
  $$delete from public.github_install_flows$$,
  '42501', null, 'anonymous callers cannot consume flows'
);

set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'ad020000-0000-4000-8000-000000000001';

select throws_ok(
  $$select encrypted_code_verifier from public.github_install_flows$$,
  '42501', null, 'even the flow user cannot read verifiers through the Data API'
);
select throws_ok(
  $$insert into public.github_install_flows select * from public.github_install_flows$$,
  '42501', null, 'authenticated callers cannot create flows through the Data API'
);
select throws_ok(
  $$update public.github_install_flows set source = 'onboarding'$$,
  '42501', null, 'authenticated callers cannot alter flows through the Data API'
);
select throws_ok(
  $$delete from public.github_install_flows$$,
  '42501', null, 'authenticated callers cannot consume flows through the Data API'
);

set local role service_role;
set local "request.jwt.claim.role" = 'service_role';

with advanced as (
  update public.github_install_flows
  set phase = 'authorize', installation_id = 9020001
  where state_hash = repeat('a', 64)
    and user_id = 'ad020000-0000-4000-8000-000000000001'
    and phase = 'install'
    and expires_at > now()
  returning state_hash
)
select is(count(*), 1::bigint, 'service role advances an unexpired matching flow once') from advanced;

with advanced as (
  update public.github_install_flows
  set phase = 'authorize', installation_id = 9020001
  where state_hash = repeat('a', 64) and phase = 'install'
  returning state_hash
)
select is(count(*), 0::bigint, 'a repeated phase transition changes nothing') from advanced;

with consumed as (
  delete from public.github_install_flows
  where state_hash = repeat('a', 64)
    and user_id = 'ad020000-0000-4000-8000-000000000002'
    and phase = 'authorize'
  returning state_hash
)
select is(count(*), 0::bigint, 'flow consumption with the wrong user changes nothing') from consumed;

with consumed as (
  delete from public.github_install_flows
  where state_hash = repeat('a', 64)
    and user_id = 'ad020000-0000-4000-8000-000000000001'
    and phase = 'authorize'
    and expires_at > now()
  returning encrypted_code_verifier
)
select is(count(*), 1::bigint, 'service role consumes the matching authorize flow once') from consumed;

with consumed as (
  delete from public.github_install_flows where state_hash = repeat('a', 64)
  returning state_hash
)
select is(count(*), 0::bigint, 'a replay cannot consume the same flow again') from consumed;

reset role;
select * from finish();
rollback;
