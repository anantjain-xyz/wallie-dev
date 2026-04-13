-- Phase 4: Operational Hardening for Symphony convergence.
--
-- 4.1  Exponential backoff — update claim_agent_job to skip jobs whose
--      scheduled_at is in the future, and add a schedule_job_retry RPC.
--
-- 4.2  Token accounting — add input_tokens, output_tokens, total_cost_usd
--      columns to agent_runs for per-run cost tracking.
--
-- 4.3  REST API — workspace_api_keys table so external clients can
--      authenticate against /api/v1/* endpoints.
--
-- 4.4  Worker health dashboard — no new schema needed; worker_heartbeats
--      already exists from Phase 1.

-- -----------------------------------------------------------------------
-- 4.1 — Exponential backoff: schedule_job_retry RPC
-- -----------------------------------------------------------------------
-- Computes next_retry_at = now() + min(base * 2^attempt, max_backoff)
-- and sets agent_jobs.scheduled_at + status='queued' so the job re-enters
-- the queue after a delay. Returns the updated row.

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
  -- Read the current attempt count.
  select attempt_count into current_attempt
  from public.agent_jobs
  where id = target_job_id
  for update;

  if current_attempt is null then
    return;
  end if;

  -- Compute delay: base * 2^attempt, capped at max_backoff.
  delay_ms := least(base_delay_ms * power(2, current_attempt)::int, max_backoff_ms);
  next_retry := now() + (delay_ms || ' milliseconds')::interval;

  return query
  update public.agent_jobs
  set
    status = 'queued',
    scheduled_at = next_retry,
    finished_at = null
  where id = target_job_id
  returning *;
end;
$$;

-- -----------------------------------------------------------------------
-- 4.1 — Update claim_agent_job to skip jobs scheduled in the future
-- -----------------------------------------------------------------------

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
  job_scheduled_at timestamptz;
  configured_limit int;
  effective_limit int;
  running_count int;
begin
  -- Look up the workspace for this job (also confirms it's still queued).
  select workspace_id, scheduled_at
  into job_workspace_id, job_scheduled_at
  from public.agent_jobs
  where id = target_job_id
    and status = 'queued'
  for update skip locked;

  if job_workspace_id is null then
    return;
  end if;

  -- Skip jobs scheduled for the future (exponential backoff).
  if job_scheduled_at is not null and job_scheduled_at > now() then
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
    return;
  end if;

  -- Claim: queued -> running.
  return query
  update public.agent_jobs
  set
    status = 'running',
    attempt_count = attempt_count + 1,
    last_error = null,
    started_at = coalesce(started_at, now()),
    scheduled_at = null
  where id = target_job_id
    and status = 'queued'
  returning *;
end;
$$;

-- -----------------------------------------------------------------------
-- 4.2 — Token accounting columns on agent_runs
-- -----------------------------------------------------------------------

alter table public.agent_runs
  add column if not exists input_tokens bigint,
  add column if not exists output_tokens bigint,
  add column if not exists total_cost_usd numeric(12, 6);

-- -----------------------------------------------------------------------
-- 4.3 — workspace_api_keys for REST API authentication
-- -----------------------------------------------------------------------

create table if not exists public.workspace_api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null default 'Default',
  key_hash text not null,
  key_prefix text not null,
  created_by_member_id uuid references public.workspace_members(id) on delete set null,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint workspace_api_keys_key_hash_unique unique (key_hash)
);

create index if not exists idx_workspace_api_keys_workspace
  on public.workspace_api_keys(workspace_id);

create index if not exists idx_workspace_api_keys_hash
  on public.workspace_api_keys(key_hash)
  where revoked_at is null;

alter table public.workspace_api_keys enable row level security;

create policy "workspace_api_keys_select"
  on public.workspace_api_keys for select to authenticated
  using (workspace_id in (select current_user_workspace_ids()));

create policy "workspace_api_keys_insert"
  on public.workspace_api_keys for insert to authenticated
  with check (can_manage_workspace(workspace_id));

create policy "workspace_api_keys_update"
  on public.workspace_api_keys for update to authenticated
  using (can_manage_workspace(workspace_id));

create policy "workspace_api_keys_delete"
  on public.workspace_api_keys for delete to authenticated
  using (can_manage_workspace(workspace_id));

create policy "workspace_api_keys_service_role_all"
  on public.workspace_api_keys for all to service_role
  using (true) with check (true);
