create or replace function internal.is_bounded_factory_workflow_route_graph(p_plan jsonb)
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
    if configured.value - array['minimumConfidence', 'allowedDestinationIds', 'fallback', 'foremanProfile'] <> '{}'::jsonb then
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

create function internal.is_enrollable_factory_workflow_foreman(
  p_workspace_id uuid, p_factory_id uuid, p_plan jsonb
) returns boolean language plpgsql stable set search_path = '' as $$
declare
  route record;
  profile jsonb;
begin
  for route in select key, value from jsonb_each(p_plan#>'{routePolicy,nodes}') loop
    if not (route.value ? 'foremanProfile') then continue; end if;
    profile := route.value->'foremanProfile';
    if jsonb_typeof(profile) is distinct from 'object'
      or jsonb_typeof(p_plan->'delegationPolicy') is distinct from 'object' then
      return false;
    end if;
    if profile - array['definitionRevisionId', 'definitionDigest'] <> '{}'::jsonb
      or jsonb_typeof(profile->'definitionRevisionId') is distinct from 'string'
      or jsonb_typeof(profile->'definitionDigest') is distinct from 'string'
      or not exists (
        select 1 from public.factory_definition_revisions revision
        where (revision.workspace_id, revision.factory_id, revision.id::text, revision.canonical_digest) =
          (p_workspace_id, p_factory_id, profile->>'definitionRevisionId', profile->>'definitionDigest')
          and revision.definition_json::jsonb ?& array['executionGrant', 'credentialBindingId']
          and not (revision.definition_json::jsonb ? 'modelRouting')
          and revision.definition_json::jsonb#>>'{agent,provider}' = 'codex'
          and exists (
            select 1 from jsonb_array_elements(p_plan->'nodes') node
            where (node->>'id', node->>'kind', node->>'agentPromptRevisionId') =
              (route.key, 'route', revision.definition_json::jsonb#>>'{implementationAgent,promptRevisionId}')
          )
          and exists (
            select 1 from public.factory_definition_activations activation
            where (activation.workspace_id, activation.factory_id, activation.revision_id) =
              (revision.workspace_id, revision.factory_id, revision.id)
          )
      ) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;
revoke all on function internal.is_enrollable_factory_workflow_foreman(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

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

  if exists (select 1 from internal.factory_workflow_delegations marker
    where (marker.child_session_id, marker.workspace_id, marker.factory_id) =
      (p_root_session_id, p_workspace_id, p_factory_id)) then
    raise exception 'A delegated child cannot start an independent workflow graph.' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.sessions session
    where session.id = p_root_session_id and session.archived_at is not null) then
    raise exception 'The graph revision must match an active session definition pin.' using errcode = 'PT409';
  end if;

  -- Existing command and route capabilities, plus guarded routed child admission.
  plan := graph.workflow_json::jsonb;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node
    where coalesce(node->>'kind', '') not in ('deterministic', 'human-gate', 'route', 'agent')
      or (node->>'kind' = 'deterministic' and coalesce(node->>'operation', '') not in ('validation', 'policy', 'checkpoint'))) then
    raise exception 'The graph requires workflow capabilities that are unavailable.' using errcode = 'PT422';
  end if;
  if not internal.is_enrollable_factory_workflow_delegation(p_workspace_id, p_factory_id, plan) then
    raise exception 'The graph requires bounded delegation and exact scoped child profiles.' using errcode = 'PT422';
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
    if not internal.is_enrollable_factory_workflow_foreman(p_workspace_id, p_factory_id, plan) then
      raise exception 'The graph requires a scoped foreman profile and bounded delegation.' using errcode = 'PT422';
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

-- One irreversible provider issuance per exact route occurrence. A missing
-- response leaves an issued hold and replay never returns an inference permit.
create table internal.factory_workflow_foreman_runs (
  root_session_id uuid not null,
  route_occurrence_id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  foreman_run_id uuid not null unique default gen_random_uuid(),
  issue_id uuid not null unique default gen_random_uuid(),
  issued_generation bigint not null check (issued_generation between 1 and 9007199254740991),
  issued_owner_hash bytea not null check (octet_length(issued_owner_hash) = 32),
  workflow_digest text not null,
  parent_session_id uuid not null,
  source_checkpoint_run_id uuid,
  offered_children jsonb not null check (jsonb_typeof(offered_children) = 'array'),
  profile_revision_id uuid not null,
  profile_digest text not null,
  prompt_revision_id uuid not null,
  prompt_sha256 text not null,
  inference_model text not null,
  execution_grant_id uuid not null,
  execution_grant_version bigint not null,
  credential_binding_id uuid not null,
  reserved_tokens bigint not null check (reserved_tokens > 0),
  reserved_cost_usd numeric not null check (reserved_cost_usd > 0),
  input_tokens bigint check (input_tokens >= 0),
  output_tokens bigint check (output_tokens >= 0),
  cost_usd numeric check (cost_usd >= 0),
  provider_receipt_id text,
  status text not null default 'issued' check (status in ('issued', 'accepted', 'blocked', 'stale')),
  blocked_code text,
  plan_json text,
  plan_digest text,
  issued_at timestamptz not null,
  deadline_at timestamptz not null check (deadline_at > issued_at),
  settled_at timestamptz,
  primary key (root_session_id, route_occurrence_id),
  unique (root_session_id, route_occurrence_id, foreman_run_id),
  foreign key (root_session_id, route_occurrence_id)
    references internal.factory_workflow_node_occurrences(root_session_id, occurrence_id) on delete cascade,
  foreign key (root_session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) on delete cascade,
  foreign key (parent_session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) deferrable initially deferred,
  foreign key (workspace_id, factory_id, profile_revision_id)
    references public.factory_definition_revisions(workspace_id, factory_id, id) deferrable initially deferred,
  check ((status = 'issued') = (settled_at is null)),
  check ((status in ('blocked', 'stale')) = (blocked_code is not null)),
  check ((status = 'accepted') = (plan_json is not null)),
  check ((plan_json is null) = (plan_digest is null)),
  check (plan_digest is null or plan_digest = encode(sha256(convert_to(plan_json, 'UTF8')), 'hex'))
);
alter table internal.factory_workflow_foreman_runs enable row level security;
revoke all on table internal.factory_workflow_foreman_runs from public, anon, authenticated, service_role;

create table internal.factory_workflow_foreman_commands (
  root_session_id uuid not null,
  route_occurrence_id uuid not null,
  foreman_run_id uuid not null,
  ordinal smallint not null check (ordinal in (1, 2)),
  command_json jsonb not null check (jsonb_typeof(command_json) = 'object'),
  receipt_json jsonb check (jsonb_typeof(receipt_json) = 'object'),
  route_decision_id uuid,
  target_occurrence_id uuid,
  child_session_id uuid,
  child_job_id uuid,
  child_run_id uuid,
  dispatched_at timestamptz,
  primary key (foreman_run_id, ordinal),
  foreign key (root_session_id, route_occurrence_id, foreman_run_id)
    references internal.factory_workflow_foreman_runs(root_session_id, route_occurrence_id, foreman_run_id) on delete cascade,
  foreign key (root_session_id, route_decision_id)
    references internal.factory_workflow_route_decisions(root_session_id, decision_id) deferrable initially deferred,
  foreign key (root_session_id, target_occurrence_id)
    references internal.factory_workflow_node_occurrences(root_session_id, occurrence_id) deferrable initially deferred,
  check ((receipt_json is null) = (dispatched_at is null)),
  check (receipt_json is not null or
    (route_decision_id is null and target_occurrence_id is null and
      child_session_id is null and child_job_id is null and child_run_id is null)),
  check (num_nonnulls(child_session_id, child_job_id, child_run_id) in (0, 3))
);
alter table internal.factory_workflow_foreman_commands enable row level security;
revoke all on table internal.factory_workflow_foreman_commands from public, anon, authenticated, service_role;

-- Include synchronous inference in the canonical root accounting used by claim and child admission.
create or replace function internal.factory_workflow_attempt_budget(
  p_root_session_id uuid, p_policy jsonb
) returns table (attempts bigint, tokens numeric, spend_usd numeric, active_children bigint)
language sql stable set search_path = '' as $$
  with reserved_attempts as (
    select
      reserve.session_id,
      coalesce(run.status in ('started', 'running'), false)
        or (run.id is null and coalesce(
          (job.status = 'queued' and job.attempt_count < reserve.attempt_count)
          or (job.status in ('started', 'running') and job.attempt_count = reserve.attempt_count), false)
        ) as active,
      reserve.run_id is not null as started,
      reserve.reserved_tokens,
      reserve.reserved_cost_usd,
      reserve.reported_tokens,
      reserve.reported_cost_usd
    from internal.factory_workflow_attempt_reservations reserve
    left join public.agent_jobs job on (job.workspace_id, job.session_id, job.id) =
      (reserve.workspace_id, reserve.session_id, reserve.job_id)
    left join public.agent_runs run on
      (run.workspace_id, run.session_id, run.agent_job_id, run.id, run.attempt_count) =
      (reserve.workspace_id, reserve.session_id, reserve.job_id, reserve.run_id, reserve.attempt_count)
    where reserve.root_session_id = p_root_session_id
  ), existing_root_attempts as (
    -- The root may have started an ordinary serial attempt before enrollment.
    -- Include its exact run once, even though it predates this reservation ledger.
    select
      run.session_id,
      run.status in ('started', 'running') as active,
      true as started,
      (p_policy->>'maxTokensPerAttempt')::bigint as reserved_tokens,
      (p_policy->>'maxCostUsdPerAttempt')::numeric as reserved_cost_usd,
      run.input_tokens + run.output_tokens as reported_tokens,
      run.total_cost_usd as reported_cost_usd
    from public.agent_runs run
    where run.session_id = p_root_session_id and run.attempt_count > 0
      and not exists (
        select 1 from internal.factory_workflow_attempt_reservations reserve
        where (reserve.job_id, reserve.attempt_count) = (run.agent_job_id, run.attempt_count)
      )
  ), foreman_attempts as (
    select invocation.root_session_id as session_id, invocation.status = 'issued' as active,
      true as started, invocation.reserved_tokens, invocation.reserved_cost_usd,
      coalesce(invocation.input_tokens + invocation.output_tokens,
        greatest(invocation.reserved_tokens, coalesce(invocation.input_tokens, 0) + coalesce(invocation.output_tokens, 0)))
        as reported_tokens, invocation.cost_usd as reported_cost_usd
    from internal.factory_workflow_foreman_runs invocation
    where invocation.root_session_id = p_root_session_id
  ), attempts as (
    select * from reserved_attempts
    union all
    select * from existing_root_attempts
    union all
    select * from foreman_attempts
  )
  select count(*) filter (where active or started),
    coalesce(sum(case when active then greatest(reserved_tokens, reported_tokens)
      when started then coalesce(reported_tokens, reserved_tokens) else 0 end), 0),
    coalesce(sum(case when active then greatest(reserved_cost_usd, reported_cost_usd)
      when started then coalesce(reported_cost_usd, reserved_cost_usd) else 0 end), 0),
    count(distinct session_id) filter (where active and session_id <> p_root_session_id)
  from attempts;
$$;
create function internal.is_valid_factory_workflow_foreman_plan(p_plan_json text, p_plan_digest text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare plan jsonb; commands jsonb; candidate jsonb; decision jsonb;
begin
  if p_plan_json is null or octet_length(convert_to(p_plan_json, 'UTF8')) > 24576
    or p_plan_json is not json object with unique keys
    or p_plan_digest is distinct from encode(sha256(convert_to(p_plan_json, 'UTF8')), 'hex') then
    return false;
  end if;
  plan := p_plan_json::jsonb;
  commands := plan->'commands';
  if plan->'version' is distinct from '1'::jsonb or plan - array['version', 'commands'] <> '{}'::jsonb
    or jsonb_typeof(commands) is distinct from 'array' then return false; end if;
  if jsonb_array_length(commands) not in (1, 2) then return false; end if;

  for candidate in select value from jsonb_array_elements(commands) loop
    if jsonb_typeof(candidate) is distinct from 'object' then return false; end if;
    case candidate->>'kind'
      when 'route' then
        decision := candidate->'decision';
        if candidate - array['kind', 'decision'] <> '{}'::jsonb or jsonb_typeof(decision) is distinct from 'object'
          or jsonb_typeof(decision->'reason') is distinct from 'string'
          or char_length(decision->>'reason') not between 1 and 512 or decision->>'reason' !~ '\S' then return false; end if;
        if decision->>'kind' = 'choose' then
          if decision - array['kind', 'destinationNodeId', 'confidence', 'reason'] <> '{}'::jsonb
            or jsonb_typeof(decision->'destinationNodeId') is distinct from 'string'
            or char_length(decision->>'destinationNodeId') not between 1 and 96
            or jsonb_typeof(decision->'confidence') is distinct from 'number' then return false; end if;
          if (decision->>'confidence')::numeric not between 0 and 1 then return false; end if;
        elsif decision->>'kind' is distinct from 'unresolved'
          or decision - array['kind', 'reason'] <> '{}'::jsonb then return false;
        end if;
      when 'delegate' then
        if candidate - array['kind', 'targetNodeId', 'title', 'promptMd'] <> '{}'::jsonb
          or jsonb_typeof(candidate->'targetNodeId') is distinct from 'string'
          or char_length(candidate->>'targetNodeId') not between 1 and 96
          or candidate->>'targetNodeId' !~ '^[a-z0-9]+([.-][a-z0-9]+)*$'
          or jsonb_typeof(candidate->'title') is distinct from 'string'
          or jsonb_typeof(candidate->'promptMd') is distinct from 'string'
          or char_length(btrim(candidate->>'title')) not between 1 and 200
          or char_length(btrim(candidate->>'promptMd')) not between 1 and 20000 then return false; end if;
      when 'read_child' then
        if candidate - array['kind', 'childRef'] <> '{}'::jsonb
          or jsonb_typeof(candidate->'childRef') is distinct from 'string'
          or candidate->>'childRef' !~ '^[a-z0-9][a-z0-9.-]{0,63}$' then return false; end if;
      else return false;
    end case;
  end loop;

  return (commands#>>'{0,kind}' = 'route' and (
    jsonb_array_length(commands) = 1 or commands#>>'{1,kind}' = 'read_child' or (
      commands#>>'{0,decision,kind}' = 'choose' and commands#>>'{1,kind}' = 'delegate'
      and commands#>>'{0,decision,destinationNodeId}' = commands#>>'{1,targetNodeId}'
    )
  )) is true;
end;
$$;

create function internal.factory_workflow_foreman_usage_exhausted(
  p_input_tokens bigint, p_output_tokens bigint, p_cost_usd numeric,
  p_reserved_tokens bigint, p_reserved_cost_usd numeric
) returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_input_tokens, 0) + coalesce(p_output_tokens, 0) > p_reserved_tokens
    or coalesce(p_output_tokens, 0) > least(p_reserved_tokens, 4096)
    or coalesce(p_cost_usd, 0) > p_reserved_cost_usd
$$;
revoke all on function internal.factory_workflow_foreman_usage_exhausted(bigint, bigint, numeric, bigint, numeric)
  from public, anon, authenticated, service_role;

create function internal.factory_workflow_foreman_run_projection(p_run internal.factory_workflow_foreman_runs)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'foremanRunId', p_run.foreman_run_id,
    'rootSessionId', p_run.root_session_id,
    'workspaceId', p_run.workspace_id,
    'factoryId', p_run.factory_id,
    'routeOccurrenceId', p_run.route_occurrence_id,
    'routeNodeId', (select occurrence.node_id from internal.factory_workflow_node_occurrences occurrence
      where (occurrence.root_session_id, occurrence.occurrence_id) =
        (p_run.root_session_id, p_run.route_occurrence_id)),
    'workflowDigest', p_run.workflow_digest,
    'issuedGeneration', p_run.issued_generation,
    'currentGeneration', (select execution.generation from internal.factory_workflow_executions execution
      where execution.root_session_id = p_run.root_session_id),
    'status', p_run.status,
    'code', p_run.blocked_code,
    'parentSessionId', p_run.parent_session_id,
    'planJson', p_run.plan_json,
    'planDigest', p_run.plan_digest,
    'issuedAt', p_run.issued_at,
    'deadlineAt', p_run.deadline_at,
    'settledAt', p_run.settled_at,
    'providerReceiptId', p_run.provider_receipt_id
  )) || jsonb_build_object(
    'sourceCheckpointRunId', p_run.source_checkpoint_run_id,
    'usage', jsonb_build_object('inputTokens', p_run.input_tokens, 'outputTokens', p_run.output_tokens, 'costUsd', p_run.cost_usd),
    'commands', coalesce((
      select jsonb_agg(jsonb_build_object('ordinal', command.ordinal, 'command', command.command_json)
        || case when command.receipt_json is null then '{}'::jsonb else jsonb_build_object('receipt', command.receipt_json) end
        order by command.ordinal)
      from internal.factory_workflow_foreman_commands command where command.foreman_run_id = p_run.foreman_run_id
    ), '[]'::jsonb)
  )
$$;

create function public.read_factory_workflow_foreman_run(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_route_occurrence_id uuid
) returns jsonb language sql stable security definer set search_path = '' as $$
  select internal.factory_workflow_foreman_run_projection(invocation)
  from internal.factory_workflow_foreman_runs invocation
  where (invocation.root_session_id, invocation.workspace_id, invocation.factory_id, invocation.route_occurrence_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_route_occurrence_id)
$$;

revoke all on function internal.is_valid_factory_workflow_foreman_plan(text, text),
  internal.factory_workflow_foreman_run_projection(internal.factory_workflow_foreman_runs),
  public.read_factory_workflow_foreman_run(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.read_factory_workflow_foreman_run(uuid, uuid, uuid, uuid) to service_role;

create function public.begin_factory_workflow_foreman_inference(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint, p_ownership_token uuid,
  p_route_occurrence_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  invocation internal.factory_workflow_foreman_runs;
  root public.sessions;
  parent public.sessions;
  parent_id uuid;
  source_run_id uuid;
  route_node jsonb;
  route_policy jsonb;
  profile_pin jsonb;
  profile public.factory_definition_revisions;
  profile_definition jsonb;
  root_definition jsonb;
  parent_definition jsonb;
  root_grant public.factory_execution_grants;
  parent_grant public.factory_execution_grants;
  profile_grant public.factory_execution_grants;
  binding public.factory_secret_bindings;
  prompt public.factory_agent_prompt_revisions;
  input_pin public.session_factory_admission_inputs;
  encrypted_credential text;
  offered_children jsonb;
  budget_policy jsonb;
  root_budget record;
  consumed record;
  reserved_tokens bigint;
  reserved_cost_usd numeric;
  issue_time timestamptz;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select run.* into invocation from internal.factory_workflow_foreman_runs run
  where (run.root_session_id, run.route_occurrence_id) = (p_root_session_id, p_route_occurrence_id);
  if found then
    return jsonb_build_object('status', 'existing', 'run', internal.factory_workflow_foreman_run_projection(invocation));
  end if;

  if execution.graph_revision_id is null then
    return jsonb_build_object('status', 'blocked', 'code', 'profile_unavailable');
  end if;
  select node into route_node
  from internal.factory_workflow_node_occurrences occurrence
  cross join lateral jsonb_array_elements(execution.workflow_json::jsonb->'nodes') node
  where (occurrence.root_session_id, occurrence.occurrence_id, occurrence.node_kind) =
    (p_root_session_id, p_route_occurrence_id, 'route') and node->>'id' = occurrence.node_id
    and node->>'kind' = 'route';
  if not found then return jsonb_build_object('status', 'blocked', 'code', 'route_unavailable'); end if;
  if exists (select 1 from internal.factory_workflow_node_results result
    where (result.root_session_id, result.occurrence_id) = (p_root_session_id, p_route_occurrence_id)) then
    return jsonb_build_object('status', 'blocked', 'code', 'route_already_decided');
  end if;
  route_policy := execution.workflow_json::jsonb#>array['routePolicy', 'nodes', route_node->>'id'];
  profile_pin := route_policy->'foremanProfile';
  if jsonb_typeof(profile_pin) is distinct from 'object'
    or profile_pin - array['definitionRevisionId', 'definitionDigest'] <> '{}'::jsonb then
    return jsonb_build_object('status', 'blocked', 'code', 'profile_unavailable');
  end if;

  select session.* into strict root from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (p_root_session_id, p_workspace_id, p_factory_id);
  if root.execution_purpose <> 'production' or not root.execute_pinned_definition or root.phase_status = 'rejected'
    or (root.archived_at is not null and root.phase_status <> 'approved') then
    return jsonb_build_object('status', 'blocked', 'code', 'root_unavailable');
  end if;

  -- The nearest delegated ancestor owns the route, otherwise the root owns it.
  with recursive ancestry(occurrence_id, distance) as (
    select p_route_occurrence_id, 0
    union all
    select transition.source_occurrence_id, ancestry.distance + 1
    from ancestry join internal.factory_workflow_transition_receipts transition
      on (transition.root_session_id, transition.target_occurrence_id) = (p_root_session_id, ancestry.occurrence_id)
    where ancestry.distance < 1023
  )
  select coalesce((select marker.child_session_id from ancestry join internal.factory_workflow_delegations marker
    on (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.target_occurrence_id) =
      (p_root_session_id, p_workspace_id, p_factory_id, ancestry.occurrence_id)
    order by ancestry.distance limit 1), p_root_session_id) into parent_id;

  if not internal.recheck_factory_workflow_delegation_lineage(
    p_root_session_id, p_workspace_id, p_factory_id, parent_id
  ) then
    return jsonb_build_object('status', 'blocked', 'code', 'parent_unavailable');
  end if;
  select session.* into strict parent from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (parent_id, p_workspace_id, p_factory_id);

  budget_policy := execution.workflow_json::jsonb->'delegationPolicy';
  select * into strict root_budget from public.get_session_execution_budget(p_root_session_id);
  if budget_policy is null or root_budget.policy_revision is null then
    return jsonb_build_object('status', 'blocked', 'code', 'execution_policy_required');
  end if;
  if root_budget.exhaustion_code is not null or root_budget.remaining_execution_ms <= 0 then
    return jsonb_build_object('status', 'blocked', 'code', 'budget_exhausted');
  end if;
  reserved_tokens := (budget_policy->>'maxTokensPerAttempt')::bigint;
  reserved_cost_usd := (budget_policy->>'maxCostUsdPerAttempt')::numeric;
  select * into strict consumed from internal.factory_workflow_attempt_budget(p_root_session_id, budget_policy);
  if consumed.attempts + 1 > (budget_policy->>'maxAttempts')::integer
    or consumed.tokens + reserved_tokens > least(root_budget.max_total_tokens, (budget_policy->>'maxTotalTokens')::bigint)
    or consumed.spend_usd + reserved_cost_usd > least(root_budget.max_cost_usd, (budget_policy->>'maxCostUsd')::numeric) then
    return jsonb_build_object('status', 'blocked', 'code', 'budget_exhausted');
  end if;

  select revision.* into profile from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id::text, revision.canonical_digest) =
    (p_workspace_id, p_factory_id, profile_pin->>'definitionRevisionId', profile_pin->>'definitionDigest')
    and exists (select 1 from public.factory_definition_activations activation
      where (activation.workspace_id, activation.factory_id, activation.revision_id) =
        (revision.workspace_id, revision.factory_id, revision.id));
  if not found then return jsonb_build_object('status', 'blocked', 'code', 'profile_unavailable'); end if;
  profile_definition := profile.definition_json::jsonb;
  if profile_definition ? 'modelRouting'
    or profile_definition#>>'{agent,provider}' is distinct from 'codex'
    or nullif(btrim(profile_definition#>>'{agent,model}'), '') is null
    or profile_definition#>>'{implementationAgent,promptRevisionId}' is distinct from route_node->>'agentPromptRevisionId'
    or profile_definition->>'repositoryId' is distinct from root.github_repository_id::text then
    return jsonb_build_object('status', 'blocked', 'code', 'profile_unavailable');
  end if;

  select revision.* into prompt from public.factory_agent_prompt_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id::text, revision.agent_id::text) =
    (p_workspace_id, p_factory_id, route_node->>'agentPromptRevisionId', profile_definition#>>'{implementationAgent,agentId}')
    and revision.prompt_sha256 = profile_definition#>>'{implementationAgent,promptSha256}'
    and revision.prompt_sha256 = encode(sha256(convert_to(revision.prompt_md, 'UTF8')), 'hex')
    and octet_length(convert_to(revision.prompt_md, 'UTF8')) <= 24576;
  if not found then return jsonb_build_object('status', 'blocked', 'code', 'profile_unavailable'); end if;

  root_definition := internal.pinned_session_execution_definition(root);
  select approved.* into root_grant from public.session_factory_admission_inputs pin
  join public.factory_execution_grants approved on (approved.workspace_id, approved.factory_id, approved.id, approved.version) =
    (pin.workspace_id, pin.factory_id, pin.execution_grant_id, pin.execution_grant_version)
  where pin.session_id = root.id;
  if parent.id = root.id then
    parent_definition := root_definition;
    parent_grant := root_grant;
  else
    parent_definition := internal.pinned_session_execution_definition(parent);
    select approved.* into parent_grant from public.session_factory_admission_inputs pin
    join public.factory_execution_grants approved on (approved.workspace_id, approved.factory_id, approved.id, approved.version) =
      (pin.workspace_id, pin.factory_id, pin.execution_grant_id, pin.execution_grant_version)
    where pin.session_id = parent.id;
  end if;
  profile_grant := internal.resolve_definition_execution_grant(p_workspace_id, p_factory_id, profile_definition,
    root.github_repository_id, (profile_definition->>'executionPolicyRevisionId')::uuid);
  if internal.factory_workflow_delegated_scope_is_subset(profile_grant, root_grant, profile_definition, root_definition) is not true
    or internal.factory_workflow_delegated_scope_is_subset(profile_grant, parent_grant, profile_definition, parent_definition) is not true
    or (route_node ? 'grantId' and not exists (
      select 1 from jsonb_array_elements(execution.workflow_json::jsonb->'grants') declared
      where (declared->>'id', declared->'version') = (root_grant.id::text, to_jsonb(root_grant.version))
        and declared->>'id' = route_node->>'grantId'
    )) then
    raise exception 'The foreman profile exceeds inherited execution authority.' using errcode = '42501';
  end if;
  binding := internal.lock_definition_credential_binding(p_workspace_id, p_factory_id, profile_definition,
    profile_grant.id, profile_grant.service_principal_id);
  select secret.encrypted_value into strict encrypted_credential from public.workspace_secrets secret
  where (secret.workspace_id, secret.id) = (p_workspace_id, binding.workspace_secret_id);

  select pin.* into strict input_pin from public.session_factory_admission_inputs pin
  where (pin.session_id, pin.workspace_id, pin.factory_id) = (parent.id, p_workspace_id, p_factory_id);
  select head.checkpoint_run_id into source_run_id from public.session_git_heads head
  where (head.session_id, head.workspace_id) = (parent.id, p_workspace_id) for share;
  select coalesce(jsonb_agg(jsonb_build_object(
      'childRef', 'child-' || offered.child_session_id,
      'childSessionId', offered.child_session_id,
      'targetOccurrenceId', offered.target_occurrence_id,
      'phaseStatus', offered.phase_status
    ) order by offered.created_at, offered.child_session_id), '[]'::jsonb) into offered_children
  from (
    select marker.child_session_id, marker.target_occurrence_id, marker.created_at, child.phase_status
    from internal.factory_workflow_delegations marker join public.sessions child on child.id = marker.child_session_id
    where (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.parent_session_id) =
      (p_root_session_id, p_workspace_id, p_factory_id, parent.id)
    order by marker.created_at, marker.child_session_id limit 16
  ) offered;

  issue_time := clock_timestamp();
  insert into internal.factory_workflow_foreman_runs (
    root_session_id, route_occurrence_id, workspace_id, factory_id, issued_generation, issued_owner_hash,
    workflow_digest, parent_session_id, source_checkpoint_run_id, offered_children, profile_revision_id, profile_digest,
    prompt_revision_id, prompt_sha256, inference_model, execution_grant_id, execution_grant_version, credential_binding_id,
    reserved_tokens, reserved_cost_usd, issued_at, deadline_at
  ) values (
    p_root_session_id, p_route_occurrence_id, p_workspace_id, p_factory_id, execution.generation,
    sha256(convert_to(p_ownership_token::text, 'UTF8')), execution.workflow_digest, parent.id, source_run_id, offered_children,
    profile.id, profile.canonical_digest, prompt.id, prompt.prompt_sha256, profile_definition#>>'{agent,model}',
    profile_grant.id, profile_grant.version, binding.id, reserved_tokens, reserved_cost_usd, issue_time,
    issue_time + least(root_budget.remaining_execution_ms, 30000) * interval '1 millisecond'
  ) returning * into invocation;

  return jsonb_build_object(
    'status', 'issued', 'foremanRunId', invocation.foreman_run_id, 'issueId', invocation.issue_id,
    'rootSessionId', p_root_session_id, 'workspaceId', p_workspace_id, 'factoryId', p_factory_id,
    'routeOccurrenceId', p_route_occurrence_id, 'routeNodeId', route_node->>'id',
    'workflowDigest', execution.workflow_digest, 'executionGeneration', execution.generation,
    'model', invocation.inference_model, 'promptRevisionId', prompt.id, 'promptSha256', prompt.prompt_sha256,
    'promptMd', prompt.prompt_md, 'encryptedCredential', encrypted_credential,
    'reservedTokens', reserved_tokens, 'reservedCostUsd', reserved_cost_usd,
    'maxInputBytes', 49152, 'maxOutputTokens', least(reserved_tokens, 4096),
    'deadlineAt', invocation.deadline_at,
    'parentSessionId', parent.id, 'sourceCheckpointRunId', source_run_id,
    'title', left(input_pin.original_title, 200), 'taskPromptMd', left(input_pin.original_prompt_md, 12000),
    'allowedDestinationIds', route_policy->'allowedDestinationIds',
    'offeredChildren', offered_children
  );
end;
$$;

create function public.settle_factory_workflow_foreman_inference(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint, p_ownership_token uuid,
  p_route_occurrence_id uuid, p_issue_id uuid, p_outcome jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  invocation internal.factory_workflow_foreman_runs;
  execution internal.factory_workflow_executions;
  root public.sessions;
  workspace_active boolean;
  factory_active boolean;
  next_status text;
  settled_code text;
  received_status text := p_outcome->>'status';
  usage jsonb := p_outcome->'usage';
  received_input_tokens bigint;
  received_output_tokens bigint;
  received_cost numeric;
  effective_input_tokens bigint;
  effective_output_tokens bigint;
  effective_cost numeric;
  lineage_current boolean;
  received_provider_receipt text := p_outcome->>'providerReceiptId';
begin
  if jsonb_typeof(p_outcome) is distinct from 'object'
    or p_outcome - array['status', 'usage', 'code', 'planJson', 'planDigest', 'providerReceiptId'] <> '{}'::jsonb
    or coalesce(received_status, '') not in ('accepted', 'blocked', 'accounting')
    or jsonb_typeof(usage) is distinct from 'object' then
    raise exception 'Invalid foreman settlement.' using errcode = '22023';
  end if;
  if usage - array['inputTokens', 'outputTokens', 'costUsd'] <> '{}'::jsonb
    or not (usage ?& array['inputTokens', 'outputTokens', 'costUsd'])
    or jsonb_typeof(usage->'inputTokens') not in ('null', 'number')
    or jsonb_typeof(usage->'outputTokens') not in ('null', 'number')
    or jsonb_typeof(usage->'costUsd') not in ('null', 'number')
    or coalesce(usage->>'inputTokens', '0') !~ '^(0|[1-9][0-9]{0,15})$'
    or coalesce(usage->>'outputTokens', '0') !~ '^(0|[1-9][0-9]{0,15})$'
    or (received_provider_receipt is not null and (jsonb_typeof(p_outcome->'providerReceiptId') is distinct from 'string'
      or received_provider_receipt collate "C" !~ '^[A-Za-z0-9_.:-]{1,160}$')) then
    raise exception 'Invalid foreman usage receipt.' using errcode = '22023';
  end if;
  received_input_tokens := (usage->>'inputTokens')::bigint;
  received_output_tokens := (usage->>'outputTokens')::bigint;
  received_cost := (usage->>'costUsd')::numeric;
  if received_input_tokens > 9007199254740991 or received_output_tokens > 9007199254740991
    or received_cost not between 0 and 1000000000 then
    raise exception 'Invalid foreman usage receipt.' using errcode = '22023';
  end if;

  if received_status = 'accepted' then
    if p_outcome ? 'code' or jsonb_typeof(p_outcome->'planJson') is distinct from 'string'
      or jsonb_typeof(p_outcome->'planDigest') is distinct from 'string'
      or not internal.is_valid_factory_workflow_foreman_plan(p_outcome->>'planJson', p_outcome->>'planDigest') then
      raise exception 'Invalid foreman plan.' using errcode = '22023';
    end if;
  elsif p_outcome ?| array['planJson', 'planDigest']
    or (received_status = 'blocked' and coalesce(p_outcome->>'code', '') not in (
      'invalid_plan', 'invalid_permit', 'provider_unavailable', 'timeout', 'budget_exhausted'
    ))
    or (received_status = 'accounting' and p_outcome ? 'code') then
    raise exception 'Invalid foreman settlement.' using errcode = '22023';
  end if;

  -- Usage can arrive after ownership loss, cancellation or a factory fence.
  -- Keep the same lock order, but do not require these rows to accept new work.
  select workspace.deletion_requested_at is null into workspace_active from public.workspaces workspace
  where workspace.id = p_workspace_id for share;
  if not found then return null; end if;
  select factory.status = 'active' into factory_active from public.factories factory
  where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id) for share;
  if not found then return null; end if;
  select session.* into root from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (p_root_session_id, p_workspace_id, p_factory_id)
  for no key update;
  if not found then return null; end if;
  select workflow.* into execution from internal.factory_workflow_executions workflow
  where workflow.root_session_id = p_root_session_id for no key update;
  if not found then return null; end if;
  select run.* into invocation from internal.factory_workflow_foreman_runs run
  where (run.root_session_id, run.workspace_id, run.factory_id, run.route_occurrence_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_route_occurrence_id)
  for no key update;
  if not found then return null; end if;
  if p_issue_id is distinct from invocation.issue_id or p_expected_generation is distinct from invocation.issued_generation
    or sha256(convert_to(p_ownership_token::text, 'UTF8')) is distinct from invocation.issued_owner_hash then
    raise exception 'The exact foreman issue capability is required.' using errcode = '42501';
  end if;
  if received_provider_receipt is not null and invocation.provider_receipt_id is not null
    and received_provider_receipt <> invocation.provider_receipt_id then
    raise exception 'The foreman provider receipt conflicts with the original issue.' using errcode = 'PT409';
  end if;
  if invocation.status = 'accepted' and received_status = 'accepted' and
    (p_outcome->>'planJson', p_outcome->>'planDigest') is distinct from (invocation.plan_json, invocation.plan_digest) then
    raise exception 'The foreman issue already accepted a different plan.' using errcode = 'PT409';
  end if;

  effective_input_tokens := greatest(invocation.input_tokens, received_input_tokens);
  effective_output_tokens := greatest(invocation.output_tokens, received_output_tokens);
  effective_cost := greatest(invocation.cost_usd, received_cost);
  if invocation.status = 'issued' then
    if received_status = 'blocked' then
      next_status := 'blocked';
      settled_code := p_outcome->>'code';
    elsif received_status = 'accepted' then
      if invocation.deadline_at <= clock_timestamp() then
        next_status := 'stale';
        settled_code := 'inference_deadline_elapsed';
      elsif workspace_active and factory_active and root.phase_status <> 'rejected'
        and (root.archived_at is null or root.phase_status = 'approved') and root.execute_pinned_definition
        and (execution.generation, execution.ownership_token, execution.workflow_digest) =
          (p_expected_generation, p_ownership_token, invocation.workflow_digest)
        and not exists (select 1 from internal.factory_workflow_node_results result
          where (result.root_session_id, result.occurrence_id) = (p_root_session_id, p_route_occurrence_id)) then
        -- A fence can block the returned plan while the exact issue still owes
        -- its measured usage. The private lineage check raises on revoked grants.
        begin
          lineage_current := internal.recheck_factory_workflow_delegation_lineage(
            p_root_session_id, p_workspace_id, p_factory_id, invocation.parent_session_id
          );
        exception when insufficient_privilege or sqlstate 'PT409' or sqlstate 'PT422' then
          lineage_current := false;
        end;
        if not lineage_current then
          next_status := 'stale';
          settled_code := 'ownership_lost';
        elsif internal.factory_workflow_foreman_usage_exhausted(effective_input_tokens, effective_output_tokens,
          effective_cost, invocation.reserved_tokens, invocation.reserved_cost_usd) then
          next_status := 'blocked';
          settled_code := 'budget_exhausted';
        else
          next_status := 'accepted';
        end if;
      else
        next_status := 'stale';
        settled_code := 'ownership_lost';
      end if;
    end if;
  end if;

  update internal.factory_workflow_foreman_runs run
  set input_tokens = effective_input_tokens,
      output_tokens = effective_output_tokens,
      cost_usd = effective_cost,
      provider_receipt_id = coalesce(run.provider_receipt_id, received_provider_receipt),
      status = coalesce(next_status, run.status),
      blocked_code = coalesce(settled_code, run.blocked_code),
      plan_json = case when next_status = 'accepted' then p_outcome->>'planJson' else run.plan_json end,
      plan_digest = case when next_status = 'accepted' then p_outcome->>'planDigest' else run.plan_digest end,
      settled_at = case when next_status is not null then clock_timestamp() else run.settled_at end
  where run.foreman_run_id = invocation.foreman_run_id returning * into invocation;

  if next_status = 'accepted' then
    insert into internal.factory_workflow_foreman_commands(root_session_id, route_occurrence_id, foreman_run_id, ordinal, command_json)
    select p_root_session_id, p_route_occurrence_id, invocation.foreman_run_id, command.ordinal::smallint, command.body
    from jsonb_array_elements(invocation.plan_json::jsonb->'commands') with ordinality command(body, ordinal);
  end if;
  return internal.factory_workflow_foreman_run_projection(invocation);
end;
$$;

revoke all on function public.begin_factory_workflow_foreman_inference(uuid, uuid, uuid, bigint, uuid, uuid),
  public.settle_factory_workflow_foreman_inference(uuid, uuid, uuid, bigint, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_factory_workflow_foreman_inference(uuid, uuid, uuid, bigint, uuid, uuid),
  public.settle_factory_workflow_foreman_inference(uuid, uuid, uuid, bigint, uuid, uuid, uuid, jsonb) to service_role;

create function public.dispatch_factory_workflow_foreman_command(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_route_occurrence_id uuid, p_foreman_run_id uuid, p_ordinal integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  invocation internal.factory_workflow_foreman_runs;
  command internal.factory_workflow_foreman_commands;
  definition jsonb;
  approved public.factory_execution_grants;
  route_resolution record;
  route_decision uuid;
  target_occurrence uuid;
  prior_route_dest text;
  planned_child jsonb;
  child_id uuid;
  child_job uuid;
  child_run uuid;
  child_phase public.pipeline_phase_status;
  child_receipt record;
  effect jsonb;
  receipt jsonb;
  blocked_code text;
  decision jsonb;
  kind text;
begin
  perform internal.assert_checkpoint_publication_service();
  execution := internal.lock_factory_workflow_owner(
    p_root_session_id, p_workspace_id, p_factory_id, p_expected_generation, p_ownership_token
  );
  select run.* into invocation from internal.factory_workflow_foreman_runs run
  where (run.root_session_id, run.workspace_id, run.factory_id, run.route_occurrence_id, run.foreman_run_id,
    run.workflow_digest) = (p_root_session_id, p_workspace_id, p_factory_id, p_route_occurrence_id,
    p_foreman_run_id, execution.workflow_digest)
  for no key update;
  if not found or invocation.status <> 'accepted' then
    raise exception 'The accepted foreman run is unavailable.' using errcode = 'PT409';
  end if;

  select stored.* into command from internal.factory_workflow_foreman_commands stored
  where (stored.root_session_id, stored.route_occurrence_id, stored.foreman_run_id, stored.ordinal) =
    (p_root_session_id, p_route_occurrence_id, p_foreman_run_id, p_ordinal)
  for update;
  if not found then
    raise exception 'The foreman command is unavailable.' using errcode = 'PT404';
  end if;
  if command.receipt_json is not null then return command.receipt_json; end if;
  if exists (
    select 1 from internal.factory_workflow_foreman_commands before
    where before.foreman_run_id = p_foreman_run_id and before.ordinal < p_ordinal and before.receipt_json is null
  ) then
    raise exception 'An earlier foreman command is unresolved.' using errcode = 'PT409';
  end if;

  if not internal.recheck_factory_workflow_delegation_lineage(
    p_root_session_id, p_workspace_id, p_factory_id, invocation.parent_session_id
  ) then
    raise exception 'The workflow lineage is unavailable for foreman commands.' using errcode = 'PT409';
  end if;
  select revision.definition_json::jsonb into strict definition from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
    (p_workspace_id, p_factory_id, invocation.profile_revision_id, invocation.profile_digest);
  approved := internal.resolve_definition_execution_grant(p_workspace_id, p_factory_id, definition,
    (definition->>'repositoryId')::uuid, (definition->>'executionPolicyRevisionId')::uuid);
  if (approved.id, approved.version, definition->>'credentialBindingId') is distinct from
    (invocation.execution_grant_id, invocation.execution_grant_version, invocation.credential_binding_id::text) then
    raise exception 'The pinned foreman authority is unavailable.' using errcode = '42501';
  end if;
  perform internal.lock_definition_credential_binding(p_workspace_id, p_factory_id, definition,
    approved.id, approved.service_principal_id);

  kind := command.command_json->>'kind';
  if internal.factory_workflow_foreman_usage_exhausted(invocation.input_tokens, invocation.output_tokens, invocation.cost_usd,
    invocation.reserved_tokens, invocation.reserved_cost_usd) then
    blocked_code := 'budget_exhausted';
  elsif kind = 'route' then
    decision := command.command_json->'decision';
    select * into route_resolution from public.admit_factory_workflow_route_decision(
      p_root_session_id, p_workspace_id, p_factory_id, p_expected_generation, p_ownership_token,
      p_route_occurrence_id, decision->>'reason', decision->>'destinationNodeId',
      (decision->>'confidence')::numeric
    );
    if not found then
      return jsonb_build_object('status', 'waiting', 'code', 'route_budget_unavailable');
    end if;
    route_decision := route_resolution.decision_id;
    target_occurrence := route_resolution.target_occurrence_id;
    effect := jsonb_build_object('decisionId', route_decision, 'resolution', route_resolution.resolution,
      'transitionId', route_resolution.transition_id, 'targetOccurrenceId', target_occurrence);
  elsif kind = 'delegate' then
    select prior.decision_id, prior.selected_destination_id, admission.target_occurrence_id
      into route_decision, prior_route_dest, target_occurrence
    from internal.factory_workflow_route_decisions prior
    join internal.factory_workflow_foreman_commands routed
      on (routed.root_session_id, routed.route_occurrence_id, routed.route_decision_id) =
        (prior.root_session_id, prior.route_occurrence_id, prior.decision_id)
    join internal.factory_workflow_transition_receipts admission
      on (admission.root_session_id, admission.source_occurrence_id, admission.edge_id, admission.edge_kind) =
        (prior.root_session_id, prior.route_occurrence_id, prior.selected_edge_id, prior.selected_edge_kind)
    where (prior.root_session_id, prior.route_occurrence_id) = (p_root_session_id, p_route_occurrence_id)
      and (routed.foreman_run_id, routed.ordinal, routed.target_occurrence_id) =
        (p_foreman_run_id, p_ordinal - 1, admission.target_occurrence_id)
      and routed.command_json->>'kind' = 'route' and routed.receipt_json->>'status' = 'accepted';
    if not found or prior_route_dest is distinct from command.command_json->>'targetNodeId' then
      blocked_code := 'no_authorized_target';
    elsif invocation.source_checkpoint_run_id is null then
      blocked_code := 'checkpoint_required';
    else
      select * into strict child_receipt from public.admit_factory_workflow_delegated_session(
        p_root_session_id, p_workspace_id, p_factory_id, p_expected_generation, p_ownership_token,
        invocation.parent_session_id, target_occurrence, invocation.source_checkpoint_run_id,
        command.command_json->>'title', command.command_json->>'promptMd'
      );
      child_id := child_receipt.child_session_id;
      child_job := child_receipt.job_id;
      child_run := child_receipt.run_id;
      effect := jsonb_build_object('decisionId', route_decision, 'targetOccurrenceId', target_occurrence,
        'childSessionId', child_id, 'jobId', child_job, 'runId', child_run);
    end if;
  elsif kind = 'read_child' then
    select offered into planned_child from jsonb_array_elements(invocation.offered_children) offered
    where offered->>'childRef' = command.command_json->>'childRef';
    if found then
      select marker.child_session_id, marker.child_job_id, marker.child_run_id, marker.target_occurrence_id,
        child.phase_status
      into child_id, child_job, child_run, target_occurrence, child_phase
      from internal.factory_workflow_delegations marker
      join public.sessions child on (child.id, child.workspace_id, child.factory_id) =
        (marker.child_session_id, marker.workspace_id, marker.factory_id)
      where (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.parent_session_id,
        marker.child_session_id::text, marker.target_occurrence_id::text) =
        (p_root_session_id, p_workspace_id, p_factory_id, invocation.parent_session_id,
          planned_child->>'childSessionId', planned_child->>'targetOccurrenceId');
    end if;
    if child_id is null then
      blocked_code := 'child_unavailable';
    else
      effect := jsonb_build_object('childSessionId', child_id, 'targetOccurrenceId', target_occurrence,
        'phaseStatus', child_phase);
    end if;
  else
    raise exception 'The foreman command kind is unsupported.' using errcode = 'PT422';
  end if;

  receipt := jsonb_build_object('ordinal', p_ordinal, 'kind', kind)
    || case when blocked_code is null then jsonb_build_object('status', 'accepted') || effect
      else jsonb_build_object('status', 'blocked', 'code', blocked_code)
    end;
  update internal.factory_workflow_foreman_commands stored
  set receipt_json = receipt, route_decision_id = route_decision, target_occurrence_id = target_occurrence,
    child_session_id = child_id, child_job_id = child_job, child_run_id = child_run,
    dispatched_at = clock_timestamp()
  where (stored.foreman_run_id, stored.ordinal) = (p_foreman_run_id, p_ordinal);
  return receipt;
end;
$$;
revoke all on function public.dispatch_factory_workflow_foreman_command(uuid, uuid, uuid, bigint, uuid, uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.dispatch_factory_workflow_foreman_command(uuid, uuid, uuid, bigint, uuid, uuid, uuid, integer)
  to service_role;
