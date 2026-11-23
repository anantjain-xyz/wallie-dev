-- The inspection read uses the caller's session visibility and a field allowlist.
create function public.read_factory_workflow_inspection(
  p_session_id uuid, p_run_id uuid default null, p_before jsonb default null, p_page_size integer default 25
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  subject public.sessions;
  root public.sessions;
  execution internal.factory_workflow_executions;
  authoring internal.factory_workflow_authoring_session_pins;
  root_header jsonb;
  response jsonb;
  page_events jsonb;
  next_cursor jsonb;
  before_at timestamptz;
  graph_policy jsonb;
  graph_budget jsonb;
  session_budget jsonb;
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' then return null; end if;
  select session.* into subject from public.sessions session
  where session.id = p_session_id and internal.can_access_session(session.id);
  if not found or (p_run_id is not null and not exists (
    select 1 from public.agent_runs run where (run.id,run.session_id,run.workspace_id) =
      (p_run_id,subject.id,subject.workspace_id)
  )) then return null; end if;

  select workflow.* into execution from internal.factory_workflow_executions workflow
  where (workflow.root_session_id,workflow.workspace_id,workflow.factory_id) =
    (internal.find_factory_workflow_lifecycle_root(subject.id),subject.workspace_id,subject.factory_id)
    and workflow.graph_revision_id is not null;
  if not found then return null; end if;
  select session.* into root from public.sessions session
  where (session.id,session.workspace_id,session.factory_id) = (execution.root_session_id,execution.workspace_id,execution.factory_id)
    and internal.can_access_session(session.id);
  if not found then return null; end if;

  if p_page_size is null or p_page_size not between 0 and 50 or (p_page_size = 0 and p_before is not null) then
    raise exception 'Invalid workflow inspection page.' using errcode = '22023';
  end if;
  if p_before is not null then
    if jsonb_typeof(p_before) is distinct from 'object'
      or p_before - array['rootSessionId','sessionId','runId','recordedAt','kind','id'] <> '{}'::jsonb
      or p_before->>'rootSessionId' is distinct from root.id::text
      or p_before->>'sessionId' is distinct from subject.id::text
      or p_before->'runId' is distinct from coalesce(to_jsonb(p_run_id),'null'::jsonb)
      or jsonb_typeof(p_before->'recordedAt') is distinct from 'string'
      or not coalesce(pg_catalog.pg_input_is_valid(p_before->>'recordedAt','timestamp with time zone'),false)
      or coalesce(p_before->>'kind','') not in ('occurrence','transition','route','foreman','branch','child','attempt',
        'join','repository','review','repair','artifact','approval','lifecycle')
      or jsonb_typeof(p_before->'id') is distinct from 'string'
      or char_length(p_before->>'id') not between 1 and 92 then
      raise exception 'Invalid workflow inspection cursor.' using errcode = '22023';
    end if;
    before_at := (p_before->>'recordedAt')::timestamptz;
    if not isfinite(before_at) then raise exception 'Invalid workflow inspection cursor.' using errcode = '22023'; end if;
  end if;

  select pin.* into authoring from internal.factory_workflow_authoring_session_pins pin
  where (pin.session_id,pin.workspace_id,pin.factory_id,pin.graph_revision_id,pin.workflow_digest) =
    (root.id,root.workspace_id,root.factory_id,execution.graph_revision_id,execution.workflow_digest);
  root_header := jsonb_strip_nulls(jsonb_build_object(
    'sessionId',root.id,'sessionNumber',root.number,'workspaceId',root.workspace_id,'factoryId',root.factory_id,
    'graphRevisionId',execution.graph_revision_id,'workflowDigest',execution.workflow_digest,
    'lifecycleStatus',execution.lifecycle_status,'generation',execution.generation,
    'canManage',internal.can_manage_factory(root.workspace_id,root.factory_id),
    'workflowId',authoring.workflow_id,'activationId',authoring.activation_id
  ));
  response := jsonb_build_object('root',root_header,'subject',jsonb_build_object(
    'sessionId',subject.id,'sessionNumber',subject.number,'runId',p_run_id
  ));
  if p_page_size = 0 then
    return response || jsonb_build_object('events','[]'::jsonb,'nextCursor',null,'budget',null);
  end if;

  with repositories as materialized (
    select repository.id,repository.full_name from public.github_repositories repository
    where (repository.workspace_id,repository.factory_id) = (root.workspace_id,root.factory_id)
      and internal.can_access_factory(repository.workspace_id,repository.factory_id)
  ), children as materialized (
    select marker.*,child.number as child_number,child.phase_status as child_status,parent.number as parent_number,
      (internal.factory_workflow_branch_current_job(marker.root_session_id,marker.workspace_id,child.id)).id as current_job_id
    from internal.factory_workflow_delegations marker
    join public.sessions child on (child.id,child.workspace_id,child.factory_id) =
      (marker.child_session_id,marker.workspace_id,marker.factory_id) and internal.can_access_session(child.id)
    join public.sessions parent on (parent.id,parent.workspace_id,parent.factory_id) =
      (marker.parent_session_id,marker.workspace_id,marker.factory_id) and internal.can_access_session(parent.id)
    join repositories repository on repository.id = marker.repository_id
    where (marker.root_session_id,marker.workspace_id,marker.factory_id) = (root.id,root.workspace_id,root.factory_id)
  ), joins as materialized (
    select manifest.*,parent.number as parent_number,repository.full_name as repository_name
    from internal.factory_workflow_joins manifest
    join public.sessions parent on (parent.id,parent.workspace_id,parent.factory_id) =
      (manifest.parent_session_id,manifest.workspace_id,manifest.factory_id) and internal.can_access_session(parent.id)
    join repositories repository on repository.id = manifest.repository_id
    where (manifest.root_session_id,manifest.workspace_id,manifest.factory_id,manifest.workflow_digest) =
      (root.id,root.workspace_id,root.factory_id,execution.workflow_digest)
  ), targets as materialized (
    select target.*,parent.number as parent_number,repository.full_name as repository_name
    from internal.factory_workflow_repository_delivery_targets target
    join joins manifest on (manifest.root_session_id,manifest.join_id,manifest.parent_session_id) =
      (target.root_session_id,target.join_id,target.parent_session_id)
    join public.sessions parent on (parent.id,parent.workspace_id,parent.factory_id) =
      (target.parent_session_id,target.workspace_id,target.factory_id) and internal.can_access_session(parent.id)
    join repositories repository on repository.id = target.repository_id
    where (target.workspace_id,target.factory_id) = (root.workspace_id,root.factory_id)
  ), reviews as materialized (
    select review.*,parent.number as parent_number,repository.full_name as repository_name
    from internal.factory_workflow_exact_reviews review
    join joins manifest on (manifest.root_session_id,manifest.join_id,manifest.parent_session_id,manifest.repository_id) =
      (review.root_session_id,review.join_id,review.parent_session_id,review.repository_id)
    join public.sessions parent on (parent.id,parent.workspace_id,parent.factory_id) =
      (review.parent_session_id,review.workspace_id,review.factory_id) and internal.can_access_session(parent.id)
    join repositories repository on repository.id = review.repository_id
    where (review.workspace_id,review.factory_id,review.workflow_digest) =
      (root.workspace_id,root.factory_id,execution.workflow_digest)
  ), participating_jobs as materialized (
    select job.id,job.session_id,root.number as session_number,null::uuid as parent_session_id,
      null::uuid as occurrence_id,null::uuid as group_id,'preparation'::text as source,job.status,job.attempt_count,job.created_at,
      true as current_job
    from public.agent_runs run
    join public.agent_jobs job on (job.id,job.session_id,job.workspace_id) = (run.agent_job_id,run.session_id,run.workspace_id)
    where (run.id,run.session_id,run.workspace_id) = (execution.graph_input_run_id,root.id,root.workspace_id)
    union all
    select job.id,job.session_id,child.child_number,child.parent_session_id,child.target_occurrence_id,
      slot.group_id,'child',job.status,job.attempt_count,job.created_at,job.id=child.current_job_id
    from children child join public.agent_jobs job on (job.session_id,job.workspace_id) = (child.child_session_id,child.workspace_id)
    left join internal.factory_workflow_branch_slots slot
      on (slot.root_session_id,slot.slot_id) = (root.id,child.source_branch_slot_id)
    where not exists (select 1 from internal.factory_workflow_join_jobs marker where marker.job_id=job.id)
      and not exists (select 1 from internal.factory_workflow_review_repairs repair where repair.job_id=job.id)
    union all
    select job.id,job.session_id,manifest.parent_number,manifest.parent_session_id,manifest.join_occurrence_id,
      manifest.branch_group_id,'join',job.status,job.attempt_count,job.created_at,true
    from joins manifest join internal.factory_workflow_join_jobs marker
      on (marker.root_session_id,marker.join_id,marker.workspace_id,marker.factory_id,marker.parent_session_id) =
        (root.id,manifest.join_id,root.workspace_id,root.factory_id,manifest.parent_session_id)
    join public.agent_jobs job on (job.id,job.workspace_id,job.session_id) = (marker.job_id,root.workspace_id,marker.parent_session_id)
    union all
    select job.id,job.session_id,review.parent_number,review.parent_session_id,review.review_occurrence_id,
      null::uuid,'repair',job.status,job.attempt_count,job.created_at,true
    from reviews review join internal.factory_workflow_review_repairs repair
      on (repair.root_session_id,repair.review_id) = (root.id,review.review_id)
    join public.agent_jobs job on (job.id,job.workspace_id,job.session_id) = (repair.job_id,root.workspace_id,review.parent_session_id)
    union all
    select job.id,job.session_id,validation.number,target.parent_session_id,manifest.join_occurrence_id,
      manifest.branch_group_id,'repository-validation',job.status,job.attempt_count,job.created_at,true
    from targets target join joins manifest using (root_session_id,join_id)
    join internal.factory_workflow_repository_validation_jobs marker on (marker.root_session_id,marker.join_id,marker.repository_id) =
      (root.id,target.join_id,target.repository_id)
    join public.sessions validation on (validation.id,validation.workspace_id,validation.factory_id) =
      (marker.session_id,root.workspace_id,root.factory_id) and internal.can_access_session(validation.id)
    join public.agent_jobs job on (job.id,job.workspace_id,job.session_id) = (marker.job_id,root.workspace_id,validation.id)
  ), attempts as materialized (
    select entry.*,run.id as run_id,run.status::text as run_state,
      coalesce(run.attempt_count,entry.attempt_count+1) as attempt_number,run.created_at as recorded_at,
      exists (select 1 from internal.factory_workflow_lifecycle_commands command
        cross join lateral jsonb_array_elements(command.receipt->'retired') retired
        where command.root_session_id=root.id and retired->>'sessionId'=entry.session_id::text
          and retired->'jobIds' ? entry.id::text and retired->'runIds' ? run.id::text) as retired,
      entry.current_job and case when entry.status='queued' then run.status='queued' and run.attempt_count is null
        else run.attempt_count is not distinct from nullif(entry.attempt_count,0) end as current
    from participating_jobs entry
    join public.agent_runs run on (run.session_id,run.workspace_id,run.agent_job_id) = (entry.session_id,root.workspace_id,entry.id)
    union all
    select entry.*,null::uuid,'queued',entry.attempt_count+1,entry.created_at,false,entry.current_job
    from participating_jobs entry where entry.status='queued' and not exists (
      select 1 from public.agent_runs run
      where (run.session_id,run.workspace_id,run.agent_job_id) = (entry.session_id,root.workspace_id,entry.id)
        and run.status='queued' and run.attempt_count is null
    )
  ), checkpoints as materialized (
    select publication.run_id,publication.job_id,publication.session_id,attempt.session_number,attempt.occurrence_id,
      checkpoint.repository_id,repository.full_name as repository_name,checkpoint.output_sha,
      artifact.id as artifact_id,artifact.stage_id,artifact.stage_slug,artifact.version as artifact_version,publication.adopted_at,
      parent.current_artifact_id,parent.phase_status
    from attempts attempt
    join public.session_checkpoint_publications publication
      on (publication.run_id,publication.workspace_id,publication.session_id,publication.job_id,publication.attempt_count) =
        (attempt.run_id,root.workspace_id,attempt.session_id,attempt.id,attempt.attempt_number) and publication.status='adopted'
    join public.session_git_checkpoints checkpoint
      on (checkpoint.run_id,checkpoint.workspace_id,checkpoint.session_id,checkpoint.job_id,checkpoint.attempt_count,checkpoint.artifact_id) =
        (publication.run_id,publication.workspace_id,publication.session_id,publication.job_id,publication.attempt_count,
          publication.artifact_id)
    join repositories repository on repository.id=checkpoint.repository_id
    join public.sessions parent on (parent.id,parent.workspace_id,parent.factory_id) =
      (publication.session_id,root.workspace_id,root.factory_id) and internal.can_access_session(parent.id)
    join public.session_artifacts artifact on (artifact.id,artifact.session_id,artifact.workspace_id) =
      (publication.artifact_id,publication.session_id,root.workspace_id)
  ), approvals as materialized (
    select approval.id,approval.approved_at,checkpoint.*
    from checkpoints checkpoint join public.session_stage_approval_receipts approval
      on (approval.artifact_id,approval.workspace_id,approval.session_id,approval.stage_id,approval.artifact_version) =
        (checkpoint.artifact_id,root.workspace_id,checkpoint.session_id,checkpoint.stage_id,checkpoint.artifact_version)
  ), events(kind,event_id,recorded_at,occurrence_id,node_id,state,detail) as (
    select 'occurrence',occurrence.occurrence_id::text,occurrence.admitted_at,occurrence.occurrence_id,occurrence.node_id,
      coalesce(result.outcome::text,'pending'),jsonb_build_object(
        'nodeKind',occurrence.node_kind,'entry',occurrence.is_entry,'generation',occurrence.admitted_generation,'resultId',result.result_id)
    from internal.factory_workflow_node_occurrences occurrence
    left join internal.factory_workflow_node_results result using (root_session_id,occurrence_id)
    where occurrence.root_session_id=root.id
    union all
    select 'transition',transition.transition_id::text,transition.recorded_at,transition.source_occurrence_id,source.node_id,
      'admitted',jsonb_build_object('sourceOccurrenceId',transition.source_occurrence_id,
        'targetOccurrenceId',transition.target_occurrence_id,'sourceResultId',transition.source_result_id,
        'edgeId',transition.edge_id,'edgeKind',transition.edge_kind,'generation',transition.recorded_generation)
    from internal.factory_workflow_transition_receipts transition
    join internal.factory_workflow_node_occurrences source on (source.root_session_id,source.occurrence_id) =
      (transition.root_session_id,transition.source_occurrence_id)
    where transition.root_session_id=root.id
    union all
    select 'route',route.decision_id::text,route.recorded_at,route.route_occurrence_id,occurrence.node_id,
      route.resolution,jsonb_build_object('resolution',route.resolution,'selectedEdgeId',route.selected_edge_id,
        'selectedDestinationId',route.selected_destination_id,'targetOccurrenceId',transition.target_occurrence_id,
        'generation',route.recorded_generation)
    from internal.factory_workflow_route_decisions route
    join internal.factory_workflow_node_occurrences occurrence on (occurrence.root_session_id,occurrence.occurrence_id) =
      (route.root_session_id,route.route_occurrence_id)
    left join internal.factory_workflow_transition_receipts transition on
      (transition.root_session_id,transition.source_occurrence_id,transition.edge_id,transition.edge_kind) =
        (route.root_session_id,route.route_occurrence_id,route.selected_edge_id,route.selected_edge_kind)
    where route.root_session_id=root.id
    union all
    select 'foreman',foreman.foreman_run_id::text,foreman.issued_at,foreman.route_occurrence_id,occurrence.node_id,
      foreman.status,jsonb_build_object('parentSessionId',parent.id,'sessionNumber',parent.number,
        'checkpointRunId',checkpoint.run_id,'blocker',foreman.blocked_code,'generation',foreman.issued_generation)
    from internal.factory_workflow_foreman_runs foreman
    join internal.factory_workflow_node_occurrences occurrence on (occurrence.root_session_id,occurrence.occurrence_id) =
      (foreman.root_session_id,foreman.route_occurrence_id)
    join public.sessions parent on (parent.id,parent.workspace_id,parent.factory_id) =
      (foreman.parent_session_id,foreman.workspace_id,foreman.factory_id) and internal.can_access_session(parent.id)
    left join checkpoints checkpoint on (checkpoint.run_id,checkpoint.session_id) = (foreman.source_checkpoint_run_id,parent.id)
    where (foreman.root_session_id,foreman.workspace_id,foreman.factory_id,foreman.workflow_digest) =
      (root.id,root.workspace_id,root.factory_id,execution.workflow_digest)
    union all
    select 'branch',slot.slot_id::text,manifest.created_at,manifest.branch_occurrence_id,occurrence.node_id,
      coalesce(terminal.outcome::text,case when dispatch.terminal_blocker is not null then 'blocked' else 'pending' end),
      jsonb_build_object('groupId',manifest.group_id,'slotId',slot.slot_id,'joinNodeId',manifest.join_node_id,
        'branchEdgeId',slot.branch_edge_id,'required',slot.required,'outcomeId',terminal.outcome_id,
        'admissionBlocker',dispatch.terminal_blocker,'parentSessionId',parent.id,'childSessionId',child.child_session_id,
        'sessionNumber',child.child_number,'runId',attempt.run_id)
    from internal.factory_workflow_branch_groups manifest
    join internal.factory_workflow_branch_slots slot using (root_session_id,group_id)
    join public.sessions parent on (parent.id,parent.workspace_id,parent.factory_id) =
      (manifest.parent_session_id,manifest.workspace_id,manifest.factory_id) and internal.can_access_session(parent.id)
    join repositories repository on repository.id=manifest.repository_id
    left join internal.factory_workflow_repository_writers writer on (writer.graph_revision_id,writer.join_node_id)=
      (execution.graph_revision_id,manifest.join_node_id) and slot.branch_edge_id=any(writer.branch_edge_ids)
    join repositories branch_repository on branch_repository.id=coalesce(writer.repository_id,manifest.repository_id)
    join internal.factory_workflow_node_occurrences occurrence on (occurrence.root_session_id,occurrence.occurrence_id) =
      (manifest.root_session_id,manifest.branch_occurrence_id)
    left join children child on (child.root_session_id,child.parent_session_id,child.source_branch_slot_id) =
      (manifest.root_session_id,manifest.parent_session_id,slot.slot_id)
    left join internal.factory_workflow_branch_slot_dispatches dispatch on (dispatch.root_session_id,dispatch.slot_id)=
      (manifest.root_session_id,slot.slot_id)
    left join internal.factory_workflow_branch_outcomes terminal on (terminal.root_session_id,terminal.slot_id,terminal.child_session_id) =
      (slot.root_session_id,slot.slot_id,child.child_session_id)
    left join attempts attempt on (attempt.run_id,attempt.id,attempt.session_id,attempt.attempt_number) =
      (terminal.run_id,terminal.job_id,terminal.child_session_id,terminal.attempt_count)
    where (manifest.root_session_id,manifest.workspace_id,manifest.factory_id) = (root.id,root.workspace_id,root.factory_id)
      and (child.child_session_id is not null or not exists (select 1 from internal.factory_workflow_delegations hidden
        where (hidden.root_session_id,hidden.source_branch_slot_id)=(root.id,slot.slot_id)))
    union all
    select 'child',child.child_session_id::text,child.created_at,child.target_occurrence_id,occurrence.node_id,
      child.child_status::text,jsonb_build_object('parentSessionId',child.parent_session_id,'parentSessionNumber',child.parent_number,
        'childSessionId',child.child_session_id,'sessionNumber',child.child_number,'jobId',job.id,'runId',admitted.run_id,
        'groupId',slot.group_id,'slotId',slot.slot_id,'sourceDecisionId',child.source_route_decision_id,
        'repositoryId',repository.id,'repositoryName',repository.full_name)
    from children child join repositories repository on repository.id=child.repository_id
    join internal.factory_workflow_node_occurrences occurrence on (occurrence.root_session_id,occurrence.occurrence_id) =
      (child.root_session_id,child.target_occurrence_id)
    left join participating_jobs job on (job.id,job.session_id)=(child.child_job_id,child.child_session_id)
    left join attempts admitted on (admitted.run_id,admitted.id,admitted.session_id)=
      (child.child_run_id,job.id,child.child_session_id)
    left join internal.factory_workflow_branch_slots slot on (slot.root_session_id,slot.slot_id)=(root.id,child.source_branch_slot_id)
    union all
    select 'attempt',coalesce(attempt.run_id,attempt.id)::text,attempt.recorded_at,attempt.occurrence_id,occurrence.node_id,
      attempt.run_state,jsonb_build_object('parentSessionId',attempt.parent_session_id,'sessionId',attempt.session_id,
        'sessionNumber',attempt.session_number,'jobId',attempt.id,'runId',attempt.run_id,'attemptCount',attempt.attempt_number,
        'current',attempt.current and not attempt.retired,'retired',attempt.retired,'source',attempt.source,
        'groupId',attempt.group_id,'jobStatus',attempt.status)
    from attempts attempt left join internal.factory_workflow_node_occurrences occurrence
      on (occurrence.root_session_id,occurrence.occurrence_id)=(root.id,attempt.occurrence_id)
    union all
    select 'join',manifest.join_id::text,manifest.admitted_at,manifest.join_occurrence_id,occurrence.node_id,
      coalesce(terminal.outcome,case when visible_attempt.run_id is not null then 'running' else 'pending' end),
      jsonb_build_object('joinId',manifest.join_id,'groupId',manifest.branch_group_id,
        'parentSessionId',manifest.parent_session_id,'sessionId',manifest.parent_session_id,'sessionNumber',manifest.parent_number,
        'repositoryId',manifest.repository_id,'repositoryName',manifest.repository_name,'inputRunId',source.run_id,
        'runId',coalesce(checkpoint.run_id,visible_attempt.run_id),'artifactId',checkpoint.artifact_id,
        'artifactVersion',checkpoint.artifact_version,'stageSlug',checkpoint.stage_slug,
        'selectedOutcomeIds',inputs.selected,'omittedBranchEdgeIds',inputs.omitted,
        'deliveryStatus',case when result.result_id is not null then 'adopted'
          when terminal.outcome in ('conflict','validation_failed') then 'blocked'
          when terminal.outcome='adopted' and exists (select 1 from targets target where target.join_id=manifest.join_id)
            then 'partial' else 'pending' end,
        'wholeJoinComplete',result.result_id is not null)
    from joins manifest
    join internal.factory_workflow_node_occurrences occurrence on (occurrence.root_session_id,occurrence.occurrence_id) =
      (manifest.root_session_id,manifest.join_occurrence_id)
    left join internal.factory_workflow_join_attempts attempt on (attempt.root_session_id,attempt.join_id)=
      (manifest.root_session_id,manifest.join_id)
    left join attempts visible_attempt on (visible_attempt.id,visible_attempt.run_id,visible_attempt.attempt_number,visible_attempt.session_id)=
      (attempt.job_id,attempt.run_id,attempt.attempt_count,manifest.parent_session_id)
    left join internal.factory_workflow_join_outcomes terminal on (terminal.root_session_id,terminal.join_id)=
      (manifest.root_session_id,manifest.join_id)
    left join internal.factory_workflow_node_results result on (result.root_session_id,result.occurrence_id,result.outcome,result.evidence_ref) =
      (manifest.root_session_id,manifest.join_occurrence_id,'succeeded','join-checkpoint:'||terminal.checkpoint_run_id)
    left join checkpoints source on (source.run_id,source.session_id,source.repository_id)=
      (manifest.expected_head_run_id,manifest.parent_session_id,manifest.repository_id)
    left join checkpoints checkpoint on (checkpoint.run_id,checkpoint.session_id,checkpoint.repository_id,checkpoint.artifact_id)=
      (terminal.checkpoint_run_id,manifest.parent_session_id,manifest.repository_id,terminal.artifact_id)
    cross join lateral (
      select coalesce(jsonb_agg(input.outcome_id order by input.branch_edge_id)
        filter (where input.selected and terminal_slot.outcome_id is not null),'[]'::jsonb) as selected,
        coalesce(jsonb_agg(input.branch_edge_id order by input.branch_edge_id)
          filter (where not input.selected and not slot.required),'[]'::jsonb) as omitted
      from internal.factory_workflow_join_inputs input
      join internal.factory_workflow_branch_slots slot on (slot.root_session_id,slot.group_id,slot.slot_id)=
        (manifest.root_session_id,manifest.branch_group_id,input.slot_id)
      left join children child on (child.root_session_id,child.parent_session_id,child.source_branch_slot_id)=
        (manifest.root_session_id,manifest.parent_session_id,input.slot_id)
      left join internal.factory_workflow_repository_writers writer on (writer.graph_revision_id,writer.join_node_id)=
        (execution.graph_revision_id,occurrence.node_id) and slot.branch_edge_id=any(writer.branch_edge_ids)
      join repositories input_repository on input_repository.id=coalesce(child.repository_id,writer.repository_id,manifest.repository_id)
      left join internal.factory_workflow_branch_outcomes terminal_slot
        on (terminal_slot.root_session_id,terminal_slot.slot_id,terminal_slot.child_session_id,terminal_slot.outcome_id)=
          (manifest.root_session_id,input.slot_id,child.child_session_id,input.outcome_id)
      where (input.root_session_id,input.join_id)=(manifest.root_session_id,manifest.join_id)
        and (terminal_slot.outcome_id is not null or (input.outcome_id is null and not exists (
          select 1 from internal.factory_workflow_delegations hidden
          where (hidden.root_session_id,hidden.source_branch_slot_id)=(root.id,slot.slot_id))))
    ) inputs
    union all
    select 'repository',target.join_id::text||':'||target.repository_id::text,manifest.admitted_at,
      manifest.join_occurrence_id,occurrence.node_id,delivery.status,jsonb_build_object(
        'joinId',target.join_id,'parentSessionId',target.parent_session_id,
        'sessionId',observed.session_id,'sessionNumber',observed.session_number,'repositoryId',target.repository_id,
        'repositoryName',target.repository_name,'runId',observed.run_id,'validationRunId',sealed.run_id,
        'blocker',delivery.blocker,'attempts',delivery.attempts,'acceptedHeadReceiptId',delivery.accepted_head_receipt_id,
        'remoteReconciliationRequired',delivery.prospective_remote_ref,'commitSha',case when sealed.run_id is not null then intent.candidate_sha end,
        'validationTreeSha',case when sealed.run_id is not null then intent.tree_sha end)
    from targets target join joins manifest using (root_session_id,join_id)
    join internal.factory_workflow_node_occurrences occurrence on (occurrence.root_session_id,occurrence.occurrence_id) =
      (target.root_session_id,manifest.join_occurrence_id)
    join internal.factory_workflow_repository_delivery_state delivery on (delivery.root_session_id,delivery.join_id,delivery.repository_id)=
      (target.root_session_id,target.join_id,target.repository_id)
    left join internal.factory_workflow_repository_delivery_intents intent on (intent.root_session_id,intent.join_id,intent.repository_id)=
      (target.root_session_id,target.join_id,target.repository_id)
    left join internal.factory_workflow_repository_validation_attempts receipt
      on (receipt.root_session_id,receipt.join_id,receipt.repository_id,receipt.validation_run_id)=
        (intent.root_session_id,intent.join_id,intent.repository_id,intent.validation_run_id)
    left join attempts sealed on (sealed.session_id,sealed.id,sealed.run_id,sealed.attempt_number)=
      (receipt.validation_session_id,receipt.validation_job_id,receipt.validation_run_id,receipt.attempt_count)
    left join lateral (
      select attempt.session_id,attempt.session_number,attempt.run_id
      from internal.factory_workflow_repository_validation_jobs marker
      join attempts attempt on (attempt.id,attempt.session_id)=(marker.job_id,marker.session_id)
      where (marker.root_session_id,marker.join_id,marker.repository_id)=(target.root_session_id,target.join_id,target.repository_id)
        and (sealed.run_id is null or attempt.run_id=sealed.run_id)
      order by marker.admitted_generation desc,attempt.current desc,attempt.attempt_number desc,attempt.run_id desc
      limit 1
    ) observed on true
    where intent.validation_run_id is null or sealed.run_id is not null
    union all
    select 'review',review.review_id::text,occurrence.admitted_at,review.review_occurrence_id,occurrence.node_id,
      case when result.result_id is not null then 'pass' when report.report->>'verdict'='findings' then 'findings'
        when failure.reason is not null or progress.progress->>'status' in ('escalated','stale_review') then 'blocked'
        else 'pending' end,
      jsonb_build_object('reviewId',review.review_id,'reviewReceiptId',report.receipt_id,'joinId',review.join_id,
        'parentSessionId',review.parent_session_id,'sessionId',review.parent_session_id,'sessionNumber',review.parent_number,
        'repositoryId',review.repository_id,'repositoryName',review.repository_name,'runId',checkpoint.run_id,
        'artifactId',checkpoint.artifact_id,'artifactVersion',checkpoint.artifact_version,'stageSlug',checkpoint.stage_slug,'commitSha',review.commit_sha,
        'validationTreeSha',review.tree_sha,'verdict',report.report->>'verdict',
        'blocker',coalesce(failure.reason,case when progress.progress->>'code' in
          ('finding_ineligible','finding_repeated','repair_budget_exhausted','repair_stage_unavailable','stale_review')
          then progress.progress->>'code' end,case when progress.progress->>'status'='stale_review' then 'stale_review' end),
        'nextReviewOccurrenceId',repair.next_review_occurrence_id)
    from reviews review
    join internal.factory_workflow_node_occurrences occurrence on (occurrence.root_session_id,occurrence.occurrence_id)=
      (review.root_session_id,review.review_occurrence_id)
    left join internal.factory_workflow_exact_review_reports report on (report.root_session_id,report.review_id)=(review.root_session_id,review.review_id)
    left join internal.factory_workflow_exact_review_failures failure on (failure.root_session_id,failure.review_id)=(review.root_session_id,review.review_id)
    left join internal.factory_workflow_repair_dispatch_outcomes progress on (progress.root_session_id,progress.review_id)=(review.root_session_id,review.review_id)
    left join internal.factory_workflow_review_repairs repair on (repair.root_session_id,repair.review_id)=(review.root_session_id,review.review_id)
    left join internal.factory_workflow_node_results result on (result.root_session_id,result.occurrence_id,result.outcome,result.evidence_ref)=
      (review.root_session_id,review.review_occurrence_id,'succeeded','exact-review:'||report.receipt_id)
    left join checkpoints checkpoint on (checkpoint.run_id,checkpoint.session_id,checkpoint.repository_id,checkpoint.output_sha)=
      (review.checkpoint_run_id,review.parent_session_id,review.repository_id,review.commit_sha)
    union all
    select 'repair',repair.receipt_id::text,repair.recorded_at,review.review_occurrence_id,occurrence.node_id,job.status::text,
      jsonb_build_object('repairReceiptId',repair.receipt_id,'reviewReceiptId',repair.review_receipt_id,
        'priorRepairReceiptId',prior.receipt_id,'jobId',job.id,'runId',attempt.run_id,'outputRunId',checkpoint.run_id,
        'nextReviewOccurrenceId',repair.next_review_occurrence_id,'sessionId',job.session_id,
        'sessionNumber',job.session_number,'parentSessionId',review.parent_session_id,'joinId',review.join_id)
    from reviews review join internal.factory_workflow_review_repairs repair using (root_session_id,review_id)
    join internal.factory_workflow_node_occurrences occurrence on (occurrence.root_session_id,occurrence.occurrence_id)=
      (review.root_session_id,review.review_occurrence_id)
    join participating_jobs job on (job.id,job.session_id)=(repair.job_id,review.parent_session_id)
    left join lateral (
      select current_attempt.run_id from attempts current_attempt
      where current_attempt.id=job.id and current_attempt.current and not current_attempt.retired
      order by current_attempt.attempt_number desc,current_attempt.run_id desc limit 1
    ) attempt on true
    left join lateral (
      select output.run_id from checkpoints output
      join participating_jobs output_job on (output_job.id,output_job.session_id) = (output.job_id,output.session_id)
      join public.session_job_git_inputs input on (input.job_id,input.workspace_id,input.session_id,input.source_checkpoint_run_id)=
        (output_job.id,root.workspace_id,output_job.session_id,review.checkpoint_run_id)
      where (output.job_id,output.session_id,output.repository_id)=(job.id,job.session_id,review.repository_id)
      order by output.adopted_at desc,output.run_id desc limit 1
    ) checkpoint on true
    left join internal.factory_workflow_review_repairs prior on (prior.root_session_id,prior.receipt_id)=
      (review.root_session_id,repair.prior_repair_receipt_id) and exists (
        select 1 from reviews authorized where (authorized.root_session_id,authorized.review_id)=(prior.root_session_id,prior.review_id))
    union all
    select 'artifact',checkpoint.artifact_id::text,checkpoint.adopted_at,checkpoint.occurrence_id,occurrence.node_id,'adopted',
      jsonb_build_object('sessionId',checkpoint.session_id,'sessionNumber',checkpoint.session_number,'runId',checkpoint.run_id,
        'artifactId',checkpoint.artifact_id,'artifactVersion',checkpoint.artifact_version,'stageId',checkpoint.stage_id,'stageSlug',checkpoint.stage_slug,
        'repositoryId',checkpoint.repository_id,'repositoryName',checkpoint.repository_name,'commitSha',checkpoint.output_sha,
        'approvalState',case when exists (select 1 from approvals approval where approval.artifact_id=checkpoint.artifact_id) then 'approved'
          when checkpoint.artifact_id=checkpoint.current_artifact_id and checkpoint.phase_status='awaiting_review' then 'awaiting_review'
          else 'historical' end)
    from checkpoints checkpoint left join internal.factory_workflow_node_occurrences occurrence
      on (occurrence.root_session_id,occurrence.occurrence_id)=(root.id,checkpoint.occurrence_id)
    union all
    select 'approval',approval.id::text,approval.approved_at,approval.occurrence_id,occurrence.node_id,'approved',
      jsonb_build_object('sessionId',approval.session_id,'sessionNumber',approval.session_number,'runId',approval.run_id,
        'artifactId',approval.artifact_id,'artifactVersion',approval.artifact_version,'stageId',approval.stage_id,'stageSlug',approval.stage_slug,'approvalId',approval.id)
    from approvals approval left join internal.factory_workflow_node_occurrences occurrence
      on (occurrence.root_session_id,occurrence.occurrence_id)=(root.id,approval.occurrence_id)
    union all
    select 'lifecycle',command.request_id::text,command.created_at,null::uuid,null::text,
      case command.action when 'pause' then 'paused' when 'resume' then 'running' else 'canceled' end,
      jsonb_build_object('action',command.action,'generation',command.applied_generation)
    from internal.factory_workflow_lifecycle_commands command where command.root_session_id=root.id
  ), bounded as materialized (
    select event.* from events event
    where before_at is null or (event.recorded_at,event.kind collate "C",event.event_id collate "C") <
      (before_at,(p_before->>'kind') collate "C",(p_before->>'id') collate "C")
    order by event.recorded_at desc,event.kind collate "C" desc,event.event_id collate "C" desc
    limit p_page_size+1
  ), page as materialized (
    select event.* from bounded event
    order by event.recorded_at desc,event.kind collate "C" desc,event.event_id collate "C" desc
    limit p_page_size
  )
  select coalesce((select jsonb_agg(jsonb_build_object('kind',event.kind,'id',event.event_id,'recordedAt',event.recorded_at,
      'occurrenceId',event.occurrence_id,'nodeId',event.node_id,'state',event.state,'detail',event.detail)
    order by event.recorded_at desc,event.kind collate "C" desc,event.event_id collate "C" desc) from page event),'[]'::jsonb),
    case when (select count(*) from bounded)>p_page_size then (
      select jsonb_build_object('rootSessionId',root.id,'sessionId',subject.id,'runId',p_run_id,
        'recordedAt',event.recorded_at,'kind',event.kind,'id',event.event_id)
      from page event order by event.recorded_at,event.kind collate "C",event.event_id collate "C" limit 1
    ) end
  into page_events,next_cursor;

  select jsonb_build_object('policyRevisionId',policy.id,'exhaustionCode',root.execution_exhaustion_code,
    'limits',jsonb_build_object('maxRepairAttempts',policy.requirements->'maxRepairAttempts',
      'maxExecutionMs',policy.requirements->'maxExecutionMs','maxTotalTokens',policy.requirements->'maxTotalTokens',
      'maxCostUsd',policy.requirements->'maxCostUsd'),
    'usage',jsonb_build_object('elapsedMs',usage.elapsed_ms,'repairAttempts',root.execution_repair_attempts,
      'remainingExecutionMs',case when policy.id is not null then greatest(0,(policy.requirements->>'maxExecutionMs')::bigint-usage.elapsed_ms) end,
      'totalTokens',usage.total_tokens,'totalCostUsd',usage.total_cost_usd,'tokensUnavailable',usage.tokens_unavailable,
      'costUnavailable',usage.cost_unavailable,'startedRuns',usage.started_runs,
      'tokensUnreported',unreported.tokens,'costUnreported',unreported.cost))
  into session_budget
  from internal.load_session_execution_usage(root.id) usage
  left join public.execution_policy_revisions policy on (policy.id,policy.workspace_id)=(root.execution_policy_revision_id,root.workspace_id)
  cross join lateral (
    select coalesce(bool_or(run.token_provenance not in ('measured','estimated')),false) tokens,
      coalesce(bool_or(run.cost_provenance not in ('measured','estimated')),false) cost
    from public.agent_runs run
    where (run.session_id,run.workspace_id)=(root.id,root.workspace_id)
      and run.started_at is not null and run.usage_finalized_at is null
  ) unreported;

  -- Shared accounting charges unpublished reservations. Use it only when
  -- every participant contributing to it is within the caller's scope.
  graph_policy := execution.workflow_json::jsonb->'delegationPolicy';
  if jsonb_typeof(graph_policy)='object' and not exists (
    select 1 from internal.factory_workflow_attempt_reservations reservation
    where reservation.root_session_id=root.id and not exists (
      select 1 from public.sessions participant
      where (participant.id,participant.workspace_id,participant.factory_id)=
        (reservation.session_id,reservation.workspace_id,reservation.factory_id)
        and (participant.workspace_id,participant.factory_id)=(root.workspace_id,root.factory_id)
        and internal.can_access_session(participant.id)
        and (participant.github_repository_id is null or exists (select 1 from public.github_repositories repository
          where (repository.id,repository.workspace_id,repository.factory_id)=
            (participant.github_repository_id,root.workspace_id,root.factory_id)
            and internal.can_access_factory(repository.workspace_id,repository.factory_id)))
    )
    union all
    select 1 from internal.factory_workflow_delegations marker
    where marker.root_session_id=root.id and (
      (marker.workspace_id,marker.factory_id) is distinct from (root.workspace_id,root.factory_id)
      or not internal.can_access_session(marker.child_session_id)
      or not internal.can_access_session(marker.parent_session_id)
      or not exists (select 1 from public.github_repositories repository
        where (repository.id,repository.workspace_id,repository.factory_id)=(marker.repository_id,root.workspace_id,root.factory_id)
          and internal.can_access_factory(repository.workspace_id,repository.factory_id)))
    union all
    select 1 from internal.factory_workflow_foreman_runs foreman
    where foreman.root_session_id=root.id and (
      (foreman.workspace_id,foreman.factory_id) is distinct from (root.workspace_id,root.factory_id)
      or not internal.can_access_session(foreman.parent_session_id))
    union all
    select 1 from internal.factory_workflow_exact_reviews review
    where review.root_session_id=root.id and (
      (review.workspace_id,review.factory_id) is distinct from (root.workspace_id,root.factory_id)
      or not internal.can_access_session(review.parent_session_id)
      or not exists (select 1 from public.github_repositories repository
        where (repository.id,repository.workspace_id,repository.factory_id)=(review.repository_id,root.workspace_id,root.factory_id)
          and internal.can_access_factory(repository.workspace_id,repository.factory_id)))
  ) then
    select jsonb_build_object('limits',jsonb_build_object('maxChildren',graph_policy->'maxChildren',
      'maxConcurrentChildren',graph_policy->'maxConcurrentChildren','maxAttempts',graph_policy->'maxAttempts',
      'maxTotalTokens',graph_policy->'maxTotalTokens','maxCostUsd',graph_policy->'maxCostUsd'),
      'accountedAttempts',usage.attempts,'accountedTokens',usage.tokens,'accountedSpendUsd',usage.spend_usd,
      'activeChildren',usage.active_children) into graph_budget
    from internal.factory_workflow_attempt_budget(root.id,graph_policy) usage;
  end if;

  return response || jsonb_build_object('events',page_events,'nextCursor',next_cursor,
    'budget',jsonb_build_object('session',session_budget,'graph',graph_budget));
end;
$$;
revoke all on function public.read_factory_workflow_inspection(uuid,uuid,jsonb,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.read_factory_workflow_inspection(uuid,uuid,jsonb,integer) to authenticated;
