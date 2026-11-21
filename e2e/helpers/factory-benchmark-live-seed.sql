begin;
set local request.jwt.claim.role = 'service_role';

-- The managed image, provider key, checkout and capability receipts are local
-- fixtures. The browser uses the real connection, freeze and schedule APIs.
insert into public.factory_definition_revisions (
  id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
) values (:'definition_id', :'workspace_id', :'factory_id', 1,
  :'definition_json', :'definition_digest', :'owner_id');

insert into public.workspace_vercel_sandbox_connections (
  workspace_id, connection_revision, encrypted_token, team_id, project_id
) values (
  :'workspace_id', :'sandbox_revision', 'synthetic-local-token', 'team_live_browser', 'prj_live_browser'
);

insert into public.sandbox_capability_checks (
  id, workspace_id, github_repository_id, sandbox_provider, sandbox_id, sandbox_connection_revision,
  sandbox_vercel_team_id, sandbox_vercel_project_id, agent_provider, agent_model, status, capabilities
)
select id, :'workspace_id', :'repository_id', 'vercel', 'sbx_live_browser_' || harness, :'sandbox_revision',
  'team_live_browser', 'prj_live_browser', harness, model, 'success',
  jsonb_build_object(
    'agentCli', jsonb_build_object('ok', true, 'detail', cli),
    'git', jsonb_build_object('ok', true, 'detail', 'git version 2.51.0'),
    'node', jsonb_build_object('ok', true, 'detail', 'v22.23.1'),
    'packageManager', jsonb_build_object('ok', true, 'detail', 'pnpm 10.32.1'),
    'chromium', jsonb_build_object('ok', true, 'detail', 'Chromium 142.0.7444.175'),
    'playwrightPackage', jsonb_build_object('ok', true, 'detail', 'Playwright 1.57.0'),
    'screenshotSmoke', jsonb_build_object('ok', true, 'detail', 'Synthetic screenshot proof'),
    'codexExternalSandbox', jsonb_build_object('ok', true, 'detail', 'Synthetic sandbox proof')
  )
from (values
  (:'codex_id'::uuid, 'codex', 'gpt-4.1-2025-04-14', 'codex-cli 0.88.0'),
  (:'opencode_id'::uuid, 'opencode', 'openai/gpt-4.1-2025-04-14', 'opencode 1.2.27')
) as qualification(id, harness, model, cli);

create temporary table live_browser_task as
select task.* from public.create_factory_benchmark_task(
  :'workspace_id', :'factory_id', :'owner_id', :'source_run_id',
  'Verify the original invoice totals', 'A retry preserves the saved totals.', '{}', 'eligible'
) task;

insert into public.factory_benchmark_task_inputs (
  task_id, workspace_id, factory_id, source_run_id, source_session_id,
  source_job_id, source_attempt_count, definition_revision_id, definition_digest, repository_id, checkout_sha
)
select task.task_id, task.workspace_id, task.factory_id, run.id, run.session_id,
  run.agent_job_id, run.attempt_count, :'definition_id', :'definition_digest', :'repository_id', repeat('a', 40)
from live_browser_task task
join public.agent_runs run on (run.workspace_id, run.id) = (task.workspace_id, :'source_run_id'::uuid);

select jsonb_build_object('suiteId', suite.suite_id, 'suiteRevisionId', suite.id,
  'taskRevisionId', task.id, 'policyRevisionId', policy.id)
from live_browser_task task
cross join lateral public.save_factory_benchmark_suite_revision(
  :'workspace_id', :'factory_id', :'owner_id', 'Invoice replay harness comparison', 'regression',
  p_task_revision_ids => array[task.id]
) suite
cross join lateral public.publish_factory_benchmark_replay_policy(
  :'workspace_id', :'factory_id', :'owner_id', 'blocked'
) policy;

commit;
