-- Tighten publication recovery around the exact worker attempt and acquire
-- session/job locks in the same order as successful publication. This keeps a
-- late worker from mutating a retry that another worker already reclaimed.

drop function public.schedule_job_retry_with_error(uuid, text, integer, integer);

create function public.schedule_job_retry_with_error(
  target_job_id uuid,
  error_message text,
  expected_attempt_count int,
  base_delay_ms int default 5000,
  max_backoff_ms int default 300000
)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_attempt int;
  delay_ms int;
  next_retry timestamptz;
begin
  select attempt_count into current_attempt
  from public.agent_jobs
  where id = target_job_id
    and status = 'running'
    and attempt_count = expected_attempt_count
  for update;

  if not found then
    return;
  end if;

  delay_ms := least(base_delay_ms * power(2, current_attempt)::int, max_backoff_ms);
  next_retry := now() + (delay_ms || ' milliseconds')::interval;

  return query
  update public.agent_jobs
  set
    status = 'queued',
    scheduled_at = next_retry,
    finished_at = null,
    last_error = error_message
  where id = target_job_id
    and status = 'running'
    and attempt_count = expected_attempt_count
  returning *;
end;
$$;

create or replace function public.recover_stalled_publication_job(
  target_job_id uuid,
  expected_updated_at timestamptz,
  expected_last_error text,
  stall_reason text,
  max_retries int,
  base_delay_ms int default 5000,
  max_backoff_ms int default 300000
)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_session_id uuid;
  current_session_status public.pipeline_phase_status;
  current_job public.agent_jobs%rowtype;
  recovered_job public.agent_jobs%rowtype;
  delay_ms int;
  next_retry timestamptz;
begin
  select session_id into target_session_id
  from public.agent_jobs
  where id = target_job_id;

  if not found then
    return;
  end if;

  -- Successful publication locks the session before completing the job. Use
  -- the same order here to avoid a job/session deadlock, and stop immediately
  -- if publication already advanced the session to review.
  select phase_status into current_session_status
  from public.sessions
  where id = target_session_id
  for update;

  if not found or current_session_status <> 'in_progress' then
    return;
  end if;

  select * into current_job
  from public.agent_jobs
  where id = target_job_id
    and session_id = target_session_id
    and status = 'running'
    and updated_at = expected_updated_at
    and last_error is not distinct from expected_last_error
  for update;

  if not found then
    return;
  end if;

  update public.sessions
  set phase_status = 'rejected'
  where id = target_session_id
    and phase_status = 'in_progress';

  if not found then
    return;
  end if;

  if current_job.attempt_count < max_retries then
    delay_ms := least(
      base_delay_ms * power(2, current_job.attempt_count)::int,
      max_backoff_ms
    );
    next_retry := now() + (delay_ms || ' milliseconds')::interval;

    update public.agent_jobs
    set
      status = 'queued',
      scheduled_at = next_retry,
      finished_at = null
    where id = current_job.id
    returning * into recovered_job;
  else
    update public.agent_jobs
    set
      status = 'error',
      finished_at = now(),
      last_error = stall_reason
    where id = current_job.id
    returning * into recovered_job;
  end if;

  return next recovered_job;
end;
$$;

revoke all on function public.schedule_job_retry_with_error(
  uuid,
  text,
  integer,
  integer,
  integer
) from public, anon, authenticated;
revoke all on function public.recover_stalled_publication_job(
  uuid,
  timestamptz,
  text,
  text,
  integer,
  integer,
  integer
) from public, anon, authenticated;

grant execute on function public.schedule_job_retry_with_error(
  uuid,
  text,
  integer,
  integer,
  integer
) to service_role;
grant execute on function public.recover_stalled_publication_job(
  uuid,
  timestamptz,
  text,
  text,
  integer,
  integer,
  integer
) to service_role;
