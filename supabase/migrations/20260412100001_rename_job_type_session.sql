-- Rename the agent_jobs.job_type discriminator from 'pipeline' to 'session'.
-- The job is scoped to a session, not the pipeline workflow itself.

update public.agent_jobs
  set job_type = 'session'
  where job_type = 'pipeline';
