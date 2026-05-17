-- Session creation remains browser-initiated, but workspaces must finish
-- onboarding before clients can insert the first session.

drop policy if exists sessions_insert_membership on public.sessions;

create policy sessions_insert_membership
  on public.sessions
  for insert
  to authenticated
  with check (
    workspace_id in (select public.current_user_workspace_ids())
    and workspace_id in (
      select onboarding.workspace_id
      from public.workspace_onboarding onboarding
      where onboarding.status = 'completed'
    )
    and phase_status = 'agent_generating'
    and current_artifact_version = 0
    and rejection_count = 0
    and archived_at is null
  );
