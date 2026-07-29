drop function if exists public.lookup_job(uuid);

create function public.lookup_job(uuid)
returns text
language sql
as $function$
  select 'replacement';
$function$;
