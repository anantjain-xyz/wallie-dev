-- Session creation must allocate its number, selected stages, first job, and
-- first run in the privileged creation transaction. The original client INSERT
-- grant bypassed that transaction and let members reserve arbitrary numbers.
-- Remove the original column grant explicitly, plus any table-level INSERT.
revoke insert (
  workspace_id,
  number,
  title,
  prompt_md,
  linear_issue_id,
  linear_issue_url,
  pipeline_id,
  current_stage_id,
  phase_status
) on public.sessions from authenticated;

revoke insert on public.sessions from authenticated;

drop policy if exists sessions_insert_membership on public.sessions;
