begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '64500000-0000-4000-8000-000000000001';

create function pg_temp.op645_id(slot integer) returns uuid language sql immutable as $$
  select ('64500000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
insert into auth.users(id, email) values
  (pg_temp.op645_id(1), 'op645-owner@example.test'),
  (pg_temp.op645_id(2), 'op645-foreign-owner@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.op645_id(11), 'op645-workflow-fixture', 'Workflow policy fixture'),
  (pg_temp.op645_id(12), 'op645-foreign-fixture', 'Unrelated workflow fixture');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.op645_id(21), pg_temp.op645_id(11), pg_temp.op645_id(1), 'human', 'owner'),
  (pg_temp.op645_id(22), pg_temp.op645_id(12), pg_temp.op645_id(2), 'human', 'owner');
insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential)
values (pg_temp.op645_id(1), 'platform_api_key', 'fixture-ciphertext');

create temp table op645_scope as
select workspace_id, id as factory_id from public.factories
where workspace_id = pg_temp.op645_id(11) and is_default;
insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
select pg_temp.op645_id(31), workspace_id, factory_id, 'Workflow receipt pipeline', true from op645_scope;
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name)
values (pg_temp.op645_id(32), pg_temp.op645_id(31), pg_temp.op645_id(11), 1, 'inspect-output', 'Inspect output');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.op645_id(33), pg_temp.op645_id(11), 64500033, 'https://github.test/installations/64500033',
  645000, 'Organization', 'Fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name, private, html_url, default_branch)
select pg_temp.op645_id(34), workspace_id, factory_id, pg_temp.op645_id(33), 64500034,
  'workflow-fixture', 'fixture/workflow-fixture', true, 'https://github.test/fixture/workflow-fixture', 'main'
from op645_scope;

with definition as (
  select workspace_id, factory_id, jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.op645_id(31),
    'repositoryId', pg_temp.op645_id(34), 'sandboxProvider', 'e2b',
    'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5', 'effort', 'high',
      'concurrencyLimit', 1, 'stallTimeoutMs', 900000, 'maxRetries', 3, 'maxTurns', 5),
    'executionPolicyRevisionId', null, 'deliveryPolicyRevisionId', null,
    'skillIds', '[]'::jsonb, 'toolIds', '[]'::jsonb, 'operatingRulesMd', '', 'operatingRuleStageIds', '[]'::jsonb,
    'stages', jsonb_build_array(jsonb_build_object('id', pg_temp.op645_id(32), 'slug', 'inspect-output',
      'name', 'Inspect output', 'description', '', 'promptTemplateMd', 'Inspect the admitted output.',
      'anyoneCanApprove', false, 'previousStageIds', '[]'::jsonb,
      'approverMemberIds', jsonb_build_array(pg_temp.op645_id(21))))
  )::text as body from op645_scope
), revision as (
  insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version,
    definition_json, canonical_digest, created_by)
  select pg_temp.op645_id(41), workspace_id, factory_id, 1, body,
    encode(sha256(convert_to(body, 'UTF8')), 'hex'), pg_temp.op645_id(21)
  from definition returning id, workspace_id, factory_id, created_by
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 1, created_by from revision;

create temp table op645_admitted as
select * from public.create_session_with_first_job(
  pg_temp.op645_id(11), pg_temp.op645_id(21), 'Workflow policy fixture', 'Inspect the admitted output.',
  'codex', 'gpt-5.5');

create temp table op645_graphs as
select scenario, body, encode(sha256(convert_to(body, 'UTF8')), 'hex') as digest
from (values
  ('policy', '{"kind":"graph","schemaVersion":1,"entryNodeId":"policy.check","nodes":[{"id":"policy.check","kind":"deterministic","operation":"policy"},{"id":"policy.recheck","kind":"deterministic","operation":"policy"}],"edges":[{"id":"next.policy.check","kind":"next","from":"policy.check","to":"policy.recheck"}],"grants":[]}'),
  ('needs-input', '{"kind":"graph","schemaVersion":1,"entryNodeId":"checkpoint.check","nodes":[{"id":"checkpoint.check","kind":"deterministic","operation":"checkpoint"}],"edges":[],"grants":[]}'),
  ('validation', '{"kind":"graph","schemaVersion":1,"entryNodeId":"validation.check","nodes":[{"id":"validation.check","kind":"deterministic","operation":"validation"}],"edges":[],"grants":[]}'),
  ('unsupported', '{"kind":"graph","schemaVersion":1,"entryNodeId":"agent.review","nodes":[{"id":"agent.review","kind":"agent","agentPromptRevisionId":"64500000-0000-4000-8000-000000000099"}],"edges":[],"grants":[]}')
) inputs(scenario, body);

insert into op645_graphs(scenario, body, digest)
with cases(scenario, node_ids, edges) as (
  values
    ('fork', array['policy.root', 'policy.left', 'policy.right'],
      '[{"id":"next.left","kind":"next","from":"policy.root","to":"policy.left"},{"id":"next.right","kind":"next","from":"policy.root","to":"policy.right"}]'::jsonb),
    ('disconnected-cycle', array['policy.root', 'policy.left', 'policy.right'],
      '[{"id":"next.left","kind":"next","from":"policy.left","to":"policy.right"},{"id":"next.right","kind":"next","from":"policy.right","to":"policy.left"}]'::jsonb),
    ('duplicate-node', array['policy.root', 'policy.left', 'policy.left'],
      '[{"id":"next.one","kind":"next","from":"policy.root","to":"policy.left"},{"id":"next.two","kind":"next","from":"policy.left","to":"policy.root"}]'::jsonb),
    ('duplicate-edge', array['policy.root', 'policy.left', 'policy.right'],
      '[{"id":"next.repeat","kind":"next","from":"policy.root","to":"policy.left"},{"id":"next.repeat","kind":"next","from":"policy.left","to":"policy.right"}]'::jsonb),
    ('dangling-edge', array['policy.root', 'policy.left'],
      '[{"id":"next.missing","kind":"next","from":"policy.root","to":"policy.missing"}]'::jsonb),
    ('missing-kind', array['policy.root', 'policy.left'],
      '[{"id":"next.left","from":"policy.root","to":"policy.left"}]'::jsonb)
), compiled as (
  select scenario, jsonb_build_object('kind', 'graph', 'schemaVersion', 1, 'entryNodeId', node_ids[1],
    'nodes', (select jsonb_agg(jsonb_build_object('id', node.id, 'kind', 'deterministic', 'operation', 'policy') order by node.position)
      from unnest(node_ids) with ordinality node(id, position)), 'edges', edges, 'grants', '[]'::jsonb)::text as body
  from cases
  union all
  select scenario, jsonb_build_object('kind', 'graph', 'schemaVersion', 1, 'entryNodeId', 'policy.1',
    'nodes', (select jsonb_agg(jsonb_build_object('id', 'policy.' || node, 'kind', 'deterministic', 'operation', 'policy') order by node)
      from generate_series(1, length) node),
    'edges', (select jsonb_agg(jsonb_build_object('id', 'next.' || node, 'kind', 'next',
      'from', 'policy.' || node, 'to', 'policy.' || (node + 1)) order by node) from generate_series(1, length - 1) node),
    'grants', '[]'::jsonb)::text
  from (values ('at-limit', 128), ('over-limit', 129)) limits(scenario, length)
)
select scenario, body, encode(sha256(convert_to(body, 'UTF8')), 'hex') from compiled;

create temp table op645_root as
select pin.session_id as root_session_id, pin.workspace_id, pin.factory_id, pin.definition_revision_id, pin.definition_digest
from op645_admitted admitted join public.session_factory_admission_inputs pin using (session_id);

select throws_ok($$select public.register_factory_workflow_graph_revision(workspace_id, factory_id, definition_revision_id,
  definition_digest, body, repeat('0', 64)) from op645_root cross join op645_graphs where scenario = 'policy'$$,
  '22023', 'A verified compiled workflow graph is required.', 'registration checks the exact graph digest');
select throws_ok($$select public.register_factory_workflow_graph_revision(workspace_id, factory_id, definition_revision_id,
  repeat('0', 64), body, digest) from op645_root cross join op645_graphs where scenario = 'policy'$$,
  'PT404', 'The graph base definition revision is unavailable.', 'registration checks the exact base definition digest');
select throws_ok($$select public.register_factory_workflow_graph_revision(foreign_factory.workspace_id, foreign_factory.id,
  definition_revision_id, definition_digest, body, digest) from op645_root cross join op645_graphs
  cross join public.factories foreign_factory
  where scenario = 'policy' and foreign_factory.workspace_id = pg_temp.op645_id(12) and foreign_factory.is_default$$,
  'PT404', 'The graph base definition revision is unavailable.', 'another factory cannot register this base revision');

create temp table op645_registered as
select candidate.scenario, registered.* from op645_root root cross join op645_graphs candidate
cross join lateral public.register_factory_workflow_graph_revision(root.workspace_id, root.factory_id,
  root.definition_revision_id, root.definition_digest, candidate.body, candidate.digest) registered;
select ok((select registered.created and registered.graph_revision_id is not null and not replay.created
    and replay.graph_revision_id = registered.graph_revision_id
  from op645_root root cross join op645_graphs graph join op645_registered registered using (scenario)
  cross join lateral public.register_factory_workflow_graph_revision(root.workspace_id, root.factory_id,
    root.definition_revision_id, root.definition_digest, graph.body, graph.digest) replay where graph.scenario = 'policy'),
  'registration replays the exact compiled graph revision');
select throws_ok($$select public.start_factory_workflow_graph_execution(root_session_id, foreign_factory.workspace_id,
  foreign_factory.id, graph_revision_id) from op645_root cross join op645_registered
  cross join public.factories foreign_factory
  where scenario = 'policy' and foreign_factory.workspace_id = pg_temp.op645_id(12) and foreign_factory.is_default$$,
  'PT404', 'Workflow root session is unavailable.', 'graph enrollment respects the root factory scope');
select throws_ok($$select public.start_factory_workflow_graph_execution(root_session_id, workspace_id, factory_id,
  graph_revision_id) from op645_root cross join op645_registered where scenario = 'unsupported'$$,
  'PT422', 'The graph requires workflow capabilities that are unavailable.', 'graph enrollment rejects an unsupported agent node');
select throws_ok($$select public.start_factory_workflow_graph_execution(root_session_id, workspace_id, factory_id,
  graph_revision_id) from op645_root cross join op645_registered where scenario = 'validation'$$,
  'PT422', 'The graph requires a pinned delivery policy with valid required evidence.', 'validation requires a pinned delivery policy');
select throws_ok($$select public.start_factory_workflow_graph_execution(root_session_id, workspace_id, factory_id,
  graph_revision_id) from op645_root cross join op645_registered where scenario = 'needs-input'$$,
  'PT422', 'The graph requires a scoped checkpoint input run.', 'an evidence-dependent graph requires an immutable input run');
select throws_ok(format('select public.start_factory_workflow_graph_execution(%L,%L,%L,%L)',
  root.root_session_id, root.workspace_id, root.factory_id, registered.graph_revision_id),
  'PT422', 'The graph must form one next-only path with at most 128 nodes.',
  'enrollment rejects ' || registered.scenario)
from op645_root root cross join op645_registered registered
where registered.scenario in ('fork', 'disconnected-cycle', 'duplicate-node', 'duplicate-edge',
  'dangling-edge', 'missing-kind', 'over-limit') order by registered.scenario;
select is((select public.read_factory_workflow_execution(root_session_id, workspace_id, factory_id) from op645_root),
  null::jsonb, 'failed enrollment leaves no execution');

create temp table op645_limit_root as
select * from public.create_session_with_first_job(pg_temp.op645_id(11), pg_temp.op645_id(21),
  'Maximum workflow path fixture', 'Inspect the admitted output.', 'codex', 'gpt-5.5');
select ok((select started.created and started.ownership_token is not null
  from op645_limit_root root cross join op645_root scope cross join op645_registered registered
  cross join lateral public.start_factory_workflow_graph_execution(root.session_id, scope.workspace_id, scope.factory_id,
    registered.graph_revision_id) started where registered.scenario = 'at-limit'), 'the executor enrolls a path of exactly 128 nodes');

select throws_ok($$select public.start_factory_workflow_graph_execution(root.root_session_id, root.workspace_id,
  root.factory_id, registered.graph_revision_id, other_run.run_id)
  from op645_root root cross join op645_registered registered cross join op645_limit_root other_run
  where registered.scenario = 'policy'$$, 'PT409', 'The graph input run has no current scoped checkpoint publication intent.',
  'a real run from another root cannot pin graph input');
select throws_ok($$select public.start_factory_workflow_graph_execution(root.root_session_id, root.workspace_id,
  root.factory_id, registered.graph_revision_id, pg_temp.op645_id(98))
  from op645_root root cross join op645_registered registered where registered.scenario = 'policy'$$,
  'PT409', 'The graph input run has no current scoped checkpoint publication intent.', 'a missing input run cannot pin graph input');
select throws_ok($$select public.start_factory_workflow_graph_execution(root.root_session_id, root.workspace_id,
  root.factory_id, registered.graph_revision_id, admitted.run_id)
  from op645_root root join op645_admitted admitted on admitted.session_id = root.root_session_id
  cross join op645_registered registered where registered.scenario = 'policy'$$,
  'PT409', 'The graph input run has no current scoped checkpoint publication intent.', 'a queued run without an intent cannot pin graph input');

create temp table op645_started as
select root.*, registered.graph_revision_id, started.* from op645_root root cross join op645_registered registered
cross join lateral public.start_factory_workflow_graph_execution(root.root_session_id, root.workspace_id, root.factory_id,
  registered.graph_revision_id) started where registered.scenario = 'policy';
select ok((select started.created and execution_generation = 1 and started.entry_occurrence_id is not null
    and started.ownership_token is not null
    and snapshot.value#>>'{execution,graph_revision_id}' = started.graph_revision_id::text
    and snapshot.value#>'{execution,graph_input_run_id}' = 'null'::jsonb
    and snapshot.value#>>'{execution,definition_revision_id}' = started.definition_revision_id::text
    and snapshot.value#>>'{execution,definition_digest}' = started.definition_digest
    and not (snapshot.value->'execution' ? 'ownership_token')
    and snapshot.value#>>'{execution,workflow_json}' = graph.body and snapshot.value#>>'{execution,workflow_digest}' = graph.digest
    and snapshot.value#>>'{occurrences,0,occurrence_id}' = started.entry_occurrence_id::text
    and snapshot.value#>>'{occurrences,0,node_id}' = 'policy.check'
  from op645_started started cross join op645_graphs graph
  cross join lateral (select public.read_factory_workflow_execution(root_session_id, workspace_id, factory_id) as value) snapshot
  where graph.scenario = 'policy'), 'enrollment freezes the exact registered graph and its policy entry on the root');
select ok((select not replay.created and replay.execution_generation = started.execution_generation
    and replay.entry_occurrence_id = started.entry_occurrence_id and replay.ownership_token is null
  from op645_started started cross join lateral public.start_factory_workflow_graph_execution(started.root_session_id,
    started.workspace_id, started.factory_id, started.graph_revision_id) replay), 'enrollment replay returns the same entry without exposing ownership');
select throws_ok($$select public.start_factory_workflow_graph_execution(root_session_id, workspace_id,
  factory_id, graph_revision_id, admitted.run_id) from op645_started started
  join op645_admitted admitted on admitted.session_id = started.root_session_id$$,
  'PT409', 'The root session already has a different workflow or input run.', 'enrollment replay cannot change the original null input run');
select ok((select checked.policy_revision_id is null and checked.exhaustion_code is null
  from op645_started started cross join lateral public.check_factory_workflow_execution_policy(started.root_session_id,
    started.workspace_id, started.factory_id, started.execution_generation, started.ownership_token, started.entry_occurrence_id) checked),
  'a missing policy produces a pending observation');
select ok((select snapshot.value->'results' = '[]'::jsonb and snapshot.value->'runnableTransitions' = '[]'::jsonb
  from op645_started cross join lateral (select public.read_factory_workflow_execution(root_session_id, workspace_id, factory_id) as value) snapshot),
  'a pending policy observation produces no result or runnable edge');
create temp table op645_handoff as
select advanced.* from op645_started started cross join lateral public.advance_factory_workflow_generation(
  started.root_session_id, started.workspace_id, started.factory_id, started.execution_generation) advanced;
select ok((select handoff.execution_generation = 2 and handoff.ownership_token is not null
    and handoff.ownership_token is distinct from started.ownership_token
  from op645_started started cross join op645_handoff handoff), 'handoff advances the generation and rotates the token');
select throws_ok($$select public.check_factory_workflow_execution_policy(root_session_id, workspace_id, factory_id,
  execution_generation, ownership_token, entry_occurrence_id) from op645_started$$, 'PT409', 'Workflow generation is stale.',
  'the previous generation cannot evaluate a policy occurrence');
select throws_ok($$select public.check_factory_workflow_execution_policy(started.root_session_id, started.workspace_id,
  started.factory_id, handoff.execution_generation, started.ownership_token, started.entry_occurrence_id)
  from op645_started started cross join op645_handoff handoff$$, 'PT409', 'Workflow ownership token is stale.',
  'the previous owner cannot evaluate a policy by guessing the new generation');
select throws_ok($$select public.check_factory_workflow_execution_policy(started.root_session_id, started.workspace_id,
  started.factory_id, handoff.execution_generation, handoff.ownership_token, pg_temp.op645_id(99))
  from op645_started started cross join op645_handoff handoff$$, 'PT404', 'Workflow policy occurrence is unavailable.',
  'policy evaluation requires the exact admitted policy occurrence');
select ok((select checked.policy_revision_id is null and checked.exhaustion_code is null
  from op645_started started cross join op645_handoff handoff
  cross join lateral public.check_factory_workflow_execution_policy(started.root_session_id, started.workspace_id,
    started.factory_id, handoff.execution_generation, handoff.ownership_token, started.entry_occurrence_id) checked),
  'the new owner can evaluate the same admitted occurrence');

select throws_ok($$select public.acquire_factory_workflow_ownership(started.root_session_id, foreign_factory.workspace_id,
  foreign_factory.id, handoff.execution_generation, pg_temp.op645_id(80))
  from op645_started started cross join op645_handoff handoff cross join public.factories foreign_factory
  where foreign_factory.workspace_id = pg_temp.op645_id(12) and foreign_factory.is_default$$,
  'PT404', 'Workflow root session is unavailable.', 'ownership acquisition respects the exact factory scope');
create temp table op645_acquired as
select acquired.* from op645_started started cross join op645_handoff handoff
cross join lateral public.acquire_factory_workflow_ownership(started.root_session_id, started.workspace_id,
  started.factory_id, handoff.execution_generation, pg_temp.op645_id(80)) acquired;
select ok((select acquired.execution_generation = handoff.execution_generation + 1
    and acquired.ownership_token = pg_temp.op645_id(80)
  from op645_acquired acquired cross join op645_handoff handoff), 'acquisition rotates ownership to the supplied candidate');
select ok((select (replay.execution_generation, replay.ownership_token) = (acquired.execution_generation, acquired.ownership_token)
  from op645_started started cross join op645_handoff handoff cross join op645_acquired acquired
  cross join lateral public.acquire_factory_workflow_ownership(started.root_session_id, started.workspace_id,
    started.factory_id, handoff.execution_generation, pg_temp.op645_id(80)) replay), 'the same candidate recovers an exact acquisition replay');
select is((select count(*) from op645_started started cross join op645_handoff handoff
  cross join lateral public.acquire_factory_workflow_ownership(started.root_session_id, started.workspace_id,
    started.factory_id, handoff.execution_generation, pg_temp.op645_id(81)) denied), 0::bigint,
  'a competing candidate for the previous generation cannot acquire ownership');
select is((select count(*) from op645_started started cross join op645_acquired acquired
  cross join lateral public.acquire_factory_workflow_ownership(started.root_session_id, started.workspace_id,
    started.factory_id, acquired.execution_generation, acquired.ownership_token) denied), 0::bigint,
  'a new acquisition requires a fresh candidate');
select ok((select not (public.read_factory_workflow_execution(root_session_id, workspace_id, factory_id)->'execution' ? 'ownership_token')
  from op645_started), 'acquired ownership stays out of restart reads');
select ok(has_function_privilege('service_role', 'public.acquire_factory_workflow_ownership(uuid,uuid,uuid,bigint,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.acquire_factory_workflow_ownership(uuid,uuid,uuid,bigint,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.acquire_factory_workflow_ownership(uuid,uuid,uuid,bigint,uuid)', 'EXECUTE'),
  'ownership acquisition is restricted to service callers');

-- Admit a second root from a definition that explicitly pins a real execution policy.
create temp table op645_policy as select * from public.save_execution_policy(pg_temp.op645_id(11), pg_temp.op645_id(1), 0,
  '{"version":1,"maxRepairAttempts":1,"maxExecutionMs":60000,"maxTotalTokens":null,"maxCostUsd":null}');
with definition as (
  select base.workspace_id, base.factory_id, base.created_by,
    jsonb_set(base.definition_json::jsonb, '{executionPolicyRevisionId}', to_jsonb(policy.id), false)::text as body
  from public.factory_definition_revisions base cross join op645_policy policy where base.id = pg_temp.op645_id(41)
), revision as (
  insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json,
    canonical_digest, created_by)
  select pg_temp.op645_id(42), workspace_id, factory_id, 1, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), created_by
  from definition returning id, workspace_id, factory_id, created_by
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 2, created_by from revision;
select public.set_git_continuity_release(true, revision, 'Workflow policy fixture')
from public.get_git_continuity_release_state() where not enabled;
create temp table op645_configured_session as
select fixture.scenario, admitted.*
from (values ('receipt', 'Workflow policy receipt fixture'), ('exhausted', 'Exhausted workflow policy fixture')) fixture(scenario, title)
cross join lateral public.create_session_with_first_job(pg_temp.op645_id(11), pg_temp.op645_id(21),
  fixture.title, 'Inspect the admitted output.', 'codex', 'gpt-5.5') admitted;
create temp table op645_configured as
select admitted.*, pin.workspace_id, pin.factory_id, pin.definition_revision_id, pin.definition_digest
from op645_configured_session admitted join public.session_factory_admission_inputs pin using (session_id);
select throws_ok($$select public.start_factory_workflow_graph_execution(root.session_id, root.workspace_id, root.factory_id,
  registered.graph_revision_id) from op645_configured root cross join op645_registered registered
  where root.scenario = 'receipt' and registered.scenario = 'policy'$$,
  'PT409', 'The graph revision must match an active session definition pin.',
  'a registered graph for the previous base definition cannot enroll this root');
create temp table op645_configured_graph as
select registered.graph_revision_id from op645_configured root cross join op645_graphs graph
cross join lateral public.register_factory_workflow_graph_revision(root.workspace_id, root.factory_id,
  root.definition_revision_id, root.definition_digest, graph.body, graph.digest) registered
where root.scenario = 'receipt' and graph.scenario = 'policy';
create temp table op645_configured_start as
select root.*, started.* from op645_configured root cross join op645_configured_graph registered
cross join lateral public.start_factory_workflow_graph_execution(root.session_id, root.workspace_id,
  root.factory_id, registered.graph_revision_id) started;
select ok((select checked.policy_revision_id = policy.id and checked.exhaustion_code is null
  from op645_configured_start started cross join op645_policy policy
  cross join lateral public.check_factory_workflow_execution_policy(started.session_id, started.workspace_id,
    started.factory_id, started.execution_generation, started.ownership_token, started.entry_occurrence_id) checked
  where started.scenario = 'receipt'), 'within-budget policy reports the exact configured revision');

select throws_ok($$select public.record_factory_workflow_node_result(started.session_id, started.workspace_id,
  started.factory_id, started.execution_generation, started.ownership_token, started.entry_occurrence_id,
  'succeeded', 'policy:' || policy.id) from op645_configured_start started cross join op645_policy policy
  where started.scenario = 'receipt'$$,
  '42501', 'This workflow node requires a guarded command result.', 'the generic result writer cannot complete a graph policy command');
select is((select count(*) from op645_configured_start started
  cross join lateral public.record_factory_workflow_command_result(started.session_id, started.workspace_id, started.factory_id,
    started.execution_generation, started.ownership_token, started.entry_occurrence_id, 'policy:' || pg_temp.op645_id(97)) denied
  where started.scenario = 'receipt'), 0::bigint, 'a well-formed reference to a different policy records no command result');
select is((select public.read_factory_workflow_execution(session_id, workspace_id, factory_id)->'results'
  from op645_configured_start where scenario = 'receipt'), '[]'::jsonb, 'invalid proof leaves the policy occurrence pending');

create temp table op645_command_result as
select receipt.*, 'policy:' || policy.id as evidence_ref from op645_configured_start started cross join op645_policy policy
cross join lateral public.record_factory_workflow_command_result(started.session_id, started.workspace_id, started.factory_id,
  started.execution_generation, started.ownership_token, started.entry_occurrence_id, 'policy:' || policy.id) receipt
where started.scenario = 'receipt';
select ok((select receipt.created and receipt.result_id is not null
    and snapshot.value->'results' @> jsonb_build_array(jsonb_build_object('result_id', receipt.result_id,
      'occurrence_id', started.entry_occurrence_id, 'outcome', 'succeeded', 'recorded_generation', started.execution_generation,
      'evidence_ref', receipt.evidence_ref))
    and snapshot.value->'runnableTransitions' = jsonb_build_array(jsonb_build_object('edgeId', 'next.policy.check',
      'sourceOccurrenceId', started.entry_occurrence_id, 'sourceResultId', receipt.result_id))
  from op645_configured_start started cross join op645_command_result receipt
  cross join lateral (select public.read_factory_workflow_execution(started.session_id, started.workspace_id,
    started.factory_id) as value) snapshot where started.scenario = 'receipt'),
  'the guarded command records the exact policy evidence and makes its successor runnable');
select ok((select not replay.created and replay.result_id = receipt.result_id
  from op645_configured_start started cross join op645_command_result receipt
  cross join lateral public.record_factory_workflow_command_result(started.session_id, started.workspace_id, started.factory_id,
    started.execution_generation, started.ownership_token, started.entry_occurrence_id, receipt.evidence_ref) replay
  where started.scenario = 'receipt'), 'an identical policy proof replays the exact immutable command result');
select throws_ok($$select public.record_factory_workflow_command_result(started.session_id, started.workspace_id,
  started.factory_id, started.execution_generation, started.ownership_token, started.entry_occurrence_id,
  'policy:' || pg_temp.op645_id(97)) from op645_configured_start started where started.scenario = 'receipt'$$,
  'PT409', 'The workflow node already has a different result.', 'a replay cannot change the recorded policy proof');

update public.agent_jobs job set status = 'running', attempt_count = 1,
  git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
from op645_configured_start fixture where job.id = fixture.job_id;
select is(public.start_session_job_attempt(fixture.job_id, 1, session.current_stage_id, session.current_artifact_version,
    'codex', 'gpt-5.5', 'project', 'wallie/op645-policy-fixture-' || fixture.scenario), fixture.run_id,
  'exhaustion fixture starts the real admitted run for ' || fixture.scenario)
from op645_configured_start fixture join public.sessions session on session.id = fixture.session_id order by fixture.scenario;
update public.agent_runs run set started_at = clock_timestamp() - interval '61 seconds'
from op645_configured_start fixture where run.id = fixture.run_id;
select is(checked.exhaustion_code, 'elapsed_execution', 'policy evaluation reports elapsed execution exhaustion for ' || started.scenario)
from op645_configured_start started cross join lateral public.check_factory_workflow_execution_policy(started.session_id,
  started.workspace_id, started.factory_id, started.execution_generation, started.ownership_token, started.entry_occurrence_id) checked
order by started.scenario;
select is((select count(*) from public.sessions session join op645_configured_start fixture on session.id = fixture.session_id
  where session.execution_exhaustion_code = 'elapsed_execution'), 2::bigint,
  'the existing policy service durably records both exhaustion reasons');
select is((select count(*) from op645_configured_start started cross join op645_policy policy
  cross join lateral public.record_factory_workflow_command_result(started.session_id, started.workspace_id, started.factory_id,
    started.execution_generation, started.ownership_token, started.entry_occurrence_id, 'policy:' || policy.id) denied
  where started.scenario = 'exhausted'), 0::bigint, 'an exhausted root cannot record a command result even with its exact policy reference');
select is((select public.read_factory_workflow_execution(session_id, workspace_id, factory_id)->'runnableTransitions'
  from op645_configured_start where scenario = 'exhausted'), '[]'::jsonb, 'exhaustion does not make the successor runnable');
select ok((select snapshot.value->'runnableTransitions' = '[]'::jsonb
    and snapshot.value->'results' @> jsonb_build_array(jsonb_build_object('result_id', receipt.result_id))
  from op645_configured_start started cross join op645_command_result receipt
  cross join lateral (select public.read_factory_workflow_execution(started.session_id, started.workspace_id,
    started.factory_id) as value) snapshot where started.scenario = 'receipt'),
  'a known exhausted root hides its candidate while retaining the exact result receipt');
select is((select count(*) from op645_configured_start started cross join op645_command_result receipt
  cross join lateral public.admit_factory_workflow_next(started.session_id, started.workspace_id, started.factory_id,
    started.execution_generation, started.ownership_token, started.entry_occurrence_id, 'next.policy.check', receipt.result_id) denied
  where started.scenario = 'receipt'), 0::bigint, 'later exhaustion prevents admission from an already recorded policy success');
select ok((select not replay.created and replay.result_id = receipt.result_id
  from op645_configured_start started cross join op645_command_result receipt
  cross join lateral public.record_factory_workflow_command_result(started.session_id, started.workspace_id, started.factory_id,
    started.execution_generation, started.ownership_token, started.entry_occurrence_id, receipt.evidence_ref) replay
  where started.scenario = 'receipt'), 'later exhaustion preserves the recorded command result for exact replay');

create function pg_temp.op645_validation_session(p_title text, p_revision bigint, p_evidence jsonb)
returns table (session_id uuid, job_id uuid, run_id uuid) language plpgsql as $$
declare policy_id uuid; definition_id uuid := gen_random_uuid();
begin
  select policy.id into strict policy_id from public.save_delivery_policy(pg_temp.op645_id(11), pg_temp.op645_id(31),
    pg_temp.op645_id(1), p_revision, jsonb_build_object('version', 1, 'deliveryMode', 'analysis',
      'requiredChecks', '[]'::jsonb, 'requiredEvidence', p_evidence, 'freshnessSeconds', 600, 'minimumApprovals', 0,
      'requireCodeOwnerReview', false, 'requireResolvedThreads', false, 'requireArtifactApprovalForDelivery', false)) policy;
  with definition as (
    select base.workspace_id, base.factory_id, base.created_by,
      jsonb_set(base.definition_json::jsonb, '{deliveryPolicyRevisionId}', to_jsonb(policy_id), false)::text as body
    from public.factory_definition_revisions base where base.id = pg_temp.op645_id(42)
  ), revision as (
    insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json,
      canonical_digest, created_by)
    select definition_id, workspace_id, factory_id, 1, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), created_by
    from definition returning id, workspace_id, factory_id, created_by
  )
  insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
  select workspace_id, factory_id, id, p_revision + 3, created_by from revision;
  return query select admitted.session_id, admitted.job_id, admitted.run_id from public.create_session_with_first_job(
    pg_temp.op645_id(11), pg_temp.op645_id(21), p_title, 'Validate the admitted output.', 'codex', 'gpt-5.5') admitted;
end;
$$;
create temp table op645_validation_roots as
select 'empty-policy'::text as scenario, admitted.* from pg_temp.op645_validation_session('Empty evidence policy', 0, '[]') admitted;
insert into op645_validation_roots select 'invalid-policy', admitted.*
from pg_temp.op645_validation_session('Unsupported evidence key', 1, '["browser:trace:smoke"]') admitted;
insert into op645_validation_roots select 'pending', admitted.*
from pg_temp.op645_validation_session('Pending publication', 2, '["unit","browser:screenshot:smoke"]') admitted;
insert into op645_validation_roots
select fixture.scenario, admitted.session_id, admitted.job_id, admitted.run_id
from (values ('expired'), ('stale'), ('claimed'), ('adopted')) fixture(scenario)
cross join lateral public.create_session_with_first_job(pg_temp.op645_id(11), pg_temp.op645_id(21),
  fixture.scenario || ' publication', 'Validate the admitted output.', 'codex', 'gpt-5.5') admitted;
create temp table op645_validation_graphs as
select fixture.*, pin.workspace_id, pin.factory_id, registered.graph_revision_id from op645_validation_roots fixture
join public.session_factory_admission_inputs pin using (session_id) cross join op645_graphs graph
cross join lateral public.register_factory_workflow_graph_revision(pin.workspace_id, pin.factory_id, pin.definition_revision_id,
  pin.definition_digest, graph.body, graph.digest) registered where graph.scenario = 'validation';
select throws_ok(format('select public.start_factory_workflow_graph_execution(%L,%L,%L,%L)',
  session_id, workspace_id, factory_id, graph_revision_id), 'PT422',
  'The graph requires a pinned delivery policy with valid required evidence.', 'validation rejects ' || scenario)
from op645_validation_graphs where scenario in ('empty-policy', 'invalid-policy') order by scenario;

create function pg_temp.op645_prepare_publication(p_session_id uuid, p_job_id uuid, p_run_id uuid, p_deadline timestamptz)
returns void language plpgsql as $$
declare owner public.sessions; started uuid; base_sha text := repeat('a', 40);
begin
  select * into strict owner from public.sessions where id = p_session_id;
  update public.agent_jobs set status = 'running', attempt_count = 1,
    git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()) where id = p_job_id;
  started := public.start_session_job_attempt(p_job_id, 1, owner.current_stage_id, owner.current_artifact_version,
    'codex', 'gpt-5.5', 'project', 'wallie/op645-input-' || p_run_id::text);
  if started is distinct from p_run_id then raise exception 'Checkpoint fixture did not start its admitted run'; end if;
  perform public.pin_session_job_git_input(p_job_id, 1, p_run_id, owner.github_repository_id, 'main', base_sha);
  if not public.prepare_session_source_and_checkpoint_publication(p_run_id, owner.github_repository_id, 'main', base_sha,
    base_sha, 'Validation checkpoint', 'Validation evidence fixture', '', '', '', owner.current_artifact_version,
    'Validate the admitted output.', p_deadline) then raise exception 'Checkpoint fixture could not prepare its publication'; end if;
end;
$$;
select pg_temp.op645_prepare_publication(session_id, job_id, run_id, clock_timestamp() +
  case when scenario in ('expired', 'stale') then interval '-1 second' else interval '1 hour' end)
from op645_validation_graphs where scenario not in ('empty-policy', 'invalid-policy');
create temp table op645_publication_claims as
select scenario, run_id, public.claim_session_checkpoint_publication(run_id) as claim_id
from op645_validation_graphs where scenario in ('stale', 'claimed', 'adopted');
select ok((select public.adopt_session_checkpoint_publication(run_id, claim_id, null, null)
  from op645_publication_claims where scenario = 'adopted'), 'the adopted input fixture uses the checkpoint publication protocol');
select is((select publication.status from public.session_checkpoint_publications publication
  join op645_validation_graphs fixture using (run_id) where fixture.scenario = 'stale'), 'stale',
  'the stale fixture retains the intent after its deadline is processed');
select throws_ok(format('select public.start_factory_workflow_graph_execution(%L,%L,%L,%L,%L)',
  session_id, workspace_id, factory_id, graph_revision_id, run_id), 'PT409',
  'The graph input run has no current scoped checkpoint publication intent.', 'enrollment rejects the ' || scenario || ' intent')
from op645_validation_graphs where scenario in ('expired', 'stale') order by scenario;
select ok(started.created and started.ownership_token is not null, 'enrollment accepts the ' || fixture.scenario || ' intent')
from op645_validation_graphs fixture cross join lateral public.start_factory_workflow_graph_execution(fixture.session_id,
  fixture.workspace_id, fixture.factory_id, fixture.graph_revision_id, fixture.run_id) started
where fixture.scenario in ('pending', 'claimed', 'adopted') order by fixture.scenario;

update public.sessions set archived_at = clock_timestamp()
where id = (select root_session_id from op645_started);
select ok((select not replay.created and replay.ownership_token is null
    and replay.entry_occurrence_id = started.entry_occurrence_id
  from op645_started started
  cross join lateral public.start_factory_workflow_graph_execution(started.root_session_id, started.workspace_id,
    started.factory_id, started.graph_revision_id) replay),
  'an archived root can replay its exact graph enrollment without acquiring ownership');

select throws_ok($$delete from internal.factory_workflow_graph_revisions
  where id = (select graph_revision_id from op645_started)$$,
  '23514', 'Factory definition records are immutable.', 'a registered graph revision cannot be deleted directly');
delete from public.workspaces where id = pg_temp.op645_id(11);
select is((select count(*) from internal.factory_workflow_graph_revisions where workspace_id = pg_temp.op645_id(11)),
  0::bigint, 'workspace erasure removes all registered graph revisions');
select is((select count(*) from internal.factory_workflow_executions where workspace_id = pg_temp.op645_id(11)),
  0::bigint, 'workspace erasure removes all enrolled graph executions');
select ok(not exists (select 1 from internal.factory_workflow_node_occurrences occurrence
  where occurrence.root_session_id in (select root_session_id from op645_started
    union all select session_id from op645_limit_root union all select session_id from op645_configured_start)),
  'workspace erasure removes the enrolled graph occurrences');
select * from finish();
rollback;
