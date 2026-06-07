-- Make stage approval atomic with respect to archiving.
--
-- Previously `approve_session_stage` gated its lookup and CAS only on
-- (workspace, version, awaiting_review). An archive that landed between the
-- phase-action route's membership read and this RPC could still let an archived
-- session advance — and on a non-terminal approval the next stage was set to
-- `agent_generating` while the processor (which checks `archived_at`) never
-- queued a job, wedging the session. Adding `archived_at is null` to the lookup
-- and the CAS turns approval into a no-op for archived sessions.
create or replace function public.approve_session_stage(
  target_session_id uuid,
  expected_workspace_id uuid,
  expected_version integer,
  approver_member_id uuid default null
)
returns table (
  id uuid,
  pipeline_id uuid,
  current_stage_id uuid,
  current_stage_slug text,
  phase_status public.pipeline_phase_status,
  workspace_id uuid,
  linear_issue_url text,
  archived_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  session_pipeline_id uuid;
  current_stage_id_v uuid;
  current_stage_slug_v text;
  current_position integer;
  approver_list uuid[];
  approver_role public.member_role;
  approver_active boolean;
  approver_workspace uuid;
  next_stage_id uuid;
  approved_at_now timestamptz := now();
begin
  -- Lookup the current stage so we can check approvers BEFORE flipping state.
  -- An archived session is frozen and must not advance.
  select s.pipeline_id, s.current_stage_id
  into session_pipeline_id, current_stage_id_v
  from public.sessions s
  where s.id = target_session_id
    and s.workspace_id = expected_workspace_id
    and s.current_artifact_version = expected_version
    and s.phase_status = 'awaiting_review'
    and s.archived_at is null;

  if current_stage_id_v is null then
    return;
  end if;

  select ps.position, ps.slug, ps.approver_member_ids
  into current_position, current_stage_slug_v, approver_list
  from public.pipeline_stages ps
  where ps.id = current_stage_id_v;

  if approver_member_id is not null then
    select wm.role, wm.is_active, wm.workspace_id
    into approver_role, approver_active, approver_workspace
    from public.workspace_members wm
    where wm.id = approver_member_id;

    if not coalesce(approver_active, false)
       or approver_workspace is distinct from expected_workspace_id then
      return;
    end if;
  end if;

  if coalesce(array_length(approver_list, 1), 0) > 0 then
    if approver_member_id is null
       or not (approver_member_id = any(approver_list)) then
      return;
    end if;
  else
    -- Empty list: fall back to workspace owner/admin.
    if approver_member_id is null
       or approver_role is null
       or approver_role not in ('owner', 'admin') then
      return;
    end if;
  end if;

  -- Approver checks passed; flip phase_status with the same CAS gate as before,
  -- now also guarding against a concurrent archive landing before this update.
  update public.sessions s
  set phase_status = 'approved'
  where s.id = target_session_id
    and s.workspace_id = expected_workspace_id
    and s.current_artifact_version = expected_version
    and s.phase_status = 'awaiting_review'
    and s.archived_at is null;

  if not found then
    return;
  end if;

  insert into public.session_phase_completions (
    session_id,
    workspace_id,
    stage_id,
    stage_slug,
    completed_at,
    completed_by_member_id
  )
  values (
    target_session_id,
    expected_workspace_id,
    current_stage_id_v,
    current_stage_slug_v,
    approved_at_now,
    approver_member_id
  )
  on conflict (session_id, stage_slug) do nothing;

  -- Find the next stage by position. Null result = terminal stage; archive.
  select ps.id into next_stage_id
  from public.pipeline_stages ps
  where ps.pipeline_id = session_pipeline_id
    and ps.position > current_position
  order by ps.position asc
  limit 1;

  if next_stage_id is null then
    update public.sessions s
    set archived_at = approved_at_now
    where s.id = target_session_id;
  else
    update public.sessions s
    set current_stage_id = next_stage_id,
        phase_status = 'agent_generating',
        current_artifact_version = 0,
        rejection_count = 0
    where s.id = target_session_id;
  end if;

  return query
    select
      s.id,
      s.pipeline_id,
      s.current_stage_id,
      ps.slug,
      s.phase_status,
      s.workspace_id,
      s.linear_issue_url,
      s.archived_at
    from public.sessions s
    join public.pipeline_stages ps on ps.id = s.current_stage_id
    where s.id = target_session_id;
end;
$$;

revoke all on function public.approve_session_stage(uuid, uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.approve_session_stage(uuid, uuid, integer, uuid)
  to service_role;
