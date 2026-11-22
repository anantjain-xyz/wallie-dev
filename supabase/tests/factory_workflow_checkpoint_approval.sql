begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.workflow_proof_id(slot integer) returns uuid language sql immutable as $$
  select ('645a0000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
insert into auth.users(id, email) values (pg_temp.workflow_proof_id(1), 'op645-checkpoint-approval@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.workflow_proof_id(11), 'op645-checkpoint-approval', 'Workflow checkpoint and approval');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.workflow_proof_id(21), pg_temp.workflow_proof_id(11), pg_temp.workflow_proof_id(1), 'human', 'owner');
insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential)
values (pg_temp.workflow_proof_id(1), 'platform_api_key', 'fixture-ciphertext');

create temp table workflow_proof_scope as
select workspace_id, id as factory_id from public.factories
where workspace_id = pg_temp.workflow_proof_id(11) and is_default;
insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
select pg_temp.workflow_proof_id(31), workspace_id, factory_id, 'Exact approval pipeline', true from workflow_proof_scope;
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name, approver_member_ids)
values (pg_temp.workflow_proof_id(32), pg_temp.workflow_proof_id(31), pg_temp.workflow_proof_id(11),
  1, 'review-source', 'Review source', array[pg_temp.workflow_proof_id(21)]);
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.workflow_proof_id(33), pg_temp.workflow_proof_id(11), 64510033,
  'https://github.test/installations/64510033', 645100, 'Organization', 'Proof fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name, private, html_url, default_branch)
select pg_temp.workflow_proof_id(34), workspace_id, factory_id, pg_temp.workflow_proof_id(33), 64510034,
  'workflow-proof', 'fixture/workflow-proof', true, 'https://github.test/fixture/workflow-proof', 'main'
from workflow_proof_scope;

with definition as (
  select workspace_id, factory_id, jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.workflow_proof_id(31),
    'repositoryId', pg_temp.workflow_proof_id(34), 'sandboxProvider', 'e2b',
    'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5', 'effort', 'high',
      'concurrencyLimit', 1, 'stallTimeoutMs', 900000, 'maxRetries', 3, 'maxTurns', 5),
    'executionPolicyRevisionId', null, 'deliveryPolicyRevisionId', null,
    'skillIds', '[]'::jsonb, 'toolIds', '[]'::jsonb, 'operatingRulesMd', '', 'operatingRuleStageIds', '[]'::jsonb,
    'stages', jsonb_build_array(jsonb_build_object('id', pg_temp.workflow_proof_id(32), 'slug', 'review-source',
      'name', 'Review source', 'description', '', 'promptTemplateMd', 'Review the exact checkpoint.',
      'anyoneCanApprove', false, 'previousStageIds', '[]'::jsonb,
      'approverMemberIds', jsonb_build_array(pg_temp.workflow_proof_id(21))))
  )::text as body from workflow_proof_scope
), revision as (
  insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version,
    definition_json, canonical_digest, created_by)
  select pg_temp.workflow_proof_id(41), workspace_id, factory_id, 1, body,
    encode(sha256(convert_to(body, 'UTF8')), 'hex'), pg_temp.workflow_proof_id(21)
  from definition returning id, workspace_id, factory_id, created_by
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 1, created_by from revision;

create function pg_temp.workflow_proof_prepare(label text, head_sha text, validation_status text default null)
returns table (root_session_id uuid, input_run_id uuid)
language plpgsql as $$
declare
  created record;
  started uuid;
  base_sha text := repeat('a', 40);
  tree_sha text := repeat('c', 40);
begin
  select * into strict created from public.create_session_with_first_job(
    pg_temp.workflow_proof_id(11), pg_temp.workflow_proof_id(21), label, 'Review exact source.', 'codex', 'gpt-5.5');
  -- Select this fixture's job without claiming unrelated work on the shared test DB.
  update public.agent_jobs
  set status = 'running', attempt_count = 1,
      git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
  where id = created.job_id;
  started := public.start_session_job_attempt(created.job_id, 1, pg_temp.workflow_proof_id(32),
    0, 'codex', 'gpt-5.5', 'code', 'wallie/workflow-proof-' || created.job_id::text);
  if started is null then raise exception 'Could not start the workflow source fixture.'; end if;
  perform public.pin_session_job_git_input(created.job_id, 1, started, pg_temp.workflow_proof_id(34), 'main', base_sha);
  if validation_status is not null then
    perform public.pin_session_validation_plan(started, head_sha, tree_sha,
      '{"version":1,"commands":[{"key":"tests","command":"pnpm test","timeoutSeconds":30,"reports":[]}]}');
    if validation_status <> 'missing' then
      perform public.record_session_validation_evidence(started, head_sha, tree_sha,
        jsonb_build_array(jsonb_build_object('key', 'tests', 'command', 'pnpm test', 'provenance', 'harness',
          'status', validation_status, 'exitCode', case when validation_status = 'passed' then 0 else 1 end,
          'startedAt', clock_timestamp(), 'completedAt', clock_timestamp(),
          'commitSha', head_sha, 'treeSha', tree_sha, 'finalCommitSha', head_sha, 'finalTreeSha', tree_sha,
          'reportKeys', '[]'::jsonb, 'missingRequiredReports', '[]'::jsonb)));
    end if;
  end if;
  if not public.prepare_session_source_and_checkpoint_publication(started, pg_temp.workflow_proof_id(34),
    'main', base_sha, head_sha, label, 'Checkpoint test PR body', '',
    case when head_sha <> base_sha then encode(sha256(convert_to('fixture source bundle', 'UTF8')), 'hex') else '' end,
    case when head_sha <> base_sha then encode(convert_to('fixture source bundle', 'UTF8'), 'base64') else '' end,
    0, 'Review the exact checkpoint.') then
    raise exception 'Could not prepare the workflow source fixture.';
  end if;
  return query select created.session_id, started;
end;
$$;

create temp table workflow_proof_sources as
select fixture.label, prepared.* from (values ('exact', repeat('b', 40)), ('other', repeat('a', 40))) fixture(label, head_sha)
cross join lateral pg_temp.workflow_proof_prepare(fixture.label, fixture.head_sha) prepared;

create temp table workflow_proof_graph as
select ret.graph_revision_id, scope.workspace_id, scope.factory_id
from workflow_proof_scope scope
join public.factory_definition_revisions revision on revision.id = pg_temp.workflow_proof_id(41)
cross join lateral (select jsonb_build_object('kind', 'graph', 'schemaVersion', 1, 'entryNodeId', 'checkpoint.observe',
  'nodes', jsonb_build_array(
    jsonb_build_object('id', 'checkpoint.observe', 'kind', 'deterministic', 'operation', 'checkpoint'),
    jsonb_build_object('id', 'human.review', 'kind', 'human-gate', 'anyoneCanApprove', false,
      'approverMemberIds', jsonb_build_array(pg_temp.workflow_proof_id(21))),
    jsonb_build_object('id', 'checkpoint.resume', 'kind', 'deterministic', 'operation', 'checkpoint')),
  'edges', '[{"id":"next.checkpoint","kind":"next","from":"checkpoint.observe","to":"human.review"},
    {"id":"next.human","kind":"next","from":"human.review","to":"checkpoint.resume"}]'::jsonb,
  'grants', '[]'::jsonb)::text body) compiled
cross join lateral public.register_factory_workflow_graph_revision(scope.workspace_id, scope.factory_id,
  revision.id, revision.canonical_digest, compiled.body, encode(sha256(convert_to(compiled.body, 'UTF8')), 'hex')) ret;

select throws_ok($$select public.start_factory_workflow_graph_execution(exact.root_session_id, graph.workspace_id,
  graph.factory_id, graph.graph_revision_id, other.input_run_id)
  from workflow_proof_graph graph cross join workflow_proof_sources exact cross join workflow_proof_sources other
  where exact.label = 'exact' and other.label = 'other'$$,
  'PT409', 'The graph input run has no current scoped checkpoint publication intent.',
  'graph enrollment rejects a real publication intent from another session');

create temp table workflow_proof_started as
select graph.workspace_id, graph.factory_id, source.root_session_id, source.input_run_id, started.*
from workflow_proof_graph graph cross join workflow_proof_sources source
cross join lateral public.start_factory_workflow_graph_execution(source.root_session_id, graph.workspace_id,
  graph.factory_id, graph.graph_revision_id, source.input_run_id) started
where source.label = 'exact';
create temp table workflow_proof_other_started as
select graph.workspace_id, graph.factory_id, source.root_session_id, source.input_run_id, started.*
from workflow_proof_graph graph cross join workflow_proof_sources source
cross join lateral public.start_factory_workflow_graph_execution(source.root_session_id, graph.workspace_id,
  graph.factory_id, graph.graph_revision_id, source.input_run_id) started
where source.label = 'other';
select is((select count(*) from workflow_proof_started started
  cross join lateral public.record_factory_workflow_command_result(started.root_session_id, started.workspace_id,
    started.factory_id, started.execution_generation, started.ownership_token, started.entry_occurrence_id,
    'checkpoint:' || started.input_run_id::text)), 0::bigint,
  'a prepared checkpoint supplies no graph success before guarded adoption');

create function pg_temp.workflow_proof_adopt(run_id uuid) returns boolean language plpgsql as $$
declare
  claim uuid := public.claim_session_checkpoint_publication(run_id);
  source public.session_source_deliveries;
  retained text;
begin
  select delivery.* into strict source from public.session_source_deliveries delivery where delivery.run_id = $1;
  select publication.retained_ref into strict retained from public.session_checkpoint_publications publication where publication.run_id = $1;
  return claim is not null and public.adopt_session_checkpoint_publication(run_id, claim, retained,
    case when retained is not null then source.head_sha end);
end;
$$;
select is((select count(*) from workflow_proof_sources where pg_temp.workflow_proof_adopt(input_run_id)),
  2::bigint, 'the guarded publisher adopts the code and unchanged source fixtures');
select is((select count(*) from workflow_proof_started started cross join workflow_proof_sources other
  cross join lateral public.record_factory_workflow_command_result(started.root_session_id, started.workspace_id,
    started.factory_id, started.execution_generation, started.ownership_token, started.entry_occurrence_id,
    'checkpoint:' || other.input_run_id::text)
  where other.label = 'other'), 0::bigint, 'another successful run cannot satisfy the pinned checkpoint');

create temp table workflow_proof_gate as
select started.*, result.result_id as checkpoint_result_id, admitted.target_occurrence_id as gate_occurrence_id
from workflow_proof_started started
cross join lateral public.record_factory_workflow_command_result(started.root_session_id, started.workspace_id,
  started.factory_id, started.execution_generation, started.ownership_token, started.entry_occurrence_id,
  'checkpoint:' || started.input_run_id::text) result
cross join lateral public.admit_factory_workflow_next(started.root_session_id, started.workspace_id, started.factory_id,
  started.execution_generation, started.ownership_token, started.entry_occurrence_id, 'next.checkpoint', result.result_id) admitted;
select is((select count(*) from workflow_proof_gate where checkpoint_result_id is not null and gate_occurrence_id is not null),
  1::bigint, 'the adopted exact checkpoint admits the human gate once');

create function pg_temp.workflow_proof_approve(root_id uuid) returns uuid language sql as $$
  select approved.id from public.sessions root
  cross join lateral public.approve_session_stage(root.id, root.workspace_id, root.current_stage_id,
    root.current_artifact_id, root.current_artifact_version, pg_temp.workflow_proof_id(21),
    'codex', 'gpt-5.5', 'code', root.artifact_review_revision) approved
  where root.id = root_id;
$$;
select is((select pg_temp.workflow_proof_approve(root_session_id) from workflow_proof_sources where label = 'other'),
  (select root_session_id from workflow_proof_sources where label = 'other'), 'a human approves the unrelated source fixture');
select is((select count(*) from workflow_proof_gate gate join workflow_proof_sources other on other.label = 'other'
  join public.session_stage_approval_receipts approval on approval.session_id = other.root_session_id
  cross join lateral public.record_factory_workflow_command_result(gate.root_session_id, gate.workspace_id,
    gate.factory_id, gate.execution_generation, gate.ownership_token, gate.gate_occurrence_id,
    'human-gate:' || approval.id::text)), 0::bigint, 'another session’s genuine human decision cannot satisfy the gate');
select is((select pg_temp.workflow_proof_approve(root_session_id) from workflow_proof_started),
  (select root_session_id from workflow_proof_sources where label = 'exact'), 'the guarded human command approves the exact artifact');

create temp table workflow_proof_review as
select gate.*, approval.completion_id, approval.id as approval_id, result.result_id as approval_result_id
from workflow_proof_gate gate
join public.session_stage_approval_receipts approval on approval.session_id = gate.root_session_id
cross join lateral public.record_factory_workflow_command_result(gate.root_session_id, gate.workspace_id,
  gate.factory_id, gate.execution_generation, gate.ownership_token, gate.gate_occurrence_id,
  'human-gate:' || approval.id::text) result;
select is((select count(*) from workflow_proof_review where approval_result_id is not null),
  1::bigint, 'the latest receipt for the pinned artifact and stage satisfies the graph gate');
select ok((select not replay.created and replay.result_id = review.approval_result_id
  from workflow_proof_review review cross join lateral public.record_factory_workflow_command_result(review.root_session_id,
    review.workspace_id, review.factory_id, review.execution_generation, review.ownership_token,
    review.gate_occurrence_id, 'human-gate:' || review.approval_id::text) replay),
  'recovery observes the same human result without another domain approval');

-- A reroute deletes the invalidated completion while preserving the approval receipt.
delete from public.session_phase_completions completion using workflow_proof_review review
where completion.id = review.completion_id;
select is((select count(*) from workflow_proof_review review cross join lateral public.admit_factory_workflow_next(
  review.root_session_id, review.workspace_id, review.factory_id, review.execution_generation, review.ownership_token,
  review.gate_occurrence_id, 'next.human', review.approval_result_id)),
  0::bigint, 'a graph admission rechecks that the observed approval still has a valid stage completion');
select is((select jsonb_array_length(public.read_factory_workflow_execution(root_session_id, workspace_id, factory_id)->'transitions')
  from workflow_proof_started), 1, 'the invalidated human result does not admit a successor');

-- The other session still has its own exact approval and completion.
select is((select count(admitted.target_occurrence_id)
  from workflow_proof_other_started started
  join public.session_stage_approval_receipts approval on approval.session_id = started.root_session_id
  cross join lateral public.record_factory_workflow_command_result(started.root_session_id, started.workspace_id,
    started.factory_id, started.execution_generation, started.ownership_token, started.entry_occurrence_id,
    'checkpoint:' || started.input_run_id::text) checkpoint
  cross join lateral public.admit_factory_workflow_next(started.root_session_id, started.workspace_id,
    started.factory_id, started.execution_generation, started.ownership_token, started.entry_occurrence_id,
    'next.checkpoint', checkpoint.result_id) gate
  cross join lateral public.record_factory_workflow_command_result(started.root_session_id, started.workspace_id,
    started.factory_id, started.execution_generation, started.ownership_token, gate.target_occurrence_id,
    'human-gate:' || approval.id::text) result
  cross join lateral public.admit_factory_workflow_next(started.root_session_id, started.workspace_id,
    started.factory_id, started.execution_generation, started.ownership_token, gate.target_occurrence_id,
    'next.human', result.result_id) admitted),
  1::bigint, 'the exact approval and surviving completion admit a successor');

-- Validation uses a new definition revision so the checkpoint and human cases
-- above retain their original delivery policy and approval behavior.
create temp table workflow_proof_validation_revision as
with policy as (
  select * from public.save_delivery_policy(pg_temp.workflow_proof_id(11), pg_temp.workflow_proof_id(31),
    pg_temp.workflow_proof_id(1), 0, '{"version":1,"deliveryMode":"code","requiredChecks":[],
    "minimumApprovals":0,"requireCodeOwnerReview":false,"requireResolvedThreads":false,
    "requiredEvidence":["tests"],"freshnessSeconds":300,"requireArtifactApprovalForDelivery":false}')
), definition as (
  select prior.workspace_id, prior.factory_id, prior.created_by,
    jsonb_set(prior.definition_json::jsonb, '{deliveryPolicyRevisionId}', to_jsonb(policy.id))::text as body
  from public.factory_definition_revisions prior cross join policy where prior.id = pg_temp.workflow_proof_id(41)
), inserted as (
  insert into public.factory_definition_revisions(workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by)
  select workspace_id, factory_id, 1, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), created_by from definition
  returning id, workspace_id, factory_id, canonical_digest, created_by
)
select * from inserted;
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 2, created_by from workflow_proof_validation_revision;

create temp table workflow_proof_validation_sources as
select fixture.status, prepared.* from (values ('passed'), ('failed'), ('missing')) fixture(status)
cross join lateral pg_temp.workflow_proof_prepare('Validation ' || fixture.status, repeat('a', 40), fixture.status) prepared;
select is((select count(*) from workflow_proof_validation_sources where pg_temp.workflow_proof_adopt(input_run_id)),
  3::bigint, 'all validation cases adopt their exact source independently of validation outcome');

create temp table workflow_proof_validation_started as
select source.*, revision.workspace_id, revision.factory_id, started.*
from workflow_proof_validation_revision revision
cross join (values ('{"kind":"graph","schemaVersion":1,"entryNodeId":"validation.check","nodes":[
  {"id":"validation.check","kind":"deterministic","operation":"validation"}],"edges":[],"grants":[]}')) compiled(body)
cross join lateral public.register_factory_workflow_graph_revision(revision.workspace_id, revision.factory_id, revision.id,
  revision.canonical_digest, compiled.body, encode(sha256(convert_to(compiled.body, 'UTF8')), 'hex')) registered
cross join workflow_proof_validation_sources source
cross join lateral public.start_factory_workflow_graph_execution(source.root_session_id, revision.workspace_id,
  revision.factory_id, registered.graph_revision_id, source.input_run_id) started;
create temp table workflow_proof_validation_results as
select started.status, result.* from workflow_proof_validation_started started
left join lateral public.record_factory_workflow_command_result(started.root_session_id, started.workspace_id,
  started.factory_id, started.execution_generation, started.ownership_token, started.entry_occurrence_id,
  'validation:' || started.input_run_id::text) result on true;
select is((select count(*) from workflow_proof_validation_results), 3::bigint, 'all exact validation cases reach the guarded node');
select ok((select created and result_id is not null from workflow_proof_validation_results where status = 'passed'),
  'exact passing harness evidence satisfies the pinned validation policy');
select is((select count(result_id) from workflow_proof_validation_results where status in ('failed', 'missing')),
  0::bigint, 'failed and missing harness evidence create no graph result');

select * from finish();
rollback;
