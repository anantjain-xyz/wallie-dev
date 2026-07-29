-- wallie-migration-safety: allow drop-column:"public"."agent_jobs"."active_job_id" owner=@anantjain-xyz issue=OP-387
alter table public.agent_jobs
  drop column if exists active_job_id;
