begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
-- Remove only this fixture's committed state if an earlier race was interrupted.
delete from public.workspaces where id = '66510000-0000-4000-8000-000000000011';
delete from auth.users where id in ('66510000-0000-4000-8000-000000000001', '66510000-0000-4000-8000-000000000002');
\set op651_fixture_namespace 66510000
\ir fixtures/factory_guarded_delivery.psql

select ok(pg_temp.delivery_sync(session_id), 'the exact reviewed code is retained on a real canonical PR') from delivery_checkpoint;

select throws_ok($$select pg_temp.delivery_prepare(250, 'timeout')$$, 'PT409', null,
  'an unapproved source cannot create a delivery command');
select pg_temp.delivery_ready(session_id) from delivery_checkpoint;
select is(pg_temp.approve_branch(session_id), session_id, 'real final approval uses the exact Ready decision and policy')
from delivery_checkpoint;
select throws_ok($$select pg_temp.delivery_prepare(250, 'timeout')$$, 'PT409', null,
  'human approval and a green PR alone do not replace the manual source merge');

select ok(pg_temp.delivery_observe_merge(repeat('c', 40)), 'the manual merge arrives as exact canonical evidence');
select ok(
  candidate->>'checkpointRunId' = checkpoint.run_id::text and candidate->>'approvalId' is not null
  and candidate->>'policyRevisionId' = policy.id::text and candidate->>'sourceRevision' = repeat('c', 40),
  'a manager can resolve the exact delivery evidence before preparing a command')
from delivery_checkpoint checkpoint cross join op651_scope scope cross join delivery_policy policy
join delivery_sources source on source.name = 'timeout'
cross join lateral public.read_factory_delivery_command_candidate(scope.workspace_id, scope.factory_id,
  pg_temp.op651_id(1), checkpoint.session_id, source.source_id) candidate;
select throws_ok($$select pg_temp.delivery_prepare(250, 'timeout', p_override_head => gen_random_uuid())$$,
  'PT409', null, 'a stale checkpoint cannot prepare delivery');
select throws_ok($$select pg_temp.delivery_prepare(250, 'timeout', p_override_policy => gen_random_uuid())$$,
  'PT409', null, 'a different policy revision cannot prepare delivery');
select throws_ok($$select pg_temp.delivery_prepare(250, 'timeout', p_actor => pg_temp.op651_id(2))$$,
  '42501', null, 'a workspace viewer cannot prepare a command');

create temp table delivery_intent as select pg_temp.delivery_prepare(250, 'timeout') as result;
select ok(result->>'dispatchState' = 'queued' and result->>'outcome' is null
  and result->>'approvedHeadSha' = repeat('b', 40) and result->>'sourceRevision' = repeat('c', 40),
  'the command pins both the approved head and distinct merged deployment SHA') from delivery_intent;
select is(pg_temp.delivery_prepare(250, 'timeout'), result, 'the same request replays the exact command') from delivery_intent;
select throws_ok($$select pg_temp.delivery_prepare(250, 'cancelled')$$,
  'PT409', null, 'a command ID cannot change its deployment target');
select throws_ok($$select pg_temp.delivery_prepare(251, 'timeout')$$,
  'PT409', null, 'another request ID cannot dispatch the same source to the same target');

select pg_temp.delivery_prepare(252, 'cancelled');
select is(pg_temp.delivery_cancel(252)->>'dispatchState', 'cancelled', 'cancellation before the claim prevents dispatch');
select is(pg_temp.delivery_claim(252), null::jsonb, 'claim loses to a committed cancellation');
select is(pg_temp.delivery_prepare(255, 'cancelled')->>'dispatchState', 'queued',
  'a manager can explicitly re-request delivery after confirmed cancellation');
select is(pg_temp.delivery_claim(250, 'wrong-provider'), null::jsonb, 'an adapter cannot claim another provider’s delivery');
create temp table delivery_lease as select pg_temp.delivery_claim(250) as packet;
select ok(packet->>'dispatchState' = 'dispatching' and packet->>'externalDeploymentId' = pg_temp.op651_id(250)::text
  and packet->>'leaseId' is not null, 'one exact lease allocates the stable external correlation ID') from delivery_lease;
select is(pg_temp.delivery_claim(250), null::jsonb, 'a second worker receives no dispatch lease');
select throws_ok($$select pg_temp.delivery_cancel(250)$$, 'PT409', null, 'cancellation loses after a worker has claimed dispatch');
select is(pg_temp.delivery_settle(250, gen_random_uuid(), 'accepted'), false, 'a stale lease cannot settle dispatch');
update internal.factory_delivery_commands set lease_expires_at = clock_timestamp() - interval '1 second'
where id = pg_temp.op651_id(250);
select is(public.expire_factory_delivery_dispatches(), 1, 'maintenance marks an interrupted dispatch unknown');
select is(pg_temp.delivery_state(250)->>'outcome', 'unknown', 'a dispatch timeout cannot report success');
select is(pg_temp.delivery_claim(250), null::jsonb, 'an unknown dispatch is never automatically retried');
select is(pg_temp.delivery_settle(250, (packet->>'leaseId')::uuid, 'accepted'), false,
  'an expired worker reply cannot settle the dispatch') from delivery_lease;

select pg_temp.delivery_report(260, 250, 1, 'accepted', 'succeeded', repeat('c', 40));
select is(pg_temp.delivery_state(250)->>'outcome', 'unknown', 'another approved environment cannot reconcile the command');
select pg_temp.delivery_report(261, 250, 2, 'timeout', 'succeeded', repeat('b', 40));
select is(pg_temp.delivery_state(250)->>'outcome', 'unknown', 'a report for the PR head cannot prove the merged deployment');
select pg_temp.delivery_report(262, 250, 3, 'timeout', 'failed', repeat('c', 40));
select is(pg_temp.delivery_state(250)->>'outcome', 'failed', 'the exact M06 deployment can resolve unknown as failure');
select pg_temp.delivery_report(263, 250, 1, 'timeout', 'succeeded', repeat('c', 40));
select is(pg_temp.delivery_state(250)->>'outcome', 'failed', 'a late superseded success cannot replace a newer failure');
create temp table delivery_observed as select pg_temp.delivery_report(264, 250, 4, 'timeout', 'succeeded', repeat('c', 40)) as result;
select ok(pg_temp.delivery_state(250)->>'outcome' = 'succeeded'
  and pg_temp.delivery_state(250)->>'deploymentObservationId' = result->>'observationId',
  'authoritative exact observation reconciles to success with its separate receipt') from delivery_observed;
select pg_temp.delivery_report(265, 250, 5, 'timeout', 'succeeded', repeat('b', 40));
select is(pg_temp.delivery_state(250)->>'outcome', 'unknown', 'a contradictory newer M06 revision invalidates previous success');
select public.revoke_factory_deployment_source(grant_row.workspace_id, grant_row.factory_id, pg_temp.op651_id(1),
  source.source_id)
from delivery_grant grant_row cross join delivery_sources source where source.name = 'timeout';
update delivery_sources source
set source_id = (public.approve_factory_deployment_source(grant_row.workspace_id, grant_row.factory_id,
  pg_temp.op651_id(1), grant_row.id, grant_row.version, 'fixture-ci', 'wallie-delivery-fixture', source.name,
  true)->>'sourceId')::uuid
from delivery_grant grant_row where source.name = 'timeout';
select throws_ok($$select pg_temp.delivery_prepare(258, 'timeout')$$,
  'PT409', null, 'reporter rotation cannot dispatch the same source and stable target while it is unknown');
select pg_temp.delivery_report(266, 250, 6, 'timeout', 'succeeded', repeat('c', 40), clock_timestamp() - interval '1 hour');
select is(pg_temp.delivery_state(250)->>'outcome', 'unknown',
  'a delayed report whose authoritative provider time predates dispatch cannot prove success');
select pg_temp.delivery_report(267, 250, 7, 'timeout', 'succeeded', repeat('c', 40));
select is(pg_temp.delivery_state(250)->>'outcome', 'succeeded',
  'rotation of the authorized reporter preserves the original M06 deployment identity');

select pg_temp.delivery_prepare(253, 'accepted');
create temp table second_delivery_lease as select pg_temp.delivery_claim(253) as packet;
select ok(pg_temp.delivery_settle(253, (packet->>'leaseId')::uuid, 'accepted'),
  'the exact worker lease can record provider acceptance') from second_delivery_lease;
select is(pg_temp.delivery_state(253)->>'outcome', 'pending', 'provider acceptance is still awaiting deployment outcome');

select pg_temp.delivery_prepare(254, 'stale');
select ok(pg_temp.delivery_observe_merge(repeat('d', 40)), 'a newer canonical fact supersedes the original merge');
select is(pg_temp.delivery_claim(254), null::jsonb, 'claim checks merge identity again after preparation');
select is(pg_temp.delivery_state(254)->>'dispatchState', 'blocked', 'stale source command settles without side effects');
select ok(not has_table_privilege('authenticated', 'internal.factory_delivery_commands', 'select')
  and not has_function_privilege('authenticated', 'public.claim_factory_delivery_command(uuid,uuid,uuid,text)', 'execute'),
  'an authenticated browser cannot access worker authority or provider leases directly');

-- Independent connections see the same committed, scoped test commands.
select pg_temp.delivery_prepare(256, 'stale');
select pg_temp.delivery_prepare(257, 'accepted');
select pg_temp.delivery_prepare(259, 'lease');
select public.set_git_continuity_release(false, gate.revision, 'Restore release gate after guarded delivery setup')
from public.get_git_continuity_release_state() gate cross join delivery_release_before prior
where gate.enabled and not prior.enabled;
commit;
begin;
set local request.jwt.claim.role = 'service_role';

select extensions.dblink_connect(connection, coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  format('host=%L port=%L dbname=%L user=supabase_admin password=postgres',
    inet_server_addr(), inet_server_port(), current_database())))
from unnest(array['op665_manager', 'op665_worker']) connection;
select extensions.dblink_exec(connection, 'set statement_timeout = ''15s''; set request.jwt.claim.role = ''service_role''')
from unnest(array['op665_manager', 'op665_worker']) connection;
create temp table delivery_worker_backend as
select pid from extensions.dblink('op665_worker', 'select pg_backend_pid()') result(pid integer);

select extensions.dblink_exec('op665_manager', 'begin');
select is(state, 'cancelled', 'the manager holds the cancellation open')
from op651_scope scope cross join lateral extensions.dblink('op665_manager', format(
  'select public.cancel_factory_delivery_command(%L,%L,%L,%L)->>''dispatchState''',
  scope.workspace_id, scope.factory_id, pg_temp.op651_id(1), pg_temp.op651_id(256))) result(state text);
select extensions.dblink_send_query('op665_worker', format(
  'select public.claim_factory_delivery_command(%L,%L,%L,''fixture-ci'') is null',
  workspace_id, factory_id, pg_temp.op651_id(256)))
from op651_scope;
create function pg_temp.delivery_wait_for_lock(p_backend integer) returns boolean language plpgsql as $$
begin
  for attempt in 1..100 loop
    if cardinality(pg_blocking_pids(p_backend)) > 0 then return true; end if;
    perform pg_sleep(0.02);
  end loop;
  return false;
end;
$$;
select ok(pg_temp.delivery_wait_for_lock(pid), 'a concurrent claim reaches the cancellation lock')
from delivery_worker_backend;
select extensions.dblink_exec('op665_manager', 'commit');
select ok(skipped, 'the competing worker receives no lease after the cancellation commits')
from extensions.dblink_get_result('op665_worker') result(skipped boolean);
select count(*) from extensions.dblink_get_result('op665_worker') result(skipped boolean);

select extensions.dblink_exec('op665_manager', 'begin');
select state from op651_scope scope cross join lateral extensions.dblink('op665_manager', format(
  'select public.cancel_factory_delivery_command(%L,%L,%L,%L)->>''dispatchState''',
  scope.workspace_id, scope.factory_id, pg_temp.op651_id(1), pg_temp.op651_id(259))) result(state text);
select extensions.dblink_send_query('op665_worker', format(
  'select public.claim_factory_delivery_command(%L,%L,%L,''fixture-ci'')',
  workspace_id, factory_id, pg_temp.op651_id(259)))
from op651_scope;
select ok(pg_temp.delivery_wait_for_lock(pid), 'the worker waits for a second cancellation to settle')
from delivery_worker_backend;
create temp table delivery_rollback_marker as select clock_timestamp() as captured_at;
select extensions.dblink_exec('op665_manager', 'rollback');
select ok((packet->>'dispatchStartedAt')::timestamptz >= captured_at
  and (packet->>'leaseExpiresAt')::timestamptz - (packet->>'dispatchStartedAt')::timestamptz = interval '60 seconds',
  'a rolled-back cancellation leaves the worker the full lease from lock acquisition')
from extensions.dblink_get_result('op665_worker') result(packet jsonb) cross join delivery_rollback_marker;
select count(*) from extensions.dblink_get_result('op665_worker') result(packet jsonb);

select extensions.dblink_exec('op665_manager', 'begin');
select locked from extensions.dblink('op665_manager', format(
  'select id from public.github_installations where id = %L for no key update',
  pg_temp.op651_id(33))) result(locked uuid);
select throws_ok($$select pg_temp.delivery_claim(257)$$, '55P03', null,
  'a real competing installation writer postpones the authority check');
select is(pg_temp.delivery_state(257)->>'dispatchState', 'queued', 'a temporary grant fence leaves the command queued');
select extensions.dblink_exec('op665_manager', 'rollback');
select is(pg_temp.delivery_claim(257)->>'dispatchState', 'dispatching', 'the same command claims after the grant lock clears');

select extensions.dblink_exec('op665_manager', format(
  'update internal.factory_delivery_commands set lease_expires_at = clock_timestamp() + interval ''2 seconds'' where id = %L',
  pg_temp.op651_id(259)));
create temp table delivery_settlement_lease as
select workspace_id, factory_id, id, lease_id, lease_expires_at
from internal.factory_delivery_commands where id = pg_temp.op651_id(259);
select extensions.dblink_exec('op665_manager', 'begin');
select locked from extensions.dblink('op665_manager', format(
  'select id from internal.factory_delivery_commands where id = %L for update',
  pg_temp.op651_id(259))) result(locked uuid);
select extensions.dblink_send_query('op665_worker', format(
  'select public.settle_factory_delivery_dispatch(%L,%L,%L,%L,''accepted'')',
  workspace_id, factory_id, id, lease_id))
from delivery_settlement_lease;
select ok(pg_temp.delivery_wait_for_lock(pid), 'settlement reaches the command lock before the lease expires')
from delivery_worker_backend;
select pg_sleep_until(lease_expires_at) from delivery_settlement_lease;
select extensions.dblink_exec('op665_manager', 'rollback');
select ok(not settled, 'settlement fails when the lease expires while the worker waits for the row')
from extensions.dblink_get_result('op665_worker') result(settled boolean);
select count(*) from extensions.dblink_get_result('op665_worker') result(settled boolean);
select is(pg_temp.delivery_state(259)->>'dispatchState', 'dispatching', 'expired settlement leaves the dispatch for the reaper');
select ok(public.expire_factory_delivery_dispatches() > 0, 'the reaper expires the abandoned lease');
select is(pg_temp.delivery_state(259)->>'dispatchState', 'unknown', 'the reaper records an unknown provider response');

select extensions.dblink_disconnect(connection) from unnest(array['op665_manager', 'op665_worker']) connection;
delete from public.workspaces where id = pg_temp.op651_id(11);
delete from auth.users where id in (pg_temp.op651_id(1), pg_temp.op651_id(2));
select * from finish();
commit;
