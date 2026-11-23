-- Template provenance belongs to an authoring workflow. Published graph bytes and
-- existing session pins use the same immutable authoring and execution identities.
alter table internal.factory_workflow_authoring_workflows
  add column template_id text,
  add column template_version integer,
  add constraint factory_workflow_template_revision check (
    (template_id is null and template_version is null) or
    (template_id is not null and template_version is not null
      and template_id in ('product-delivery','scoped-fix','incident-analysis') and template_version = 1)
  );

create function internal.preserve_factory_workflow_template() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.template_id,new.template_version) is distinct from (old.template_id,old.template_version) then
    raise exception 'The workflow template revision is immutable.' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger preserve_factory_workflow_template before update of template_id,template_version
  on internal.factory_workflow_authoring_workflows for each row
  execute function internal.preserve_factory_workflow_template();

-- Existing clients keep the five-argument call and create custom workflows.
drop function public.create_factory_workflow_authoring(uuid,uuid,uuid,uuid,text);

create function public.create_factory_workflow_authoring(
  p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid,p_workflow_id uuid,p_display_name text,
  p_template_id text default null,p_template_version integer default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  actor:=internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id,p_factory_id);
  insert into internal.factory_workflow_authoring_workflows(id,workspace_id,factory_id,display_name,created_by_member_id,template_id,template_version)
  values(p_workflow_id,p_workspace_id,p_factory_id,btrim(p_display_name),actor,p_template_id,p_template_version) on conflict(id) do nothing;
  if exists(select 1 from internal.factory_workflow_authoring_workflows
    where (id,workspace_id,factory_id,display_name,created_by_member_id) =
      (p_workflow_id,p_workspace_id,p_factory_id,btrim(p_display_name),actor)
      and (template_id,template_version) is not distinct from (p_template_id,p_template_version))
    then return p_workflow_id; end if;
  raise exception 'Workflow identity is unavailable.' using errcode='PT409';
end;
$$;

revoke all on function public.create_factory_workflow_authoring(uuid,uuid,uuid,uuid,text,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.create_factory_workflow_authoring(uuid,uuid,uuid,uuid,text,text,integer)
  to service_role;

create or replace function public.read_factory_workflow_authoring(
  p_workspace_id uuid,p_factory_id uuid,p_workflow_id uuid,p_selected_draft_id uuid default null
) returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('workflowId',workflow.id,'displayName',workflow.display_name,
    'template',case when workflow.template_id is not null then jsonb_build_object(
      'id',workflow.template_id,'version',workflow.template_version) end,
    'baseDefinition',jsonb_build_object('activationId',base.id,'revisionId',base.revision_id,'digest',base.digest),
    'draftId',draft.id,'activationId',published.id,'draftDigest',draft.workflow_digest,'publishedDraftId',published.draft_id,
    'draftBaseDefinition',case when draft.id is not null then jsonb_build_object('activationId',draft.base_activation_id,
      'revisionId',draft.base_definition_revision_id,'digest',draft.base_definition_digest) end,
    'graph',draft.workflow_json::jsonb,'selectedDraftId',selected.id,
    'selectedDraftGraph',selected.workflow_json::jsonb,'selectedDraftDigest',selected.workflow_digest,
    'selectedDraftBaseDefinition',case when selected.id is not null then jsonb_build_object('activationId',selected.base_activation_id,
      'revisionId',selected.base_definition_revision_id,'digest',selected.base_definition_digest) end,
    'publishedGraphRevisionId',published.graph_revision_id,'recentDrafts',history.drafts)
  from internal.factory_workflow_authoring_workflows workflow
  join public.factories factory on (factory.workspace_id,factory.id)=(workflow.workspace_id,workflow.factory_id)
  left join lateral internal.factory_workflow_authoring_base(workflow.workspace_id,workflow.factory_id) base on true
  left join lateral (select * from internal.factory_workflow_authoring_drafts candidate
    where candidate.workflow_id=workflow.id order by revision_number desc limit 1) draft on true
  left join lateral (select * from internal.factory_workflow_authoring_activations candidate
    where candidate.workflow_id=workflow.id order by activation_number desc limit 1) published on true
  left join internal.factory_workflow_authoring_drafts selected on (selected.workflow_id,selected.id)=(workflow.id,p_selected_draft_id)
  cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object('id',candidate.id,'revision',candidate.revision_number)
      order by candidate.revision_number desc),'[]'::jsonb) as drafts
    from (select id,revision_number from internal.factory_workflow_authoring_drafts
      where workflow_id=workflow.id order by revision_number desc limit 20) candidate
  ) history
  where (workflow.workspace_id,workflow.factory_id,workflow.id)=(p_workspace_id,p_factory_id,p_workflow_id)
    and factory.status='active' and auth.uid() is not null and internal.can_manage_factory(p_workspace_id,p_factory_id)
    and (p_selected_draft_id is null or selected.id is not null)
$$;

-- Product scope enters from OP649's single-stage specification contract. At
-- publication, reject incompatible bases and edits that remove that handoff.
create function internal.assert_factory_product_template_entry() returns trigger
language plpgsql set search_path = '' as $$
declare
  base jsonb;
  plan jsonb;
  entry text;
begin
  if not exists (select 1 from internal.factory_workflow_authoring_workflows workflow
    where (workflow.id,workflow.workspace_id,workflow.factory_id,workflow.template_id,workflow.template_version) =
      (new.workflow_id,new.workspace_id,new.factory_id,'product-delivery',1)) then
    return new;
  end if;

  select revision.definition_json::jsonb,graph.workflow_json::jsonb into strict base,plan
  from internal.factory_workflow_graph_revisions graph
  join public.factory_definition_revisions revision
    on (revision.workspace_id,revision.factory_id,revision.id,revision.canonical_digest) =
      (graph.workspace_id,graph.factory_id,graph.definition_revision_id,graph.definition_digest)
  where (graph.id,graph.workspace_id,graph.factory_id,graph.workflow_digest) =
    (new.graph_revision_id,new.workspace_id,new.factory_id,new.workflow_digest);
  if jsonb_array_length(base->'stages') is distinct from 1
    or base#>>'{implementationAgent,promptRevisionId}' is null then
    raise exception 'Product delivery requires a definition with one specification stage and a named agent.' using errcode = 'PT422';
  end if;
  if exists (select 1 from public.delivery_policy_revisions policy
    where (policy.id,policy.workspace_id,policy.pipeline_id) =
      ((base->>'deliveryPolicyRevisionId')::uuid,new.workspace_id,(base->>'pipelineId')::uuid)
      and policy.requirements->>'deliveryMode' = 'code'
      and policy.requirements->'requireArtifactApprovalForDelivery' = 'true'::jsonb) then
    raise exception 'Product delivery uses its workflow approval gates. The selected specification policy requires a later pipeline stage.' using errcode = 'PT422';
  end if;

  entry := plan->>'entryNodeId';
  if not exists (select 1 from jsonb_array_elements(plan->'nodes') gate
    where (gate->>'id',gate->>'kind') = (entry,'human-gate'))
    or not exists (select 1 from jsonb_array_elements(plan->'edges') edge
      where (edge->>'from',edge->>'kind') = (entry,'next')
        and jsonb_typeof(plan#>array['routePolicy','nodes',edge->>'to','foremanProfile']) = 'object') then
    raise exception 'Product delivery must begin with scope approval followed by a configured Foreman.' using errcode = 'PT422';
  end if;
  return new;
end;
$$;
create trigger assert_factory_product_template_entry before insert on internal.factory_workflow_authoring_activations
  for each row execute function internal.assert_factory_product_template_entry();

create or replace function internal.bind_factory_workflow_intake_selection(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid, p_selection jsonb
) returns void language plpgsql strict set search_path = '' as $$
declare
  root public.sessions;
  pin internal.factory_workflow_authoring_session_pins;
begin
  perform internal.pin_factory_workflow_authoring_session(p_workspace_id, p_factory_id, p_session_id,
    (p_selection->>'workflowId')::uuid, (p_selection->>'activationId')::uuid);
  select selected.* into pin from internal.factory_workflow_authoring_session_pins selected
  join internal.factory_workflow_authoring_workflows workflow
    on (workflow.id,workflow.workspace_id,workflow.factory_id) = (selected.workflow_id,selected.workspace_id,selected.factory_id)
  where (selected.session_id,selected.workspace_id,selected.factory_id,workflow.template_id,workflow.template_version) =
    (p_session_id,p_workspace_id,p_factory_id,'product-delivery',1);
  if not found then return; end if;

  select session.* into strict root from public.sessions session
  where (session.id,session.workspace_id,session.factory_id) = (pin.session_id,pin.workspace_id,pin.factory_id);
  -- This selection is per session. The outer legacy helper uses the current
  -- factory-definition-wide triage configuration instead.
  perform internal.pin_session_specification_stage_before_triage(root);
  perform internal.bind_factory_workflow_triage(pin.session_id,pin.workspace_id,pin.factory_id,
    pin.graph_revision_id,pin.workflow_digest);
end;
$$;

create or replace function internal.guard_factory_workflow_authoring_execution()
returns trigger language plpgsql set search_path = '' as $$
declare
  pin internal.factory_workflow_authoring_session_pins;
  binding internal.factory_workflow_triage_bindings;
begin
  select * into pin from internal.factory_workflow_authoring_session_pins where session_id = new.root_session_id;
  if not found then return new; end if;
  if (new.workspace_id,new.factory_id,new.graph_revision_id,new.workflow_digest) is distinct from
    (pin.workspace_id,pin.factory_id,pin.graph_revision_id,pin.workflow_digest) then
    raise exception 'Execution must use the graph selected at session admission.' using errcode = 'PT409';
  end if;
  if tg_op = 'INSERT' then
    select triage.* into binding from internal.factory_workflow_triage_bindings triage
    where (triage.session_id,triage.workspace_id,triage.factory_id,triage.graph_revision_id,triage.workflow_digest) =
      (pin.session_id,pin.workspace_id,pin.factory_id,pin.graph_revision_id,pin.workflow_digest);
    if found then
      perform internal.assert_factory_workflow_accepted_scope_enrollment(binding,pin.graph_revision_id,
        pin.workflow_digest,new.graph_input_run_id);
    elsif not internal.factory_workflow_authoring_checkpoint_is_ready(
      pin.workspace_id,pin.factory_id,pin.session_id,new.graph_input_run_id
    ) then
      raise exception 'Execution requires the exact adopted preparation checkpoint.' using errcode = 'PT409';
    end if;
  end if;
  return new;
end;
$$;

create or replace function internal.enqueue_factory_workflow_authoring_dispatch()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into internal.factory_workflow_authoring_dispatches(session_id,workspace_id,factory_id,input_run_id,artifact_id)
  select pin.session_id,pin.workspace_id,pin.factory_id,new.run_id,new.artifact_id
  from internal.factory_workflow_authoring_session_pins pin
  where (pin.session_id,pin.workspace_id) = (new.session_id,new.workspace_id)
    -- Approval owns enrollment when this exact pin uses accepted triage scope.
    and not exists (select 1 from internal.factory_workflow_triage_bindings binding
      where (binding.session_id,binding.workspace_id,binding.factory_id,binding.graph_revision_id,binding.workflow_digest) =
        (pin.session_id,pin.workspace_id,pin.factory_id,pin.graph_revision_id,pin.workflow_digest))
    and not exists (select 1 from internal.factory_workflow_executions execution where execution.root_session_id = pin.session_id)
    and internal.factory_workflow_authoring_checkpoint_is_ready(pin.workspace_id,pin.factory_id,pin.session_id,new.run_id)
  on conflict (session_id,input_run_id,occurrence_id) do nothing;
  return new;
end;
$$;

create or replace function internal.queue_factory_workflow_accepted_triage_route() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- An authored pin uses the normal successor dispatcher for its first route.
  if new.edge_kind <> 'next' or exists (
    select 1 from internal.factory_workflow_accepted_scopes scope
    join internal.factory_workflow_authoring_session_pins pin
      on (pin.session_id,pin.workspace_id,pin.factory_id,pin.graph_revision_id,pin.workflow_digest) =
        (scope.session_id,scope.workspace_id,scope.factory_id,scope.graph_revision_id,scope.workflow_digest)
    where scope.session_id = new.root_session_id
  ) then return new; end if;
  insert into internal.factory_workflow_triage_route_dispatches(root_session_id, workspace_id, factory_id, scope_receipt_id, occurrence_id)
  select saved.session_id, saved.workspace_id, saved.factory_id, saved.receipt_id, route.occurrence_id
  from internal.factory_workflow_accepted_scopes saved
  join internal.factory_workflow_executions execution
    on (execution.root_session_id, execution.workspace_id, execution.factory_id, execution.graph_revision_id,
      execution.workflow_digest, execution.graph_input_run_id) =
      (saved.session_id, saved.workspace_id, saved.factory_id, saved.graph_revision_id, saved.workflow_digest, saved.run_id)
  join internal.factory_workflow_node_occurrences gate
    on (gate.root_session_id, gate.occurrence_id, gate.node_kind, gate.is_entry) =
      (saved.session_id, new.source_occurrence_id, 'human-gate', true)
  join internal.factory_workflow_node_results accepted
    on (accepted.root_session_id, accepted.occurrence_id, accepted.result_id, accepted.outcome) =
      (saved.session_id, gate.occurrence_id, new.source_result_id, 'succeeded')
  join internal.factory_workflow_node_occurrences route
    on (route.root_session_id, route.occurrence_id, route.node_kind) =
      (saved.session_id, new.target_occurrence_id, 'route')
  where saved.session_id = new.root_session_id and accepted.evidence_ref = 'human-gate:' || saved.approval_id::text
    and jsonb_typeof(execution.workflow_json::jsonb#>array['routePolicy','nodes',route.node_id,'foremanProfile']) = 'object';
  return new;
end;
$$;

revoke all on function internal.preserve_factory_workflow_template(),
  internal.assert_factory_product_template_entry() from public,anon,authenticated,service_role;
