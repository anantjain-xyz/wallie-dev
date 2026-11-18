begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '55400000-0000-4000-8000-000000000001';

select public.set_git_continuity_release(true, revision, 'Factory repository binding fixture')
from public.get_git_continuity_release_state() where not enabled;

insert into auth.users(id, email) values
  ('55400000-0000-4000-8000-000000000001', 'factory-bindings-owner@example.test');
insert into public.workspaces(id, slug, name) values
  ('55400000-1000-4000-8000-000000000001', 'factory-bindings-test', 'Factory bindings');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  ('55400000-2000-4000-8000-000000000001', '55400000-1000-4000-8000-000000000001',
   '55400000-0000-4000-8000-000000000001', 'human', 'owner');
insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential) values
  ('55400000-0000-4000-8000-000000000001', 'platform_api_key', 'factory-bindings-fixture');
insert into public.factories(id, workspace_id, name, slug, is_default) values
  ('55400000-3000-4000-8000-000000000002', '55400000-1000-4000-8000-000000000001', 'Sibling', 'sibling', false);
insert into public.pipelines(id, workspace_id, name, is_default) values
  ('55400000-4000-4000-8000-000000000001', '55400000-1000-4000-8000-000000000001', 'Pipeline', true);
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name) values
  ('55400000-5000-4000-8000-000000000001', '55400000-4000-4000-8000-000000000001',
   '55400000-1000-4000-8000-000000000001', 1, 'bound-build', 'Build');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id,
  target_type, target_name, permissions) values
  ('55400000-7000-4000-8000-000000000001', '55400000-1000-4000-8000-000000000001',
   55400001, 'https://github.com/settings/installations/55400001', 55400, 'Organization', 'fixture',
   '{"contents":"write","pull_requests":"write"}');

create function pg_temp.fixture_repository(p_slot integer) returns uuid
language sql immutable as $$
  select ('55400000-6000-4000-8000-' || lpad(p_slot::text, 12, '0'))::uuid
$$;
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
select pg_temp.fixture_repository(slot), '55400000-1000-4000-8000-000000000001',
  case when slot = 5 then '55400000-3000-4000-8000-000000000002'::uuid end,
  '55400000-7000-4000-8000-000000000001', 55400 + slot,
  name, 'fixture/' || name, true, 'https://github.com/fixture/' || name, 'main'
from (values (1, 'default-writer'), (2, 'alternate-writer'), (3, 'read-context'),
  (4, 'unbound'), (5, 'sibling')) as repository(slot, name);

create temp table factory_definition as
select jsonb_build_object(
  'schemaVersion', 1, 'kind', 'serial', 'pipelineId', '55400000-4000-4000-8000-000000000001',
  'repositoryId', pg_temp.fixture_repository(1),
  'writableRepositoryIds', jsonb_build_array(pg_temp.fixture_repository(2)),
  'readContextRepositoryIds', jsonb_build_array(pg_temp.fixture_repository(3)),
  'sandboxProvider', 'e2b',
  'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5'),
  'stages', jsonb_build_array(jsonb_build_object(
    'id', '55400000-5000-4000-8000-000000000001', 'slug', 'bound-build', 'name', 'Build'))
) as body;

create function pg_temp.activate_fixture(p_activation bigint, p_definition jsonb)
returns void language sql as $$
  with revision as (
    insert into public.factory_definition_revisions(workspace_id, factory_id, schema_version,
      definition_json, canonical_digest, created_by)
    select factory.workspace_id, factory.id, 1, p_definition::text,
      encode(sha256(convert_to(p_definition::text, 'UTF8')), 'hex'),
      '55400000-0000-4000-8000-000000000001'
    from public.factories factory
    where factory.workspace_id = '55400000-1000-4000-8000-000000000001' and factory.is_default
    returning id, workspace_id, factory_id, created_by
  )
  insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
  select workspace_id, factory_id, id, p_activation, created_by from revision;
$$;
select throws_ok($$select pg_temp.activate_fixture(1, jsonb_set(
  body, '{readContextRepositoryIds}', jsonb_build_array(pg_temp.fixture_repository(2)))) from factory_definition$$,
  'PT422', 'Each repository can have only one factory binding.',
  'compiled bindings cannot name the same repository for read and write');
select throws_ok($$select pg_temp.activate_fixture(1, jsonb_set(
  body, '{readContextRepositoryIds}', jsonb_build_array(pg_temp.fixture_repository(1)))) from factory_definition$$,
  'PT422', 'Each repository can have only one factory binding.',
  'the default writer cannot also be read context');
select throws_ok($$select pg_temp.activate_fixture(1, jsonb_set(
  body, '{readContextRepositoryIds}', jsonb_build_array(pg_temp.fixture_repository(5)))) from factory_definition$$,
  'PT422', 'A bound repository is outside the factory scope.',
  'a factory cannot bind a sibling repository as read context');

update public.github_repositories set is_archived = true where id = pg_temp.fixture_repository(3);
select throws_ok($$select pg_temp.activate_fixture(1, body) from factory_definition$$,
  'PT422', 'A bound repository is unavailable.', 'activation checks connected repository bindings');
update public.github_repositories set is_archived = false where id = pg_temp.fixture_repository(3);
select pg_temp.activate_fixture(1, body) from factory_definition;

insert into public.workspace_e2b_sandbox_connections(workspace_id, encrypted_api_key)
values ('55400000-1000-4000-8000-000000000001', 'factory-bindings-fixture');
create function pg_temp.reserve_fixture_capability(p_repository_id uuid)
returns public.sandbox_capability_checks language sql as $$
  select public.start_factory_definition_capability_check(
    revision.workspace_id, p_repository_id, '55400000-0000-4000-8000-000000000001', 'e2b', 'codex', 'gpt-5.5',
    revision.canonical_digest)
  from public.factory_definition_activations activation
  join public.factory_definition_revisions revision on revision.id = activation.revision_id
  where activation.workspace_id = '55400000-1000-4000-8000-000000000001' and activation.activation_number = 1
$$;
select is((pg_temp.reserve_fixture_capability(pg_temp.fixture_repository(2))).github_repository_id,
  pg_temp.fixture_repository(2), 'a candidate can reserve repository-specific evidence for an alternate writer');
select throws_ok($$select pg_temp.reserve_fixture_capability(pg_temp.fixture_repository(3))$$,
  'P0002', 'The selected factory definition is unavailable for this check.',
  'read context cannot reserve a writable capability probe');
select throws_ok($$select pg_temp.reserve_fixture_capability(pg_temp.fixture_repository(5))$$,
  'P0002', 'The selected factory definition is unavailable for this check.',
  'a sibling factory repository cannot reserve a writable capability probe');

create function pg_temp.create_fixture(p_repository_id uuid default null)
returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language sql as $$
  select * from public.create_session_with_first_job(
    '55400000-1000-4000-8000-000000000001', '55400000-2000-4000-8000-000000000001',
    'Repository fixture', 'Use assigned source', 'codex', 'gpt-5.5',
    session_github_repository_id => p_repository_id);
$$;
create temp table default_session as select * from pg_temp.create_fixture();
create temp table alternate_session as select * from pg_temp.create_fixture(pg_temp.fixture_repository(2));
select is((select repository.github_repository_id
  from default_session fixture join public.session_factory_admission_inputs repository using (session_id)),
  pg_temp.fixture_repository(1), 'omitting the selection keeps the default writer');
select is((select repository.github_repository_id
  from alternate_session fixture join public.session_factory_admission_inputs repository using (session_id)),
  pg_temp.fixture_repository(2), 'admission records the explicit alternate writer');
select is((select public.get_session_detail_page(workspace_slug, session_number)
  #>> '{activity,repository,fullName}' from alternate_session),
  'fixture/alternate-writer', 'session detail resolves the admitted writer instead of the factory default');
select throws_ok($$select * from pg_temp.create_fixture(pg_temp.fixture_repository(3))$$,
  'P0003', 'The active factory no longer matches the requested session options.',
  'read context cannot be selected for writable execution');
select throws_ok($$select * from pg_temp.create_fixture(pg_temp.fixture_repository(4))$$,
  'P0003', 'The active factory no longer matches the requested session options.',
  'repositories installed but unbound are not implicit writers');
select throws_ok($$select * from pg_temp.create_fixture(pg_temp.fixture_repository(5))$$,
  'P0003', 'The active factory no longer matches the requested session options.',
  'a sibling factory repository cannot be selected for writable execution');
select throws_ok($$update public.sessions set github_repository_id = pg_temp.fixture_repository(1)
  where id = (select session_id from alternate_session)$$,
  '23514', 'The admitted writable repository cannot change.',
  'a different writable binding cannot retarget an existing session');

update public.github_repositories set is_archived = true where id = pg_temp.fixture_repository(3);
select lives_ok($$select * from pg_temp.create_fixture(pg_temp.fixture_repository(2))$$,
  'read context availability is independent of writable admission');
update public.github_repositories set is_archived = false where id = pg_temp.fixture_repository(3);

create function pg_temp.restart_fixture(p_request uuid, p_repository_id uuid default null)
returns table(session_id uuid, job_id uuid, run_id uuid) language sql as $$
  select restarted.session_id, restarted.job_id, restarted.run_id
  from alternate_session source
  cross join lateral public.restart_session_once_with_first_job(
    '55400000-1000-4000-8000-000000000001', '55400000-2000-4000-8000-000000000001',
    p_request, repeat('c', 64), source.session_id, 'Restarted', 'Use assigned source', 'codex', 'gpt-5.5', '{}',
    session_github_repository_id => p_repository_id) as restarted
$$;
create temp table restarted_alternate as select * from pg_temp.restart_fixture(gen_random_uuid());
select is((select repository.github_repository_id
  from restarted_alternate fixture join public.session_factory_admission_inputs repository using (session_id)),
  pg_temp.fixture_repository(2), 'restarting an explicitly selected session preserves its writer');
create temp table restarted_override as select * from pg_temp.restart_fixture(gen_random_uuid(), pg_temp.fixture_repository(1));
select is((select repository.github_repository_id
  from restarted_override fixture join public.session_factory_admission_inputs repository using (session_id)),
  pg_temp.fixture_repository(1), 'a deliberate restart may explicitly choose another writable binding');

insert into auth.users(id, email) values
  ('55400000-0000-4000-8000-000000000002', 'factory-bindings-member@example.test');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  ('55400000-2000-4000-8000-000000000002', '55400000-1000-4000-8000-000000000001',
   '55400000-0000-4000-8000-000000000002', 'human', 'member');
insert into public.pipelines(id, workspace_id, factory_id, name) values
  ('55400000-4000-4000-8000-000000000002', '55400000-1000-4000-8000-000000000001',
   '55400000-3000-4000-8000-000000000002', 'Sibling pipeline');
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name) values
  ('55400000-5000-4000-8000-000000000002', '55400000-4000-4000-8000-000000000002',
   '55400000-1000-4000-8000-000000000001', 1, 'sibling-build', 'Build');
insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id, github_repository_id)
values ('55400000-8000-4000-8000-000000000001', '55400000-1000-4000-8000-000000000001',
  '55400000-3000-4000-8000-000000000002', 100, 'Restricted source',
  '55400000-4000-4000-8000-000000000002', '55400000-5000-4000-8000-000000000002', pg_temp.fixture_repository(5));
select throws_ok($$select public.restart_session_once_with_first_job(
  '55400000-1000-4000-8000-000000000001', '55400000-2000-4000-8000-000000000002',
  gen_random_uuid(), repeat('d', 64), '55400000-8000-4000-8000-000000000001',
  'Restarted', 'Do not borrow a restricted source', 'codex', 'gpt-5.5', '{}',
  session_github_repository_id => pg_temp.fixture_repository(1))$$,
  'PT404', 'Source session is unavailable in this workspace.',
  'a workspace member cannot restart from an inaccessible sibling session even with a writable override');

update public.github_installations set suspended = true where id = '55400000-7000-4000-8000-000000000001';
select throws_ok($$select * from pg_temp.create_fixture(pg_temp.fixture_repository(2))$$,
  'P0002', 'The factory definition repository is unavailable.',
  'GitHub installation suspension blocks admission for the selected writer');
update public.github_installations set suspended = false where id = '55400000-7000-4000-8000-000000000001';

update public.agent_jobs set git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()),
  status = 'running', attempt_count = 1 where id = (select job_id from alternate_session);
select public.start_session_job_attempt(f.job_id, 1, s.current_stage_id, 0, 'codex', 'gpt-5.5',
  'project', 'wallie/factory-bindings') from alternate_session f join public.sessions s on s.id = f.session_id;
select throws_ok($$select public.pin_session_job_git_input(job_id, 1, run_id,
  pg_temp.fixture_repository(3), 'main', repeat('a', 40)) from alternate_session$$,
  '23514', 'Git lineage repository does not match the session.',
  'a read context binding cannot become the execution Git root');
select is((select (input.repository_id, input.input_sha)::text from alternate_session f
  cross join lateral public.pin_session_job_git_input(f.job_id, 1, f.run_id,
    pg_temp.fixture_repository(2), 'main', repeat('a', 40)) input),
  '(' || pg_temp.fixture_repository(2)::text || ',' || repeat('a', 40) || ')',
  'the execution pins exactly the selected writer and its source SHA');
select throws_ok($$select public.prepare_session_source_delivery(run_id, pg_temp.fixture_repository(3), 'main',
  repeat('a', 40), repeat('a', 40), 'Fixture', 'Artifact', '', '', '') from alternate_session$$,
  '23514', 'Source does not match the pinned Git input.',
  'read context cannot be used for checkpoint publication');
select throws_ok($$select public.record_session_pull_request(session_id, '55400000-1000-4000-8000-000000000001',
  pg_temp.fixture_repository(3), 'context-only', 1, 'https://github.com/fixture/read-context/pull/1',
  'open', false, now()) from alternate_session$$,
  '23514', 'Pull request repository must match its session', 'the PR repository remains the admitted writer');

select pg_temp.activate_fixture(2, body - 'writableRepositoryIds') from factory_definition;
select throws_ok($$select * from pg_temp.restart_fixture(gen_random_uuid())$$,
  'P0003', 'The active factory no longer matches the requested session options.',
  'a restart without an override cannot silently select a new writer');
update public.agent_jobs set attempt_count = 2 where id = (select job_id from alternate_session);
create temp table retry_run as
select f.job_id, public.start_session_job_attempt(f.job_id, 2, s.current_stage_id, 0, 'codex', 'gpt-5.5',
  'project', 'wallie/factory-bindings-retry') as run_id
from alternate_session f join public.sessions s on s.id = f.session_id;
select throws_ok($$select public.pin_session_job_git_input(job_id, 2, run_id,
  pg_temp.fixture_repository(2), 'main', repeat('b', 40)) from retry_run$$,
  '23514', 'Observed Git input does not match the selected checkpoint.',
  'an exact retry rejects a different source SHA on the same writer');
select is((select (input.repository_id, input.input_sha)::text from retry_run f
  cross join lateral public.pin_session_job_git_input(f.job_id, 2, f.run_id,
    pg_temp.fixture_repository(2), 'main', repeat('a', 40)) input),
  '(' || pg_temp.fixture_repository(2)::text || ',' || repeat('a', 40) || ')',
  'a retry uses the original writer and SHA after another definition is activated');

update public.github_installations set suspended = true where id = '55400000-7000-4000-8000-000000000001';
select throws_ok($$select public.pin_session_job_git_input(job_id, 2, run_id,
    pg_temp.fixture_repository(2), 'main', repeat('a', 40)) from retry_run$$,
  '23514', 'Git lineage repository does not match the session.',
  'a previously pinned SHA cannot bypass installation suspension');
update public.github_installations set suspended = false where id = '55400000-7000-4000-8000-000000000001';

select lives_ok($$delete from public.github_repositories where id = pg_temp.fixture_repository(2)$$,
  'GitHub disconnection can clear the live repository FK');
select is((select public.get_session_detail_page(workspace_slug, session_number)
  #>> '{activity,sessionGithubRepositoryId}' from alternate_session),
  pg_temp.fixture_repository(2)::text, 'the session retains the exact admitted repository identity after disconnection');
select throws_ok($$insert into public.session_git_roots(
  session_id, workspace_id, repository_id, repository_full_name, base_branch, initial_base_sha)
  select session_id, '55400000-1000-4000-8000-000000000001', pg_temp.fixture_repository(3),
    'fixture/read-context', 'main', repeat('a', 40) from restarted_alternate$$,
  '23514', 'Git lineage repository does not match the session.',
  'a disconnected writer cannot be replaced by a directly inserted context Git root');
select throws_ok($$select public.record_session_pull_request(session_id, '55400000-1000-4000-8000-000000000001',
  pg_temp.fixture_repository(3), 'context-only', 1, 'https://github.com/fixture/read-context/pull/1',
  'open', false, now()) from alternate_session$$,
  '23514', 'Pull request repository must match its session',
  'a cleared session FK does not authorize context PRs');

select * from finish();
rollback;
