-- Rename the next_issue_number RPC to next_session_number.
-- Sessions reuse the same workspace_issue_counters table (the counter
-- is workspace-scoped, not table-scoped), but the old name is misleading
-- now that sessions are the primary entity.

create or replace function public.next_session_number(target_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  allocated_number integer;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not exists (
       select 1
       from public.current_user_workspace_ids() as workspace_ids(workspace_id)
       where workspace_id = target_workspace_id
     ) then
    raise exception 'Not authorized to allocate session numbers for workspace %', target_workspace_id
      using errcode = '42501';
  end if;

  insert into internal.workspace_issue_counters as counters (
    workspace_id,
    last_issue_number
  )
  values (target_workspace_id, 1)
  on conflict (workspace_id)
  do update
    set last_issue_number = counters.last_issue_number + 1,
        updated_at = now()
  returning last_issue_number into allocated_number;

  return allocated_number;
end;
$$;

grant execute on function public.next_session_number(uuid) to authenticated;

-- Keep the old name as a thin alias for one deploy cycle so in-flight
-- requests from the previous code revision still work.
create or replace function public.next_issue_number(target_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.next_session_number(target_workspace_id);
end;
$$;
