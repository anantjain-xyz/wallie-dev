begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '648a0000-0000-4000-8000-000000000001';

create function pg_temp.op648_id(slot integer) returns uuid language sql immutable as $$
  select ('648a0000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
insert into auth.users(id, email) values (pg_temp.op648_id(1), 'op648-grants@example.test');
insert into public.workspaces(id, slug, name) values (pg_temp.op648_id(11), 'op648-grant-proof', 'Delegated grant proof');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.op648_id(21), pg_temp.op648_id(11), pg_temp.op648_id(1), 'human', 'owner');

create temp table op648_scope as
select workspace_id, id as factory_id from public.factories
where workspace_id = pg_temp.op648_id(11) and is_default;
insert into public.factory_agent_prompt_revisions(id, workspace_id, factory_id, agent_id, revision_number,
  prompt_md, prompt_sha256, created_by)
select pg_temp.op648_id(91), workspace_id, factory_id, id, 2,
  'Choose a configured destination.', encode(sha256(convert_to('Choose a configured destination.', 'UTF8')), 'hex'),
  pg_temp.op648_id(21)
from public.factory_agents where workspace_id = pg_temp.op648_id(11) and is_default;
insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
select pg_temp.op648_id(31), workspace_id, factory_id, 'Workflow receipt pipeline', true from op648_scope;
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name)
values (pg_temp.op648_id(32), pg_temp.op648_id(31), pg_temp.op648_id(11), 1, 'inspect-output', 'Inspect output');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.op648_id(33), pg_temp.op648_id(11), 64720033, 'https://github.test/installations/64720033',
  647200, 'Organization', 'Fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name, private, html_url, default_branch)
select pg_temp.op648_id(34), workspace_id, factory_id, pg_temp.op648_id(33), 64720034,
  'workflow-fixture', 'fixture/workflow-fixture', true, 'https://github.test/fixture/workflow-fixture', 'main'
from op648_scope;

-- Root's grant can read A and B. Its pinned definition only exercises A.
-- C is a live same-factory repository outside both inherited scope envelopes.
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
select pg_temp.op648_id(repo.slot), scope.workspace_id, scope.factory_id, pg_temp.op648_id(33),
  64720000 + repo.slot, repo.name, 'fixture/' || repo.name, true, 'https://github.test/fixture/' || repo.name, 'main'
from op648_scope scope
cross join (values (61, 'context-a'), (62, 'context-b'), (63, 'context-c')) repo(slot, name);

create temp table grant_scope as
select principal.*, policy.id as policy_id
from op648_scope scope
cross join lateral public.create_service_principal(
  scope.workspace_id, scope.factory_id, pg_temp.op648_id(1), 'Workflow router', 'workflow-router') principal
cross join lateral public.save_execution_policy(scope.workspace_id, pg_temp.op648_id(1), 0,
  '{"version":1,"maxRepairAttempts":1,"maxExecutionMs":60000,"maxTotalTokens":null,"maxCostUsd":null}') policy;

create temp table approved_grants as
select intent.scenario, intent.revision_slot, intent.activation_number, approved.*
from grant_scope scope
cross join (values
  ('root', 43, 4, array[pg_temp.op648_id(61), pg_temp.op648_id(62)], interval '2 hours'),
  ('narrow', 44, 1, '{}'::uuid[], interval '1 hour'),
  ('outside-parent-definition', 45, 2, array[pg_temp.op648_id(62)], interval '1 hour'),
  ('outside-parent-grant', 46, 3, array[pg_temp.op648_id(63)], interval '1 hour')
) intent(scenario, revision_slot, activation_number, context_repositories, expires_in)
cross join lateral public.approve_factory_execution_grant(
  scope.workspace_id, scope.factory_id, pg_temp.op648_id(1), scope.id, pg_temp.op648_id(34),
  intent.context_repositories, '{}', scope.policy_id, pg_temp.op648_id(21),
  clock_timestamp() + intent.expires_in, 0, null, '{sessions:create}'::public.factory_command_scope[]) approved;
create temp view op648_grant as select * from approved_grants where scenario = 'root';
create temp view scoped_child_grants as select * from approved_grants where scenario <> 'root';

insert into public.workspace_secrets(id, workspace_id, key, encrypted_value)
select pg_temp.op648_id(revision_slot + 30), workspace_id, 'OP647_GRANT_KEY_' || revision_slot, 'fixture-ciphertext'
from approved_grants;
insert into public.workspace_sandbox_settings(workspace_id, active_provider) values (pg_temp.op648_id(11), 'e2b')
on conflict (workspace_id) do update set active_provider = excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id, encrypted_api_key)
values (pg_temp.op648_id(11), 'fixture-sandbox-ciphertext');

create temp table scoped_revisions as
select grant_row.scenario, pg_temp.op648_id(grant_row.revision_slot) as revision_id, grant_row.activation_number,
  grant_row.id as grant_id, grant_row.version as grant_version, binding.id as binding_id,
  grant_row.workspace_id, grant_row.factory_id,
  jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.op648_id(31),
    'repositoryId', grant_row.github_repository_id, 'sandboxProvider', 'e2b',
    'readContextRepositoryIds', to_jsonb(case when grant_row.scenario = 'root' then array[pg_temp.op648_id(61)]
      else grant_row.read_context_repository_ids end),
    'credentialBindingId', binding.id, 'executionGrant', jsonb_build_object('id', grant_row.id, 'version', grant_row.version),
    'implementationAgent', jsonb_build_object('agentId', prompt.agent_id, 'promptRevisionId', prompt.id,
      'promptMd', prompt.prompt_md, 'promptSha256', prompt.prompt_sha256),
    'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5', 'effort', 'high',
      'concurrencyLimit', 1, 'stallTimeoutMs', 900000, 'maxRetries', 3, 'maxTurns', 5),
    'executionPolicyRevisionId', grant_row.execution_policy_revision_id, 'deliveryPolicyRevisionId', null,
    'skillIds', '[]'::jsonb, 'toolIds', '[]'::jsonb, 'operatingRulesMd', '', 'operatingRuleStageIds', '[]'::jsonb,
    'stages', jsonb_build_array(jsonb_build_object('id', pg_temp.op648_id(32), 'slug', 'inspect-output',
      'name', 'Inspect output', 'description', '', 'promptTemplateMd', 'Inspect the admitted output.',
      'anyoneCanApprove', false, 'previousStageIds', '[]'::jsonb, 'approverMemberIds', jsonb_build_array(pg_temp.op648_id(21))))
  )::text as body
from approved_grants grant_row
join public.factory_agent_prompt_revisions prompt on prompt.id = pg_temp.op648_id(91)
cross join lateral public.create_factory_secret_binding(grant_row.workspace_id, grant_row.factory_id, pg_temp.op648_id(1),
  grant_row.id, grant_row.version, prompt.agent_id, 'codex', pg_temp.op648_id(grant_row.revision_slot + 30)) binding;
create temp view scoped_child_revisions as select * from scoped_revisions where scenario <> 'root';

insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by)
select revision_id, workspace_id, factory_id, 1, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), pg_temp.op648_id(21)
from scoped_revisions;
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, revision_id, activation_number, pg_temp.op648_id(21)
from scoped_revisions order by activation_number;
select public.issue_factory_machine_token(workspace_id, factory_id, pg_temp.op648_id(1), id, version,
  pg_temp.op648_id(36), repeat('a', 64), 'Delegated grant fixture', '{sessions:create}') from op648_grant;
create function pg_temp.op648_create_service_root(p_slot integer, p_title text) returns jsonb language plpgsql as $$
declare
  scope record;
  permit record;
  request_id uuid := gen_random_uuid();
  receipt jsonb;
begin
  select workspace_id, factory_id into strict scope from op648_scope;
  select * into strict permit from public.admit_factory_command(scope.workspace_id, scope.factory_id, 'machine_token',
    pg_temp.op648_id(36), repeat('a', 64), 'sessions:create', request_id, repeat('b', 64), 'api');
  if permit.status <> 'admitted' then raise exception 'Service route fixture admission failed: %', permit.status; end if;
  receipt := public.execute_factory_session_mutation(scope.workspace_id, scope.factory_id, 'machine_token',
    pg_temp.op648_id(36), repeat('a', 64), request_id, repeat('b', 64), 'api', permit.admission_id, permit.lease_id,
    'create', pg_temp.op648_id(p_slot), jsonb_build_object('title', p_title, 'prompt', 'Choose a configured route.',
      'agentId', (select agent_id from public.factory_agent_prompt_revisions where id = pg_temp.op648_id(91)),
      'repositoryId', pg_temp.op648_id(34), 'draftSpecification', false));
  perform public.release_factory_command_admission(permit.admission_id, permit.lease_id);
  return receipt;
end;
$$;

create temp table delegated_root as
select fixture.scenario, scope.*, fields.*
from op648_scope scope
cross join (values ('narrow', 101), ('outside-parent-definition', 102), ('outside-parent-grant', 103),
  ('unknown-usage', 104), ('over-budget', 105), ('revoked-authority', 106),
  ('reordered-usage', 108), ('late-cost', 109), ('read-after-route', 110), ('stale-owner', 111),
  ('foreman-only', 112), ('deadline-during-lineage', 113), ('moved-checkpoint', 114),
  ('child-limit', 115))
  fixture(scenario, request_slot)
cross join lateral jsonb_to_record(pg_temp.op648_create_service_root(fixture.request_slot,
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
  artifact_version integer;
begin
  select current_artifact_version into strict artifact_version from public.sessions where id = p_session_id;
  update public.agent_jobs set status = 'running', attempt_count = 1,
    git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
  where id = p_job_id;
  started := public.start_session_job_attempt(p_job_id, 1, pg_temp.op648_id(32), artifact_version,
    'codex', 'gpt-5.5', 'code', 'wallie/op648-smoke-' || p_job_id);
  if started is null then raise exception 'Root attempt failed to start.'; end if;
  perform public.pin_session_job_git_input(p_job_id, 1, started, pg_temp.op648_id(34), 'main', repeat('a', 40));
  if not found or not public.prepare_session_source_and_checkpoint_publication(started, pg_temp.op648_id(34), 'main',
    repeat('a', 40), repeat('a', 40), 'Root source', 'Delegation source proof', '', '', '', artifact_version, 'Private root checkpoint.') then
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

select is((select count(*) from scoped_child_grants child cross join op648_grant root_grant
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
from scoped_child_grants child cross join op648_grant root_grant
join public.factory_definition_revisions parent on parent.id = pg_temp.op648_id(43)
where child.scenario = 'outside-parent-definition';
select ok(not (child.read_context_repository_ids <@ root_grant.read_context_repository_ids),
  'the raw-grant expansion names a live same-factory read repository outside the root grant')
from scoped_child_grants child cross join op648_grant root_grant where child.scenario = 'outside-parent-grant';

create temp table route_graph as
select profile.scenario, jsonb_set(jsonb_build_object(
  'schemaVersion', 1, 'kind', 'graph', 'entryNodeId', 'route.choose',
  'nodes', jsonb_build_array(
    jsonb_build_object('id', 'route.choose', 'kind', 'route', 'agentPromptRevisionId', pg_temp.op648_id(91), 'grantId', approved.id),
    jsonb_build_object('id', 'agent.child', 'kind', 'agent', 'agentPromptRevisionId', pg_temp.op648_id(91), 'grantId', approved.id)
  ),
  'edges', jsonb_build_array(jsonb_build_object('id','route.child','kind','route','from','route.choose','to','agent.child')),
  'grants', jsonb_build_array(jsonb_build_object('id', approved.id, 'version', approved.version)),
  'routePolicy', '{"maxNodeVisits":16,"maxLoopTraversals":0,"nodes":{"route.choose":{"minimumConfidence":0.7,
    "allowedDestinationIds":["agent.child"],"fallback":{"kind":"clarification"}}}}'::jsonb,
  'delegationPolicy', jsonb_build_object('maxChildren', 1, 'maxConcurrentChildren', 1, 'maxAttempts', case when profile.scenario = 'outside-parent-grant' then 1 else 4 end,
    'maxTotalTokens', 1000, 'maxTokensPerAttempt', 50, 'maxCostUsd', 2, 'maxCostUsdPerAttempt', 0.2,
    'targets', jsonb_build_object('agent.child', jsonb_build_object(
      'definitionRevisionId', definition.id, 'definitionDigest', definition.canonical_digest)))
), '{routePolicy,nodes,route.choose,foremanProfile}', jsonb_build_object(
  'definitionRevisionId', foreman.id, 'definitionDigest', foreman.canonical_digest))::text as body
from op648_grant approved
cross join scoped_child_revisions profile
join public.factory_definition_revisions definition on definition.id = profile.revision_id
join public.factory_definition_revisions foreman on foreman.id = pg_temp.op648_id(43);
insert into route_graph(scenario, body)
select extra.scenario, graph.body from route_graph graph
cross join (values ('unknown-usage'), ('over-budget'), ('revoked-authority'), ('reordered-usage'),
  ('late-cost'), ('read-after-route'), ('stale-owner'), ('deadline-during-lineage'), ('moved-checkpoint'), ('child-limit')) extra(scenario)
where graph.scenario = 'narrow';
insert into route_graph(scenario, body)
select 'foreman-only', jsonb_set(jsonb_set(jsonb_set(jsonb_set(
  graph.body::jsonb,
  '{nodes,1}', '{"id":"policy.check","kind":"deterministic","operation":"policy"}'),
  '{edges,0,to}', '"policy.check"'),
  '{routePolicy,nodes,route.choose,allowedDestinationIds}', '["policy.check"]'),
  '{delegationPolicy,targets}', '{}')::text
from route_graph graph where graph.scenario = 'narrow';

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
select is((select count(*) from root_owner where created and ownership_token is not null), 14::bigint,
  'all roots enroll their graph and exact historical target profile');
select ok((select created and ownership_token is not null from root_owner where scenario = 'foreman-only'),
  'a foreman-only route enrolls with a bounded policy and empty child targets');
select is(internal.is_enrollable_factory_workflow_delegation(workspace_id, factory_id,
    jsonb_set(graph.body::jsonb, '{delegationPolicy,maxAttempts}', '1025')), false,
  'a foreman-only route applies the same native bounds to its root policy')
from op648_scope cross join route_graph graph where graph.scenario = 'foreman-only';
update public.sessions session set archived_at = clock_timestamp(), phase_status = 'approved'
from root_owner root where session.id = root."sessionId";

create function pg_temp.begin_foreman(p_scenario text) returns jsonb language sql as $$
  select public.begin_factory_workflow_foreman_inference(
    root."sessionId", root.workspace_id, root.factory_id, root.execution_generation, root.ownership_token, root.entry_occurrence_id)
  from root_owner root where root.scenario = p_scenario
$$;
create function pg_temp.read_foreman(p_scenario text) returns jsonb language sql as $$
  select public.read_factory_workflow_foreman_run(root."sessionId", root.workspace_id, root.factory_id, root.entry_occurrence_id)
  from root_owner root where root.scenario = p_scenario
$$;
update public.agent_runs run set started_at = run.finished_at - interval '45 seconds'
from root_owner root where root.scenario = 'unknown-usage' and run.id = root.checkpoint_run_id;
create temp table baseline_budget as
select root.scenario, budget.*
from root_owner root join internal.factory_workflow_executions execution on execution.root_session_id = root."sessionId"
cross join lateral internal.factory_workflow_attempt_budget(root."sessionId", execution.workflow_json::jsonb->'delegationPolicy') budget;

create temp table foreman_tickets as
select scenario, pg_temp.begin_foreman(scenario) as ticket from root_owner;
select is((select count(*) from foreman_tickets where ticket->>'status' = 'issued'), 13::bigint,
  'fresh scoped routes issue one provider ticket under root accounting');
select ok((select ticket->>'status' = 'issued' and ticket->'allowedDestinationIds' = '["policy.check"]'::jsonb
  from foreman_tickets where scenario = 'foreman-only'),
  'the foreman-only route issues inference for its exact deterministic destination');
select ok((select invocation.deadline_at - invocation.issued_at = interval '15 seconds'
  from root_owner root join internal.factory_workflow_foreman_runs invocation on invocation.root_session_id = root."sessionId"
  where root.scenario = 'unknown-usage'), 'the provider deadline is bounded by the root session’s remaining execution time');
select ok((select ticket->>'status' = 'blocked' and ticket->>'code' = 'budget_exhausted'
  from foreman_tickets where scenario = 'outside-parent-grant'),
  'existing root attempt consumes the only configured attempt before any provider issue');
select ok((select ticket->>'promptRevisionId' = pg_temp.op648_id(91)::text and ticket->>'model' = 'gpt-5.5'
  and ticket->>'encryptedCredential' = 'fixture-ciphertext'
  and ticket->>'sourceCheckpointRunId' = root.checkpoint_run_id::text and ticket ? 'issueId'
  from foreman_tickets join root_owner root using (scenario) where scenario = 'narrow'),
  'first ticket contains exact pinned prompt, scoped credential and accepted parent checkpoint');
select ok((select snapshot->>'status' = 'existing' and snapshot#>>'{run,status}' = 'issued'
  and snapshot#>'{run,usage,inputTokens}' = 'null'::jsonb
  and not (snapshot->'run' ?| array['issueId', 'encryptedCredential', 'ownershipToken'])
  from (select pg_temp.begin_foreman('narrow') as snapshot) repeated),
  'replayed begin exposes existing hold without exposing a second permit');
select ok((select readback->>'foremanRunId' = ticket->>'foremanRunId' and not (readback ?| array['issueId', 'encryptedCredential'])
  from foreman_tickets cross join lateral (select pg_temp.read_foreman(scenario) as readback) run where scenario = 'narrow'),
  'scoped read identifies the run without exposing issuance material');
select ok((select budget.attempts = baseline.attempts + 1 and budget.tokens = baseline.tokens + 50
  and budget.spend_usd = baseline.spend_usd + 0.20 and budget.active_children = baseline.active_children
  from root_owner root join baseline_budget baseline using (scenario)
  join internal.factory_workflow_executions execution on execution.root_session_id = root."sessionId"
  cross join lateral internal.factory_workflow_attempt_budget(root."sessionId", execution.workflow_json::jsonb->'delegationPolicy') budget
  where root.scenario = 'narrow'),
  'a pending inference reserves attempts, tokens and spend in the shared budget apart from child concurrency');

create function pg_temp.settle_foreman(p_scenario text, p_outcome jsonb, p_override_issue uuid default null)
returns jsonb language sql as $$
  select public.settle_factory_workflow_foreman_inference(root."sessionId", root.workspace_id, root.factory_id,
    root.execution_generation, root.ownership_token, root.entry_occurrence_id,
    coalesce(p_override_issue, (ticket->>'issueId')::uuid), p_outcome)
  from root_owner root join foreman_tickets using (scenario) where root.scenario = p_scenario
$$;
create temp table planned as
select raw.plan, jsonb_build_object('status', 'accepted', 'planJson', raw.plan,
  'planDigest', encode(sha256(convert_to(raw.plan, 'UTF8')), 'hex'),
  'usage', '{"inputTokens":12,"outputTokens":3,"costUsd":0.05}'::jsonb,
  'providerReceiptId', 'fixture-response') as outcome
from (values ('{"version":1,"commands":[{"kind":"route","decision":{"kind":"choose","destinationNodeId":"agent.child","confidence":0.9,"reason":"Proceed."}},{"kind":"delegate","targetNodeId":"agent.child","title":"Child","promptMd":"Inspect the checkpoint."}]}'))
  raw(plan);
select throws_ok($$select pg_temp.settle_foreman('narrow', outcome, gen_random_uuid()) from planned$$,
  '42501', 'The exact foreman issue capability is required.', 'a different issue cannot settle the observed occurrence');
select throws_ok($$select pg_temp.settle_foreman('narrow', outcome || '{"planDigest":"bad"}') from planned$$,
  '22023', 'Invalid foreman plan.', 'the native boundary verifies exact plan bytes before accepting intent');
select throws_ok($$select pg_temp.settle_foreman('narrow', outcome || jsonb_build_object(
    'planJson', standalone.plan, 'planDigest', encode(sha256(convert_to(standalone.plan, 'UTF8')), 'hex')))
  from planned
  cross join (values ('{"version":1,"commands":[{"kind":"delegate","targetNodeId":"agent.child","title":"Child","promptMd":"Inspect the checkpoint."}]}')) standalone(plan)$$,
  '22023', 'Invalid foreman plan.', 'the native plan requires a foreman route before delegation');
create temp table exhausted_foreman as
select pg_temp.settle_foreman('over-budget',
  jsonb_set(outcome, '{usage}', '{"inputTokens":51,"outputTokens":null,"costUsd":null}')) as result from planned;
select ok((select result->>'status' = 'blocked' and result->>'code' = 'budget_exhausted'
  and result#>>'{usage,inputTokens}' = '51' and result->'commands' = '[]'::jsonb
  from exhausted_foreman), 'native settlement charges over-budget usage and refuses a purported accepted plan');
select is(pg_temp.settle_foreman('reordered-usage',
  '{"status":"accounting","usage":{"inputTokens":43,"outputTokens":null,"costUsd":null},"providerReceiptId":"fixture-response"}')->>'status',
  'issued', 'partial usage can arrive before the terminal plan');
create temp table reordered_foreman as
select pg_temp.settle_foreman('reordered-usage',
  jsonb_set(outcome, '{usage}', '{"inputTokens":12,"outputTokens":8,"costUsd":null}')) as result from planned;
select ok((select result->>'code' = 'budget_exhausted' and result#>>'{usage,inputTokens}' = '43'
  and result#>>'{usage,outputTokens}' = '8' and result->'commands' = '[]'::jsonb from reordered_foreman),
  'settlement checks the combined measured maxima before persisting any plan');
create temp table settled_foreman as select pg_temp.settle_foreman('narrow', outcome) as result from planned;
select ok((select result->>'status' = 'accepted' and result->>'planJson' = plan
  and result#>>'{commands,0,ordinal}' = '1' and result#>>'{commands,0,command,kind}' = 'route'
  and result#>>'{commands,1,ordinal}' = '2' and result#>>'{commands,1,command,kind}' = 'delegate'
  from settled_foreman cross join planned), 'the current issue persists one immutable plan and its two ordered intents');
select is((select pg_temp.settle_foreman('narrow', outcome) from planned), (select result from settled_foreman),
  'identical settlement replays the same plan and ordered rows');
select ok((select budget.attempts = baseline.attempts + 1 and budget.tokens = baseline.tokens + 15
  and budget.spend_usd = baseline.spend_usd + 0.05
  from root_owner root join baseline_budget baseline using (scenario)
  join internal.factory_workflow_executions execution on execution.root_session_id = root."sessionId"
  cross join lateral internal.factory_workflow_attempt_budget(root."sessionId", execution.workflow_json::jsonb->'delegationPolicy') budget
  where root.scenario = 'narrow'), 'measured usage reconciles the conservative inference hold exactly');

-- Stretch the private lineage check past a still-live issue deadline inside
-- this rollback-only fixture. Assert it ran so an already-expired issue cannot
-- accidentally satisfy the test on a loaded database.
create temp table original_foreman_lineage as select pg_get_functiondef(
  'internal.recheck_factory_workflow_delegation_lineage(uuid,uuid,uuid,uuid)'::regprocedure) as definition;
do $$
declare definition text := (select original.definition from original_foreman_lineage original);
begin
  execute replace(definition, '  return true;', $test$
  if p_root_session_id::text = current_setting('wallie.foreman_deadline_fixture_root', true) then
    perform set_config('wallie.foreman_deadline_fixture_waited', 'yes', true);
    perform pg_sleep_until((select invocation.deadline_at from internal.factory_workflow_foreman_runs invocation
      where invocation.root_session_id = p_root_session_id));
  end if;
  return true;$test$);
end;
$$;
select set_config('wallie.foreman_deadline_fixture_root', root."sessionId"::text, true)
from root_owner root where root.scenario = 'deadline-during-lineage';
create temp table expired_foreman (result jsonb);
do $$
begin
  update internal.factory_workflow_foreman_runs invocation set deadline_at = clock_timestamp() + interval '3 seconds'
  from root_owner root where root.scenario = 'deadline-during-lineage' and root."sessionId" = invocation.root_session_id;
  insert into expired_foreman select pg_temp.settle_foreman('deadline-during-lineage', outcome) from planned;
end;
$$;
select ok((select current_setting('wallie.foreman_deadline_fixture_waited', true) = 'yes'
  and result->>'status' = 'stale' and result->>'code' = 'inference_deadline_elapsed'
  and result#>>'{usage,inputTokens}' = '12' and result->'commands' = '[]'::jsonb and not result ? 'planJson'
  from expired_foreman), 'the deadline is enforced after lineage waits while exact usage is retained');
do $$ begin execute (select definition from original_foreman_lineage); end; $$;

create temp table foreman_handoff as
select owner.* from root_owner root
cross join lateral public.acquire_factory_workflow_ownership(root."sessionId", root.workspace_id, root.factory_id,
  root.execution_generation, gen_random_uuid()) owner
where root.scenario = 'stale-owner';
create temp table stale_foreman as select pg_temp.settle_foreman('stale-owner', outcome) as result from planned;
select ok((select result->>'status' = 'stale' and result->>'code' = 'ownership_lost'
  and result#>>'{usage,inputTokens}' = '12' and result->'commands' = '[]'::jsonb and not result ? 'planJson'
  from stale_foreman), 'an exact old owner settles usage after handoff without appending a domain plan');
update public.sessions session set phase_status = 'rejected' from root_owner root
where root.scenario = 'stale-owner' and session.id = root."sessionId";
create temp table late_foreman as select pg_temp.settle_foreman('stale-owner',
  '{"status":"accounting","usage":{"inputTokens":20,"outputTokens":7,"costUsd":0.09},"providerReceiptId":"fixture-response"}') as result;
select ok((select result->>'status' = 'stale' and result#>>'{usage,inputTokens}' = '20'
  and result#>>'{usage,outputTokens}' = '7' and (result#>>'{usage,costUsd}')::numeric = 0.09
  from late_foreman), 'a later absolute receipt on the same issue can raise debit without changing terminal ownership');
select is((select pg_temp.settle_foreman('stale-owner', outcome) from planned), (select result from late_foreman),
  'reordered receipt cannot reduce measured usage or revive a stale plan');
select is(pg_temp.settle_foreman('unknown-usage',
  '{"status":"blocked","code":"timeout","usage":{"inputTokens":4,"outputTokens":null,"costUsd":null}}')#>>'{status}',
  'blocked', 'provider timeout closes the attempt without a second issue');
select ok((select budget.attempts = baseline.attempts + 1 and budget.tokens = baseline.tokens + 50
  and budget.spend_usd = baseline.spend_usd + 0.20
  from root_owner root join baseline_budget baseline using (scenario)
  join internal.factory_workflow_executions execution on execution.root_session_id = root."sessionId"
  cross join lateral internal.factory_workflow_attempt_budget(root."sessionId", execution.workflow_json::jsonb->'delegationPolicy') budget
  where root.scenario = 'unknown-usage'), 'partial tokens and unknown spend keep the full conservative debit');
select ok(pg_temp.settle_foreman('unknown-usage',
  '{"status":"accounting","usage":{"inputTokens":75,"outputTokens":null,"costUsd":null}}')#>>'{usage,inputTokens}' = '75',
  'late measured input can exceed the reservation while output is unavailable');
select ok((select budget.tokens = baseline.tokens + 75 and budget.spend_usd = baseline.spend_usd + 0.20
  from root_owner root join baseline_budget baseline using (scenario)
  join internal.factory_workflow_executions execution on execution.root_session_id = root."sessionId"
  cross join lateral internal.factory_workflow_attempt_budget(root."sessionId", execution.workflow_json::jsonb->'delegationPolicy') budget
  where root.scenario = 'unknown-usage'), 'the aggregate honors a measured lower bound above the conservative reservation');
select ok(not has_table_privilege('service_role', 'internal.factory_workflow_foreman_runs', 'select')
  and not has_function_privilege('authenticated', 'public.read_factory_workflow_foreman_run(uuid,uuid,uuid,uuid)', 'execute'),
  'foreman rows and invocation identities require the service-only command boundary');

create function pg_temp.dispatch_foreman(p_ordinal integer, p_scenario text default 'narrow') returns jsonb language sql as $$
  select public.dispatch_factory_workflow_foreman_command(root."sessionId", root.workspace_id, root.factory_id,
    root.execution_generation, root.ownership_token, root.entry_occurrence_id, (ticket->>'foremanRunId')::uuid, p_ordinal)
  from root_owner root join foreman_tickets using (scenario) where root.scenario = p_scenario
$$;
select throws_ok($$select pg_temp.dispatch_foreman(2)$$, 'PT409',
  'An earlier foreman command is unresolved.', 'dispatcher refuses a child command before the route receipt');
create temp table dispatched_route as select pg_temp.dispatch_foreman(1) as receipt;
create temp table dispatched_delegate as select pg_temp.dispatch_foreman(2) as receipt;
select ok((select route.receipt->>'status' = 'accepted' and delegate.receipt->>'status' = 'accepted'
  and delegate.receipt->>'targetOccurrenceId' = route.receipt->>'targetOccurrenceId'
  and marker.source_checkpoint_run_id = root.checkpoint_run_id and marker.child_session_id <> root."sessionId"
  from dispatched_route route cross join dispatched_delegate delegate cross join root_owner root
  join internal.factory_workflow_delegations marker on marker.root_session_id = root."sessionId"
  where root.scenario = 'narrow' and marker.child_session_id::text = delegate.receipt->>'childSessionId'),
  'the persisted plan dispatches an exact native route and separately granted child in order');
select is(pg_temp.dispatch_foreman(2), (select receipt from dispatched_delegate),
  'replayed dispatch retains the original child receipt');
select is(pg_temp.settle_foreman('outside-parent-definition', outcome)->>'status', 'accepted',
  'the current owner can settle a plan before the child profile is checked') from planned;
create temp table denied_child_route as select pg_temp.dispatch_foreman(1, 'outside-parent-definition') as receipt;
create temp table denied_child as select pg_temp.dispatch_foreman(2, 'outside-parent-definition') as receipt;
select ok((select route.receipt->>'status' = 'accepted'
  and denied.receipt = '{"ordinal":2,"kind":"delegate","status":"blocked","code":"child_admission_denied"}'::jsonb
  and not exists (select 1 from internal.factory_workflow_delegations marker
    where marker.root_session_id = root."sessionId")
  from denied_child_route route cross join denied_child denied cross join root_owner root
  where root.scenario = 'outside-parent-definition'),
  'the child grant cannot exceed the parent definition and its denied ordinal is recorded');
select is(pg_temp.dispatch_foreman(2, 'outside-parent-definition'), (select receipt from denied_child),
  'a definitively denied command replays the same blocked receipt');
select is(pg_temp.dispatch_foreman(1, 'outside-parent-definition'), (select receipt from denied_child_route),
  'a denied child does not roll back the committed route');
select is(pg_temp.settle_foreman('foreman-only', outcome || jsonb_build_object(
    'planJson', deterministic.plan, 'planDigest', encode(sha256(convert_to(deterministic.plan, 'UTF8')), 'hex')))
    ->>'status', 'accepted', 'the foreman plan can contain a delegate command naming its deterministic route target')
from planned cross join lateral (select replace(plan, 'agent.child', 'policy.check') as plan) deterministic;
create temp table deterministic_route as select pg_temp.dispatch_foreman(1, 'foreman-only') as receipt;
select ok((select receipt->>'status' = 'accepted' and occurrence.node_kind = 'deterministic'
  from deterministic_route join internal.factory_workflow_node_occurrences occurrence
    on occurrence.occurrence_id::text = receipt->>'targetOccurrenceId'),
  'the first ordinal admits the exact deterministic target');
select is(pg_temp.dispatch_foreman(2, 'foreman-only'),
  '{"ordinal":2,"kind":"delegate","status":"blocked","code":"no_authorized_target"}'::jsonb,
  'a deterministic target writes a terminal delegate blocker');
select is(pg_temp.dispatch_foreman(1, 'foreman-only'), (select receipt from deterministic_route),
  'the delegate blocker preserves the deterministic route receipt');

select is(pg_temp.settle_foreman('moved-checkpoint', outcome)->>'status', 'accepted',
  'the plan pins the original exact parent checkpoint') from planned;
create temp table superseded_route as select pg_temp.dispatch_foreman(1, 'moved-checkpoint') as receipt;
update public.sessions session set archived_at = null, phase_status = 'in_progress'
from root_owner root where root.scenario = 'moved-checkpoint' and session.id = root."sessionId";
create temp table next_parent_source as
select root."sessionId", pg_temp.adopt_source_checkpoint(root."sessionId", enqueued.job_id) as checkpoint_run_id
from root_owner root
cross join lateral public.enqueue_session_job_with_run(root."sessionId", root.workspace_id,
  pg_temp.op648_id(32), p_run_type => 'code') enqueued
where root.scenario = 'moved-checkpoint';
update public.sessions session set archived_at = clock_timestamp(), phase_status = 'approved'
from next_parent_source next where session.id = next."sessionId";
select ok((select current.run_id <> original.run_id and current.output_sha = original.output_sha
  from next_parent_source next join root_owner root using ("sessionId")
  join public.session_git_checkpoints current on current.run_id = next.checkpoint_run_id
  join public.session_git_checkpoints original on original.run_id = root.checkpoint_run_id),
  'the accepted parent head advances to a new exact checkpoint at the same Git commit');
create temp table stale_source_child as select pg_temp.dispatch_foreman(2, 'moved-checkpoint') as receipt;
select is((select receipt->>'code' from stale_source_child), 'checkpoint_stale',
  'a superseded parent checkpoint terminates the old delegate command');
select is(pg_temp.dispatch_foreman(2, 'moved-checkpoint'), (select receipt from stale_source_child),
  'the exact stale checkpoint denial is retained across retries');
select is(pg_temp.dispatch_foreman(1, 'moved-checkpoint'), (select receipt from superseded_route),
  'moving the checkpoint preserves the first route receipt');

select is(pg_temp.settle_foreman('child-limit', outcome)->>'status', 'accepted',
  'the first child-limit plan settles') from planned;
create temp table first_capped_route as select pg_temp.dispatch_foreman(1, 'child-limit') as receipt;
create temp table first_capped_child as
select child.* from root_owner root cross join first_capped_route route
cross join lateral public.admit_factory_workflow_delegated_session(root."sessionId", root.workspace_id, root.factory_id,
  root.execution_generation, root.ownership_token, root."sessionId", (route.receipt->>'targetOccurrenceId')::uuid,
  root.checkpoint_run_id, 'Child', 'Inspect the checkpoint.') child
where root.scenario = 'child-limit';
select is(pg_temp.dispatch_foreman(2, 'child-limit')->>'childSessionId',
  (select child_session_id::text from first_capped_child),
  'a matching prior native child admission can be read already at the root child limit');

-- A second occurrence of the same route exercises a fresh admission at the
-- aggregate limit, with its own real route, invocation and ordinal receipts.
with later as (
  insert into internal.factory_workflow_node_occurrences(root_session_id, node_id, node_kind, admitted_generation)
  select root."sessionId", 'route.choose', 'route', root.execution_generation
  from root_owner root where root.scenario = 'child-limit'
  returning root_session_id, occurrence_id
)
update root_owner root set entry_occurrence_id = later.occurrence_id
from later where root."sessionId" = later.root_session_id;
update foreman_tickets set ticket = pg_temp.begin_foreman('child-limit') where scenario = 'child-limit';
select is(pg_temp.settle_foreman('child-limit', outcome)->>'status', 'accepted',
  'a later route can plan without granting another child') from planned;
create temp table second_capped_route as select pg_temp.dispatch_foreman(1, 'child-limit') as receipt;
create temp table second_capped_child as select pg_temp.dispatch_foreman(2, 'child-limit') as receipt;
select ok((select route.receipt->>'status' = 'accepted' and denied.receipt->>'code' = 'child_limit_reached'
  and (select count(*) from internal.factory_workflow_delegations marker where marker.root_session_id = root."sessionId") = 1
  from second_capped_route route cross join second_capped_child denied cross join root_owner root
  where root.scenario = 'child-limit'),
  'the total child limit durably blocks only the new delegate ordinal');
select is(pg_temp.dispatch_foreman(2, 'child-limit'), (select receipt from second_capped_child),
  'a total-child denial replays its terminal receipt');

create temp table read_plans as
select scenario, jsonb_build_object('status', 'accepted', 'planJson', raw.plan,
  'planDigest', encode(sha256(convert_to(raw.plan, 'UTF8')), 'hex'),
  'usage', '{"inputTokens":12,"outputTokens":3,"costUsd":0.05}'::jsonb) as outcome
from (values
  ('read-only', '{"version":1,"commands":[{"kind":"read_child","childRef":"unknown-child"}]}'),
  ('route-and-read', '{"version":1,"commands":[{"kind":"route","decision":{"kind":"choose","destinationNodeId":"agent.child","confidence":0.9,"reason":"Continue."}},{"kind":"read_child","childRef":"unknown-child"}]}')
) raw(scenario, plan);
select throws_ok($$select pg_temp.settle_foreman('read-after-route', outcome) from read_plans
  where scenario = 'read-only'$$, '22023', 'Invalid foreman plan.',
  'a plan that only reads a child cannot consume the route');
select is(pg_temp.settle_foreman('read-after-route', outcome)->>'status', 'accepted',
  'a route-first plan can also inspect an offered child') from read_plans where scenario = 'route-and-read';
create temp table read_first_route as select pg_temp.dispatch_foreman(1, 'read-after-route') as receipt;
select ok((select receipt->>'status' = 'accepted' and receipt->>'targetOccurrenceId' is not null
  from read_first_route), 'the route is committed before child inspection');
select is(pg_temp.dispatch_foreman(2, 'read-after-route')->>'code', 'child_unavailable',
  'a child that was not offered is not disclosed');
select is(pg_temp.dispatch_foreman(1, 'read-after-route'), (select receipt from read_first_route),
  'a blocked child read leaves the committed route available for continuation');
select is(pg_temp.settle_foreman('late-cost', outcome)->>'status', 'accepted',
  'a plan may settle before its final spend receipt') from planned;
create temp table late_cost_route as select pg_temp.dispatch_foreman(1, 'late-cost') as receipt;
select is((select receipt->>'status' from late_cost_route), 'accepted', 'route commits before the late spend receipt');
select is((pg_temp.settle_foreman('late-cost',
  '{"status":"accounting","usage":{"inputTokens":null,"outputTokens":null,"costUsd":0.21},"providerReceiptId":"fixture-response"}')#>>'{usage,costUsd}')::numeric,
  0.21::numeric, 'exact late spend is retained over the original reservation');
select is(pg_temp.dispatch_foreman(1, 'late-cost'), (select receipt from late_cost_route),
  'known late overrun still returns the already committed route receipt');
create temp table late_cost_delegate as select pg_temp.dispatch_foreman(2, 'late-cost') as receipt;
select ok((select receipt->>'status' = 'blocked' and receipt->>'code' = 'budget_exhausted' from late_cost_delegate)
  and not exists (select 1 from root_owner root join internal.factory_workflow_delegations marker
    on marker.root_session_id = root."sessionId" where root.scenario = 'late-cost'),
  'known late overrun blocks fresh child admission and records its terminal receipt');
select is(pg_temp.dispatch_foreman(2, 'late-cost'), (select receipt from late_cost_delegate),
  'replayed budget denial returns the same receipt');

create temp table fenced_inflight_root as
select 'fenced-inflight'::text as scenario, scope.*, admitted.*,
  pg_temp.adopt_source_checkpoint(admitted."sessionId", admitted."jobId") as checkpoint_run_id
from op648_scope scope
cross join lateral jsonb_to_record(pg_temp.op648_create_service_root(107, 'Grant fence during foreman inference'))
  admitted("sessionId" uuid, "jobId" uuid, "runId" uuid);
insert into root_owner
select root.*, registered.graph_revision_id, started.*
from fenced_inflight_root root
join public.session_factory_admission_inputs pin on pin.session_id = root."sessionId"
cross join route_graph graph
cross join lateral public.register_factory_workflow_graph_revision(
  pin.workspace_id, pin.factory_id, pin.definition_revision_id, pin.definition_digest,
  graph.body, encode(sha256(convert_to(graph.body, 'UTF8')), 'hex')) registered
cross join lateral public.start_factory_workflow_graph_execution(root."sessionId", root.workspace_id, root.factory_id,
  registered.graph_revision_id, root.checkpoint_run_id) started
where graph.scenario = 'narrow';
insert into foreman_tickets select scenario, pg_temp.begin_foreman(scenario)
from root_owner where scenario = 'fenced-inflight';

select is(pg_temp.settle_foreman('revoked-authority', outcome)->>'status', 'accepted',
  'the scoped provider result can settle before a grant revocation')
from planned;
select ok(revoked.revoked_at is not null, 'the factory manager revokes the enrolled grant')
from op648_grant approved cross join lateral public.revoke_factory_execution_grant(
  approved.workspace_id, approved.factory_id, pg_temp.op648_id(1), approved.id, approved.version, 'Foreman fixture revocation') revoked;
select throws_ok($$select pg_temp.dispatch_foreman(1, 'revoked-authority')$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'fresh dispatch rechecks the live grant after recording the model plan');
select is(pg_temp.dispatch_foreman(2), (select receipt from dispatched_delegate),
  'previously dispatched child receipts survive the grant revocation');

select throws_ok($$select pg_temp.begin_foreman('outside-parent-grant')$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'a new provider issue is denied after the pinned grant revocation');
select ok(pg_temp.read_foreman('outside-parent-grant') is null,
  'denied fresh issuance leaves no provider hold');
select ok((select result->>'status' = 'stale' and result->>'code' = 'ownership_lost'
  and result->'commands' = '[]'::jsonb and result#>>'{usage,inputTokens}' = '12'
  from planned cross join lateral (select pg_temp.settle_foreman('fenced-inflight', outcome) as result) settled),
  'a revoked grant preserves exact in-flight usage while refusing to accept its plan');
select ok((select replay->>'status' = 'existing' and replay#>>'{run,status}' = 'accepted'
    and not (replay->'run' ?| array['issueId', 'encryptedCredential', 'ownershipToken'])
  from (select pg_temp.begin_foreman('narrow') as replay) resumed),
  'a historic foreman enrollment replays its plan and receipts without another permit');
select ok(has_function_privilege('service_role',
    'public.start_factory_workflow_graph_execution(uuid,uuid,uuid,uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated',
    'public.start_factory_workflow_graph_execution(uuid,uuid,uuid,uuid,uuid)', 'execute')
  and not has_function_privilege('service_role',
    'internal.recheck_factory_workflow_delegation_lineage(uuid,uuid,uuid,uuid)', 'execute')
  and not has_function_privilege('service_role',
    'internal.is_enrollable_factory_workflow_foreman(uuid,uuid,jsonb)', 'execute'),
  'the service enrollment RPC retains its execute grant while both helpers remain private');

select ok((select not replay.created and replay.ownership_token is null
    and (replay.execution_generation, replay.entry_occurrence_id) =
      (root.execution_generation, root.entry_occurrence_id)
  from root_owner root cross join lateral public.start_factory_workflow_graph_execution(root."sessionId",
    root.workspace_id, root.factory_id, root.graph_revision_id, root.checkpoint_run_id) replay
  where root.scenario = 'narrow'), 'an archived approved root replays the exact enrollment without another token');
select throws_ok($$select replay.* from root_owner root
  cross join lateral public.start_factory_workflow_graph_execution(root."sessionId",
    root.workspace_id, root.factory_id, root.graph_revision_id, gen_random_uuid()) replay
  where root.scenario = 'narrow'$$, 'PT409', 'The root session already has a different workflow or input run.',
  'the exact enrollment replay rejects a conflicting input before fresh enrollment');

select * from finish();
rollback;
