begin;
create extension if not exists pgtap with schema extensions;
select plan(70);
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
   'LINEAR_API_KEY','synthetic-integration-material','...linear');

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
create function pg_temp.bind_provider(p_source uuid)
returns public.factory_secret_bindings language sql as $$
  select public.create_factory_secret_binding(grant_v1.workspace_id, grant_v1.factory_id,
    '55700200-0000-4000-8000-000000000001', grant_v1.id, 1, fixture_agent.id, 'codex', p_source)
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
  p_operation text default 'search', p_public boolean default false, p_include_tools boolean default true
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
    'credentialBindingId', provider_binding.id,
    'implementationAgent', jsonb_build_object('agentId', agent.id, 'promptRevisionId', agent.revision_id,
      'promptMd', agent.prompt_md, 'promptSha256', agent.prompt_sha256),
    'sandboxProvider', 'e2b', 'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5'),
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

create function pg_temp.admit_mcp(p_label text)
returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language sql as $$
  select * from public.create_session_with_first_job(
    '55700200-1000-4000-8000-000000000001', '55700200-2000-4000-8000-000000000002',
    p_label, 'MCP manifest fixture', 'codex', 'gpt-5.5',
    session_github_repository_id => '55700200-6000-4000-8000-000000000001');
$$;
create temp table empty_run as select * from pg_temp.admit_mcp('Empty MCP fixture');
select lives_ok($$select pg_temp.activate_mcp_fixture(3, pg_temp.mcp_definition())$$,
  'a canonical reference scoped to exact revision, operation, grant and agent can activate');
create temp table admitted_run as select * from pg_temp.admit_mcp('Approved MCP fixture');
create temp table queued_run as select * from pg_temp.admit_mcp('Queued MCP fixture');
grant select on empty_run, queued_run to authenticated;

create function pg_temp.start_mcp(p_session uuid, p_job uuid)
returns uuid language plpgsql as $$
declare owner public.sessions;
begin
  select * into strict owner from public.sessions where id = p_session;
  update public.agent_jobs set git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()),
    status = 'running', attempt_count = 1 where id = p_job;
  return public.start_session_job_attempt(p_job, 1, owner.current_stage_id, owner.current_artifact_version,
    'codex', 'gpt-5.5', 'code', 'wallie/mcp-fixture-' || p_job::text);
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
select pg_temp.activate_mcp_fixture(4, pg_temp.mcp_definition('lookup', true));
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

select * from finish();
rollback;
