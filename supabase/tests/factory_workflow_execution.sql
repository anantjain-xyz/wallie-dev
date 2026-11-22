begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '64400000-0000-4000-8000-000000000001';

create function pg_temp.op644_id(slot integer) returns uuid language sql immutable as $$
  select ('64400000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
insert into auth.users(id, email) values
  (pg_temp.op644_id(1), 'op644-owner@example.test'),
  (pg_temp.op644_id(2), 'op644-foreign-owner@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.op644_id(11), 'op644-workflow-fixture', 'Workflow receipt fixture'),
  (pg_temp.op644_id(12), 'op644-foreign-fixture', 'Unrelated workflow fixture');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.op644_id(21), pg_temp.op644_id(11), pg_temp.op644_id(1), 'human', 'owner'),
  (pg_temp.op644_id(22), pg_temp.op644_id(12), pg_temp.op644_id(2), 'human', 'owner');
insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential)
values (pg_temp.op644_id(1), 'platform_api_key', 'fixture-ciphertext');

create temp table op644_scope as
select workspace_id, id as factory_id from public.factories
where workspace_id = pg_temp.op644_id(11) and is_default;
insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
select pg_temp.op644_id(31), workspace_id, factory_id, 'Workflow receipt pipeline', true from op644_scope;
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name)
values (pg_temp.op644_id(32), pg_temp.op644_id(31), pg_temp.op644_id(11), 1, 'inspect-output', 'Inspect output');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.op644_id(33), pg_temp.op644_id(11), 64400033, 'https://github.test/installations/64400033',
  644000, 'Organization', 'Fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name, private, html_url, default_branch)
select pg_temp.op644_id(34), workspace_id, factory_id, pg_temp.op644_id(33), 64400034,
  'workflow-fixture', 'fixture/workflow-fixture', true, 'https://github.test/fixture/workflow-fixture', 'main'
from op644_scope;

with definition as (
  select workspace_id, factory_id, jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.op644_id(31),
    'repositoryId', pg_temp.op644_id(34), 'sandboxProvider', 'e2b',
    'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5', 'effort', 'high',
      'concurrencyLimit', 1, 'stallTimeoutMs', 900000, 'maxRetries', 3, 'maxTurns', 5),
    'executionPolicyRevisionId', null, 'deliveryPolicyRevisionId', null,
    'skillIds', '[]'::jsonb, 'toolIds', '[]'::jsonb, 'operatingRulesMd', '', 'operatingRuleStageIds', '[]'::jsonb,
    'stages', jsonb_build_array(jsonb_build_object('id', pg_temp.op644_id(32), 'slug', 'inspect-output',
      'name', 'Inspect output', 'description', '', 'promptTemplateMd', 'Inspect the admitted output.',
      'anyoneCanApprove', false, 'previousStageIds', '[]'::jsonb,
      'approverMemberIds', jsonb_build_array(pg_temp.op644_id(21))))
  )::text as body from op644_scope
), revision as (
  insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version,
    definition_json, canonical_digest, created_by)
  select pg_temp.op644_id(41), workspace_id, factory_id, 1, body,
    encode(sha256(convert_to(body, 'UTF8')), 'hex'), pg_temp.op644_id(21)
  from definition returning id, workspace_id, factory_id, created_by
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 1, created_by from revision;

create temp table op644_admitted as
select * from public.create_session_with_first_job(
  pg_temp.op644_id(11), pg_temp.op644_id(21), 'Workflow receipt fixture', 'Inspect the admitted output.',
  'codex', 'gpt-5.5');

create temp table op644_workflow as
with pinned as (
  select admitted.job_id, pin.session_id as root_session_id, pin.workspace_id, pin.factory_id,
    pin.definition_revision_id, pin.definition_digest, 'stage.' || pin.selected_stage_ids[1] as entry_node_id,
    'approval.' || pin.selected_stage_ids[1] as next_node_id,
    revision.definition_json::jsonb#>'{stages,0}' as stage
  from op644_admitted admitted
  join public.session_factory_admission_inputs pin using (session_id)
  join public.factory_definition_revisions revision on revision.id = pin.definition_revision_id
), compiled as (
  select pinned.*, 'next.' || entry_node_id as edge_id, jsonb_build_object(
    'kind', 'serial', 'entryNodeId', entry_node_id,
    'nodes', jsonb_build_array(
      jsonb_build_object('id', entry_node_id, 'kind', 'agent',
        'stage', stage - 'anyoneCanApprove' - 'approverMemberIds'),
      jsonb_build_object('id', next_node_id, 'kind', 'human-gate', 'stageId', stage->'id',
        'approval', jsonb_build_object('anyoneCanApprove', stage->'anyoneCanApprove',
          'approverMemberIds', stage->'approverMemberIds'))),
    'edges', jsonb_build_array(jsonb_build_object('id', 'next.' || entry_node_id,
      'kind', 'next', 'from', entry_node_id, 'to', next_node_id)))::text as workflow_json
  from pinned
)
select compiled.*, encode(sha256(convert_to(workflow_json, 'UTF8')), 'hex') as workflow_digest from compiled;

create function pg_temp.read_op644_workflow() returns jsonb language sql as $$
  select public.read_factory_workflow_execution(root_session_id, workspace_id, factory_id) from op644_workflow;
$$;
select is((select count(*) from op644_workflow), 1::bigint, 'the root has one real pinned definition');
select throws_ok($$select public.start_factory_workflow_execution(root_session_id, workspace_id, factory_id,
  definition_revision_id, repeat('0', 64), workflow_json, workflow_digest) from op644_workflow$$,
  'PT409', 'The workflow must match the session definition pin.', 'start rejects a different definition digest');
select throws_ok($$select public.start_factory_workflow_execution(root_session_id, workspace_id, factory_id,
  definition_revision_id, definition_digest, workflow_json, repeat('0', 64)) from op644_workflow$$,
  '22023', 'A verified compiled workflow is required.', 'start rejects a different workflow digest');

select throws_ok($$select public.start_factory_workflow_execution(root_session_id, workspace_id, factory_id,
  definition_revision_id, definition_digest, forged.body, encode(sha256(convert_to(forged.body, 'UTF8')), 'hex'))
  from op644_workflow cross join lateral (select replace(workflow_json, entry_node_id, 'stage.forged') as body) forged$$,
  'PT409', 'The workflow must match the session definition pin.', 'a self-consistent substituted stage node is not the pinned projection');
select throws_ok($$select public.start_factory_workflow_execution(root_session_id, workspace_id, factory_id,
  definition_revision_id, definition_digest, forged.body, encode(sha256(convert_to(forged.body, 'UTF8')), 'hex'))
  from op644_workflow cross join lateral (
    select jsonb_set(workflow_json::jsonb, '{nodes,1,approval,anyoneCanApprove}', 'true'::jsonb)::text as body) forged$$,
  'PT409', 'The workflow must match the session definition pin.', 'a recomputed digest cannot widen the pinned approval policy');

select throws_ok($$select public.start_factory_workflow_execution(root_session_id, workspace_id, factory_id,
  definition_revision_id, definition_digest, graph,
  encode(sha256(convert_to(graph, 'UTF8')), 'hex'))
  from op644_workflow
  cross join (values ('{"schemaVersion":1,"kind":"graph","entryNodeId":"check","nodes":[{"id":"check","kind":"deterministic","operation":"policy"}],"edges":[],"grants":[]}')) candidate(graph)$$,
  '22023', 'A verified compiled workflow is required.', 'a serial admission cannot substitute a graph plan');

-- Historical sessions could capture a definition receipt and still run live stages.
insert into public.sessions(id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id,
  current_stage_id, factory_definition_provenance, factory_definition_revision_id)
select pg_temp.op644_id(51), session.workspace_id, session.factory_id, 100, 'Historical workflow fixture',
  session.creator_member_id, session.pipeline_id, session.current_stage_id, 'pinned', session.factory_definition_revision_id
from public.sessions session join op644_admitted admitted on admitted.session_id = session.id;
insert into public.session_factory_admission_inputs(session_id, workspace_id, factory_id, activation_number,
  definition_revision_id, definition_digest, pipeline_id, github_repository_id, selected_stage_ids,
  execution_policy_revision_id, model_provider, model_name, title_sha256, prompt_sha256)
select pg_temp.op644_id(51), pin.workspace_id, pin.factory_id, pin.activation_number,
  pin.definition_revision_id, pin.definition_digest, pin.pipeline_id, pin.github_repository_id, pin.selected_stage_ids,
  pin.execution_policy_revision_id, pin.model_provider, pin.model_name, pin.title_sha256, pin.prompt_sha256
from public.session_factory_admission_inputs pin join op644_admitted admitted using (session_id);
select throws_ok($$select public.start_factory_workflow_execution(pg_temp.op644_id(51), workspace_id, factory_id,
  definition_revision_id, definition_digest, workflow_json, workflow_digest) from op644_workflow$$,
  'PT409', 'The workflow must match the session definition pin.', 'retained provenance alone cannot enroll live-stage execution');

create temp table op644_started as
select started.* from op644_workflow workflow cross join lateral public.start_factory_workflow_execution(
  root_session_id, workspace_id, factory_id, definition_revision_id, definition_digest, workflow_json, workflow_digest) started;
select ok((select created and execution_generation = 1 and entry_occurrence_id is not null
    and ownership_token is not null from op644_started),
  'start admits a single entry occurrence and returns its ownership token');
select ok((select not replay.created and replay.entry_occurrence_id = started.entry_occurrence_id
    and replay.execution_generation = started.execution_generation and replay.ownership_token is null
  from op644_workflow workflow cross join op644_started started cross join lateral public.start_factory_workflow_execution(
    root_session_id, workspace_id, factory_id, definition_revision_id, definition_digest, workflow_json, workflow_digest) replay),
  'an exact start replay returns the same occurrence without its ownership token');
select throws_ok($$select public.start_factory_workflow_execution(root_session_id, workspace_id, factory_id,
  definition_revision_id, definition_digest, workflow_json || ' ',
  encode(sha256(convert_to(workflow_json || ' ', 'UTF8')), 'hex')) from op644_workflow$$,
  'PT409', 'The root session already has a different workflow.', 'start cannot replace the stored workflow bytes');
select ok((select payload#>>'{execution,definition_revision_id}' = workflow.definition_revision_id::text
    and payload#>>'{execution,definition_digest}' = workflow.definition_digest
    and payload#>>'{execution,workflow_json}' = workflow.workflow_json
    and payload#>>'{execution,workflow_digest}' = workflow.workflow_digest
    and payload#>>'{occurrences,0,node_id}' = workflow.entry_node_id
    and jsonb_array_length(payload->'occurrences') = 1
  from op644_workflow workflow cross join lateral (select pg_temp.read_op644_workflow() as payload) snapshot),
  'restart data preserves the exact pin, compiled bytes, digest, and entry node');
select is(pg_temp.read_op644_workflow()->'runnableTransitions', '[]'::jsonb,
  'a pending entry does not make its successor runnable');
select throws_ok($$select public.admit_factory_workflow_next(root_session_id, workspace_id, factory_id,
  1, ownership_token, entry_occurrence_id, edge_id, pg_temp.op644_id(99)) from op644_workflow cross join op644_started$$,
  'PT409', 'The expected successful predecessor result is unavailable.', 'admission requires an actual successful result');

create temp table op644_failed_source as
select session.session_id as root_session_id, workflow.workspace_id, workflow.factory_id, workflow.edge_id,
  started.entry_occurrence_id, started.ownership_token, failed.result_id
from op644_workflow workflow
cross join lateral public.create_session_with_first_job(workflow.workspace_id, pg_temp.op644_id(21),
  'Failed workflow receipt fixture', 'Inspect the admitted output.', 'codex', 'gpt-5.5') session
cross join lateral public.start_factory_workflow_execution(session.session_id, workflow.workspace_id, workflow.factory_id,
  workflow.definition_revision_id, workflow.definition_digest, workflow.workflow_json, workflow.workflow_digest) started
cross join lateral public.record_factory_workflow_node_result(session.session_id, workflow.workspace_id, workflow.factory_id,
  1, started.ownership_token, started.entry_occurrence_id, 'failed', 'validation:failed-artifact') failed;
select is((select public.read_factory_workflow_execution(root_session_id, workspace_id, factory_id)->'runnableTransitions'
  from op644_failed_source), '[]'::jsonb, 'a recorded failure does not make its successor runnable');
select throws_ok($$select public.admit_factory_workflow_next(root_session_id, workspace_id, factory_id,
  1, ownership_token, entry_occurrence_id, edge_id, result_id) from op644_failed_source$$,
  'PT409', 'The expected successful predecessor result is unavailable.', 'the exact failed result cannot admit a successor');

create temp table op644_result as
select accepted.* from op644_workflow cross join op644_started cross join lateral public.record_factory_workflow_node_result(
  root_session_id, workspace_id, factory_id, 1, ownership_token, entry_occurrence_id, 'succeeded', 'validation:exact-artifact') accepted;
select ok((select created and result_id is not null from op644_result), 'the first completion receives a terminal result ID');
select ok((select not duplicate.created and duplicate.result_id = accepted.result_id
  from op644_workflow cross join op644_started cross join op644_result accepted
  cross join lateral public.record_factory_workflow_node_result(root_session_id, workspace_id, factory_id,
    1, ownership_token, entry_occurrence_id, 'succeeded', 'validation:exact-artifact') duplicate),
  'duplicate completion returns the same result ID');
select throws_ok($$select public.record_factory_workflow_node_result(root_session_id, workspace_id, factory_id,
  1, ownership_token, entry_occurrence_id, 'succeeded', 'validation:different-artifact') from op644_workflow cross join op644_started$$,
  'PT409', 'The workflow node already has a different result.', 'duplicate completion cannot replace the evidence reference');
select throws_ok($$select public.admit_factory_workflow_next(root_session_id, workspace_id, factory_id,
  1, ownership_token, entry_occurrence_id, edge_id, pg_temp.op644_id(99)) from op644_workflow cross join op644_started$$,
  'PT409', 'The expected successful predecessor result is unavailable.', 'the wrong result ID cannot admit a successor');

create temp table op644_handoff as
select handoff.* from op644_workflow
cross join lateral public.advance_factory_workflow_generation(root_session_id, workspace_id, factory_id, 1) handoff;
select ok((select handoff.execution_generation = 2 and handoff.ownership_token is not null
    and handoff.ownership_token <> started.ownership_token
  from op644_started started cross join op644_handoff handoff),
  'a handoff advances the root generation and rotates its ownership token');
select throws_ok($$select public.record_factory_workflow_node_result(root_session_id, workspace_id, factory_id,
  1, ownership_token, entry_occurrence_id, 'succeeded', 'validation:exact-artifact') from op644_workflow cross join op644_started$$,
  'PT409', 'Workflow generation is stale.', 'old ownership cannot replay a result mutation');
select throws_ok($$select public.admit_factory_workflow_next(root_session_id, workspace_id, factory_id,
  1, ownership_token, entry_occurrence_id, edge_id, result_id) from op644_workflow cross join op644_started cross join op644_result$$,
  'PT409', 'Workflow generation is stale.', 'old ownership cannot admit a transition');
select throws_ok($$select public.advance_factory_workflow_generation(root_session_id, workspace_id, factory_id, 1)
  from op644_workflow$$, 'PT409', 'Workflow generation is stale.', 'old ownership cannot advance the generation again');

create temp table op644_observed_execution as
select pg_temp.read_op644_workflow()->'execution' as payload;
select ok((select (payload->>'generation')::bigint = 2 and not (payload ? 'ownership_token')
  from op644_observed_execution), 'a read exposes the new generation without revealing its ownership token');
select ok((select not replay.created and replay.execution_generation = (observed.payload->>'generation')::bigint
    and replay.ownership_token is null and replay.entry_occurrence_id = started.entry_occurrence_id
  from op644_workflow workflow cross join op644_started started cross join op644_observed_execution observed
  cross join lateral public.start_factory_workflow_execution(root_session_id, workspace_id, factory_id,
    definition_revision_id, definition_digest, workflow_json, workflow_digest) replay),
  'an old owner cannot obtain the rotated token by replaying start');
select throws_ok($$select public.record_factory_workflow_node_result(root_session_id, workspace_id, factory_id,
  (observed.payload->>'generation')::bigint, started.ownership_token, started.entry_occurrence_id,
  'succeeded', 'validation:exact-artifact')
  from op644_workflow cross join op644_started started cross join op644_observed_execution observed$$,
  'PT409', 'Workflow ownership token is stale.', 'the observed generation cannot authorize an old owner to write a result');
select throws_ok($$select public.admit_factory_workflow_next(root_session_id, workspace_id, factory_id,
  (observed.payload->>'generation')::bigint, started.ownership_token, started.entry_occurrence_id, edge_id, result_id)
  from op644_workflow cross join op644_started started cross join op644_observed_execution observed cross join op644_result$$,
  'PT409', 'Workflow ownership token is stale.', 'the observed generation cannot authorize an old owner to admit an edge');

select throws_ok($$select public.advance_factory_workflow_generation(root_session_id, foreign_factory.workspace_id, foreign_factory.id, 2)
  from op644_workflow cross join public.factories foreign_factory
  where foreign_factory.workspace_id = pg_temp.op644_id(12) and foreign_factory.is_default$$,
  'PT404', 'Workflow root session is unavailable.', 'a matching root ID cannot grant authority to another factory');
select is((select public.read_factory_workflow_execution(root_session_id, foreign_factory.workspace_id, foreign_factory.id)
  from op644_workflow cross join public.factories foreign_factory
  where foreign_factory.workspace_id = pg_temp.op644_id(12) and foreign_factory.is_default), null::jsonb,
  'a restart read in another workspace does not expose the root');

update public.workspaces set deletion_requested_at = clock_timestamp() where id = pg_temp.op644_id(11);
select is(pg_temp.read_op644_workflow()->'runnableTransitions', '[]'::jsonb,
  'restart hides runnable edges once workspace deletion starts');
select throws_ok($$select public.advance_factory_workflow_generation(root_session_id, workspace_id, factory_id, 2)
  from op644_workflow$$, 'P0010', 'Workspace deletion is in progress.', 'a workspace deletion fence blocks new workflow ownership');
select throws_ok($$select public.admit_factory_workflow_next(root_session_id, workspace_id, factory_id,
  handoff.execution_generation, handoff.ownership_token, entry_occurrence_id, edge_id, result_id)
  from op644_workflow cross join op644_started cross join op644_handoff handoff cross join op644_result$$,
  'P0010', 'Workspace deletion is in progress.', 'a workspace deletion fence blocks edge admission');
update public.workspaces set deletion_requested_at = null where id = pg_temp.op644_id(11);

create function pg_temp.op644_peer_query(p_operation text) returns text language sql as $$
  select case p_operation when 'read' then format('select public.read_factory_workflow_execution(%L,%L,%L)',
    root_session_id, workspace_id, factory_id)
  when 'admit' then format('select * from public.admit_factory_workflow_next(%L,%L,%L,%L,%L,%L,%L,%L)',
    root_session_id, workspace_id, factory_id, handoff.execution_generation, handoff.ownership_token,
    entry_occurrence_id, edge_id, result_id) end
  from op644_workflow cross join op644_started cross join op644_handoff handoff cross join op644_result;
$$;
create function pg_temp.op644_wait_for_blocker(p_owner integer, p_waiter integer) returns boolean language plpgsql as $$
declare deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
  loop
    if p_owner = any(pg_blocking_pids(p_waiter)) then return true; end if;
    if clock_timestamp() >= deadline then return false; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;
create function pg_temp.op644_run_admission_race() returns void language plpgsql as $$
declare
  connection_string text := coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
    'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres');
  read_query text := pg_temp.op644_peer_query('read');
  admit_query text := pg_temp.op644_peer_query('admit');
  owner_pid integer;
  contender_pid integer;
  before_race jsonb;
  expected_runnable jsonb;
  first_admission record;
  second_admission record;
  restarted jsonb;
  expected_result_id uuid;
begin
  perform extensions.dblink_connect(peer.name, connection_string)
  from (values ('op644_a'), ('op644_b')) peer(name);
  perform extensions.dblink_exec(peer.name,
    'set role service_role; set request.jwt.claim.role = ''service_role''; set statement_timeout = ''15s''')
  from (values ('op644_a'), ('op644_b')) peer(name);
  select pid into strict owner_pid
    from extensions.dblink('op644_a', 'select pg_backend_pid()') peer(pid integer);
  select pid into strict contender_pid
    from extensions.dblink('op644_b', 'select pg_backend_pid()') peer(pid integer);
  select payload into strict before_race
    from extensions.dblink('op644_b', read_query) snapshot(payload jsonb);
  select source.result_id, jsonb_build_array(jsonb_build_object('sourceOccurrenceId', entry_occurrence_id,
    'sourceResultId', source.result_id, 'edgeId', edge_id)) into strict expected_result_id, expected_runnable
  from op644_workflow cross join op644_started cross join op644_result source;
  if (before_race#>>'{execution,generation}' = '2' and before_race->'transitions' = '[]'::jsonb
      and before_race->'runnableTransitions' = expected_runnable) is not true then
    raise exception 'A fresh worker did not recover the exact successful predecessor and runnable edge.';
  end if;

  perform extensions.dblink_exec('op644_a', 'begin');
  select * into strict first_admission from extensions.dblink('op644_a', admit_query)
    accepted(transition_id uuid, target_occurrence_id uuid, created boolean);
  if extensions.dblink_send_query('op644_b', admit_query) <> 1 then
    raise exception 'The second worker could not start its admission.';
  end if;
  if not pg_temp.op644_wait_for_blocker(owner_pid, contender_pid) then
    raise exception 'The second worker did not wait for the first admission transaction.';
  end if;
  perform extensions.dblink_exec('op644_a', 'commit');
  select * into strict second_admission from extensions.dblink_get_result('op644_b')
    accepted(transition_id uuid, target_occurrence_id uuid, created boolean);
  perform 1 from extensions.dblink_get_result('op644_b')
    drained(transition_id uuid, target_occurrence_id uuid, created boolean);
  if (first_admission.created and not second_admission.created
      and first_admission.transition_id = second_admission.transition_id
      and first_admission.target_occurrence_id = second_admission.target_occurrence_id) is not true then
    raise exception 'Concurrent duplicate admissions did not share one transition and target occurrence.';
  end if;

  perform extensions.dblink_connect('op644_restart', connection_string);
  perform extensions.dblink_exec('op644_restart',
    'set role service_role; set request.jwt.claim.role = ''service_role''; set statement_timeout = ''15s''');
  select payload into strict restarted
    from extensions.dblink('op644_restart', read_query) snapshot(payload jsonb);
  if (restarted->'runnableTransitions' = '[]'::jsonb
      and jsonb_array_length(restarted->'occurrences') = 2 and jsonb_array_length(restarted->'results') = 1
      and jsonb_array_length(restarted->'transitions') = 1
      and restarted#>>'{results,0,result_id}' = expected_result_id::text
      and restarted#>>'{results,0,recorded_generation}' = '1'
      and restarted#>>'{transitions,0,source_result_id}' = expected_result_id::text
      and restarted#>>'{transitions,0,transition_id}' = first_admission.transition_id::text
      and restarted#>>'{transitions,0,target_occurrence_id}' = first_admission.target_occurrence_id::text
      and restarted#>>'{transitions,0,recorded_generation}' = '2') is not true then
    raise exception 'A fresh worker did not recover the exact receipts after admission.';
  end if;
exception when query_canceled or assert_failure then
  -- pgTAP catches ordinary SQL errors. Preserve a peer timeout as a TAP failure too.
  raise exception 'Workflow admission race failed: %', sqlerrm;
end;
$$;
commit;

begin;
-- Isolate any peer SQL error from the transaction that deletes the committed fixtures.
select lives_ok($$select pg_temp.op644_run_admission_race()$$,
  'concurrent duplicate admission creates one transition and restart recovers exact receipts');
select lives_ok($$
  select extensions.dblink_disconnect(peer.name)
  from unnest(extensions.dblink_get_connections()) peer(name)
  where peer.name in ('op644_a', 'op644_b', 'op644_restart')
$$, 'all workflow race peers disconnect before fixture cleanup');
commit;

begin;
select is((select array_agg(job.id order by job.id) from op644_workflow workflow join public.agent_jobs job
  on (job.workspace_id, job.session_id) = (workflow.workspace_id, workflow.root_session_id)
  and job.status in ('queued', 'started', 'running')),
  (select array[job_id] from op644_workflow), 'the original job is still the only active legacy job');

select ok(not exists (select 1 from (values ('anon'), ('authenticated'), ('service_role')) roles(role_name)
  cross join (values ('internal.factory_workflow_executions'), ('internal.factory_workflow_node_occurrences'),
    ('internal.factory_workflow_node_results'), ('internal.factory_workflow_transition_receipts')) relations(relation_name)
  where has_table_privilege(role_name, relation_name, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')),
  'no API role has direct ledger table privileges');
select is((select count(*) from pg_class cls join pg_namespace ns on ns.oid = cls.relnamespace
  where ns.nspname = 'internal' and cls.relrowsecurity and cls.relname in ('factory_workflow_executions',
    'factory_workflow_node_occurrences', 'factory_workflow_node_results', 'factory_workflow_transition_receipts')), 4::bigint,
  'all ledger tables have RLS enabled');
select ok(not exists (select 1 from (values
  ('public.start_factory_workflow_execution(uuid,uuid,uuid,uuid,text,text,text)'),
  ('public.advance_factory_workflow_generation(uuid,uuid,uuid,bigint)'),
  ('public.record_factory_workflow_node_result(uuid,uuid,uuid,bigint,uuid,uuid,public.factory_workflow_node_outcome,text)'),
  ('public.admit_factory_workflow_next(uuid,uuid,uuid,bigint,uuid,uuid,text,uuid)'),
  ('public.read_factory_workflow_execution(uuid,uuid,uuid)')) functions(signature)
  where has_function_privilege('anon', signature, 'EXECUTE')
    or has_function_privilege('authenticated', signature, 'EXECUTE')
    or not has_function_privilege('service_role', signature, 'EXECUTE')),
  'workflow RPCs are executable by service role only among the API roles');

set local role authenticated;
select throws_ok($$select public.read_factory_workflow_execution(null, null, null)$$,
  '42501', null, 'an authenticated caller cannot execute the service-only restart RPC');
reset role;
set local role service_role;
select throws_ok($$select 1 from internal.factory_workflow_executions limit 1$$,
  '42501', null, 'a service role must use its RPC to access the ledger');
reset role;
commit;

begin;
set local request.jwt.claim.role = 'service_role';
delete from public.workspaces where id in (pg_temp.op644_id(11), pg_temp.op644_id(12));
delete from auth.users where id in (pg_temp.op644_id(1), pg_temp.op644_id(2));
select ok(not exists (select 1 from internal.factory_workflow_executions ledger join op644_workflow workflow using (root_session_id))
  and not exists (select 1 from internal.factory_workflow_node_occurrences ledger join op644_workflow workflow using (root_session_id))
  and not exists (select 1 from internal.factory_workflow_node_results ledger join op644_workflow workflow using (root_session_id))
  and not exists (select 1 from internal.factory_workflow_transition_receipts ledger join op644_workflow workflow using (root_session_id)),
  'deleting the workspace erases its committed execution and all ledger receipts');
select * from finish();
commit;
