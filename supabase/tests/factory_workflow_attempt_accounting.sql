begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '647a0000-0000-4000-8000-000000000001';
create function pg_temp.op647_id(slot integer) returns uuid language sql immutable as $$
  select ('647a0000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
insert into auth.users(id, email) values
  (pg_temp.op647_id(1), 'op647-attempt-accounting@example.test'),
  (pg_temp.op647_id(2), 'op647-unrelated-tenant@example.test');
insert into public.workspaces(id, slug, name)
values
  (pg_temp.op647_id(11), 'op647-attempt-accounting', 'Delegated attempt accounting'),
  (pg_temp.op647_id(12), 'op647-unrelated-tenant', 'Unrelated attempt accounting tenant');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values
  (pg_temp.op647_id(21), pg_temp.op647_id(11), pg_temp.op647_id(1), 'human', 'owner'),
  (pg_temp.op647_id(22), pg_temp.op647_id(12), pg_temp.op647_id(2), 'human', 'owner');
create temp table op647_scope as
select workspace_id, id as factory_id from public.factories
where workspace_id = pg_temp.op647_id(11) and is_default;
insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
select pg_temp.op647_id(31), workspace_id, factory_id, 'Delegated attempt pipeline', true from op647_scope;
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name, approver_member_ids)
values (pg_temp.op647_id(32), pg_temp.op647_id(31), pg_temp.op647_id(11),
  1, 'review-source', 'Review source', array[pg_temp.op647_id(21)]);
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.op647_id(33), pg_temp.op647_id(11), 64710033,
  'https://github.test/installations/64710033', 647100, 'Organization', 'Proof fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name, private, html_url, default_branch)
select pg_temp.op647_id(34), workspace_id, factory_id, pg_temp.op647_id(33), 64710034,
  'workflow-proof', 'fixture/workflow-proof', true, 'https://github.test/fixture/workflow-proof', 'main'
from op647_scope;

create temp table op647_prompt as
select prompt.* from op647_scope scope
cross join lateral public.create_factory_agent(
  scope.workspace_id, scope.factory_id, pg_temp.op647_id(1),
  'Delegated fixture agent', 'delegated-fixture-agent', 'Inspect the source and report the delegated outcome.'
) prompt;

create temp table op647_policy as
select * from public.save_execution_policy(
  pg_temp.op647_id(11), pg_temp.op647_id(1), 0,
  '{"version":1,"maxRepairAttempts":3,"maxExecutionMs":600000,"maxTotalTokens":null,"maxCostUsd":null}'
);

create temp table op647_principal as
select principal.* from op647_scope scope cross join lateral public.create_service_principal(
  scope.workspace_id, scope.factory_id, pg_temp.op647_id(1), 'Workflow delegator', 'workflow-delegator') principal;
create temp table op647_grant as
select approved.* from op647_principal principal cross join op647_policy policy
cross join lateral public.approve_factory_execution_grant(
  principal.workspace_id, principal.factory_id, pg_temp.op647_id(1), principal.id, pg_temp.op647_id(34),
  '{}', '{}', policy.id, pg_temp.op647_id(21), clock_timestamp() + interval '1 hour', 0, null,
  '{sessions:create}'::public.factory_command_scope[]) approved;
insert into public.workspace_secrets(id, workspace_id, key, encrypted_value)
values (pg_temp.op647_id(35), pg_temp.op647_id(11), 'OP647_AGENT_KEY', 'fixture-service-ciphertext');
insert into public.workspace_sandbox_settings(workspace_id, active_provider)
values (pg_temp.op647_id(11), 'e2b')
on conflict (workspace_id) do update set active_provider = excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id, encrypted_api_key)
values (pg_temp.op647_id(11), 'fixture-sandbox-ciphertext');
create temp table op647_binding as
select binding.* from op647_grant approved cross join op647_prompt prompt
cross join lateral public.create_factory_secret_binding(approved.workspace_id, approved.factory_id, pg_temp.op647_id(1),
  approved.id, approved.version, prompt.agent_id, 'codex', pg_temp.op647_id(35)) binding;

with definition as (
  select scope.workspace_id, scope.factory_id, profile.slot, jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.op647_id(31),
    'repositoryId', pg_temp.op647_id(34), 'sandboxProvider', 'e2b',
    'executionGrant', jsonb_build_object('id', approved.id, 'version', approved.version), 'credentialBindingId', binding.id,
    'implementationAgent', (select jsonb_build_object('agentId', agent_id, 'promptRevisionId', id,
      'promptMd', prompt_md, 'promptSha256', prompt_sha256) from op647_prompt),
    'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5', 'effort', 'high',
      'concurrencyLimit', 4, 'stallTimeoutMs', 900000, 'maxRetries', 3, 'maxTurns', profile.max_turns),
    'executionPolicyRevisionId', (select id from op647_policy), 'deliveryPolicyRevisionId', null,
    'skillIds', '[]'::jsonb, 'toolIds', '[]'::jsonb, 'operatingRulesMd', '', 'operatingRuleStageIds', '[]'::jsonb,
    'stages', jsonb_build_array(jsonb_build_object('id', pg_temp.op647_id(32), 'slug', 'review-source',
      'name', 'Review source', 'description', '', 'promptTemplateMd', 'Review the exact checkpoint.',
      'anyoneCanApprove', false, 'previousStageIds', '[]'::jsonb,
      'approverMemberIds', jsonb_build_array(pg_temp.op647_id(21))))
  )::text as body from op647_scope scope cross join op647_grant approved cross join op647_binding binding
  cross join (values (41, 4), (42, 5)) profile(slot, max_turns)
), revision as (
  insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version,
    definition_json, canonical_digest, created_by)
  select pg_temp.op647_id(slot), workspace_id, factory_id, 1, body,
    encode(sha256(convert_to(body, 'UTF8')), 'hex'), pg_temp.op647_id(21)
  from definition returning id, workspace_id, factory_id, created_by
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, case when id = pg_temp.op647_id(41) then 1 else 2 end, created_by
from revision order by id;

select public.issue_factory_machine_token(workspace_id, factory_id, pg_temp.op647_id(1), id, version,
  pg_temp.op647_id(36), repeat('a', 64), 'Delegated attempt fixture', '{sessions:create}') from op647_grant;

create function pg_temp.op647_create_service_root(p_title text) returns jsonb language plpgsql as $$
declare
  scope record;
  permit record;
  request_id uuid := gen_random_uuid();
  receipt jsonb;
begin
  select workspace_id, factory_id into strict scope from op647_scope;
  select * into strict permit from public.admit_factory_command(scope.workspace_id, scope.factory_id, 'machine_token',
    pg_temp.op647_id(36), repeat('a', 64), 'sessions:create', request_id, repeat('b', 64), 'api');
  if permit.status <> 'admitted' then raise exception 'Delegation fixture admission failed: %', permit.status; end if;
  receipt := public.execute_factory_session_mutation(scope.workspace_id, scope.factory_id, 'machine_token',
    pg_temp.op647_id(36), repeat('a', 64), request_id, repeat('b', 64), 'api', permit.admission_id, permit.lease_id,
    'create', request_id, jsonb_build_object('title', p_title, 'prompt', 'Inspect the source checkpoint.',
      'agentId', (select agent_id from op647_prompt), 'repositoryId', pg_temp.op647_id(34), 'draftSpecification', false));
  perform public.release_factory_command_admission(permit.admission_id, permit.lease_id);
  return receipt;
end;
$$;

-- Keep release setup local unless the fixture explicitly commits for dblink.
create temp table op647_prior_release as select * from public.get_git_continuity_release_state();
select public.set_git_continuity_release(true, revision, 'Delegated attempt accounting fixture')
from op647_prior_release where not enabled;

create function pg_temp.op647_prepare_root(p_label text, p_head_sha text)
returns table (root_session_id uuid, input_run_id uuid)
language plpgsql as $$
declare
  receipt jsonb;
  root_id uuid;
  job_id uuid;
  started uuid;
  base_sha text := repeat('a', 40);
  bundle text := 'OP647 fixture source bundle';
begin
  receipt := pg_temp.op647_create_service_root(p_label);
  root_id := (receipt->>'sessionId')::uuid;
  job_id := (receipt->>'jobId')::uuid;
  -- Select the fixture source job directly. The assertions exercise actual claim for delegated jobs.
  update public.agent_jobs
  set status = 'running', attempt_count = 1,
      git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
  where id = job_id;

  started := public.start_session_job_attempt(job_id, 1, pg_temp.op647_id(32),
    0, 'codex', 'gpt-5.5', 'code', 'wallie/op647-source-' || job_id::text);
  if started is null then raise exception 'Could not start the source attempt.'; end if;
  perform public.pin_session_job_git_input(job_id, 1, started, pg_temp.op647_id(34), 'main', base_sha);
  if not found then
    raise exception 'Could not pin the source attempt Git input.';
  end if;
  if not public.prepare_session_source_and_checkpoint_publication(
    started, pg_temp.op647_id(34), 'main', base_sha, p_head_sha, p_label, 'Delegated attempt fixture source', '',
    case when p_head_sha <> base_sha then encode(sha256(convert_to(bundle, 'UTF8')), 'hex') else '' end,
    case when p_head_sha <> base_sha then encode(convert_to(bundle, 'UTF8'), 'base64') else '' end,
    0, 'Source is ready for a delegated attempt.') then
    raise exception 'Could not prepare the source checkpoint.';
  end if;
  return query select root_id, started;
end;
$$;

create function pg_temp.op647_enroll_root(
  p_label text, p_graph jsonb, p_head_sha text default repeat('a', 40), p_approve boolean default true
)
returns table (
  root_session_id uuid, workspace_id uuid, factory_id uuid, input_run_id uuid,
  execution_generation bigint, ownership_token uuid, entry_occurrence_id uuid
)
language plpgsql as $$
declare
  root record;
  registered record;
  started record;
  claim uuid;
  approved uuid;
  owner public.sessions;
  workflow_json text := p_graph::text;
  retained_ref text;
begin
  select * into strict root from pg_temp.op647_prepare_root(p_label, p_head_sha);
  select scope.workspace_id, scope.factory_id, revision.graph_revision_id into strict registered
  from op647_scope scope
  join public.factory_definition_revisions definition on definition.id = pg_temp.op647_id(42)
  cross join lateral public.register_factory_workflow_graph_revision(
    scope.workspace_id, scope.factory_id, definition.id, definition.canonical_digest,
    workflow_json, encode(sha256(convert_to(workflow_json, 'UTF8')), 'hex')) revision;
  select * into strict started from public.start_factory_workflow_graph_execution(
    root.root_session_id, registered.workspace_id, registered.factory_id,
    registered.graph_revision_id, root.input_run_id);
  select publication.retained_ref into strict retained_ref
  from public.session_checkpoint_publications publication where publication.run_id = root.input_run_id;
  claim := public.claim_session_checkpoint_publication(root.input_run_id);
  if not started.created or started.ownership_token is null or claim is null
    or not public.adopt_session_checkpoint_publication(root.input_run_id, claim, retained_ref,
      case when retained_ref is not null then p_head_sha end) then
    raise exception 'Could not enroll or adopt the source checkpoint.';
  end if;
  if p_approve then
    select * into strict owner from public.sessions where id = root.root_session_id;
    select result.id into strict approved from public.approve_session_stage(owner.id, owner.workspace_id,
      owner.current_stage_id, owner.current_artifact_id, owner.current_artifact_version,
      pg_temp.op647_id(21), 'codex', 'gpt-5.5', 'code', owner.artifact_review_revision) result;
    if approved is distinct from root.root_session_id then
      raise exception 'Could not approve the delegated root checkpoint.';
    end if;
  end if;
  return query select root.root_session_id, registered.workspace_id, registered.factory_id,
    root.input_run_id, started.execution_generation, started.ownership_token, started.entry_occurrence_id;
end;
$$;

create function pg_temp.op647_claim_only(p_job uuid, p_expected_attempt integer) returns public.agent_jobs
language plpgsql as $$
declare
  claimed public.agent_jobs;
begin
  -- Move only this fixture's job ahead of other test work; exercise the real
  -- workspace/root/job claim and start fences.
  update public.agent_jobs
  set scheduled_at = null, created_at = '2000-01-01T00:00:00Z'
  where id = p_job and status = 'queued';
  select * into strict claimed from public.claim_next_agent_job(false, 1000, 'node');
  if (claimed.id, claimed.attempt_count) is distinct from (p_job, p_expected_attempt) then
    raise exception 'Fixture claim did not pick the expected exact attempt.';
  end if;
  return claimed;
end;
$$;
create function pg_temp.op647_graph(p_max_attempts integer) returns jsonb language sql as $$
  select jsonb_build_object(
    'kind', 'graph', 'schemaVersion', 1, 'entryNodeId', 'route.select',
    'nodes', jsonb_build_array(
      jsonb_build_object('id', 'route.select', 'kind', 'route', 'agentPromptRevisionId', prompt.id, 'grantId', approved.id),
      jsonb_build_object('id', 'child.first', 'kind', 'agent', 'agentPromptRevisionId', prompt.id, 'grantId', approved.id),
      jsonb_build_object('id', 'child.second', 'kind', 'agent', 'agentPromptRevisionId', prompt.id, 'grantId', approved.id),
      jsonb_build_object('id', 'child.followup', 'kind', 'deterministic', 'operation', 'policy')
    ),
    'edges', '[
      {"id":"route.first","kind":"route","from":"route.select","to":"child.first"},
      {"id":"route.second","kind":"route","from":"route.select","to":"child.second"},
      {"id":"child.followup","kind":"next","from":"child.first","to":"child.followup"}
    ]'::jsonb,
    'grants', jsonb_build_array(jsonb_build_object('id', approved.id, 'version', approved.version)),
    'routePolicy', '{
      "maxNodeVisits": 16, "maxLoopTraversals": 0,
      "nodes": {"route.select": {"minimumConfidence": 0.7,
        "allowedDestinationIds": ["child.first", "child.second"], "fallback": {"kind":"clarification"}}}
    }'::jsonb,
    'delegationPolicy', jsonb_build_object(
      'maxChildren', 2, 'maxConcurrentChildren', 2, 'maxAttempts', p_max_attempts,
      'maxTotalTokens', 300, 'maxCostUsd', 3.0,
      'maxTokensPerAttempt', 40, 'maxCostUsdPerAttempt', 0.40,
      'targets', jsonb_build_object(
        'child.first', jsonb_build_object('definitionRevisionId', definition.id, 'definitionDigest', definition.canonical_digest),
        'child.second', jsonb_build_object('definitionRevisionId', definition.id, 'definitionDigest', definition.canonical_digest)
      )
    )
  ) from public.factory_definition_revisions definition cross join op647_grant approved cross join op647_prompt prompt
    where definition.id = pg_temp.op647_id(41);
$$;

create function pg_temp.op647_targets(
  p_root uuid, p_workspace uuid, p_factory uuid, p_generation bigint, p_owner uuid,
  p_entry uuid
) returns table (slot text, occurrence_id uuid)
language plpgsql as $$
declare
  second_source uuid;
begin
  -- Isolate competing admission without requiring branch scheduling. Both
  -- arrival receipts come from the guarded route decision RPC.
  insert into internal.factory_workflow_node_occurrences(root_session_id, node_id, node_kind, admitted_generation)
  values (p_root, 'route.select', 'route', p_generation)
  returning factory_workflow_node_occurrences.occurrence_id into second_source;

  return query
  select candidate.slot, decision.target_occurrence_id
  from (values ('first', p_entry, 'child.first'), ('second', second_source, 'child.second'))
    candidate(slot, source_occurrence_id, destination)
  cross join lateral public.admit_factory_workflow_route_decision(
    p_root, p_workspace, p_factory, p_generation, p_owner, candidate.source_occurrence_id,
    'Delegate through the admitted route.', candidate.destination, 0.9) decision;
end;
$$;
create function pg_temp.op647_connect_contender(p_name text) returns void
language plpgsql as $$
declare
  connection text := coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
    format('host=%L port=%s dbname=%L user=supabase_admin password=postgres',
      coalesce(host(inet_server_addr()), '127.0.0.1'), current_setting('port'), current_database()));
begin
  perform extensions.dblink_connect(p_name, connection);
  perform extensions.dblink_exec(p_name, format(
    'set application_name = %L; set statement_timeout = ''15s''; set request.jwt.claim.role = ''service_role''; set request.jwt.claim.sub = ''647a0000-0000-4000-8000-000000000001''',
    p_name
  ));
end;
$$;

create function pg_temp.op647_wait_for_blocker(p_waiting_name text, p_blocker_pid integer) returns boolean
language plpgsql as $$
declare
  deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists (
      select 1 from pg_stat_activity activity where activity.application_name = p_waiting_name
        and p_blocker_pid = any(pg_blocking_pids(activity.pid))
    ) then
      return true;
    end if;
    if clock_timestamp() >= deadline then return false; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;

-- JSON result avoids binding the fixture to prospective receipt field ordering.
create function pg_temp.op647_admission_sql(
  p_root uuid, p_workspace uuid, p_factory uuid, p_generation bigint, p_owner uuid,
  p_parent uuid, p_target_occurrence uuid, p_source_run uuid, p_title text
) returns text language sql as $$
  select format($query$
    select to_jsonb(admitted) from public.admit_factory_workflow_delegated_session(
      p_root_session_id => %L::uuid, p_workspace_id => %L::uuid, p_factory_id => %L::uuid,
      p_expected_generation => %L::bigint, p_ownership_token => %L::uuid,
      p_parent_session_id => %L::uuid, p_target_occurrence_id => %L::uuid,
      p_source_checkpoint_run_id => %L::uuid, p_title => %L, p_prompt_md => 'Verify the delegated outcome.'
    ) admitted
  $query$, p_root, p_workspace, p_factory, p_generation, p_owner, p_parent, p_target_occurrence, p_source_run, p_title);
$$;

create function pg_temp.op647_run_admission(p_statement text) returns jsonb
language plpgsql as $$
declare
  receipt jsonb;
begin
  execute p_statement into receipt;
  return receipt;
end;
$$;

-- Check both connections before making any fixture rows visible to other tests.
select pg_temp.op647_connect_contender('op647_first');
select pg_temp.op647_connect_contender('op647_second');

-- Exactly one delegated attempt remains after the root's source attempt.
create temp table op647_race_root as
select * from pg_temp.op647_enroll_root('Delegated admission race', pg_temp.op647_graph(2));
create temp table op647_requests as
select target.slot, pg_temp.op647_admission_sql(
  scope.root_session_id, scope.workspace_id, scope.factory_id, scope.execution_generation,
  scope.ownership_token, scope.root_session_id, target.occurrence_id, scope.input_run_id,
  'Delegated race contender ' || target.slot) as statement
from op647_race_root scope cross join lateral pg_temp.op647_targets(
  scope.root_session_id, scope.workspace_id, scope.factory_id, scope.execution_generation,
  scope.ownership_token, scope.entry_occurrence_id) target;
select is((select count(*) from op647_requests), 2::bigint, 'two independent targets are eligible before the race');
select ok((select (budget.attempts, budget.active_children) = (1, 0)
  from op647_race_root scope cross join lateral internal.factory_workflow_attempt_budget(
    scope.root_session_id, pg_temp.op647_graph(2)->'delegationPolicy') budget),
  'the exact adopted root attempt leaves capacity for one child');
commit;

begin;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '647a0000-0000-4000-8000-000000000001';
select extensions.dblink_exec('op647_first', 'begin');
create temp table op647_first_pid as
select r.pid from extensions.dblink('op647_first', 'select pg_backend_pid()') r(pid integer);
create temp table op647_winner as
select r.receipt from op647_requests request
cross join lateral extensions.dblink('op647_first', request.statement) r(receipt jsonb)
where request.slot = 'first';

select extensions.dblink_send_query('op647_second', statement) from op647_requests where slot = 'second';
select ok(pg_temp.op647_wait_for_blocker('op647_second', (select pid from op647_first_pid)),
  'the second admission waits for the exact transaction holding the root budget');
select extensions.dblink_exec('op647_first', 'commit');

create temp table op647_loser as
select r.receipt from extensions.dblink_get_result('op647_second', false) r(receipt jsonb);
select ok(extensions.dblink_error_message('op647_second') like '%The workflow root has no remaining child attempt capacity.%',
  'the distinct contender reaches the attempt cap rather than another admission guard');
select count(*) from extensions.dblink_get_result('op647_second', false) r(receipt jsonb);
select extensions.dblink_disconnect('op647_first');
select extensions.dblink_disconnect('op647_second');

select ok((select (receipt->>'created')::boolean and receipt->>'child_session_id' is not null from op647_winner),
  'the first admission creates a child under the root cap');
select is((select count(*) from op647_loser where receipt->>'child_session_id' is not null), 0::bigint,
  'a distinct concurrent admission cannot overspend the final attempt');
select is((select count(*) from internal.factory_workflow_attempt_reservations reservation
  join op647_race_root scope using (root_session_id)), 1::bigint,
  'only the winning delegated admission leaves a reservation');
select ok((select marker.source_checkpoint_run_id = scope.input_run_id
  and marker.child_definition_revision_id = pg_temp.op647_id(41)
  and owner.definition_revision_id = pg_temp.op647_id(42)
  from op647_winner winner cross join op647_race_root scope
  join public.session_factory_admission_inputs owner on owner.session_id = scope.root_session_id
  join internal.factory_workflow_delegations marker on (marker.root_session_id, marker.child_session_id) =
    (scope.root_session_id, (winner.receipt->>'child_session_id')::uuid)),
  'the allocation retains the accepted checkpoint and historical scoped child profile');

select ok((select not (replay.receipt->>'created')::boolean
  and (replay.receipt->>'child_session_id', replay.receipt->>'job_id', replay.receipt->>'run_id') =
    (winner.receipt->>'child_session_id', winner.receipt->>'job_id', winner.receipt->>'run_id')
  from op647_winner winner cross join op647_requests request
  cross join lateral (select pg_temp.op647_run_admission(request.statement) as receipt) replay
  where request.slot = 'first'), 'exact child replay returns the prior allocation when no new capacity remains');
select throws_ok($$select pg_temp.op647_run_admission(replace(statement,
  'Delegated race contender first', 'Conflicting delegate intent')) from op647_requests where slot = 'first'$$,
  'PT409', 'The workflow occurrence was already delegated with different input.',
  'a conflicting intent cannot replace the exact child allocation');
select ok((select (budget.attempts, budget.active_children) = (2, 1)
  from op647_race_root scope cross join lateral internal.factory_workflow_attempt_budget(
    scope.root_session_id, pg_temp.op647_graph(2)->'delegationPolicy') budget),
  'the queued winner occupies exactly one attempt and one active child');

select is((pg_temp.op647_claim_only((receipt->>'job_id')::uuid, 1)).attempt_count, 1,
  'the winner has an exact claim without a started run')
from op647_winner;
select ok((select (winner.receipt->>'job_id')::uuid = any(canceled.job_ids)
  from op647_winner winner cross join op647_race_root scope
  cross join lateral public.cancel_session_job_attempts(
    (winner.receipt->>'child_session_id')::uuid, scope.workspace_id, 'Cancel before run start',
    (winner.receipt->>'run_id')::uuid) canceled),
  'an exact cancellation retires the unstarted child job');
select ok((select (budget.attempts, budget.active_children) = (1, 0)
  from op647_race_root scope cross join lateral internal.factory_workflow_attempt_budget(
    scope.root_session_id, pg_temp.op647_graph(2)->'delegationPolicy') budget),
  'pre-start cancellation returns the reserved attempt to the root');
select ok((select reservation.run_id is null from internal.factory_workflow_attempt_reservations reservation
  join op647_race_root scope using (root_session_id)),
  'the pre-start reservation stays unbound to a provider run');
create temp table op647_after_cancel as
select pg_temp.op647_run_admission(statement) as receipt from op647_requests where slot = 'second';
select ok((select (receipt->>'created')::boolean and receipt->>'child_session_id' is not null from op647_after_cancel),
  'the losing target can use the returned capacity once');
select ok((select (budget.attempts, budget.active_children) = (2, 1)
  from op647_race_root scope cross join lateral internal.factory_workflow_attempt_budget(
    scope.root_session_id, pg_temp.op647_graph(2)->'delegationPolicy') budget),
  'the second admission uses the returned slot without erasing the retired identity');
create function pg_temp.op647_claim_and_start(p_job uuid, p_expected_attempt integer) returns uuid
language plpgsql as $$
declare
  claimed public.agent_jobs;
  owner public.sessions;
  started uuid;
begin
  claimed := pg_temp.op647_claim_only(p_job, p_expected_attempt);
  select * into strict owner from public.sessions where id = claimed.session_id;
  started := public.start_session_job_attempt(claimed.id, claimed.attempt_count,
    owner.current_stage_id, owner.current_artifact_version,
    'codex', 'gpt-5.5', 'code', 'wallie/op647-child-' || claimed.id::text || '-' || claimed.attempt_count);
  if started is null then raise exception 'Fixture attempt did not start.'; end if;
  return started;
end;
$$;

create temp table op647_rejected_root as
select * from pg_temp.op647_enroll_root('Delegation root in review', pg_temp.op647_graph(4), p_approve => false);
create temp table op647_rejected_targets as
select target.slot, pg_temp.op647_admission_sql(
  scope.root_session_id, scope.workspace_id, scope.factory_id, scope.execution_generation,
  scope.ownership_token, scope.root_session_id, target.occurrence_id, scope.input_run_id,
  'Rejected root child ' || target.slot) as statement
from op647_rejected_root scope cross join lateral pg_temp.op647_targets(
  scope.root_session_id, scope.workspace_id, scope.factory_id, scope.execution_generation,
  scope.ownership_token, scope.entry_occurrence_id) target;
create temp table op647_child_before_rejection as
select pg_temp.op647_run_admission(statement) as receipt from op647_rejected_targets where slot = 'first';
select is((pg_temp.op647_claim_only((receipt->>'job_id')::uuid, 1)).attempt_count, 1,
  'the child has an exact claim before review rejects the root')
from op647_child_before_rejection;

create temp table op647_root_repair as
select repair.* from op647_rejected_root scope
join public.sessions owner on owner.id = scope.root_session_id
cross join lateral public.reject_session_stage(owner.id, owner.workspace_id, owner.current_artifact_version,
  'Repair the source under review.', 'codex', 'gpt-5.5', owner.current_stage_id, owner.current_artifact_id,
  'code', pg_temp.op647_id(21)) repair;
select ok((select phase_status = 'rejected' and job_created and run_id is not null from op647_root_repair),
  'rejecting the reviewed checkpoint queues the canonical root repair');
select throws_ok($$select pg_temp.op647_run_admission(statement) from op647_rejected_targets where slot = 'second'$$,
  'PT409', 'The root or parent is unavailable for delegation.', 'a rejected root cannot admit another child');
select is(public.start_session_job_attempt((admitted.receipt->>'job_id')::uuid, 1,
  owner.current_stage_id, owner.current_artifact_version, 'codex', 'gpt-5.5', 'code', 'wallie/op647-rejected-child'),
  null::uuid, 'a rejected root prevents an already claimed child from starting')
from op647_child_before_rejection admitted
join public.sessions owner on owner.id = (admitted.receipt->>'child_session_id')::uuid;

update public.agent_jobs job set scheduled_at = null, created_at = '1900-01-01T00:00:00Z'
from op647_root_repair repair where job.id = repair.job_id;
create temp table op647_root_repair_claim as select id, attempt_count from public.claim_next_agent_job(false, 1000, 'node');
select is((select claim.id from op647_root_repair_claim claim where claim.attempt_count = 1),
  (select job_id from op647_root_repair), 'the worker claims the rejected root canonical repair');
-- Supply an exact claim only if the claim regression failed, so the start guard is independently tested.
update public.agent_jobs job set status = 'running', attempt_count = 1, claimed_worker_runtime = 'node',
  git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
from op647_root_repair repair where job.id = repair.job_id and job.status = 'queued';
select is(public.start_session_job_attempt(job_id, 1, current_stage_id, current_artifact_version,
  'codex', 'gpt-5.5', 'code', 'wallie/op647-root-repair'), run_id,
  'the worker starts the canonical repair and reuses its queued run') from op647_root_repair;
select canceled.job_ids from op647_child_before_rejection admitted cross join op647_rejected_root scope
cross join lateral public.cancel_session_job_attempts(
  (admitted.receipt->>'child_session_id')::uuid, scope.workspace_id, 'Retire the rejected root child claim',
  (admitted.receipt->>'run_id')::uuid) canceled;
select canceled.job_ids from op647_root_repair repair cross join lateral public.cancel_session_job_attempts(
  repair.session_id, repair.workspace_id, 'Retire the verified root repair', repair.run_id) canceled;

create temp table op647_usage_roots as
select scenario.prior, scope.*
from (values ('estimated'), ('unavailable')) scenario(prior)
cross join lateral pg_temp.op647_enroll_root('Delegated late ' || scenario.prior, pg_temp.op647_graph(3),
  case when scenario.prior = 'estimated' then repeat('b', 40) else repeat('a', 40) end) scope;
create temp table op647_usage_children as
select scope.*,
  (admission.receipt->>'child_session_id')::uuid as child_session_id,
  (admission.receipt->>'job_id')::uuid as job_id
from op647_usage_roots scope
cross join lateral pg_temp.op647_targets(scope.root_session_id, scope.workspace_id, scope.factory_id,
  scope.execution_generation, scope.ownership_token, scope.entry_occurrence_id) target
cross join lateral (select pg_temp.op647_run_admission(pg_temp.op647_admission_sql(
  scope.root_session_id, scope.workspace_id, scope.factory_id, scope.execution_generation,
  scope.ownership_token, scope.root_session_id, target.occurrence_id, scope.input_run_id, 'Delegated worker'
)) as receipt where target.slot = 'first') admission;
select is((select count(*) from op647_usage_children where child_session_id is not null and job_id is not null),
  2::bigint, 'both accounting cohorts admit a delegated job');

create temp table op647_previous_runs as
select child.*, pg_temp.op647_claim_and_start(child.job_id, 1) as old_run_id
from op647_usage_children child;
select ok((select (input.repository_id, input.source_checkpoint_run_id, input.input_sha, input.input_ref,
    input.pinned_run_id, input.pinned_attempt_count) =
  (pg_temp.op647_id(34), run.input_run_id, repeat('b', 40), publication.remote_verified_ref, run.old_run_id, 1)
  from op647_previous_runs run
  join public.session_checkpoint_publications publication on publication.run_id = run.input_run_id
  cross join lateral public.pin_session_job_git_input(
    run.job_id, 1, run.old_run_id, pg_temp.op647_id(34), 'main', repeat('b', 40)) input
  where run.prior = 'estimated'), 'the first child attempt pins the verified parent checkpoint ref');
select ok((select accepted from op647_previous_runs run
  cross join lateral public.record_session_run_usage(
    run.job_id, 1, run.old_run_id, 10, 15, 'estimated', 0.25, 'estimated', 'fixture-estimator-v1', false)
  where run.prior = 'estimated'), 'the first worker reports an estimate before retirement');

select is(public.fail_session_job_attempt(job_id, 1, 'Retire old attempt', true, 3, old_run_id), 'queued',
  'retirement queues a new attempt for ' || prior)
from op647_previous_runs;
create temp table op647_current_runs as
select prior.*, pg_temp.op647_claim_and_start(prior.job_id, 2) as new_run_id
from op647_previous_runs prior;
select is((select count(*) from op647_current_runs where old_run_id <> new_run_id), 2::bigint,
  'each claimed replacement has a new exact run ID');
select throws_ok($$select input.input_sha from op647_current_runs run
  cross join lateral public.pin_session_job_git_input(
    run.job_id, 2, run.new_run_id, pg_temp.op647_id(34), 'main', repeat('a', 40)) input where run.prior = 'estimated'$$,
  '23514', 'Observed Git input does not match the selected checkpoint.',
  'a replacement attempt cannot substitute the default branch base for the frozen parent checkpoint');
select ok((select (input.source_checkpoint_run_id, input.input_sha, input.input_ref, input.pinned_run_id, input.pinned_attempt_count) =
  (run.input_run_id, repeat('b', 40), publication.remote_verified_ref, run.old_run_id, 1)
  from op647_current_runs run
  join public.session_checkpoint_publications publication on publication.run_id = run.input_run_id
  cross join lateral public.pin_session_job_git_input(
    run.job_id, 2, run.new_run_id, pg_temp.op647_id(34), 'main', repeat('b', 40)) input
  where run.prior = 'estimated'), 'the replacement claim uses the exact inherited checkpoint and original pin');
select is((select count(*) from op647_current_runs run
  cross join lateral public.pin_session_job_git_input(
    run.job_id, 1, run.old_run_id, pg_temp.op647_id(34), 'main', repeat('b', 40)) input where run.prior = 'estimated'),
  0::bigint, 'the retired claim cannot read the inherited worker pin through the attempt RPC');

create temp table op647_budget_before as
select run.prior, run.root_session_id, budget.*
from op647_current_runs run cross join lateral internal.factory_workflow_attempt_budget(
  run.root_session_id, pg_temp.op647_graph(3)->'delegationPolicy') budget;
create temp table op647_replacement_usage_before as
select reservation.root_session_id, reservation.job_id, reservation.attempt_count, reservation.run_id,
  reservation.reported_tokens, reservation.reported_cost_usd, reservation.token_provenance, reservation.cost_provenance
from op647_current_runs run join internal.factory_workflow_attempt_reservations reservation
  on (reservation.root_session_id, reservation.job_id, reservation.attempt_count, reservation.run_id) =
    (run.root_session_id, run.job_id, 2, run.new_run_id);
select ok((select attempts = 3 and active_children = 1 from op647_budget_before where prior = 'estimated'),
  'a terminal old attempt and active replacement both count alongside the root');
select is((select unavailable.tokens - estimated.tokens from op647_budget_before unavailable
  cross join op647_budget_before estimated where unavailable.prior = 'unavailable' and estimated.prior = 'estimated'),
  15::numeric, 'unknown usage retains a finite 40-token debit while the other root records 25 estimated tokens');
select is((select unavailable.spend_usd - estimated.spend_usd from op647_budget_before unavailable
  cross join op647_budget_before estimated where unavailable.prior = 'unavailable' and estimated.prior = 'estimated'),
  0.15::numeric, 'unknown cost retains a finite $0.40 debit alongside the estimated $0.25 case');

-- This run deliberately comes from a genuinely different tenant.
insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
select pg_temp.op647_id(85), workspace_id, id, 'Foreign accounting pipeline', true
from public.factories where workspace_id = pg_temp.op647_id(12) and is_default;
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name)
values (pg_temp.op647_id(86), pg_temp.op647_id(85), pg_temp.op647_id(12), 1, 'foreign-plan', 'Foreign plan');
insert into public.sessions(id, workspace_id, factory_id, pipeline_id, current_stage_id, number,
  title, prompt_md, creator_member_id, phase_status)
select pg_temp.op647_id(82), workspace_id, factory_id, id, pg_temp.op647_id(86), 1,
  'Foreign accounting', 'Unrelated work', pg_temp.op647_id(22), 'rejected'
from public.pipelines where id = pg_temp.op647_id(85);
insert into public.agent_jobs(id, workspace_id, session_id, status, attempt_count, trigger_type, dedupe_key)
values (pg_temp.op647_id(83), pg_temp.op647_id(12), pg_temp.op647_id(82), 'error', 1, 'assignment', 'op647-foreign');
insert into public.agent_runs(id, workspace_id, session_id, agent_job_id, attempt_count,
  run_type, model_provider, model_name, status, started_at, finished_at)
values (pg_temp.op647_id(84), pg_temp.op647_id(12), pg_temp.op647_id(82), pg_temp.op647_id(83), 1,
  'project', 'codex', 'gpt-5.5', 'error', now(), now());

select ok(not observation.accepted, 'a foreign-tenant run ID cannot update the ' || run.prior || ' child')
from op647_current_runs run cross join lateral public.record_session_run_usage(
  run.job_id, 1, pg_temp.op647_id(84), 3, 5, 'measured', 0.08, 'measured', null, true) observation;
select ok(not observation.accepted, 'the old run cannot be charged to the new attempt for ' || run.prior)
from op647_current_runs run cross join lateral public.record_session_run_usage(
  run.job_id, 2, run.old_run_id, 3, 5, 'measured', 0.08, 'measured', null, true) observation;
select ok((select bool_and((before.attempts, before.tokens, before.spend_usd, before.active_children) =
  (budget.attempts, budget.tokens, budget.spend_usd, budget.active_children)) from op647_budget_before before
  cross join lateral internal.factory_workflow_attempt_budget(
    before.root_session_id, pg_temp.op647_graph(3)->'delegationPolicy') budget),
  'wrong-tenant and wrong-attempt reports leave the complete budget unchanged');

-- The report reaches the exact prior attempt even though its ownership is stale.
select observation.accepted from op647_current_runs run cross join lateral public.record_session_run_usage(
  run.job_id, 1, run.old_run_id, 3, 5, 'measured', 0.08, 'measured', null, true) observation;
select observation.accepted from op647_current_runs run cross join lateral public.record_session_run_usage(
  run.job_id, 1, run.old_run_id, 3, 5, 'measured', 0.08, 'measured', null, true) observation;
select observation.accepted from op647_current_runs run cross join lateral public.record_session_run_usage(
  run.job_id, 1, run.old_run_id, 80, 15, 'estimated', 0.95, 'estimated', 'fixture-estimator-v1', true) observation;

select ok((select bool_and((before.attempts, before.active_children) = (budget.attempts, budget.active_children)
  and budget.tokens = before.tokens - case when before.prior = 'estimated' then 17 else 32 end
  and budget.spend_usd = before.spend_usd - case when before.prior = 'estimated' then 0.17 else 0.32 end)
  from op647_budget_before before
  cross join lateral internal.factory_workflow_attempt_budget(
    before.root_session_id, pg_temp.op647_graph(3)->'delegationPolicy') budget),
  'a duplicate late report replaces each old debit exactly once and a later estimate cannot downgrade it');
select ok((select bool_and(
  (reservation.reported_tokens, reservation.reported_cost_usd, reservation.token_provenance, reservation.cost_provenance) =
  (8::bigint, 0.08::numeric, 'measured'::text, 'measured'::text))
  from internal.factory_workflow_attempt_reservations reservation join op647_current_runs run
  on (reservation.root_session_id, reservation.job_id, reservation.attempt_count, reservation.run_id) =
    (run.root_session_id, run.job_id, 1, run.old_run_id)),
  'only the exact historical reservation has the measured value');
select is((select count(*) from op647_replacement_usage_before prior
  join internal.factory_workflow_attempt_reservations current
    using (root_session_id, job_id, attempt_count, run_id)
  where (current.reported_tokens, current.reported_cost_usd, current.token_provenance, current.cost_provenance)
    is not distinct from (prior.reported_tokens, prior.reported_cost_usd, prior.token_provenance, prior.cost_provenance)),
  2::bigint, 'the exact replacement reservations preserve their previous usage and provenance');
select ok((select bool_and(job.attempt_count = 2 and current_run.status = 'running' and retired_run.status = 'error')
  from op647_current_runs run join public.agent_jobs job on job.id = run.job_id
  join public.agent_runs current_run on current_run.id = run.new_run_id
  join public.agent_runs retired_run on retired_run.id = run.old_run_id),
  'late accounting leaves ownership and lifecycle states untouched');

select ok(public.prepare_session_source_and_checkpoint_publication(
  run.new_run_id, pg_temp.op647_id(34), 'main', repeat('b', 40), repeat('d', 40),
  'Delegated output', 'Private delegated fixture checkpoint', '',
  encode(sha256(convert_to('OP647 private child bundle', 'UTF8')), 'hex'),
  encode(convert_to('OP647 private child bundle', 'UTF8'), 'base64'), 0, 'Private delegated output.'),
  'the current child attempt can prepare a private source checkpoint')
from op647_current_runs run where run.prior = 'estimated';
create temp table op647_private_checkpoint as
select run.child_session_id, run.workspace_id, run.factory_id, run.root_session_id, run.input_run_id, run.new_run_id,
  run.execution_generation, run.ownership_token, marker.target_occurrence_id, publication.retained_ref,
  public.claim_session_checkpoint_publication(run.new_run_id) as claim_id
from op647_current_runs run
join public.session_checkpoint_publications publication on publication.run_id = run.new_run_id
join internal.factory_workflow_delegations marker on marker.child_session_id = run.child_session_id
where run.prior = 'estimated';
select throws_ok($$select public.adopt_session_checkpoint_publication(
  child.new_run_id, child.claim_id, 'refs/heads/main', repeat('d', 40)) from op647_private_checkpoint child$$,
  '23514', 'Exact retained remote checkpoint proof is required.',
  'a public branch ref cannot substitute for the private child checkpoint');
select ok(public.adopt_session_checkpoint_publication(child.new_run_id, child.claim_id, child.retained_ref, repeat('d', 40)),
  'the delegated writer can adopt its verified private ref')
from op647_private_checkpoint child;
select ok((select publication.status = 'adopted'
  and (publication.remote_verified_ref, publication.remote_verified_sha) = (child.retained_ref, repeat('d', 40))
  and (child_head.checkpoint_run_id, root_head.checkpoint_run_id) = (child.new_run_id, child.input_run_id)
  from op647_private_checkpoint child
  join public.session_checkpoint_publications publication on publication.run_id = child.new_run_id
  join public.session_git_heads child_head on child_head.session_id = child.child_session_id
  join public.session_git_heads root_head on root_head.session_id = child.root_session_id),
  'private adoption advances only the child head');
select ok((select not exists (select 1 from public.session_pr_sync sync where sync.session_id = child.child_session_id)
  and exists (select 1 from public.session_pr_sync sync
    where (sync.session_id, sync.desired_checkpoint_run_id) = (child.root_session_id, child.input_run_id))
  from op647_private_checkpoint child), 'only the parent retains its canonical PR sync target');
select is(public.claim_session_pr_sync(child_session_id), null::uuid, 'canonical PR sync cannot claim the delegated child')
from op647_private_checkpoint;
select is((select internal.source_delivery_is_eligible(delivery)
  from op647_private_checkpoint child
  join public.session_source_deliveries delivery on delivery.run_id = child.new_run_id),
  false, 'the adopted child cannot publish via legacy source delivery');
select throws_ok($$select public.record_session_pull_request(child_session_id, workspace_id, pg_temp.op647_id(34),
  'wallie/op647-child-pr', 647, 'https://github.test/fixture/workflow-proof/pull/647', 'open', false, clock_timestamp())
  from op647_private_checkpoint$$, '42501', 'A delegated child cannot publish or link a pull request.',
  'the legacy link RPC refuses a direct PR link for the child');
select throws_ok($$insert into public.session_pull_requests(session_id, workspace_id, branch_name, pull_request_url)
  select child_session_id, pg_temp.op647_id(12), 'wallie/op647-child-wrong-tenant',
    'https://github.test/fixture/workflow-proof/pull/648' from op647_private_checkpoint$$,
  '42501', 'A delegated child cannot publish or link a pull request.',
  'a direct PR insert cannot evade the child publisher guard by supplying another workspace');

select is((select count(*) from op647_private_checkpoint child
  cross join lateral public.record_factory_workflow_delegated_result(child.root_session_id, child.workspace_id,
    child.factory_id, child.execution_generation, child.ownership_token, child.target_occurrence_id)),
  0::bigint, 'a verified private checkpoint alone leaves the delegated occurrence pending');
select is((select approved.id from public.approve_session_stage(owner.id, owner.workspace_id, owner.current_stage_id,
    owner.current_artifact_id, owner.current_artifact_version,
    pg_temp.op647_id(21), 'codex', 'gpt-5.5', 'code', owner.artifact_review_revision) approved),
  child.child_session_id, 'the reviewer approves the exact artifact from the delegated retry')
from op647_private_checkpoint child join public.sessions owner on owner.id = child.child_session_id;

create temp table op647_child_result as
select child.*, receipt.result_id, receipt.created
from op647_private_checkpoint child
cross join lateral public.record_factory_workflow_delegated_result(child.root_session_id, child.workspace_id,
  child.factory_id, child.execution_generation, child.ownership_token, child.target_occurrence_id) receipt;
select ok((select child.created and result.outcome = 'succeeded'
    and result.evidence_ref = 'delegated-checkpoint:' || child.new_run_id::text
  from op647_child_result child join internal.factory_workflow_node_results result
    on (result.root_session_id, result.occurrence_id, result.result_id) =
      (child.root_session_id, child.target_occurrence_id, child.result_id)),
  'the guarded completion pins the approved retry checkpoint as the durable delegated result');
-- Simulate loss of live child approval after the result has been recorded.
update public.sessions owner set phase_status = 'awaiting_review'
from op647_child_result child where owner.id = child.child_session_id;
select ok((select not replay.created and replay.result_id = child.result_id from op647_child_result child
  cross join lateral public.record_factory_workflow_delegated_result(child.root_session_id, child.workspace_id,
    child.factory_id, child.execution_generation, child.ownership_token, child.target_occurrence_id) replay),
  'the exact recorded delegated result remains replayable when live approval is unavailable');
select is((select count(*) from op647_child_result child
  cross join lateral public.admit_factory_workflow_next(child.root_session_id, child.workspace_id, child.factory_id,
    child.execution_generation, child.ownership_token, child.target_occurrence_id, 'child.followup', child.result_id)),
  0::bigint, 'a recorded delegated result needs current approval proof to admit fresh work');
update public.sessions owner set phase_status = 'approved'
from op647_child_result child where owner.id = child.child_session_id;

create temp table op647_child_next as
select child.*, next.transition_id, next.target_occurrence_id as next_occurrence_id, next.created as next_created
from op647_child_result child
cross join lateral public.admit_factory_workflow_next(child.root_session_id, child.workspace_id, child.factory_id,
  child.execution_generation, child.ownership_token, child.target_occurrence_id, 'child.followup', child.result_id) next;
select ok((select child.next_created and occurrence.node_id = 'child.followup'
  from op647_child_next child join internal.factory_workflow_node_occurrences occurrence
    on (occurrence.root_session_id, occurrence.occurrence_id) = (child.root_session_id, child.next_occurrence_id)),
  'the approved delegated result admits the configured successor');
update public.sessions owner set phase_status = 'awaiting_review'
from op647_child_next child where owner.id = child.child_session_id;
select ok((select not replay.created and (replay.transition_id, replay.target_occurrence_id) =
    (child.transition_id, child.next_occurrence_id) from op647_child_next child
  cross join lateral public.admit_factory_workflow_next(child.root_session_id, child.workspace_id, child.factory_id,
    child.execution_generation, child.ownership_token, child.target_occurrence_id, 'child.followup', child.result_id) replay),
  'the exact delegated successor remains replayable when live approval is unavailable');
update public.sessions owner set phase_status = 'approved'
from op647_child_next child where owner.id = child.child_session_id;

select ok(not has_table_privilege(role.name, 'internal.factory_workflow_delegations', 'SELECT')
  and not has_table_privilege(role.name, 'internal.factory_workflow_attempt_reservations', 'SELECT')
  and not has_function_privilege(role.name, 'internal.delegated_workflow_git_input(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege(role.name, 'public.admit_factory_workflow_delegated_session(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,text,text)', 'EXECUTE')
  and not has_function_privilege(role.name, 'public.record_factory_workflow_delegated_result(uuid,uuid,uuid,bigint,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege(role.name, 'public.record_session_run_usage(uuid,integer,uuid,bigint,bigint,text,numeric,text,text,boolean)', 'EXECUTE'),
  role.name || ' cannot read private delegation data or invoke admission and accounting writes')
from (values ('anon'), ('authenticated')) role(name);
-- One older terminal child per root owns an unavailable debit. A second child
-- holds the remaining budget while queued in one case and claimed in the other.
create temp table op647_headroom_roots as
select fixture.phase, scope.*
from (values ('queued'), ('claimed')) fixture(phase)
cross join lateral pg_temp.op647_enroll_root('Late debit before ' || fixture.phase,
  jsonb_set(pg_temp.op647_graph(4), '{delegationPolicy,maxTotalTokens}', '125')) scope;
create temp table op647_headroom_targets as
select scope.*, target.slot, pg_temp.op647_admission_sql(
  scope.root_session_id, scope.workspace_id, scope.factory_id, scope.execution_generation,
  scope.ownership_token, scope.root_session_id, target.occurrence_id, scope.input_run_id,
  'Headroom child ' || target.slot) as statement
from op647_headroom_roots scope cross join lateral pg_temp.op647_targets(
  scope.root_session_id, scope.workspace_id, scope.factory_id,
  scope.execution_generation, scope.ownership_token, scope.entry_occurrence_id) target;

create temp table op647_headroom_previous as
select target.*, (admitted.receipt->>'job_id')::uuid as old_job_id,
  pg_temp.op647_claim_and_start((admitted.receipt->>'job_id')::uuid, 1) as old_run_id
from op647_headroom_targets target
cross join lateral (select pg_temp.op647_run_admission(target.statement) as receipt where target.slot = 'first') admitted;
select is(public.fail_session_job_attempt(old_job_id, 1, 'Retire the older child', false, 3, old_run_id), 'error',
  'the older started child is terminal before checking ' || phase || ' work')
from op647_headroom_previous;

create temp table op647_headroom_new as
select pending.phase, pending.root_session_id, (admitted.receipt->>'child_session_id')::uuid as child_session_id,
  (admitted.receipt->>'job_id')::uuid as job_id, (admitted.receipt->>'run_id')::uuid as run_id
from op647_headroom_targets pending
cross join lateral (select pg_temp.op647_run_admission(pending.statement) as receipt where pending.slot = 'second') admitted;
select is((select count(*) from op647_headroom_new where child_session_id is not null), 2::bigint,
  'both younger children are admitted with five tokens of root headroom');
select is((pg_temp.op647_claim_only(job_id, 1)).attempt_count, 1,
  'the second stage fixture claims the reserved job before the late report')
from op647_headroom_new where phase = 'claimed';

select ok((select bool_and(budget.tokens = 120 and budget.attempts = 3 and budget.active_children = 1)
  from op647_headroom_roots scope
  join internal.factory_workflow_executions execution using (root_session_id)
  cross join lateral internal.factory_workflow_attempt_budget(execution.root_session_id,
    execution.workflow_json::jsonb->'delegationPolicy') budget),
  'the queued and claimed holds each count against a 125-token budget before the late report');

select observation.accepted from op647_headroom_previous run cross join lateral public.record_session_run_usage(
  run.old_job_id, 1, run.old_run_id, 35, 20, 'measured', null, 'unavailable', null, true) observation;
select ok((select bool_and(budget.tokens = 135 and budget.attempts = 3 and budget.active_children = 1)
  from op647_headroom_roots scope
  join internal.factory_workflow_executions execution using (root_session_id)
  cross join lateral internal.factory_workflow_attempt_budget(execution.root_session_id,
    execution.workflow_json::jsonb->'delegationPolicy') budget),
  'the older exact late debit consumes the headroom without removing either open hold');

-- Put the blocked candidate first so the claim test cannot pass by claiming an
-- earlier unrelated row. The scanner may skip it and continue to other work.
update public.agent_jobs job set created_at = '1900-01-01T00:00:00Z'
from op647_headroom_new pending where job.id = pending.job_id and pending.phase = 'queued';
create temp table op647_late_headroom_claim as
select id from public.claim_next_agent_job(false, 1000, 'node');
select is((select count(*) from op647_late_headroom_claim claimed
  join op647_headroom_new pending on pending.job_id = claimed.id where pending.phase = 'queued'), 0::bigint,
  'claim rechecks a queued reservation after the late charge breaches the root cap');
select is(public.start_session_job_attempt(pending.job_id, 1, owner.current_stage_id, owner.current_artifact_version,
  'codex', 'gpt-5.5', 'code', 'wallie/op647-headroom-' || pending.job_id::text), null::uuid,
  'start rechecks a claimed reservation after the late charge breaches the root cap')
from op647_headroom_new pending join public.sessions owner on owner.id = pending.child_session_id
where pending.phase = 'claimed';
select is((select count(*) from op647_headroom_new pending
  join internal.factory_workflow_attempt_reservations reservation
    on (reservation.root_session_id, reservation.job_id, reservation.attempt_count) =
      (pending.root_session_id, pending.job_id, 1)
  join public.agent_jobs job on job.id = pending.job_id
  join public.agent_runs run on run.id = pending.run_id
  where reservation.run_id is null and run.started_at is null
    and ((pending.phase = 'queued' and job.status = 'queued' and job.attempt_count = 0)
      or (pending.phase = 'claimed' and job.status = 'running' and job.attempt_count = 1))),
  2::bigint, 'neither oversubscribed hold starts, binds a run, or increments the wrong claim');

select is((public.archive_factory(workspace_id, factory_id, pg_temp.op647_id(1), 'Retire the proof factory')).status,
  'archived', 'the factory is archived before the exact late provider report') from op647_scope;
create temp table op647_archived_attempt as
select prior.root_session_id, prior.old_job_id, prior.old_run_id, run.started_at, run.finished_at
from op647_headroom_previous prior join public.agent_runs run on run.id = prior.old_run_id where prior.phase = 'queued';
select lives_ok($$select report.accepted from op647_archived_attempt attempt
cross join lateral public.record_session_run_usage(attempt.old_job_id, 1, attempt.old_run_id,
  40, 25, 'measured', 0.25, 'measured', null, true) report$$,
  'exact late usage can be recorded after the factory is archived');
select ok((select (reservation.reported_tokens, reservation.reported_cost_usd,
    reservation.token_provenance, reservation.cost_provenance) = (65::bigint, 0.25::numeric, 'measured', 'measured')
  from op647_archived_attempt attempt join internal.factory_workflow_attempt_reservations reservation
    on (reservation.root_session_id, reservation.job_id, reservation.attempt_count, reservation.run_id) =
      (attempt.root_session_id, attempt.old_job_id, 1, attempt.old_run_id)),
  'the exact archived historical reservation reflects measured usage');
select ok((select run.status = 'error' and job.status = 'error' and job.attempt_count = 1
    and (run.started_at, run.finished_at) = (attempt.started_at, attempt.finished_at)
  from op647_archived_attempt attempt join public.agent_runs run on run.id = attempt.old_run_id
  join public.agent_jobs job on job.id = attempt.old_job_id),
  'the late measurement leaves the archived attempt retired');
select * from finish();
rollback;

begin;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '647a0000-0000-4000-8000-000000000001';
delete from public.workspaces where id in (pg_temp.op647_id(11), pg_temp.op647_id(12));
delete from auth.users where id in (pg_temp.op647_id(1), pg_temp.op647_id(2));
select public.set_git_continuity_release(false, current_revision.revision, 'Restore fixture release state')
from public.get_git_continuity_release_state() current_revision cross join op647_prior_release prior
where current_revision.enabled and not prior.enabled;
commit;
