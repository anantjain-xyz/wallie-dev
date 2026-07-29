create or replace function public.lookup_job(job_id uuid)
returns text
language sql
as $function$
  select 'uuid replacement';
$function$;

create or replace function public.lookup_job(job_key text)
returns text
language sql
as $function$
  select 'text overload replacement';
$function$;
