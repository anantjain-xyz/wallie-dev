begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65130000
\set op651_open_groups true
\set op651_parallel_only true
\ir fixtures/factory_workflow_branch.psql

create extension if not exists dblink with schema extensions;

-- Publish the single scoped seed so three database connections can contend.
commit;

create function pg_temp.op651_branch_admit_sql(p_edge text) returns text language sql as $$
  select format(
    'select * from public.admit_factory_workflow_branch_slot(%L::uuid,%L::uuid,%L::uuid,%L::bigint,%L::uuid,%L::uuid,%L)',
    root."sessionId", root.workspace_id, root.factory_id, root.execution_generation,
    root.ownership_token, groups.group_id, p_edge
  )
  from branch_owner root join branch_groups groups using (scenario)
  where root.scenario = 'parallel'
$$;

create function pg_temp.op651_wait_for_branch_lock() returns boolean language plpgsql as $$
declare
  deadline timestamptz := clock_timestamp() + interval '8 seconds';
begin
  loop
    if (
      -- PostgreSQL can put the sibling behind the replay in the same lock queue.
      with recursive blockers(waiter, holder) as (
        select peer.pid, blocker.pid
        from pg_stat_activity peer
        cross join lateral unnest(pg_blocking_pids(peer.pid)) blocker(pid)
        where peer.datname = current_database()
          and peer.application_name in ('op651_branch_replay','op651_branch_sibling')
        union
        select prior.waiter, blocker.pid
        from blockers prior
        cross join lateral unnest(pg_blocking_pids(prior.holder)) blocker(pid)
      )
      select count(distinct blockers.waiter) = 2 from blockers
      join pg_stat_activity holder on holder.pid = blockers.holder
      where holder.datname = current_database() and holder.application_name = 'op651_branch_holder'
    ) then return true; end if;
    if clock_timestamp() >= deadline then return false; end if;
    perform pg_sleep(0.02);
  end loop;
end;
$$;

create function pg_temp.op651_test_parallel_admission() returns setof text language plpgsql as $$
declare
  connection_info text := coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
    'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres');
  peer text;
  seeded boolean;
begin
  foreach peer in array array['op651_branch_holder','op651_branch_replay','op651_branch_sibling'] loop
    perform extensions.dblink_connect(peer, connection_info);
    select visible into strict seeded
    from extensions.dblink(peer, format('select current_database() = %L and exists (
        select 1 from public.workspaces where id = %L::uuid
      )', current_database(), pg_temp.op651_id(11))) seed(visible boolean);
    if not seeded then raise exception 'The independent connection cannot see the committed OP651 fixture.'; end if;
    perform extensions.dblink_exec(peer, format(
      'set application_name=%L; set statement_timeout=%L; set request.jwt.claim.role=%L',
      peer, '15s', 'service_role'
    ));
  end loop;

  perform extensions.dblink_exec('op651_branch_holder', 'begin');
  create temp table race_holder as
  select * from extensions.dblink('op651_branch_holder', pg_temp.op651_branch_admit_sql('run.required')) admitted(
    target_occurrence_id uuid, child_session_id uuid, job_id uuid, run_id uuid, created boolean
  );
  return query select is(extensions.dblink_send_query('op651_branch_replay', pg_temp.op651_branch_admit_sql('run.required')), 1,
    'same-slot contender starts while the root lock is held');
  return query select is(extensions.dblink_send_query('op651_branch_sibling', pg_temp.op651_branch_admit_sql('run.optional')), 1,
    'sibling contender starts while the same root lock is held');
  return query select ok(pg_temp.op651_wait_for_branch_lock(), 'both real connections wait on the owned root');
  perform extensions.dblink_exec('op651_branch_holder', 'commit');

  create temp table race_replay as
  select * from extensions.dblink_get_result('op651_branch_replay') admitted(
    target_occurrence_id uuid, child_session_id uuid, job_id uuid, run_id uuid, created boolean
  );
  create temp table race_sibling as
  select * from extensions.dblink_get_result('op651_branch_sibling') admitted(
    target_occurrence_id uuid, child_session_id uuid, job_id uuid, run_id uuid, created boolean
  );
  return query select ok((select holder.created and not replay.created and
      (holder.child_session_id, holder.target_occurrence_id, holder.job_id, holder.run_id) =
      (replay.child_session_id, replay.target_occurrence_id, replay.job_id, replay.run_id)
    from race_holder holder cross join race_replay replay), 'racing same-slot requests share one exact admission');
  return query select ok((select sibling.created and sibling.child_session_id <> holder.child_session_id
      and sibling.target_occurrence_id <> holder.target_occurrence_id
    from race_holder holder cross join race_sibling sibling), 'the sibling retains an independent admission after serialization');
  return query select ok((select count(*) = 2 and count(distinct reservation.job_id) = 2
    from branch_owner root join internal.factory_workflow_attempt_reservations reservation on reservation.root_session_id = root."sessionId"),
    'the two contenders leave exactly one reservation per declared child');
  return query select ok((select count(*) = 2
    from branch_owner root join internal.factory_workflow_transition_receipts transition on transition.root_session_id = root."sessionId"
    where transition.edge_kind = 'branch'), 'the concurrent admission leaves exactly two branch transitions');
  return query select ok((select head.checkpoint_run_id = root.checkpoint_run_id
    from branch_owner root join public.session_git_heads head on head.session_id = root."sessionId"),
    'the accepted parent checkpoint survives both racing admissions');
exception when query_canceled or others then
  -- Report an unexpected peer failure as TAP and let the caller release the
  -- peer transactions and delete the committed seed.
  return next fail(format('independent branch transactions failed (%s): %s', SQLSTATE, SQLERRM));
end;
$$;

select * from pg_temp.op651_test_parallel_admission();
select extensions.dblink_disconnect(peer.name)
from (values ('op651_branch_holder'), ('op651_branch_replay'), ('op651_branch_sibling')) peer(name)
where peer.name = any(coalesce(extensions.dblink_get_connections(), '{}'::text[]));

begin;
set local request.jwt.claim.role = 'service_role';
delete from public.workspaces where id = pg_temp.op651_id(11);
delete from auth.users where id = pg_temp.op651_id(1);

-- Restore only a release change made by this fixture. An intervening
-- revision is a failed isolation check, never a change to overwrite.
create temp table op651_release_restored as
select restored.* from op651_release_before prior
cross join op651_release_enabled enabled
cross join lateral public.set_git_continuity_release(false, enabled.revision, prior.reason) restored;

select ok(not exists (select 1 from public.workspaces where id = pg_temp.op651_id(11))
  and not exists (select 1 from auth.users where id = pg_temp.op651_id(1)),
  'cleanup removes the exact workspace and seeded auth user');
select ok(not exists (select 1 from public.sessions where workspace_id = pg_temp.op651_id(11))
  and not exists (select 1 from internal.factory_workflow_executions where workspace_id = pg_temp.op651_id(11))
  and not exists (select 1 from internal.factory_workflow_attempt_reservations where workspace_id = pg_temp.op651_id(11)),
  'cleanup cascades the committed parent, children, ledger, and reservations');
select ok((select (current.enabled,current.reason) = (prior.enabled,prior.reason) and (
    (prior.enabled and (current.revision,current.updated_at) = (prior.revision,prior.updated_at)
      and not exists (select 1 from op651_release_restored))
    or (not prior.enabled and current.revision = prior.revision + 2
      and exists (select 1 from op651_release_restored restored where restored.revision = current.revision))
  )
  from op651_release_before prior cross join public.get_git_continuity_release_state() current),
  'cleanup leaves a pre-enabled release byte-for-byte unchanged or restores exactly its paused state and reason');
select * from finish();
commit;
