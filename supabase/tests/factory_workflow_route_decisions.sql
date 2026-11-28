begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '64600000-0000-4000-8000-000000000001';

create function pg_temp.op646_id(slot integer) returns uuid language sql immutable as $$
  select ('64600000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
insert into auth.users(id, email) values
  (pg_temp.op646_id(1), 'op646-owner@example.test'),
  (pg_temp.op646_id(2), 'op646-foreign-owner@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.op646_id(11), 'op646-workflow-fixture', 'Workflow route fixture'),
  (pg_temp.op646_id(12), 'op646-foreign-fixture', 'Unrelated workflow fixture');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.op646_id(21), pg_temp.op646_id(11), pg_temp.op646_id(1), 'human', 'owner'),
  (pg_temp.op646_id(22), pg_temp.op646_id(12), pg_temp.op646_id(2), 'human', 'owner');
insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential)
values (pg_temp.op646_id(1), 'platform_api_key', 'fixture-ciphertext');

create temp table op646_scope as
select workspace_id, id as factory_id from public.factories
where workspace_id = pg_temp.op646_id(11) and is_default;
insert into public.factory_agent_prompt_revisions(id, workspace_id, factory_id, agent_id, revision_number,
  prompt_md, prompt_sha256, created_by)
select pg_temp.op646_id(91), workspace_id, factory_id, id, 2,
  'Choose a configured destination.', encode(sha256(convert_to('Choose a configured destination.', 'UTF8')), 'hex'),
  pg_temp.op646_id(21)
from public.factory_agents where workspace_id = pg_temp.op646_id(11) and is_default;
insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
select pg_temp.op646_id(31), workspace_id, factory_id, 'Workflow receipt pipeline', true from op646_scope;
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name)
values (pg_temp.op646_id(32), pg_temp.op646_id(31), pg_temp.op646_id(11), 1, 'inspect-output', 'Inspect output');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.op646_id(33), pg_temp.op646_id(11), 64600033, 'https://github.test/installations/64600033',
  646000, 'Organization', 'Fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name, private, html_url, default_branch)
select pg_temp.op646_id(34), workspace_id, factory_id, pg_temp.op646_id(33), 64600034,
  'workflow-fixture', 'fixture/workflow-fixture', true, 'https://github.test/fixture/workflow-fixture', 'main'
from op646_scope;

with definition as (
  select workspace_id, factory_id, jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.op646_id(31),
    'repositoryId', pg_temp.op646_id(34), 'sandboxProvider', 'e2b',
    'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5', 'effort', 'high',
      'concurrencyLimit', 1, 'stallTimeoutMs', 900000, 'maxRetries', 3, 'maxTurns', 5),
    'executionPolicyRevisionId', null, 'deliveryPolicyRevisionId', null,
    'skillIds', '[]'::jsonb, 'toolIds', '[]'::jsonb, 'operatingRulesMd', '', 'operatingRuleStageIds', '[]'::jsonb,
    'stages', jsonb_build_array(jsonb_build_object('id', pg_temp.op646_id(32), 'slug', 'inspect-output',
      'name', 'Inspect output', 'description', '', 'promptTemplateMd', 'Inspect the admitted output.',
      'anyoneCanApprove', false, 'previousStageIds', '[]'::jsonb,
      'approverMemberIds', jsonb_build_array(pg_temp.op646_id(21))))
  )::text as body from op646_scope
), revision as (
  insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version,
    definition_json, canonical_digest, created_by)
  select pg_temp.op646_id(41), workspace_id, factory_id, 1, body,
    encode(sha256(convert_to(body, 'UTF8')), 'hex'), pg_temp.op646_id(21)
  from definition returning id, workspace_id, factory_id, created_by
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 1, created_by from revision;

create temp table op646_admitted as
select * from public.create_session_with_first_job(
  pg_temp.op646_id(11), pg_temp.op646_id(21), 'Workflow route fixture', 'Inspect the admitted output.',
  'codex', 'gpt-5.5');

create temp table op646_policy as select * from public.save_execution_policy(pg_temp.op646_id(11), pg_temp.op646_id(1), 0,
  '{"version":1,"maxRepairAttempts":1,"maxExecutionMs":60000,"maxTotalTokens":null,"maxCostUsd":null}');
with definition as (
  select base.workspace_id, base.factory_id, base.created_by,
    jsonb_set(base.definition_json::jsonb, '{executionPolicyRevisionId}', to_jsonb(policy.id), false)::text as body
  from public.factory_definition_revisions base cross join op646_policy policy where base.id = pg_temp.op646_id(41)
), revision as (
  insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json,
    canonical_digest, created_by)
  select pg_temp.op646_id(42), workspace_id, factory_id, 1, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), created_by
  from definition returning id, workspace_id, factory_id, created_by
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 2, created_by from revision;
select public.set_git_continuity_release(true, revision, 'Workflow route fixture')
from public.get_git_continuity_release_state() where not enabled;
create temp table op646_graphs as
with source(name, plan) as (values
  ('forward', '{"kind":"graph","schemaVersion":1,"entryNodeId":"route.choose","nodes":[
    {"id":"route.choose","kind":"route","agentPromptRevisionId":"64600000-0000-4000-8000-000000000091"},
    {"id":"policy.finish","kind":"deterministic","operation":"policy"},
    {"id":"policy.fallback","kind":"deterministic","operation":"policy"},
    {"id":"policy.denied","kind":"deterministic","operation":"policy"}],"edges":[
    {"id":"route.finish","kind":"route","from":"route.choose","to":"policy.finish"},
    {"id":"route.fallback","kind":"route","from":"route.choose","to":"policy.fallback"},
    {"id":"route.denied","kind":"route","from":"route.choose","to":"policy.denied"}],"grants":[],"routePolicy":{
    "maxNodeVisits":16,"maxLoopTraversals":0,"nodes":{"route.choose":{"minimumConfidence":0.7,
    "allowedDestinationIds":["policy.finish"],"fallback":{"kind":"route","destinationId":"policy.fallback"}}}}}'::jsonb),
  ('loop', '{"kind":"graph","schemaVersion":1,"entryNodeId":"policy.prepare","nodes":[
    {"id":"policy.prepare","kind":"deterministic","operation":"policy"},
    {"id":"route.choose","kind":"route","agentPromptRevisionId":"64600000-0000-4000-8000-000000000091"},
    {"id":"policy.finish","kind":"deterministic","operation":"policy"}],"edges":[
    {"id":"next.prepare","kind":"next","from":"policy.prepare","to":"route.choose"},
    {"id":"route.finish","kind":"route","from":"route.choose","to":"policy.finish"},
    {"id":"loop.self","kind":"loop","from":"route.choose","to":"route.choose","maxTraversals":3},
    {"id":"loop.prepare","kind":"loop","from":"route.choose","to":"policy.prepare","maxTraversals":3}],"grants":[],"routePolicy":{
    "maxNodeVisits":16,"maxLoopTraversals":3,"nodes":{"route.choose":{"minimumConfidence":0.7,
    "allowedDestinationIds":["policy.finish","route.choose","policy.prepare"],"fallback":{"kind":"clarification"}}}}}'::jsonb),
  ('grant-expansion', '{"kind":"graph","schemaVersion":1,"entryNodeId":"route.choose","nodes":[
    {"id":"route.choose","kind":"route","agentPromptRevisionId":"64600000-0000-4000-8000-000000000091"},
    {"id":"route.privileged","kind":"route","agentPromptRevisionId":"64600000-0000-4000-8000-000000000091",
      "grantId":"64600000-0000-4000-8000-000000000092"},
    {"id":"policy.finish","kind":"deterministic","operation":"policy"}],"edges":[
    {"id":"route.privileged","kind":"route","from":"route.choose","to":"route.privileged"},
    {"id":"route.finish","kind":"route","from":"route.privileged","to":"policy.finish"}],"grants":[
    {"id":"64600000-0000-4000-8000-000000000092","version":1}],"routePolicy":{
    "maxNodeVisits":16,"maxLoopTraversals":0,"nodes":{
    "route.choose":{"minimumConfidence":0.7,"allowedDestinationIds":["route.privileged"],"fallback":{"kind":"clarification"}},
    "route.privileged":{"minimumConfidence":0.7,"allowedDestinationIds":["policy.finish"],"fallback":{"kind":"clarification"}}}}}'::jsonb)
), compiled as (
  select scenario, (case scenario
    when 'clarification' then jsonb_set(jsonb_set(jsonb_set(plan, '{routePolicy,nodes,route.choose,fallback}', '{"kind":"clarification"}'),
      '{routePolicy,nodes,route.choose,allowedDestinationIds}', '[]'), '{routePolicy,maxNodeVisits}', '1')
    when 'entry-forward-cap' then jsonb_set(plan, '{routePolicy,maxNodeVisits}', '1')
    when 'per-edge' then jsonb_set(plan, '{edges,2,maxTraversals}', '1')
    when 'global-loop' then jsonb_set(plan, '{routePolicy,maxLoopTraversals}', '1')
    when 'visit-cap' then jsonb_set(plan, '{routePolicy,maxNodeVisits}', '3')
    else plan end)::text as body
  from (values ('choice', 'forward'), ('fallback', 'forward'), ('clarification', 'forward'), ('entry-forward-cap', 'forward'),
    ('missing-budget', 'forward'),
    ('approved-root', 'forward'), ('archived-root', 'forward'),
    ('exhausted', 'forward'), ('per-edge', 'loop'), ('global-loop', 'loop'), ('visit-cap', 'loop'),
    ('grant-expansion', 'grant-expansion')) fixture(scenario, name) join source using (name)
)
select scenario, body, encode(sha256(convert_to(body, 'UTF8')), 'hex') as digest from compiled;

create temp table op646_sessions as
select 'missing-budget'::text as scenario, admitted.* from op646_admitted admitted
union all
select graph.scenario, admitted.* from op646_graphs graph
cross join lateral public.create_session_with_first_job(pg_temp.op646_id(11), pg_temp.op646_id(21),
  'Workflow route fixture ' || graph.scenario, 'Choose a configured route.', 'codex', 'gpt-5.5') admitted
where graph.scenario <> 'missing-budget';
create temp table op646_registered as
select fixture.scenario, fixture.session_id, fixture.job_id, fixture.run_id, pin.workspace_id, pin.factory_id,
  pin.execution_policy_revision_id, registered.graph_revision_id
from op646_sessions fixture join public.session_factory_admission_inputs pin using (session_id)
join op646_graphs graph using (scenario)
cross join lateral public.register_factory_workflow_graph_revision(pin.workspace_id, pin.factory_id, pin.definition_revision_id,
  pin.definition_digest, graph.body, graph.digest) registered;
create temp table op646_foreign_prompt_graph as
select pin.session_id, pin.workspace_id, pin.factory_id, registered.graph_revision_id
from op646_sessions fixture
join public.session_factory_admission_inputs pin using (session_id)
join op646_graphs graph using (scenario)
cross join lateral (select jsonb_set(graph.body::jsonb, '{nodes,0,agentPromptRevisionId}', to_jsonb(prompt.id))::text body
  from public.factory_agent_prompt_revisions prompt
  where prompt.workspace_id = pg_temp.op646_id(12) and prompt.revision_number = 1) foreign_plan
cross join lateral public.register_factory_workflow_graph_revision(pin.workspace_id, pin.factory_id, pin.definition_revision_id,
  pin.definition_digest, foreign_plan.body, encode(sha256(convert_to(foreign_plan.body, 'UTF8')), 'hex')) registered
where fixture.scenario = 'choice';
select throws_ok($$select public.start_factory_workflow_graph_execution(session_id, workspace_id, factory_id, graph_revision_id)
  from op646_foreign_prompt_graph$$, 'PT422', 'The graph requires scoped route prompt revisions.',
  'the raw enrollment RPC refuses a real route prompt revision from another workspace');
create temp table op646_invalid_policy_graphs as
select field.name, pin.session_id, pin.workspace_id, pin.factory_id, registered.graph_revision_id
from op646_sessions fixture
join public.session_factory_admission_inputs pin using (session_id)
join op646_graphs graph using (scenario)
cross join (values ('policy', array['routePolicy','extra']),
  ('rule', array['routePolicy','nodes','route.choose','extra'])) field(name, path)
cross join lateral (select jsonb_set(graph.body::jsonb, field.path, 'true')::text body) invalid
cross join lateral public.register_factory_workflow_graph_revision(pin.workspace_id, pin.factory_id, pin.definition_revision_id,
  pin.definition_digest, invalid.body, encode(sha256(convert_to(invalid.body, 'UTF8')), 'hex')) registered
where fixture.scenario = 'choice';
select throws_ok(format('select public.start_factory_workflow_graph_execution(session_id, workspace_id, factory_id,
  graph_revision_id) from op646_invalid_policy_graphs where name = %L', name),
  'PT422', 'The graph must match a bounded workflow route policy.',
  'raw graph enrollment rejects an extra ' || name || ' field')
from op646_invalid_policy_graphs;
create temp table op646_started as
select fixture.*, started.* from op646_registered fixture
cross join lateral public.start_factory_workflow_graph_execution(fixture.session_id, fixture.workspace_id,
  fixture.factory_id, fixture.graph_revision_id) started;
select is((select count(*) from op646_started where created and ownership_token is not null), 12::bigint,
  'each scenario starts from a real pinned graph root');

-- Complete the deterministic predecessor through its guarded policy API.
create function pg_temp.op646_next_from_policy(
  p_root uuid, p_workspace uuid, p_factory uuid, p_generation bigint, p_token uuid, p_occurrence uuid, p_policy uuid
) returns uuid language plpgsql as $$
declare
  result_id uuid;
  target_id uuid;
begin
  select receipt.result_id into strict result_id from public.record_factory_workflow_command_result(
    p_root, p_workspace, p_factory, p_generation, p_token, p_occurrence, 'policy:' || p_policy) receipt;
  select admitted.target_occurrence_id into strict target_id from public.admit_factory_workflow_next(
    p_root, p_workspace, p_factory, p_generation, p_token, p_occurrence, 'next.prepare', result_id) admitted;
  return target_id;
end;
$$;
create temp table op646_route_owners as
select started.*, case when scenario in ('per-edge', 'global-loop', 'visit-cap') then pg_temp.op646_next_from_policy(
    session_id, workspace_id, factory_id, execution_generation, ownership_token, entry_occurrence_id, execution_policy_revision_id)
  else entry_occurrence_id end as route_occurrence_id
from op646_started started;

create function pg_temp.op646_propose(p_scenario text, p_destination text, p_reason text, p_confidence numeric)
returns table(decision_id uuid, resolution text, transition_id uuid, target_occurrence_id uuid, created boolean)
language sql as $$
  select admitted.* from op646_route_owners owner cross join lateral public.admit_factory_workflow_route_decision(
    owner.session_id, owner.workspace_id, owner.factory_id, owner.execution_generation, owner.ownership_token,
    owner.route_occurrence_id, p_reason, p_destination, p_confidence) admitted where owner.scenario = p_scenario;
$$;
create function pg_temp.op646_read_decision(p_scenario text) returns jsonb language sql as $$
  select public.read_factory_workflow_route_decision(session_id, workspace_id, factory_id, route_occurrence_id)
  from op646_route_owners where scenario = p_scenario;
$$;
create function pg_temp.op646_conflict_diagnostic(p_statement text) returns text[] language plpgsql as $$
declare exception_detail text;
begin
  execute p_statement;
  return null;
exception when sqlstate 'PT409' then
  get stacked diagnostics exception_detail = pg_exception_detail;
  return array[sqlstate, sqlerrm, exception_detail];
end;
$$;

select is(public.read_factory_workflow_execution(session_id, workspace_id, factory_id)#>'{execution,graph_visit_limit_exhausted}',
  to_jsonb(scenario <> 'choice'), 'the route snapshot reflects whether the entry exhausts its visit limit: ' || scenario)
from op646_route_owners where scenario in ('choice', 'entry-forward-cap', 'clarification');

create temp table op646_choice_handoff as
select acquired.* from op646_route_owners owner cross join lateral public.acquire_factory_workflow_ownership(
  owner.session_id, owner.workspace_id, owner.factory_id, owner.execution_generation,
  gen_random_uuid()) acquired where owner.scenario = 'choice';
select throws_ok($$select pg_temp.op646_propose('choice', 'policy.finish', 'Old generation', 0.9)$$,
  'PT409', 'Workflow generation is stale.', 'an old generation cannot submit a route decision');
select throws_ok($$select public.admit_factory_workflow_route_decision(owner.session_id, owner.workspace_id, owner.factory_id,
  handoff.execution_generation, owner.ownership_token, owner.route_occurrence_id, 'Old token', 'policy.finish', 0.9)
  from op646_route_owners owner cross join op646_choice_handoff handoff where owner.scenario = 'choice'$$,
  'PT409', 'Workflow ownership token is stale.', 'the old owner cannot guess the next generation');
update op646_route_owners owner set (execution_generation, ownership_token) = (handoff.execution_generation, handoff.ownership_token)
from op646_choice_handoff handoff where owner.scenario = 'choice';
select throws_ok($$select pg_temp.op646_propose('choice', 'policy.unknown', 'Unknown destination', 0.9)$$,
  'PT422', 'The proposed destination is not allowed by the workflow route policy.', 'an unknown destination is rejected');
select throws_ok($$select pg_temp.op646_propose('choice', 'policy.denied', 'Unlisted destination', 0.9)$$,
  'PT422', 'The proposed destination is not allowed by the workflow route policy.', 'a real edge outside the allowlist is rejected');
select throws_ok($$select pg_temp.op646_propose('grant-expansion', 'route.privileged', 'Broader authority', 0.9)$$,
  '42501', 'The workflow route cannot expand the root session execution grant.', 'the route cannot add a grant absent from the root pin');
select throws_ok($$select pg_temp.op646_propose('grant-expansion', 'route.privileged', 'Broader authority below threshold', 0.1)$$,
  '42501', 'The workflow route cannot expand the root session execution grant.', 'low confidence cannot launder a broader grant through clarification');
select throws_ok($$select public.record_factory_workflow_node_result(session_id, workspace_id, factory_id, execution_generation,
  ownership_token, route_occurrence_id, 'succeeded', 'agent:forged') from op646_route_owners where scenario = 'choice'$$,
  '42501', 'This workflow node requires a guarded route decision.', 'the generic result API cannot complete a route node');
select is(pg_temp.op646_read_decision('choice'), null::jsonb, 'rejected proposals write no route receipt');

update public.sessions session set archived_at = clock_timestamp(),
  phase_status = case owner.scenario when 'approved-root' then 'approved'::public.pipeline_phase_status else session.phase_status end
from op646_route_owners owner where session.id = owner.session_id and owner.scenario in ('approved-root', 'archived-root');
select ok((select created and resolution = 'selected'
  from pg_temp.op646_propose('approved-root', 'policy.finish', 'Approved root can progress', 0.9)),
  'a route following final human approval can use the enrolled graph');
select throws_ok($$select pg_temp.op646_propose('archived-root', 'policy.finish', 'Stopped root cannot progress', 0.9)$$,
  'PT409', 'The workflow root session cannot admit a new route.', 'an archived unfinished root cannot admit a route');

create temp table op646_choice as select * from pg_temp.op646_propose('choice', 'policy.finish', 'Ready to finish', 0.9);
select ok((select admitted.created and admitted.resolution = 'selected' and admitted.decision_id is not null
  and admitted.transition_id is not null and admitted.target_occurrence_id is not null
  and pg_temp.op646_read_decision('choice')->>'decision_id' = admitted.decision_id::text
  and pg_temp.op646_read_decision('choice')->>'transition_id' = admitted.transition_id::text
  and pg_temp.op646_read_decision('choice')->>'target_occurrence_id' = admitted.target_occurrence_id::text
  and pg_temp.op646_read_decision('choice')->>'selected_edge_id' = 'route.finish'
  and pg_temp.op646_read_decision('choice')->>'selected_destination_id' = 'policy.finish'
  and pg_temp.op646_read_decision('choice')->>'recorded_generation' = '2'
  from op646_choice admitted), 'the current owner records and admits the exact approved route');
select ok((select not replay.created and (replay.decision_id, replay.transition_id, replay.target_occurrence_id) =
  (admitted.decision_id, admitted.transition_id, admitted.target_occurrence_id)
  from op646_choice admitted cross join pg_temp.op646_propose('choice', 'policy.finish', 'Ready to finish', 0.9) replay),
  'an exact replay returns the original decision and successor');
create temp table op646_choice_next_owner as
select acquired.* from op646_route_owners owner cross join lateral public.acquire_factory_workflow_ownership(
  owner.session_id, owner.workspace_id, owner.factory_id, owner.execution_generation,
  gen_random_uuid()) acquired where owner.scenario = 'choice';
update op646_route_owners owner set (execution_generation, ownership_token) = (handoff.execution_generation, handoff.ownership_token)
from op646_choice_next_owner handoff where owner.scenario = 'choice';
select ok((select not replay.created and (replay.decision_id, replay.transition_id, replay.target_occurrence_id) =
  (admitted.decision_id, admitted.transition_id, admitted.target_occurrence_id)
  from op646_choice admitted cross join pg_temp.op646_propose('choice', 'policy.finish', 'Ready to finish', 0.9) replay),
  'the next owner can replay the exact durable route without consuming capacity again');
select throws_ok($$select pg_temp.op646_propose('choice', 'policy.finish', 'Changed reason', 0.9)$$,
  'PT409', 'The route occurrence already has a different decision.', 'conflicting replay cannot replace the immutable proposal');
select is((select count(*) from internal.factory_workflow_transition_receipts transition join op646_route_owners owner
  on (transition.root_session_id, transition.source_occurrence_id) = (owner.session_id, owner.route_occurrence_id)
  where owner.scenario = 'choice'), 1::bigint, 'replayed and conflicting decisions create only one transition');

create temp table op646_fallback as select * from pg_temp.op646_propose('fallback', 'policy.finish', 'Insufficient confidence', 0.3);
select ok((select admitted.created and admitted.resolution = 'fallback' and admitted.transition_id is not null
  and pg_temp.op646_read_decision('fallback')->>'proposed_destination_id' = 'policy.finish'
  and pg_temp.op646_read_decision('fallback')->>'selected_edge_id' = 'route.fallback'
  and pg_temp.op646_read_decision('fallback')->>'selected_destination_id' = 'policy.fallback'
  from op646_fallback admitted), 'low confidence admits only the configured forward fallback');
create temp table op646_clarification as select admitted.* from op646_route_owners owner
cross join lateral public.admit_factory_workflow_route_decision(owner.session_id, owner.workspace_id, owner.factory_id,
  owner.execution_generation, owner.ownership_token, owner.route_occurrence_id, 'Scope needs clarification') admitted
where owner.scenario = 'clarification';
select ok((select admitted.created and admitted.resolution = 'clarification' and admitted.transition_id is null
  and admitted.target_occurrence_id is null and pg_temp.op646_read_decision('clarification')->>'decision_id' = admitted.decision_id::text
  and pg_temp.op646_read_decision('clarification')->'selected_edge_id' = 'null'::jsonb from op646_clarification admitted),
  'an unresolved choice records clarification without a successor');
select ok((select not replay.created and replay.decision_id = admitted.decision_id and replay.target_occurrence_id is null
  from op646_clarification admitted cross join pg_temp.op646_propose('clarification', null, 'Scope needs clarification', null) replay),
  'clarification replay preserves the durable decision without creating work');
select is((select count(*) from internal.factory_workflow_node_occurrences occurrence join op646_route_owners owner
  on occurrence.root_session_id = owner.session_id where owner.scenario = 'clarification'), 1::bigint,
  'clarification records a decision at the visit limit without a new occurrence');
select is(pg_temp.op646_conflict_diagnostic(format($$select pg_temp.op646_propose(
    'entry-forward-cap', 'policy.finish', 'Try the capped route.', %L::numeric)$$, confidence)),
  array['PT409', 'The workflow visit limit is exhausted.', 'workflow_visit_limit_exhausted'],
  'the route entry already exhausts visits for the ' || selected_edge)
from (values (0.9, 'forward edge'), (0.3, 'fallback edge')) fixture(confidence, selected_edge);
select is(pg_temp.op646_read_decision('entry-forward-cap'), null::jsonb, 'edge capacity rejection leaves no route receipt');

create temp table op646_loop_first as
select owner.scenario, owner.route_occurrence_id as source_occurrence_id, admitted.*
from op646_route_owners owner cross join lateral pg_temp.op646_propose(owner.scenario,
  case when owner.scenario = 'visit-cap' then 'policy.prepare' else 'route.choose' end, 'One bounded retry', 0.9) admitted
where owner.scenario in ('per-edge', 'global-loop', 'visit-cap');
select is((select count(*) from op646_loop_first where created and resolution = 'selected'
  and source_occurrence_id <> target_occurrence_id), 3::bigint, 'the first loop admits a fresh occurrence for each bounded root');
update op646_route_owners owner set route_occurrence_id = admitted.target_occurrence_id
from op646_loop_first admitted where owner.scenario = admitted.scenario and owner.scenario in ('per-edge', 'global-loop');
select throws_ok($$select pg_temp.op646_propose('per-edge', 'route.choose', 'Repeat the capped edge', 0.9)$$,
  'PT409', 'The workflow loop limit is exhausted.', 'the per-edge limit spans successive occurrences');
select throws_ok($$select pg_temp.op646_propose('per-edge', 'route.choose', 'Low-confidence retry', 0.1)$$,
  'PT409', 'The workflow loop limit is exhausted.', 'a capped loop cannot be laundered through low-confidence escalation');
select throws_ok($$select pg_temp.op646_propose('global-loop', 'policy.prepare', 'Try a different loop', 0.9)$$,
  'PT409', 'The workflow loop limit is exhausted.', 'the root-wide loop limit covers a different loop edge');
select is((select count(*) from internal.factory_workflow_route_decisions decision join op646_route_owners owner
  on decision.root_session_id = owner.session_id where owner.scenario in ('per-edge', 'global-loop')), 2::bigint,
  'a loop exhausted by either limit writes no second decision');
create temp table op646_visit_cap_result as
select owner.*, admitted.target_occurrence_id as capped_occurrence_id, receipt.result_id
from op646_route_owners owner join op646_loop_first admitted using (scenario)
cross join lateral public.record_factory_workflow_command_result(owner.session_id, owner.workspace_id, owner.factory_id,
  owner.execution_generation, owner.ownership_token, admitted.target_occurrence_id, 'policy:' || owner.execution_policy_revision_id) receipt
where owner.scenario = 'visit-cap';
select is(pg_temp.op646_conflict_diagnostic($$select public.admit_factory_workflow_next(session_id, workspace_id, factory_id,
  execution_generation, ownership_token, capped_occurrence_id, 'next.prepare', result_id) from op646_visit_cap_result$$),
  array['PT409', 'The workflow visit limit is exhausted.', 'workflow_visit_limit_exhausted'],
  'a subsequent next edge respects the root-wide visit cap');
select ok(snapshot->'results' @> jsonb_build_array(jsonb_build_object('result_id', fixture.result_id, 'outcome', 'succeeded'))
  and snapshot->'runnableTransitions' = '[]'::jsonb
  and snapshot#>'{execution,graph_visit_limit_exhausted}' = 'true'::jsonb,
  'the separately recorded result survives refused admission and the exhausted next edge is absent')
from op646_visit_cap_result fixture cross join lateral (
  select public.read_factory_workflow_execution(fixture.session_id, fixture.workspace_id, fixture.factory_id) as snapshot
) execution;
select ok((select not replay.created and (replay.decision_id, replay.transition_id, replay.target_occurrence_id) =
  (admitted.decision_id, admitted.transition_id, admitted.target_occurrence_id)
  from op646_loop_first admitted
  cross join pg_temp.op646_propose('visit-cap', 'policy.prepare', 'One bounded retry', 0.9) replay
  where admitted.scenario = 'visit-cap'), 'the exhausted root still replays its retained route receipt');

select is((select count(*) from pg_temp.op646_propose('missing-budget', 'policy.finish', 'Budget is required', 0.9)),
  0::bigint, 'a root without a pinned budget admits no decision');
select is(pg_temp.op646_read_decision('missing-budget'), null::jsonb, 'missing budget leaves no route receipt');
select is(public.read_factory_workflow_execution(session_id, workspace_id, factory_id)#>>'{execution,graph_route_blocker}',
  'execution_policy_required', 'the ledger identifies missing budget before requesting another proposal')
from op646_route_owners where scenario = 'missing-budget';
update public.agent_jobs job set status = 'running', attempt_count = 1,
  git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
from op646_route_owners owner where owner.scenario = 'exhausted' and job.id = owner.job_id;
select is(public.start_session_job_attempt(owner.job_id, 1, session.current_stage_id, session.current_artifact_version,
    'codex', 'gpt-5.5', 'project', 'wallie/op646-budget-fixture'), owner.run_id, 'the budget fixture starts its admitted run')
from op646_route_owners owner join public.sessions session on session.id = owner.session_id where owner.scenario = 'exhausted';
update public.agent_runs run set started_at = clock_timestamp() - interval '61 seconds'
from op646_route_owners owner where owner.scenario = 'exhausted' and run.id = owner.run_id;
select is((select count(*) from pg_temp.op646_propose('exhausted', 'policy.finish', 'Budget is exhausted', 0.9)),
  0::bigint, 'a newly exhausted budget admits no route decision');
select is(pg_temp.op646_read_decision('exhausted'), null::jsonb, 'exhaustion leaves no route receipt');
select is((select session.execution_exhaustion_code from public.sessions session join op646_route_owners owner
  on session.id = owner.session_id where owner.scenario = 'exhausted'), 'elapsed_execution',
  'the existing budget service durably records exhaustion');
select is(public.read_factory_workflow_execution(session_id, workspace_id, factory_id)#>>'{execution,graph_route_blocker}',
  'execution_budget_exhausted', 'the ledger identifies a known exhausted budget before requesting another proposal')
from op646_route_owners where scenario = 'exhausted';

create temp table op646_principal as
select principal.* from op646_scope scope cross join lateral public.create_service_principal(
  scope.workspace_id, scope.factory_id, pg_temp.op646_id(1), 'Workflow router', 'workflow-router') principal;
create temp table op646_grant as
select approved.* from op646_principal principal cross join op646_policy policy
cross join lateral public.approve_factory_execution_grant(
  principal.workspace_id, principal.factory_id, pg_temp.op646_id(1), principal.id, pg_temp.op646_id(34),
  '{}', '{}', policy.id, pg_temp.op646_id(21), clock_timestamp() + interval '1 hour', 0, null,
  '{sessions:create}'::public.factory_command_scope[]) approved;
insert into public.workspace_secrets(id, workspace_id, key, encrypted_value)
values (pg_temp.op646_id(35), pg_temp.op646_id(11), 'OP646_AGENT_KEY', 'fixture-service-ciphertext');
insert into public.workspace_sandbox_settings(workspace_id, active_provider)
values (pg_temp.op646_id(11), 'e2b')
on conflict (workspace_id) do update set active_provider = excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id, encrypted_api_key)
values (pg_temp.op646_id(11), 'fixture-sandbox-ciphertext');
create temp table op646_binding as
select binding.* from op646_grant approved
join public.factory_agent_prompt_revisions prompt
  on (prompt.workspace_id, prompt.factory_id, prompt.id) = (approved.workspace_id, approved.factory_id, pg_temp.op646_id(91))
cross join lateral public.create_factory_secret_binding(approved.workspace_id, approved.factory_id, pg_temp.op646_id(1),
  approved.id, approved.version, prompt.agent_id, 'codex', pg_temp.op646_id(35)) binding;

with definition as (
  select base.workspace_id, base.factory_id, base.created_by,
    (base.definition_json::jsonb || jsonb_build_object(
      'credentialBindingId', binding.id, 'executionGrant', jsonb_build_object('id', approved.id, 'version', approved.version),
      'implementationAgent', jsonb_build_object('agentId', prompt.agent_id, 'promptRevisionId', prompt.id,
        'promptMd', prompt.prompt_md, 'promptSha256', prompt.prompt_sha256)))::text as body
  from public.factory_definition_revisions base
  cross join op646_grant approved cross join op646_binding binding
  join public.factory_agent_prompt_revisions prompt on prompt.id = pg_temp.op646_id(91)
  where base.id = pg_temp.op646_id(42)
), revision as (
  insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json,
    canonical_digest, created_by)
  select pg_temp.op646_id(43), workspace_id, factory_id, 1, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), created_by
  from definition returning id, workspace_id, factory_id, created_by
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 3, created_by from revision;

select public.issue_factory_machine_token(workspace_id, factory_id, pg_temp.op646_id(1), id, version,
  pg_temp.op646_id(36), repeat('a', 64), 'Workflow route fixture', '{sessions:create}') from op646_grant;
create function pg_temp.op646_create_service_root(p_slot integer, p_title text) returns jsonb language plpgsql as $$
declare
  scope record;
  permit record;
  request_id uuid := gen_random_uuid();
  receipt jsonb;
begin
  select workspace_id, factory_id into strict scope from op646_scope;
  select * into strict permit from public.admit_factory_command(scope.workspace_id, scope.factory_id, 'machine_token',
    pg_temp.op646_id(36), repeat('a', 64), 'sessions:create', request_id, repeat('b', 64), 'api');
  if permit.status <> 'admitted' then raise exception 'Service route fixture admission failed: %', permit.status; end if;
  receipt := public.execute_factory_session_mutation(scope.workspace_id, scope.factory_id, 'machine_token',
    pg_temp.op646_id(36), repeat('a', 64), request_id, repeat('b', 64), 'api', permit.admission_id, permit.lease_id,
    'create', pg_temp.op646_id(p_slot), jsonb_build_object('title', p_title, 'prompt', 'Choose a configured route.',
      'agentId', (select agent_id from public.factory_agent_prompt_revisions where id = pg_temp.op646_id(91)),
      'repositoryId', pg_temp.op646_id(34), 'draftSpecification', false));
  perform public.release_factory_command_admission(permit.admission_id, permit.lease_id);
  return receipt;
end;
$$;

create temp table op646_service_sessions as
select fixture.scenario, pg_temp.op646_create_service_root(fixture.slot, fixture.scenario) as receipt
from (values (101, 'service-selected'), (102, 'service-revoked')) fixture(slot, scenario);
select is((select count(*) from op646_service_sessions fixture
  join public.session_factory_admission_inputs pin on pin.session_id = (fixture.receipt->>'sessionId')::uuid
  join op646_grant approved on (approved.workspace_id, approved.factory_id, approved.id, approved.version,
    approved.service_principal_id, approved.budget_payer_member_id) =
    (pin.workspace_id, pin.factory_id, pin.execution_grant_id, pin.execution_grant_version,
      pin.invoking_actor_service_principal_id, pin.budget_payer_member_id)), 2::bigint,
  'both service-backed roots pin the exact approved grant, principal, and budget payer');

insert into op646_route_owners(scenario, session_id, job_id, run_id, workspace_id, factory_id, execution_policy_revision_id,
  graph_revision_id, execution_generation, entry_occurrence_id, created, ownership_token, route_occurrence_id)
select fixture.scenario, pin.session_id, (fixture.receipt->>'jobId')::uuid, (fixture.receipt->>'runId')::uuid,
  pin.workspace_id, pin.factory_id, pin.execution_policy_revision_id, registered.graph_revision_id,
  started.execution_generation, started.entry_occurrence_id, started.created, started.ownership_token, started.entry_occurrence_id
from op646_service_sessions fixture
join public.session_factory_admission_inputs pin on pin.session_id = (fixture.receipt->>'sessionId')::uuid
cross join op646_grant approved
cross join lateral (
  select jsonb_set(jsonb_set(jsonb_set(graph.body::jsonb,
    '{nodes,0,grantId}', to_jsonb(approved.id)), '{nodes,1,grantId}', to_jsonb(approved.id)),
    '{grants}', jsonb_build_array(jsonb_build_object('id', approved.id, 'version', approved.version)))::text as body
  from op646_graphs graph where graph.scenario = 'grant-expansion'
) graph
cross join lateral public.register_factory_workflow_graph_revision(pin.workspace_id, pin.factory_id, pin.definition_revision_id,
  pin.definition_digest, graph.body, encode(sha256(convert_to(graph.body, 'UTF8')), 'hex')) registered
cross join lateral public.start_factory_workflow_graph_execution(pin.session_id, pin.workspace_id, pin.factory_id,
  registered.graph_revision_id) started;
select is((select count(*) from op646_route_owners where scenario in ('service-selected', 'service-revoked')
  and created and ownership_token is not null), 2::bigint, 'both exact service-backed roots enroll before revocation');

create temp table op646_service_decision as
select * from pg_temp.op646_propose('service-selected', 'route.privileged', 'The approved route is available.', 0.9);
select ok((select admitted.created and admitted.resolution = 'selected' and target.node_id = 'route.privileged'
  from op646_service_decision admitted
  join op646_route_owners owner on owner.scenario = 'service-selected'
  join internal.factory_workflow_node_occurrences target
    on (target.root_session_id, target.occurrence_id) = (owner.session_id, admitted.target_occurrence_id)),
  'the live exact grant authorizes the scoped route and its privileged target');
select ok(revoked.revoked_at is not null and revoked.version = approved.version + 1,
  'revoking the enrolled execution grant advances its version')
from op646_grant approved cross join lateral public.revoke_factory_execution_grant(
  approved.workspace_id, approved.factory_id, pg_temp.op646_id(1), approved.id, approved.version, 'Route fixture revocation') revoked;
select throws_ok($$select pg_temp.op646_propose('service-revoked', 'route.privileged', 'The approved route is available.', 0.9)$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'the revoked grant stops a new decision on an already enrolled route');
select is(pg_temp.op646_read_decision('service-revoked'), null::jsonb, 'revocation leaves the fresh route without a receipt');
select ok((select not replay.created and (replay.decision_id, replay.transition_id, replay.target_occurrence_id) =
  (admitted.decision_id, admitted.transition_id, admitted.target_occurrence_id)
  from op646_service_decision admitted
  cross join pg_temp.op646_propose('service-selected', 'route.privileged', 'The approved route is available.', 0.9) replay),
  'an exact prior decision replays after grant revocation without admitting another target');
select is((select count(*) from internal.factory_workflow_transition_receipts transition
  join op646_route_owners owner on owner.session_id = transition.root_session_id
  where owner.scenario in ('service-selected', 'service-revoked')), 1::bigint,
  'the two service-backed roots retain only the originally authorized transition');

select * from finish();
rollback;
