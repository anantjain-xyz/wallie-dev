begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65230000
\set op651_open_groups true
\set op651_parallel_only true
\set op652_join_evidence true
\ir fixtures/factory_workflow_branch.psql

create extension if not exists dblink with schema extensions;

-- Two approved no-code branches integrate at the existing commit. The root's
-- accepted checkpoint identity still changes when the join is adopted.
create function pg_temp.prepare_join_replay() returns table(
  run_id uuid, lease_id uuid, join_id uuid, occurrence_id uuid
) language plpgsql as $$
declare
  root record;
  group_id uuid;
  edge text;
  child record;
  output_id uuid;
  selected_ids uuid[] := '{}'::uuid[];
  queued jsonb;
  claimed public.agent_jobs;
  started jsonb;
  commit_sha text := repeat('a', 40);
  tree_sha text := repeat('e', 40);
begin
  select * into strict root from branch_owner;
  select groups.group_id into strict group_id from branch_groups groups;
  foreach edge in array array['run.required', 'run.optional'] loop
    select * into strict child from pg_temp.admit_slot(root.scenario, edge);
    perform pg_temp.adopt_source_checkpoint(child.child_session_id, child.job_id);
    perform pg_temp.approve_branch(child.child_session_id);
    select outcome.outcome_id into strict output_id from public.record_factory_workflow_branch_outcome(
      root."sessionId", root.workspace_id, root.factory_id, root.execution_generation,
      root.ownership_token, group_id, edge, child.job_id, 1, child.run_id) outcome;
    selected_ids := array_append(selected_ids, output_id);
  end loop;

  queued := public.enqueue_factory_workflow_join_for_user(root."sessionId", root.workspace_id, root.factory_id,
    pg_temp.op651_id(1), root.execution_generation, pg_temp.op651_id(220), group_id,
    root.checkpoint_run_id, selected_ids);
  join_id := (queued->>'joinId')::uuid;
  occurrence_id := (queued->>'occurrenceId')::uuid;
  select * into strict claimed from public.claim_next_agent_job(false, 3, 'node');
  if claimed.id is distinct from (queued->>'jobId')::uuid then
    raise exception 'Expected the exact fixture join job.';
  end if;
  started := public.start_factory_workflow_join_attempt(claimed.id, claimed.workspace_id, claimed.session_id,
    claimed.attempt_count, clock_timestamp() + interval '5 minutes');
  run_id := (started->>'runId')::uuid;
  if started->>'kind' <> 'started' or run_id is distinct from (queued->>'runId')::uuid then
    raise exception 'Expected the exact fixture join run.';
  end if;

  if not public.record_active_factory_workflow_join_candidate(root."sessionId", root.workspace_id, root.factory_id,
    root.execution_generation, root.ownership_token, join_id, claimed.id, run_id, claimed.attempt_count,
    commit_sha, tree_sha, null) then
    raise exception 'Expected the exact no-code join candidate.';
  end if;
  perform public.pin_session_validation_plan(run_id, commit_sha, tree_sha,
    '{"version":1,"commands":[{"key":"tests","command":"pnpm test","timeoutSeconds":30,"reports":[]}]}');
  perform public.record_session_validation_evidence(run_id, commit_sha, tree_sha,
    jsonb_build_array(jsonb_build_object('key', 'tests', 'command', 'pnpm test', 'provenance', 'harness',
      'status', 'passed', 'exitCode', 0, 'startedAt', clock_timestamp(), 'completedAt', clock_timestamp(),
      'commitSha', commit_sha, 'treeSha', tree_sha, 'finalCommitSha', commit_sha, 'finalTreeSha', tree_sha,
      'reportKeys', '[]'::jsonb, 'missingRequiredReports', '[]'::jsonb)));
  if not public.prepare_session_source_and_checkpoint_publication(run_id, pg_temp.op651_id(34), 'main',
    commit_sha, commit_sha, 'Joined output', 'Same-commit join for review', '', '', '',
    (started->>'artifactVersion')::integer, 'Joined artifact with exact validation.',
    (started->>'deadlineAt')::timestamptz) then
    raise exception 'Expected a durable validated no-code join publication.';
  end if;
  lease_id := public.claim_session_checkpoint_publication(run_id);
  if lease_id is null then raise exception 'Expected a publication lease.'; end if;
  return next;
end;
$$;

create temp table join_replay as select * from pg_temp.prepare_join_replay();
commit;

create function pg_temp.test_join_adoption_replay()
returns setof text language plpgsql as $$
declare
  connection_info text := coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
    'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres');
  holder text := 'op652_join_holder';
  replay text := 'op652_join_replay';
  request text;
  holder_pid integer;
  replay_pid integer;
  holder_adopted boolean;
  replay_adopted boolean;
  wait_until timestamptz;
  seed_visible boolean;
begin
  select format('select public.adopt_session_checkpoint_publication(%L::uuid, %L::uuid, null, null)',
    run_id, lease_id) into strict request from join_replay;
  perform extensions.dblink_connect(holder, connection_info);
  perform extensions.dblink_connect(replay, connection_info);
  perform extensions.dblink_exec(holder, 'set statement_timeout = ''15s''; set request.jwt.claim.role = ''service_role''');
  perform extensions.dblink_exec(replay, 'set statement_timeout = ''15s''; set request.jwt.claim.role = ''service_role''');
  select pid, visible into strict holder_pid, seed_visible from extensions.dblink(holder, format(
    'select pg_backend_pid(), current_database() = %L and exists (
      select 1 from public.session_checkpoint_publications where run_id = %L::uuid)',
    current_database(), (select run_id from join_replay))) remote(pid integer, visible boolean);
  select pid into strict replay_pid from extensions.dblink(replay, 'select pg_backend_pid()') remote(pid integer);
  if not seed_visible then raise exception 'Independent connections cannot see the committed join fixture.'; end if;

  perform extensions.dblink_exec(holder, 'begin');
  select adopted into strict holder_adopted from extensions.dblink(holder, request) result(adopted boolean);
  return next ok(holder_adopted, 'the first call adopts the exact join but holds the transaction open');
  return next is(extensions.dblink_send_query(replay, request), 1,
    'a second connection submits the same run and lease before the winner commits');
  wait_until := clock_timestamp() + interval '8 seconds';
  while not (holder_pid = any(pg_blocking_pids(replay_pid))) and clock_timestamp() < wait_until loop
    perform pg_sleep(0.02);
  end loop;
  return next ok(holder_pid = any(pg_blocking_pids(replay_pid)), 'the replay waits on the first adoption transaction');
  perform extensions.dblink_exec(holder, 'commit');

  select adopted into strict replay_adopted from extensions.dblink_get_result(replay) result(adopted boolean);
  return next ok(replay_adopted, 'the lock waiter accepts the identical committed adoption proof');
exception when query_canceled or others then
  return next fail(format('Independent join adoption transactions failed (%s), %s', SQLSTATE, SQLERRM));
end;
$$;

select * from pg_temp.test_join_adoption_replay();
select extensions.dblink_disconnect(peer.name)
from (values ('op652_join_holder'), ('op652_join_replay')) peer(name)
where peer.name = any(coalesce(extensions.dblink_get_connections(), '{}'::text[]));

select ok((select head.checkpoint_run_id = replay.run_id
    and head.checkpoint_run_id <> root.checkpoint_run_id
    and original.output_sha = adopted.output_sha and terminal.checkpoint_run_id = adopted.run_id
    and terminal.artifact_id = parent.current_artifact_id and parent.phase_status = 'awaiting_review'
  from join_replay replay cross join branch_owner root
  join public.sessions parent on parent.id = root."sessionId"
  join public.session_git_heads head on head.session_id = parent.id
  join public.session_git_checkpoints original on original.run_id = root.checkpoint_run_id
  join public.session_git_checkpoints adopted on adopted.run_id = head.checkpoint_run_id
  join internal.factory_workflow_join_outcomes terminal on (terminal.root_session_id, terminal.join_id) =
    (parent.id, replay.join_id)),
  'one exact new checkpoint and review artifact survive both calls at the same commit SHA');
select is((select count(*) from join_replay replay cross join branch_owner root
  join internal.factory_workflow_node_results result
    on (result.root_session_id, result.occurrence_id, result.evidence_ref) =
    (root."sessionId", replay.occurrence_id, 'join-checkpoint:' || replay.run_id)
    and result.outcome = 'succeeded'),
  1::bigint, 'the race leaves one successful graph occurrence result');
select ok((select case when pub.status = 'adopted' then
    not public.adopt_session_checkpoint_publication(run_id, gen_random_uuid(), null, null)
    and not public.adopt_session_checkpoint_publication(run_id, lease_id, null, repeat('a', 40))
  else false end
  from join_replay join public.session_checkpoint_publications pub using(run_id)),
  'the completed join still requires its exact lease and no-code retained proof');

begin;
set local request.jwt.claim.role = 'service_role';
delete from public.workspaces where id = pg_temp.op651_id(11);
delete from auth.users where id = pg_temp.op651_id(1);

-- Restore only a release change this fixture made, at the exact revision.
create temp table op652_release_restored as
select restored.* from op651_release_before prior
cross join op651_release_enabled enabled
cross join lateral public.set_git_continuity_release(false, enabled.revision, prior.reason) restored;
select ok(not exists (select 1 from public.workspaces where id = pg_temp.op651_id(11))
  and not exists (select 1 from auth.users where id = pg_temp.op651_id(1))
  and not exists (select 1 from internal.factory_workflow_joins where workspace_id = pg_temp.op651_id(11)),
  'cleanup removes the exact workspace, user, and committed join');
select ok((select (current.enabled, current.reason) = (prior.enabled, prior.reason) and (
    (prior.enabled and (current.revision, current.updated_at) = (prior.revision, prior.updated_at)
      and not exists (select 1 from op652_release_restored))
    or (not prior.enabled and current.revision = prior.revision + 2
      and exists (select 1 from op652_release_restored restored where restored.revision = current.revision))
  )
  from op651_release_before prior cross join public.get_git_continuity_release_state() current),
  'cleanup leaves the initial release intact or restores its exact paused state and reason');
select * from finish();
commit;
