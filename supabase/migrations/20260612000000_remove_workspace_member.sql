-- Atomic member removal that also keeps pipelines approvable.
--
-- Soft-removing a member (is_active = false) revokes access immediately because
-- every RLS policy derives from active memberships. But a member id can also be
-- pinned as an explicit approver in pipeline_stages.approver_member_ids, and
-- approve_session_stage requires the submitting approver to be BOTH in that list
-- AND active. So removing a member who is the sole explicit approver on a stage
-- would leave the stage unapprovable until someone hand-edited the pipeline.
--
-- This function deactivates the member and prunes their id from every stage
-- approver list in the same transaction. A list that becomes empty falls back to
-- "any owner/admin can approve" (the documented default), so stages stay
-- approvable. Owner rows are refused — ownership transfer is out of scope.
create or replace function public.remove_workspace_member(
  target_member_id uuid,
  expected_workspace_id uuid
)
returns table (
  id uuid,
  full_name text,
  email text,
  role public.member_role
)
language plpgsql
security definer
set search_path = public
as $$
declare
  removed_id uuid;
  removed_full_name text;
  removed_email text;
  removed_role public.member_role;
begin
  update public.workspace_members wm
  set is_active = false
  where wm.id = target_member_id
    and wm.workspace_id = expected_workspace_id
    and wm.kind = 'human'
    and wm.is_active = true
    and wm.role <> 'owner'
  returning wm.id, wm.full_name, wm.email, wm.role
  into removed_id, removed_full_name, removed_email, removed_role;

  if removed_id is null then
    return;
  end if;

  update public.pipeline_stages ps
  set approver_member_ids = array_remove(ps.approver_member_ids, target_member_id)
  where ps.workspace_id = expected_workspace_id
    and target_member_id = any(ps.approver_member_ids);

  return query
    select removed_id, removed_full_name, removed_email, removed_role;
end;
$$;

revoke all on function public.remove_workspace_member(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.remove_workspace_member(uuid, uuid)
  to service_role;
