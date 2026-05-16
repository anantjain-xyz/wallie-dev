-- New sessions are created from the browser client after the user selects a
-- workspace. The initial schema only granted SELECT on sessions, so PostgREST
-- rejected the insert before the membership trigger could attribute creator.

grant insert (
  workspace_id,
  number,
  title,
  prompt_md,
  linear_issue_id,
  linear_issue_url,
  pipeline_id,
  current_stage_id,
  phase_status
) on public.sessions to authenticated;

create policy sessions_insert_membership
  on public.sessions
  for insert
  to authenticated
  with check (
    workspace_id in (select public.current_user_workspace_ids())
    and phase_status = 'agent_generating'
    and current_artifact_version = 0
    and rejection_count = 0
    and archived_at is null
  );
