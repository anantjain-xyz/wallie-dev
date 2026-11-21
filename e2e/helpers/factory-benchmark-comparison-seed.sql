begin;
set local request.jwt.claim.role = 'service_role';

-- Synthetic local records stand in for hosted sandbox probes. The browser
-- still uses the real catalog, pair validation and matrix freeze.
with definitions as (
  insert into public.factory_definition_revisions (
    id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
  ) values
    (:'baseline_id', :'workspace_id', :'factory_id', 1, :'baseline_json', :'baseline_digest', :'owner_id'),
    (:'candidate_id', :'workspace_id', :'factory_id', 1, :'candidate_json', :'candidate_digest', :'owner_id')
  returning id
),
connection as (
  insert into public.workspace_vercel_sandbox_connections (
    workspace_id, encrypted_token, team_id, project_id
  )
  values (:'workspace_id', 'synthetic-local-token', 'team_comparison_fixture', 'prj_comparison_fixture')
  returning connection_revision, team_id, project_id
),
checks as (
  insert into public.sandbox_capability_checks (
    id, workspace_id, github_repository_id, sandbox_provider, sandbox_id, sandbox_connection_revision,
    sandbox_vercel_team_id, sandbox_vercel_project_id, agent_provider, agent_model, status, capabilities
  )
  select id, :'workspace_id', :'repository_id', 'vercel', 'sbx_comparison_' || harness, connection_revision,
    team_id, project_id, harness, model, 'success',
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
  from connection cross join (values
    (:'codex_id'::uuid, 'codex', 'gpt-4.1-2025-04-14', 'codex-cli 0.88.0'),
    (:'opencode_id'::uuid, 'opencode', 'openai/gpt-4.1-2025-04-14', 'opencode 1.2.27')
  ) as qualification(id, harness, model, cli)
  returning id
)
select jsonb_build_object('definitions', (select count(*) from definitions),
  'qualifications', (select count(*) from checks),
  'connectionRevision', (select connection_revision from connection));

commit;
