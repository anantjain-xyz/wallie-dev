-- Remove the single-value job discriminator now that all jobs are session jobs.
drop index if exists public.agent_jobs_job_type_status_idx;

alter table public.agent_jobs
  drop constraint if exists agent_jobs_job_type_pipeline_only_check;

alter table public.agent_jobs
  drop column if exists job_type;
