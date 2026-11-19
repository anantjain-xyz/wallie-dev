begin;
create extension if not exists pgtap with schema extensions;
select plan(104);
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '55700200-0000-4000-8000-000000000001';

select public.set_git_continuity_release(true, revision, 'Factory scoped MCP fixture')
from public.get_git_continuity_release_state() where not enabled;

insert into auth.users(id, email) values
  ('55700200-0000-4000-8000-000000000001', 'mcp-manifest-payer@example.test'),
  ('55700200-0000-4000-8000-000000000002', 'mcp-manifest-invoker@example.test');
insert into public.workspaces(id, slug, name) values
  ('55700200-1000-4000-8000-000000000001', 'mcp-manifest-test', 'Service execution');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  ('55700200-2000-4000-8000-000000000001', '55700200-1000-4000-8000-000000000001',
   '55700200-0000-4000-8000-000000000001', 'human', 'owner'),
  ('55700200-2000-4000-8000-000000000002', '55700200-1000-4000-8000-000000000001',
   '55700200-0000-4000-8000-000000000002', 'human', 'member');
insert into public.pipelines(id, workspace_id, name, is_default) values
  ('55700200-4000-4000-8000-000000000001', '55700200-1000-4000-8000-000000000001', 'Pipeline', true);
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name) values
  ('55700200-5000-4000-8000-000000000001', '55700200-4000-4000-8000-000000000001',
   '55700200-1000-4000-8000-000000000001', 1, 'service-build', 'Build');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id,
  target_type, target_name, permissions) values
  ('55700200-7000-4000-8000-000000000001', '55700200-1000-4000-8000-000000000001',
   55700201, 'https://github.com/settings/installations/55700201', 55700, 'Organization', 'fixture',
   '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch) values
  ('55700200-6000-4000-8000-000000000001', '55700200-1000-4000-8000-000000000001',
   '55700200-7000-4000-8000-000000000001', 55700201, 'writer', 'fixture/writer', true,
   'https://github.com/fixture/writer', 'main');
insert into public.execution_policy_revisions(id, workspace_id, revision, requirements, created_by) values
  ('55700200-8000-4000-8000-000000000001', '55700200-1000-4000-8000-000000000001', 1,
   '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":300000,"maxTotalTokens":10000,"maxCostUsd":5}',
   '55700200-0000-4000-8000-000000000001');

create temp table principal as
select principal.* from public.factories factory
cross join lateral public.create_service_principal(factory.workspace_id, factory.id,
  '55700200-0000-4000-8000-000000000001', 'Fixture service', 'fixture-service') principal
where factory.workspace_id = '55700200-1000-4000-8000-000000000001' and factory.is_default;

insert into auth.users(id,email) values ('55700200-0000-4000-8000-000000000003','mcp-manifest-outsider@example.test');
insert into public.workspace_secrets(id,workspace_id,key,encrypted_value,value_preview) values
  ('55700200-9000-4000-8000-000000000001','55700200-1000-4000-8000-000000000001',
   'TEST_MCP_BEARER','synthetic-encryption-version-1','...fixture'),
  ('55700200-9000-4000-8000-000000000002','55700200-1000-4000-8000-000000000001',
   'TEST_PROVIDER_KEY','synthetic-provider-material','...provider'),
  ('55700200-9000-4000-8000-000000000003','55700200-1000-4000-8000-000000000001',
   'LINEAR_API_KEY','synthetic-integration-material','...linear'),
  ('55700200-9000-4000-8000-000000000004','55700200-1000-4000-8000-000000000001',
   'TEST_OPENCODE_KEY','synthetic-opencode-material',null),
  ('55700200-9000-4000-8000-000000000005','55700200-1000-4000-8000-000000000001',
   'TEST_CURSOR_KEY','synthetic-cursor-material',null);

create temp table fixture_agent as
select agent.id, revision.id as revision_id, revision.prompt_md, revision.prompt_sha256
from public.factory_agents agent
join principal on (principal.workspace_id, principal.factory_id) = (agent.workspace_id, agent.factory_id)
join public.factory_agent_prompt_revisions revision on revision.agent_id = agent.id and revision.revision_number = 1
where agent.is_default;

create function pg_temp.approve_server(
  p_endpoint text, p_operations text[], p_auth_kind text default 'bearer',
  p_actor uuid default '55700200-0000-4000-8000-000000000001', p_slug text default 'fixture-mcp'
) returns public.factory_mcp_server_revisions language sql as $$
  select public.create_factory_mcp_server(principal.workspace_id, principal.factory_id, p_actor,
    'Fixture MCP', p_slug, p_endpoint, p_operations, p_auth_kind) from principal;
$$;

select throws_ok($$select pg_temp.approve_server('http://fixture.example.test/mcp', array['search'])$$,
  'PT422', null, 'an insecure transport cannot be approved');
select throws_ok($$select pg_temp.approve_server('https://user@fixture.example.test/mcp', array['search'])$$,
  'PT422', null, 'endpoint user info cannot be approved');
select throws_ok($$select pg_temp.approve_server('https://fixture.example.test/mcp?foo=bar', array['search'])$$,
  'PT422', null, 'endpoint queries cannot be approved');
select throws_ok($$select pg_temp.approve_server('https://fixture.example.test/mcp#fragment', array['search'])$$,
  'PT422', null, 'endpoint fragments cannot be approved');
select throws_ok($$select pg_temp.approve_server('https://fixture.example.test/mcp', array['search','search'])$$,
  'PT422', null, 'operation approval excludes duplicate names');
select throws_ok($$select pg_temp.approve_server('https://fixture.example.test/mcp', array['*'])$$,
  'PT422', null, 'operation approval excludes wildcards');
select throws_ok($$select pg_temp.approve_server('https://fixture.example.test/mcp', array['search'],
    p_actor => '55700200-0000-4000-8000-000000000002')$$,
  '42501', null, 'ordinary participants cannot approve MCP servers');
select ok(not has_function_privilege('authenticated',
  'public.create_factory_mcp_server(uuid,uuid,uuid,text,text,text,text[],text)', 'execute'),
  'the inventory mutation RPC requires service role plus a manager actor');
select ok(not has_column_privilege('authenticated', 'public.factory_mcp_secret_bindings', 'workspace_secret_id', 'select'),
  'browser roles cannot retrieve the underlying source ID');

create temp table approved_revision as
select * from pg_temp.approve_server('https://fixture.example.test/mcp', array['search','read']);
select is((select operation_names from approved_revision), array['read','search'],
  'approved revisions preserve a deterministic allowlist');
create function pg_temp.revise_server(p_expected integer)
returns public.factory_mcp_server_revisions language sql as $$
  select public.save_factory_mcp_server_revision(workspace_id, factory_id,
    '55700200-0000-4000-8000-000000000001', server_id, p_expected,
    'https://fixture.example.test/next', array['search'], 'none') from approved_revision;
$$;
select is((pg_temp.revise_server(1)).revision_number, 2, 'an approved edit creates a new immutable revision');
select throws_ok($$select pg_temp.revise_server(1)$$, 'PT409', null, 'concurrent stale edits must reload');
select throws_ok($$update public.factory_mcp_server_revisions set endpoint='https://changed.example.test/'
  where id=(select id from approved_revision)$$, '23514', null, 'historical endpoints cannot be overwritten');
create temp table public_revision as
select * from pg_temp.approve_server('https://public.example.test/mcp', array['lookup'], 'none', p_slug => 'fixture-public');

create temp table grant_v1 as
select approved.* from principal cross join approved_revision bearer cross join public_revision open
cross join lateral public.approve_factory_execution_grant(principal.workspace_id, principal.factory_id,
  '55700200-0000-4000-8000-000000000001', principal.id, '55700200-6000-4000-8000-000000000001',
  '{}'::uuid[], array[bearer.id::text || '/search', open.id::text || '/lookup'],
  '55700200-8000-4000-8000-000000000001', '55700200-2000-4000-8000-000000000001',
  clock_timestamp() + interval '10 minutes', 0) approved;

create function pg_temp.bind_mcp(
  p_source uuid default '55700200-9000-4000-8000-000000000001',
  p_revision uuid default null, p_version bigint default 1
) returns public.factory_mcp_secret_bindings language sql as $$
  select public.create_factory_mcp_secret_binding(grant_v1.workspace_id, grant_v1.factory_id,
    '55700200-0000-4000-8000-000000000001', grant_v1.id, p_version, fixture_agent.id,
    coalesce(p_revision, approved_revision.id), p_source)
  from grant_v1 cross join fixture_agent cross join approved_revision;
$$;
create function pg_temp.bind_provider(p_source uuid, p_provider text default 'codex', p_upstream text default null)
returns public.factory_secret_bindings language sql as $$
  select public.create_factory_secret_binding(grant_v1.workspace_id, grant_v1.factory_id,
    '55700200-0000-4000-8000-000000000001', grant_v1.id, 1, fixture_agent.id, p_provider, p_source, p_upstream)
  from grant_v1 cross join fixture_agent;
$$;
select throws_ok($$select pg_temp.bind_mcp(p_version => 2)$$, 'PT409', null,
  'MCP delegation requires the exact current grant version');
select throws_ok($$select pg_temp.bind_mcp(p_revision => (select id from public_revision))$$, '42501', null,
  'an approved unauthenticated revision cannot acquire a bearer credential');
select throws_ok($$select pg_temp.bind_mcp('55700200-9000-4000-8000-000000000003')$$, 'P0002', null,
  'the shared Linear key cannot be delegated to an MCP tool');
select lives_ok($$select pg_temp.bind_provider('55700200-9000-4000-8000-000000000002')$$,
  'an agent provider can claim its own source');
create temp table provider_binding as select * from public.factory_secret_bindings
  where workspace_secret_id = '55700200-9000-4000-8000-000000000002';
select throws_ok($$select pg_temp.bind_mcp('55700200-9000-4000-8000-000000000002')$$, 'PT409', null,
  'an MCP scope cannot claim a provider source');
create temp table bearer_binding as select * from pg_temp.bind_mcp();
select throws_ok($$select pg_temp.bind_provider('55700200-9000-4000-8000-000000000001')$$, 'PT409', null,
  'an agent provider cannot claim an MCP source');
select ok((select value_preview is null from public.workspace_secrets where key = 'TEST_MCP_BEARER'),
  'delegating the bearer source removes its stored preview');
update public.workspace_secrets set encrypted_value = 'synthetic-encryption-version-2', value_preview = '...rotated'
  where key = 'TEST_MCP_BEARER';
select ok((select value_preview is null and material_revision = 2 from public.workspace_secrets where key = 'TEST_MCP_BEARER'),
  'ordinary workspace secret rotations cannot restore the bearer preview');
select ok(not exists (select 1 from principal cross join lateral public.list_factory_bindable_workspace_secrets(
  principal.workspace_id, principal.factory_id, '55700200-0000-4000-8000-000000000001') candidate
  where candidate.key = 'TEST_MCP_BEARER'), 'delegated bearer sources are unavailable in the shared picker');

create function pg_temp.mcp_definition(
  p_operation text default 'search', p_public boolean default false, p_include_tools boolean default true,
  p_provider text default 'codex', p_model text default 'gpt-5.5', p_credential_binding_id uuid default null
) returns jsonb language sql as $$
  with choice as (
    select * from approved_revision where not p_public
    union all
    select * from public_revision where p_public
  )
  select jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', '55700200-4000-4000-8000-000000000001',
    'repositoryId', '55700200-6000-4000-8000-000000000001', 'readContextRepositoryIds', '[]'::jsonb,
    'toolIds', case when p_include_tools then jsonb_build_array(choice.id::text || '/' || p_operation) else '[]'::jsonb end,
    'executionPolicyRevisionId', '55700200-8000-4000-8000-000000000001',
    'executionGrant', jsonb_build_object('id', grant_v1.id, 'version', grant_v1.version),
    'credentialBindingId', coalesce(p_credential_binding_id, provider_binding.id),
    'implementationAgent', jsonb_build_object('agentId', agent.id, 'promptRevisionId', agent.revision_id,
      'promptMd', agent.prompt_md, 'promptSha256', agent.prompt_sha256),
    'sandboxProvider', 'e2b', 'agent', jsonb_build_object('provider', p_provider, 'model', p_model),
    'stages', jsonb_build_array(jsonb_build_object(
      'id', '55700200-5000-4000-8000-000000000001', 'slug', 'service-build', 'name', 'Build'))
  ) || case when p_include_tools then jsonb_build_object('mcpManifest', jsonb_build_object('agentId', agent.id,
    'servers', jsonb_build_array(jsonb_build_object(
      'toolRevisionId', choice.id, 'serverId', choice.server_id,
      'serverSlug', case when p_public then 'fixture-public' else 'fixture-mcp' end,
      'revisionNumber', choice.revision_number, 'endpoint', choice.endpoint, 'operations', jsonb_build_array(p_operation),
      'auth', case when p_public then '{"kind":"none"}'::jsonb
        else jsonb_build_object('kind', 'bearer', 'secretBindingId', bearer_binding.id) end)))) else '{}'::jsonb end
  from grant_v1 cross join fixture_agent agent cross join choice cross join bearer_binding cross join provider_binding;
$$;

create function pg_temp.activate_mcp_fixture(p_activation bigint, p_definition jsonb)
returns void language sql as $$
  with revision as (
    insert into public.factory_definition_revisions(workspace_id, factory_id, schema_version,
      definition_json, canonical_digest, created_by)
    select principal.workspace_id, principal.factory_id, 1, p_definition::text,
      encode(sha256(convert_to(p_definition::text, 'UTF8')), 'hex'), '55700200-0000-4000-8000-000000000001'
    from principal
    where not exists (
      select 1 from public.factory_definition_revisions stored
      where (stored.workspace_id, stored.factory_id) = (principal.workspace_id, principal.factory_id)
        and stored.canonical_digest = encode(sha256(convert_to(p_definition::text, 'UTF8')), 'hex')
    )
    returning id, workspace_id, factory_id, created_by
  ), selected_revision as (
    select * from revision
    union all
    select stored.id, stored.workspace_id, stored.factory_id, stored.created_by
    from public.factory_definition_revisions stored join principal
      on (stored.workspace_id, stored.factory_id) = (principal.workspace_id, principal.factory_id)
    where stored.canonical_digest = encode(sha256(convert_to(p_definition::text, 'UTF8')), 'hex')
  )
  insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
  select workspace_id, factory_id, id, p_activation, created_by from selected_revision;
$$;
create temp table legacy_default as select * from public.create_session_with_first_job(
  '55700200-1000-4000-8000-000000000001', '55700200-2000-4000-8000-000000000002',
  'Legacy default factory', 'Legacy prompt', 'codex', 'gpt-5.5');
select ok((select session.factory_id = principal.factory_id
    and session.pipeline_id = '55700200-4000-4000-8000-000000000001'
    and session.factory_definition_provenance = 'legacy' and session.factory_definition_revision_id is null
    and not session.execute_pinned_definition
  from legacy_default legacy join public.sessions session on session.id = legacy.session_id cross join principal),
  'admission without an active definition retains the default factory and legacy pipeline');
select throws_ok($$select pg_temp.activate_mcp_fixture(1, pg_temp.mcp_definition() - 'executionGrant')$$,
  '42501', null, 'activation requires a live execution grant for any MCP scope');
select throws_ok($$select pg_temp.activate_mcp_fixture(1, pg_temp.mcp_definition() - 'mcpManifest')$$,
  'PT422', null, 'a current grant key cannot imply an ambient MCP operation');
select throws_ok($$select pg_temp.activate_mcp_fixture(1, pg_temp.mcp_definition('read'))$$,
  '42501', null, 'an approved endpoint operation outside the reviewed grant fails activation');
select throws_ok($$select pg_temp.activate_mcp_fixture(1,
  jsonb_set(pg_temp.mcp_definition(), '{mcpManifest,servers,0,operations}', '["search","write"]'))$$,
  'PT422', null, 'activation rejects an operation beyond the approved server revision');
select throws_ok($$select pg_temp.activate_mcp_fixture(1,
  jsonb_set(pg_temp.mcp_definition(), '{mcpManifest,servers,0,toolRevisionId}', to_jsonb(gen_random_uuid())))$$,
  'PT422', null, 'activation rejects unregistered tool revisions');
select throws_ok($$select pg_temp.activate_mcp_fixture(1,
  jsonb_set(pg_temp.mcp_definition(), '{mcpManifest,servers,0,endpoint}', '"https://changed.example.test/"'))$$,
  'PT422', null, 'activation cannot change the approved endpoint under a valid grant');
select throws_ok($$select pg_temp.activate_mcp_fixture(1,
  jsonb_set(pg_temp.mcp_definition(), '{mcpManifest,servers,0,auth,inlineToken}', '"synthetic-inline-material"'))$$,
  'PT422', null, 'bearer manifests accept only a secret reference');
select throws_ok($$select pg_temp.activate_mcp_fixture(1,
  jsonb_set(pg_temp.mcp_definition(), '{mcpManifest,servers,0,auth,secretBindingId}', to_jsonb(gen_random_uuid())))$$,
  '42501', null, 'activation fails if the bearer reference is unavailable');
select throws_ok($$select pg_temp.activate_mcp_fixture(1,
  jsonb_set(pg_temp.mcp_definition(), '{mcpManifest,servers,0,auth}', '{"kind":"none"}'))$$,
  'PT422', null, 'activation fails if the bearer reference is removed');
select lives_ok($$select pg_temp.activate_mcp_fixture(1, pg_temp.mcp_definition('lookup', true))$$,
  'a grant may explicitly select an approved unauthenticated operation');
select lives_ok($$select pg_temp.activate_mcp_fixture(2, pg_temp.mcp_definition(p_include_tools => false))$$,
  'a grant with approved tools can still activate a definition with no tools');

create function pg_temp.admit_mcp(p_label text, p_provider text default 'codex', p_model text default 'gpt-5.5')
returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language sql as $$
  select * from public.create_session_with_first_job(
    '55700200-1000-4000-8000-000000000001', '55700200-2000-4000-8000-000000000002',
    p_label, 'MCP manifest fixture', p_provider, p_model,
    session_github_repository_id => '55700200-6000-4000-8000-000000000001');
$$;
create temp table empty_run as select * from pg_temp.admit_mcp('Empty MCP fixture');
select lives_ok($$select pg_temp.activate_mcp_fixture(3, pg_temp.mcp_definition())$$,
  'a canonical reference scoped to exact revision, operation, grant and agent can activate');
create temp table admitted_run as select * from pg_temp.admit_mcp('Approved MCP fixture');
create temp table queued_run as select * from pg_temp.admit_mcp('Queued MCP fixture');
grant select on empty_run, queued_run to authenticated;

create function pg_temp.start_mcp(
  p_session uuid, p_job uuid, p_provider text default 'codex', p_model text default 'gpt-5.5'
)
returns uuid language plpgsql as $$
declare owner public.sessions;
begin
  select * into strict owner from public.sessions where id = p_session;
  update public.agent_jobs set git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()),
    status = 'running', attempt_count = 1 where id = p_job;
  return public.start_session_job_attempt(p_job, 1, owner.current_stage_id, owner.current_artifact_version,
    p_provider, p_model, 'code', 'wallie/mcp-fixture-' || p_job::text);
end;
$$;
create temp table started_run as select session_id, job_id, pg_temp.start_mcp(session_id,job_id) run_id from admitted_run;
grant select on started_run to authenticated;
select ok((select run_id is not null from started_run), 'a currently authorized exact scope permits attempt start');
select lives_ok($$select public.pin_session_job_git_input(job_id,1,run_id,
  '55700200-6000-4000-8000-000000000001', 'main', repeat('a',40)) from started_run$$,
  'attempt pin uses its exact worker git input');
select throws_ok($$select public.resolve_factory_run_mcp_credentials(
    '55700200-1000-4000-8000-000000000001',job_id,run_id,1) from started_run$$,
  '42501', null, 'an active run cannot resolve bearer material before pinning its attempt');
select ok((select public.pin_session_attempt_manifest(job_id,run_id,1,repeat('b',64),24,3,
  repeat('a',40),'[]','workerd',7,'high',null) from started_run), 'the worker pins only the admitted scope');

select ok(has_function_privilege('service_role',
  'public.resolve_factory_run_mcp_credentials(uuid,uuid,uuid,integer)', 'execute')
  and not has_function_privilege('authenticated',
    'public.resolve_factory_run_mcp_credentials(uuid,uuid,uuid,integer)', 'execute')
  and not has_function_privilege('anon',
    'public.resolve_factory_run_mcp_credentials(uuid,uuid,uuid,integer)', 'execute'),
  'only service role can call the MCP resolver');
select ok(not has_table_privilege('authenticated', 'internal.factory_run_mcp_material_pins', 'select')
  and not has_table_privilege('service_role', 'internal.factory_run_mcp_material_pins', 'select'),
  'material revision pins are private even to the service-role Data API');
grant select on started_run, approved_revision, bearer_binding to service_role;
set local role service_role;
select results_eq($$select resolved.tool_revision_id,resolved.binding_id,resolved.material_revision,resolved.encrypted_value
    from started_run cross join lateral public.resolve_factory_run_mcp_credentials(
      '55700200-1000-4000-8000-000000000001',job_id,run_id,1) resolved$$,
  $$select approved_revision.id,bearer_binding.id,2::bigint,'synthetic-encryption-version-2'::text
    from approved_revision cross join bearer_binding$$,
  'service role receives only the canonical bearer revision and its encrypted material');
select is((select count(*) from started_run cross join lateral public.resolve_factory_run_mcp_credentials(
    '55700200-1000-4000-8000-000000000001',job_id,run_id,1)),
  1::bigint, 'repeat resolution of the same material in a current attempt is idempotent');
reset role;
select throws_ok($$select public.resolve_factory_run_mcp_credentials(
    '55700200-1000-4000-8000-000000000001',job_id,run_id,2) from started_run$$,
  '42501', null, 'the wrong attempt cannot resolve bearer material');
select throws_ok($$select public.resolve_factory_run_mcp_credentials(
    '55700200-1000-4000-8000-000000000001',started_run.job_id,queued_run.run_id,1)
    from started_run cross join queued_run$$,
  '42501', null, 'a job cannot borrow another run to resolve bearer material');
select throws_ok($$select public.resolve_factory_run_mcp_credentials(
    '55700200-1000-4000-8000-000000000099',job_id,run_id,1) from started_run$$,
  '42501', null, 'a different workspace cannot resolve bearer material');

create temp table opencode_binding as
select * from pg_temp.bind_provider('55700200-9000-4000-8000-000000000004', 'opencode', 'opencode');
create temp table cursor_binding as
select * from pg_temp.bind_provider('55700200-9000-4000-8000-000000000005', 'cursor');

select throws_ok($$select pg_temp.activate_mcp_fixture(4, pg_temp.mcp_definition(
    p_provider => 'opencode', p_model => 'openai/gpt-5.5',
    p_credential_binding_id => (select id from opencode_binding)))$$,
  'PT422', 'A current scoped credential binding is required.',
  'OpenCode cannot substitute an upstream model provider outside the approved binding');

create function pg_temp.pin_adapter_mcp_attempt(
  p_activation bigint, p_provider text, p_model text, p_binding_id uuid
) returns table(job_id uuid, run_id uuid) language plpgsql as $$
declare admitted record;
begin
  perform pg_temp.activate_mcp_fixture(p_activation, pg_temp.mcp_definition(
    p_provider => p_provider, p_model => p_model, p_credential_binding_id => p_binding_id));
  select * into strict admitted from pg_temp.admit_mcp('MCP ' || p_provider, p_provider, p_model);
  job_id := admitted.job_id;
  run_id := pg_temp.start_mcp(admitted.session_id, job_id, p_provider, p_model);
  perform public.pin_session_job_git_input(job_id,1,run_id,
    '55700200-6000-4000-8000-000000000001', 'main', repeat('a',40));
  if not public.pin_session_attempt_manifest(job_id,run_id,1,repeat('b',64),24,3,
    repeat('a',40),'[]','node',7,null,null) then
    raise exception 'The provider MCP fixture could not pin its admitted attempt.';
  end if;
  return next;
end;
$$;

create temp table opencode_attempt as select * from pg_temp.pin_adapter_mcp_attempt(
  4, 'opencode', 'opencode/gpt-5.6-sol', (select id from opencode_binding));
create temp table cursor_attempt as select * from pg_temp.pin_adapter_mcp_attempt(
  5, 'cursor', 'composer-2', (select id from cursor_binding));
grant select on opencode_attempt, opencode_binding, cursor_attempt to service_role;
set local role service_role;
select results_eq($$select resolved.binding_id,resolved.encrypted_value
    from opencode_attempt cross join lateral public.resolve_factory_run_credential(
      '55700200-1000-4000-8000-000000000001',job_id,run_id,1) resolved$$,
  $$select opencode_binding.id,'synthetic-opencode-material'::text from opencode_binding$$,
  'the OpenCode attempt resolves the separately scoped upstream model credential');
select results_eq($$select resolved.tool_revision_id,resolved.binding_id,resolved.material_revision,resolved.encrypted_value
    from opencode_attempt cross join lateral public.resolve_factory_run_mcp_credentials(
      '55700200-1000-4000-8000-000000000001',job_id,run_id,1) resolved$$,
  $$select approved_revision.id,bearer_binding.id,2::bigint,'synthetic-encryption-version-2'::text
    from approved_revision cross join bearer_binding$$,
  'the exact OpenCode attempt can resolve its approved MCP bearer independently of its model credential');
select throws_ok($$select public.resolve_factory_run_mcp_credentials(
    '55700200-1000-4000-8000-000000000001',job_id,run_id,1) from cursor_attempt$$,
  '42501', 'The worker does not own a current scoped MCP attempt.',
  'a pinned Cursor attempt cannot release MCP credentials while Cursor readiness is unsupported');
reset role;
select pg_temp.activate_mcp_fixture(6, pg_temp.mcp_definition());

update public.workspace_secrets set encrypted_value = 'synthetic-encryption-version-3'
  where key = 'TEST_MCP_BEARER';
select throws_ok($$select public.resolve_factory_run_mcp_credentials(
    '55700200-1000-4000-8000-000000000001',job_id,run_id,1) from started_run$$,
  'PT409', null, 'rotated material cannot replace the revision reserved for a running attempt');

select ok((select (public.revoke_factory_mcp_secret_binding(workspace_id,factory_id,
  '55700200-0000-4000-8000-000000000001',id)).revoked_at is not null from bearer_binding),
  'bearer revocation records a decision without deleting the reference');
select throws_ok($$select * from pg_temp.admit_mcp('Revoked bearer MCP fixture')$$, '42501', null,
  'revoked bearer reference blocks new session admission');
select throws_ok($$select pg_temp.start_mcp(session_id,job_id) from queued_run$$, '42501', null,
  'attempt start rechecks the bearer reference after admission');
select throws_ok($$select public.resolve_factory_run_mcp_credentials(
    '55700200-1000-4000-8000-000000000001',job_id,run_id,1) from started_run$$,
  '42501', null, 'an already pinned attempt cannot resolve a revoked bearer reference');
select ok((select (public.revoke_factory_mcp_server_revision(workspace_id,factory_id,
  '55700200-0000-4000-8000-000000000001',server_id,id)).revoked_at is not null from approved_revision),
  'endpoint revision revocation preserves the historical decision');
select throws_ok($$select * from pg_temp.admit_mcp('Revoked endpoint MCP fixture')$$, 'PT422', null,
  'revoked endpoint revision blocks new session admission');
select throws_ok($$select pg_temp.start_mcp(session_id,job_id) from queued_run$$, 'PT422', null,
  'attempt start rechecks the endpoint revision after admission');
select pg_temp.activate_mcp_fixture(7, pg_temp.mcp_definition('lookup', true));
create temp table granted_queue as select * from pg_temp.admit_mcp('Public MCP fixture');
create temp table public_attempt as
  select session_id,job_id,pg_temp.start_mcp(session_id,job_id) run_id
  from pg_temp.admit_mcp('Running public MCP fixture');
select public.pin_session_job_git_input(job_id,1,run_id,
  '55700200-6000-4000-8000-000000000001','main',repeat('a',40)) from public_attempt;
select public.pin_session_attempt_manifest(job_id,run_id,1,repeat('b',64),24,3,
  repeat('a',40),'[]','node',7,'high',null) from public_attempt;
select is((select count(*) from public_attempt cross join lateral public.resolve_factory_run_mcp_credentials(
    '55700200-1000-4000-8000-000000000001',job_id,run_id,1)),
  0::bigint, 'an exact unauthenticated-only manifest passes the authorization check with no bearer material');
create function pg_temp.resolve_after_provider_revocation(p_job_id uuid, p_run_id uuid) returns void language plpgsql as $$
begin
  perform public.resolve_factory_run_credential('55700200-1000-4000-8000-000000000001',p_job_id,p_run_id,1);
  perform public.revoke_factory_secret_binding(workspace_id,factory_id,
    '55700200-0000-4000-8000-000000000001',id,version) from provider_binding;
  perform public.resolve_factory_run_mcp_credentials('55700200-1000-4000-8000-000000000001',p_job_id,p_run_id,1);
end;
$$;
select throws_ok($$select pg_temp.resolve_after_provider_revocation(job_id,run_id) from public_attempt$$,
  'PT422', 'A current scoped credential binding is required.',
  'the last credential check catches provider binding revocation even for an unauthenticated MCP scope');
select ok((select (public.revoke_factory_execution_grant(workspace_id, factory_id,
  '55700200-0000-4000-8000-000000000001', id, version)).revoked_at is not null from grant_v1),
  'the execution grant can revoke an otherwise approved server and operation');
select throws_ok($$select * from pg_temp.admit_mcp('Revoked execution grant MCP fixture')$$, '42501', null,
  'a revoked grant denies session admission even when the server revision remains approved');
select throws_ok($$select pg_temp.start_mcp(session_id,job_id) from granted_queue$$, '42501', null,
  'attempt start rechecks the grant even when the server revision remains approved');
select throws_ok($$select public.resolve_factory_run_mcp_credentials(
    '55700200-1000-4000-8000-000000000001',job_id,run_id,1) from public_attempt$$,
  '42501', null, 'the resolver rechecks a revoked grant even when the manifest has no bearer material');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select is((select count(*) from public.factory_mcp_servers), 2::bigint,
  'a factory manager can inspect approved server identities');
select is((select count(id) from public.factory_mcp_secret_bindings), 1::bigint,
  'a factory manager can inspect safe bearer reference IDs');
set local request.jwt.claim.sub = '55700200-0000-4000-8000-000000000002';
select is((select count(*) from public.factory_mcp_servers), 0::bigint,
  'an ordinary participant cannot list approved server inventory');
select is((select public.get_run_mcp_manifest('55700200-1000-4000-8000-000000000001',run_id)
  from empty_run), null::jsonb, 'an empty canonical factory definition gives runs no ambient tools');
select is((select public.get_run_mcp_manifest('55700200-1000-4000-8000-000000000001',run_id)->>'kind'
  from queued_run), 'planned', 'an unclaimed run can show its admitted scope before it pins an attempt');
select ok((select public.get_run_mcp_manifest('55700200-1000-4000-8000-000000000001',run_id,1)
    #>>'{manifest,servers,0,endpoint}' = 'https://fixture.example.test/mcp' from started_run),
  'an authorized session reader can inspect the exact historical endpoint after revocation');
select is((select public.get_run_mcp_manifest('55700200-1000-4000-8000-000000000001',run_id,1)
    #>'{manifest,servers,0,operations}' from started_run), '["search"]'::jsonb,
  'the exact attempt receipt contains only the selected operation');
select is((select public.get_run_mcp_manifest('55700200-1000-4000-8000-000000000001',run_id,1)->>'kind'
  from started_run), 'pinned', 'the inspector identifies the exact attempt receipt');
select is((select public.get_run_mcp_manifest('55700200-1000-4000-8000-000000000001',run_id)
  from started_run), null::jsonb, 'a claimed run requires its exact attempt number');
select is((select public.get_run_mcp_manifest('55700200-1000-4000-8000-000000000001',run_id,99)
  from started_run), null::jsonb, 'inspection cannot borrow a different attempt identity');
set local request.jwt.claim.sub = '55700200-0000-4000-8000-000000000003';
select is((select public.get_run_mcp_manifest('55700200-1000-4000-8000-000000000001',run_id,1)
  from started_run), null::jsonb, 'an outsider cannot inspect a scoped attempt');

reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '55700200-0000-4000-8000-000000000001';

create temp table named_factory as select factory.* from principal
cross join lateral public.create_factory(principal.workspace_id,
  '55700200-0000-4000-8000-000000000001','Release factory','release-factory') factory;
insert into auth.users(id,email) values ('55700200-0000-4000-8000-000000000004','release-factory-invoker@example.test');
insert into public.workspace_members(id,workspace_id,user_id,kind,role)
select '55700200-2000-4000-8000-000000000004',workspace_id,'55700200-0000-4000-8000-000000000004','human','member'
from named_factory;
select public.grant_factory_membership(workspace_id,id,'55700200-0000-4000-8000-000000000001',
  '55700200-2000-4000-8000-000000000004','member') from named_factory;
select public.revoke_factory_membership(workspace_id,factory_id,'55700200-0000-4000-8000-000000000001',
  '55700200-2000-4000-8000-000000000004') from principal;

insert into public.pipelines(id,workspace_id,factory_id,name)
select '55700200-4000-4000-8000-000000000002',workspace_id,id,'Named pipeline' from named_factory;
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name)
select '55700200-5000-4000-8000-000000000002','55700200-4000-4000-8000-000000000002',
  workspace_id,1,'release','Release' from named_factory;
insert into public.github_repositories(id,workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch)
select repository.id,factory.workspace_id,factory.id,'55700200-7000-4000-8000-000000000001',
  repository.repo_id,repository.name,'fixture/' || repository.name,true,'https://github.com/fixture/' || repository.name,'main'
from named_factory factory cross join (values
  ('55700200-6000-4000-8000-000000000002'::uuid,55700202,'release-writer'),
  ('55700200-6000-4000-8000-000000000003'::uuid,55700203,'release-context')
) repository(id,repo_id,name);
insert into public.workspace_secrets(id,workspace_id,key,encrypted_value)
select secret.id, factory.workspace_id, secret.key, secret.material from named_factory factory cross join (values
  ('55700200-9000-4000-8000-000000000006'::uuid,'RELEASE_MODEL_KEY','synthetic-release-model'),
  ('55700200-9000-4000-8000-000000000007'::uuid,'RELEASE_MCP_KEY','synthetic-release-mcp')
) secret(id,key,material);

create temp table named_principal as select service.* from named_factory factory cross join lateral public.create_service_principal(
  factory.workspace_id,factory.id,'55700200-0000-4000-8000-000000000001','Release service','release-service') service;
create temp table named_prompt as select prompt.* from named_factory factory cross join lateral public.create_factory_agent(
  factory.workspace_id,factory.id,'55700200-0000-4000-8000-000000000001','Release agent','release-agent','Release fixture prompt') prompt;
create temp table named_tool as select tool.* from named_factory factory cross join lateral public.create_factory_mcp_server(
  factory.workspace_id,factory.id,'55700200-0000-4000-8000-000000000001','Release tool','release-tool',
  'https://release.example.test/mcp',array['lookup'],'bearer') tool;

create function pg_temp.approve_named_grant(p_writer uuid,p_context uuid) returns public.factory_execution_grants
language sql as $$
  select public.approve_factory_execution_grant(service.workspace_id,service.factory_id,
    '55700200-0000-4000-8000-000000000001',service.id,p_writer,array[p_context],
    array[named_tool.id::text || '/lookup',public_revision.id::text || '/lookup'],
    '55700200-8000-4000-8000-000000000001','55700200-2000-4000-8000-000000000001',
    statement_timestamp() + interval '10 minutes',0)
  from named_principal service cross join named_tool cross join public_revision;
$$;
select throws_ok($$select pg_temp.approve_named_grant('55700200-6000-4000-8000-000000000001','55700200-6000-4000-8000-000000000003')$$,
  '22023',null,'the named factory cannot grant its sibling writer');
select throws_ok($$select pg_temp.approve_named_grant('55700200-6000-4000-8000-000000000002','55700200-6000-4000-8000-000000000001')$$,
  '22023',null,'the named factory cannot grant its sibling repository as context');
create temp table named_grant as select * from pg_temp.approve_named_grant(
  '55700200-6000-4000-8000-000000000002','55700200-6000-4000-8000-000000000003');
select throws_ok($$select public.create_factory_secret_binding(g.workspace_id,g.factory_id,
  '55700200-0000-4000-8000-000000000001',g.id,g.version,prompt.agent_id,'codex',binding.workspace_secret_id)
  from named_grant g cross join named_prompt prompt cross join opencode_binding binding$$,
  'PT409',null,'a named factory cannot claim active model material reserved in its sibling');
select throws_ok($$select public.create_factory_mcp_secret_binding(g.workspace_id,g.factory_id,
  '55700200-0000-4000-8000-000000000001',g.id,g.version,prompt.agent_id,tool.id,binding.workspace_secret_id)
  from named_grant g cross join named_prompt prompt cross join named_tool tool cross join opencode_binding binding$$,
  'PT409',null,'a named tool cannot claim active model material reserved in its sibling');
create temp table named_model_binding as select binding.* from named_grant g cross join named_prompt prompt
cross join lateral public.create_factory_secret_binding(g.workspace_id,g.factory_id,
  '55700200-0000-4000-8000-000000000001',g.id,g.version,prompt.agent_id,'codex',
  '55700200-9000-4000-8000-000000000006') binding;
create temp table named_mcp_binding as select binding.* from named_grant g cross join named_prompt prompt cross join named_tool tool
cross join lateral public.create_factory_mcp_secret_binding(g.workspace_id,g.factory_id,
  '55700200-0000-4000-8000-000000000001',g.id,g.version,prompt.agent_id,tool.id,
  '55700200-9000-4000-8000-000000000007') binding;

create temp table named_definition as
select jsonb_build_object(
  'schemaVersion',1,'kind','serial','pipelineId','55700200-4000-4000-8000-000000000002',
  'repositoryId',g.github_repository_id,'readContextRepositoryIds',to_jsonb(g.read_context_repository_ids),
  'toolIds',jsonb_build_array(tool.id::text || '/lookup'), 'executionPolicyRevisionId',g.execution_policy_revision_id,
  'executionGrant',jsonb_build_object('id',g.id,'version',g.version),'credentialBindingId',model.id,
  'implementationAgent',jsonb_build_object('agentId',prompt.agent_id,'promptRevisionId',prompt.id,
    'promptMd',prompt.prompt_md,'promptSha256',prompt.prompt_sha256),
  'sandboxProvider','e2b','agent',jsonb_build_object('provider','codex','model','gpt-5.5'),
  'stages',jsonb_build_array(jsonb_build_object('id','55700200-5000-4000-8000-000000000002','slug','release','name','Release')),
  'mcpManifest',jsonb_build_object('agentId',prompt.agent_id,'servers',jsonb_build_array(jsonb_build_object(
      'toolRevisionId',tool.id,'serverId',tool.server_id,'serverSlug','release-tool','revisionNumber',tool.revision_number,
      'endpoint',tool.endpoint,'operations',jsonb_build_array('lookup'),
      'auth',jsonb_build_object('kind','bearer','secretBindingId',credential.id))))
) body from named_grant g cross join named_prompt prompt cross join named_tool tool
cross join named_model_binding model cross join named_mcp_binding credential;

create function pg_temp.activate_named_factory(p_definition jsonb) returns uuid language sql as $$
  with revision as (
    insert into public.factory_definition_revisions(workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
    select workspace_id,id,1,p_definition::text,encode(sha256(convert_to(p_definition::text,'UTF8')),'hex'),
      '55700200-0000-4000-8000-000000000001' from named_factory
    returning workspace_id,factory_id,id,created_by
  )
  insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
  select workspace_id,factory_id,id,1,created_by from revision returning revision_id;
$$;
select throws_ok($$select pg_temp.activate_named_factory(body || jsonb_build_object(
  'toolIds',jsonb_build_array(tool.id::text || '/lookup'),
  'mcpManifest',jsonb_set(body->'mcpManifest','{servers}',jsonb_build_array(jsonb_build_object(
    'toolRevisionId',tool.id,'serverId',tool.server_id,'serverSlug','fixture-public','revisionNumber',tool.revision_number,
    'endpoint',tool.endpoint,'operations',jsonb_build_array('lookup'),'auth',jsonb_build_object('kind','none'))))))
  from named_definition cross join public_revision tool$$,
  'PT422','A selected MCP revision is unavailable or revoked in this factory.',
  'a grant naming a real sibling operation cannot activate that sibling tool');
select throws_ok($$select pg_temp.activate_named_factory(jsonb_set(body,'{credentialBindingId}',to_jsonb(binding.id)))
  from named_definition cross join opencode_binding binding$$,
  'PT422','A current scoped credential binding is required.','a named definition cannot borrow a sibling model binding ID');
select throws_ok($$select pg_temp.activate_named_factory(jsonb_set(body,'{mcpManifest,servers,0,auth,secretBindingId}',to_jsonb(binding.id)))
  from named_definition cross join bearer_binding binding$$,
  '42501','The MCP bearer binding is unavailable for this grant, agent, and revision.',
  'an approved named tool cannot borrow a sibling MCP binding ID');
create temp table named_activation as select pg_temp.activate_named_factory(body) as revision_id from named_definition;

-- The public creation RPC selects the default factory. Seed the named admission through its guarded tables.
create function pg_temp.queue_named_factory(p_number integer) returns table(session_id uuid,job_id uuid,run_id uuid)
language plpgsql as $$
declare saved_session public.sessions; saved_job uuid; saved_run uuid; revision public.factory_definition_revisions;
begin
  select stored.* into strict revision from public.factory_definition_revisions stored
    join named_activation active on active.revision_id = stored.id;
  insert into public.sessions(workspace_id,factory_id,number,title,prompt_md,creator_member_id,pipeline_id,
    current_stage_id,phase_status,github_repository_id,factory_definition_provenance,factory_definition_revision_id,
    execute_pinned_definition,execution_policy_revision_id)
  values (revision.workspace_id,revision.factory_id,p_number,'Named factory qualification','Release fixture input',
    '55700200-2000-4000-8000-000000000004','55700200-4000-4000-8000-000000000002',
    '55700200-5000-4000-8000-000000000002','in_progress','55700200-6000-4000-8000-000000000002',
    'pinned',revision.id,true,'55700200-8000-4000-8000-000000000001') returning * into saved_session;
  insert into public.session_factory_admission_inputs(session_id,workspace_id,factory_id,activation_number,definition_revision_id,
    definition_digest,pipeline_id,github_repository_id,selected_stage_ids,execution_policy_revision_id,model_provider,model_name,
    title_sha256,prompt_sha256,original_title,original_prompt_md)
  values (saved_session.id,revision.workspace_id,revision.factory_id,1,revision.id,revision.canonical_digest,
    saved_session.pipeline_id,saved_session.github_repository_id,array[saved_session.current_stage_id],saved_session.execution_policy_revision_id,
    'codex','gpt-5.5',encode(sha256(convert_to(saved_session.title,'UTF8')),'hex'),
    encode(sha256(convert_to(saved_session.prompt_md,'UTF8')),'hex'),saved_session.title,saved_session.prompt_md);
  insert into public.session_selected_stages(session_id,workspace_id,stage_id)
  values (saved_session.id,revision.workspace_id,saved_session.current_stage_id);
  insert into public.agent_jobs(workspace_id,session_id,requested_by_member_id,stage_id,stage_slug,stage_name,trigger_type,status,dedupe_key)
  values (revision.workspace_id,saved_session.id,saved_session.creator_member_id,saved_session.current_stage_id,
    'release','Release','assignment','queued','qualification:' || saved_session.id::text) returning id into saved_job;
  insert into public.agent_runs(workspace_id,session_id,agent_job_id,triggered_by_member_id,stage_id,stage_slug,stage_name,
    run_type,model_provider,model_name,status)
  values (revision.workspace_id,saved_session.id,saved_job,saved_session.creator_member_id,saved_session.current_stage_id,
    'release','Release','code','codex','gpt-5.5','queued') returning id into saved_run;
  return query select saved_session.id,saved_job,saved_run;
end;
$$;

update public.agent_jobs set status = 'canceled' where status = 'queued';
create temp table named_node as select * from pg_temp.queue_named_factory(901);
select is((select id from public.claim_next_agent_job(200)),(select job_id from named_node),
  'Node claims a named factory job after the default grant is revoked');
create temp table named_workerd as select * from pg_temp.queue_named_factory(902);
create temp table named_dispatch as select * from public.claim_next_worker_dispatch(200,200,300000);
select is((select job_id from named_dispatch),(select job_id from named_workerd),
  'native dispatch claims its own named factory job after the default grant is revoked');
select ok((select public.begin_worker_dispatch(job_id,attempt_count,workflow_id) from named_dispatch),
  'native dispatch starts the exact claimed attempt');

create temp table named_runs as select 'node'::text as runtime,node.* from named_node node
union all select 'workerd',native.* from named_workerd native;
select ok((select bool_and(public.start_session_job_attempt(f.job_id,1,s.current_stage_id,s.current_artifact_version,
  'codex','gpt-5.5','code','wallie/m03-qualification-' || f.job_id::text) = f.run_id)
  from named_runs f join public.sessions s on s.id = f.session_id),
  'both workers begin exactly their authorized named-factory attempt');
select lives_ok($$select public.pin_session_job_git_input(job_id,1,run_id,
  '55700200-6000-4000-8000-000000000002','main',repeat('c',40)) from named_runs$$,
  'both named attempts pin the authorized writer and checkout SHA');
select ok((select bool_and(public.pin_session_attempt_manifest(job_id,run_id,1,repeat('d',64),24,3,
  repeat('c',40),'[]',runtime,7,'high',null)) from named_runs),
  'both worker claim paths freeze the same named configuration with their own runtime');
select results_eq($$select f.runtime,r.binding_id,r.encrypted_value from named_runs f cross join named_factory factory
  cross join lateral public.resolve_factory_run_credential(factory.workspace_id,f.job_id,f.run_id,1) r order by f.runtime$$,
  $$select f.runtime,binding.id,'synthetic-release-model'::text from named_runs f cross join named_model_binding binding order by f.runtime$$,
  'both workers can resolve only the named model credential');
select results_eq($$select f.runtime,r.tool_revision_id,r.binding_id,r.encrypted_value from named_runs f cross join named_factory factory
  cross join lateral public.resolve_factory_run_mcp_credentials(factory.workspace_id,f.job_id,f.run_id,1) r order by f.runtime$$,
  $$select f.runtime,tool.id,binding.id,'synthetic-release-mcp'::text from named_runs f cross join named_tool tool
    cross join named_mcp_binding binding order by f.runtime$$,'both workers can resolve only the approved named tool credential');

select public.save_factory_agent_prompt_revision(workspace_id,factory_id,'55700200-0000-4000-8000-000000000001',
  agent_id,revision_number,'Updated prompt for future activation') from named_prompt;
create temp table named_queued as select * from pg_temp.queue_named_factory(903);
create temp table named_queued_native as select * from pg_temp.queue_named_factory(904);
update public.agent_jobs set scheduled_at = now() + interval '1 hour'
where id = (select job_id from named_queued_native);
select is((select (public.revoke_factory_execution_grant(workspace_id,factory_id,
  '55700200-0000-4000-8000-000000000001',id,version)).version from named_grant),2::bigint,
  'revocation advances the exact named grant version');
select throws_ok($$select pg_temp.queue_named_factory(905)$$,'42501',null,
  'the named admission fence rejects new sessions after revocation');
select is((select id from public.claim_next_agent_job(200)),(select job_id from named_queued),
  'existing queued work still requires the attempt authorization fence');
select throws_ok($$select public.start_session_job_attempt(f.job_id,1,s.current_stage_id,s.current_artifact_version,
  'codex','gpt-5.5','code','wallie/revoked-named-attempt') from named_queued f join public.sessions s on s.id = f.session_id$$,
  '42501',null,'Node cannot start a queued named attempt after revocation');
update public.agent_jobs set scheduled_at = null where id = (select job_id from named_queued_native);
select is((select job_id from public.claim_next_worker_dispatch(200,200,300000)),(select job_id from named_queued_native),
  'native dispatch also reaches the attempt authorization fence');
select throws_ok($$select public.start_session_job_attempt(f.job_id,1,s.current_stage_id,s.current_artifact_version,
  'codex','gpt-5.5','code','wallie/revoked-native-attempt') from named_queued_native f join public.sessions s on s.id = f.session_id$$,
  '42501',null,'native dispatch cannot start a queued named attempt after revocation');
select throws_ok(format('select public.resolve_factory_run_credential(%L,%L,%L,1)',factory.workspace_id,f.job_id,f.run_id),
  '42501',null,f.runtime || ' cannot obtain model material after grant revocation') from named_runs f cross join named_factory factory;
select throws_ok(format('select public.resolve_factory_run_mcp_credentials(%L,%L,%L,1)',factory.workspace_id,f.job_id,f.run_id),
  '42501',null,f.runtime || ' cannot obtain tool material after grant revocation') from named_runs f cross join named_factory factory;

grant select on named_runs,named_factory,named_prompt,named_activation,named_grant,named_model_binding,named_tool to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '55700200-0000-4000-8000-000000000004';
select results_eq($$select profile->>'workerRuntime',profile->>'factoryId',profile->>'definitionRevisionId',
    profile->>'agentId',profile->>'promptRevisionId',profile->>'invokingMemberId',profile->>'triggeredByMemberId',profile->'authority'
  from named_runs f cross join named_factory factory
  cross join lateral public.get_run_execution_profile(factory.workspace_id,f.run_id,1) profile order by f.runtime$$,
  $$select f.runtime,factory.id::text,activation.revision_id::text,prompt.agent_id::text,prompt.id::text,
    '55700200-2000-4000-8000-000000000004'::text,'55700200-2000-4000-8000-000000000004'::text,
    jsonb_build_object('kind','service','grantId',g.id,'grantVersion',g.version,'servicePrincipalId',g.service_principal_id,'bindingId',binding.id)
  from named_runs f cross join named_factory factory cross join named_prompt prompt cross join named_activation activation
  cross join named_grant g cross join named_model_binding binding order by f.runtime$$,
  'both historical runs preserve their exact factory, revision, prompt, actors and credential authority after edits and revocation');
select ok((select bool_and(public.get_run_mcp_manifest(factory.workspace_id,f.run_id,1)
    #>>'{manifest,servers,0,toolRevisionId}' = tool.id::text)
  from named_runs f cross join named_factory factory cross join named_tool tool),
  'the authorized inspector retains the exact named tool revision after revocation');
select is((select public.get_run_execution_profile(factory.workspace_id,f.run_id,2)
  from named_runs f cross join named_factory factory where f.runtime = 'node'),null::jsonb,
  'an incorrect attempt cannot borrow pinned named-factory identities');
set local request.jwt.claim.sub = '55700200-0000-4000-8000-000000000002';
select ok((select bool_and(public.get_run_execution_profile(factory.workspace_id,f.run_id,1) is null
  and public.get_run_mcp_manifest(factory.workspace_id,f.run_id,1) is null)
  from named_runs f cross join named_factory factory),
  'a sibling-only participant cannot inspect either exact named attempt');

select * from finish();
rollback;
