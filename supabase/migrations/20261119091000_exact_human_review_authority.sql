create or replace function public.approve_session_stage(target_session_id uuid, expected_workspace_id uuid, expected_stage_id uuid,
  expected_artifact_id uuid, expected_version integer, approver_member_id uuid, p_agent_model_provider text,
  p_agent_model_name text, p_run_type text default 'project', p_expected_review_revision bigint default null)
returns table(id uuid,pipeline_id uuid,current_stage_id uuid,current_stage_slug text,phase_status public.pipeline_phase_status,
  workspace_id uuid,linear_issue_url text,archived_at timestamptz,current_artifact_version integer,rejection_count integer,
  job_id uuid,run_id uuid,job_created boolean)
language plpgsql security definer set search_path = '' as $$
declare target_factory_id uuid; reviewed public.sessions;
begin
  -- Session factory scope is immutable. Discover its identity without
  -- locking the review so we can take workspace, factory, and human fences
  -- in the same order as the existing mutation commands.
  select session.factory_id into target_factory_id from public.sessions session
  where (session.id, session.workspace_id) = (target_session_id, expected_workspace_id);
  if not found then return; end if;
  if not exists (
    select 1 from public.workspace_members member
    where (member.workspace_id, member.id) = (expected_workspace_id, approver_member_id)
      and member.kind = 'human' and member.is_active
  ) then return; end if;
  perform internal.assert_session_mutation_human_access(expected_workspace_id, target_factory_id, approver_member_id);

  select session.* into reviewed from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) =
    (target_session_id, expected_workspace_id, target_factory_id)
  for no key update;
  if not found then return; end if;

  if reviewed.archived_at is null and reviewed.phase_status = 'awaiting_review'
    and (reviewed.specification_stage_id, reviewed.current_stage_id, reviewed.current_artifact_id,
      reviewed.current_artifact_version, reviewed.artifact_review_revision) =
      (expected_stage_id, expected_stage_id, expected_artifact_id, expected_version, p_expected_review_revision)
    and exists (
      select 1 from public.session_specification_clarifications clarification
      where (clarification.workspace_id, clarification.factory_id, clarification.session_id,
        clarification.stage_id, clarification.artifact_id, clarification.artifact_version) =
        (expected_workspace_id, target_factory_id, target_session_id, expected_stage_id, expected_artifact_id, expected_version)
        and clarification.status = 'pending'
    ) then
    raise exception 'Answer the open specification clarification before approving.' using errcode = 'PT423';
  end if;

  return query select * from internal.approve_session_stage(target_session_id, expected_workspace_id,
    expected_stage_id, expected_artifact_id, expected_version, approver_member_id, p_agent_model_provider,
    p_agent_model_name, p_run_type, p_expected_review_revision);
end;
$$;
