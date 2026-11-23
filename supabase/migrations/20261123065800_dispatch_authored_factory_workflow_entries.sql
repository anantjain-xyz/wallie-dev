-- Adoption is the only producer of an authored workflow entry. A leased
-- maintenance transaction enrolls the frozen graph from the adopted source.
create table internal.factory_workflow_authoring_dispatches (
  session_id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  input_run_id uuid not null references public.session_checkpoint_publications(run_id) on delete cascade,
  artifact_id uuid not null,
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_id uuid unique,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  primary key (session_id, input_run_id),
  foreign key (session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) on delete cascade,
  check ((lease_id is null) = (lease_expires_at is null)),
  check (completed_at is null or lease_id is null)
);
create index factory_workflow_authoring_dispatches_due
  on internal.factory_workflow_authoring_dispatches(next_attempt_at, session_id)
  where completed_at is null;
alter table internal.factory_workflow_authoring_dispatches enable row level security;
revoke all on table internal.factory_workflow_authoring_dispatches from public, anon, authenticated, service_role;

create function internal.factory_workflow_authoring_checkpoint_is_ready(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid, p_input_run_id uuid
) returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.sessions root
    join public.session_factory_admission_inputs admission
      on (admission.workspace_id, admission.factory_id, admission.session_id) =
        (root.workspace_id, root.factory_id, root.id)
    join public.session_git_heads head
      on (head.workspace_id, head.session_id, head.checkpoint_run_id) = (root.workspace_id, root.id, p_input_run_id)
    join public.session_checkpoint_publications publication
      on (publication.workspace_id, publication.session_id, publication.run_id) =
        (head.workspace_id, head.session_id, head.checkpoint_run_id)
    where (root.workspace_id, root.factory_id, root.id) = (p_workspace_id, p_factory_id, p_session_id)
      and root.archived_at is null and root.phase_status = 'awaiting_review'
      and root.current_stage_id = admission.selected_stage_ids[cardinality(admission.selected_stage_ids)]
      and publication.status = 'adopted' and publication.artifact_id = root.current_artifact_id
  )
$$;

create or replace function internal.guard_factory_workflow_authoring_execution()
returns trigger language plpgsql set search_path = '' as $$
declare pin internal.factory_workflow_authoring_session_pins;
begin
  select * into pin from internal.factory_workflow_authoring_session_pins where session_id = new.root_session_id;
  if not found then return new; end if;
  if (new.workspace_id,new.factory_id,new.graph_revision_id,new.workflow_digest) is distinct from
    (pin.workspace_id,pin.factory_id,pin.graph_revision_id,pin.workflow_digest) then
    raise exception 'Execution must use the graph selected at session admission.' using errcode = 'PT409';
  end if;
  if tg_op = 'INSERT' and not internal.factory_workflow_authoring_checkpoint_is_ready(
    pin.workspace_id, pin.factory_id, pin.session_id, new.graph_input_run_id
  ) then
    raise exception 'Execution requires the exact adopted preparation checkpoint.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create function internal.enqueue_factory_workflow_authoring_dispatch()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into internal.factory_workflow_authoring_dispatches(session_id,workspace_id,factory_id,input_run_id,artifact_id)
  select pin.session_id,pin.workspace_id,pin.factory_id,new.run_id,new.artifact_id
  from internal.factory_workflow_authoring_session_pins pin
  where (pin.session_id,pin.workspace_id) = (new.session_id,new.workspace_id)
    and not exists (select 1 from internal.factory_workflow_executions execution where execution.root_session_id = pin.session_id)
    and internal.factory_workflow_authoring_checkpoint_is_ready(pin.workspace_id,pin.factory_id,pin.session_id,new.run_id)
  on conflict (session_id,input_run_id) do nothing;
  return new;
end;
$$;
create trigger enqueue_factory_workflow_authoring_dispatch
  after update of status on public.session_checkpoint_publications for each row
  when (old.status is distinct from new.status and new.status = 'adopted')
  execute function internal.enqueue_factory_workflow_authoring_dispatch();

-- Approval and rejection both take the session lock before changing its
-- reviewable artifact. Keep that exact artifact available until enrollment.
create function internal.guard_factory_workflow_authoring_pending_review()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from internal.factory_workflow_authoring_dispatches dispatch
    where (dispatch.session_id,dispatch.workspace_id,dispatch.factory_id,dispatch.artifact_id) =
      (old.id,old.workspace_id,old.factory_id,old.current_artifact_id)
      and dispatch.completed_at is null
      and not exists (select 1 from internal.factory_workflow_executions execution
        where (execution.root_session_id,execution.graph_input_run_id) = (dispatch.session_id,dispatch.input_run_id))
  ) then
    raise exception 'The selected workflow is waiting for checkpoint enrollment.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
create trigger guard_factory_workflow_authoring_pending_review
  before update of phase_status on public.sessions for each row
  when (old.phase_status = 'awaiting_review' and new.phase_status is distinct from old.phase_status)
  execute function internal.guard_factory_workflow_authoring_pending_review();

create function public.claim_factory_workflow_authoring_dispatch(p_lease_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  selected internal.factory_workflow_authoring_dispatches;
  pin internal.factory_workflow_authoring_session_pins;
  execution internal.factory_workflow_executions;
  entry internal.factory_workflow_node_occurrences;
  claimed_at timestamptz;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_lease_id is null then return null; end if;
  select dispatch.* into selected from internal.factory_workflow_authoring_dispatches dispatch
  join public.workspaces workspace on workspace.id = dispatch.workspace_id
  join public.factories factory on (factory.workspace_id,factory.id) = (dispatch.workspace_id,dispatch.factory_id)
  join public.sessions session on (session.id,session.workspace_id,session.factory_id) =
    (dispatch.session_id,dispatch.workspace_id,dispatch.factory_id)
  left join internal.factory_workflow_executions owner on owner.root_session_id = dispatch.session_id
  where dispatch.completed_at is null and workspace.deletion_requested_at is null and factory.status = 'active'
    and (owner.lifecycle_status = 'running' or (owner.root_session_id is null and session.archived_at is null))
    and (dispatch.lease_id = p_lease_id or
      (dispatch.next_attempt_at <= clock_timestamp()
        and (dispatch.lease_id is null or dispatch.lease_expires_at <= clock_timestamp())))
  order by (dispatch.lease_id is not distinct from p_lease_id) desc,dispatch.next_attempt_at,dispatch.session_id,dispatch.input_run_id
  limit 1;
  if not found then return null; end if;

  -- Match adoption's workspace → factory → session order, then lease the row.
  perform internal.lock_factory_workflow_root(selected.session_id,selected.workspace_id,selected.factory_id);
  select dispatch.* into selected from internal.factory_workflow_authoring_dispatches dispatch
  where (dispatch.session_id,dispatch.input_run_id) = (selected.session_id,selected.input_run_id)
  for update;
  claimed_at := clock_timestamp();
  if not found or selected.completed_at is not null
    or (selected.lease_id = p_lease_id and selected.lease_expires_at <= claimed_at)
    or (selected.lease_id is distinct from p_lease_id and
      (selected.next_attempt_at > claimed_at or selected.lease_expires_at > claimed_at
        or exists (select 1 from internal.factory_workflow_authoring_dispatches where lease_id = p_lease_id)))
    then return null; end if;
  select * into strict pin from internal.factory_workflow_authoring_session_pins where session_id = selected.session_id;
  select * into execution from internal.factory_workflow_executions where root_session_id = selected.session_id;
  if not found then
    if not internal.factory_workflow_authoring_checkpoint_is_ready(
      selected.workspace_id,selected.factory_id,selected.session_id,selected.input_run_id
    ) then
      update internal.factory_workflow_authoring_dispatches
      set completed_at = claimed_at, lease_id = null, lease_expires_at = null
      where (session_id,input_run_id) = (selected.session_id,selected.input_run_id);
      return null;
    end if;
    begin
      perform public.start_factory_workflow_graph_execution(
        selected.session_id,selected.workspace_id,selected.factory_id,pin.graph_revision_id,selected.input_run_id
      );
    exception when sqlstate 'PT409' or sqlstate 'PT422' or insufficient_privilege then
      -- A live prerequisite can change after publication. Yield to other
      -- sessions while preserving the reviewable source and its pending handoff.
      update internal.factory_workflow_authoring_dispatches
      set next_attempt_at = claimed_at + interval '1 minute', lease_id = null, lease_expires_at = null
      where (session_id,input_run_id) = (selected.session_id,selected.input_run_id);
      return null;
    end;
    select * into strict execution from internal.factory_workflow_executions where root_session_id = selected.session_id;
  end if;
  if (execution.workspace_id,execution.factory_id,execution.graph_revision_id,execution.workflow_digest,
      execution.graph_input_run_id,execution.lifecycle_status) is distinct from
    (pin.workspace_id,pin.factory_id,pin.graph_revision_id,pin.workflow_digest,selected.input_run_id,'running') then
    return null;
  end if;
  select * into strict entry from internal.factory_workflow_node_occurrences
  where root_session_id = selected.session_id and is_entry;

  if selected.lease_id is distinct from p_lease_id then
    update internal.factory_workflow_authoring_dispatches dispatch
    set lease_id = p_lease_id, lease_expires_at = clock_timestamp() + interval '75 seconds'
    where (dispatch.session_id,dispatch.input_run_id) = (selected.session_id,selected.input_run_id)
    returning dispatch.* into selected;
  end if;
  return jsonb_build_object(
    'leaseId',p_lease_id,'leaseExpiresAt',selected.lease_expires_at,'rootSessionId',selected.session_id,'workspaceId',selected.workspace_id,
    'factoryId',selected.factory_id,'inputRunId',selected.input_run_id,'workflowDigest',execution.workflow_digest,
    'occurrenceId',entry.occurrence_id,'nodeId',entry.node_id,
    'generation',execution.generation,'ownershipToken',execution.ownership_token
  );
end;
$$;

create function public.finish_factory_workflow_authoring_dispatch(
  p_session_id uuid, p_input_run_id uuid, p_lease_id uuid, p_expected_generation bigint
) returns text language plpgsql security definer set search_path = '' as $$
declare
  selected internal.factory_workflow_authoring_dispatches;
  execution internal.factory_workflow_executions;
  entry internal.factory_workflow_node_occurrences;
  resolved boolean;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into selected from internal.factory_workflow_authoring_dispatches
  where (session_id,input_run_id,lease_id) = (p_session_id,p_input_run_id,p_lease_id);
  if not found then return 'stale'; end if;
  perform internal.lock_factory_workflow_root(selected.session_id,selected.workspace_id,selected.factory_id);
  select * into selected from internal.factory_workflow_authoring_dispatches
  where (session_id,input_run_id,lease_id) = (p_session_id,p_input_run_id,p_lease_id)
  for update;
  if not found or selected.lease_expires_at <= clock_timestamp() then return 'stale'; end if;

  select * into strict execution from internal.factory_workflow_executions where root_session_id = p_session_id;
  select * into strict entry from internal.factory_workflow_node_occurrences where root_session_id = p_session_id and is_entry;
  resolved := execution.generation = p_expected_generation and execution.lifecycle_status = 'running' and (
    exists (select 1 from internal.factory_workflow_branch_groups branch
      where (branch.root_session_id,branch.branch_occurrence_id) = (p_session_id,entry.occurrence_id))
    or exists (select 1 from internal.factory_workflow_route_decisions route
      where (route.root_session_id,route.route_occurrence_id) = (p_session_id,entry.occurrence_id))
    or exists (
      select 1 from internal.factory_workflow_node_results result
      where (result.root_session_id,result.occurrence_id) = (p_session_id,entry.occurrence_id)
        and (result.outcome <> 'succeeded'
          or not exists (select 1 from jsonb_array_elements(execution.workflow_json::jsonb->'edges') edge
            where (edge->>'from',edge->>'kind') = (entry.node_id,'next'))
          or exists (select 1 from internal.factory_workflow_transition_receipts transition
            where (transition.root_session_id,transition.source_occurrence_id,transition.source_result_id) =
              (p_session_id,entry.occurrence_id,result.result_id)))
    )
  );
  update internal.factory_workflow_authoring_dispatches
  set lease_id = null, lease_expires_at = null,
    completed_at = case when resolved then clock_timestamp() end,
    next_attempt_at = clock_timestamp() + interval '30 seconds'
  where (session_id,input_run_id) = (p_session_id,p_input_run_id);
  return case when resolved then 'complete' else 'retry' end;
end;
$$;

revoke all on function internal.factory_workflow_authoring_checkpoint_is_ready(uuid,uuid,uuid,uuid),
  internal.enqueue_factory_workflow_authoring_dispatch(), internal.guard_factory_workflow_authoring_pending_review(),
  public.claim_factory_workflow_authoring_dispatch(uuid),
  public.finish_factory_workflow_authoring_dispatch(uuid,uuid,uuid,bigint)
from public, anon, authenticated, service_role;
grant execute on function public.claim_factory_workflow_authoring_dispatch(uuid),
  public.finish_factory_workflow_authoring_dispatch(uuid,uuid,uuid,bigint) to service_role;
