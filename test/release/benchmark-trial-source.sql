begin;
set local request.jwt.claim.role = 'service_role';
select set_config('wallie.benchmark_smoke_namespace', :'namespace', true);
create function pg_temp.fixture_id(slot integer) returns uuid language sql as $$
  select (current_setting('wallie.benchmark_smoke_namespace') || '-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

-- The browser qualification opts in to a real local password session.
\if :{?fixture_login}
\getenv fixture_password WALLIE_M08_SQL_FIXTURE_PASSWORD
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token,
  email_change_token_new, email_change_token_current, reauthentication_token,
  email_change, created_at, updated_at, is_sso_user, is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000', pg_temp.fixture_id(1), 'authenticated',
  'authenticated', :'fixture_email', extensions.crypt(:'fixture_password', extensions.gen_salt('bf')),
  now(), '{"provider":"email","providers":["email"]}',
  jsonb_build_object('sub', pg_temp.fixture_id(1)::text, 'email', :'fixture_email',
    'email_verified', true, 'phone_verified', false),
  '', '', '', '', '', '', now(), now(), false, false
);
insert into auth.identities (id, provider_id, user_id, identity_data, provider, created_at, updated_at)
select gen_random_uuid(), id::text, id, raw_user_meta_data, 'email', now(), now()
from auth.users where id = pg_temp.fixture_id(1);
\else
insert into auth.users(id, email) values (pg_temp.fixture_id(1), :'fixture_email');
\endif
insert into public.workspaces(id, slug, name)
values (pg_temp.fixture_id(2), :'fixture_slug', 'Disposable benchmark trial smoke');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.fixture_id(3), pg_temp.fixture_id(2), pg_temp.fixture_id(1), 'human', 'owner');
create temp table scope as
select workspace_id, id as factory_id from public.factories where workspace_id = pg_temp.fixture_id(2) and is_default;

insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.fixture_id(4), pg_temp.fixture_id(2), :'installation_id', 'https://github.com/settings/installations', 616, 'User', 'anantjain-xyz', '{"contents":"read"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name,
  private, html_url, default_branch)
select pg_temp.fixture_id(5), workspace_id, factory_id, pg_temp.fixture_id(4), :'repository_id', 'wallie-dev',
  'anantjain-xyz/wallie-dev', false, 'https://github.com/anantjain-xyz/wallie-dev', 'main' from scope;

insert into public.pipelines(id, workspace_id, factory_id, name)
select pg_temp.fixture_id(6), workspace_id, factory_id, 'Recorded fixture pipeline' from scope;
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name)
values (pg_temp.fixture_id(7), pg_temp.fixture_id(2), pg_temp.fixture_id(6), 1, 'run', 'Run');
insert into public.factory_agents(id, workspace_id, factory_id, name, slug, created_by)
select pg_temp.fixture_id(8), workspace_id, factory_id, 'Recorded historical agent', 'recorded-source-agent', pg_temp.fixture_id(1) from scope;
insert into public.factory_agent_prompt_revisions(id, workspace_id, factory_id, agent_id, revision_number, prompt_md, prompt_sha256, created_by)
select pg_temp.fixture_id(9), workspace_id, factory_id, pg_temp.fixture_id(8), 1, 'Record a measured result.',
  encode(sha256(convert_to('Record a measured result.', 'UTF8')), 'hex'), pg_temp.fixture_id(1) from scope;
insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by)
select pg_temp.fixture_id(10), workspace_id, factory_id, 1, :'definition', encode(sha256(convert_to(:'definition', 'UTF8')), 'hex'),
  pg_temp.fixture_id(1) from scope;
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, pg_temp.fixture_id(10), 1, pg_temp.fixture_id(1) from scope;

insert into public.sessions(id, workspace_id, factory_id, number, title, prompt_md, pipeline_id, current_stage_id,
  creator_member_id, github_repository_id, factory_definition_provenance, factory_definition_revision_id, execute_pinned_definition)
select pg_temp.fixture_id(11), workspace_id, factory_id, 1, 'Count archived README lines', :'prompt',
  pg_temp.fixture_id(6), pg_temp.fixture_id(7), pg_temp.fixture_id(3), pg_temp.fixture_id(5), 'pinned', pg_temp.fixture_id(10), true from scope;
insert into public.session_factory_admission_inputs(session_id, workspace_id, factory_id, activation_number,
  definition_revision_id, definition_digest, pipeline_id, selected_stage_ids, github_repository_id, model_provider, model_name,
  title_sha256, prompt_sha256, original_title, original_prompt_md)
select pg_temp.fixture_id(11), workspace_id, factory_id, 1, id, canonical_digest, pg_temp.fixture_id(6),
  array[pg_temp.fixture_id(7)], pg_temp.fixture_id(5), 'codex', 'gpt-5.5',
  encode(sha256(convert_to('Count archived README lines', 'UTF8')), 'hex'),
  encode(sha256(convert_to(:'prompt', 'UTF8')), 'hex'), 'Count archived README lines', :'prompt'
from public.factory_definition_revisions where id = pg_temp.fixture_id(10);

insert into public.agent_jobs(id, workspace_id, session_id, stage_id, stage_slug, trigger_type, status, attempt_count, started_at, finished_at)
values (pg_temp.fixture_id(12), pg_temp.fixture_id(2), pg_temp.fixture_id(11), pg_temp.fixture_id(7), 'run',
  'manual_run', 'success', 1, clock_timestamp() - interval '1 minute', clock_timestamp());
insert into public.agent_runs(id, workspace_id, session_id, agent_job_id, stage_id, stage_slug, run_type, model_provider,
  model_name, status, attempt_count, started_at, finished_at, agent_id, agent_prompt_revision_id)
values (pg_temp.fixture_id(13), pg_temp.fixture_id(2), pg_temp.fixture_id(11), pg_temp.fixture_id(12),
  pg_temp.fixture_id(7), 'run', 'project', 'codex', 'gpt-5.5', 'success', 1, clock_timestamp() - interval '1 minute',
  clock_timestamp(), pg_temp.fixture_id(8), pg_temp.fixture_id(9));
insert into public.session_attempt_manifests(run_id, workspace_id, session_id, job_id, attempt_count, stage_id,
  definition_provenance, definition_revision_id, definition_digest, definition_skill_ids, definition_tool_ids,
  repository_id, repository_full_name, base_branch, initial_base_sha, input_sha, input_ref, checkout_sha,
  prompt_sha256, prompt_utf8_bytes, renderer_version, predecessors, worker_runtime, run_type, model_provider, model_name)
select pg_temp.fixture_id(13), workspace_id, pg_temp.fixture_id(11), pg_temp.fixture_id(12), 1, pg_temp.fixture_id(7),
  'pinned', id, canonical_digest, '{}', '{}', pg_temp.fixture_id(5), 'anantjain-xyz/wallie-dev', 'main',
  :'commit_sha', :'commit_sha', :'retained_ref', :'commit_sha',
  encode(sha256(convert_to(:'prompt', 'UTF8')), 'hex'), octet_length(:'prompt'), 6, '[]', 'node', 'project', 'codex', 'gpt-5.5'
from public.factory_definition_revisions where id = pg_temp.fixture_id(10);
insert into public.session_run_context_manifests(run_id, workspace_id, session_id, job_id, attempt_count, manifest, manifest_sha256)
select pg_temp.fixture_id(13), pg_temp.fixture_id(2), pg_temp.fixture_id(11), pg_temp.fixture_id(12), 1,
  :'context_manifest'::jsonb, encode(sha256(convert_to((:'context_manifest'::jsonb)::text, 'UTF8')), 'hex');
commit;
