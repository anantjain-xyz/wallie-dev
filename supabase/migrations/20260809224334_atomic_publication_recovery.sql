-- Keep retry checkpoints and publication-stall recovery atomic. A queued job
-- is claimable as soon as its row is committed, so every piece of state needed
-- by the next worker must be persisted in the same transaction that requeues
-- it.

create or replace function public.schedule_job_retry_with_error(
  target_job_id uuid,
  error_message text,
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
  current_job public.agent_jobs%rowtype;
  recovered_job public.agent_jobs%rowtype;
  delay_ms int;
  next_retry timestamptz;
begin
  -- Claim the exact snapshot observed by the stall sweep. Locking the job
  -- before touching its session also prevents another worker from claiming a
  -- requeued job until both changes commit.
  select * into current_job
  from public.agent_jobs
  where id = target_job_id
    and status = 'running'
    and updated_at = expected_updated_at
    and last_error is not distinct from expected_last_error
  for update;

  if not found then
    return;
  end if;

  update public.sessions
  set phase_status = 'rejected'
  where id = current_job.session_id
    and phase_status = 'in_progress';

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

revoke all on function public.schedule_job_retry_with_error(uuid, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.recover_stalled_publication_job(
  uuid,
  timestamptz,
  text,
  text,
  integer,
  integer,
  integer
) from public, anon, authenticated;

grant execute on function public.schedule_job_retry_with_error(uuid, text, integer, integer)
  to service_role;
grant execute on function public.recover_stalled_publication_job(
  uuid,
  timestamptz,
  text,
  text,
  integer,
  integer,
  integer
) to service_role;
