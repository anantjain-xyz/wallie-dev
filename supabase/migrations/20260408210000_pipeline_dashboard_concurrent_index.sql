-- Build the agent_jobs (job_type, status) partial index concurrently.
--
-- Must run as its own migration so the statement executes outside a
-- transaction. CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block, and Supabase wraps multi-statement migration files in an implicit
-- transaction. Isolating the statement in its own file sidesteps the wrap.
create index concurrently if not exists agent_jobs_job_type_status_idx
  on public.agent_jobs (job_type, status)
  where status in ('queued', 'running');
