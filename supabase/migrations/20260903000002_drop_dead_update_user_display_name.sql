-- Drop the superseded update_user_display_name RPC.
-- Superseded by update_user_profile in 20260823133717_add_user_profile_avatars.sql.
-- Zero TypeScript callers exist.

revoke execute on function public.update_user_display_name(uuid, text) from authenticated;
drop function if exists public.update_user_display_name(uuid, text);

-- Recreate sessions_insert_membership with the current enum value.
-- The original (init.sql:2546) still says 'agent_generating', which was renamed
-- to 'in_progress' by 20260808000004_rename_agent_generating_phase.sql.
-- Postgres resolved it by OID so the policy has been working, but the text
-- is misleading. Drop and recreate with the correct literal.

drop policy if exists sessions_insert_membership on public.sessions;

create policy sessions_insert_membership
  on public.sessions
  for insert
  to authenticated
  with check (
    workspace_id in (select internal.current_user_workspace_ids())
    and workspace_id in (
      select onboarding.workspace_id
      from public.workspace_onboarding onboarding
      where onboarding.status = 'completed'
    )
    and phase_status = 'in_progress'
    and current_artifact_version = 0
    and rejection_count = 0
    and archived_at is null
  );
