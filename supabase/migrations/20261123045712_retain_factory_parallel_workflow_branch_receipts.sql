-- Validate branch isolation, then apply the existing bounded route or next-path
-- validator to the graph with each valid branch group represented by one next edge.
create function internal.is_bounded_factory_workflow_branch_graph(p_plan jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  skeleton jsonb;
  total_loop_traversals bigint;
begin
  if jsonb_typeof(p_plan->'nodes') is distinct from 'array'
    or jsonb_typeof(p_plan->'edges') is distinct from 'array'
    or jsonb_array_length(p_plan->'nodes') not between 1 and 128
    or jsonb_array_length(p_plan->'edges') > 512 then
    return false;
  end if;

  with nodes as materialized (
    select node as body, node->>'id' as id, node->>'kind' as kind
    from jsonb_array_elements(p_plan->'nodes') node
  ), edges as materialized (
    select edge as body, edge->>'id' as id, edge->>'kind' as kind, edge->>'from' as source, edge->>'to' as target
    from jsonb_array_elements(p_plan->'edges') edge
  ), arms as materialized (
    select admission.id, admission.source, admission.target, result.target as join_id,
      admission.body->'required' as required
    from edges admission
    left join edges result on result.source = admission.target and result.kind = 'branch-result'
    where admission.kind = 'branch'
  ), groups as (
    select arm.source, min(arm.id) as edge_id, min(arm.join_id) as join_id
    from arms arm group by arm.source
  )
  select jsonb_set(jsonb_set(p_plan, '{nodes}', (
      select jsonb_agg(case when n.kind in ('branch', 'join')
        then jsonb_build_object('id', n.id, 'kind', 'deterministic', 'operation', 'policy') else n.body end)
      from nodes n where not exists (select 1 from arms arm where arm.target = n.id)
    )), '{edges}', (
      select coalesce(jsonb_agg(rest.body), '[]'::jsonb)
      from (
        select e.body from edges e where e.kind not in ('branch', 'branch-result')
        union all
        select jsonb_build_object('id', g.edge_id, 'kind', 'next', 'from', g.source, 'to', g.join_id)
        from groups g
      ) rest
    )),
    (select coalesce(sum(case when e.kind = 'loop' and jsonb_typeof(e.body->'maxTraversals') = 'number'
      and e.body->>'maxTraversals' collate "C" ~ '^(1[0-6]|[1-9])$'
      then (e.body->>'maxTraversals')::integer else 0 end), 0) from edges e)
  into skeleton, total_loop_traversals
  where
    exists (select 1 from groups)
    and (select count(*) = count(distinct n.id) from nodes n)
    and (select count(*) = count(distinct e.id) from edges e)
    and not exists (select 1 from nodes n where jsonb_typeof(n.body->'id') is distinct from 'string'
      or n.id collate "C" !~ '^[a-z0-9]+([.-][a-z0-9]+)*$' or length(n.id) > 96)
    and not exists (select 1 from edges e
      left join nodes source on source.id = e.source left join nodes target on target.id = e.target
      where source.id is null or target.id is null
        or e.kind is null or e.kind not in ('next', 'route', 'loop', 'branch', 'branch-result')
        or jsonb_typeof(e.body->'id') is distinct from 'string'
        or jsonb_typeof(e.body->'from') is distinct from 'string'
        or jsonb_typeof(e.body->'to') is distinct from 'string'
        or e.id collate "C" !~ '^[a-z0-9]+([.-][a-z0-9]+)*$' or length(e.id) > 96
        or (source.kind = 'branch' and e.kind is distinct from 'branch')
        or (e.kind = 'branch' and (source.kind is distinct from 'branch' or target.kind is distinct from 'agent'
          or jsonb_typeof(e.body->'required') is distinct from 'boolean'))
        or (e.kind = 'branch-result' and (target.kind is distinct from 'join'
          or not exists (select 1 from arms arm where arm.target = source.id)))
        or (target.kind = 'join' and e.kind is distinct from 'branch-result'))
    and not exists (select 1 from nodes n where n.kind = 'branch' and (
      (select count(*) from edges e where e.source = n.id and e.kind = 'branch') < 2
      or (select count(distinct join_id) from arms arm where arm.source = n.id) <> 1
      or not exists (select 1 from arms arm where arm.source = n.id and arm.required = 'true'::jsonb)))
    and not exists (select 1 from arms arm where arm.join_id is null
      or arm.target = p_plan->>'entryNodeId'
      or (select count(*) from edges e where e.target = arm.target) <> 1
      or (select count(*) from edges e where e.source = arm.target) <> 1)
    and not exists (select 1 from nodes n where n.kind = 'join' and (
      n.id = p_plan->>'entryNodeId'
      or (select count(distinct source) from arms arm where arm.join_id = n.id) <> 1));

  if skeleton is null or jsonb_array_length(p_plan->'nodes') * (1 + total_loop_traversals) > 1024 then
    return false;
  end if;
  if exists (select 1 from jsonb_array_elements(skeleton->'nodes') node where node->>'kind' = 'route') then
    return internal.is_bounded_factory_workflow_route_graph(skeleton);
  end if;
  return internal.is_bounded_factory_workflow_next_path(skeleton);
end;
$$;
revoke all on function internal.is_bounded_factory_workflow_branch_graph(jsonb)
  from public, anon, authenticated, service_role;
create table internal.factory_workflow_branch_groups (
  root_session_id uuid not null references internal.factory_workflow_executions(root_session_id) on delete cascade,
  group_id uuid not null default gen_random_uuid(),
  branch_occurrence_id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  parent_session_id uuid not null,
  source_checkpoint_run_id uuid not null,
  repository_id uuid not null,
  repository_full_name text not null,
  base_branch text not null,
  initial_base_sha text not null,
  input_sha text not null,
  input_ref text,
  join_node_id text not null,
  created_generation bigint not null check (created_generation between 1 and 9007199254740991),
  created_at timestamptz not null default clock_timestamp(),
  primary key (root_session_id, group_id),
  unique (root_session_id, branch_occurrence_id),
  foreign key (root_session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) deferrable initially deferred,
  foreign key (root_session_id, branch_occurrence_id)
    references internal.factory_workflow_node_occurrences(root_session_id, occurrence_id) deferrable initially deferred,
  foreign key (parent_session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) deferrable initially deferred,
  foreign key (source_checkpoint_run_id) references public.session_git_checkpoints(run_id)
    deferrable initially deferred
);

create table internal.factory_workflow_branch_slots (
  root_session_id uuid not null,
  group_id uuid not null,
  slot_id uuid not null default gen_random_uuid(),
  branch_edge_id text not null,
  required boolean not null,
  target_node_id text not null,
  branch_result_edge_id text not null,
  child_definition_revision_id uuid not null,
  child_definition_digest text not null check (child_definition_digest collate "C" ~ '^[0-9a-f]{64}$'),
  primary key (root_session_id, slot_id),
  unique (root_session_id, group_id, branch_edge_id),
  unique (root_session_id, group_id, target_node_id),
  foreign key (root_session_id, group_id)
    references internal.factory_workflow_branch_groups(root_session_id, group_id) on delete cascade
);

alter table internal.factory_workflow_branch_groups enable row level security;
alter table internal.factory_workflow_branch_slots enable row level security;
revoke all on table internal.factory_workflow_branch_groups, internal.factory_workflow_branch_slots
  from public, anon, authenticated, service_role;

create table internal.factory_workflow_branch_slot_dispatches (
  root_session_id uuid not null,
  slot_id uuid not null,
  last_attempted_at timestamptz,
  terminal_blocker text check (terminal_blocker in (
    'workflow_child_limit', 'workflow_visit_limit_exhausted', 'workflow_child_attempt_limit'
  )),
  primary key (root_session_id, slot_id),
  foreign key (root_session_id, slot_id)
    references internal.factory_workflow_branch_slots(root_session_id, slot_id) on delete cascade
);
alter table internal.factory_workflow_branch_slot_dispatches enable row level security;
revoke all on table internal.factory_workflow_branch_slot_dispatches from public, anon, authenticated, service_role;

create function internal.reject_factory_workflow_branch_manifest_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'The workflow branch manifest is immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.reject_factory_workflow_branch_manifest_update()
  from public, anon, authenticated, service_role;

create trigger freeze_factory_workflow_branch_group before update on internal.factory_workflow_branch_groups
  for each row execute function internal.reject_factory_workflow_branch_manifest_update();
create trigger freeze_factory_workflow_branch_slot before update on internal.factory_workflow_branch_slots
  for each row execute function internal.reject_factory_workflow_branch_manifest_update();

alter table internal.factory_workflow_delegations
  alter column source_route_occurrence_id drop not null,
  alter column source_route_decision_id drop not null,
  add column source_branch_slot_id uuid,
  add constraint factory_workflow_delegations_one_cause check (
    (source_branch_slot_id is null and source_route_occurrence_id is not null and source_route_decision_id is not null)
    or (source_branch_slot_id is not null and source_route_occurrence_id is null and source_route_decision_id is null)
  ),
  add constraint factory_workflow_delegations_branch_slot_fk foreign key (root_session_id, source_branch_slot_id)
    references internal.factory_workflow_branch_slots(root_session_id, slot_id) deferrable initially deferred;
create unique index factory_workflow_delegations_branch_slot_idx
  on internal.factory_workflow_delegations(root_session_id, source_branch_slot_id)
  where source_branch_slot_id is not null;

-- The frozen transition ancestry determines which session owns a fork's source.
create function internal.factory_workflow_branch_source(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_branch_occurrence_id uuid
) returns table(parent_session_id uuid, checkpoint_run_id uuid)
language sql stable set search_path = '' as $$
  with recursive ancestry(occurrence_id, depth) as (
    select p_branch_occurrence_id, 0
    union all
    select transition.source_occurrence_id, ancestry.depth + 1
    from ancestry join internal.factory_workflow_transition_receipts transition
      on (transition.root_session_id, transition.target_occurrence_id) = (p_root_session_id, ancestry.occurrence_id)
    where ancestry.depth < 1023
  ), nearest_delegate as (
    select marker.child_session_id,
      substring(result.evidence_ref from '^delegated-checkpoint:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')::uuid
        as checkpoint_run_id
    from ancestry join internal.factory_workflow_delegations marker
      on (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.target_occurrence_id) =
        (p_root_session_id, p_workspace_id, p_factory_id, ancestry.occurrence_id)
    left join internal.factory_workflow_node_results result
      on (result.root_session_id, result.occurrence_id, result.outcome) =
        (marker.root_session_id, marker.target_occurrence_id, 'succeeded')
    order by ancestry.depth limit 1
  )
  select coalesce(delegate.child_session_id, execution.root_session_id),
    case when delegate.child_session_id is not null then delegate.checkpoint_run_id
      else execution.graph_input_run_id end
  from internal.factory_workflow_executions execution
  left join nearest_delegate delegate on true
  where (execution.root_session_id, execution.workspace_id, execution.factory_id) =
    (p_root_session_id, p_workspace_id, p_factory_id)
$$;
revoke all on function internal.factory_workflow_branch_source(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.open_factory_workflow_branch_group(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_branch_occurrence_id uuid, p_source_checkpoint_run_id uuid
) returns table(group_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_branch_groups;
  plan jsonb;
  branch_node_id text;
  parent_id uuid;
  exact_checkpoint_run_id uuid;
  join_id text;
  source record;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select groups.* into manifest from internal.factory_workflow_branch_groups groups
  where (groups.root_session_id, groups.workspace_id, groups.factory_id, groups.branch_occurrence_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_branch_occurrence_id);
  if found then
    if manifest.source_checkpoint_run_id is distinct from p_source_checkpoint_run_id then
      raise exception 'The branch group already pins a different checkpoint.' using errcode = 'PT409';
    end if;
    return query select manifest.group_id, false;
    return;
  end if;

  select occurrence.node_id into branch_node_id
  from internal.factory_workflow_node_occurrences occurrence
  where (occurrence.root_session_id, occurrence.occurrence_id, occurrence.node_kind) =
    (p_root_session_id, p_branch_occurrence_id, 'branch');
  plan := execution.workflow_json::jsonb;
  if branch_node_id is null or execution.graph_revision_id is null
    or not internal.is_bounded_factory_workflow_branch_graph(plan) then
    raise exception 'A declared branch occurrence is required.' using errcode = 'PT422';
  end if;

  select pin.parent_session_id, pin.checkpoint_run_id into strict parent_id, exact_checkpoint_run_id
  from internal.factory_workflow_branch_source(p_root_session_id, p_workspace_id, p_factory_id, p_branch_occurrence_id) pin;
  if not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id, p_workspace_id, p_factory_id, parent_id) then
    raise exception 'The branch parent is unavailable.' using errcode = 'PT409';
  end if;
  if exact_checkpoint_run_id is null or exact_checkpoint_run_id is distinct from p_source_checkpoint_run_id then
    raise exception 'Branching requires the exact accepted parent checkpoint.'
      using errcode = 'PT409', detail = 'workflow_branch_source_changed';
  end if;
  perform 1 from public.session_git_heads head
  where (head.session_id, head.workspace_id, head.checkpoint_run_id) =
    (parent_id, p_workspace_id, p_source_checkpoint_run_id)
  for share;
  if not found then
    if exists (select 1 from public.session_git_checkpoints checkpoint
      where (checkpoint.run_id, checkpoint.session_id, checkpoint.workspace_id) =
        (exact_checkpoint_run_id, parent_id, p_workspace_id)) then
      raise exception 'The accepted parent checkpoint changed before branching.'
        using errcode = 'PT409', detail = 'workflow_branch_source_changed';
    end if;
    raise exception 'Branching requires the exact accepted parent checkpoint.' using errcode = 'PT409';
  end if;
  select * into strict source from internal.checkpoint_execution_input(p_source_checkpoint_run_id, parent_id, p_workspace_id);

  select distinct result_edge->>'to' into strict join_id
  from jsonb_array_elements(plan->'edges') branch_edge
  join lateral jsonb_array_elements(plan->'edges') result_edge
    on result_edge->>'kind' = 'branch-result' and result_edge->>'from' = branch_edge->>'to'
  where branch_edge->>'kind' = 'branch' and branch_edge->>'from' = branch_node_id;
  insert into internal.factory_workflow_branch_groups(
    root_session_id, branch_occurrence_id, workspace_id, factory_id, parent_session_id, source_checkpoint_run_id,
    repository_id, repository_full_name, base_branch, initial_base_sha, input_sha, input_ref, join_node_id, created_generation
  ) values (
    p_root_session_id, p_branch_occurrence_id, p_workspace_id, p_factory_id, parent_id, p_source_checkpoint_run_id,
    source.repository_id, source.repository_full_name, source.base_branch, source.initial_base_sha, source.input_sha,
    source.input_ref, join_id, execution.generation
  ) returning * into manifest;

  insert into internal.factory_workflow_branch_slots(
    root_session_id, group_id, branch_edge_id, required, target_node_id, branch_result_edge_id,
    child_definition_revision_id, child_definition_digest
  )
  select p_root_session_id, manifest.group_id, branch_edge->>'id', (branch_edge->>'required')::boolean,
    branch_edge->>'to', output->>'id', (target.profile->>'definitionRevisionId')::uuid, target.profile->>'definitionDigest'
  from jsonb_array_elements(plan->'edges') branch_edge
  join lateral jsonb_array_elements(plan->'edges') output
    on output->>'kind' = 'branch-result' and output->>'from' = branch_edge->>'to'
  cross join lateral (select plan#>array['delegationPolicy', 'targets', branch_edge->>'to'] as profile) target
  where branch_edge->>'kind' = 'branch' and branch_edge->>'from' = branch_node_id;
  perform internal.insert_factory_workflow_node_result(execution, p_branch_occurrence_id, 'succeeded',
    'branch-manifest:' || manifest.group_id);
  return query select manifest.group_id, true;
end;
$$;
revoke all on function public.open_factory_workflow_branch_group(uuid, uuid, uuid, bigint, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.open_factory_workflow_branch_group(uuid, uuid, uuid, bigint, uuid, uuid, uuid)
  to service_role;
create function internal.create_factory_workflow_child(
  execution internal.factory_workflow_executions, p_parent_session_id uuid, p_target_occurrence_id uuid,
  p_target_node_id text, p_source_checkpoint_run_id uuid, source_repository_id uuid,
  p_source_transition_id uuid, p_source_route_occurrence_id uuid, p_source_route_decision_id uuid,
  p_source_branch_slot_id uuid, p_title text, p_prompt_md text, intent_title_hash text, intent_prompt_hash text
) returns table(child_session_id uuid, job_id uuid, run_id uuid, created boolean)
language plpgsql set search_path = '' as $$
declare
  p_root_session_id uuid := execution.root_session_id;
  p_workspace_id uuid := execution.workspace_id;
  p_factory_id uuid := execution.factory_id;
  root public.sessions;
  parent public.sessions;
  plan jsonb;
  target_node jsonb;
  target_profile jsonb;
  existing_children bigint;
  child_profile public.factory_definition_revisions;
  root_definition jsonb;
  parent_definition jsonb;
  child_definition jsonb;
  actual_child_definition jsonb;
  root_grant public.factory_execution_grants;
  parent_grant public.factory_execution_grants;
  child_grant public.factory_execution_grants;
  actor internal.session_mutation_actor;
  child record;
begin
  select session.* into strict root from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (p_root_session_id, p_workspace_id, p_factory_id);
  select session.* into strict parent from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (p_parent_session_id, p_workspace_id, p_factory_id);
  plan := execution.workflow_json::jsonb;
  select node into strict target_node from jsonb_array_elements(plan->'nodes') node where node->>'id' = p_target_node_id;
  target_profile := plan#>array['delegationPolicy', 'targets', p_target_node_id];
  select count(*) into existing_children from internal.factory_workflow_delegations receipt
  where receipt.root_session_id = p_root_session_id;
  if existing_children >= (plan#>>'{delegationPolicy,maxChildren}')::integer then
    raise exception 'The workflow root has no remaining delegated child capacity.'
      using errcode = 'PT409', detail = 'workflow_child_limit';
  end if;
  select revision.* into child_profile from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id::text, revision.canonical_digest) =
    (p_workspace_id, p_factory_id, target_profile->>'definitionRevisionId', target_profile->>'definitionDigest')
    and exists (select 1 from public.factory_definition_activations activation
      where (activation.workspace_id, activation.factory_id, activation.revision_id) =
        (revision.workspace_id, revision.factory_id, revision.id));
  child_definition := child_profile.definition_json::jsonb;
  if not found or child_definition#>>'{implementationAgent,promptRevisionId}' is distinct from target_node->>'agentPromptRevisionId'
    or child_definition#>>'{implementationAgent,agentId}' is null
    or child_definition->>'repositoryId' is distinct from source_repository_id::text then
    raise exception 'The frozen child profile does not match the declared agent and parent source.' using errcode = 'PT422';
  end if;
  if exists (select 1 from public.delivery_policy_revisions delivery
    where (delivery.id::text, delivery.workspace_id) = (child_definition->>'deliveryPolicyRevisionId', p_workspace_id)
      and delivery.requirements->>'deliveryMode' = 'code'
      and delivery.requirements->'requireArtifactApprovalForDelivery' = 'true'::jsonb) then
    raise exception 'The child delivery policy requires a pull request that delegated children cannot publish.' using errcode = 'PT422';
  end if;

  root_definition := internal.pinned_session_execution_definition(root);
  select grant_row.* into root_grant from public.session_factory_admission_inputs pin
  join public.factory_execution_grants grant_row on (grant_row.workspace_id, grant_row.factory_id, grant_row.id, grant_row.version) =
    (pin.workspace_id, pin.factory_id, pin.execution_grant_id, pin.execution_grant_version)
  where pin.session_id = root.id;
  if parent.id = root.id then
    parent_definition := root_definition;
    parent_grant := root_grant;
  else
    parent_definition := internal.pinned_session_execution_definition(parent);
    select grant_row.* into parent_grant from public.session_factory_admission_inputs pin
    join public.factory_execution_grants grant_row on (grant_row.workspace_id, grant_row.factory_id, grant_row.id, grant_row.version) =
      (pin.workspace_id, pin.factory_id, pin.execution_grant_id, pin.execution_grant_version)
    where pin.session_id = parent.id;
  end if;
  child_grant := internal.resolve_definition_execution_grant(p_workspace_id, p_factory_id, child_definition,
    source_repository_id, (child_definition->>'executionPolicyRevisionId')::uuid);
  -- The route declaration authorizes the root envelope. The frozen child
  -- profile may bind a distinct grant contained within this envelope.
  if internal.factory_workflow_delegated_scope_is_subset(child_grant, root_grant, child_definition, root_definition) is not true
    or internal.factory_workflow_delegated_scope_is_subset(child_grant, parent_grant, child_definition, parent_definition) is not true
    or (target_node ? 'grantId' and not exists (
      select 1 from jsonb_array_elements(plan->'grants') declared
      where (declared->>'id', declared->'version') = (root_grant.id::text, to_jsonb(root_grant.version))
        and declared->>'id' = target_node->>'grantId'
    )) then
    raise exception 'The frozen child profile exceeds inherited execution authority.' using errcode = '42501';
  end if;
  perform internal.lock_definition_credential_binding(p_workspace_id, p_factory_id, child_definition,
    child_grant.id, child_grant.service_principal_id);

  actor := row(p_workspace_id, p_factory_id, null, child_grant.service_principal_id, null,
    child_grant.id, child_grant.version, source_repository_id, null)::internal.session_mutation_actor;
  select * into strict child from internal.create_attributed_session_from_profile(
    p_workspace_id, null, p_title, p_prompt_md, child_definition#>>'{agent,provider}', child_definition#>>'{agent,model}',
    null, null, source_repository_id, null, null, actor, (child_definition#>>'{implementationAgent,agentId}')::uuid,
    child_profile.canonical_digest, child_profile.id);
  select internal.pinned_session_execution_definition(session) into strict actual_child_definition
  from public.sessions session where session.id = child.session_id;
  if actual_child_definition is distinct from child_definition then
    raise exception 'The admitted child must retain the exact frozen execution profile.' using errcode = 'PT422';
  end if;

  insert into internal.factory_workflow_delegations (
    child_session_id, workspace_id, factory_id, root_session_id, parent_session_id, target_occurrence_id,
    source_route_occurrence_id, source_route_decision_id, source_transition_id, source_checkpoint_run_id, source_branch_slot_id,
    child_definition_revision_id, child_definition_digest, child_job_id, child_run_id,
    title_sha256, prompt_sha256, recorded_generation
  ) values (
    child.session_id, p_workspace_id, p_factory_id, p_root_session_id, parent.id, p_target_occurrence_id,
    p_source_route_occurrence_id, p_source_route_decision_id, p_source_transition_id, p_source_checkpoint_run_id, p_source_branch_slot_id,
    child_profile.id, child_profile.canonical_digest, child.job_id, child.run_id,
    intent_title_hash, intent_prompt_hash, execution.generation
  );
  perform internal.prepare_session_job_git_input(child.job_id);
  if not internal.reserve_factory_workflow_attempt(execution, child.session_id, child.job_id, 1) then
    raise exception 'The workflow root has no remaining child attempt capacity.'
      using errcode = 'PT409', detail = 'workflow_child_attempt_limit';
  end if;
  return query select child.session_id::uuid, child.job_id::uuid, child.run_id::uuid, true;
end;
$$;
revoke all on function internal.create_factory_workflow_child(
  internal.factory_workflow_executions, uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated, service_role;


create or replace function public.admit_factory_workflow_delegated_session(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint, p_ownership_token uuid,
  p_parent_session_id uuid, p_target_occurrence_id uuid, p_source_checkpoint_run_id uuid, p_title text, p_prompt_md text
) returns table (child_session_id uuid, job_id uuid, run_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  prior internal.factory_workflow_delegations;
  arrival record;
  parent public.sessions;
  expected_parent_id uuid;
  source_repository_id uuid;
  intent_title_hash text;
  intent_prompt_hash text;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  if p_title is null or char_length(btrim(p_title)) not between 1 and 200
    or p_prompt_md is null or char_length(btrim(p_prompt_md)) not between 1 and 20000 then
    raise exception 'A bounded delegated title and prompt are required.' using errcode = '22023';
  end if;
  intent_title_hash := encode(sha256(convert_to(btrim(p_title), 'UTF8')), 'hex');
  intent_prompt_hash := encode(sha256(convert_to(btrim(p_prompt_md), 'UTF8')), 'hex');

  select receipt.* into prior from internal.factory_workflow_delegations receipt
  where (receipt.root_session_id, receipt.target_occurrence_id) = (p_root_session_id, p_target_occurrence_id);
  if found then
    if prior.source_branch_slot_id is not null then
      raise exception 'A branch child requires its declared branch slot.' using errcode = '42501';
    end if;
    if (prior.parent_session_id, prior.source_checkpoint_run_id, prior.title_sha256, prior.prompt_sha256) is distinct from
      (p_parent_session_id, p_source_checkpoint_run_id, intent_title_hash, intent_prompt_hash) then
      raise exception 'The workflow occurrence was already delegated with different input.' using errcode = 'PT409';
    end if;
    return query select prior.child_session_id, prior.child_job_id, prior.child_run_id, false;
    return;
  end if;

  select transition.transition_id, transition.source_occurrence_id, decision.decision_id, target.node_id into arrival
  from internal.factory_workflow_transition_receipts transition
  join internal.factory_workflow_route_decisions decision
    on (decision.root_session_id, decision.route_occurrence_id, decision.selected_edge_id, decision.selected_edge_kind) =
      (transition.root_session_id, transition.source_occurrence_id, transition.edge_id, transition.edge_kind)
  join internal.factory_workflow_node_results result
    on (result.root_session_id, result.occurrence_id, result.result_id) =
      (transition.root_session_id, transition.source_occurrence_id, transition.source_result_id)
  join internal.factory_workflow_node_occurrences target
    on (target.root_session_id, target.occurrence_id, target.node_id) =
      (transition.root_session_id, transition.target_occurrence_id, decision.selected_destination_id)
  where (transition.root_session_id, transition.target_occurrence_id, target.node_kind) =
    (p_root_session_id, p_target_occurrence_id, 'agent') and transition.edge_kind in ('route', 'loop')
    and result.outcome = 'succeeded' and result.evidence_ref = 'route:' || decision.decision_id;
  if not found or execution.graph_revision_id is null then
    raise exception 'An exact routed agent occurrence is required for delegation.' using errcode = 'PT409';
  end if;

  -- Walk occurrence identities, not node IDs. A loop creates new occurrences,
  -- and a sibling's checkpoint cannot become the parent of this route.
  with recursive ancestry(occurrence_id, distance) as (
    select arrival.source_occurrence_id, 0
    union all
    select transition.source_occurrence_id, ancestry.distance + 1
    from ancestry join internal.factory_workflow_transition_receipts transition
      on (transition.root_session_id, transition.target_occurrence_id) = (p_root_session_id, ancestry.occurrence_id)
    where ancestry.distance < 1023
  )
  select coalesce((select marker.child_session_id from ancestry join internal.factory_workflow_delegations marker
    on (marker.root_session_id, marker.target_occurrence_id) = (p_root_session_id, ancestry.occurrence_id)
    order by ancestry.distance limit 1), p_root_session_id) into expected_parent_id;
  if p_parent_session_id is distinct from expected_parent_id then
    raise exception 'The parent does not own the routed occurrence.' using errcode = '42501';
  end if;

  if not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id, p_workspace_id, p_factory_id, p_parent_session_id) then
    raise exception 'The root or parent is unavailable for delegation.' using errcode = 'PT409';
  end if;
  select session.* into strict parent from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (p_parent_session_id, p_workspace_id, p_factory_id);
  select checkpoint.repository_id into source_repository_id from public.session_git_heads head
  join public.session_git_checkpoints checkpoint
    on (checkpoint.run_id, checkpoint.session_id, checkpoint.workspace_id) = (head.checkpoint_run_id, head.session_id, head.workspace_id)
  where (head.session_id, head.workspace_id, head.checkpoint_run_id) = (parent.id, p_workspace_id, p_source_checkpoint_run_id)
  for share of head;
  if not found then
    raise exception 'Delegation requires the parent’s current accepted checkpoint.' using errcode = 'PT409';
  end if;

  return query select * from internal.create_factory_workflow_child(
    execution, p_parent_session_id, p_target_occurrence_id, arrival.node_id, p_source_checkpoint_run_id,
    source_repository_id, arrival.transition_id, arrival.source_occurrence_id, arrival.decision_id, null,
    p_title, p_prompt_md, intent_title_hash, intent_prompt_hash);
end;
$$;


create or replace function internal.is_enrollable_factory_workflow_delegation(
  p_workspace_id uuid, p_factory_id uuid, p_plan jsonb
) returns boolean
language plpgsql stable set search_path = '' as $$
declare
  policy jsonb := p_plan->'delegationPolicy';
  targets jsonb := policy->'targets';
  agent_count integer;
begin
  select count(*) into agent_count from jsonb_array_elements(p_plan->'nodes') node
  where node->>'kind' = 'agent';
  if agent_count = 0 and not exists (
    select 1 from jsonb_array_elements(p_plan->'nodes') node
    where node->>'kind' = 'route'
      and p_plan #> array['routePolicy', 'nodes', node->>'id', 'foremanProfile'] is not null
  ) then
    return policy is null;
  end if;
  if jsonb_typeof(policy) is distinct from 'object' or jsonb_typeof(targets) is distinct from 'object' then
    return false;
  end if;
  if policy - array['targets', 'maxChildren', 'maxConcurrentChildren', 'maxAttempts',
      'maxTotalTokens', 'maxTokensPerAttempt', 'maxCostUsd', 'maxCostUsdPerAttempt'] <> '{}'::jsonb
    or (select count(*) from jsonb_object_keys(targets)) <> agent_count then
    return false;
  end if;

  if exists (select 1 from unnest(array['maxChildren', 'maxConcurrentChildren', 'maxAttempts',
      'maxTotalTokens', 'maxTokensPerAttempt']) as limit_key(name)
    where jsonb_typeof(policy->limit_key.name) is distinct from 'number'
      or (policy->>limit_key.name) collate "C" !~ '^[1-9][0-9]{0,12}$')
    or jsonb_typeof(policy->'maxCostUsd') is distinct from 'number'
    or jsonb_typeof(policy->'maxCostUsdPerAttempt') is distinct from 'number' then
    return false;
  end if;

  if (policy->>'maxAttempts')::bigint > 1024
    or (policy->>'maxChildren')::bigint > (policy->>'maxAttempts')::bigint
    or (policy->>'maxConcurrentChildren')::bigint > (policy->>'maxChildren')::bigint
    or (policy->>'maxTotalTokens')::bigint > 1000000000000
    or (policy->>'maxTokensPerAttempt')::bigint > (policy->>'maxTotalTokens')::bigint
    or (policy->>'maxCostUsd')::numeric not between 0.000001 and 1000000
    or (policy->>'maxCostUsdPerAttempt')::numeric not between 0.000001 and (policy->>'maxCostUsd')::numeric then
    return false;
  end if;

  return not exists (
    select 1 from jsonb_array_elements(p_plan->'nodes') node
    where node->>'kind' = 'agent' and (
      node->>'id' = p_plan->>'entryNodeId'
      or exists (select 1 from jsonb_array_elements(p_plan->'edges') edge
        where edge->>'to' = node->>'id' and edge->>'kind' not in ('route', 'loop', 'branch'))
      or not exists (
        select 1 from jsonb_each(targets) target
        join public.factory_definition_revisions revision on
          (revision.workspace_id, revision.factory_id, revision.id::text, revision.canonical_digest) =
          (p_workspace_id, p_factory_id, target.value->>'definitionRevisionId', target.value->>'definitionDigest')
        where target.key = node->>'id'
          and jsonb_typeof(target.value) = 'object'
          and jsonb_typeof(target.value->'definitionRevisionId') = 'string'
          and jsonb_typeof(target.value->'definitionDigest') = 'string'
          and target.value - array['definitionRevisionId', 'definitionDigest'] = '{}'::jsonb
          and revision.definition_json::jsonb#>>'{implementationAgent,promptRevisionId}' = node->>'agentPromptRevisionId'
          and revision.definition_json::jsonb ?& array['executionGrant', 'credentialBindingId']
          and not (revision.definition_json::jsonb ? 'modelRouting')
          and exists (select 1 from public.factory_definition_activations activation
            where (activation.workspace_id, activation.factory_id, activation.revision_id) =
              (revision.workspace_id, revision.factory_id, revision.id))
      )
    )
  );
end;
$$;

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
  has_branches boolean;
  triage internal.factory_workflow_triage_bindings;
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
  select binding.* into triage from internal.factory_workflow_triage_bindings binding
  where (binding.session_id, binding.workspace_id, binding.factory_id) =
    (p_root_session_id, p_workspace_id, p_factory_id);
  if found then
    perform internal.assert_factory_workflow_accepted_scope_enrollment(triage, graph.id, graph.workflow_digest, p_input_run_id);
  elsif exists (select 1 from public.sessions session
    where session.id = p_root_session_id and session.archived_at is not null) then
    raise exception 'The graph revision must match an active session definition pin.' using errcode = 'PT409';
  end if;

  -- Existing command and route capabilities, plus guarded routed child admission.
  plan := graph.workflow_json::jsonb;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node
    where coalesce(node->>'kind', '') not in ('deterministic', 'human-gate', 'route', 'agent', 'branch', 'join')
      or (node->>'kind' = 'deterministic' and coalesce(node->>'operation', '') not in ('validation', 'policy', 'checkpoint'))) then
    raise exception 'The graph requires workflow capabilities that are unavailable.' using errcode = 'PT422';
  end if;
  has_branches := exists (select 1 from jsonb_array_elements(plan->'nodes') node
    where node->>'kind' in ('branch', 'join'));
  if has_branches and not internal.is_bounded_factory_workflow_branch_graph(plan) then
    raise exception 'The graph must match a bounded workflow branch topology.' using errcode = 'PT422';
  end if;
  if not internal.is_enrollable_factory_workflow_delegation(p_workspace_id, p_factory_id, plan) then
    raise exception 'The graph requires bounded delegation and exact scoped child profiles.' using errcode = 'PT422';
  end if;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node where node->>'kind' = 'route') then
    if not has_branches and not internal.is_bounded_factory_workflow_route_graph(plan) then
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
  elsif not has_branches and not internal.is_bounded_factory_workflow_next_path(plan) then
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
  if p_input_run_id is null and (has_branches or exists (
    select 1 from jsonb_array_elements(plan->'nodes') node
    where node->>'kind' = 'human-gate' or node->>'operation' in ('validation', 'checkpoint')
  )) then
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
  if execution.graph_revision_id is not null and node_kind in ('branch', 'join') then
    raise exception 'This workflow node requires a guarded branch or join result.' using errcode = '42501';
  end if;
  if execution.graph_revision_id is not null and node_kind = 'agent' then
    raise exception 'A delegated agent result requires bound child-session evidence.' using errcode = '42501';
  end if;
  return query select * from internal.insert_factory_workflow_node_result(execution, p_occurrence_id, p_outcome, p_evidence_ref);
end;
$$;

create or replace function public.record_factory_workflow_delegated_result(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_occurrence_id uuid
) returns table (result_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  delegation internal.factory_workflow_delegations;
  prior internal.factory_workflow_node_results;
  completion_ref text;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  if execution.graph_revision_id is null or not exists (
    select 1 from internal.factory_workflow_node_occurrences occurrence
    where (occurrence.root_session_id, occurrence.occurrence_id, occurrence.node_kind) =
      (p_root_session_id, p_occurrence_id, 'agent')
  ) then
    raise exception 'Workflow delegated agent occurrence is unavailable.' using errcode = 'PT404';
  end if;

  select marker.* into delegation from internal.factory_workflow_delegations marker
  where (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.target_occurrence_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_occurrence_id);
  if not found then return; end if;
  if delegation.source_branch_slot_id is not null then
    raise exception 'A branch child requires its declared branch outcome.' using errcode = '42501';
  end if;

  select result.* into prior from internal.factory_workflow_node_results result
  where (result.root_session_id, result.occurrence_id) = (p_root_session_id, p_occurrence_id);
  if found then
    if prior.outcome <> 'succeeded' or not coalesce(prior.evidence_ref collate "C" ~
      '^delegated-checkpoint:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) then
      raise exception 'The workflow node already has a different result.' using errcode = 'PT409';
    end if;
    return query select prior.result_id, false;
    return;
  end if;

  completion_ref := internal.factory_workflow_delegated_completion_ref(delegation);
  if completion_ref is null then return; end if;
  return query select * from internal.insert_factory_workflow_node_result(execution, p_occurrence_id, 'succeeded', completion_ref);
end;
$$;
create function public.admit_factory_workflow_branch_slot(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_group_id uuid, p_branch_edge_id text
) returns table(target_occurrence_id uuid, child_session_id uuid, job_id uuid, run_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_branch_groups;
  slot internal.factory_workflow_branch_slots;
  prior internal.factory_workflow_delegations;
  transition internal.factory_workflow_transition_receipts;
  predecessor_result_id uuid;
  occurrence_id uuid;
  decision_edge jsonb;
  target jsonb;
  parent_input public.session_factory_admission_inputs;
  terminal_blocker text;
  title text;
  prompt text;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select groups.* into manifest from internal.factory_workflow_branch_groups groups
  where (groups.root_session_id, groups.workspace_id, groups.factory_id, groups.group_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_group_id);
  if not found then raise exception 'The workflow branch group is unavailable.' using errcode = 'PT404'; end if;
  select slots.* into slot from internal.factory_workflow_branch_slots slots
  where (slots.root_session_id, slots.group_id, slots.branch_edge_id) =
    (p_root_session_id, p_group_id, p_branch_edge_id);
  if not found then raise exception 'The workflow branch slot is unavailable.' using errcode = 'PT404'; end if;
  select marker.* into prior from internal.factory_workflow_delegations marker
  where (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.source_branch_slot_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, slot.slot_id);
  if found then
    return query select prior.target_occurrence_id, prior.child_session_id, prior.child_job_id, prior.child_run_id, false;
    return;
  end if;
  select state.terminal_blocker into terminal_blocker
  from internal.factory_workflow_branch_slot_dispatches state
  where (state.root_session_id, state.slot_id) = (p_root_session_id, slot.slot_id);
  if terminal_blocker is not null then
    raise exception 'The workflow branch slot has reached its lifetime limit.'
      using errcode = 'PT409', detail = terminal_blocker;
  end if;

  -- Ready mandatory work takes the next capacity within this group.
  if not slot.required and exists (
    select 1 from internal.factory_workflow_branch_slots pending
    where (pending.root_session_id, pending.group_id) = (p_root_session_id, p_group_id)
      and pending.required and not exists (
        select 1 from internal.factory_workflow_delegations marker
        where (marker.root_session_id, marker.source_branch_slot_id) = (p_root_session_id, pending.slot_id)
      )
  ) then return; end if;

  if not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id, p_workspace_id, p_factory_id, manifest.parent_session_id) then
    raise exception 'The branch parent is unavailable.' using errcode = 'PT409';
  end if;
  select edge into strict decision_edge from jsonb_array_elements(execution.workflow_json::jsonb->'edges') edge
  where edge->>'id' = slot.branch_edge_id and edge->>'kind' = 'branch' and edge->>'to' = slot.target_node_id;
  target := execution.workflow_json::jsonb#>array['delegationPolicy', 'targets', slot.target_node_id];
  if (target->>'definitionRevisionId', target->>'definitionDigest') is distinct from
    (slot.child_definition_revision_id::text, slot.child_definition_digest) then
    raise exception 'The frozen branch target profile is unavailable.' using errcode = 'PT409';
  end if;
  select result.result_id into strict predecessor_result_id from internal.factory_workflow_node_results result
  where (result.root_session_id, result.occurrence_id, result.evidence_ref) =
    (p_root_session_id, manifest.branch_occurrence_id, 'branch-manifest:' || manifest.group_id)
    and result.outcome = 'succeeded';
  perform internal.assert_factory_workflow_route_capacity(execution, decision_edge);

  select pin.* into strict parent_input from public.session_factory_admission_inputs pin
  where (pin.session_id, pin.workspace_id, pin.factory_id) = (manifest.parent_session_id, p_workspace_id, p_factory_id);
  title := left('Branch ' || slot.target_node_id || ': ' || parent_input.original_title, 200);
  prompt := left(btrim(parent_input.original_prompt_md), 20000);

  -- The root's initial intake may contradict the clarified scope. Its branch
  -- task comes from the exact approved scope. Nested branches retain the
  -- narrower task already assigned to their immediate parent.
  if manifest.parent_session_id = p_root_session_id and exists (
    select 1 from internal.factory_workflow_triage_bindings binding
    where (binding.session_id, binding.workspace_id, binding.factory_id) =
      (p_root_session_id, p_workspace_id, p_factory_id)
  ) then
    title := 'Branch ' || slot.target_node_id;
    select saved.scope->>'scope' into prompt from internal.factory_workflow_accepted_scopes saved
    where (saved.session_id, saved.workspace_id, saved.factory_id, saved.graph_revision_id, saved.workflow_digest, saved.run_id) =
      (p_root_session_id, p_workspace_id, p_factory_id, execution.graph_revision_id, execution.workflow_digest,
        manifest.source_checkpoint_run_id)
      and saved.run_id = execution.graph_input_run_id;
    if not found or prompt is null then
      raise exception 'The branch task requires its exact approved scope.' using errcode = 'PT409';
    end if;
  end if;

  insert into internal.factory_workflow_node_occurrences(root_session_id, node_id, node_kind, admitted_generation)
  values (p_root_session_id, slot.target_node_id, 'agent', execution.generation)
  returning factory_workflow_node_occurrences.occurrence_id into occurrence_id;
  insert into internal.factory_workflow_transition_receipts(
    root_session_id, source_occurrence_id, edge_id, source_result_id, edge_kind, target_occurrence_id, recorded_generation
  ) values (
    p_root_session_id, manifest.branch_occurrence_id, slot.branch_edge_id, predecessor_result_id, 'branch', occurrence_id,
    execution.generation
  ) returning * into transition;

  return query select occurrence_id, child.* from internal.create_factory_workflow_child(
    execution, manifest.parent_session_id, occurrence_id, slot.target_node_id, manifest.source_checkpoint_run_id,
    manifest.repository_id, transition.transition_id, null, null, slot.slot_id, title, prompt,
    encode(sha256(convert_to(btrim(title), 'UTF8')), 'hex'),
    encode(sha256(convert_to(btrim(prompt), 'UTF8')), 'hex')
  ) child;
end;
$$;
revoke all on function public.admit_factory_workflow_branch_slot(uuid, uuid, uuid, bigint, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admit_factory_workflow_branch_slot(uuid, uuid, uuid, bigint, uuid, uuid, text)
  to service_role;
create table internal.factory_workflow_branch_outcomes (
  root_session_id uuid not null,
  slot_id uuid not null,
  outcome_id uuid not null default gen_random_uuid(),
  outcome public.factory_workflow_node_outcome not null,
  child_session_id uuid not null,
  job_id uuid not null,
  attempt_count integer not null check (attempt_count >= 0),
  run_id uuid,
  run_started boolean not null,
  checkpoint_run_id uuid,
  artifact_id uuid,
  attempt_input_sha text,
  output_sha text,
  retained_ref text,
  recorded_generation bigint not null check (recorded_generation between 1 and 9007199254740991),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (root_session_id, slot_id),
  unique (root_session_id, outcome_id),
  check (
    (run_started and attempt_count > 0 and run_id is not null)
    or (not run_started and (outcome = 'canceled' or (outcome = 'failed' and attempt_count > 0)))
  ),
  check (
    (outcome = 'succeeded' and checkpoint_run_id is not null and checkpoint_run_id = run_id and artifact_id is not null
      and attempt_input_sha is not null and output_sha is not null)
    or (outcome in ('failed', 'canceled') and checkpoint_run_id is null and artifact_id is null
      and attempt_input_sha is null and output_sha is null and retained_ref is null)
  ),
  foreign key (root_session_id, slot_id) references internal.factory_workflow_branch_slots(root_session_id, slot_id)
    on delete cascade,
  foreign key (child_session_id) references public.sessions(id) deferrable initially deferred,
  foreign key (checkpoint_run_id) references public.session_git_checkpoints(run_id) deferrable initially deferred
);
alter table internal.factory_workflow_branch_outcomes enable row level security;
revoke all on table internal.factory_workflow_branch_outcomes from public, anon, authenticated, service_role;
create trigger freeze_factory_workflow_branch_outcome before update on internal.factory_workflow_branch_outcomes
  for each row execute function internal.reject_factory_workflow_branch_manifest_update();

-- The OP650 before-insert guard owns the child session lock before a fresh job
-- can pass this check. An attempted same-job requeue owns the exact job lock.
create function internal.reject_factory_workflow_terminal_branch_job()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('queued', 'started', 'running') and exists (
    select 1 from internal.factory_workflow_delegations marker
    join internal.factory_workflow_branch_outcomes result
      on (result.root_session_id, result.slot_id) = (marker.root_session_id, marker.source_branch_slot_id)
    where (marker.child_session_id, marker.workspace_id) = (new.session_id, new.workspace_id)
  ) then
    raise exception 'The workflow branch slot already has a terminal outcome.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke all on function internal.reject_factory_workflow_terminal_branch_job()
  from public, anon, authenticated, service_role;
create trigger reject_factory_workflow_terminal_branch_job before insert or update of status on public.agent_jobs
  for each row execute function internal.reject_factory_workflow_terminal_branch_job();

-- The timestamp can tie when a pause and resume occur in one transaction.
-- Prefer the active job, then use the explicit lifecycle generation for ties.
create function internal.factory_workflow_branch_current_job(
  p_root_session_id uuid, p_workspace_id uuid, p_child_session_id uuid
) returns public.agent_jobs language sql stable set search_path = '' as $$
  select job.*
  from public.agent_jobs job
  join public.sessions owner on (owner.id, owner.workspace_id) = (job.session_id, job.workspace_id)
  left join public.session_git_heads head on (head.session_id, head.workspace_id) = (owner.id, owner.workspace_id)
  left join public.session_git_checkpoints checkpoint on checkpoint.run_id = head.checkpoint_run_id
  where (job.session_id, job.workspace_id) = (p_child_session_id, p_workspace_id)
  order by (job.status in ('queued', 'started', 'running')) desc,
    coalesce(owner.phase_status = 'approved' and checkpoint.job_id = job.id, false) desc,
    job.created_at desc,
    coalesce((select max(command.applied_generation)
      from internal.factory_workflow_lifecycle_commands command
      cross join lateral jsonb_array_elements(command.receipt->'resumed') resumed
      where command.root_session_id = p_root_session_id and command.action = 'resume'
        and resumed->>'jobId' = job.id::text), 0) desc,
    job.id desc
  limit 1
$$;
revoke all on function internal.factory_workflow_branch_current_job(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- Resume requeues the same job and leaves the old claim counter in place until
-- the next claim. Cancellation during that window has no new execution to use.
create function internal.factory_workflow_branch_resume_waits_for_claim(
  p_root_session_id uuid, p_job public.agent_jobs
) returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from internal.factory_workflow_lifecycle_commands command
    cross join lateral jsonb_array_elements(command.receipt->'resumed') resumed
    where command.root_session_id = p_root_session_id and command.action = 'resume'
      and (resumed->>'jobId', resumed->>'attemptCount') = (p_job.id::text, (p_job.attempt_count + 1)::text)
  )
$$;
revoke all on function internal.factory_workflow_branch_resume_waits_for_claim(uuid, public.agent_jobs)
  from public, anon, authenticated, service_role;

create function internal.factory_workflow_branch_terminal_run(
  p_root_session_id uuid, p_job public.agent_jobs
) returns public.agent_runs language sql stable set search_path = '' as $$
  select run.*
  from public.agent_runs run
  where (run.agent_job_id, run.workspace_id, run.session_id) = (p_job.id, p_job.workspace_id, p_job.session_id)
    and (
      (p_job.status not in ('error', 'canceled') and run.attempt_count = p_job.attempt_count)
      or (p_job.status = 'error' and run.status = 'error' and
        (run.attempt_count = p_job.attempt_count or run.attempt_count is null))
      or (p_job.status = 'canceled'
        and not internal.factory_workflow_branch_resume_waits_for_claim(p_root_session_id, p_job)
        and ((run.attempt_count = p_job.attempt_count and run.status in ('canceled', 'success'))
          or (run.attempt_count is null and run.status = 'canceled')))
    )
  order by run.attempt_count desc nulls last, run.created_at desc, run.id desc
  limit 1
$$;
revoke all on function internal.factory_workflow_branch_terminal_run(uuid, public.agent_jobs)
  from public, anon, authenticated, service_role;

create function public.record_factory_workflow_branch_outcome(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_group_id uuid, p_branch_edge_id text, p_job_id uuid, p_attempt_count integer, p_run_id uuid
) returns table(outcome_id uuid, outcome public.factory_workflow_node_outcome, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_branch_groups;
  slot internal.factory_workflow_branch_slots;
  marker internal.factory_workflow_delegations;
  receipt internal.factory_workflow_branch_outcomes;
  child public.sessions;
  job public.agent_jobs;
  run public.agent_runs;
  terminal_run_id uuid;
  checkpoint public.session_git_checkpoints;
  verified_retained_ref text;
  completion_ref text;
  branch_outcome public.factory_workflow_node_outcome;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select groups.* into manifest from internal.factory_workflow_branch_groups groups
  where (groups.root_session_id, groups.workspace_id, groups.factory_id, groups.group_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_group_id);
  if not found then raise exception 'The workflow branch group is unavailable.' using errcode = 'PT404'; end if;
  select slots.* into slot from internal.factory_workflow_branch_slots slots
  where (slots.root_session_id, slots.group_id, slots.branch_edge_id) =
    (p_root_session_id, p_group_id, p_branch_edge_id);
  if not found then raise exception 'The workflow branch slot is unavailable.' using errcode = 'PT404'; end if;

  select stored.* into receipt from internal.factory_workflow_branch_outcomes stored
  where (stored.root_session_id, stored.slot_id) = (p_root_session_id, slot.slot_id);
  if found then
    if (receipt.job_id, receipt.attempt_count, receipt.run_id) is distinct from (p_job_id, p_attempt_count, p_run_id) then
      raise exception 'The branch slot already has a different terminal attempt.' using errcode = 'PT409';
    end if;
    return query select receipt.outcome_id, receipt.outcome, false;
    return;
  end if;

  select delegation.* into marker from internal.factory_workflow_delegations delegation
  where (delegation.root_session_id, delegation.workspace_id, delegation.factory_id, delegation.source_branch_slot_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, slot.slot_id);
  if not found then return; end if;
  if not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id, p_workspace_id, p_factory_id, manifest.parent_session_id) then
    raise exception 'The branch parent is unavailable.' using errcode = 'PT409';
  end if;
  select session.* into strict child from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (marker.child_session_id, p_workspace_id, p_factory_id)
  for no key update;
  select current_job.* into job from public.agent_jobs current_job
  where current_job.id = (internal.factory_workflow_branch_current_job(p_root_session_id, p_workspace_id, child.id)).id
  for update;
  if not found or (job.id, job.attempt_count) is distinct from (p_job_id, p_attempt_count) then
    raise exception 'The exact current branch attempt is unavailable.' using errcode = 'PT409';
  end if;
  terminal_run_id := (internal.factory_workflow_branch_terminal_run(p_root_session_id, job)).id;
  if terminal_run_id is distinct from p_run_id or
    (terminal_run_id is null and job.status not in ('error', 'canceled')) then
    raise exception 'The exact current branch attempt is unavailable.' using errcode = 'PT409';
  end if;
  if terminal_run_id is not null then
    select exact_run.* into run from public.agent_runs exact_run where exact_run.id = terminal_run_id for share;
    if not found then raise exception 'The exact current branch attempt is unavailable.' using errcode = 'PT409'; end if;
  end if;

  if job.status = 'success' and run.status = 'success' then
    perform internal.recheck_session_execution_grant(child);
    completion_ref := internal.factory_workflow_delegated_completion_ref(marker);
    if completion_ref is distinct from 'delegated-checkpoint:' || run.id then return; end if;
    select accepted.* into strict checkpoint from public.session_git_checkpoints accepted
    where (accepted.run_id, accepted.session_id, accepted.workspace_id) = (run.id, child.id, p_workspace_id);
    select source.input_ref into strict verified_retained_ref
    from internal.checkpoint_execution_input(run.id, child.id, p_workspace_id) source;
    branch_outcome := 'succeeded';
  elsif (job.status = 'error' and (run.id is null or run.status = 'error'))
    or (job.status = 'canceled' and (run.id is null or run.status = 'canceled')) then
    -- Pause retirement is provisional while the child can resume. An explicit
    -- archive prevents resume and leaves the exact retired cancellation final.
    if child.phase_status = 'approved' or (
      child.archived_at is null
      and not internal.factory_workflow_branch_resume_waits_for_claim(p_root_session_id, job) and exists (
        select 1 from internal.factory_workflow_lifecycle_commands command
        cross join lateral jsonb_array_elements(command.receipt->'retired') retired
        cross join lateral jsonb_array_elements(retired->'jobs') attempt
        where command.root_session_id = p_root_session_id and command.action = 'pause'
          and (attempt->>'jobId', attempt->>'attemptCount') = (job.id::text, job.attempt_count::text)
      )
    ) then return; end if;
    branch_outcome := case when job.status = 'error' then 'failed' else 'canceled' end;
  else
    return;
  end if;

  insert into internal.factory_workflow_branch_outcomes(
    root_session_id, slot_id, outcome, child_session_id, job_id, attempt_count, run_id, run_started,
    checkpoint_run_id, artifact_id, attempt_input_sha, output_sha, retained_ref, recorded_generation
  ) values (
    p_root_session_id, slot.slot_id, branch_outcome, child.id, job.id, p_attempt_count, run.id,
    run.attempt_count is not null, checkpoint.run_id, checkpoint.artifact_id, checkpoint.input_sha, checkpoint.output_sha,
    verified_retained_ref, execution.generation
  ) returning * into receipt;
  perform internal.insert_factory_workflow_node_result(execution, marker.target_occurrence_id,
    branch_outcome, 'branch-outcome:' || receipt.outcome_id);
  return query select receipt.outcome_id, receipt.outcome, true;
end;
$$;
revoke all on function public.record_factory_workflow_branch_outcome(uuid, uuid, uuid, bigint, uuid, uuid, text, uuid, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.record_factory_workflow_branch_outcome(uuid, uuid, uuid, bigint, uuid, uuid, text, uuid, integer, uuid)
  to service_role;

create function public.read_factory_workflow_branch_group(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_group_id uuid
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('manifest', to_jsonb(manifest), 'lifecycleStatus', execution.lifecycle_status,
    'joinStatus', case
      when execution.lifecycle_status <> 'running' then execution.lifecycle_status
      when slots.required_failure then 'required_blocked'
      when slots.pending then 'pending'
      when slots.optional_failure then 'optional_failure'
      else 'ready'
    end,
    'slots', slots.payload)
  from internal.factory_workflow_branch_groups manifest
  join internal.factory_workflow_executions execution on execution.root_session_id = manifest.root_session_id
  cross join lateral (
    select bool_or(slot.required and (terminal.outcome <> 'succeeded' or state.terminal_blocker is not null)) as required_failure,
      bool_or(not slot.required and (terminal.outcome <> 'succeeded' or state.terminal_blocker is not null)) as optional_failure,
      bool_or(terminal.outcome is null and state.terminal_blocker is null) as pending,
      jsonb_agg(jsonb_build_object(
        'slot', to_jsonb(slot),
        'admission', case when admitted.child_session_id is not null then jsonb_build_object(
          'childSessionId', admitted.child_session_id, 'targetOccurrenceId', admitted.target_occurrence_id,
          'jobId', admitted.child_job_id, 'runId', admitted.child_run_id) end,
        'currentAttempt', case when activity.job_id is not null then jsonb_build_object(
          'jobId', activity.job_id, 'runId', activity.run_id, 'attemptCount', activity.attempt_count,
          'jobStatus', activity.job_status) end,
        'outcome', to_jsonb(terminal),
        'admissionBlocker', state.terminal_blocker
      ) order by slot.required desc, slot.branch_edge_id) as payload
    from internal.factory_workflow_branch_slots slot
    left join internal.factory_workflow_branch_slot_dispatches state
      on (state.root_session_id, state.slot_id) = (slot.root_session_id, slot.slot_id)
    left join internal.factory_workflow_delegations admitted
      on (admitted.root_session_id, admitted.source_branch_slot_id) = (slot.root_session_id, slot.slot_id)
    left join lateral (
      select job.id as job_id,
        case when job.status = 'queued' then job.attempt_count + 1 else job.attempt_count end as attempt_count,
        job.status as job_status, case when job.status in ('error', 'canceled')
          then (internal.factory_workflow_branch_terminal_run(manifest.root_session_id, job)).id
          else (
            select run.id from public.agent_runs run
            where (run.agent_job_id, run.session_id, run.workspace_id) = (job.id, job.session_id, job.workspace_id)
              and (job.status = 'queued' and run.status = 'queued' and run.attempt_count is null
                or job.status <> 'queued' and run.attempt_count = job.attempt_count)
            order by run.created_at desc, run.id desc limit 1
          )
        end as run_id
      from internal.factory_workflow_branch_current_job(
        manifest.root_session_id, manifest.workspace_id, admitted.child_session_id) job
      where job.id is not null
    ) activity on true
    left join internal.factory_workflow_branch_outcomes terminal
      on (terminal.root_session_id, terminal.slot_id) = (slot.root_session_id, slot.slot_id)
    where (slot.root_session_id, slot.group_id) = (manifest.root_session_id, manifest.group_id)
  ) slots
  where (manifest.root_session_id, manifest.workspace_id, manifest.factory_id, manifest.group_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_group_id)
$$;
revoke all on function public.read_factory_workflow_branch_group(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.read_factory_workflow_branch_group(uuid, uuid, uuid, uuid) to service_role;

-- Discover newly admitted forks after restart. A dispatch transaction acts only
-- with the current root capability and does not cross a remote-I/O boundary.
create table internal.factory_workflow_branch_dispatches (
  root_session_id uuid not null,
  branch_occurrence_id uuid not null,
  due_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  primary key (root_session_id, branch_occurrence_id),
  foreign key (root_session_id, branch_occurrence_id)
    references internal.factory_workflow_node_occurrences(root_session_id, occurrence_id) on delete cascade
);
create index factory_workflow_branch_dispatch_due_idx
  on internal.factory_workflow_branch_dispatches(due_at, root_session_id, branch_occurrence_id)
  where completed_at is null;
alter table internal.factory_workflow_branch_dispatches enable row level security;
revoke all on table internal.factory_workflow_branch_dispatches from public, anon, authenticated, service_role;

create function internal.queue_factory_workflow_branch_occurrence()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into internal.factory_workflow_branch_dispatches(root_session_id, branch_occurrence_id)
  values (new.root_session_id, new.occurrence_id) on conflict do nothing;
  return new;
end;
$$;
revoke all on function internal.queue_factory_workflow_branch_occurrence()
  from public, anon, authenticated, service_role;
create trigger queue_factory_workflow_branch_occurrence after insert on internal.factory_workflow_node_occurrences
  for each row when (new.node_kind = 'branch') execute function internal.queue_factory_workflow_branch_occurrence();

-- The caller owns the root lock. Check whether one more reservation exceeds
-- the caps even after all unbound holds release and provisional usage falls.
-- The canonical admission check still accounts for those holds and concurrency.
create function internal.factory_workflow_branch_attempt_budget_exhausted(
  p_execution internal.factory_workflow_executions
) returns boolean language sql stable set search_path = '' as $$
  with policy as (
    select p_execution.workflow_json::jsonb->'delegationPolicy' as graph_limits
  ), caps as (
    select (policy.graph_limits->>'maxAttempts')::integer as max_attempts,
      (policy.graph_limits->>'maxTokensPerAttempt')::bigint as next_tokens,
      (policy.graph_limits->>'maxCostUsdPerAttempt')::numeric as next_cost,
      least((policy.graph_limits->>'maxTotalTokens')::bigint,
        (revision.requirements->>'maxTotalTokens')::bigint) as max_tokens,
      least((policy.graph_limits->>'maxCostUsd')::numeric,
        (revision.requirements->>'maxCostUsd')::numeric) as max_cost
    from policy cross join public.sessions root
    left join public.execution_policy_revisions revision
      on (revision.workspace_id, revision.id) = (root.workspace_id, root.execution_policy_revision_id)
    where (root.id, root.workspace_id, root.factory_id) =
      (p_execution.root_session_id, p_execution.workspace_id, p_execution.factory_id)
  ), committed_attempts as (
    -- Binding makes the attempt count durable. Exact measured reservation
    -- receipts can only grow, even if they arrive after cancellation.
    select case when reservation.token_provenance = 'measured' then reservation.reported_tokens end as tokens,
      case when reservation.cost_provenance = 'measured' then reservation.reported_cost_usd end as cost
    from internal.factory_workflow_attempt_reservations reservation
    where reservation.root_session_id = p_execution.root_session_id and reservation.run_id is not null
    union all
    -- Match the canonical pre-enrollment root fallback exactly. Its legacy
    -- writer can replace measurements while a run is still active.
    select case when run.status in ('success', 'error', 'canceled') and run.token_provenance = 'measured'
        then run.input_tokens::numeric + run.output_tokens end,
      case when run.status in ('success', 'error', 'canceled') and run.cost_provenance = 'measured'
        then run.total_cost_usd end
    from public.agent_runs run
    where run.session_id = p_execution.root_session_id and run.attempt_count > 0
      and not exists (
        select 1 from internal.factory_workflow_attempt_reservations reservation
        where (reservation.job_id, reservation.attempt_count) = (run.agent_job_id, run.attempt_count)
      )
    union all
    -- Foreman issues are one-shot and their observed usage only increases.
    -- A partial receipt proves its known token components, not the hold.
    select coalesce(invocation.input_tokens, 0)::numeric + coalesce(invocation.output_tokens, 0), invocation.cost_usd
    from internal.factory_workflow_foreman_runs invocation
    where invocation.root_session_id = p_execution.root_session_id
  ), committed as (
    select count(*) as attempts, coalesce(sum(tokens), 0) as tokens, coalesce(sum(cost), 0) as cost
    from committed_attempts
  )
  select coalesce((
    select committed.attempts + 1 > caps.max_attempts
      or committed.tokens + caps.next_tokens > caps.max_tokens
      or committed.cost + caps.next_cost > caps.max_cost
    from caps cross join committed
  ), false)
$$;
revoke all on function internal.factory_workflow_branch_attempt_budget_exhausted(internal.factory_workflow_executions)
  from public, anon, authenticated, service_role;

create function public.advance_factory_workflow_branch_occurrence(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid,
  p_expected_generation bigint, p_ownership_token uuid, p_occurrence_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  dispatch internal.factory_workflow_branch_dispatches;
  pending_slot record;
  manifest_id uuid;
  input_run_id uuid;
  group_state jsonb;
  current_blocker text;
  admission_blocker text;
begin
  perform internal.assert_checkpoint_publication_service();
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select candidate.* into dispatch from internal.factory_workflow_branch_dispatches candidate
  where candidate.root_session_id = p_root_session_id and candidate.branch_occurrence_id = coalesce((
    select transition.source_occurrence_id from internal.factory_workflow_transition_receipts transition
    where (transition.root_session_id, transition.target_occurrence_id, transition.edge_kind) =
      (p_root_session_id, p_occurrence_id, 'branch')
  ), p_occurrence_id) for update;
  if not found then return null; end if;

  select manifest.group_id into manifest_id from internal.factory_workflow_branch_groups manifest
  where (manifest.root_session_id, manifest.branch_occurrence_id) = (p_root_session_id, dispatch.branch_occurrence_id);
  if manifest_id is null then
    select pin.checkpoint_run_id into input_run_id from internal.factory_workflow_branch_source(
      p_root_session_id, p_workspace_id, p_factory_id, dispatch.branch_occurrence_id
    ) pin;
    if input_run_id is null then
      update internal.factory_workflow_branch_dispatches candidate
      set due_at = clock_timestamp() + interval '10 seconds'
      where (candidate.root_session_id, candidate.branch_occurrence_id) = (p_root_session_id, dispatch.branch_occurrence_id);
      return null;
    end if;
    begin
      select opened.group_id into strict manifest_id from public.open_factory_workflow_branch_group(
        p_root_session_id, p_workspace_id, p_factory_id, execution.generation, execution.ownership_token,
        dispatch.branch_occurrence_id, input_run_id
      ) opened;
    exception when sqlstate 'PT409' or insufficient_privilege then
      get stacked diagnostics current_blocker = pg_exception_detail;
      update internal.factory_workflow_branch_dispatches candidate
      set due_at = clock_timestamp() + interval '10 seconds'
      where (candidate.root_session_id, candidate.branch_occurrence_id) = (p_root_session_id, dispatch.branch_occurrence_id);
      if current_blocker = 'workflow_branch_source_changed' then
        return jsonb_build_object('blocker', current_blocker);
      end if;
      return null;
    end;
  end if;

  if dispatch.completed_at is null then
    -- Observe exact current attempts, including a replacement after resume.
    -- An approved checkpoint or an exact terminal failure is still validated
    -- by the native recorder before it creates an immutable result.
    for pending_slot in
      select slot.branch_edge_id, job.id as job_id, job.attempt_count, run.id as run_id
      from internal.factory_workflow_branch_slots slot
      join internal.factory_workflow_delegations marker
        on (marker.root_session_id, marker.source_branch_slot_id) = (slot.root_session_id, slot.slot_id)
      join public.sessions child on (child.workspace_id, child.id) = (marker.workspace_id, marker.child_session_id)
      cross join lateral internal.factory_workflow_branch_current_job(slot.root_session_id, child.workspace_id, child.id) job
      left join lateral internal.factory_workflow_branch_terminal_run(p_root_session_id, job) run on true
      where (slot.root_session_id, slot.group_id) = (p_root_session_id, manifest_id)
        and (job.status = 'success' and child.phase_status = 'approved' and run.status = 'success'
          or job.status = 'error' and (run.id is null or run.status = 'error')
          or job.status = 'canceled' and (run.id is null or run.status = 'canceled'))
        and not exists (select 1 from internal.factory_workflow_branch_outcomes outcome
          where (outcome.root_session_id, outcome.slot_id) = (slot.root_session_id, slot.slot_id))
      order by slot.required desc, slot.branch_edge_id
    loop
      begin
        perform public.record_factory_workflow_branch_outcome(
          p_root_session_id, p_workspace_id, p_factory_id, execution.generation, execution.ownership_token,
          manifest_id, pending_slot.branch_edge_id, pending_slot.job_id, pending_slot.attempt_count, pending_slot.run_id
        );
      exception when sqlstate 'PT409' or insufficient_privilege then
        -- A child can be retried after this scan. Reobserve its current exact
        -- attempt on the next tick while continuing to process other slots.
        continue;
      end;
    end loop;

    -- Required slots use capacity first. Within each tier, defer recently
    -- attempted slots so a slot-specific rejection cannot starve siblings.
    for pending_slot in
      select slot.slot_id, slot.branch_edge_id from internal.factory_workflow_branch_slots slot
      left join internal.factory_workflow_branch_slot_dispatches state
        on (state.root_session_id, state.slot_id) = (slot.root_session_id, slot.slot_id)
      where (slot.root_session_id, slot.group_id) = (p_root_session_id, manifest_id)
        and state.terminal_blocker is null
        and not exists (select 1 from internal.factory_workflow_delegations marker
          where (marker.root_session_id, marker.source_branch_slot_id) = (slot.root_session_id, slot.slot_id))
      order by slot.required desc, state.last_attempted_at asc nulls first, slot.branch_edge_id
      limit 8
    loop
      insert into internal.factory_workflow_branch_slot_dispatches(root_session_id, slot_id, last_attempted_at)
      values (p_root_session_id, pending_slot.slot_id, clock_timestamp())
      on conflict (root_session_id, slot_id) do update set last_attempted_at = excluded.last_attempted_at;
      begin
        perform public.admit_factory_workflow_branch_slot(
          p_root_session_id, p_workspace_id, p_factory_id, execution.generation, execution.ownership_token,
          manifest_id, pending_slot.branch_edge_id
        );
      exception when sqlstate 'PT409' or sqlstate 'PT422' or insufficient_privilege then
        get stacked diagnostics current_blocker = pg_exception_detail;
        if current_blocker in ('workflow_visit_limit_exhausted', 'workflow_child_limit')
          or (current_blocker = 'workflow_child_attempt_limit'
            and internal.factory_workflow_branch_attempt_budget_exhausted(execution)) then
          insert into internal.factory_workflow_branch_slot_dispatches(root_session_id, slot_id, terminal_blocker)
          select slot.root_session_id, slot.slot_id, current_blocker
          from internal.factory_workflow_branch_slots slot
          where (slot.root_session_id, slot.group_id) = (p_root_session_id, manifest_id)
            and not exists (select 1 from internal.factory_workflow_delegations marker
              where (marker.root_session_id, marker.source_branch_slot_id) = (slot.root_session_id, slot.slot_id))
          on conflict (root_session_id, slot_id) do update set terminal_blocker = excluded.terminal_blocker
            where factory_workflow_branch_slot_dispatches.terminal_blocker is null;
          admission_blocker := current_blocker;
          exit;
        end if;
        if current_blocker = 'workflow_child_attempt_limit' then
          admission_blocker := current_blocker;
          exit;
        end if;
        admission_blocker := 'workflow_branch_admission_unavailable';
      end;
    end loop;

    update internal.factory_workflow_branch_dispatches candidate
    set due_at = clock_timestamp() + interval '10 seconds',
      completed_at = case when not exists (
        select 1 from internal.factory_workflow_branch_slots slot
        left join internal.factory_workflow_branch_slot_dispatches state
          on (state.root_session_id, state.slot_id) = (slot.root_session_id, slot.slot_id)
        left join internal.factory_workflow_branch_outcomes outcome
          on (outcome.root_session_id, outcome.slot_id) = (slot.root_session_id, slot.slot_id)
        where (slot.root_session_id, slot.group_id) = (p_root_session_id, manifest_id)
          and state.terminal_blocker is null and outcome.outcome_id is null
      ) then clock_timestamp() end
    where (candidate.root_session_id, candidate.branch_occurrence_id) = (p_root_session_id, dispatch.branch_occurrence_id);
  end if;

  group_state := public.read_factory_workflow_branch_group(p_root_session_id, p_workspace_id, p_factory_id, manifest_id);
  return jsonb_strip_nulls(jsonb_build_object(
    'groupId', manifest_id, 'joinStatus', group_state->>'joinStatus', 'admissionBlocker', admission_blocker
  ));
end;
$$;
revoke all on function public.advance_factory_workflow_branch_occurrence(uuid, uuid, uuid, bigint, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.advance_factory_workflow_branch_occurrence(uuid, uuid, uuid, bigint, uuid, uuid)
  to service_role;

create function public.dispatch_next_factory_workflow_branch()
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  candidate record;
  execution internal.factory_workflow_executions;
  checked_at timestamptz := clock_timestamp();
begin
  perform internal.assert_checkpoint_publication_service();
  for candidate in
    select dispatch.root_session_id, workflow.workspace_id, workflow.factory_id, dispatch.branch_occurrence_id
    from internal.factory_workflow_branch_dispatches dispatch
    join internal.factory_workflow_executions workflow using (root_session_id)
    join public.workspaces workspace on workspace.id = workflow.workspace_id
    join public.factories factory on (factory.workspace_id, factory.id) = (workflow.workspace_id, workflow.factory_id)
    where dispatch.completed_at is null and dispatch.due_at <= checked_at
      and workflow.lifecycle_status = 'running' and workspace.deletion_requested_at is null and factory.status = 'active'
    order by dispatch.due_at, dispatch.root_session_id, dispatch.branch_occurrence_id
    limit 16
  loop
    perform 1 from public.workspaces workspace where workspace.id = candidate.workspace_id
      and workspace.deletion_requested_at is null for share skip locked;
    if not found then continue; end if;
    perform 1 from public.factories factory where (factory.workspace_id, factory.id, factory.status) =
      (candidate.workspace_id, candidate.factory_id, 'active') for share skip locked;
    if not found then continue; end if;
    perform 1 from public.sessions root where (root.id, root.workspace_id, root.factory_id) =
      (candidate.root_session_id, candidate.workspace_id, candidate.factory_id) for no key update skip locked;
    if not found then continue; end if;
    select workflow.* into execution from internal.factory_workflow_executions workflow
    where workflow.root_session_id = candidate.root_session_id and workflow.lifecycle_status = 'running'
    for no key update skip locked;
    if not found then continue; end if;
    perform 1 from internal.factory_workflow_branch_dispatches dispatch
    where (dispatch.root_session_id, dispatch.branch_occurrence_id) = (candidate.root_session_id, candidate.branch_occurrence_id)
      and dispatch.completed_at is null and dispatch.due_at <= checked_at for update skip locked;
    if not found then continue; end if;

    perform public.advance_factory_workflow_branch_occurrence(
      candidate.root_session_id, candidate.workspace_id, candidate.factory_id,
      execution.generation, execution.ownership_token, candidate.branch_occurrence_id
    );
    return true;
  end loop;
  return false;
end;
$$;
revoke all on function public.dispatch_next_factory_workflow_branch() from public, anon, authenticated, service_role;
grant execute on function public.dispatch_next_factory_workflow_branch() to service_role;
