-- agent_jobs.job_type is no longer polymorphic. Only the pipeline job type
-- ('session') is supported. The previous dispatcher returned a "Phase 2 not
-- implemented" error for any other value, which would have wedged the queue
-- on retry. Encode the invariant in the schema instead.

alter table public.agent_jobs
  add constraint agent_jobs_job_type_pipeline_only_check
  check (job_type = 'session');
