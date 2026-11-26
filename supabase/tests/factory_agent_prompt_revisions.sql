begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

insert into auth.users(id, email) values
  ('55200000-0000-4000-8000-000000000001', 'agent-owner@example.test'),
  ('55200000-0000-4000-8000-000000000002', 'agent-reader@example.test');
insert into public.workspaces(id, slug, name) values
  ('55200000-1000-4000-8000-000000000001', 'agent-prompts-primary', 'Agent prompts primary'),
  ('55200000-1000-4000-8000-000000000002', 'agent-prompts-other', 'Agent prompts other');
insert into public.workspace_members(workspace_id, user_id, kind, role) values
  ('55200000-1000-4000-8000-000000000001', '55200000-0000-4000-8000-000000000001', 'human', 'owner'),
  ('55200000-1000-4000-8000-000000000001', '55200000-0000-4000-8000-000000000002', 'human', 'member');
insert into public.factories(id, workspace_id, name, slug, is_default) values
  ('55200000-2000-4000-8000-000000000002', '55200000-1000-4000-8000-000000000001',
    'Restricted agent factory', 'restricted', false);

create temporary table agent_fixture(key text primary key, id uuid not null);
insert into agent_fixture select 'factory', id from public.factories
where workspace_id = '55200000-1000-4000-8000-000000000001' and is_default;
insert into agent_fixture select 'implementation', id from public.factory_agents
where factory_id = (select id from agent_fixture where key = 'factory') and is_default;
insert into agent_fixture select 'initial-prompt', id from public.factory_agent_prompt_revisions
where agent_id = (select id from agent_fixture where key = 'implementation') and revision_number = 1;

select is((select count(*) from public.factories factory where not exists (
  select 1 from public.factory_agents agent where agent.factory_id = factory.id and agent.is_default
)), 0::bigint, 'each migrated or newly created factory has its implementation agent');
select is((select prompt_md from public.factory_agent_prompt_revisions
  where id = (select id from agent_fixture where key = 'initial-prompt')), '',
  'the migrated implementation prompt is empty so stage behavior is preserved');
select ok(not has_table_privilege('authenticated', 'public.factory_agents', 'INSERT'),
  'browser roles cannot bypass agent mutation commands');
select ok(not has_table_privilege('service_role', 'public.factory_agent_prompt_revisions', 'UPDATE'),
  'service clients cannot rewrite immutable prompt revisions');
select ok(not has_function_privilege('authenticated',
  'public.save_factory_agent_prompt_revision(uuid,uuid,uuid,uuid,integer,text)', 'EXECUTE'),
  'prompt mutation is available only through privileged routes');

insert into agent_fixture
select 'candidate-prompt', id from public.save_factory_agent_prompt_revision(
  '55200000-1000-4000-8000-000000000001', (select id from agent_fixture where key = 'factory'),
  '55200000-0000-4000-8000-000000000001', (select id from agent_fixture where key = 'implementation'),
  1, 'Review correctness. Preserve the literal {{session.prompt}} placeholder.');
select is((select revision_number from public.factory_agent_prompt_revisions
  where id = (select id from agent_fixture where key = 'candidate-prompt')), 2,
  'editing an implementation prompt appends a candidate revision');
select is((select prompt_md from public.factory_agent_prompt_revisions
  where id = (select id from agent_fixture where key = 'initial-prompt')), '',
  'editing leaves the historical prompt bytes unchanged');
select is((select count(*) from public.factory_audit_events
  where workspace_id = '55200000-1000-4000-8000-000000000001'
    and action = 'agent.prompt_revision_created'), 1::bigint,
  'appending a prompt records its immutable revision identity in the audit trail');
select throws_ok($sql$select public.save_factory_agent_prompt_revision(
  '55200000-1000-4000-8000-000000000001', (select id from agent_fixture where key = 'factory'),
  '55200000-0000-4000-8000-000000000001', (select id from agent_fixture where key = 'implementation'),
  1, 'stale write')$sql$, 'PT409', 'The agent prompt changed. Reload its revision before saving.',
  'a stale prompt editor cannot overwrite a concurrent candidate');
select throws_ok($sql$select public.save_factory_agent_prompt_revision(
  '55200000-1000-4000-8000-000000000001', (select id from agent_fixture where key = 'factory'),
  '55200000-0000-4000-8000-000000000002', (select id from agent_fixture where key = 'implementation'),
  2, 'unauthorized write')$sql$, '42501', 'Factory manager access is required.',
  'an ordinary factory member cannot change trusted agent instructions');

insert into agent_fixture select 'named-prompt', id from public.create_factory_agent(
  '55200000-1000-4000-8000-000000000001', (select id from agent_fixture where key = 'factory'),
  '55200000-0000-4000-8000-000000000001', 'Repository maintainer', 'maintainer', 'Check repository conventions.');
select is((select name from public.factory_agents agent join public.factory_agent_prompt_revisions revision
  on revision.agent_id = agent.id where revision.id = (select id from agent_fixture where key = 'named-prompt')),
  'Repository maintainer', 'a named agent has a stable identity separate from its prompt revision');
select is((select authority from public.factory_agents agent join public.factory_agent_prompt_revisions revision
  on revision.agent_id = agent.id where revision.id = (select id from agent_fixture where key = 'named-prompt')),
  'implementation', 'creating a named agent retains the declared implementation authority');

create function pg_temp.agent_snapshot(p_revision_id uuid) returns jsonb language sql as $$
  select jsonb_build_object('agentId', agent_id, 'promptRevisionId', id,
    'promptMd', prompt_md, 'promptSha256', prompt_sha256)
  from public.factory_agent_prompt_revisions where id = p_revision_id;
$$;
create function pg_temp.save_agent_candidate(p_snapshot jsonb) returns uuid language sql as $$
  select (public.save_factory_definition_draft(
    '55200000-1000-4000-8000-000000000001', (select id from agent_fixture where key = 'factory'),
    '55200000-0000-4000-8000-000000000001', 0,
    candidate.definition, encode(sha256(convert_to(candidate.definition, 'UTF8')), 'hex'))).id
  from (select jsonb_build_object('schemaVersion', 1, 'kind', 'serial', 'implementationAgent', p_snapshot)::text as definition) candidate;
$$;
select lives_ok($sql$select pg_temp.save_agent_candidate(pg_temp.agent_snapshot(
  (select id from agent_fixture where key = 'named-prompt')))$sql$,
  'definition drafts retain the exact immutable named-agent snapshot');
select throws_ok($sql$select pg_temp.save_agent_candidate(jsonb_set(pg_temp.agent_snapshot(
  (select id from agent_fixture where key = 'named-prompt')), '{promptMd}', '"changed bytes"'::jsonb))$sql$,
  'PT422', 'The implementation agent snapshot must match a prompt revision in this factory.',
  'a forged compiled prompt cannot disagree with the immutable revision');
select throws_ok($sql$select pg_temp.save_agent_candidate(pg_temp.agent_snapshot((
  select id from public.factory_agent_prompt_revisions
  where factory_id = '55200000-2000-4000-8000-000000000002' and revision_number = 1
)))$sql$, 'PT422', 'The implementation agent snapshot must match a prompt revision in this factory.',
  'a definition cannot borrow another factory agent');
select throws_ok($sql$select pg_temp.save_agent_candidate(pg_temp.agent_snapshot(
  (select id from agent_fixture where key = 'named-prompt')) || '{"authority":"foreman"}'::jsonb)$sql$,
  'PT422', 'The implementation agent snapshot must match a prompt revision in this factory.',
  'a prompt binding cannot introduce authority fields');
select throws_ok($sql$select pg_temp.save_agent_candidate(jsonb_set(pg_temp.agent_snapshot(
  (select id from agent_fixture where key = 'named-prompt')), '{promptMd}', '1'::jsonb))$sql$,
  'PT422', 'The implementation agent snapshot must match a prompt revision in this factory.',
  'a compiled prompt snapshot requires string values');

insert into public.pipelines(id, workspace_id, name) values
  ('55200000-3000-4000-8000-000000000001', '55200000-1000-4000-8000-000000000001', 'Custom stage pipeline');
insert into public.pipeline_stages(id, workspace_id, pipeline_id, slug, name, position) values
  ('55200000-4000-4000-8000-000000000001', '55200000-1000-4000-8000-000000000001',
    '55200000-3000-4000-8000-000000000001', 'inspect', 'Inspect', 1);
insert into public.sessions(id, workspace_id, number, title, pipeline_id, current_stage_id) values
  ('55200000-5000-4000-8000-000000000001', '55200000-1000-4000-8000-000000000001', 1, 'Custom execution',
    '55200000-3000-4000-8000-000000000001', '55200000-4000-4000-8000-000000000001');
insert into public.agent_runs(id, workspace_id, session_id, stage_id, run_type, model_provider, model_name, created_at) values
  ('55200000-6000-4000-8000-000000000001', '55200000-1000-4000-8000-000000000001',
    '55200000-5000-4000-8000-000000000001', '55200000-4000-4000-8000-000000000001', 'research', 'codex', 'gpt-5.5', clock_timestamp());
select is((select agent_id from public.agent_runs where id = '55200000-6000-4000-8000-000000000001'),
  (select id from agent_fixture where key = 'implementation'), 'a custom stage executes through the default implementation identity');
select is((select agent_prompt_revision_id from public.agent_runs where id = '55200000-6000-4000-8000-000000000001'),
  (select id from agent_fixture where key = 'initial-prompt'), 'unbound execution retains the empty first revision after candidate editing');
select throws_ok($sql$update public.agent_runs set agent_prompt_revision_id =
  (select id from agent_fixture where key = 'candidate-prompt')
  where id = '55200000-6000-4000-8000-000000000001'$sql$,
  '23514', 'Run agent identity and prompt revision are immutable.', 'an active run cannot adopt edited instructions');
select throws_ok($sql$update public.factory_agent_prompt_revisions set prompt_md = 'rewritten'
  where id = (select id from agent_fixture where key = 'candidate-prompt')$sql$,
  '23514', 'Agent identities and prompt revisions are immutable.', 'prompt revisions cannot be edited in place');

-- The real queue mutation uses SECURITY INVOKER under service_role. Exercise
-- that role with an explicitly pinned named agent, rather than only setting
-- the request role claim while running with the database owner privileges.
insert into public.factory_definition_revisions(
  id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
)
select '55200000-7000-4000-8000-000000000001', '55200000-1000-4000-8000-000000000001',
  (select id from agent_fixture where key = 'factory'), 1, definition,
  encode(sha256(convert_to(definition, 'UTF8')), 'hex'), '55200000-0000-4000-8000-000000000001'
from (select jsonb_build_object('schemaVersion', 1, 'kind', 'serial',
  'pipelineId', '55200000-3000-4000-8000-000000000001', 'implementationAgent',
  pg_temp.agent_snapshot((select id from agent_fixture where key = 'named-prompt')))::text as definition) candidate;
insert into public.sessions(id, workspace_id, number, title, pipeline_id, current_stage_id,
  factory_definition_provenance, factory_definition_revision_id, execute_pinned_definition) values
  ('55200000-5000-4000-8000-000000000002', '55200000-1000-4000-8000-000000000001', 2, 'Pinned custom execution',
    '55200000-3000-4000-8000-000000000001', '55200000-4000-4000-8000-000000000001',
    'pinned', '55200000-7000-4000-8000-000000000001', true);
set local role service_role;
select lives_ok($sql$insert into public.agent_runs(id, workspace_id, session_id, stage_id, run_type, model_provider, model_name, created_at)
  values ('55200000-6000-4000-8000-000000000002', '55200000-1000-4000-8000-000000000001',
    '55200000-5000-4000-8000-000000000002', '55200000-4000-4000-8000-000000000001', 'research', 'codex', 'gpt-5.5', clock_timestamp())$sql$,
  'service-role execution can insert a run with the exact compiled agent snapshot');
select is((select agent_prompt_revision_id from public.agent_runs
  where id = '55200000-6000-4000-8000-000000000002'),
  (select id from public.factory_agent_prompt_revisions where prompt_md = 'Check repository conventions.'
    and workspace_id = '55200000-1000-4000-8000-000000000001'),
  'the run pins the selected named agent revision rather than the default agent');
reset role;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '55200000-0000-4000-8000-000000000002';
select is((select count(*) from public.factory_agents), 2::bigint,
  'a factory member reads only its default and named agent identities');
select is((select count(*) from public.factory_agent_prompt_revisions), 3::bigint,
  'prompt history hides restricted and foreign factories');
select is((
  select catalog.run_id from public.factory_agent_prompt_revisions prompt
  cross join lateral public.list_workspace_run_catalog(prompt.workspace_id,
    p_factory_id => prompt.factory_id, p_agent_id => prompt.agent_id,
    p_agent_prompt_revision_id => prompt.id, p_limit => 1) catalog
  where prompt.prompt_md = 'Check repository conventions.'
), '55200000-6000-4000-8000-000000000002'::uuid,
  'a factory member can inspect the exact pinned named prompt revision');
select is((
  select count(*) from public.factory_agent_prompt_revisions prompt
  join public.factory_agents agent on agent.factory_id = prompt.factory_id and agent.is_default
  cross join lateral public.list_workspace_run_catalog(prompt.workspace_id,
    p_agent_id => agent.id, p_agent_prompt_revision_id => prompt.id) catalog
  where prompt.prompt_md = 'Check repository conventions.'
), 0::bigint, 'a prompt revision from a different agent does not match a run');
select is((
  select count(*) from public.factory_agent_prompt_revisions prompt
  cross join lateral public.list_workspace_run_catalog(prompt.workspace_id,
    p_agent_id => prompt.agent_id, p_agent_prompt_revision_id => prompt.id) catalog
  where prompt.revision_number = 1 and prompt.prompt_md = ''
), 0::bigint, 'legacy default pins do not appear as actual prompt revision usage');
reset role;
set local request.jwt.claim.role = 'service_role';
select public.archive_factory('55200000-1000-4000-8000-000000000001',
  (select id from agent_fixture where key = 'factory'), '55200000-0000-4000-8000-000000000001');
select throws_ok($sql$select public.save_factory_agent_prompt_revision(
  '55200000-1000-4000-8000-000000000001', (select id from agent_fixture where key = 'factory'),
  '55200000-0000-4000-8000-000000000001', (select id from agent_fixture where key = 'implementation'),
  2, 'archived candidate')$sql$, 'P0011', 'Factory is archived.', 'an archived factory cannot create prompt candidates');

select * from finish();
rollback;
