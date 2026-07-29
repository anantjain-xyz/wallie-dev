-- DROP TABLE public.jobs;
/* ALTER TABLE public.jobs
   RENAME COLUMN id TO old_id; */
select 'DROP COLUMN active_job_id';
select E'escaped quote: \'; DROP TABLE public.jobs;';

create or replace function public.describe_job(job_id uuid)
returns text
language sql
as $function$
  select 'RENAME and DROP are data here: ' || job_id::text;
$function$;
