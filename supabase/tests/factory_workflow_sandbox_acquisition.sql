begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set workflow_fixture_namespace 65040000
\ir fixtures/factory_workflow_lifecycle.psql

insert into lifecycle_children
select test.scenario, child.* from (values ('budget-root'), ('late-registration')) test(scenario)
cross join lateral pg_temp.admit_scoped_child(test.scenario) child;

create temp table acquisition_runs as
select child.scenario, publication.job_id, publication.run_id, root."sessionId" as root_session_id,
  root.workspace_id, root.factory_id, connection.connection_revision, null::uuid as operation_id
from lifecycle_children child join lifecycle_roots root using (scenario)
join public.workspace_e2b_sandbox_connections connection on connection.workspace_id = root.workspace_id
cross join lateral pg_temp.prepare_child_publication(child.scenario) publication;

update acquisition_runs candidate
set operation_id = public.begin_workspace_resource_operation(candidate.workspace_id,'sandbox','e2b','','',
  clock_timestamp() + interval '30 minutes',candidate.connection_revision)
where candidate.scenario <> 'budget-root';

create function pg_temp.register_acquisition(p_scenario text) returns boolean language sql as $$
  select public.register_factory_workflow_sandbox_acquisition(run_id,1,operation_id)
  from acquisition_runs where scenario = p_scenario
$$;
create function pg_temp.settle_acquisition(p_scenario text, p_sandbox_ids text[]) returns boolean language sql as $$
  select public.settle_factory_workflow_sandbox_acquisition(operation_id,p_sandbox_ids)
  from acquisition_runs where scenario = p_scenario
$$;
create function pg_temp.cancel_acquisition_workflow(p_scenario text) returns jsonb language sql as $$
  select public.control_factory_workflow_lifecycle(root_session_id,workspace_id,factory_id,1,gen_random_uuid(),'cancel')
  from acquisition_runs where scenario = p_scenario
$$;

insert into public.workspaces(id,slug,name)
values (pg_temp.workflow_fixture_id(12),'op650-foreign-acquisition','Unrelated lifecycle fixture');
insert into public.workspace_e2b_sandbox_connections(workspace_id,encrypted_api_key)
values (pg_temp.workflow_fixture_id(12),'synthetic-foreign-provider-key');
create temp table foreign_operation as
select public.begin_workspace_resource_operation(connection.workspace_id,'sandbox','e2b','','',
  clock_timestamp() + interval '30 minutes',connection.connection_revision) as operation_id
from public.workspace_e2b_sandbox_connections connection where connection.workspace_id = pg_temp.workflow_fixture_id(12);

select is((select public.register_factory_workflow_sandbox_acquisition(candidate.run_id,1,foreign_op.operation_id)
  from acquisition_runs candidate cross join foreign_operation foreign_op where candidate.scenario = 'running-child'),
  false, 'an acquisition cannot borrow a reservation from a different workspace');
select is((select public.register_factory_workflow_sandbox_acquisition(run_id,2,operation_id)
  from acquisition_runs where scenario = 'running-child'),
  false, 'registration requires the exact currently owned attempt');
select is(pg_temp.register_acquisition('running-child'), true, 'registration commits before the provider receives a create request');
select is(pg_temp.register_acquisition('running-child'), true, 'exact registration can replay while the attempt is current');
select is((select public.register_factory_workflow_sandbox_acquisition(other.run_id,1,original.operation_id)
  from acquisition_runs original cross join acquisition_runs other
  where (original.scenario,other.scenario) = ('running-child','queued-child')),
  false, 'a live operation cannot be retargeted to a different live run');
select ok((select acquisition.run_id = candidate.run_id and acquisition.root_session_id = candidate.root_session_id
  and acquisition.attempt_count = 1 and acquisition.workspace_id = candidate.workspace_id
  and acquisition.sandbox_provider = 'e2b' and acquisition.sandbox_connection_revision = candidate.connection_revision
  and acquisition.lookup_completed_at is null
  from acquisition_runs candidate
  join internal.factory_workflow_sandbox_acquisitions acquisition on acquisition.operation_id = candidate.operation_id
  where candidate.scenario = 'running-child'),
  'the acquisition pins the exact recovered scope and revision before the handle exists');

select is(pg_temp.cancel_acquisition_workflow('running-child')->>'lifecycleStatus','canceled',
  'cancellation commits before the create callback knows a handle');
select ok((select stop.sandbox_id is null and stop.confirmed_at is null and stop.lookup_expired_at is null
  and stop.acquisition_operation_id = candidate.operation_id
  and stop.sandbox_connection_revision = candidate.connection_revision
  from acquisition_runs candidate join internal.factory_workflow_sandbox_stops stop on stop.run_id = candidate.run_id
  where candidate.scenario = 'running-child'),
  'retirement retains the exact acquisition and credential revision while provider proof is pending');
select is(pg_temp.settle_acquisition('running-child',array['recovered-sandbox']), false,
  'provider lookup alone cannot settle a stop without a positive exact cleanup receipt');
insert into public.workspace_sandbox_cleanup_receipts(workspace_id,provider,connection_revision,sandbox_id)
select workspace_id,'e2b',connection_revision,'unrelated-sandbox' from acquisition_runs where scenario = 'running-child';
select is(pg_temp.settle_acquisition('running-child',array['recovered-sandbox']), false,
  'a receipt under the same credential cannot confirm a different handle');
insert into public.workspace_sandbox_cleanup_receipts(workspace_id,provider,connection_revision,sandbox_id)
select workspace_id,'e2b',connection_revision,'recovered-sandbox' from acquisition_runs where scenario = 'running-child';
select is(pg_temp.settle_acquisition('running-child',array['recovered-sandbox']), true,
  'restart can settle the unknown acquisition after strictly stopping the discovered handle');
delete from public.workspace_resource_operations where id = (
  select operation_id from acquisition_runs where scenario = 'running-child'
);
select ok((select acquisition.stopped_sandbox_ids = array['recovered-sandbox']
  and acquisition.lookup_completed_at is not null
  and stop.confirmed_at is not null and stop.lookup_expired_at is null
  and run.status = 'canceled' and run.sandbox_id is null
  from acquisition_runs candidate
  join internal.factory_workflow_sandbox_acquisitions acquisition on acquisition.operation_id = candidate.operation_id
  join internal.factory_workflow_sandbox_stops stop on stop.run_id = candidate.run_id
  join public.agent_runs run on run.id = candidate.run_id
  where candidate.scenario = 'running-child'),
  'the stop proof survives reservation cleanup without reattaching or restarting the canceled run');

select is(pg_temp.register_acquisition('queued-child'), true,
  'a second owned attempt registers a separate provider operation');
select is((select public.record_workspace_resource_operation(operation_id,'known-before-retirement')
  from acquisition_runs where scenario = 'queued-child'), true,
  'the workspace reservation retains a published handle after the original worker disappears');
select is(pg_temp.settle_acquisition('queued-child','{}'::text[]), false,
  'an empty lookup cannot settle an already known provider handle');
insert into public.workspace_sandbox_cleanup_receipts(workspace_id,provider,connection_revision,sandbox_id)
select workspace_id,'e2b',connection_revision,'known-before-retirement' from acquisition_runs where scenario = 'queued-child';
select is(pg_temp.settle_acquisition('queued-child',array['known-before-retirement']), true,
  'the exact known handle can be confirmed before the workflow retires the attempt');
delete from public.workspace_resource_operations where id = (
  select operation_id from acquisition_runs where scenario = 'queued-child'
);
select is(pg_temp.cancel_acquisition_workflow('queued-child')->>'lifecycleStatus','canceled',
  'later cancellation preserves the previously completed acquisition proof');
select ok((select stop.confirmed_at is not null and stop.lookup_expired_at is null
  and stop.acquisition_operation_id = candidate.operation_id
  from acquisition_runs candidate join internal.factory_workflow_sandbox_stops stop on stop.run_id = candidate.run_id
  where candidate.scenario = 'queued-child'),
  'retirement reconciles the linked stop from the previously recorded provider proof');

select is(pg_temp.cancel_acquisition_workflow('late-registration')->>'lifecycleStatus','canceled',
  'cancellation can win between reserving credentials and attaching workflow scope');
select is(pg_temp.register_acquisition('late-registration'), false,
  'a new registration after retirement cannot issue provider work');
select ok((select stop.acquisition_operation_id is null and stop.acquisition_unregistered_at is not null
  and reservation.resource_id is null
  and not exists (
    select 1 from internal.factory_workflow_sandbox_acquisitions acquisition
    where acquisition.operation_id = candidate.operation_id
  )
  from acquisition_runs candidate
  join internal.factory_workflow_sandbox_stops stop on stop.run_id = candidate.run_id
  join public.workspace_resource_operations reservation on reservation.id = candidate.operation_id
  where candidate.scenario = 'late-registration'),
  'a refused registration leaves the operation unbound and available to the caller for release');

-- Use the actual recovery timestamp so the expiry proof does not depend on an
-- assumed interval between two statements.
update acquisition_runs candidate
set operation_id = public.begin_workspace_resource_operation(candidate.workspace_id,'sandbox','e2b','','',
  clock_timestamp() + interval '3 seconds',candidate.connection_revision)
where candidate.scenario = 'budget-root';
select is(pg_temp.register_acquisition('budget-root'), true, 'the expiring acquisition is initially owned');
select is(pg_temp.cancel_acquisition_workflow('budget-root')->>'lifecycleStatus','canceled',
  'cancellation leaves the exact unresolved acquisition pending');
select is(pg_temp.settle_acquisition('budget-root','{}'::text[]), false,
  'empty lookup before its recovery horizon retains the obligation');
select pg_sleep_until(reservation.recovery_after)
from acquisition_runs candidate join public.workspace_resource_operations reservation on reservation.id = candidate.operation_id
where candidate.scenario = 'budget-root';
select is(pg_temp.settle_acquisition('budget-root','{}'::text[]), true,
  'a successful empty lookup after expiry retires the operation');
delete from public.workspace_resource_operations where id = (
  select operation_id from acquisition_runs where scenario = 'budget-root'
);
select ok((select stop.lookup_expired_at is not null and stop.confirmed_at is null and stop.sandbox_id is null
  and acquisition.lookup_completed_at is not null and acquisition.stopped_sandbox_ids = '{}'::text[]
  from acquisition_runs candidate
  join internal.factory_workflow_sandbox_acquisitions acquisition on acquisition.operation_id = candidate.operation_id
  join internal.factory_workflow_sandbox_stops stop on stop.run_id = candidate.run_id
  where candidate.scenario = 'budget-root'),
  'expiry reports completion without inventing a handle or a provider stop confirmation');
select is((select count(*) from public.workspace_sandbox_cleanup_receipts
  where workspace_id = pg_temp.workflow_fixture_id(11)),3::bigint,
  'empty expiry never inserts a reusable cleanup receipt');

select ok(not has_function_privilege('authenticated',
  'public.register_factory_workflow_sandbox_acquisition(uuid,integer,uuid)', 'execute')
  and not has_function_privilege('authenticated',
  'public.settle_factory_workflow_sandbox_acquisition(uuid,text[])', 'execute')
  and not has_table_privilege('service_role', 'internal.factory_workflow_sandbox_acquisitions', 'select'),
  'native acquisition history and mutations stay behind service-only commands');

select * from finish();
rollback;
