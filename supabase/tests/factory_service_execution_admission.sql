begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '55500100-0000-4000-8000-000000000001';

select public.set_git_continuity_release(true, revision, 'Factory service execution fixture')
from public.get_git_continuity_release_state() where not enabled;

insert into auth.users(id, email) values
  ('55500100-0000-4000-8000-000000000001', 'service-execution-payer@example.test'),
  ('55500100-0000-4000-8000-000000000002', 'service-execution-invoker@example.test');
insert into public.workspaces(id, slug, name) values
  ('55500100-1000-4000-8000-000000000001', 'service-execution-test', 'Service execution');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  ('55500100-2000-4000-8000-000000000001', '55500100-1000-4000-8000-000000000001',
   '55500100-0000-4000-8000-000000000001', 'human', 'owner'),
  ('55500100-2000-4000-8000-000000000002', '55500100-1000-4000-8000-000000000001',
   '55500100-0000-4000-8000-000000000002', 'human', 'member');
insert into public.pipelines(id, workspace_id, name, is_default) values
  ('55500100-4000-4000-8000-000000000001', '55500100-1000-4000-8000-000000000001', 'Pipeline', true);
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name) values
  ('55500100-5000-4000-8000-000000000001', '55500100-4000-4000-8000-000000000001',
   '55500100-1000-4000-8000-000000000001', 1, 'service-build', 'Build');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id,
  target_type, target_name, permissions) values
  ('55500100-7000-4000-8000-000000000001', '55500100-1000-4000-8000-000000000001',
   55500101, 'https://github.com/settings/installations/55500101', 55500, 'Organization', 'fixture',
   '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
select ('55500100-6000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid,
  '55500100-1000-4000-8000-000000000001', '55500100-7000-4000-8000-000000000001',
  55500100 + slot, name, 'fixture/' || name, true, 'https://github.com/fixture/' || name, 'main'
from (values (1, 'writer'), (2, 'read-context'), (3, 'outside-grant')) as repository(slot, name);
insert into public.execution_policy_revisions(id, workspace_id, revision, requirements, created_by) values
  ('55500100-8000-4000-8000-000000000001', '55500100-1000-4000-8000-000000000001', 1,
   '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":300000,"maxTotalTokens":10000,"maxCostUsd":5}',
   '55500100-0000-4000-8000-000000000001');

create temp table principal as
select principal.* from public.factories factory
cross join lateral public.create_service_principal(factory.workspace_id, factory.id,
  '55500100-0000-4000-8000-000000000001', 'Fixture service', 'fixture-service') principal
where factory.workspace_id = '55500100-1000-4000-8000-000000000001' and factory.is_default;

create function pg_temp.approve_grant(p_grant_id uuid default null, p_expected_version bigint default 0)
returns public.factory_execution_grants language sql as $$
  select public.approve_factory_execution_grant(principal.workspace_id, principal.factory_id,
    '55500100-0000-4000-8000-000000000001', principal.id, '55500100-6000-4000-8000-000000000001',
    array['55500100-6000-4000-8000-000000000002']::uuid[], array['docs'],
    '55500100-8000-4000-8000-000000000001', '55500100-2000-4000-8000-000000000001',
    clock_timestamp() + interval '10 minutes', p_expected_version, p_grant_id)
  from principal
$$;
create temp table grant_v1 as select * from pg_temp.approve_grant();

create function pg_temp.definition_for_grant(p_grant_id uuid, p_version bigint)
returns jsonb language sql as $$
  select jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', '55500100-4000-4000-8000-000000000001',
    'repositoryId', '55500100-6000-4000-8000-000000000001',
    'readContextRepositoryIds', jsonb_build_array('55500100-6000-4000-8000-000000000002'),
    'toolIds', jsonb_build_array('docs'),
    'executionPolicyRevisionId', '55500100-8000-4000-8000-000000000001',
    'executionGrant', jsonb_build_object('id', p_grant_id, 'version', p_version),
    'sandboxProvider', 'e2b',
    'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5'),
    'stages', jsonb_build_array(jsonb_build_object(
      'id', '55500100-5000-4000-8000-000000000001', 'slug', 'service-build', 'name', 'Build'))
  )
$$;
create function pg_temp.activate_fixture(p_activation bigint, p_definition jsonb)
returns void language sql as $$
  with revision as (
    insert into public.factory_definition_revisions(workspace_id, factory_id, schema_version,
      definition_json, canonical_digest, created_by)
    select principal.workspace_id, principal.factory_id, 1, p_definition::text,
      encode(sha256(convert_to(p_definition::text, 'UTF8')), 'hex'), '55500100-0000-4000-8000-000000000001'
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

select throws_ok($$select pg_temp.activate_fixture(1, pg_temp.definition_for_grant(id, 1)
  || '{"repositoryId":"55500100-6000-4000-8000-000000000003"}') from grant_v1$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'a grant cannot authorize a different write repository');
select throws_ok($$select pg_temp.activate_fixture(1, pg_temp.definition_for_grant(id, 1)
  || '{"readContextRepositoryIds":["55500100-6000-4000-8000-000000000003"]}') from grant_v1$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'a grant cannot add read context outside its explicit set');
select throws_ok($$select pg_temp.activate_fixture(1, pg_temp.definition_for_grant(id, 1)
  || '{"toolIds":["docs","network"]}') from grant_v1$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'a grant cannot add a tool outside its explicit set');
select throws_ok($$select pg_temp.activate_fixture(1, pg_temp.definition_for_grant(id, 1)
  || '{"writableRepositoryIds":["55500100-6000-4000-8000-000000000003"]}') from grant_v1$$,
  'PT422', 'A grant-backed definition requires one writer and an explicit execution budget.',
  'a grant-backed definition cannot offer alternate writers');
select throws_ok($$select pg_temp.activate_fixture(1, pg_temp.definition_for_grant(id, 1)
  - 'executionPolicyRevisionId') from grant_v1$$,
  'PT422', 'A grant-backed definition requires one writer and an explicit execution budget.',
  'a grant-backed definition must pin an explicit budget');
select lives_ok($$select pg_temp.activate_fixture(1, pg_temp.definition_for_grant(id, 1)) from grant_v1$$,
  'a definition with exact grant scope and an explicit budget can activate');

insert into public.workspace_e2b_sandbox_connections(workspace_id, encrypted_api_key) values
  ('55500100-1000-4000-8000-000000000001', 'fixture-sandbox-connection');
insert into public.sandbox_capability_checks(workspace_id, github_repository_id, status, capabilities,
  sandbox_provider, agent_provider, agent_model, sandbox_connection_revision, checked_at)
select connection.workspace_id, '55500100-6000-4000-8000-000000000001', 'success',
  '{"git":{"ok":true}}', 'e2b', 'codex', 'gpt-5.5', connection.connection_revision, clock_timestamp()
from public.workspace_e2b_sandbox_connections connection join principal using (workspace_id);
create function pg_temp.reserve_smoke_fixture() returns public.factory_definition_smoke_tests language sql as $$
  select public.start_factory_definition_smoke_test(principal.workspace_id, principal.factory_id,
    '55500100-0000-4000-8000-000000000001', 1, 'revision', revision.id, revision.canonical_digest,
    array['e2b'], array['git'])
  from principal
  join public.factory_definition_activations activation using (workspace_id, factory_id)
  join public.factory_definition_revisions revision on revision.id = activation.revision_id
  where activation.activation_number = 1;
$$;
create temp table smoke as select * from pg_temp.reserve_smoke_fixture();
select is((select status from smoke), 'running',
  'a synthetic smoke check validates the grant without a personal publisher credential');
select public.finish_factory_definition_smoke_test(workspace_id, id, 'canceled', '{}') from smoke;

create function pg_temp.reserve_probe_fixture() returns public.sandbox_capability_checks language sql as $$
  select public.start_factory_definition_capability_check(principal.workspace_id,
    '55500100-6000-4000-8000-000000000001', '55500100-0000-4000-8000-000000000001',
    'e2b', 'codex', 'gpt-5.5', revision.canonical_digest)
  from principal
  join public.factory_definition_activations activation using (workspace_id, factory_id)
  join public.factory_definition_revisions revision on revision.id = activation.revision_id
  where activation.activation_number = 1;
$$;
create temp table probe as select * from pg_temp.reserve_probe_fixture();
select is((select status from probe), 'running', 'a valid grant can reserve a repository capability probe');
update public.sandbox_capability_checks set status = 'success', capabilities = '{"git":{"ok":true}}'
where id = (select id from probe);

create function pg_temp.create_fixture(
  p_invoker_id uuid default '55500100-2000-4000-8000-000000000002'
) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language sql as $$
  select * from public.create_session_with_first_job(
    '55500100-1000-4000-8000-000000000001', p_invoker_id,
    'Service execution fixture', 'Use assigned scope', 'codex', 'gpt-5.5');
$$;
select throws_ok($$select * from principal cross join lateral pg_temp.create_fixture(principal.id)$$,
  '42501', null, 'a service principal cannot impersonate a human invoking member');
create temp table session_v1 as select * from pg_temp.create_fixture();

select ok((select receipt.invoking_actor_member_id = '55500100-2000-4000-8000-000000000002'
    and receipt.credential_owner_member_id is null and receipt.credential_owner_service_principal_id = principal.id
    and receipt.budget_payer_member_id = '55500100-2000-4000-8000-000000000001'
    and receipt.execution_policy_revision_id = '55500100-8000-4000-8000-000000000001'
    and receipt.execution_grant_id = grant_v1.id and receipt.execution_grant_version = 1
  from session_v1 natural join public.session_factory_admission_inputs receipt
  cross join principal cross join grant_v1),
  'grant admission attributes invoker, service credential owner, payer and exact policy separately without personal credentials');
select throws_ok($$update public.session_factory_admission_inputs set budget_payer_member_id = invoking_actor_member_id
    where session_id = (select session_id from session_v1)$$,
  '23514', 'Session factory admission inputs are immutable.', 'a caller cannot rewrite the attributed payer');

create function pg_temp.start_fixture(p_job_id uuid, p_attempt integer)
returns uuid language plpgsql as $$
begin
  update public.agent_jobs set git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()),
    status = 'running', attempt_count = p_attempt where id = p_job_id;
  return public.start_session_job_attempt(p_job_id, p_attempt, '55500100-5000-4000-8000-000000000001',
    0, 'codex', 'gpt-5.5', 'code', 'wallie/service-execution-fixture');
end;
$$;
select ok((select pg_temp.start_fixture(job_id, 1) is not null from session_v1),
  'a current grant can bind the exact attempt before the worker resolves credentials');
create temp table invoker_revocation_session as select * from pg_temp.create_fixture();
update public.workspace_members set is_active = false
where id = '55500100-2000-4000-8000-000000000002';
select throws_ok($$select pg_temp.start_fixture(job_id, 1) from invoker_revocation_session$$,
  '42501', 'The service execution invoker no longer has factory access.',
  'removing the invoking member after admission blocks the queued attempt');
update public.workspace_members set is_active = true
where id = '55500100-2000-4000-8000-000000000002';

create temp table grant_v2 as
select updated.* from grant_v1 cross join lateral pg_temp.approve_grant(grant_v1.id, 1) updated;
select is((pg_temp.reserve_smoke_fixture()).status, 'blocked',
  'an obsolete grant blocks the synthetic smoke check');
select throws_ok($$select pg_temp.reserve_probe_fixture()$$,
  'PT422', 'The selected factory execution grant is unavailable.',
  'an obsolete grant cannot reserve a new repository capability probe');
select throws_ok($$select * from pg_temp.create_fixture()$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'an active definition referencing an older grant version blocks new admissions');
select throws_ok($$select pg_temp.start_fixture(job_id, 2) from session_v1$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'a retry for an older grant version cannot begin execution');
select throws_ok($$select pg_temp.activate_fixture(2, pg_temp.definition_for_grant(id, 1)) from grant_v1$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'rollback cannot reactivate a superseded grant reference');

select pg_temp.activate_fixture(2, pg_temp.definition_for_grant(id, 2)) from grant_v2;
create temp table session_v2 as select * from pg_temp.create_fixture();
create temp table replay_attempt as
select session_id, job_id, pg_temp.start_fixture(job_id, 1) as run_id from pg_temp.create_fixture();
select public.cancel_session_job_attempts(attempt.session_id, principal.workspace_id, 'Complete the replay source fixture')
from replay_attempt attempt cross join principal;

-- Seed only the captured locator. The replay gate's separate byte validation
-- is covered by the benchmark resolver tests.
create temp table replay_revision as
select revision.* from replay_attempt attempt cross join principal
cross join lateral public.create_factory_benchmark_task(principal.workspace_id, principal.factory_id,
  '55500100-0000-4000-8000-000000000001', attempt.run_id, 'Grant-bound benchmark',
  'Verify the retained execution authority.', '{}', 'eligible') revision;
insert into public.factory_benchmark_task_inputs(task_id, workspace_id, factory_id,
  source_run_id, source_session_id, source_job_id, source_attempt_count, definition_revision_id)
select revision.task_id, revision.workspace_id, revision.factory_id, attempt.run_id, attempt.session_id,
  attempt.job_id, 1, source.factory_definition_revision_id
from replay_revision revision cross join replay_attempt attempt
join public.sessions source on source.id = attempt.session_id;
create function pg_temp.replay_grant_access() returns boolean language sql as $$
  select public.assert_factory_benchmark_replay_access(workspace_id, factory_id,
    '55500100-0000-4000-8000-000000000001', id) from replay_revision
$$;
select ok(pg_temp.replay_grant_access(), 'the exact source attempt authorizes replay while its original grant is live');

select public.revoke_factory_execution_grant(workspace_id, factory_id, '55500100-0000-4000-8000-000000000001',
  id, 2, 'Fixture revoked') from grant_v2;
select throws_ok($$select pg_temp.replay_grant_access()$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'revoking the original execution grant blocks replay of an otherwise eligible historical revision');
select throws_ok($$select pg_temp.start_fixture(job_id, 1) from session_v2$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'revocation after queueing blocks the first worker attempt');
select throws_ok($$select * from pg_temp.create_fixture()$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'revocation blocks new admission on the prior active definition');
select is((select receipt.execution_grant_version
    from session_v2 fixture join public.session_factory_admission_inputs receipt using (session_id)), 2::bigint,
  'revocation leaves the historical admitted version intact');

create temp table expiring_grant as select * from pg_temp.approve_grant();
select pg_temp.activate_fixture(3, pg_temp.definition_for_grant(id, 1)) from expiring_grant;
create temp table expiring_session as select * from pg_temp.create_fixture();
-- Backdate both timestamps to exercise the boundary without adding a test sleep.
update public.factory_execution_grants set expires_at = clock_timestamp() - interval '1 minute',
  approved_at = clock_timestamp() - interval '2 minutes' where id = (select id from expiring_grant);
select throws_ok($$select pg_temp.start_fixture(job_id, 1) from expiring_session$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'expiration between admission and attempt blocks execution');
select throws_ok($$select * from pg_temp.create_fixture()$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'expiration blocks admission on the prior active definition');

select pg_temp.activate_fixture(4, pg_temp.definition_for_grant(id, 1) - 'executionGrant') from expiring_grant;
select throws_ok($$select * from pg_temp.create_fixture()$$, 'PT422',
  'A current personal credential is required for this agent.',
  'the existing human path still requires its own credential');
insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential) values
  ('55500100-0000-4000-8000-000000000002', 'platform_api_key', 'fixture-human-credential');
create temp table human_session as select * from pg_temp.create_fixture();
select ok((select receipt.invoking_actor_member_id = '55500100-2000-4000-8000-000000000002'
    and receipt.credential_owner_member_id = receipt.invoking_actor_member_id
    and receipt.budget_payer_member_id = receipt.invoking_actor_member_id
    and receipt.credential_owner_service_principal_id is null and receipt.execution_grant_id is null
  from human_session fixture join public.session_factory_admission_inputs receipt using (session_id)),
  'a new human admission keeps personal credential ownership and separate attribution fields');

select * from finish();
rollback;
