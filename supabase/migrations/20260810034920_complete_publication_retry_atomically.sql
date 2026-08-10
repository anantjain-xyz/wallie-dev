-- Publication-only retries have no active agent run. Complete the durable job
-- in the same transaction that exposes the preserved artifact for review so a
-- worker crash cannot leave an awaiting-review session behind a running job.

create function public.complete_publication_retry_attempt(
  target_job_id uuid,
  expected_attempt_count int,
  expected_last_error text,
  target_session_id uuid,
  expected_artifact_version int
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_session_id uuid;
  locked_job_id uuid;
begin
  -- Publication stall recovery uses this same session-before-job lock order.
  select id into locked_session_id
  from public.sessions
  where id = target_session_id
    and current_artifact_version = expected_artifact_version
    and phase_status = 'in_progress'
    and archived_at is null
  for update;

  if not found then
    return false;
  end if;

  select id into locked_job_id
  from public.agent_jobs
  where id = target_job_id
    and session_id = target_session_id
    and status = 'running'
    and attempt_count = expected_attempt_count
    and last_error is not distinct from expected_last_error
  for update;

  if not found then
    return false;
  end if;

  update public.sessions
  set phase_status = 'awaiting_review'
  where id = locked_session_id;

  update public.agent_jobs
  set
    status = 'success',
    scheduled_at = null,
    finished_at = now(),
    last_error = null
  where id = locked_job_id;

  return true;
end;
$$;

revoke all on function public.complete_publication_retry_attempt(
  uuid,
  integer,
  text,
  uuid,
  integer
) from public, anon, authenticated;

grant execute on function public.complete_publication_retry_attempt(
  uuid,
  integer,
  text,
  uuid,
  integer
) to service_role;
