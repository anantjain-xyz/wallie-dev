-- Keep agent job status aligned with active-job queries and the existing
-- active dedupe partial index, both of which treat started as in-flight.

alter type public.agent_job_status add value if not exists 'started' after 'queued';
