-- Phase 1: Worker Infrastructure for Symphony convergence.
--
-- 1.1  Worker heartbeats table — workers report liveness periodically.
--      The web app / dashboard can query this to show worker health.
--
-- 1.3  Stall detection — add last_activity_at to agent_runs so the worker
--      can sweep for runs that have gone silent past the workspace's
--      stall_timeout_ms threshold.
--
-- Together these support the standalone worker process, stall detection,
-- and reconciliation features.

-- -----------------------------------------------------------------------
-- 1.1 — worker_heartbeats
-- -----------------------------------------------------------------------

create table public.worker_heartbeats (
  id uuid primary key default gen_random_uuid(),
  worker_id text not null,
  started_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  active_job_id uuid references public.agent_jobs(id) on delete set null,
  metadata jsonb not null default '{}',
  constraint worker_heartbeats_worker_id_unique unique (worker_id)
);

-- Index for finding stale workers (those that haven't heartbeated recently).
create index worker_heartbeats_last_heartbeat_idx
  on public.worker_heartbeats (last_heartbeat_at);

-- RLS: worker_heartbeats is managed by the service role only.
-- The web app reads via admin client for the health dashboard.
alter table public.worker_heartbeats enable row level security;

-- Authenticated users can read heartbeats (for dashboard visibility).
create policy "worker_heartbeats_select"
  on public.worker_heartbeats
  for select
  using (true);

-- Only service_role can insert/update/delete.
-- (No authenticated-user write policies — workers use the admin client.)

-- -----------------------------------------------------------------------
-- 1.3 — agent_runs.last_activity_at for stall detection
-- -----------------------------------------------------------------------

alter table public.agent_runs
  add column last_activity_at timestamptz;

-- Backfill existing rows: use updated_at as a reasonable proxy.
update public.agent_runs
set last_activity_at = updated_at
where last_activity_at is null;

-- Index for the stall-detection sweep: find running runs whose
-- last_activity_at is older than the workspace's stall threshold.
create index agent_runs_stall_sweep_idx
  on public.agent_runs (last_activity_at)
  where status in ('queued', 'started', 'running');
