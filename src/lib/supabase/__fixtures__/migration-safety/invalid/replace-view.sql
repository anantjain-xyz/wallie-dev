create or replace view public.ready_jobs as
select id
from public.agent_jobs
where status = 'ready';
