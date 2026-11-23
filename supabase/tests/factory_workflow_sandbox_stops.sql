begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set workflow_fixture_namespace 65020000
\ir fixtures/factory_workflow_lifecycle.psql

create temp table stop_candidates as
select child.scenario, publication.*
from lifecycle_children child
cross join lateral pg_temp.prepare_child_publication(child.scenario) publication;

create temp table stop_connection as
select connection_revision from public.workspace_e2b_sandbox_connections where workspace_id = pg_temp.workflow_fixture_id(11);
update public.agent_runs run set sandbox_id = 'known-sandbox', sandbox_provider = 'e2b',
  sandbox_connection_revision = connection.connection_revision
from stop_candidates candidate cross join stop_connection connection
where candidate.scenario = 'running-child' and candidate.run_id = run.id;
select ok(public.control_factory_workflow_lifecycle(root."sessionId", root.workspace_id, root.factory_id, 1,
  pg_temp.workflow_fixture_id(case root.scenario when 'running-child' then 671 else 672 end), 'cancel')->>'lifecycleStatus' = 'canceled',
  'retirement persists a sandbox obligation in the same lifecycle transaction: ' || root.scenario)
from lifecycle_roots root where root.scenario in ('running-child', 'queued-child');
select is((select count(*) from internal.factory_workflow_sandbox_stops), 2::bigint,
  'actual retired child runs both retain obligations even before provider attachment');
select is((select count(*) from internal.factory_workflow_sandbox_stops
  where sandbox_id is null and acquisition_unregistered_at is not null and confirmed_at is null), 1::bigint,
  'an unregistered acquisition is distinct from a pending or confirmed provider stop');

create temp table first_stop as select * from public.claim_factory_workflow_sandbox_stops(4);
select ok((select stop.sandbox_id = 'known-sandbox' and stop.sandbox_provider = 'e2b'
  and stop.sandbox_connection_revision = connection.connection_revision and stop.run_id = candidate.run_id
  from first_stop stop cross join stop_connection connection cross join stop_candidates candidate
  where candidate.scenario = 'running-child'), 'claim exposes only the exact resolved provider handle and connection');
select is((select count(*) from public.claim_factory_workflow_sandbox_stops(4)), 0::bigint,
  'another worker cannot claim the current lease or unresolved address');
select ok((select public.settle_factory_workflow_sandbox_stop(obligation_id, lease_token, false) from first_stop),
  'a provider failure releases the lease for retry');
select is((select count(*) from public.workspace_sandbox_cleanup_receipts where workspace_id = pg_temp.workflow_fixture_id(11)), 0::bigint,
  'a stop failure records no provider confirmation');
update internal.factory_workflow_sandbox_stops set next_attempt_at = clock_timestamp()
where obligation_id = (select obligation_id from first_stop);
create temp table second_stop as select * from public.claim_factory_workflow_sandbox_stops(4);
select ok((select first.lease_token <> second.lease_token and
  not public.settle_factory_workflow_sandbox_stop(first.obligation_id, first.lease_token, true)
  from first_stop first cross join second_stop second), 'a stale lease cannot confirm a stopped sandbox after reclaim');
select ok((select public.settle_factory_workflow_sandbox_stop(obligation_id, lease_token, true) from second_stop),
  'current acknowledged lease confirms the exact stop');
select ok((select public.settle_factory_workflow_sandbox_stop(obligation_id, lease_token, true) from second_stop),
  'exact acknowledgement replay is idempotent');
select is((select count(*) from public.workspace_sandbox_cleanup_receipts receipt cross join stop_connection connection
  where (receipt.workspace_id, receipt.provider, receipt.connection_revision, receipt.sandbox_id) =
    (pg_temp.workflow_fixture_id(11), 'e2b', connection.connection_revision, 'known-sandbox')), 1::bigint,
  'the exact reusable workspace stop receipt is written once');

select ok(not public.record_late_factory_workflow_sandbox(candidate.run_id, 2, 'late-sandbox', 'e2b', connection.connection_revision),
  'a late attach cannot relabel the retired run’s attempt number')
from stop_candidates candidate cross join stop_connection connection where candidate.scenario = 'queued-child';
select ok(public.record_late_factory_workflow_sandbox(candidate.run_id, 1, 'late-sandbox', 'e2b', connection.connection_revision),
  'the exact retired attempt can bind its late provider handle')
from stop_candidates candidate cross join stop_connection connection where candidate.scenario = 'queued-child';
select ok(not public.record_late_factory_workflow_sandbox(candidate.run_id, 1, 'wrong-sandbox', 'e2b', connection.connection_revision),
  'a conflicting late handle cannot replace the immutable cleanup address')
from stop_candidates candidate cross join stop_connection connection where candidate.scenario = 'queued-child';
select ok((select run.status = 'canceled' and run.sandbox_id is null
  and stop.acquisition_unregistered_at is null
  from public.agent_runs run join stop_candidates candidate on candidate.run_id = run.id
  join internal.factory_workflow_sandbox_stops stop on stop.run_id = run.id
  where candidate.scenario = 'queued-child'),
  'late handle resolution does not attach a sandbox or reactivate the canceled run');
create temp table late_stop as select * from public.claim_factory_workflow_sandbox_stops(4);
select ok((select stop.sandbox_id = 'late-sandbox' and stop.run_id = candidate.run_id
  from late_stop stop cross join stop_candidates candidate where candidate.scenario = 'queued-child'),
  'the drain can claim the exact late handle after durable attachment');
select ok((select public.settle_factory_workflow_sandbox_stop(obligation_id, lease_token, true) from late_stop),
  'strict acknowledgement confirms the unresolved handle after it arrives');
select is((select count(*) from public.workspace_sandbox_cleanup_receipts where workspace_id = pg_temp.workflow_fixture_id(11)), 2::bigint,
  'only the exact acknowledged handles have reusable receipts');

select * from finish();
rollback;
