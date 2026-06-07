-- Track all jobs a worker is processing, not just one.
--
-- The worker now processes multiple claimed jobs concurrently in a single
-- process, so its heartbeat must report every in-flight job. The stall
-- detector reads these ids to skip runs a live worker is actively holding.
--
-- We replace the single `active_job_id` uuid (with its FK to agent_jobs) with
-- an `active_job_ids` uuid[]. Postgres arrays can't carry a foreign key, so
-- the previous `on delete set null` behaviour is dropped. This is safe: the
-- heartbeat row is fully rewritten with the live in-flight set every ~10s, and
-- the stall detector only treats an id as "fresh" when the job is still
-- running — so a deleted job's id self-clears on the next heartbeat tick.

alter table public.worker_heartbeats drop column active_job_id;

alter table public.worker_heartbeats
  add column active_job_ids uuid[] not null default '{}';
