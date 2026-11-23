-- The route executor supports the guarded deterministic kinds and bounded
-- route choices. Recheck the admitted topology before creating any occurrence.
create function internal.is_bounded_factory_workflow_route_graph(p_plan jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  policy jsonb := p_plan->'routePolicy';
  configured record;
  destination_ids jsonb;
  fallback jsonb;
begin
  if jsonb_typeof(p_plan->'nodes') is distinct from 'array'
    or jsonb_typeof(p_plan->'edges') is distinct from 'array'
    or jsonb_typeof(policy->'nodes') is distinct from 'object'
    or jsonb_typeof(p_plan->'entryNodeId') is distinct from 'string'
    or jsonb_typeof(policy->'maxNodeVisits') is distinct from 'number'
    or jsonb_typeof(policy->'maxLoopTraversals') is distinct from 'number' then
    return false;
  end if;
  if policy - array['nodes', 'maxNodeVisits', 'maxLoopTraversals'] <> '{}'::jsonb then
    return false;
  end if;
  if jsonb_array_length(p_plan->'nodes') not between 1 and 128
    or jsonb_array_length(p_plan->'edges') > 512
    or coalesce(policy->>'maxNodeVisits', '') !~ '^[1-9][0-9]{0,3}$'
    or coalesce(policy->>'maxLoopTraversals', '') !~ '^(0|[1-9][0-9]{0,3})$' then
    return false;
  end if;
  if (policy->>'maxNodeVisits')::int > 1024 or (policy->>'maxLoopTraversals')::int > 1024 then
    return false;
  end if;

  if (select count(*) from jsonb_object_keys(policy->'nodes')) <>
    (select count(*) from jsonb_array_elements(p_plan->'nodes') node where node->>'kind' = 'route') then
    return false;
  end if;
  for configured in select key, value from jsonb_each(policy->'nodes') loop
    if not exists (select 1 from jsonb_array_elements(p_plan->'nodes') node
      where node->>'id' = configured.key and node->>'kind' = 'route')
      or jsonb_typeof(configured.value->'minimumConfidence') is distinct from 'number'
      or jsonb_typeof(configured.value->'allowedDestinationIds') is distinct from 'array'
      or jsonb_typeof(configured.value->'fallback') is distinct from 'object' then
      return false;
    end if;
    if configured.value - array['minimumConfidence', 'allowedDestinationIds', 'fallback'] <> '{}'::jsonb then
      return false;
    end if;
    destination_ids := configured.value->'allowedDestinationIds';
    if (configured.value->>'minimumConfidence')::numeric not between 0 and 1
      or jsonb_array_length(destination_ids) > 128
      or (select count(*) <> count(distinct destination) from jsonb_array_elements(destination_ids) destination)
      or exists (select 1 from jsonb_array_elements(destination_ids) destination
        where jsonb_typeof(destination) is distinct from 'string' or not exists (
          select 1 from jsonb_array_elements(p_plan->'edges') edge
          where edge->>'from' = configured.key and edge->>'to' = destination #>> '{}'
            and edge->>'kind' in ('route', 'loop')
        )) then
      return false;
    end if;
    fallback := configured.value->'fallback';
    if fallback->>'kind' = 'clarification' then
      if fallback <> '{"kind":"clarification"}'::jsonb then return false; end if;
    elsif fallback->>'kind' = 'route' then
      if jsonb_typeof(fallback->'destinationId') is distinct from 'string'
        or fallback - array['kind', 'destinationId'] <> '{}'::jsonb
        or destination_ids ? (fallback->>'destinationId')
        or not exists (select 1 from jsonb_array_elements(p_plan->'edges') edge
          where edge->>'from' = configured.key and edge->>'to' = fallback->>'destinationId' and edge->>'kind' = 'route') then
        return false;
      end if;
    else
      return false;
    end if;
  end loop;

  return (
    with recursive nodes as (
      select node->>'id' as id, node->>'kind' as kind, jsonb_typeof(node->'id') as id_type
      from jsonb_array_elements(p_plan->'nodes') node
    ), edges as (
      select edge->>'id' as id, edge->>'from' as source, edge->>'to' as target, edge->>'kind' as kind,
        (jsonb_typeof(edge->'id') is not distinct from 'string'
          and jsonb_typeof(edge->'from') is not distinct from 'string'
          and jsonb_typeof(edge->'to') is not distinct from 'string') as valid_fields,
        case when jsonb_typeof(edge->'maxTraversals') = 'number' and edge->>'maxTraversals' ~ '^(1[0-6]|[1-9])$'
          then (edge->>'maxTraversals')::int end as limit_count
      from jsonb_array_elements(p_plan->'edges') edge
    ), forward_reach(source, target) as (
      select source, target from edges where kind in ('next', 'route')
      union
      select reach.source, edge.target from forward_reach reach
      join edges edge on edge.source = reach.target and edge.kind in ('next', 'route')
    )
    select
      (select count(*) = count(distinct id) from nodes)
      and (select count(*) = count(distinct id) from edges)
      and (select count(*) = count(distinct (source,target)) from edges)
      and exists (select 1 from nodes where id = p_plan->>'entryNodeId')
      and not exists (select 1 from nodes where id_type is distinct from 'string'
        or length(id) not between 1 and 96 or id collate "C" !~ '^[a-z0-9]+([.-][a-z0-9]+)*$')
      and not exists (select 1 from nodes node where node.id <> p_plan->>'entryNodeId'
        and not exists (select 1 from forward_reach reach where reach.source = p_plan->>'entryNodeId' and reach.target = node.id))
      and not exists (select 1 from forward_reach where source = target)
      and not exists (select 1 from edges edge
        left join nodes source on source.id = edge.source
        left join nodes target on target.id = edge.target
        where not edge.valid_fields or source.id is null or target.id is null
          or length(edge.id) not between 1 and 96 or edge.id collate "C" !~ '^[a-z0-9]+([.-][a-z0-9]+)*$'
          or (case when source.kind = 'route' then edge.kind in ('route', 'loop') else edge.kind = 'next' end) is not true
          or (edge.kind = 'loop' and (edge.limit_count is null or (edge.target <> edge.source and not exists(
            select 1 from forward_reach reach where reach.source = edge.target and reach.target = edge.source)))))
      and not exists (select 1 from edges edge where edge.kind = 'next' group by edge.source having count(*) > 1)
      and not exists (select 1 from nodes node where node.kind = 'route' and not exists (
        select 1 from edges edge where edge.source = node.id and edge.kind = 'route'))
      and (select count(*) from nodes) * (1 + (select coalesce(sum(limit_count), 0) from edges where kind = 'loop')) <= 1024
  );
end;
$$;
revoke all on function internal.is_bounded_factory_workflow_route_graph(jsonb)
  from public, anon, authenticated, service_role;

create table internal.factory_workflow_route_decisions (
  root_session_id uuid not null,
  route_occurrence_id uuid not null,
  decision_id uuid not null default gen_random_uuid(),
  proposed_destination_id text,
  confidence numeric check (confidence between 0 and 1),
  reason text not null check (char_length(reason) <= 2000 and btrim(reason) <> ''),
  resolution text not null check (resolution in ('selected', 'fallback', 'clarification')),
  selected_edge_id text,
  selected_edge_kind internal.factory_workflow_edge_kind,
  selected_destination_id text,
  recorded_generation bigint not null check (recorded_generation between 1 and 9007199254740991),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (root_session_id, route_occurrence_id),
  unique (root_session_id, decision_id),
  foreign key (root_session_id, route_occurrence_id)
    references internal.factory_workflow_node_occurrences(root_session_id, occurrence_id) on delete cascade,
  check ((proposed_destination_id is null) = (confidence is null)),
  check (
    (resolution = 'clarification' and selected_edge_id is null
      and selected_edge_kind is null and selected_destination_id is null)
    or (resolution in ('selected', 'fallback') and selected_edge_id is not null
      and selected_edge_kind is not null and selected_destination_id is not null
      and selected_edge_kind in ('route', 'loop'))
  ),
  check (resolution <> 'fallback' or selected_edge_kind = 'route')
);
alter table internal.factory_workflow_route_decisions enable row level security;
revoke all on table internal.factory_workflow_route_decisions from public, anon, authenticated, service_role;

create function internal.preserve_factory_workflow_route_decision()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from internal.factory_workflow_node_occurrences occurrence
    where (occurrence.root_session_id, occurrence.occurrence_id) = (old.root_session_id, old.route_occurrence_id)
  ) then return old; end if;
  raise exception 'Workflow route decisions are immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_factory_workflow_route_decision() from public, anon, authenticated, service_role;
create trigger preserve_factory_workflow_route_decision before update or delete
  on internal.factory_workflow_route_decisions for each row execute function internal.preserve_factory_workflow_route_decision();

-- Only call on a new admission while holding the root lock. The visit count
-- includes the entry, next edges, and routes, across all owner generations.
create function internal.assert_factory_workflow_route_capacity(
  p_execution internal.factory_workflow_executions, p_edge jsonb, p_check_node_visits boolean default true
) returns void language plpgsql set search_path = '' as $$
declare
  policy jsonb := p_execution.workflow_json::jsonb->'routePolicy';
  loops_used bigint;
  edge_used bigint;
begin
  if policy is null or p_execution.graph_revision_id is null or not exists (
    select 1 from jsonb_array_elements(p_execution.workflow_json::jsonb->'nodes') node where node->>'kind' = 'route'
  ) then return; end if;
  if jsonb_typeof(policy) is distinct from 'object'
    or coalesce(policy->>'maxNodeVisits', '') !~ '^[1-9][0-9]{0,3}$'
    or coalesce(policy->>'maxLoopTraversals', '') !~ '^(0|[1-9][0-9]{0,3})$' then
    raise exception 'The compiled route limits are unavailable.' using errcode = 'PT422';
  end if;
  if (policy->>'maxNodeVisits')::integer > 1024 or (policy->>'maxLoopTraversals')::integer > 1024 then
    raise exception 'The compiled route limits exceed the executor bounds.' using errcode = 'PT422';
  end if;
  if p_check_node_visits and (select count(*) from internal.factory_workflow_node_occurrences occurrence
    where occurrence.root_session_id = p_execution.root_session_id) >= (policy->>'maxNodeVisits')::integer then
    raise exception 'The workflow visit limit is exhausted.' using errcode = 'PT409';
  end if;
  if p_edge->>'kind' = 'loop' then
    if coalesce(p_edge->>'maxTraversals', '') !~ '^([1-9]|1[0-6])$' then
      raise exception 'The selected loop has no valid bound.' using errcode = 'PT422';
    end if;
    select count(*), count(*) filter (where transition.edge_id = p_edge->>'id') into loops_used, edge_used
    from internal.factory_workflow_transition_receipts transition
    where transition.root_session_id = p_execution.root_session_id and transition.edge_kind = 'loop';
    if loops_used >= (policy->>'maxLoopTraversals')::integer or edge_used >= (p_edge->>'maxTraversals')::integer then
      raise exception 'The workflow loop limit is exhausted.' using errcode = 'PT409';
    end if;
  end if;
end;
$$;
revoke all on function internal.assert_factory_workflow_route_capacity(internal.factory_workflow_executions, jsonb, boolean)
  from public, anon, authenticated, service_role;

create function public.admit_factory_workflow_route_decision(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint, p_ownership_token uuid,
  p_route_occurrence_id uuid, p_reason text, p_destination_id text default null, p_confidence numeric default null
) returns table (decision_id uuid, resolution text, transition_id uuid, target_occurrence_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  receipt internal.factory_workflow_route_decisions;
  transition internal.factory_workflow_transition_receipts;
  root_session public.sessions;
  pin public.session_factory_admission_inputs;
  plan jsonb;
  node_policy jsonb;
  fallback jsonb;
  proposed_edge jsonb;
  selected_edge jsonb;
  target_node jsonb;
  source_node_id text;
  decision_resolution text;
  target_id uuid;
  accepted_result_id uuid;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select occurrence.node_id into source_node_id from internal.factory_workflow_node_occurrences occurrence
  where (occurrence.root_session_id, occurrence.occurrence_id, occurrence.node_kind) =
    (p_root_session_id, p_route_occurrence_id, 'route');
  if execution.graph_revision_id is null or not found then
    raise exception 'Workflow route occurrence is unavailable.' using errcode = 'PT404';
  end if;
  if p_reason is null or char_length(p_reason) > 2000 or btrim(p_reason) = ''
    or (p_destination_id is null) <> (p_confidence is null)
    or (p_confidence is not null and p_confidence not between 0 and 1) then
    raise exception 'The route proposal is invalid.' using errcode = '22023';
  end if;

  select prior.* into receipt from internal.factory_workflow_route_decisions prior
  where (prior.root_session_id, prior.route_occurrence_id) = (p_root_session_id, p_route_occurrence_id);
  if found then
    if (receipt.proposed_destination_id, receipt.reason, receipt.confidence) is distinct from
      (p_destination_id, p_reason, p_confidence) then
      raise exception 'The route occurrence already has a different decision.' using errcode = 'PT409';
    end if;
    if receipt.selected_edge_id is not null then
      select admitted.* into strict transition from internal.factory_workflow_transition_receipts admitted
      where (admitted.root_session_id, admitted.source_occurrence_id, admitted.edge_id) =
        (p_root_session_id, p_route_occurrence_id, receipt.selected_edge_id);
    end if;
    return query select receipt.decision_id, receipt.resolution, transition.transition_id, transition.target_occurrence_id, false;
    return;
  end if;

  plan := execution.workflow_json::jsonb;
  node_policy := plan#>array['routePolicy', 'nodes', source_node_id];
  if jsonb_typeof(node_policy->'minimumConfidence') is distinct from 'number'
    or jsonb_typeof(node_policy->'allowedDestinationIds') is distinct from 'array' then
    raise exception 'The compiled route policy is unavailable.' using errcode = 'PT422';
  end if;
  if (node_policy->>'minimumConfidence')::numeric not between 0 and 1 then
    raise exception 'The compiled route confidence threshold is invalid.' using errcode = 'PT422';
  end if;
  if p_destination_id is not null then
    select case when count(*) = 1 then jsonb_agg(edge)->0 end into proposed_edge
    from jsonb_array_elements(plan->'edges') edge
    where edge->>'from' = source_node_id and edge->>'to' = p_destination_id and edge->>'kind' in ('route', 'loop');
    if proposed_edge is null or not (node_policy->'allowedDestinationIds' ? p_destination_id) then
      raise exception 'The proposed destination is not allowed by the workflow route policy.' using errcode = 'PT422';
    end if;
  end if;

  if p_destination_id is not null and p_confidence >= (node_policy->>'minimumConfidence')::numeric then
    decision_resolution := 'selected';
    selected_edge := proposed_edge;
  else
    fallback := node_policy->'fallback';
    if fallback->>'kind' = 'clarification' then
      decision_resolution := 'clarification';
      selected_edge := null;
    elsif fallback->>'kind' = 'route' then
      decision_resolution := 'fallback';
      select case when count(*) = 1 then jsonb_agg(edge)->0 end into selected_edge
      from jsonb_array_elements(plan->'edges') edge
      where edge->>'from' = source_node_id and edge->>'to' = fallback->>'destinationId' and edge->>'kind' = 'route';
      if selected_edge is null then
        raise exception 'The configured route fallback is unavailable.' using errcode = 'PT422';
      end if;
    else
      raise exception 'No workflow escalation is configured for this route.' using errcode = 'PT422';
    end if;
  end if;

  select session.* into root_session from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (p_root_session_id, p_workspace_id, p_factory_id)
    and (session.archived_at is null or session.phase_status = 'approved')
    and session.execute_pinned_definition;
  if not found then
    raise exception 'The workflow root session cannot admit a new route.' using errcode = 'PT409';
  end if;
  select admission.* into strict pin from public.session_factory_admission_inputs admission
  where (admission.session_id, admission.workspace_id, admission.factory_id, admission.definition_revision_id, admission.definition_digest) =
    (p_root_session_id, p_workspace_id, p_factory_id, execution.definition_revision_id, execution.definition_digest);
  if proposed_edge->>'kind' = 'loop' and decision_resolution <> 'selected' then
    perform internal.assert_factory_workflow_route_capacity(execution, proposed_edge, false);
  end if;
  if selected_edge is not null then
    select node into strict target_node from jsonb_array_elements(plan->'nodes') node where node->>'id' = selected_edge->>'to';
    perform internal.assert_factory_workflow_route_capacity(execution, selected_edge);
  end if;
  perform internal.recheck_session_execution_grant(root_session);
  if exists (
    select 1 from jsonb_array_elements(plan->'nodes') node
    where node->>'id' in (source_node_id, p_destination_id, target_node->>'id') and node ? 'grantId'
      and not exists (select 1 from jsonb_array_elements(plan->'grants') declared
        where (declared->>'id', declared->'version') = (pin.execution_grant_id::text, to_jsonb(pin.execution_grant_version))
          and declared->>'id' = node->>'grantId')
  ) then
    raise exception 'The workflow route cannot expand the root session execution grant.' using errcode = '42501';
  end if;
  if root_session.execution_policy_revision_id is null
    or internal.refresh_session_execution_exhaustion(p_root_session_id, p_workspace_id) is not null then return; end if;

  insert into internal.factory_workflow_route_decisions (
    root_session_id, route_occurrence_id, proposed_destination_id, confidence, reason, resolution,
    selected_edge_id, selected_edge_kind, selected_destination_id, recorded_generation
  ) values (p_root_session_id, p_route_occurrence_id, p_destination_id, p_confidence, p_reason, decision_resolution,
    selected_edge->>'id', (selected_edge->>'kind')::internal.factory_workflow_edge_kind, selected_edge->>'to', execution.generation)
  returning * into receipt;

  if selected_edge is not null then
    select result.result_id into strict accepted_result_id
    from internal.insert_factory_workflow_node_result(execution, p_route_occurrence_id, 'succeeded',
      'route:' || receipt.decision_id) result;
    insert into internal.factory_workflow_node_occurrences(root_session_id, node_id, node_kind, admitted_generation)
    values (p_root_session_id, target_node->>'id', (target_node->>'kind')::internal.factory_workflow_node_kind, execution.generation)
    returning occurrence_id into target_id;
    insert into internal.factory_workflow_transition_receipts (
      root_session_id, source_occurrence_id, source_result_id, edge_id, edge_kind, target_occurrence_id, recorded_generation
    ) values (p_root_session_id, p_route_occurrence_id, accepted_result_id, receipt.selected_edge_id,
      receipt.selected_edge_kind, target_id, execution.generation)
    returning * into transition;
  end if;
  return query select receipt.decision_id, receipt.resolution, transition.transition_id, transition.target_occurrence_id, true;
end;
$$;

create function public.read_factory_workflow_route_decision(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_route_occurrence_id uuid
) returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(decision) || jsonb_build_object('transition_id', transition.transition_id,
    'target_occurrence_id', transition.target_occurrence_id)
  from internal.factory_workflow_route_decisions decision
  join internal.factory_workflow_executions execution using (root_session_id)
  left join internal.factory_workflow_transition_receipts transition
    on (transition.root_session_id, transition.source_occurrence_id, transition.edge_id, transition.edge_kind) =
      (decision.root_session_id, decision.route_occurrence_id, decision.selected_edge_id, decision.selected_edge_kind)
  where (execution.root_session_id, execution.workspace_id, execution.factory_id, decision.route_occurrence_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_route_occurrence_id);
$$;

revoke all on function public.admit_factory_workflow_route_decision(uuid, uuid, uuid, bigint, uuid, uuid, text, text, numeric),
  public.read_factory_workflow_route_decision(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.admit_factory_workflow_route_decision(uuid, uuid, uuid, bigint, uuid, uuid, text, text, numeric),
  public.read_factory_workflow_route_decision(uuid, uuid, uuid, uuid) to service_role;

create or replace function public.start_factory_workflow_graph_execution(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_graph_revision_id uuid,
  p_input_run_id uuid default null
) returns table (execution_generation bigint, entry_occurrence_id uuid, created boolean, ownership_token uuid)
language plpgsql security definer set search_path = '' as $$
declare
  graph internal.factory_workflow_graph_revisions;
  execution internal.factory_workflow_executions;
  input_job_id uuid;
  input_attempt_count integer;
  input_publication public.session_checkpoint_publications;
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
    where coalesce(node->>'kind', '') not in ('deterministic', 'human-gate', 'route')
      or (node->>'kind' = 'deterministic' and coalesce(node->>'operation', '') not in ('validation', 'policy', 'checkpoint'))) then
    raise exception 'The graph requires workflow capabilities that are unavailable.' using errcode = 'PT422';
  end if;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node where node->>'kind' = 'route') then
    if not internal.is_bounded_factory_workflow_route_graph(plan) then
      raise exception 'The graph must match a bounded workflow route policy.' using errcode = 'PT422';
    end if;
    if exists (
      select 1 from jsonb_array_elements(plan->'nodes') node
      where node->>'kind' = 'route' and (
        jsonb_typeof(node->'agentPromptRevisionId') is distinct from 'string'
        or not exists (
          select 1 from public.factory_agent_prompt_revisions prompt
          where (prompt.workspace_id, prompt.factory_id, prompt.id::text) =
            (p_workspace_id, p_factory_id, node->>'agentPromptRevisionId')
        )
      )
    ) then
      raise exception 'The graph requires scoped route prompt revisions.' using errcode = 'PT422';
    end if;
  elsif not internal.is_bounded_factory_workflow_next_path(plan) then
    raise exception 'The graph must form one next-only path with at most 128 nodes.' using errcode = 'PT422';
  end if;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node where node->>'operation' = 'validation')
    and not exists (
      select 1 from public.sessions session
      join public.delivery_policy_revisions policy
        on (policy.id, policy.workspace_id, policy.pipeline_id) =
          (session.pinned_delivery_policy_revision_id, session.workspace_id, session.pipeline_id)
      where session.id = p_root_session_id and jsonb_array_length(policy.requirements->'requiredEvidence') > 0
        and not exists (
          select 1 from jsonb_array_elements_text(policy.requirements->'requiredEvidence') evidence(key)
          where evidence.key collate "C" !~
            '^([A-Za-z0-9][A-Za-z0-9._/-]{0,199}|browser:(screenshot|video):[A-Za-z0-9][A-Za-z0-9._-]{0,99})$'
        )
    ) then
    raise exception 'The graph requires a pinned delivery policy with valid required evidence.' using errcode = 'PT422';
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
      select publication.* into input_publication from public.session_checkpoint_publications publication
      where (publication.run_id, publication.job_id, publication.session_id, publication.workspace_id, publication.attempt_count) =
        (p_input_run_id, input_job_id, p_root_session_id, p_workspace_id, input_attempt_count)
      for share;
    end if;
    if input_publication.run_id is null or not (
      input_publication.status = 'adopted'
      or (input_publication.status in ('pending', 'claimed')
        and input_publication.deadline_at > clock_timestamp()
        and internal.checkpoint_publication_is_current(input_publication))
    ) then
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
  if execution.graph_revision_id is not null and node_kind = 'route' then
    raise exception 'This workflow node requires a guarded route decision.' using errcode = '42501';
  end if;
  if execution.graph_revision_id is not null and node_kind in ('deterministic', 'human-gate') then
    raise exception 'This workflow node requires a guarded command result.' using errcode = '42501';
  end if;
  return query select * from internal.insert_factory_workflow_node_result(execution, p_occurrence_id, p_outcome, p_evidence_ref);
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

  if execution.graph_revision_id is not null and source_node_kind = 'route' then
    raise exception 'This workflow node requires a guarded route decision.' using errcode = '42501';
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

  if execution.graph_revision_id is not null and exists (
    select 1 from public.sessions root where root.id = p_root_session_id
      and root.archived_at is not null and root.phase_status <> 'approved'
  ) then return; end if;

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

  perform internal.assert_factory_workflow_route_capacity(execution, edge);
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
      else jsonb_strip_nulls(jsonb_build_object(
        'graph_route_blocker', case
          when root.archived_at is not null and root.phase_status <> 'approved' then 'root_unavailable'
          when root.execution_policy_revision_id is null then 'execution_policy_required'
          when root.execution_exhaustion_code is not null then 'execution_budget_exhausted'
        end
      )) || jsonb_build_object('graph_revision_id', execution.graph_revision_id,
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
         and (execution.graph_revision_id is null or (
           root.execution_exhaustion_code is null and (root.archived_at is null or root.phase_status = 'approved')
         ))
         and case when exists (select 1 from jsonb_array_elements(execution.workflow_json::jsonb->'nodes') node
           where node->>'kind' = 'route') then
           (select count(*) from internal.factory_workflow_node_occurrences visit where visit.root_session_id = execution.root_session_id)
             < (execution.workflow_json::jsonb#>>'{routePolicy,maxNodeVisits}')::integer
         else true end
         and edge->>'kind' = 'next' and edge->>'from' = occurrence.node_id
         and not exists (
           select 1 from internal.factory_workflow_transition_receipts transition
            where (transition.root_session_id, transition.source_occurrence_id, transition.edge_id) =
              (occurrence.root_session_id, occurrence.occurrence_id, edge->>'id')
         )
    ), '[]'::jsonb)
  )
  from internal.factory_workflow_executions execution
  join public.sessions root on (root.id, root.workspace_id, root.factory_id) =
    (execution.root_session_id, execution.workspace_id, execution.factory_id)
  join public.workspaces workspace on workspace.id = execution.workspace_id
  join public.factories factory on (factory.workspace_id, factory.id) = (execution.workspace_id, execution.factory_id)
  where (execution.root_session_id, execution.workspace_id, execution.factory_id) =
    (p_root_session_id, p_workspace_id, p_factory_id);
$$;
