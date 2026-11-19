begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '55600200-0000-4000-8000-000000000001';

select public.set_git_continuity_release(true, revision, 'Factory scoped credential fixture')
from public.get_git_continuity_release_state() where not enabled;

insert into auth.users(id, email) values
  ('55600200-0000-4000-8000-000000000001', 'credential-binding-payer@example.test'),
  ('55600200-0000-4000-8000-000000000002', 'credential-binding-invoker@example.test');
insert into public.workspaces(id, slug, name) values
  ('55600200-1000-4000-8000-000000000001', 'credential-binding-test', 'Service execution');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  ('55600200-2000-4000-8000-000000000001', '55600200-1000-4000-8000-000000000001',
   '55600200-0000-4000-8000-000000000001', 'human', 'owner'),
  ('55600200-2000-4000-8000-000000000002', '55600200-1000-4000-8000-000000000001',
   '55600200-0000-4000-8000-000000000002', 'human', 'member');
insert into public.pipelines(id, workspace_id, name, is_default) values
  ('55600200-4000-4000-8000-000000000001', '55600200-1000-4000-8000-000000000001', 'Pipeline', true);
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name) values
  ('55600200-5000-4000-8000-000000000001', '55600200-4000-4000-8000-000000000001',
   '55600200-1000-4000-8000-000000000001', 1, 'service-build', 'Build');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id,
  target_type, target_name, permissions) values
  ('55600200-7000-4000-8000-000000000001', '55600200-1000-4000-8000-000000000001',
   55600201, 'https://github.com/settings/installations/55600201', 55600, 'Organization', 'fixture',
   '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
select ('55600200-6000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid,
  '55600200-1000-4000-8000-000000000001', '55600200-7000-4000-8000-000000000001',
  55600200 + slot, name, 'fixture/' || name, true, 'https://github.com/fixture/' || name, 'main'
from (values (1, 'writer'), (2, 'read-context'), (3, 'outside-grant')) as repository(slot, name);
insert into public.execution_policy_revisions(id, workspace_id, revision, requirements, created_by) values
  ('55600200-8000-4000-8000-000000000001', '55600200-1000-4000-8000-000000000001', 1,
   '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":300000,"maxTotalTokens":10000,"maxCostUsd":5}',
   '55600200-0000-4000-8000-000000000001');

create temp table principal as
select principal.* from public.factories factory
cross join lateral public.create_service_principal(factory.workspace_id, factory.id,
  '55600200-0000-4000-8000-000000000001', 'Fixture service', 'fixture-service') principal
where factory.workspace_id = '55600200-1000-4000-8000-000000000001' and factory.is_default;

create function pg_temp.approve_grant(p_grant_id uuid default null, p_expected_version bigint default 0)
returns public.factory_execution_grants language sql as $$
  select public.approve_factory_execution_grant(principal.workspace_id, principal.factory_id,
    '55600200-0000-4000-8000-000000000001', principal.id, '55600200-6000-4000-8000-000000000001',
    array['55600200-6000-4000-8000-000000000002']::uuid[], array['docs'],
    '55600200-8000-4000-8000-000000000001', '55600200-2000-4000-8000-000000000001',
    clock_timestamp() + interval '10 minutes', p_expected_version, p_grant_id)
  from principal
$$;
create temp table grant_v1 as select * from pg_temp.approve_grant();

create temp table fixture_agent as
select agent.id, revision.id as revision_id, revision.prompt_md, revision.prompt_sha256
from public.factory_agents agent
join principal on (principal.workspace_id, principal.factory_id) = (agent.workspace_id, agent.factory_id)
join public.factory_agent_prompt_revisions revision on revision.agent_id = agent.id and revision.revision_number = 1
where agent.is_default;

insert into auth.users(id,email) values ('55600200-0000-4000-8000-000000000003','credential-binding-outsider@example.test');
insert into public.workspaces(id,slug,name) values
  ('55600200-1000-4000-8000-000000000002','credential-binding-outsider','Credential test outsider');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  ('55600200-2000-4000-8000-000000000003','55600200-1000-4000-8000-000000000002',
   '55600200-0000-4000-8000-000000000003','human','owner');
insert into public.workspace_secrets(id,workspace_id,key,encrypted_value,value_preview) values
  ('55600200-9000-4000-8000-000000000001','55600200-1000-4000-8000-000000000001',
   'FACTORY_PROVIDER_KEY','synthetic-encryption-version-1','...fixture'),
  ('55600200-9000-4000-8000-000000000002','55600200-1000-4000-8000-000000000001',
   'LINEAR_API_KEY','synthetic-integration-material','...linear'),
  ('55600200-9000-4000-8000-000000000003','55600200-1000-4000-8000-000000000002',
   'OUTSIDE_KEY','synthetic-outsider-material','...outside'),
  ('55600200-9000-4000-8000-000000000005','55600200-1000-4000-8000-000000000001',
   'OPEN_CODE_PROVIDER_KEY','synthetic-opencode-material','...opencode');

create function pg_temp.attach_binding(
  p_source uuid default '55600200-9000-4000-8000-000000000001',
  p_actor uuid default '55600200-0000-4000-8000-000000000001',
  p_version bigint default 1,
  p_agent uuid default null
) returns public.factory_secret_bindings language sql as $$
  select public.create_factory_secret_binding(principal.workspace_id, principal.factory_id, p_actor,
    grant_v1.id, p_version, coalesce(p_agent, (select id from fixture_agent)), 'codex', p_source)
  from principal cross join grant_v1;
$$;

select ok(not has_function_privilege('authenticated', 'public.resolve_factory_run_credential(uuid,uuid,uuid,integer)', 'execute')
  and not has_function_privilege('anon', 'public.resolve_factory_run_credential(uuid,uuid,uuid,integer)', 'execute')
  and has_function_privilege('service_role', 'public.resolve_factory_run_credential(uuid,uuid,uuid,integer)', 'execute'),
  'resolving credential material is unavailable to browser roles');
select ok(not has_table_privilege('authenticated', 'public.factory_secret_bindings', 'select')
  and not has_table_privilege('authenticated', 'public.workspace_secrets', 'select'),
  'raw credential bindings and workspace material are unavailable to browser roles');
select throws_ok($$select pg_temp.attach_binding(p_actor => '55600200-0000-4000-8000-000000000002')$$,
  '42501', null, 'a factory participant cannot delegate a shared secret');
select throws_ok($$select pg_temp.attach_binding(p_version => 2)$$,
  'PT409', null, 'stale grant version cannot claim a secret');
select throws_ok($$select pg_temp.attach_binding(p_source => '55600200-9000-4000-8000-000000000002')$$,
  'P0002', null, 'the shared Linear integration credential cannot become an agent credential');
select throws_ok($$select pg_temp.attach_binding(p_source => '55600200-9000-4000-8000-000000000003')$$,
  'P0002', null, 'a workspace cannot delegate material owned by another workspace');

create temp table binding_v1 as select * from pg_temp.attach_binding();
select is((select version from binding_v1), 1::bigint, 'delegation assigns a stable logical binding at version one');
select is((select value_preview from public.workspace_secrets where key = 'FACTORY_PROVIDER_KEY'), null::text,
  'claiming material removes an ordinary workspace preview');
select is((select status from principal cross join lateral public.list_factory_secret_bindings(
  principal.workspace_id, principal.factory_id, '55600200-0000-4000-8000-000000000001')),
  'ready', 'authorized configuration reads derive safe readiness');
select is((select secret_key from principal cross join lateral public.list_factory_secret_bindings(
  principal.workspace_id, principal.factory_id, '55600200-0000-4000-8000-000000000001')),
  'FACTORY_PROVIDER_KEY', 'authorized rotation metadata identifies the saved key by reference');
select ok(not exists (select 1 from principal cross join lateral public.list_factory_bindable_workspace_secrets(
  principal.workspace_id, principal.factory_id, '55600200-0000-4000-8000-000000000001') candidate
  where candidate.key in ('FACTORY_PROVIDER_KEY', 'LINEAR_API_KEY', 'OUTSIDE_KEY')),
  'eligible source metadata excludes already claimed, reserved and other workspace inputs');
select ok(not exists (select 1 from principal cross join lateral public.list_factory_secret_bindings(
  principal.workspace_id, principal.factory_id, '55600200-0000-4000-8000-000000000001') metadata
  where to_jsonb(metadata) ?| array['value_preview','encrypted_value']),
  'configuration metadata returns references and rotation state only');

create temp table foreign_factory as
select sibling.* from principal cross join lateral public.create_factory(
  principal.workspace_id,'55600200-0000-4000-8000-000000000001','Sibling factory','sibling-secret-factory') sibling;
insert into public.github_repositories(id,workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch)
select '55600200-6000-4000-8000-000000000004', sibling.workspace_id, sibling.id, '55600200-7000-4000-8000-000000000001',
  55600204, 'sibling-writer', 'fixture/sibling-writer', true, 'https://github.com/fixture/sibling-writer', 'main'
from foreign_factory sibling;
create temp table foreign_principal as
select second.* from foreign_factory sibling cross join lateral public.create_service_principal(sibling.workspace_id,sibling.id,
  '55600200-0000-4000-8000-000000000001','Sibling principal','sibling-principal') second;
create temp table foreign_grant as
select approved.* from foreign_principal second cross join lateral public.approve_factory_execution_grant(
  second.workspace_id,second.factory_id,'55600200-0000-4000-8000-000000000001',second.id,
  '55600200-6000-4000-8000-000000000004','{}','{}','55600200-8000-4000-8000-000000000001',
  '55600200-2000-4000-8000-000000000001',clock_timestamp()+interval '10 minutes',0) approved;
select throws_ok($$select public.create_factory_secret_binding(
    g.workspace_id,g.factory_id,'55600200-0000-4000-8000-000000000001',g.id,g.version,
    a.id,'codex','55600200-9000-4000-8000-000000000001')
  from foreign_grant g join public.factory_agents a using (workspace_id,factory_id) where a.is_default$$,
  'PT409', null, 'a different factory and principal cannot claim already restricted material');
select throws_ok($$select pg_temp.attach_binding(
  p_agent => (select id from public.factory_agents where factory_id=(select id from foreign_factory) and is_default))$$,
  'P0002', null, 'binding cannot name an agent from a different factory');
select is((select public.check_factory_credential_binding(
    binding.workspace_id, binding.factory_id, binding.id, grant_v1.id, 2, binding.factory_agent_id,
    binding.agent_provider, 'gpt-5.5')
    from binding_v1 binding cross join grant_v1), 'grant_unavailable',
  'readiness distinguishes an obsolete grant version');

create function pg_temp.definition_for_binding(p_binding_id uuid, p_provider text default 'codex')
returns jsonb language sql as $$
  select jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', '55600200-4000-4000-8000-000000000001',
    'repositoryId', '55600200-6000-4000-8000-000000000001',
    'readContextRepositoryIds', jsonb_build_array('55600200-6000-4000-8000-000000000002'),
    'toolIds', jsonb_build_array('docs'),
    'executionPolicyRevisionId', '55600200-8000-4000-8000-000000000001',
    'executionGrant', jsonb_build_object('id', grant_v1.id, 'version', grant_v1.version),
    'credentialBindingId', p_binding_id,
    'implementationAgent', jsonb_build_object('agentId', agent.id, 'promptRevisionId', agent.revision_id,
      'promptMd', agent.prompt_md, 'promptSha256', agent.prompt_sha256),
    'sandboxProvider', 'e2b',
    'agent', jsonb_build_object('provider', p_provider, 'model', 'gpt-5.5'),
    'stages', jsonb_build_array(jsonb_build_object(
      'id', '55600200-5000-4000-8000-000000000001', 'slug', 'service-build', 'name', 'Build'))
  ) from grant_v1 cross join fixture_agent agent;
$$;

create function pg_temp.activate_binding_fixture(p_activation bigint, p_definition jsonb)
returns void language sql as $$
  with revision as (
    insert into public.factory_definition_revisions(workspace_id, factory_id, schema_version,
      definition_json, canonical_digest, created_by)
    select principal.workspace_id, principal.factory_id, 1, p_definition::text,
      encode(sha256(convert_to(p_definition::text, 'UTF8')), 'hex'), '55600200-0000-4000-8000-000000000001'
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
select throws_ok($$select pg_temp.activate_binding_fixture(1, pg_temp.definition_for_binding(gen_random_uuid()))$$,
  'PT422', null, 'activation cannot publish a missing credential reference');
select throws_ok($$select pg_temp.activate_binding_fixture(1, pg_temp.definition_for_binding(id,'cursor')) from binding_v1$$,
  'PT422', null, 'activation cannot use a credential bound to a different provider');
select lives_ok($$select pg_temp.activate_binding_fixture(1, pg_temp.definition_for_binding(id)) from binding_v1$$,
  'matching provider, principal, grant and named agent can activate the reference');
select ok((select not (definition_json like '%synthetic-encryption%' or definition_json like '%encrypted_value%')
  from public.factory_definition_revisions where workspace_id=(select workspace_id from principal) limit 1),
  'definition storage contains credential references only');

create function pg_temp.running_credential_fixture(
  p_label text, p_provider text default 'codex', p_model text default 'gpt-5.5'
)
returns table(session_id uuid, job_id uuid, run_id uuid) language plpgsql as $$
declare fixture record; owner public.sessions; started uuid;
begin
  select * into strict fixture from public.create_session_with_first_job(
    '55600200-1000-4000-8000-000000000001', '55600200-2000-4000-8000-000000000002',
    p_label, 'Scoped credential fixture', p_provider, p_model,
    session_github_repository_id => '55600200-6000-4000-8000-000000000001');
  select * into strict owner from public.sessions s where s.id = fixture.session_id;
  update public.agent_jobs j set git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()),
    status = 'running', attempt_count = 1 where j.id = fixture.job_id;
  started := public.start_session_job_attempt(fixture.job_id, 1, owner.current_stage_id, owner.current_artifact_version,
    p_provider, p_model, 'code', 'wallie/credential-fixture-' || fixture.job_id::text);
  perform public.pin_session_job_git_input(fixture.job_id, 1, started,
    '55600200-6000-4000-8000-000000000001', 'main', repeat('a', 40));
  return query select fixture.session_id, fixture.job_id, started;
end;
$$;
create function pg_temp.pin_fixture_manifest(p_job uuid, p_run uuid, p_owner uuid default null)
returns boolean language sql as $$
  select public.pin_session_attempt_manifest(p_job,p_run,1,repeat('b',64),24,3,
    repeat('a',40),'[]','workerd',7,'high',p_owner);
$$;
create temp table previous_run as select * from pg_temp.running_credential_fixture('First scoped credential run');
update public.agent_runs set sandbox_provider='e2b', sandbox_connection_revision='55600200-aa00-4000-8000-000000000001'
where id=(select run_id from previous_run);
grant select on previous_run to authenticated;
select throws_ok($$select * from previous_run p, lateral public.resolve_factory_run_credential(
    '55600200-1000-4000-8000-000000000001',p.job_id,p.run_id,1)$$,
  '42501', null, 'a running attempt cannot resolve a secret until its manifest is pinned');
select is((select pg_temp.pin_fixture_manifest(job_id,run_id,'55600200-2000-4000-8000-000000000002') from previous_run),
  false, 'service attempt manifest rejects the human invoker as credential owner');
select ok((select pg_temp.pin_fixture_manifest(job_id,run_id) from previous_run),
  'service manifest pins without a human credential owner');
create temp table previous_profile as select jsonb_build_object(
  'provider','codex','model','gpt-5.5','effort','high','maxTurns',7,
  'sandboxProvider','e2b','sandboxConnectionRevision','55600200-aa00-4000-8000-000000000001',
  'workerRuntime','workerd','definitionRevisionId',owner.factory_definition_revision_id,
  'authority',jsonb_build_object('kind','service','grantId',grant_v1.id,'grantVersion',1,
    'bindingId',binding_v1.id,'servicePrincipalId',principal.id)
) profile
from previous_run join public.sessions owner on owner.id=previous_run.session_id
cross join grant_v1 cross join binding_v1 cross join principal;
grant select on previous_profile to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '55600200-0000-4000-8000-000000000002';
select is(public.get_run_execution_profile('55600200-1000-4000-8000-000000000001',run_id,1)->'authority',
  '{"kind":"unavailable"}'::jsonb, 'a service attempt without its credential receipt cannot claim service authority')
from previous_run;
reset role;
set local request.jwt.claim.sub = '55600200-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'service_role';
select throws_ok($$select * from previous_run p, lateral public.resolve_factory_run_credential(
    '55600200-1000-4000-8000-000000000001',p.job_id,p.run_id,2)$$,
  '42501', null, 'an unrelated attempt count cannot resolve the credential');
select throws_ok($$select * from previous_run p, lateral public.resolve_factory_run_credential(
    '55600200-1000-4000-8000-000000000002',p.job_id,p.run_id,1)$$,
  '42501', null, 'changing the workspace cannot resolve a running attempt credential');
select throws_ok($$select * from previous_run p, lateral public.resolve_factory_run_credential(
    '55600200-1000-4000-8000-000000000001',p.job_id,gen_random_uuid(),1)$$,
  '42501', null, 'changing the run cannot borrow the owned attempt credential');

create function pg_temp.resolve_fixture(p_job uuid,p_run uuid)
returns table(encrypted_value text,binding_id uuid,binding_version bigint,material_revision bigint,
  service_principal_id uuid,agent_provider text) language sql as $$
  select * from public.resolve_factory_run_credential('55600200-1000-4000-8000-000000000001',p_job,p_run,1);
$$;
select ok((select material.encrypted_value = 'synthetic-encryption-version-1'
    and material.binding_id = binding.id and material.material_revision = 1
  from previous_run p cross join binding_v1 binding cross join lateral pg_temp.resolve_fixture(p.job_id,p.run_id) material),
  'an owned attempt resolves only the scoped material and current revision');
select ok((select material.encrypted_value = 'synthetic-encryption-version-1' and material.material_revision = 1
  from previous_run p cross join lateral pg_temp.resolve_fixture(p.job_id,p.run_id) material),
  'the same request can repeat before any authority or material changes');
select ok((select receipt.material_revision=1 and receipt.service_principal_id=principal.id
    and not (to_jsonb(receipt) ?| array['value_preview','encrypted_value','workspace_secret_id'])
  from public.factory_run_credential_receipts receipt join previous_run p using (run_id) cross join principal),
  'runtime provenance records resolved binding revision and principal without material');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '55600200-0000-4000-8000-000000000002';
select is((select count(*) from public.factory_run_credential_receipts where workspace_id='55600200-1000-4000-8000-000000000001'),
  1::bigint, 'session readers can see safe receipt metadata in their factory');
select is(public.get_run_execution_profile('55600200-1000-4000-8000-000000000001',run_id,1),
  profile, 'a session reader sees only the exact service profile and opaque authority identifiers')
from previous_run cross join previous_profile;
set local request.jwt.claim.sub = '55600200-0000-4000-8000-000000000003';
select is((select count(*) from public.factory_run_credential_receipts where workspace_id='55600200-1000-4000-8000-000000000001'),
  0::bigint, 'another workspace cannot read the receipt');
select is(public.get_run_execution_profile('55600200-1000-4000-8000-000000000001',run_id,1),
  null::jsonb, 'a different workspace member cannot read the service profile') from previous_run;
reset role;
set local request.jwt.claim.sub = '55600200-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'service_role';

update public.agent_jobs set git_continuity_release_revision = git_continuity_release_revision + 1
where id = (select job_id from previous_run);
select throws_ok($$select * from previous_run p, lateral pg_temp.resolve_fixture(p.job_id,p.run_id)$$,
  'P499P', null, 'an attempt from a different release revision cannot resolve material');
update public.agent_jobs set git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
where id = (select job_id from previous_run);

update public.workspace_secrets set encrypted_value = 'synthetic-encryption-version-2', value_preview = '...new'
  where id = '55600200-9000-4000-8000-000000000001';
select ok((select material_revision=2 and value_preview is null
  from public.workspace_secrets where id='55600200-9000-4000-8000-000000000001'),
  'existing saved-secret rotation increments material revision and keeps previews null');
select throws_ok($$select * from previous_run p, lateral pg_temp.resolve_fixture(p.job_id,p.run_id)$$,
  'PT409', null, 'one attempt cannot switch to a newer secret after resolving an exact revision');
select throws_ok($$update public.workspace_secrets set key='CHANGED_PROVIDER_KEY'
  where id='55600200-9000-4000-8000-000000000001'$$,
  '23514', null, 'a claimed secret cannot change its identity');
create temp table rotated_run as select * from pg_temp.running_credential_fixture('Rotated scoped credential run');
select ok((select pg_temp.pin_fixture_manifest(job_id,run_id) from rotated_run),
  'an independent attempt can pin the same logical factory definition');
select ok((select material.encrypted_value = 'synthetic-encryption-version-2'
    and material.binding_id = binding.id and material.material_revision = 2
  from rotated_run p cross join binding_v1 binding cross join lateral pg_temp.resolve_fixture(p.job_id,p.run_id) material),
  'a new attempt receives current material through the same binding ID');

delete from public.workspace_secrets where id='55600200-9000-4000-8000-000000000001';
insert into public.workspace_secrets(id,workspace_id,key,encrypted_value) values
  ('55600200-9000-4000-8000-000000000004','55600200-1000-4000-8000-000000000001',
   'FACTORY_PROVIDER_KEY','synthetic-replacement-unassigned');
select is((select public.check_factory_credential_binding(
    binding.workspace_id, binding.factory_id, binding.id, grant_v1.id, 1, binding.factory_agent_id,
    binding.agent_provider, 'gpt-5.5')
    from binding_v1 binding cross join grant_v1), 'missing',
  'deleting and recreating the same key name cannot silently reattach its new UUID');
select throws_ok($$select * from pg_temp.running_credential_fixture('Deleted scoped credential run')$$,
  'PT422', null, 'admission blocks a stored binding whose source has been deleted');
select throws_ok($$select pg_temp.activate_binding_fixture(2, pg_temp.definition_for_binding(id)) from binding_v1$$,
  'PT422', null, 'activation cannot republish a named binding whose source has been deleted');
select throws_ok($$select * from rotated_run p cross join lateral pg_temp.resolve_fixture(p.job_id,p.run_id)$$,
  'PT422', null, 'deletion denies another resolution even with an existing receipt');

create function pg_temp.revoke_fixture(p_version bigint)
returns public.factory_secret_bindings language sql as $$
  select public.revoke_factory_secret_binding(binding.workspace_id,binding.factory_id,
    '55600200-0000-4000-8000-000000000001',binding.id,p_version) from binding_v1 binding;
$$;
select throws_ok($$select pg_temp.revoke_fixture(2)$$,
  'PT409', null, 'revocation uses compare-and-swap');
select is((pg_temp.revoke_fixture(1)).version, 2::bigint, 'exact revocation increments binding decision version');
select is((select public.check_factory_credential_binding(
    binding.workspace_id, binding.factory_id, binding.id, grant_v1.id, 1, binding.factory_agent_id,
    binding.agent_provider, 'gpt-5.5')
    from binding_v1 binding cross join grant_v1), 'revoked',
  'revoked binding is still identifiable as safe history');
select throws_ok($$select * from rotated_run p cross join lateral pg_temp.resolve_fixture(p.job_id,p.run_id)$$,
  'PT422', null, 'revocation denies new resolution of a previous receipt');
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '55600200-0000-4000-8000-000000000002';
select is(public.get_run_execution_profile('55600200-1000-4000-8000-000000000001',run_id,1),
  profile, 'revocation preserves the historical service profile')
from previous_run cross join previous_profile;
reset role;
set local request.jwt.claim.sub = '55600200-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'service_role';

create temp table replacement_binding as
select * from pg_temp.attach_binding(p_source => '55600200-9000-4000-8000-000000000004');
select pg_temp.activate_binding_fixture(2, pg_temp.definition_for_binding(id)) from replacement_binding;
create temp table replacement_run as select * from pg_temp.running_credential_fixture('Replacement scoped credential run');
select ok((select pg_temp.pin_fixture_manifest(job_id,run_id) from replacement_run),
  'the explicitly attached replacement can pin an authorized new attempt');
select ok((select material.encrypted_value='synthetic-replacement-unassigned' and material.binding_id=binding.id
  from replacement_run p cross join replacement_binding binding
  cross join lateral pg_temp.resolve_fixture(p.job_id,p.run_id) material),
  'only an explicit new binding can resolve recreated material');
select public.revoke_factory_secret_binding(binding.workspace_id,binding.factory_id,
  '55600200-0000-4000-8000-000000000001',binding.id,1) from replacement_binding binding;
select throws_ok($$select * from replacement_run p cross join lateral pg_temp.resolve_fixture(p.job_id,p.run_id)$$,
  'PT422', null, 'a revoked binding cannot resolve material that still exists');

create function pg_temp.attach_opencode_fixture(p_upstream text default null)
returns public.factory_secret_bindings language sql as $$
  select public.create_factory_secret_binding(grant_v1.workspace_id, grant_v1.factory_id,
    '55600200-0000-4000-8000-000000000001', grant_v1.id, grant_v1.version, agent.id, 'opencode',
    '55600200-9000-4000-8000-000000000005',p_upstream)
  from grant_v1 cross join fixture_agent agent;
$$;
select throws_ok($$select pg_temp.attach_opencode_fixture()$$,
  '22023', null, 'an OpenCode binding cannot omit the upstream provider');
select throws_ok($$select pg_temp.attach_opencode_fixture('openrouter/model')$$,
  '22023', null, 'an OpenCode binding requires a single upstream provider slug');
create temp table opencode_binding as select * from pg_temp.attach_opencode_fixture('openrouter');
select is((select public.check_factory_credential_binding(binding.workspace_id, binding.factory_id, binding.id,
    grant_v1.id, 1, binding.factory_agent_id, 'opencode', 'openrouter/anthropic/sonnet')
    from opencode_binding binding cross join grant_v1), 'ready', 'readiness matches the first OpenCode model segment');
select is((select public.check_factory_credential_binding(binding.workspace_id, binding.factory_id, binding.id,
    grant_v1.id, 1, binding.factory_agent_id, 'opencode', 'anthropic/sonnet')
    from opencode_binding binding cross join grant_v1), 'missing', 'a changed OpenCode upstream loses readiness');
select throws_ok($$select pg_temp.activate_binding_fixture(3, jsonb_set(
    pg_temp.definition_for_binding(id,'opencode'),'{agent,model}','"anthropic/sonnet"')) from opencode_binding$$,
  'PT422', null, 'a different OpenCode upstream cannot activate the existing binding');
select pg_temp.activate_binding_fixture(3, jsonb_set(pg_temp.definition_for_binding(id,'opencode'),
  '{agent,model}','"openrouter/anthropic/sonnet"')) from opencode_binding;
create temp table opencode_run as select * from pg_temp.running_credential_fixture(
  'OpenCode scoped credential run','opencode','openrouter/anthropic/sonnet');
select ok((select pg_temp.pin_fixture_manifest(job_id,run_id) from opencode_run),
  'a matching OpenCode upstream can pin its exact attempt');
select ok((select material.encrypted_value='synthetic-opencode-material' and material.binding_id=binding.id
  from opencode_run p cross join opencode_binding binding
  cross join lateral pg_temp.resolve_fixture(p.job_id,p.run_id) material),
  'a matching OpenCode upstream can resolve its own binding');
update public.agent_runs set model_name='anthropic/sonnet' where id=(select run_id from opencode_run);
select throws_ok($$select * from opencode_run p cross join lateral pg_temp.resolve_fixture(p.job_id,p.run_id)$$,
  '42501', null, 'a run bound to a different OpenCode model cannot resolve the credential');
grant select on opencode_run to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '55600200-0000-4000-8000-000000000002';
select is(public.get_run_execution_profile('55600200-1000-4000-8000-000000000001',run_id,1),
  null::jsonb, 'a run bound to a different model cannot borrow stale profile evidence') from opencode_run;
reset role;

select ok((select not exists (select 1 from public.factory_audit_events event join principal using (workspace_id, factory_id)
  where event.action like 'credential_binding.%' and (event.detail::text like '%synthetic-%'
    or event.detail ?| array['value_preview','encrypted_value']))) ,
  'grant audit events never include secret previews or material');

select * from finish();
rollback;
