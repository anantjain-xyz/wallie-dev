-- Let a pipeline stage explicitly allow any active workspace member to approve.
-- The existing empty-list owner/admin fallback remains unchanged for backwards
-- compatibility; this flag is the opt-in all-members policy.
alter table public.pipeline_stages
  add column if not exists anyone_can_approve boolean not null default false;

-- Keep the existing rewrite implementation as the source of truth for stage
-- validation and ordering, then persist the new policy in the same transaction.
create or replace function public.rewrite_default_pipeline_with_approval_policy(
  target_workspace_id uuid,
  pipeline_name text,
  stage_payload jsonb,
  operating_rules_md text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rewrite_result jsonb;
begin
  rewrite_result := public.rewrite_default_pipeline(
    target_workspace_id,
    pipeline_name,
    stage_payload,
    operating_rules_md
  );

  if not coalesce((rewrite_result ->> 'ok')::boolean, false) then
    return rewrite_result;
  end if;

  update public.pipeline_stages ps
  set anyone_can_approve = coalesce(
    (payload.stage ->> 'anyoneCanApprove')::boolean,
    ps.anyone_can_approve
  )
  from public.pipelines p,
       jsonb_array_elements(stage_payload) as payload(stage)
  where p.workspace_id = target_workspace_id
    and p.is_default = true
    and ps.pipeline_id = p.id
    and ps.slug = payload.stage ->> 'slug';

  return rewrite_result;
end;
$$;

revoke all on function public.rewrite_default_pipeline_with_approval_policy(uuid, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.rewrite_default_pipeline_with_approval_policy(uuid, text, jsonb, text)
  to service_role;

-- Preserve the existing CAS and archive guards while adding the explicit
-- all-members branch to the approver gate.
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
  anyone_can_approve_v boolean;
  approver_role public.member_role;
  approver_active boolean;
  approver_workspace uuid;
  next_stage_id uuid;
  approved_at_now timestamptz := now();
begin
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

  select ps.position, ps.slug, ps.approver_member_ids, ps.anyone_can_approve
  into current_position, current_stage_slug_v, approver_list, anyone_can_approve_v
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

  if coalesce(anyone_can_approve_v, false) then
    -- The lookup above already established that this is an active member of
    -- the session's workspace. Service-side null approvals remain forbidden.
    if approver_member_id is null then
      return;
    end if;
  elsif coalesce(array_length(approver_list, 1), 0) > 0 then
    if approver_member_id is null
       or not (approver_member_id = any(approver_list)) then
      return;
    end if;
  else
    if approver_member_id is null
       or approver_role is null
       or approver_role not in ('owner', 'admin') then
      return;
    end if;
  end if;

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
