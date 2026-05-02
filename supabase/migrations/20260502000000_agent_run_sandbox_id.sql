-- Track the sandbox that backs each agent run.
--
-- Without this linkage, a worker that crashes mid-stage leaves both an
-- `agent_runs` row in `running` AND a Vercel Sandbox in `running` — the stall
-- detector can mark the row errored, but it has no way to find and stop the
-- orphan VM. The sandbox-reaper uses this column to cross-reference active
-- sandboxes against active runs and stop ones whose owning run is gone.

alter table public.agent_runs
  add column sandbox_id text;

-- Reaper-side lookup: "which agent_runs currently own a sandbox_id?"
-- Partial index keeps it small (most rows are terminal and do not need to be
-- scanned).
create index agent_runs_sandbox_id_active_idx
  on public.agent_runs (sandbox_id)
  where sandbox_id is not null and status in ('queued', 'started', 'running');
