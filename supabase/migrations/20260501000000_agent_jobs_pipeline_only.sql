-- agent_jobs.job_type is no longer polymorphic. Only the pipeline job type
-- ('session') is supported. The previous dispatcher returned a "Phase 2 not
-- implemented" error for any other value, which would have wedged the queue
-- on retry. Encode the invariant in the schema instead.

-- Normalize any pre-existing rows first so the validating CHECK below cannot
-- fail on environments that ran the old seed (which inserted job_type =
-- 'pipeline') or any other historical literal. Production has never had a
-- code path that writes a non-'session' job_type, so this is a no-op there.
update public.agent_jobs
   set job_type = 'session'
 where job_type <> 'session';

alter table public.agent_jobs
  add constraint agent_jobs_job_type_pipeline_only_check
  check (job_type = 'session');
