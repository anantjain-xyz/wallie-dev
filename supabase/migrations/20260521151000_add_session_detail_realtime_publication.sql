-- Add session-detail dependency tables to the Supabase Realtime publication.
-- This is intentionally a forward migration rather than an edit to the
-- historical init migration so already-provisioned environments receive it.

do $$
declare
  publication_name text := 'supabase_realtime';
  realtime_target text;
  realtime_targets text[] := array[
    'public.session_artifacts',
    'public.session_phase_completions',
    'public.session_pull_requests'
  ];
begin
  if not exists (select 1 from pg_publication where pubname = publication_name) then
    execute format('create publication %I', publication_name);
  end if;

  foreach realtime_target in array realtime_targets loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = publication_name
        and schemaname = split_part(realtime_target, '.', 1)
        and tablename = split_part(realtime_target, '.', 2)
    ) then
      execute format('alter publication %I add table only %s', publication_name, realtime_target);
    end if;
  end loop;
end
$$;
