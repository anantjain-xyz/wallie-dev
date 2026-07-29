-- wallie-migration-safety: allow drop-column:public.agent_jobs.active_job_id owner=@anantjain-xyz issue=OP-387
create table public.safe_addition (
  id uuid primary key
);
