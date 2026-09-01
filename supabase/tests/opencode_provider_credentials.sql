begin;

create extension if not exists pgtap with schema extensions;

select plan(16);
set local "request.jwt.claim.role" = 'service_role';

select has_table(
  'public',
  'user_opencode_provider_credentials',
  'OpenCode provider credential table exists'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class
    where oid = 'public.user_opencode_provider_credentials'::regclass),
  'OpenCode provider credentials have RLS enabled'
);
select ok(
  has_table_privilege('service_role', 'public.user_opencode_provider_credentials', 'INSERT')
  and has_table_privilege('service_role', 'public.user_opencode_provider_credentials', 'SELECT')
  and has_table_privilege('service_role', 'public.user_opencode_provider_credentials', 'UPDATE')
  and has_table_privilege('service_role', 'public.user_opencode_provider_credentials', 'DELETE'),
  'service role can manage OpenCode provider credentials'
);
select ok(
  has_table_privilege('authenticated', 'public.user_opencode_provider_credentials', 'SELECT')
  and has_table_privilege('authenticated', 'public.user_opencode_provider_credentials', 'DELETE'),
  'authenticated users receive self-service read and delete grants'
);
select ok(
  not has_table_privilege('authenticated', 'public.user_opencode_provider_credentials', 'INSERT')
  and not has_table_privilege('authenticated', 'public.user_opencode_provider_credentials', 'UPDATE'),
  'authenticated users cannot write provider credential ciphertext directly'
);

insert into public.user_opencode_provider_credentials (user_id, provider_id, encrypted_api_key)
values
  ('a1b2c3d4-0001-4000-8000-000000000001', 'opencode-go', 'encrypted-owner-go'),
  ('a1b2c3d4-0001-4000-8000-000000000001', 'openrouter', 'encrypted-owner-router'),
  ('a1b2c3d4-0002-4000-8000-000000000002', 'opencode-go', 'encrypted-other-go');

set local role authenticated;
set local "request.jwt.claim.sub" = 'a1b2c3d4-0001-4000-8000-000000000001';

select is(
  (select count(*) from public.user_opencode_provider_credentials),
  2::bigint,
  'authenticated users can select only their own OpenCode provider credentials'
);
select is(
  (
    select encrypted_api_key
    from public.user_opencode_provider_credentials
    where user_id = 'a1b2c3d4-0001-4000-8000-000000000001'
      and provider_id = 'opencode-go'
  ),
  'encrypted-owner-go',
  'authenticated users can select their own encrypted provider credential row'
);

delete from public.user_opencode_provider_credentials
where user_id = 'a1b2c3d4-0002-4000-8000-000000000002'
  and provider_id = 'opencode-go';

select is(
  (select count(*) from public.user_opencode_provider_credentials),
  2::bigint,
  'authenticated users cannot delete another user provider credential'
);

delete from public.user_opencode_provider_credentials
where user_id = 'a1b2c3d4-0001-4000-8000-000000000001'
  and provider_id = 'openrouter';

select is(
  (select count(*) from public.user_opencode_provider_credentials),
  1::bigint,
  'authenticated users can delete their own provider credential'
);

reset role;
set local "request.jwt.claim.role" = 'service_role';

select is(
  (
    select count(*)
    from public.user_opencode_provider_credentials
    where user_id = 'a1b2c3d4-0002-4000-8000-000000000002'
  ),
  1::bigint,
  'service role still sees the cross-user provider credential hidden by RLS'
);

select throws_ok(
  $$
    insert into public.user_opencode_provider_credentials (user_id, provider_id, encrypted_api_key)
    values ('a1b2c3d4-0001-4000-8000-000000000001', 'opencode', 'encrypted-zen-shadow')
  $$,
  '23514',
  null,
  'provider_id rejects the reserved Zen opencode prefix'
);
select throws_ok(
  $$
    insert into public.user_opencode_provider_credentials (user_id, provider_id, encrypted_api_key)
    values ('a1b2c3d4-0001-4000-8000-000000000001', 'OpenRouter', 'encrypted-uppercase')
  $$,
  '23514',
  null,
  'provider_id rejects uppercase slugs'
);
select throws_ok(
  $$
    insert into public.user_opencode_provider_credentials (user_id, provider_id, encrypted_api_key)
    values ('a1b2c3d4-0001-4000-8000-000000000001', 'open router', 'encrypted-space')
  $$,
  '23514',
  null,
  'provider_id rejects slugs with spaces'
);
select throws_ok(
  $$
    insert into public.user_opencode_provider_credentials (user_id, provider_id, encrypted_api_key)
    values ('a1b2c3d4-0001-4000-8000-000000000001', 'open/router', 'encrypted-slash')
  $$,
  '23514',
  null,
  'provider_id rejects slugs with slashes'
);
select throws_ok(
  $$
    insert into public.user_opencode_provider_credentials (user_id, provider_id, encrypted_api_key)
    values ('a1b2c3d4-0001-4000-8000-000000000001', '-leading', 'encrypted-leading')
  $$,
  '23514',
  null,
  'provider_id rejects slugs that start with a dash'
);
select lives_ok(
  $$
    insert into public.user_opencode_provider_credentials (user_id, provider_id, encrypted_api_key)
    values ('a1b2c3d4-0001-4000-8000-000000000001', 'anthropic', 'encrypted-anthropic')
  $$,
  'provider_id accepts a lowercase slug segment'
);

select * from finish();
rollback;
