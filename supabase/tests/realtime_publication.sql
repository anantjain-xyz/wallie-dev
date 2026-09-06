begin;

create extension if not exists pgtap with schema extensions;

select plan(6);
set local "request.jwt.claim.role" = 'service_role';

select ok(
  exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'sessions'
  ),
  'sessions is in supabase_realtime'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'agent_runs'
  ),
  'agent_runs is in supabase_realtime'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'agent_run_messages'
  ),
  'agent_run_messages is in supabase_realtime'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'session_artifacts'
  ),
  'session_artifacts is in supabase_realtime'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'session_phase_completions'
  ),
  'session_phase_completions is in supabase_realtime'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'session_pull_requests'
  ),
  'session_pull_requests is in supabase_realtime'
);

select * from finish();

commit;
