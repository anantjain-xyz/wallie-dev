-- The service registers the exact bytes emitted by compileWorkflowGraph.
create table internal.factory_workflow_graph_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  definition_revision_id uuid not null,
  definition_digest text not null check (definition_digest collate "C" ~ '^[0-9a-f]{64}$'),
  workflow_json text not null check (workflow_json is json object with unique keys),
  workflow_digest text not null check (workflow_digest = encode(sha256(convert_to(workflow_json, 'UTF8')), 'hex')),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, definition_revision_id, workflow_digest),
  unique (workspace_id, factory_id, definition_revision_id, definition_digest, id, workflow_digest),
  foreign key (workspace_id, factory_id, definition_revision_id)
    references public.factory_definition_revisions(workspace_id, factory_id, id) on delete cascade
);
alter table internal.factory_workflow_graph_revisions enable row level security;
revoke all on table internal.factory_workflow_graph_revisions from public, anon, authenticated, service_role;
create trigger preserve_factory_workflow_graph_revisions before update or delete
  on internal.factory_workflow_graph_revisions for each row execute function internal.preserve_factory_definition_history();

alter table internal.factory_workflow_executions
  add column graph_revision_id uuid,
  -- Keep the observed identity after the source run or its retained evidence is erased.
  add column graph_input_run_id uuid,
  add constraint factory_workflow_executions_graph_input_check check (
    graph_revision_id is not null or graph_input_run_id is null
  ),
  add constraint factory_workflow_executions_graph_kind_check check (
    (workflow_json::jsonb->>'kind') is not distinct from
      case when graph_revision_id is null then 'serial' else 'graph' end
  ),
  add constraint factory_workflow_executions_graph_revision_fk
    foreign key (workspace_id, factory_id, definition_revision_id, definition_digest, graph_revision_id, workflow_digest)
    references internal.factory_workflow_graph_revisions(workspace_id, factory_id, definition_revision_id, definition_digest,
      id, workflow_digest);
create index factory_workflow_executions_graph_revision_idx
  on internal.factory_workflow_executions(graph_revision_id) where graph_revision_id is not null;

create function public.register_factory_workflow_graph_revision(
  p_workspace_id uuid, p_factory_id uuid, p_definition_revision_id uuid, p_definition_digest text,
  p_workflow_json text, p_workflow_digest text
) returns table (graph_revision_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  plan jsonb;
  registered internal.factory_workflow_graph_revisions;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  perform 1 from public.factory_definition_revisions definition
   where (definition.workspace_id, definition.factory_id, definition.id, definition.canonical_digest) =
     (p_workspace_id, p_factory_id, p_definition_revision_id, p_definition_digest);
  if not found then
    raise exception 'The graph base definition revision is unavailable.' using errcode = 'PT404';
  end if;

  if p_workflow_json is null or p_workflow_json is not json object with unique keys
    or p_workflow_digest is distinct from encode(sha256(convert_to(p_workflow_json, 'UTF8')), 'hex') then
    raise exception 'A verified compiled workflow graph is required.' using errcode = '22023';
  end if;
  plan := p_workflow_json::jsonb;
  if plan->>'kind' is distinct from 'graph' or plan->'schemaVersion' is distinct from '1'::jsonb
    or jsonb_typeof(plan->'nodes') is distinct from 'array'
    or jsonb_typeof(plan->'edges') is distinct from 'array'
    or jsonb_typeof(plan->'grants') is distinct from 'array' then
    raise exception 'A verified compiled workflow graph is required.' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_array_elements(plan->'nodes') node where node->>'id' = plan->>'entryNodeId') <> 1 then
    raise exception 'The graph must have one entry node.' using errcode = '22023';
  end if;

  insert into internal.factory_workflow_graph_revisions as revision (
    workspace_id, factory_id, definition_revision_id, definition_digest, workflow_json, workflow_digest
  ) values (p_workspace_id, p_factory_id, p_definition_revision_id, p_definition_digest, p_workflow_json, p_workflow_digest)
  on conflict (workspace_id, factory_id, definition_revision_id, workflow_digest) do nothing
  returning revision.* into registered;
  if found then
    return query select registered.id, true;
    return;
  end if;

  select revision.* into strict registered from internal.factory_workflow_graph_revisions revision
   where (revision.workspace_id, revision.factory_id, revision.definition_revision_id, revision.workflow_digest) =
     (p_workspace_id, p_factory_id, p_definition_revision_id, p_workflow_digest);
  if registered.workflow_json is distinct from p_workflow_json then
    raise exception 'The graph digest already identifies a different revision.' using errcode = 'PT409';
  end if;
  return query select registered.id, false;
end;
$$;

-- The current executor supports one forward path. Other edge kinds need their own execution bounds.
create function internal.is_bounded_factory_workflow_next_path(p_plan jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  node_count integer;
  edge_count integer;
begin
  if jsonb_typeof(p_plan->'nodes') is distinct from 'array'
    or jsonb_typeof(p_plan->'edges') is distinct from 'array'
    or jsonb_typeof(p_plan->'entryNodeId') is distinct from 'string' then
    return false;
  end if;
  node_count := jsonb_array_length(p_plan->'nodes');
  edge_count := jsonb_array_length(p_plan->'edges');
  if node_count not between 1 and 128 or edge_count <> node_count - 1 then
    return false;
  end if;

  return (
    with recursive nodes as materialized (
      select node->>'id' as id, (jsonb_typeof(node->'id') is not distinct from 'string') as has_string_id
      from jsonb_array_elements(p_plan->'nodes') node
    ), edges as materialized (
      select edge->>'id' as id, edge->>'from' as source_id, edge->>'to' as target_id,
        (jsonb_typeof(edge->'id') is not distinct from 'string')
          and (jsonb_typeof(edge->'from') is not distinct from 'string')
          and (jsonb_typeof(edge->'to') is not distinct from 'string')
          and (edge->>'kind' is not distinct from 'next') as is_next
      from jsonb_array_elements(p_plan->'edges') edge
    ), reachable(id) as (
      select id from nodes where id = p_plan->>'entryNodeId'
      union
      select edge.target_id from reachable join edges edge on edge.source_id = reachable.id
    )
    -- With one reachable entry, N-1 edges, and at most one successor per node,
    -- visiting all N distinct nodes proves the path terminates without cycling.
    select (select count(distinct id) = node_count and bool_and(has_string_id
        and char_length(id) <= 96 and id collate "C" ~ '^[a-z0-9]+([.-][a-z0-9]+)*$') from nodes)
      and (select count(distinct id) = edge_count and count(distinct source_id) = edge_count
        and coalesce(bool_and(is_next and char_length(id) <= 96
          and id collate "C" ~ '^[a-z0-9]+([.-][a-z0-9]+)*$'), true) from edges)
      and (select count(*) = edge_count from edges edge
        join nodes source_node on source_node.id = edge.source_id
        join nodes target_node on target_node.id = edge.target_id)
      and (select count(*) = node_count from reachable)
  ) is true;
end;
$$;
revoke all on function internal.is_bounded_factory_workflow_next_path(jsonb)
  from public, anon, authenticated, service_role;

create function public.start_factory_workflow_graph_execution(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_graph_revision_id uuid,
  p_input_run_id uuid default null
) returns table (execution_generation bigint, entry_occurrence_id uuid, created boolean, ownership_token uuid)
language plpgsql security definer set search_path = '' as $$
declare
  graph internal.factory_workflow_graph_revisions;
  execution internal.factory_workflow_executions;
  input_job_id uuid;
  input_attempt_count integer;
  plan jsonb;
  entry jsonb;
begin
  perform internal.lock_factory_workflow_root(p_root_session_id, p_workspace_id, p_factory_id);
  select revision.* into graph from internal.factory_workflow_graph_revisions revision
    join public.session_factory_admission_inputs pin
      on (pin.workspace_id, pin.factory_id, pin.definition_revision_id, pin.definition_digest) =
        (revision.workspace_id, revision.factory_id, revision.definition_revision_id, revision.definition_digest)
    join public.sessions session on session.id = pin.session_id
   where (revision.workspace_id, revision.factory_id, revision.id, pin.session_id) =
     (p_workspace_id, p_factory_id, p_graph_revision_id, p_root_session_id)
     and session.execute_pinned_definition
     and session.factory_definition_revision_id = pin.definition_revision_id;
  if not found then
    raise exception 'The graph revision must match an active session definition pin.' using errcode = 'PT409';
  end if;

  select workflow.* into execution from internal.factory_workflow_executions workflow
   where workflow.root_session_id = p_root_session_id;
  if found then
    if (execution.graph_revision_id, execution.graph_input_run_id) is distinct from (graph.id, p_input_run_id) then
      raise exception 'The root session already has a different workflow or input run.' using errcode = 'PT409';
    end if;
    return query select execution.generation, occurrence.occurrence_id, false, null::uuid
      from internal.factory_workflow_node_occurrences occurrence
     where occurrence.root_session_id = p_root_session_id and occurrence.is_entry;
    return;
  end if;

  if exists (select 1 from public.sessions session
    where session.id = p_root_session_id and session.archived_at is not null) then
    raise exception 'The graph revision must match an active session definition pin.' using errcode = 'PT409';
  end if;

  -- The deterministic executor handles validation, policy, checkpoint, and human gates over next edges.
  plan := graph.workflow_json::jsonb;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node
    where coalesce(node->>'kind', '') not in ('deterministic', 'human-gate')
      or (node->>'kind' = 'deterministic' and coalesce(node->>'operation', '') not in ('validation', 'policy', 'checkpoint'))) then
    raise exception 'The graph requires workflow capabilities that are unavailable.' using errcode = 'PT422';
  end if;
  if not internal.is_bounded_factory_workflow_next_path(plan) then
    raise exception 'The graph must form one next-only path with at most 128 nodes.' using errcode = 'PT422';
  end if;
  if p_input_run_id is null and exists (
    select 1 from jsonb_array_elements(plan->'nodes') node
    where node->>'kind' = 'human-gate' or node->>'operation' in ('validation', 'checkpoint')
  ) then
    raise exception 'The graph requires a scoped checkpoint input run.' using errcode = 'PT422';
  end if;
  select node into strict entry from jsonb_array_elements(plan->'nodes') node where node->>'id' = plan->>'entryNodeId';

  if p_input_run_id is not null then
    -- Follow the root, job, run, publication lock order used by checkpoint adoption.
    select job.id, job.attempt_count into input_job_id, input_attempt_count
    from public.agent_jobs job
    join public.agent_runs run on (run.agent_job_id, run.session_id, run.workspace_id) =
      (job.id, job.session_id, job.workspace_id)
    where run.id = p_input_run_id and (job.session_id, job.workspace_id) = (p_root_session_id, p_workspace_id)
      and job.attempt_count > 0
    for share of job;

    perform 1 from public.agent_runs run
    where (run.id, run.agent_job_id, run.session_id, run.workspace_id, run.attempt_count) =
      (p_input_run_id, input_job_id, p_root_session_id, p_workspace_id, input_attempt_count)
    for share;
    if found then
      perform 1 from public.session_checkpoint_publications publication
      where (publication.run_id, publication.job_id, publication.session_id, publication.workspace_id, publication.attempt_count) =
        (p_input_run_id, input_job_id, p_root_session_id, p_workspace_id, input_attempt_count)
      for key share;
    end if;
    if not found then
      raise exception 'The graph input run has no current scoped checkpoint publication intent.' using errcode = 'PT409';
    end if;
  end if;

  return query
    with enrolled as (
      insert into internal.factory_workflow_executions (
        root_session_id, workspace_id, factory_id, definition_revision_id, definition_digest,
        graph_revision_id, graph_input_run_id, workflow_json, workflow_digest
      ) values (p_root_session_id, p_workspace_id, p_factory_id, graph.definition_revision_id, graph.definition_digest,
        graph.id, p_input_run_id, graph.workflow_json, graph.workflow_digest)
      returning factory_workflow_executions.generation, factory_workflow_executions.ownership_token
    ), admitted as (
      insert into internal.factory_workflow_node_occurrences (
        root_session_id, node_id, node_kind, is_entry, admitted_generation
      ) select p_root_session_id, entry->>'id', (entry->>'kind')::internal.factory_workflow_node_kind, true, enrolled.generation
        from enrolled
      returning occurrence_id
    )
    select enrolled.generation, admitted.occurrence_id, true, enrolled.ownership_token from enrolled cross join admitted;
end;
$$;

create or replace function public.read_factory_workflow_execution(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'execution', jsonb_build_object(
      'root_session_id', execution.root_session_id,
      'workspace_id', execution.workspace_id,
      'factory_id', execution.factory_id,
      'definition_revision_id', execution.definition_revision_id,
      'definition_digest', execution.definition_digest,
      'workflow_json', execution.workflow_json,
      'workflow_digest', execution.workflow_digest,
      'generation', execution.generation,
      'created_at', execution.created_at
    ) || case when execution.graph_revision_id is null then '{}'::jsonb
      else jsonb_build_object('graph_revision_id', execution.graph_revision_id,
        'graph_input_run_id', execution.graph_input_run_id) end,
    'occurrences', coalesce((
      select jsonb_agg(to_jsonb(occurrence) order by occurrence.admitted_at, occurrence.occurrence_id)
        from internal.factory_workflow_node_occurrences occurrence where occurrence.root_session_id = execution.root_session_id
    ), '[]'::jsonb),
    'results', coalesce((
      select jsonb_agg(to_jsonb(result) order by result.recorded_at, result.result_id)
        from internal.factory_workflow_node_results result where result.root_session_id = execution.root_session_id
    ), '[]'::jsonb),
    'transitions', coalesce((
      select jsonb_agg(to_jsonb(transition) order by transition.recorded_at, transition.transition_id)
        from internal.factory_workflow_transition_receipts transition where transition.root_session_id = execution.root_session_id
    ), '[]'::jsonb),
    'runnableTransitions', coalesce((
      select jsonb_agg(jsonb_build_object('sourceOccurrenceId', occurrence.occurrence_id, 'sourceResultId', result.result_id, 'edgeId', edge->>'id')
        order by occurrence.admitted_at, occurrence.occurrence_id, edge->>'id')
        from internal.factory_workflow_node_occurrences occurrence
        join internal.factory_workflow_node_results result
          on (result.root_session_id, result.occurrence_id) = (occurrence.root_session_id, occurrence.occurrence_id)
        cross join lateral jsonb_array_elements(execution.workflow_json::jsonb->'edges') edge
       where occurrence.root_session_id = execution.root_session_id and result.outcome = 'succeeded'
         and workspace.deletion_requested_at is null and factory.status = 'active'
         and edge->>'kind' = 'next' and edge->>'from' = occurrence.node_id
         and not exists (
           select 1 from internal.factory_workflow_transition_receipts transition
            where (transition.root_session_id, transition.source_occurrence_id, transition.edge_id) =
              (occurrence.root_session_id, occurrence.occurrence_id, edge->>'id')
         )
    ), '[]'::jsonb)
  )
  from internal.factory_workflow_executions execution
  join public.workspaces workspace on workspace.id = execution.workspace_id
  join public.factories factory on (factory.workspace_id, factory.id) = (execution.workspace_id, execution.factory_id)
  where (execution.root_session_id, execution.workspace_id, execution.factory_id) =
    (p_root_session_id, p_workspace_id, p_factory_id);
$$;

revoke all on function public.register_factory_workflow_graph_revision(uuid, uuid, uuid, text, text, text),
  public.start_factory_workflow_graph_execution(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.register_factory_workflow_graph_revision(uuid, uuid, uuid, text, text, text),
  public.start_factory_workflow_graph_execution(uuid, uuid, uuid, uuid, uuid) to service_role;

-- The command kind comes from the root's frozen plan and admitted occurrence.
create function internal.factory_workflow_occurrence_command(
  p_execution internal.factory_workflow_executions, p_occurrence_id uuid
) returns jsonb language sql stable set search_path = '' as $$
  select node
  from internal.factory_workflow_node_occurrences occurrence
  cross join lateral jsonb_array_elements(p_execution.workflow_json::jsonb->'nodes') node
  where (occurrence.root_session_id, occurrence.occurrence_id) =
    (p_execution.root_session_id, p_occurrence_id)
    and node->>'id' = occurrence.node_id
    and node->>'kind' = occurrence.node_kind::text
  and occurrence.node_kind in ('deterministic', 'human-gate');
$$;
revoke all on function internal.factory_workflow_occurrence_command(internal.factory_workflow_executions, uuid)
  from public, anon, authenticated, service_role;

create function public.check_factory_workflow_execution_policy(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_occurrence_id uuid
) returns table (policy_revision_id uuid, exhaustion_code text)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  command jsonb;
  root_session public.sessions;
begin
  execution := internal.lock_factory_workflow_owner(
    p_root_session_id, p_workspace_id, p_factory_id, p_expected_generation, p_ownership_token
  );
  command := internal.factory_workflow_occurrence_command(execution, p_occurrence_id);
  if command->>'operation' is distinct from 'policy' then
    raise exception 'Workflow policy occurrence is unavailable.' using errcode = 'PT404';
  end if;

  select session.* into strict root_session from public.sessions session
   where (session.id, session.workspace_id, session.factory_id) =
     (p_root_session_id, p_workspace_id, p_factory_id);
  if root_session.execution_policy_revision_id is null then
    return query select null::uuid, null::text;
    return;
  end if;
  return query select root_session.execution_policy_revision_id,
    internal.refresh_session_execution_exhaustion(p_root_session_id, p_workspace_id);
end;
$$;
revoke all on function public.check_factory_workflow_execution_policy(uuid, uuid, uuid, bigint, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.check_factory_workflow_execution_policy(uuid, uuid, uuid, bigint, uuid, uuid)
  to service_role;

-- Depends on the OP-644 ledger, OP-645 graph enrollment columns, and
-- internal.factory_workflow_occurrence_command from op645-policy.sql.

-- The adopted checkpoint, run, job, source intent, artifact, and GitHub
-- installation must all identify the same exact pinned root attempt.
create function internal.factory_workflow_input_checkpoint(
  p_execution internal.factory_workflow_executions
) returns public.session_git_checkpoints
language plpgsql set search_path = '' as $$
declare
  accepted public.session_git_checkpoints;
begin
  select checkpoint.* into accepted
  from public.session_git_checkpoints checkpoint
  join public.session_factory_admission_inputs admission
    on (admission.session_id, admission.workspace_id, admission.factory_id, admission.github_repository_id) =
       (checkpoint.session_id, checkpoint.workspace_id, p_execution.factory_id, checkpoint.repository_id)
  join public.agent_runs run
    on (run.id, run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count) =
       (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.job_id, checkpoint.attempt_count)
  join public.agent_jobs job
    on (job.id, job.workspace_id, job.session_id, job.attempt_count, job.stage_id) =
       (checkpoint.job_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.attempt_count, run.stage_id)
  join public.session_job_git_inputs input
    on (input.job_id, input.workspace_id, input.session_id, input.repository_id, input.repository_full_name,
        input.initial_base_sha, input.input_sha) =
       (checkpoint.job_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.repository_id,
        checkpoint.repository_full_name, checkpoint.initial_base_sha, checkpoint.input_sha)
  join public.session_source_deliveries source
    on (source.run_id, source.workspace_id, source.session_id, source.job_id, source.attempt_count,
        source.repository_id, source.repository_full_name, source.base_branch, source.base_sha, source.head_sha,
        source.branch_name) =
       (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.job_id,
        checkpoint.attempt_count, checkpoint.repository_id, checkpoint.repository_full_name, input.base_branch,
        checkpoint.input_sha, checkpoint.output_sha, run.branch_name)
  join public.session_checkpoint_publications publication
    on (publication.run_id, publication.workspace_id, publication.session_id, publication.job_id,
        publication.attempt_count, publication.artifact_id) =
       (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.job_id,
        checkpoint.attempt_count, checkpoint.artifact_id)
  join public.session_artifacts artifact
    on (artifact.id, artifact.workspace_id, artifact.session_id, artifact.stage_id) =
       (checkpoint.artifact_id, checkpoint.workspace_id, checkpoint.session_id, run.stage_id)
  join public.github_repositories repository
    on (repository.id, repository.workspace_id, repository.factory_id) =
       (checkpoint.repository_id, checkpoint.workspace_id, p_execution.factory_id)
  join public.github_installations installation
    on (installation.id, installation.workspace_id, installation.installation_id) =
       (repository.github_installation_id, checkpoint.workspace_id, source.installation_id)
  where (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id) =
        (p_execution.graph_input_run_id, p_execution.workspace_id, p_execution.root_session_id)
    and (admission.definition_revision_id, admission.definition_digest) =
        (p_execution.definition_revision_id, p_execution.definition_digest)
    and run.status = 'success' and job.status = 'success'
    and publication.status = 'adopted' and publication.adopted_at is not null
    and internal.approved_predecessor_artifact_text(artifact.artifact_json) = publication.artifact_md
    and not repository.is_archived and not installation.suspended
    and case checkpoint.output_kind
      when 'code' then checkpoint.output_ref = publication.retained_ref
        and publication.remote_verified_ref = checkpoint.output_ref
        and publication.remote_verified_sha = checkpoint.output_sha
        and publication.remote_verified_at is not null
        and source.bundle_sha256 = checkpoint.bundle_sha256
      when 'no-code' then checkpoint.output_ref is null and publication.retained_ref is null
        and publication.remote_verified_ref is null and publication.remote_verified_sha is null
        and publication.remote_verified_at is null
      else false
    end
  for share of repository, installation nowait;
  return accepted;
exception when lock_not_available then
  -- Integration shutdown may already hold the provider row and wait for this session.
  return null;
end;
$$;

-- Asset bytes are verified outside the ledger transaction. Recheck the exact
-- immutable manifest and current withholding state before using the observation.
create function internal.factory_workflow_command_evidence_passes(
  p_plan public.session_validation_plans, p_key text
) returns boolean language sql stable set search_path = '' as $$
  select count(*) = 1 and coalesce(bool_and(
    receipt->>'provenance' = 'harness' and receipt->>'status' = 'passed' and receipt->'exitCode' = '0'::jsonb
    and receipt->>'commitSha' = p_plan.commit_sha and receipt->>'finalCommitSha' = p_plan.commit_sha
    and receipt->>'treeSha' = p_plan.validation_tree_sha and receipt->>'finalTreeSha' = p_plan.validation_tree_sha
    and receipt->'missingRequiredReports' = '[]'::jsonb
    and exists (select 1 from jsonb_array_elements(p_plan.plan->'commands') command
      where command->>'key' = p_key and command->>'command' = receipt->>'command')
    and not exists (
      select 1 from jsonb_array_elements_text(receipt->'reportKeys') required(key)
      where not exists (
        select 1 from jsonb_array_elements(evidence.assets) manifest
        join public.session_validation_assets asset
          on (asset.run_id, asset.workspace_id, asset.session_id, asset.id::text, asset.evidence_key) =
             (evidence.run_id, evidence.workspace_id, evidence.session_id, manifest->>'id', required.key)
        join storage.objects object on object.bucket_id = 'session-validation-evidence'
          and object.name = asset.storage_path and object.metadata->>'size' = asset.size_bytes::text
          and object.metadata->>'mimetype' = asset.content_type
        where manifest->>'key' = required.key and asset.required and asset.kind <> 'log'
          and manifest->'required' = 'true'::jsonb
          and (asset.storage_path, asset.sha256, asset.content_type, asset.size_bytes::text, asset.kind) =
            (manifest->>'storagePath', manifest->>'sha256', manifest->>'contentType', manifest->>'sizeBytes', manifest->>'kind')
          and not exists (select 1 from public.session_validation_asset_withholdings withheld where withheld.asset_id = asset.id)
      )
    )), false)
  from public.session_validation_evidence evidence
  cross join lateral jsonb_array_elements(evidence.records) receipt
  where (evidence.run_id, evidence.workspace_id, evidence.session_id, evidence.job_id, evidence.attempt_count,
         evidence.repository_id, evidence.commit_sha, evidence.validation_tree_sha) =
        (p_plan.run_id, p_plan.workspace_id, p_plan.session_id, p_plan.job_id, p_plan.attempt_count,
         p_plan.repository_id, p_plan.commit_sha, p_plan.validation_tree_sha)
    and receipt->>'key' = p_key;
$$;

create function internal.factory_workflow_browser_evidence_passes(
  p_plan public.session_validation_plans, p_key text
) returns boolean language sql stable set search_path = '' as $$
  select count(*) = 1 and coalesce(bool_and(
    receipt->>'status' = 'captured' and receipt->>'policy' = 'isolated-fixture-v1'
    and exists (
      select 1 from jsonb_array_elements(p_plan.plan->'browser') check_plan
      cross join lateral jsonb_array_elements(check_plan->'evidence') planned_evidence
      where check_plan->>'key' = receipt->>'key' and check_plan->>'path' = receipt->>'path'
        and planned_evidence->>'kind' = receipt->>'kind'
        and case when receipt->>'kind' = 'video' and receipt->>'status' = 'captured' then
          (receipt#>>'{manifest,durationMs}')::integer <= (check_plan->>'timeoutSeconds')::integer * 1000
          and jsonb_array_length(receipt#>'{manifest,frameOffsetsMs}') =
            jsonb_array_length(check_plan->'interactions') + 1
          and (receipt->>'completedAt')::timestamptz - (receipt->>'startedAt')::timestamptz
            between interval '0 seconds' and make_interval(secs => (check_plan->>'timeoutSeconds')::integer)
        else true end
    )
    and exists (
      select 1 from public.session_browser_verification_assets asset
      join storage.objects object on object.bucket_id = 'session-validation-evidence'
        and object.name = asset.storage_path and object.metadata->>'size' = asset.size_bytes::text
        and object.metadata->>'mimetype' = asset.content_type
      where (asset.run_id, asset.workspace_id, asset.session_id, asset.evidence_key, asset.id::text,
             asset.browser_session_id::text, asset.sha256, asset.content_type, asset.size_bytes::text) =
            (p_plan.run_id, p_plan.workspace_id, p_plan.session_id, p_key, receipt#>>'{manifest,assetId}',
             receipt->>'browserSessionId', receipt#>>'{manifest,sha256}', receipt#>>'{manifest,contentType}',
             receipt#>>'{manifest,sizeBytes}')
        and not exists (select 1 from public.session_browser_asset_withholdings withheld where withheld.asset_id = asset.id)
    )), false)
  from public.session_browser_verification_receipts browser
  cross join lateral jsonb_array_elements(browser.records) receipt
  where (browser.run_id, browser.workspace_id, browser.session_id) =
        (p_plan.run_id, p_plan.workspace_id, p_plan.session_id)
    and concat('browser:', receipt->>'kind', ':', receipt->>'key') = p_key;
$$;

create function internal.factory_workflow_validation_passes(
  p_root public.sessions, p_checkpoint public.session_git_checkpoints
) returns boolean language plpgsql stable set search_path = '' as $$
declare
  plan public.session_validation_plans;
  required_keys jsonb;
  evidence_key text;
begin
  select validation_plan.* into plan from public.session_validation_plans validation_plan
  where (validation_plan.run_id, validation_plan.workspace_id, validation_plan.session_id,
         validation_plan.job_id, validation_plan.attempt_count, validation_plan.repository_id, validation_plan.commit_sha) =
        (p_checkpoint.run_id, p_checkpoint.workspace_id, p_checkpoint.session_id, p_checkpoint.job_id,
         p_checkpoint.attempt_count, p_checkpoint.repository_id, p_checkpoint.output_sha);
  if not found then return false; end if;

  select policy.requirements->'requiredEvidence' into required_keys from public.delivery_policy_revisions policy
  where (policy.id, policy.workspace_id, policy.pipeline_id) =
        (p_root.pinned_delivery_policy_revision_id, p_root.workspace_id, p_root.pipeline_id);
  if jsonb_typeof(required_keys) is distinct from 'array' or jsonb_array_length(required_keys) = 0 then
    return false;
  end if;

  for evidence_key in select jsonb_array_elements_text(required_keys) loop
    if evidence_key collate "C" ~ '^browser:(screenshot|video):[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' then
      if not internal.factory_workflow_browser_evidence_passes(plan, evidence_key) then return false; end if;
    elsif not internal.factory_workflow_command_evidence_passes(plan, evidence_key) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- The legacy receipt proves the policy enforced by the pinned serial stage.
-- A graph gate can reuse that fact only with the same policy and artifact.
create function internal.factory_workflow_human_approval_passes(
  p_root public.sessions, p_checkpoint public.session_git_checkpoints, p_command jsonb, p_approval_id uuid
) returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.session_stage_approval_receipts approval
    join public.session_artifacts artifact
      on (artifact.id, artifact.workspace_id, artifact.session_id, artifact.stage_id, artifact.version) =
         (approval.artifact_id, approval.workspace_id, approval.session_id, approval.stage_id, approval.artifact_version)
    join lateral (
      select completion.id from public.session_phase_completions completion
      where (completion.session_id, completion.workspace_id, completion.stage_id) =
            (approval.session_id, approval.workspace_id, approval.stage_id)
      order by completion.completed_at desc, completion.id desc
      limit 1
    ) completion on completion.id = approval.completion_id
    cross join lateral jsonb_array_elements(internal.pinned_session_execution_definition(p_root)->'stages')
      with ordinality reviewed_stage(stage, position)
    cross join lateral jsonb_array_elements(internal.pinned_session_execution_definition(p_root)->'stages')
      with ordinality current_stage(stage, position)
    where (approval.id, approval.workspace_id, approval.session_id, approval.artifact_id) =
          (p_approval_id, p_root.workspace_id, p_root.id, p_checkpoint.artifact_id)
      and approval.artifact_digest = encode(sha256(convert_to(
        internal.approved_predecessor_artifact_text(artifact.artifact_json), 'UTF8')), 'hex')
      and reviewed_stage.stage->>'id' = approval.stage_id::text
      and current_stage.stage->>'id' = p_root.current_stage_id::text
      and (reviewed_stage.position < current_stage.position
        or (reviewed_stage.position = current_stage.position and p_root.phase_status = 'approved'
          and (p_root.current_artifact_id, p_root.current_artifact_version) = (artifact.id, artifact.version)))
      and reviewed_stage.stage->'anyoneCanApprove' = p_command->'anyoneCanApprove'
      and array(select distinct id from jsonb_array_elements_text(reviewed_stage.stage->'approverMemberIds') member(id) order by id) =
          array(select distinct id from jsonb_array_elements_text(p_command->'approverMemberIds') member(id) order by id)
      and exists (select 1 from public.session_selected_stages selection
        where (selection.session_id, selection.workspace_id, selection.stage_id) =
              (approval.session_id, approval.workspace_id, approval.stage_id))
      and not exists (select 1 from public.session_stage_approval_receipts newer
        where (newer.session_id, newer.workspace_id, newer.stage_id, newer.completion_id) =
              (approval.session_id, approval.workspace_id, approval.stage_id, approval.completion_id)
          and newer.approval_number > approval.approval_number)
      and not exists (select 1 from public.artifact_review_threads thread
        where (thread.session_id, thread.workspace_id) = (approval.session_id, approval.workspace_id)
          and thread.kind = 'blocking' and thread.status = 'open')
  );
$$;

-- The root and execution rows are locked by the caller. A reference chooses
-- which durable fact to verify; it cannot supply the verdict or its scope.
create function internal.factory_workflow_command_evidence_is_current(
  p_execution internal.factory_workflow_executions, p_command jsonb, p_evidence_ref text
) returns boolean language plpgsql set search_path = '' as $$
declare
  root_session public.sessions;
  checkpoint public.session_git_checkpoints;
  command_kind text := case when p_command->>'kind' = 'human-gate' then 'human-gate'
    when p_command->>'kind' = 'deterministic' then p_command->>'operation' end;
  evidence_id uuid;
begin
  if command_kind is null or p_evidence_ref is null
    or split_part(p_evidence_ref, ':', 1) <> command_kind
    or p_evidence_ref collate "C" !~ '^[a-z-]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  evidence_id := split_part(p_evidence_ref, ':', 2)::uuid;
  select root.* into strict root_session from public.sessions root
  where (root.id, root.workspace_id, root.factory_id, root.factory_definition_revision_id) =
        (p_execution.root_session_id, p_execution.workspace_id, p_execution.factory_id, p_execution.definition_revision_id)
    and root.execute_pinned_definition;
  if root_session.archived_at is not null and root_session.phase_status <> 'approved' then return false; end if;

  if command_kind = 'policy' then
    if root_session.execution_policy_revision_id is distinct from evidence_id or not exists (
      select 1 from public.execution_policy_revisions policy
      where (policy.id, policy.workspace_id) = (evidence_id, root_session.workspace_id)
    ) then return false; end if;
    return internal.refresh_session_execution_exhaustion(root_session.id, root_session.workspace_id) is null;
  end if;

  if command_kind in ('validation', 'checkpoint') and p_execution.graph_input_run_id is distinct from evidence_id then
    return false;
  end if;
  checkpoint := internal.factory_workflow_input_checkpoint(p_execution);
  if checkpoint.run_id is null then return false; end if;
  case command_kind
    when 'checkpoint' then return true;
    when 'validation' then return internal.factory_workflow_validation_passes(root_session, checkpoint);
    when 'human-gate' then
      return internal.factory_workflow_human_approval_passes(root_session, checkpoint, p_command, evidence_id);
    else return false;
  end case;
end;
$$;

-- Both public recorders use the same immutable-result insertion and replay
-- rules. The calling wrapper owns the root lock and the proof requirements.
create function internal.insert_factory_workflow_node_result(
  p_execution internal.factory_workflow_executions, p_occurrence_id uuid,
  p_outcome public.factory_workflow_node_outcome, p_evidence_ref text
) returns table (result_id uuid, created boolean)
language plpgsql set search_path = '' as $$
declare
  receipt internal.factory_workflow_node_results;
begin
  select result.* into receipt from internal.factory_workflow_node_results result
  where (result.root_session_id, result.occurrence_id) = (p_execution.root_session_id, p_occurrence_id);
  if found then
    if (receipt.outcome, receipt.evidence_ref) is distinct from (p_outcome, p_evidence_ref) then
      raise exception 'The workflow node already has a different result.' using errcode = 'PT409';
    end if;
    return query select receipt.result_id, false;
    return;
  end if;
  insert into internal.factory_workflow_node_results(root_session_id, occurrence_id, outcome, evidence_ref, recorded_generation)
  values (p_execution.root_session_id, p_occurrence_id, p_outcome, p_evidence_ref, p_execution.generation)
  returning * into receipt;
  return query select receipt.result_id, true;
end;
$$;

create or replace function public.record_factory_workflow_node_result(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_occurrence_id uuid, p_outcome public.factory_workflow_node_outcome,
  p_evidence_ref text default null
) returns table (result_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  node_kind internal.factory_workflow_node_kind;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select occurrence.node_kind into node_kind from internal.factory_workflow_node_occurrences occurrence
  where (occurrence.root_session_id, occurrence.occurrence_id) = (p_root_session_id, p_occurrence_id);
  if not found then raise exception 'Workflow node occurrence is unavailable.' using errcode = 'PT404'; end if;
  if execution.graph_revision_id is not null and node_kind in ('deterministic', 'human-gate') then
    raise exception 'This workflow node requires a guarded command result.' using errcode = '42501';
  end if;
  return query select * from internal.insert_factory_workflow_node_result(execution, p_occurrence_id, p_outcome, p_evidence_ref);
end;
$$;

create function public.record_factory_workflow_command_result(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_occurrence_id uuid, p_evidence_ref text
) returns table (result_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  command jsonb;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  if execution.graph_revision_id is null then return; end if;
  command := internal.factory_workflow_occurrence_command(execution, p_occurrence_id);
  if command is null then return; end if;
  if not exists (select 1 from internal.factory_workflow_node_results result
      where (result.root_session_id, result.occurrence_id) = (p_root_session_id, p_occurrence_id))
    and not internal.factory_workflow_command_evidence_is_current(execution, command, p_evidence_ref) then
    return;
  end if;
  return query select * from internal.insert_factory_workflow_node_result(execution, p_occurrence_id, 'succeeded', p_evidence_ref);
end;
$$;

create or replace function public.admit_factory_workflow_next(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_source_occurrence_id uuid, p_edge_id text, p_expected_result_id uuid
) returns table (transition_id uuid, target_occurrence_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  source_node_id text;
  source_node_kind internal.factory_workflow_node_kind;
  evidence_ref text;
  command jsonb;
  target_node jsonb;
  edge jsonb;
  target_id uuid;
  receipt internal.factory_workflow_transition_receipts;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select occurrence.node_id, occurrence.node_kind, result.evidence_ref
    into source_node_id, source_node_kind, evidence_ref
    from internal.factory_workflow_node_occurrences occurrence
    join internal.factory_workflow_node_results result
      on (result.root_session_id, result.occurrence_id) = (occurrence.root_session_id, occurrence.occurrence_id)
   where (occurrence.root_session_id, occurrence.occurrence_id, result.result_id) =
     (p_root_session_id, p_source_occurrence_id, p_expected_result_id)
     and result.outcome = 'succeeded';
  if not found then
    raise exception 'The expected successful predecessor result is unavailable.' using errcode = 'PT409';
  end if;

  select candidate into edge
    from jsonb_array_elements(execution.workflow_json::jsonb->'edges') candidate
   where candidate->>'from' = source_node_id and candidate->>'id' = p_edge_id and candidate->>'kind' = 'next';
  if not found then
    raise exception 'The workflow has no matching next edge.' using errcode = '22023';
  end if;

  select transition.* into receipt from internal.factory_workflow_transition_receipts transition
   where (transition.root_session_id, transition.source_occurrence_id, transition.edge_id) =
     (p_root_session_id, p_source_occurrence_id, p_edge_id);
  if found then
    return query select receipt.transition_id, receipt.target_occurrence_id, false;
    return;
  end if;

  if execution.graph_revision_id is not null and source_node_kind in ('deterministic', 'human-gate') then
    command := internal.factory_workflow_occurrence_command(execution, p_source_occurrence_id);
    if not internal.factory_workflow_command_evidence_is_current(execution, command, evidence_ref) then
      return;
    end if;
    if command->>'operation' is distinct from 'policy'
      and internal.refresh_session_execution_exhaustion(p_root_session_id, p_workspace_id) is not null then
      return;
    end if;
  end if;

  select node into strict target_node
    from jsonb_array_elements(execution.workflow_json::jsonb->'nodes') node
   where node->>'id' = edge->>'to';
  insert into internal.factory_workflow_node_occurrences(root_session_id, node_id, node_kind, admitted_generation)
  values (p_root_session_id, target_node->>'id', (target_node->>'kind')::internal.factory_workflow_node_kind, p_expected_generation)
  returning occurrence_id into target_id;
  insert into internal.factory_workflow_transition_receipts(
    root_session_id, source_occurrence_id, source_result_id, target_occurrence_id, edge_id, edge_kind, recorded_generation
  ) values (p_root_session_id, p_source_occurrence_id, p_expected_result_id, target_id, p_edge_id, 'next', p_expected_generation)
  returning * into receipt;
  return query select receipt.transition_id, receipt.target_occurrence_id, true;
end;
$$;

revoke all on function internal.factory_workflow_input_checkpoint(internal.factory_workflow_executions),
  internal.factory_workflow_command_evidence_passes(public.session_validation_plans, text),
  internal.factory_workflow_browser_evidence_passes(public.session_validation_plans, text),
  internal.factory_workflow_validation_passes(public.sessions, public.session_git_checkpoints),
  internal.factory_workflow_human_approval_passes(public.sessions, public.session_git_checkpoints, jsonb, uuid),
  internal.factory_workflow_command_evidence_is_current(internal.factory_workflow_executions, jsonb, text),
  internal.insert_factory_workflow_node_result(internal.factory_workflow_executions, uuid, public.factory_workflow_node_outcome, text),
  public.record_factory_workflow_command_result(uuid, uuid, uuid, bigint, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_factory_workflow_command_result(uuid, uuid, uuid, bigint, uuid, uuid, text)
  to service_role;
