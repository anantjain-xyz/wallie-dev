create type internal.factory_workflow_node_kind as enum (
  'agent', 'deterministic', 'human-gate', 'route', 'branch', 'join'
);
create type internal.factory_workflow_edge_kind as enum (
  'next', 'route', 'loop', 'branch', 'branch-result'
);
create type public.factory_workflow_node_outcome as enum ('succeeded', 'failed', 'canceled');

-- Workflow enrollment is separate from the session job queue.
-- The creation command verifies the definition ID and digest against the session's immutable pin.
create table internal.factory_workflow_executions (
  root_session_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  definition_revision_id uuid not null,
  definition_digest text not null check (definition_digest collate "C" ~ '^[0-9a-f]{64}$'),
  workflow_json text not null check (workflow_json is json object with unique keys),
  workflow_digest text not null check (workflow_digest = encode(sha256(convert_to(workflow_json, 'UTF8')), 'hex')),
  generation bigint not null default 1 check (generation between 1 and 9007199254740991),
  ownership_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (root_session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) on delete cascade,
  foreign key (root_session_id)
    references public.session_factory_admission_inputs(session_id) on delete cascade,
  foreign key (workspace_id, factory_id, definition_revision_id)
    references public.factory_definition_revisions(workspace_id, factory_id, id)
);
create index factory_workflow_executions_revision_idx
  on internal.factory_workflow_executions(workspace_id, factory_id, definition_revision_id);

create table internal.factory_workflow_node_occurrences (
  root_session_id uuid not null references internal.factory_workflow_executions(root_session_id) on delete cascade,
  occurrence_id uuid not null default gen_random_uuid(),
  node_id text not null check (
    char_length(node_id) between 1 and 96 and node_id collate "C" ~ '^[a-z0-9]+([.-][a-z0-9]+)*$'
  ),
  node_kind internal.factory_workflow_node_kind not null,
  is_entry boolean not null default false,
  admitted_generation bigint not null check (admitted_generation between 1 and 9007199254740991),
  admitted_at timestamptz not null default clock_timestamp(),
  primary key (root_session_id, occurrence_id)
);
create unique index factory_workflow_node_occurrences_entry_idx
  on internal.factory_workflow_node_occurrences(root_session_id) where is_entry;

create table internal.factory_workflow_node_results (
  root_session_id uuid not null,
  occurrence_id uuid not null,
  result_id uuid not null default gen_random_uuid(),
  outcome public.factory_workflow_node_outcome not null,
  evidence_ref text check (evidence_ref is null or btrim(evidence_ref) <> ''),
  recorded_generation bigint not null check (recorded_generation between 1 and 9007199254740991),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (root_session_id, occurrence_id),
  unique (root_session_id, occurrence_id, result_id),
  foreign key (root_session_id, occurrence_id)
    references internal.factory_workflow_node_occurrences(root_session_id, occurrence_id) on delete cascade
);

create table internal.factory_workflow_transition_receipts (
  root_session_id uuid not null,
  transition_id uuid not null default gen_random_uuid(),
  source_occurrence_id uuid not null,
  source_result_id uuid not null,
  edge_id text not null check (
    char_length(edge_id) between 1 and 96 and edge_id collate "C" ~ '^[a-z0-9]+([.-][a-z0-9]+)*$'
  ),
  edge_kind internal.factory_workflow_edge_kind not null,
  target_occurrence_id uuid not null,
  recorded_generation bigint not null check (recorded_generation between 1 and 9007199254740991),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (root_session_id, source_occurrence_id, edge_id),
  unique (root_session_id, target_occurrence_id),
  unique (root_session_id, transition_id),
  check (source_occurrence_id <> target_occurrence_id),
  foreign key (root_session_id, source_occurrence_id, source_result_id)
    references internal.factory_workflow_node_results(root_session_id, occurrence_id, result_id) on delete cascade,
  foreign key (root_session_id, target_occurrence_id)
    references internal.factory_workflow_node_occurrences(root_session_id, occurrence_id) on delete cascade
);

alter table internal.factory_workflow_executions enable row level security;
alter table internal.factory_workflow_node_occurrences enable row level security;
alter table internal.factory_workflow_node_results enable row level security;
alter table internal.factory_workflow_transition_receipts enable row level security;
revoke all on table internal.factory_workflow_executions, internal.factory_workflow_node_occurrences,
  internal.factory_workflow_node_results, internal.factory_workflow_transition_receipts
  from public, anon, authenticated, service_role;
revoke all on type internal.factory_workflow_node_kind, internal.factory_workflow_edge_kind
  from public, anon, authenticated, service_role;
-- Take the workspace and factory admission fences before the root session.
-- Workflow commands can then lock the execution, descendant sessions, jobs, and runs in that order.
create function internal.lock_factory_workflow_root(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid
) returns void
language plpgsql set search_path = '' as $$
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  perform 1 from public.sessions session
   where (session.id, session.workspace_id, session.factory_id) =
     (p_root_session_id, p_workspace_id, p_factory_id)
   for no key update;
  if not found then
    raise exception 'Workflow root session is unavailable.' using errcode = 'PT404';
  end if;
end;
$$;
revoke all on function internal.lock_factory_workflow_root(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create function internal.lock_factory_workflow_generation(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint
) returns internal.factory_workflow_executions
language plpgsql set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
begin
  perform internal.lock_factory_workflow_root(p_root_session_id, p_workspace_id, p_factory_id);
  select workflow.* into execution
    from internal.factory_workflow_executions workflow
   where workflow.root_session_id = p_root_session_id
   for no key update;
  if not found then
    raise exception 'Workflow execution is unavailable.' using errcode = 'PT404';
  end if;
  if execution.generation is distinct from p_expected_generation then
    raise exception 'Workflow generation is stale.' using errcode = 'PT409';
  end if;
  return execution;
end;
$$;
revoke all on function internal.lock_factory_workflow_generation(uuid, uuid, uuid, bigint) from public, anon, authenticated, service_role;

create function internal.lock_factory_workflow_owner(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid
) returns internal.factory_workflow_executions
language plpgsql set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
begin
  execution := internal.lock_factory_workflow_generation(
    p_root_session_id, p_workspace_id, p_factory_id, p_expected_generation
  );
  if execution.ownership_token is distinct from p_ownership_token then
    raise exception 'Workflow ownership token is stale.' using errcode = 'PT409';
  end if;
  return execution;
end;
$$;
revoke all on function internal.lock_factory_workflow_owner(uuid, uuid, uuid, bigint, uuid)
  from public, anon, authenticated, service_role;

-- A serial plan must project the exact selected stages and approval policies.
create function internal.matches_serial_factory_workflow_plan(
  p_plan jsonb, p_definition jsonb, p_selected_stage_ids uuid[]
) returns boolean language sql immutable set search_path = '' as $$
  with selected as (
    select selection.position, stage
    from unnest(p_selected_stage_ids) with ordinality selection(stage_id, position)
    join lateral jsonb_array_elements(p_definition->'stages') stage
      on stage->>'id' = selection.stage_id::text
  ), nodes as (
    select position * 2 - 1 as position, jsonb_build_object(
      'id', 'stage.' || (stage->>'id'), 'kind', 'agent',
      'stage', stage - 'anyoneCanApprove' - 'approverMemberIds'
    ) as node from selected
    union all
    select position * 2, jsonb_build_object(
      'id', 'approval.' || (stage->>'id'), 'kind', 'human-gate', 'stageId', stage->'id',
      'approval', jsonb_build_object(
        'anyoneCanApprove', stage->'anyoneCanApprove', 'approverMemberIds', stage->'approverMemberIds'
      )
    ) from selected
  ), sequence as (
    select position, node, node->>'id' as node_id, lead(node->>'id') over (order by position) as next_node_id
    from nodes
  )
  select count(*) = 2 * cardinality(p_selected_stage_ids) and p_plan = jsonb_build_object(
    'kind', 'serial', 'entryNodeId', 'stage.' || p_selected_stage_ids[1]::text,
    'nodes', jsonb_agg(node order by position),
    'edges', jsonb_agg(jsonb_build_object(
      'id', 'next.' || node_id, 'kind', 'next', 'from', node_id, 'to', next_node_id
    ) order by position) filter (where next_node_id is not null)
  )
  from sequence;
$$;
revoke all on function internal.matches_serial_factory_workflow_plan(jsonb, jsonb, uuid[])
  from public, anon, authenticated, service_role;

create function public.start_factory_workflow_execution(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid,
  p_definition_revision_id uuid, p_definition_digest text,
  p_workflow_json text, p_workflow_digest text
) returns table (execution_generation bigint, entry_occurrence_id uuid, created boolean, ownership_token uuid)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  plan jsonb := p_workflow_json::jsonb;
  entry jsonb;
  occurrence_id uuid;
begin
  if p_workflow_digest is null or p_workflow_digest <> encode(sha256(convert_to(p_workflow_json, 'UTF8')), 'hex')
    or plan->>'kind' is distinct from 'serial'
    or jsonb_typeof(plan->'nodes') is distinct from 'array'
    or jsonb_typeof(plan->'edges') is distinct from 'array' then
    raise exception 'A verified compiled workflow is required.' using errcode = '22023';
  end if;
  select node into entry from jsonb_array_elements(plan->'nodes') node
   where node->>'id' = plan->>'entryNodeId';
  if entry is null then
    raise exception 'The workflow entry node is missing.' using errcode = '22023';
  end if;

  perform internal.lock_factory_workflow_root(p_root_session_id, p_workspace_id, p_factory_id);
  perform 1 from public.session_factory_admission_inputs pin
    join public.sessions session on session.id = pin.session_id
    join public.factory_definition_revisions revision
      on (revision.id, revision.workspace_id, revision.factory_id, revision.canonical_digest) =
        (pin.definition_revision_id, pin.workspace_id, pin.factory_id, pin.definition_digest)
   where (pin.session_id, pin.workspace_id, pin.factory_id, pin.definition_revision_id, pin.definition_digest) =
     (p_root_session_id, p_workspace_id, p_factory_id, p_definition_revision_id, p_definition_digest)
     and session.execute_pinned_definition
     and session.factory_definition_revision_id = pin.definition_revision_id
     and internal.matches_serial_factory_workflow_plan(plan, revision.definition_json::jsonb, pin.selected_stage_ids);
  if not found then
    raise exception 'The workflow must match the session definition pin.' using errcode = 'PT409';
  end if;

  select workflow.* into execution
    from internal.factory_workflow_executions workflow
   where workflow.root_session_id = p_root_session_id;
  if found then
    if execution.workflow_digest <> p_workflow_digest or execution.workflow_json <> p_workflow_json then
      raise exception 'The root session already has a different workflow.' using errcode = 'PT409';
    end if;
    return query select execution.generation, occurrence.occurrence_id, false, null::uuid
      from internal.factory_workflow_node_occurrences occurrence
     where occurrence.root_session_id = p_root_session_id and occurrence.is_entry;
    return;
  end if;

  insert into internal.factory_workflow_executions(
    root_session_id, workspace_id, factory_id, definition_revision_id, definition_digest, workflow_json, workflow_digest
  ) values (
    p_root_session_id, p_workspace_id, p_factory_id, p_definition_revision_id, p_definition_digest, p_workflow_json, p_workflow_digest
  ) returning * into execution;

  insert into internal.factory_workflow_node_occurrences(
    root_session_id, node_id, node_kind, is_entry, admitted_generation
  ) values (
    p_root_session_id, entry->>'id', (entry->>'kind')::internal.factory_workflow_node_kind, true, execution.generation
  ) returning factory_workflow_node_occurrences.occurrence_id into occurrence_id;
  return query select execution.generation, occurrence_id, true, execution.ownership_token;
end;
$$;

create function public.advance_factory_workflow_generation(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint
) returns table (execution_generation bigint, ownership_token uuid)
language plpgsql security definer set search_path = '' as $$
begin
  perform internal.lock_factory_workflow_generation(p_root_session_id, p_workspace_id, p_factory_id, p_expected_generation);
  return query
    update internal.factory_workflow_executions workflow
      set generation = workflow.generation + 1, ownership_token = gen_random_uuid()
      where workflow.root_session_id = p_root_session_id
      returning workflow.generation, workflow.ownership_token;
end;
$$;

create function public.record_factory_workflow_node_result(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_occurrence_id uuid, p_outcome public.factory_workflow_node_outcome,
  p_evidence_ref text default null
) returns table (result_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  receipt internal.factory_workflow_node_results;
begin
  perform internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  perform 1 from internal.factory_workflow_node_occurrences occurrence
   where (occurrence.root_session_id, occurrence.occurrence_id) = (p_root_session_id, p_occurrence_id);
  if not found then
    raise exception 'Workflow node occurrence is unavailable.' using errcode = 'PT404';
  end if;
  select result.* into receipt from internal.factory_workflow_node_results result
   where (result.root_session_id, result.occurrence_id) = (p_root_session_id, p_occurrence_id);
  if found then
    if receipt.outcome is distinct from p_outcome or receipt.evidence_ref is distinct from p_evidence_ref then
      raise exception 'The workflow node already has a different result.' using errcode = 'PT409';
    end if;
    return query select receipt.result_id, false;
    return;
  end if;
  insert into internal.factory_workflow_node_results(root_session_id, occurrence_id, outcome, evidence_ref, recorded_generation)
  values (p_root_session_id, p_occurrence_id, p_outcome, p_evidence_ref, p_expected_generation)
  returning * into receipt;
  return query select receipt.result_id, true;
end;
$$;

create function public.admit_factory_workflow_next(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_source_occurrence_id uuid, p_edge_id text, p_expected_result_id uuid
) returns table (transition_id uuid, target_occurrence_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  source_node_id text;
  target_node jsonb;
  edge jsonb;
  target_id uuid;
  receipt internal.factory_workflow_transition_receipts;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select occurrence.node_id into source_node_id
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

create function public.read_factory_workflow_execution(
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
    ),
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

revoke all on function public.start_factory_workflow_execution(uuid, uuid, uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.advance_factory_workflow_generation(uuid, uuid, uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.record_factory_workflow_node_result(uuid, uuid, uuid, bigint, uuid, uuid, public.factory_workflow_node_outcome, text) from public, anon, authenticated, service_role;
revoke all on function public.admit_factory_workflow_next(uuid, uuid, uuid, bigint, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.read_factory_workflow_execution(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.start_factory_workflow_execution(uuid, uuid, uuid, uuid, text, text, text) to service_role;
grant execute on function public.advance_factory_workflow_generation(uuid, uuid, uuid, bigint) to service_role;
grant execute on function public.record_factory_workflow_node_result(uuid, uuid, uuid, bigint, uuid, uuid, public.factory_workflow_node_outcome, text) to service_role;
grant execute on function public.admit_factory_workflow_next(uuid, uuid, uuid, bigint, uuid, uuid, text, uuid) to service_role;
grant execute on function public.read_factory_workflow_execution(uuid, uuid, uuid) to service_role;
