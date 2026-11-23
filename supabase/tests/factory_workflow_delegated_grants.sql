begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '647b0000-0000-4000-8000-000000000001';

create function pg_temp.op647_id(slot integer) returns uuid language sql immutable as $$
  select ('647b0000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
insert into auth.users(id, email) values (pg_temp.op647_id(1), 'op647-grants@example.test');
insert into public.workspaces(id, slug, name) values (pg_temp.op647_id(11), 'op647-grant-proof', 'Delegated grant proof');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.op647_id(21), pg_temp.op647_id(11), pg_temp.op647_id(1), 'human', 'owner');

create temp table op647_scope as
select workspace_id, id as factory_id from public.factories
where workspace_id = pg_temp.op647_id(11) and is_default;
insert into public.factory_agent_prompt_revisions(id, workspace_id, factory_id, agent_id, revision_number,
  prompt_md, prompt_sha256, created_by)
select pg_temp.op647_id(91), workspace_id, factory_id, id, 2,
  'Choose a configured destination.', encode(sha256(convert_to('Choose a configured destination.', 'UTF8')), 'hex'),
  pg_temp.op647_id(21)
from public.factory_agents where workspace_id = pg_temp.op647_id(11) and is_default;
insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
select pg_temp.op647_id(31), workspace_id, factory_id, 'Workflow receipt pipeline', true from op647_scope;
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name)
values (pg_temp.op647_id(32), pg_temp.op647_id(31), pg_temp.op647_id(11), 1, 'inspect-output', 'Inspect output');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.op647_id(33), pg_temp.op647_id(11), 64720033, 'https://github.test/installations/64720033',
  647200, 'Organization', 'Fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name, private, html_url, default_branch)
select pg_temp.op647_id(34), workspace_id, factory_id, pg_temp.op647_id(33), 64720034,
  'workflow-fixture', 'fixture/workflow-fixture', true, 'https://github.test/fixture/workflow-fixture', 'main'
from op647_scope;

-- Root's grant can read A and B. Its pinned definition only exercises A.
-- C is a live same-factory repository outside both inherited scope envelopes.
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
select pg_temp.op647_id(repo.slot), scope.workspace_id, scope.factory_id, pg_temp.op647_id(33),
  64720000 + repo.slot, repo.name, 'fixture/' || repo.name, true, 'https://github.test/fixture/' || repo.name, 'main'
from op647_scope scope
cross join (values (61, 'context-a'), (62, 'context-b'), (63, 'context-c')) repo(slot, name);

create temp table grant_scope as
select principal.*, policy.id as policy_id
from op647_scope scope
cross join lateral public.create_service_principal(
  scope.workspace_id, scope.factory_id, pg_temp.op647_id(1), 'Workflow router', 'workflow-router') principal
cross join lateral public.save_execution_policy(scope.workspace_id, pg_temp.op647_id(1), 0,
  '{"version":1,"maxRepairAttempts":1,"maxExecutionMs":60000,"maxTotalTokens":null,"maxCostUsd":null}') policy;

create temp table approved_grants as
select intent.scenario, intent.revision_slot, intent.activation_number, approved.*
from grant_scope scope
cross join (values
  ('root', 43, 5, array[pg_temp.op647_id(61), pg_temp.op647_id(62)], interval '2 hours'),
  ('narrow', 44, 1, '{}'::uuid[], interval '1 hour'),
  ('outside-parent-definition', 45, 2, array[pg_temp.op647_id(62)], interval '1 hour'),
  ('outside-parent-grant', 46, 3, array[pg_temp.op647_id(63)], interval '1 hour'),
  ('nested', 47, 4, '{}'::uuid[], interval '45 minutes')
) intent(scenario, revision_slot, activation_number, context_repositories, expires_in)
cross join lateral public.approve_factory_execution_grant(
  scope.workspace_id, scope.factory_id, pg_temp.op647_id(1), scope.id, pg_temp.op647_id(34),
  intent.context_repositories, '{}', scope.policy_id, pg_temp.op647_id(21),
  clock_timestamp() + intent.expires_in, 0, null, '{sessions:create}'::public.factory_command_scope[]) approved;
create temp view op647_grant as select * from approved_grants where scenario = 'root';
create temp view scoped_child_grants as select * from approved_grants where scenario not in ('root', 'nested');

insert into public.workspace_secrets(id, workspace_id, key, encrypted_value)
select pg_temp.op647_id(revision_slot + 30), workspace_id, 'OP647_GRANT_KEY_' || revision_slot, 'fixture-ciphertext'
from approved_grants;
insert into public.workspace_sandbox_settings(workspace_id, active_provider) values (pg_temp.op647_id(11), 'e2b')
on conflict (workspace_id) do update set active_provider = excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id, encrypted_api_key)
values (pg_temp.op647_id(11), 'fixture-sandbox-ciphertext');

create temp table scoped_revisions as
select grant_row.scenario, pg_temp.op647_id(grant_row.revision_slot) as revision_id, grant_row.activation_number,
  grant_row.id as grant_id, grant_row.version as grant_version, binding.id as binding_id,
  grant_row.workspace_id, grant_row.factory_id,
  jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.op647_id(31),
    'repositoryId', grant_row.github_repository_id, 'sandboxProvider', 'e2b',
    'readContextRepositoryIds', to_jsonb(case when grant_row.scenario = 'root' then array[pg_temp.op647_id(61)]
      else grant_row.read_context_repository_ids end),
    'credentialBindingId', binding.id, 'executionGrant', jsonb_build_object('id', grant_row.id, 'version', grant_row.version),
    'implementationAgent', jsonb_build_object('agentId', prompt.agent_id, 'promptRevisionId', prompt.id,
      'promptMd', prompt.prompt_md, 'promptSha256', prompt.prompt_sha256),
    'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5', 'effort', 'high',
      'concurrencyLimit', 1, 'stallTimeoutMs', 900000, 'maxRetries', 3, 'maxTurns', 5),
    'executionPolicyRevisionId', grant_row.execution_policy_revision_id, 'deliveryPolicyRevisionId', null,
    'skillIds', '[]'::jsonb, 'toolIds', '[]'::jsonb, 'operatingRulesMd', '', 'operatingRuleStageIds', '[]'::jsonb,
    'stages', jsonb_build_array(jsonb_build_object('id', pg_temp.op647_id(32), 'slug', 'inspect-output',
      'name', 'Inspect output', 'description', '', 'promptTemplateMd', 'Inspect the admitted output.',
      'anyoneCanApprove', false, 'previousStageIds', '[]'::jsonb, 'approverMemberIds', jsonb_build_array(pg_temp.op647_id(21))))
  )::text as body
from approved_grants grant_row
join public.factory_agent_prompt_revisions prompt on prompt.id = pg_temp.op647_id(91)
cross join lateral public.create_factory_secret_binding(grant_row.workspace_id, grant_row.factory_id, pg_temp.op647_id(1),
  grant_row.id, grant_row.version, prompt.agent_id, 'codex', pg_temp.op647_id(grant_row.revision_slot + 30)) binding;
create temp view scoped_child_revisions as select * from scoped_revisions where scenario not in ('root', 'nested');

insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by)
select revision_id, workspace_id, factory_id, 1, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), pg_temp.op647_id(21)
from scoped_revisions;
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, revision_id, activation_number, pg_temp.op647_id(21)
from scoped_revisions order by activation_number;
select public.issue_factory_machine_token(workspace_id, factory_id, pg_temp.op647_id(1), id, version,
  pg_temp.op647_id(36), repeat('a', 64), 'Delegated grant fixture', '{sessions:create}') from op647_grant;
create function pg_temp.op647_create_service_root(p_slot integer, p_title text) returns jsonb language plpgsql as $$
declare
  scope record;
  permit record;
  request_id uuid := gen_random_uuid();
  receipt jsonb;
begin
  select workspace_id, factory_id into strict scope from op647_scope;
  select * into strict permit from public.admit_factory_command(scope.workspace_id, scope.factory_id, 'machine_token',
    pg_temp.op647_id(36), repeat('a', 64), 'sessions:create', request_id, repeat('b', 64), 'api');
  if permit.status <> 'admitted' then raise exception 'Service route fixture admission failed: %', permit.status; end if;
  receipt := public.execute_factory_session_mutation(scope.workspace_id, scope.factory_id, 'machine_token',
    pg_temp.op647_id(36), repeat('a', 64), request_id, repeat('b', 64), 'api', permit.admission_id, permit.lease_id,
    'create', pg_temp.op647_id(p_slot), jsonb_build_object('title', p_title, 'prompt', 'Choose a configured route.',
      'agentId', (select agent_id from public.factory_agent_prompt_revisions where id = pg_temp.op647_id(91)),
      'repositoryId', pg_temp.op647_id(34), 'draftSpecification', false));
  perform public.release_factory_command_admission(permit.admission_id, permit.lease_id);
  return receipt;
end;
$$;

create temp table delegated_root as
select fixture.scenario, scope.*, fields.*
from op647_scope scope
cross join (values ('narrow', 101), ('outside-parent-definition', 102), ('outside-parent-grant', 103))
  fixture(scenario, request_slot)
cross join lateral jsonb_to_record(pg_temp.op647_create_service_root(fixture.request_slot,
  'Grant narrowing root ' || fixture.scenario)) fields(
  "sessionId" uuid, "jobId" uuid, "runId" uuid
);
select public.set_git_continuity_release(true, revision, 'Delegated grant narrowing fixture')
from public.get_git_continuity_release_state() where not enabled;

create function pg_temp.adopt_source_checkpoint(p_session_id uuid, p_job_id uuid)
returns uuid language plpgsql as $$
declare
  started uuid;
  lease uuid;
begin
  update public.agent_jobs set status = 'running', attempt_count = 1,
    git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
  where id = p_job_id and status = 'queued';
  started := public.start_session_job_attempt(p_job_id, 1, pg_temp.op647_id(32), 0,
    'codex', 'gpt-5.5', 'code', 'wallie/op647-smoke-' || p_job_id);
  if started is null then raise exception 'Root attempt failed to start.'; end if;
  perform public.pin_session_job_git_input(p_job_id, 1, started, pg_temp.op647_id(34), 'main', repeat('a', 40));
  if not found or not public.prepare_session_source_and_checkpoint_publication(started, pg_temp.op647_id(34), 'main',
    repeat('a', 40), repeat('a', 40), 'Root source', 'Delegation source proof', '', '', '', 0, 'Private root checkpoint.') then
    raise exception 'Root checkpoint preparation failed.';
  end if;
  lease := public.claim_session_checkpoint_publication(started);
  if lease is null or not public.adopt_session_checkpoint_publication(started, lease, null, null) then
    raise exception 'Root checkpoint adoption failed.';
  end if;
  if not exists (select 1 from public.session_git_heads h where (h.session_id, h.checkpoint_run_id) = (p_session_id, started)) then
    raise exception 'Root checkpoint did not become the accepted head.';
  end if;
  return started;
end;
$$;
create temp table root_checkpoint as
select root.*, pg_temp.adopt_source_checkpoint("sessionId", "jobId") as checkpoint_run_id from delegated_root root;

select is((select count(*) from scoped_child_grants child cross join op647_grant root_grant
  where child.id <> root_grant.id and
    (child.service_principal_id, child.github_repository_id, child.budget_payer_member_id, child.execution_policy_revision_id) =
    (root_grant.service_principal_id, root_grant.github_repository_id, root_grant.budget_payer_member_id, root_grant.execution_policy_revision_id)),
  3::bigint, 'all child profiles have separately approved grants under the same inherited authority');
select ok(resolved.id = profile.grant_id and resolved.version = profile.grant_version and binding.id = profile.binding_id,
  'the child profile independently resolves its live grant and credential: ' || profile.scenario)
from scoped_child_revisions profile
join scoped_child_grants child using (scenario)
cross join lateral internal.resolve_definition_execution_grant(profile.workspace_id, profile.factory_id, profile.body::jsonb,
  child.github_repository_id, child.execution_policy_revision_id) resolved
cross join lateral internal.lock_definition_credential_binding(profile.workspace_id, profile.factory_id, profile.body::jsonb,
  resolved.id, resolved.service_principal_id) binding;

select ok(child.read_context_repository_ids <@ root_grant.read_context_repository_ids and
  not (to_jsonb(child.read_context_repository_ids) <@ (parent.definition_json::jsonb->'readContextRepositoryIds')),
  'the effective-scope expansion is allowed by the raw root grant and excluded from its frozen definition')
from scoped_child_grants child cross join op647_grant root_grant
join public.factory_definition_revisions parent on parent.id = pg_temp.op647_id(43)
where child.scenario = 'outside-parent-definition';
select ok(not (child.read_context_repository_ids <@ root_grant.read_context_repository_ids),
  'the raw-grant expansion names a live same-factory read repository outside the root grant')
from scoped_child_grants child cross join op647_grant root_grant where child.scenario = 'outside-parent-grant';

create temp table route_graph as
select profile.scenario, jsonb_build_object(
  'schemaVersion', 1, 'kind', 'graph', 'entryNodeId', 'route.choose',
  'nodes', jsonb_build_array(
    jsonb_build_object('id', 'route.choose', 'kind', 'route', 'agentPromptRevisionId', pg_temp.op647_id(91), 'grantId', approved.id),
    jsonb_build_object('id', 'agent.child', 'kind', 'agent', 'agentPromptRevisionId', pg_temp.op647_id(91), 'grantId', approved.id),
    jsonb_build_object('id', 'route.nested', 'kind', 'route', 'agentPromptRevisionId', pg_temp.op647_id(91), 'grantId', approved.id),
    jsonb_build_object('id', 'agent.nested', 'kind', 'agent', 'agentPromptRevisionId', pg_temp.op647_id(91), 'grantId', approved.id)
  ),
  'edges', '[
    {"id":"route.child","kind":"route","from":"route.choose","to":"agent.child"},
    {"id":"child.continue","kind":"next","from":"agent.child","to":"route.nested"},
    {"id":"route.grandchild","kind":"route","from":"route.nested","to":"agent.nested"}
  ]'::jsonb,
  'grants', jsonb_build_array(jsonb_build_object('id', approved.id, 'version', approved.version)),
  'routePolicy', '{"maxNodeVisits":16,"maxLoopTraversals":0,"nodes":{
    "route.choose":{"minimumConfidence":0.7,"allowedDestinationIds":["agent.child"],"fallback":{"kind":"clarification"}},
    "route.nested":{"minimumConfidence":0.7,"allowedDestinationIds":["agent.nested"],"fallback":{"kind":"clarification"}}
  }}'::jsonb,
  'delegationPolicy', jsonb_build_object('maxChildren', 2, 'maxConcurrentChildren', 2, 'maxAttempts', 4,
    'maxTotalTokens', 1000, 'maxTokensPerAttempt', 50, 'maxCostUsd', 2, 'maxCostUsdPerAttempt', 0.2,
    'targets', jsonb_build_object(
      'agent.child', jsonb_build_object('definitionRevisionId', definition.id, 'definitionDigest', definition.canonical_digest),
      'agent.nested', jsonb_build_object('definitionRevisionId', nested.id, 'definitionDigest', nested.canonical_digest)))
)::text as body
from op647_grant approved
cross join scoped_child_revisions profile
join public.factory_definition_revisions definition on definition.id = profile.revision_id
join public.factory_definition_revisions nested on nested.id = pg_temp.op647_id(47);

create temp table root_owner as
select root.*, registered.graph_revision_id, started.*
from root_checkpoint root
join public.session_factory_admission_inputs pin on pin.session_id = root."sessionId"
join route_graph graph on graph.scenario = root.scenario
cross join lateral public.register_factory_workflow_graph_revision(
  pin.workspace_id, pin.factory_id, pin.definition_revision_id, pin.definition_digest,
  graph.body, encode(sha256(convert_to(graph.body, 'UTF8')), 'hex')) registered
cross join lateral public.start_factory_workflow_graph_execution(root."sessionId", root.workspace_id, root.factory_id,
  registered.graph_revision_id, root.checkpoint_run_id) started;
select is((select count(*) from root_owner where created and ownership_token is not null), 3::bigint,
  'all three roots enroll their graph and exact historical target profile');
update public.sessions session set archived_at = clock_timestamp(), phase_status = 'approved'
from root_owner root where session.id = root."sessionId";

create temp table selected_child as
select root.scenario, routed.* from root_owner root
cross join lateral public.admit_factory_workflow_route_decision(root."sessionId", root.workspace_id, root.factory_id,
  root.execution_generation, root.ownership_token, root.entry_occurrence_id,
  'Exact delegated profile selected.', 'agent.child', 0.9) routed;
select is((select count(*) from selected_child where created and resolution = 'selected' and target_occurrence_id is not null),
  3::bigint, 'the root route envelope admits the exact occurrence in each graph');

create function pg_temp.admit_scoped_child(p_scenario text)
returns table(child_session_id uuid, job_id uuid, run_id uuid, created boolean) language sql as $$
  select admitted.* from root_owner root join selected_child selected using (scenario)
  cross join lateral public.admit_factory_workflow_delegated_session(
    root."sessionId", root.workspace_id, root.factory_id, root.execution_generation, root.ownership_token,
    root."sessionId", selected.target_occurrence_id, root.checkpoint_run_id,
    'Grant narrowing child', 'Handle the exact accepted parent checkpoint.') admitted
  where root.scenario = p_scenario
$$;
create temp table admitted_child as select * from pg_temp.admit_scoped_child('narrow');
select ok((select admitted.created and
  (pin.definition_revision_id, pin.execution_grant_id, pin.execution_grant_version) =
  (profile.revision_id, profile.grant_id, profile.grant_version)
  and internal.pinned_session_execution_definition(child_session)->>'credentialBindingId' = profile.binding_id::text
  and pin.execution_grant_id <> parent_pin.execution_grant_id
  and cardinality(granted.read_context_repository_ids) = 0
  and input.source_checkpoint_run_id = root.checkpoint_run_id
  from admitted_child admitted
  join public.sessions child_session on child_session.id = admitted.child_session_id
  join public.session_factory_admission_inputs pin on pin.session_id = admitted.child_session_id
  join scoped_child_revisions profile on profile.revision_id = pin.definition_revision_id
  join scoped_child_grants granted on granted.id = pin.execution_grant_id
  join public.session_job_git_inputs input on input.job_id = admitted.job_id
  join root_owner root on root.scenario = profile.scenario
  join public.session_factory_admission_inputs parent_pin on parent_pin.session_id = root."sessionId"),
  'admission persists the narrower child grant and bound credential with the exact parent checkpoint');
select ok((select not replay.created and (replay.child_session_id, replay.job_id, replay.run_id) =
  (first.child_session_id, first.job_id, first.run_id)
  from pg_temp.admit_scoped_child('narrow') replay cross join admitted_child first),
  'narrower admission replay returns the same child, job and run');
select throws_ok($$select pg_temp.admit_scoped_child('outside-parent-definition')$$,
  '42501', 'The frozen child profile exceeds inherited execution authority.',
  'a live child grant cannot add context outside the accepted parent definition');
select throws_ok($$select pg_temp.admit_scoped_child('outside-parent-grant')$$,
  '42501', 'The frozen child profile exceeds inherited execution authority.',
  'a live child grant cannot add context outside the approved ancestor grant');
select is((select count(*) from internal.factory_workflow_delegations receipt
  join root_owner root on root."sessionId" = receipt.root_session_id), 1::bigint,
  'rejected expansion and duplicate admission persist no extra child receipts');
select is((select count(*) from internal.factory_workflow_attempt_reservations reservation
  join root_owner root on root."sessionId" = reservation.root_session_id), 1::bigint,
  'rejected expansion and duplicate admission reserve no extra child attempts');

update public.agent_jobs job set created_at = '1900-01-01T00:00:00Z', scheduled_at = null
from admitted_child child where job.id = child.job_id;
select is((select job.id from public.claim_next_agent_job(false, 1, 'node') job where job.attempt_count = 1),
  (select job_id from admitted_child), 'the intermediate child can claim with its live grant');
create temp table parent_checkpoint as
select child.child_session_id, pg_temp.adopt_source_checkpoint(child.child_session_id, child.job_id) as checkpoint_run_id
from admitted_child child;

-- The child has a genuine definition pin and an adopted exact scoped checkpoint.
create temp table child_graph as
select child.child_session_id, child.checkpoint_run_id, pin.workspace_id, pin.factory_id, recorded.graph_revision_id
from parent_checkpoint child
join public.session_factory_admission_inputs pin on pin.session_id = child.child_session_id
join route_graph graph on graph.scenario = 'narrow'
cross join lateral (
  select (graph.body::jsonb || jsonb_build_object(
    'grants', jsonb_build_array(jsonb_build_object('id', pin.execution_grant_id, 'version', pin.execution_grant_version)),
    'nodes', jsonb_agg(node || jsonb_build_object('grantId', pin.execution_grant_id) order by position)))::text as body
  from jsonb_array_elements(graph.body::jsonb->'nodes') with ordinality nodes(node, position)
) compiled
cross join lateral public.register_factory_workflow_graph_revision(pin.workspace_id, pin.factory_id,
  pin.definition_revision_id, pin.definition_digest, compiled.body,
  encode(sha256(convert_to(compiled.body, 'UTF8')), 'hex')) recorded;
select throws_ok($$select * from child_graph graph cross join lateral public.start_factory_workflow_graph_execution(
  graph.child_session_id, graph.workspace_id, graph.factory_id, graph.graph_revision_id, graph.checkpoint_run_id)$$,
  'PT409', 'A delegated child cannot start an independent workflow graph.',
  'a delegated child cannot create a separate root with its own attempt budget');
select ok((select public.read_factory_workflow_execution(child_session_id, workspace_id, factory_id) is null
  from child_graph), 'the declined enrollment creates no independent execution');

select is((select approved.id from public.approve_session_stage(owner.id, owner.workspace_id, owner.current_stage_id,
    owner.current_artifact_id, owner.current_artifact_version,
    pg_temp.op647_id(21), 'codex', 'gpt-5.5', 'code', owner.artifact_review_revision) approved),
  child.child_session_id, 'the reviewer accepts the intermediate checkpoint')
from parent_checkpoint child join public.sessions owner on owner.id = child.child_session_id;
create temp table nested_child as
select nested.*, root."sessionId" as root_session_id, parent.child_session_id as parent_session_id
from root_owner root join selected_child selected using (scenario) cross join parent_checkpoint parent
cross join lateral public.record_factory_workflow_delegated_result(root."sessionId", root.workspace_id,
  root.factory_id, root.execution_generation, root.ownership_token, selected.target_occurrence_id) result
cross join lateral public.admit_factory_workflow_next(root."sessionId", root.workspace_id, root.factory_id,
  root.execution_generation, root.ownership_token, selected.target_occurrence_id, 'child.continue', result.result_id) successor
cross join lateral public.admit_factory_workflow_route_decision(root."sessionId", root.workspace_id, root.factory_id,
  root.execution_generation, root.ownership_token, successor.target_occurrence_id,
  'Delegate the remaining work under the approved child checkpoint.', 'agent.nested', 0.9) routed
cross join lateral public.admit_factory_workflow_delegated_session(root."sessionId", root.workspace_id, root.factory_id,
  root.execution_generation, root.ownership_token, parent.child_session_id, routed.target_occurrence_id,
  parent.checkpoint_run_id, 'Nested child', 'Use the approved intermediate checkpoint.') nested
where root.scenario = 'narrow';
select ok((select child.created and marker.parent_session_id = child.parent_session_id
    and child_pin.execution_grant_id = nested.id and child_pin.execution_grant_id <> parent_pin.execution_grant_id
  from nested_child child
  join internal.factory_workflow_delegations marker on marker.child_session_id = child.child_session_id
  join public.session_factory_admission_inputs parent_pin on parent_pin.session_id = child.parent_session_id
  join public.session_factory_admission_inputs child_pin on child_pin.session_id = child.child_session_id
  join approved_grants nested on nested.scenario = 'nested'),
  'the nested child has the exact intermediate parent and an independently approved scoped grant');

update public.agent_jobs job set created_at = '1900-01-01T00:00:00Z', scheduled_at = null
from nested_child child where job.id = child.job_id;
select is((select job.id from public.claim_next_agent_job(false, 1, 'node') job where job.attempt_count = 1),
  (select job_id from nested_child), 'the worker claims the nested child while all three grants are live');
select ok((public.revoke_factory_execution_grant(workspace_id, factory_id, pg_temp.op647_id(1), id, version,
  'Withdraw the intermediate execution grant')).revoked_at is not null,
  'the manager revokes only the intermediate parent grant') from approved_grants where scenario = 'narrow';

select throws_ok($$select public.start_session_job_attempt(child.job_id, 1, pg_temp.op647_id(32), 0,
  'codex', 'gpt-5.5', 'code', 'wallie/op647-nested-' || child.job_id) from nested_child child$$,
  '42501', null, 'an exact claimed grandchild cannot start after its intermediate parent grant is revoked');
select ok((select run.started_at is null and reservation.run_id is null
  from nested_child child join public.agent_runs run on run.id = child.run_id
  join internal.factory_workflow_attempt_reservations reservation
    on (reservation.root_session_id, reservation.job_id, reservation.attempt_count) =
      (child.root_session_id, child.job_id, 1)), 'the blocked grandchild consumes no started root-budget attempt');
select * from finish();
rollback;
