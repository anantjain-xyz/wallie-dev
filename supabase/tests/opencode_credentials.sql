begin;

create extension if not exists pgtap with schema extensions;

select plan(17);
set local "request.jwt.claim.role" = 'service_role';

select has_table(
  'public',
  'user_opencode_credentials',
  'OpenCode credential table exists'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.user_opencode_credentials'::regclass),
  'OpenCode credentials have RLS enabled'
);
select ok(
  has_table_privilege('service_role', 'public.user_opencode_credentials', 'INSERT')
  and has_table_privilege('service_role', 'public.user_opencode_credentials', 'SELECT')
  and has_table_privilege('service_role', 'public.user_opencode_credentials', 'UPDATE')
  and has_table_privilege('service_role', 'public.user_opencode_credentials', 'DELETE'),
  'service role can manage OpenCode credentials'
);
select ok(
  has_table_privilege('authenticated', 'public.user_opencode_credentials', 'SELECT')
  and has_table_privilege('authenticated', 'public.user_opencode_credentials', 'DELETE'),
  'authenticated users receive self-service read and delete grants'
);
select ok(
  not has_table_privilege('authenticated', 'public.user_opencode_credentials', 'INSERT')
  and not has_table_privilege('authenticated', 'public.user_opencode_credentials', 'UPDATE'),
  'authenticated users cannot write credential ciphertext directly'
);

insert into public.user_opencode_credentials (user_id, encrypted_api_key)
values
  ('a1b2c3d4-0001-4000-8000-000000000001', 'encrypted-owner'),
  ('a1b2c3d4-0002-4000-8000-000000000002', 'encrypted-other');

set local role authenticated;
set local "request.jwt.claim.sub" = 'a1b2c3d4-0001-4000-8000-000000000001';

select is(
  (select count(*) from public.user_opencode_credentials),
  1::bigint,
  'authenticated users can select only their own OpenCode credential'
);
select is(
  (
    select encrypted_api_key
    from public.user_opencode_credentials
    where user_id = 'a1b2c3d4-0001-4000-8000-000000000001'
  ),
  'encrypted-owner',
  'authenticated users can select their own encrypted credential row'
);

delete from public.user_opencode_credentials
where user_id = 'a1b2c3d4-0002-4000-8000-000000000002';

select is(
  (select count(*) from public.user_opencode_credentials),
  1::bigint,
  'authenticated users cannot delete another user credential'
);

delete from public.user_opencode_credentials
where user_id = 'a1b2c3d4-0001-4000-8000-000000000001';

select is(
  (select count(*) from public.user_opencode_credentials),
  0::bigint,
  'authenticated users can delete their own credential'
);

reset role;
set local "request.jwt.claim.role" = 'service_role';

select is(
  (
    select count(*)
    from public.user_opencode_credentials
    where user_id = 'a1b2c3d4-0002-4000-8000-000000000002'
  ),
  1::bigint,
  'service role still sees the cross-user credential hidden by RLS'
);

select lives_ok(
  $$
    update public.workspace_agent_config
    set value_json = '"opencode"'::jsonb
    where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
      and key = 'agent_provider'
  $$,
  'workspace agent config accepts the OpenCode provider'
);
select lives_ok(
  $$
    update public.workspace_agent_config
    set value_json = '"opencode/gpt-5.6-sol"'::jsonb
    where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
      and key = 'agent_model'
  $$,
  'workspace agent config accepts lowercase OpenCode model ids'
);
select throws_ok(
  $$
    update public.workspace_agent_config
    set value_json = '"OpenCode/gpt-5.6-sol"'::jsonb
    where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
      and key = 'agent_model'
  $$,
  '23514',
  null,
  'workspace agent config rejects uppercase OpenCode model ids'
);
select lives_ok(
  $$
    update public.workspace_agent_config
    set value_json = '"anthropic/claude-sonnet-4-5"'::jsonb
    where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
      and key = 'agent_model'
  $$,
  'workspace agent config accepts lowercase provider/model ids'
);
select lives_ok(
  $$
    update public.workspace_agent_config
    set value_json = '"opencode-go/glm-5.3"'::jsonb
    where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
      and key = 'agent_model'
  $$,
  'workspace agent config accepts custom opencode provider ids'
);
select throws_ok(
  $$
    update public.workspace_agent_config
    set value_json = '"opencode-go/GLM-5.3"'::jsonb
    where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
      and key = 'agent_model'
  $$,
  '23514',
  null,
  'workspace agent config rejects uppercase segments in provider/model ids'
);
select throws_ok(
  $$
    update public.workspace_agent_config
    set value_json = '"opencode-go/glm-5.3/x"'::jsonb
    where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
      and key = 'agent_model'
  $$,
  '23514',
  null,
  'workspace agent config rejects provider/model ids with more than one slash'
);

select * from finish();
rollback;
