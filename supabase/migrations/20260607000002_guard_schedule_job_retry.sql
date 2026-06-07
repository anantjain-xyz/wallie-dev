-- Stop a cancelled job from being resurrected by a retry.
--
-- `schedule_job_retry` re-queues a job by flipping it back to `queued` with a
-- backoff `scheduled_at`. It is called both synchronously (markPipelineJobError,
-- deferPipelineJob) and by the stall detector. None of those callers re-check
-- the job's status first, so a worker that finishes processing *after* a user
-- cancels the run would re-queue the now-`canceled` job and the worker would
-- pick it up again — the exact retry loop cancel is meant to break.
--
-- Guard the update so a `canceled` job is never moved back to `queued`. Callers
-- only inspect the RPC error, never the affected row count, so a 0-row no-op is
-- silently correct.

create or replace function public.schedule_job_retry(
  target_job_id uuid,
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
  for update;

  if current_attempt is null then
    return;
  end if;

  delay_ms := least(base_delay_ms * power(2, current_attempt)::int, max_backoff_ms);
  next_retry := now() + (delay_ms || ' milliseconds')::interval;

  return query
  update public.agent_jobs
  set
    status = 'queued',
    scheduled_at = next_retry,
    finished_at = null
  where id = target_job_id
    and status <> 'canceled'
  returning *;
end;
$$;
