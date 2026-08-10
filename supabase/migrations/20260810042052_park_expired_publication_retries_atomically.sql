-- Expiring a publication retry must park the session in the same transaction
-- that terminalizes the job. Both functions lock session before job, matching
-- publication completion and stall recovery.

create or replace function public.finalize_publication_retry_attempt(
  target_job_id uuid,
  expected_attempt_count int,
  successful_run_id uuid,
  error_message text,
  max_retries int,
  successful_input_tokens bigint default null,
  successful_output_tokens bigint default null,
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
  locked_session_id uuid;
  current_job public.agent_jobs%rowtype;
  completed_job public.agent_jobs%rowtype;
  delay_ms int;
  next_retry timestamptz;
begin
  select session_id into target_session_id
  from public.agent_jobs
  where id = target_job_id;

  if not found then
    return;
  end if;

  select id into locked_session_id
  from public.sessions
  where id = target_session_id
    and phase_status = 'in_progress'
    and archived_at is null
  for update;

  if not found then
    return;
  end if;

  select * into current_job
  from public.agent_jobs
  where id = target_job_id
    and session_id = target_session_id
    and status = 'running'
    and attempt_count = expected_attempt_count
  for update;

  if not found then
    return;
  end if;

  update public.agent_runs
  set
    status = 'success',
    finished_at = now(),
    input_tokens = coalesce(successful_input_tokens, input_tokens),
    output_tokens = coalesce(successful_output_tokens, output_tokens)
  where id = successful_run_id
    and agent_job_id = target_job_id
    and status in ('queued', 'started', 'running');

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
      finished_at = null,
      last_error = error_message
    where id = current_job.id
    returning * into completed_job;
  else
    update public.sessions
    set phase_status = 'rejected'
    where id = locked_session_id;

    update public.agent_jobs
    set
      status = 'error',
      scheduled_at = null,
      finished_at = now(),
      last_error = error_message
    where id = current_job.id
    returning * into completed_job;
  end if;

  return next completed_job;
end;
$$;

create function public.fail_publication_retry_attempt(
  target_job_id uuid,
  expected_attempt_count int,
  error_message text,
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
  locked_session_id uuid;
  current_job public.agent_jobs%rowtype;
  completed_job public.agent_jobs%rowtype;
  delay_ms int;
  next_retry timestamptz;
begin
  select session_id into target_session_id
  from public.agent_jobs
  where id = target_job_id;

  if not found then
    return;
  end if;

  select id into locked_session_id
  from public.sessions
  where id = target_session_id
    and phase_status = 'in_progress'
    and archived_at is null
  for update;

  if not found then
    return;
  end if;

  select * into current_job
  from public.agent_jobs
  where id = target_job_id
    and session_id = target_session_id
    and status = 'running'
    and attempt_count = expected_attempt_count
  for update;

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
      finished_at = null,
      last_error = error_message
    where id = current_job.id
    returning * into completed_job;
  else
    update public.sessions
    set phase_status = 'rejected'
    where id = locked_session_id;

    update public.agent_jobs
    set
      status = 'error',
      scheduled_at = null,
      finished_at = now(),
      last_error = error_message
    where id = current_job.id
    returning * into completed_job;
  end if;

  return next completed_job;
end;
$$;

revoke all on function public.fail_publication_retry_attempt(
  uuid,
  integer,
  text,
  integer,
  integer,
  integer
) from public, anon, authenticated;

grant execute on function public.fail_publication_retry_attempt(
  uuid,
  integer,
  text,
  integer,
  integer,
  integer
) to service_role;
