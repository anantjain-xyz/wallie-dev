create function public.lookup_job(job_id uuid)
returns text
language sql
security invoker
as $function$
  select 'initial uuid overload';
$function$;

create function public.lookup_job(job_key text)
returns text
language sql
security definer
as $function$
  select 'initial text overload';
$function$;

create or replace function public.lookup_job(job_id uuid)
returns text
language sql
security invoker
as $function$
  select 'uuid replacement';
$function$;

create or replace function public.lookup_job(job_key text)
returns text
language sql
security definer
as $function$
  select 'text overload replacement';
$function$;
