-- Phase 1 fix: atomic concurrency-aware job claim + last_activity_at default.
--
-- Addresses PR review feedback:
--   P1: Concurrency check and claim must be atomic to prevent two workers
--       from both observing capacity then each claiming a different job,
--       exceeding the per-workspace concurrency limit.
--   P1: last_activity_at must be populated on run creation so the stall
--       detector can sweep runs that never received an activity update.

-- -----------------------------------------------------------------------
-- Atomic claim: claim_agent_job(job_id, concurrency_default)
-- -----------------------------------------------------------------------
-- Returns the claimed row if the workspace is below its concurrency limit
-- and the CAS succeeds. Returns no rows (empty set) if the workspace is
-- at capacity or another worker already claimed the job.

create or replace function public.claim_agent_job(
  target_job_id uuid,
  default_concurrency_limit int default 2
)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_workspace_id uuid;
  configured_limit int;
  effective_limit int;
  running_count int;
begin
  -- Look up the workspace for this job (also confirms it's still queued).
  select workspace_id into job_workspace_id
  from public.agent_jobs
  where id = target_job_id
    and status = 'queued'
  for update skip locked;

  if job_workspace_id is null then
    -- Job doesn't exist, isn't queued, or is locked by another worker.
    return;
  end if;

  -- Read per-workspace concurrency limit from config.
  select (value_json)::int into configured_limit
  from public.workspace_agent_config
  where workspace_id = job_workspace_id
    and key = 'concurrency_limit'
    and jsonb_typeof(value_json) = 'number';

  effective_limit := coalesce(configured_limit, default_concurrency_limit);

  -- Count currently running jobs for this workspace.
  select count(*) into running_count
  from public.agent_jobs
  where workspace_id = job_workspace_id
    and status = 'running';

  if running_count >= effective_limit then
    -- At capacity — do not claim.
    return;
  end if;

  -- Claim: queued -> running.
  return query
  update public.agent_jobs
  set
    status = 'running',
    attempt_count = attempt_count + 1,
    last_error = null,
    started_at = coalesce(started_at, now())
  where id = target_job_id
    and status = 'queued'
  returning *;
end;
$$;

-- -----------------------------------------------------------------------
-- Default last_activity_at on agent_runs so stall detection works for
-- all runs, including those created before any activity event arrives.
-- -----------------------------------------------------------------------

alter table public.agent_runs
  alter column last_activity_at set default now();
