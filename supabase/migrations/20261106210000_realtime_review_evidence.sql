-- Review evidence must not stay Ready after a thread, refresh, or observation change.
alter table public.session_pr_refresh_queue replica identity full;
alter table public.session_pr_verification_observations replica identity full;
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='session_pr_refresh_queue') then
    alter publication supabase_realtime add table public.session_pr_refresh_queue;
  end if;
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='session_pr_verification_observations') then
    alter publication supabase_realtime add table public.session_pr_verification_observations;
  end if;
end; $$;
