begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 66710000
\ir fixtures/factory_guarded_delivery.psql

select pg_temp.delivery_sync(session_id) from delivery_checkpoint;
select pg_temp.delivery_ready(session_id) from delivery_checkpoint;
select pg_temp.approve_branch(session_id) from delivery_checkpoint;
select pg_temp.delivery_observe_merge(repeat('c', 40));
select pg_temp.delivery_prepare(250, 'timeout');
select pg_temp.delivery_claim(250);
select pg_temp.delivery_report(260, 250, 1, 'timeout', 'succeeded', repeat('c', 40));

create function pg_temp.approve_monitor(p_actor uuid default pg_temp.op651_id(1),
  p_binding uuid default pg_temp.op651_id(270), p_secret text default repeat('x', 64))
returns jsonb language sql as $$
  select public.approve_factory_monitoring_binding(scope.workspace_id, scope.factory_id, p_actor,
    p_binding, source.source_id, pg_temp.op651_id(271), '98765', p_secret, 60)
  from op651_scope scope cross join delivery_sources source where source.name = 'timeout'
$$;
select throws_ok($$select pg_temp.approve_monitor(pg_temp.op651_id(2))$$, '42501', null,
  'a factory viewer cannot approve a Sentry binding');
select ok(not (pg_temp.approve_monitor() ? 'encryptedSecret'), 'manager consent creates a binding without returning its secret');
select ok(not has_function_privilege('authenticated', 'public.read_factory_monitoring_secret(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.admit_next_factory_monitoring_incident()', 'execute'),
  'webhook secrets and background admission are service-only');

create function pg_temp.monitor_alert(p_event integer, p_issue text default '751',
  p_installation uuid default pg_temp.op651_id(271), p_project text default '98765',
  p_command integer default 250, p_environment text default 'timeout',
  p_source_sha text default repeat('c', 40), p_digest text default repeat('a', 64),
  p_binding uuid default pg_temp.op651_id(270))
returns jsonb language sql as $$
  select public.record_factory_monitoring_signal(p_binding, p_installation, p_project,
    lpad(to_hex(p_event), 32, '0'), p_issue, pg_temp.op651_id(p_command),
    p_environment, p_source_sha, clock_timestamp(), p_digest)
$$;

select is(pg_temp.monitor_alert(1, p_installation => gen_random_uuid())->>'status', 'ignored', 'another Sentry installation cannot authorize work');
select is(pg_temp.monitor_alert(1, p_project => '99999')->>'status', 'ignored', 'another Sentry project cannot authorize work');
select is(pg_temp.monitor_alert(1, p_command => 251)->>'status', 'ignored', 'unknown deployments cannot authorize work');
select is(pg_temp.monitor_alert(1, p_environment => 'accepted')->>'status', 'ignored', 'the wrong Sentry environment cannot authorize work');
select is(pg_temp.monitor_alert(1, p_source_sha => repeat('b', 40))->>'status', 'ignored', 'the approved PR head is not the deployed source SHA');
select is((select count(*) from internal.factory_monitoring_incidents where binding_id = pg_temp.op651_id(270)),
  0::bigint, 'ignored signals create no incident rows');

create temp table monitor_first as select pg_temp.monitor_alert(1) as item;
select is(item->>'status', 'queued', 'signed alert for an exact M06 deployment queues an incident') from monitor_first;
select is(pg_temp.monitor_alert(1), jsonb_build_object('status','duplicate','incidentId',item->>'incidentId'),
  'identical event redelivery returns the same incident') from monitor_first;
select is(pg_temp.monitor_alert(1, p_digest => repeat('b',64))->>'status', 'ignored',
  'the same event ID with different content has no effect');
select is(pg_temp.monitor_alert(2), jsonb_build_object('status','suppressed','incidentId',item->>'incidentId'),
  'another event for the same deployed issue shares the window and incident') from monitor_first;

create temp table monitor_admitted as select public.admit_next_factory_monitoring_incident() item;
select is(item->>'status', 'admitted', 'worker admits one scoped incident through the session creation command') from monitor_admitted;
select ok((item->>'sessionId') is not null, 'the worker receipt identifies the incident session') from monitor_admitted;
select is(public.admit_next_factory_monitoring_incident(), null::jsonb, 'repeated worker drain creates no second session');
select ok(session.phase_status = 'in_progress' and receipt.actor_service_principal_id is not null
  and receipt.request_id = incident.id and incident.causing_session_id = checkpoint.session_id,
  'the incident uses the configured pipeline, exact machine actor, mutation receipt, and causal session')
from internal.factory_monitoring_incidents incident
join public.sessions session on session.id = incident.session_id
join internal.session_mutation_receipts receipt on receipt.id = incident.mutation_receipt_id
cross join delivery_checkpoint checkpoint
where incident.binding_id = pg_temp.op651_id(270);
select ok(not internal.factory_monitoring_cause_allowed(incident.workspace_id, incident.factory_id, incident.session_id),
  'monitoring sessions cannot recursively authorize incident work')
from internal.factory_monitoring_incidents incident where incident.binding_id = pg_temp.op651_id(270);

select workspace.slug as monitoring_workspace_slug, session.number as monitoring_session_number
from internal.factory_monitoring_incidents incident join public.sessions session on session.id = incident.session_id
join public.workspaces workspace on workspace.id = incident.workspace_id
where incident.binding_id = pg_temp.op651_id(270) \gset
select set_config('request.jwt.claim.sub', pg_temp.op651_id(1)::text, true);
set local request.jwt.claim.role = 'authenticated';
set local role authenticated;
select ok(
  evidence->>'deliveryCommandId' = '66710000-0000-4000-8000-000000000250'
    and evidence->>'sourceRevision' = repeat('c', 40) and evidence->>'approvedHeadRevision' = repeat('b', 40)
    and evidence->>'sentryIssueId' = '751' and evidence->>'sentryEventId' = lpad('1',32,'0'),
  'the signed-in session detail exposes the original deployment and Sentry evidence')
from (select public.get_session_detail_page(:'monitoring_workspace_slug', :monitoring_session_number)#>'{session,monitoring}' evidence) detail;
select set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
select is(public.get_session_detail_page(:'monitoring_workspace_slug', :monitoring_session_number)#>'{session,monitoring}',
  null::jsonb, 'unrelated callers cannot read incident evidence');
reset role;
set local request.jwt.claim.role = 'service_role';

create temp table monitor_invalidated as select pg_temp.monitor_alert(3, '752') item;
select is(item->>'status', 'queued', 'a separate Sentry issue starts another window') from monitor_invalidated;
select pg_temp.delivery_report(261, 250, 3, 'timeout', 'failed', repeat('c', 40));
select pg_temp.delivery_report(262, 250, 2, 'timeout', 'succeeded', repeat('c', 40));
select is(pg_temp.monitor_alert(4, '753')->>'status', 'ignored', 'out-of-order success does not supersede a current failed deployment');
select is(public.admit_next_factory_monitoring_incident()->>'status', 'denied', 'a pending alert loses authorization after current deployment changes');
select pg_temp.delivery_report(263, 250, 4, 'timeout', 'succeeded', repeat('c', 40));

create temp table monitor_recovered as select pg_temp.monitor_alert(6, '752') item;
select is(item->>'status', 'queued', 'a fresh alert after authoritative recovery can queue an incident')
from monitor_recovered;
select isnt(monitor_recovered.item->>'incidentId', monitor_invalidated.item->>'incidentId',
  'the recovered alert does not attach to the denied incident')
from monitor_recovered cross join monitor_invalidated;
select is(public.admit_next_factory_monitoring_incident()->>'status', 'admitted',
  'the recovered deployment can start incident work before the denied window expires');
select is(pg_temp.monitor_alert(3, '752'),
  jsonb_build_object('status', 'duplicate', 'incidentId', item->>'incidentId'),
  'the original event still replays the denied incident receipt') from monitor_invalidated;

select is(pg_temp.monitor_alert(7, '754')->>'status', 'queued', 'another alert is pending before disable');
select public.disable_factory_monitoring_binding(workspace_id, factory_id, pg_temp.op651_id(1), pg_temp.op651_id(270))
from op651_scope;
select is(public.read_factory_monitoring_secret(pg_temp.op651_id(270)), null::jsonb, 'disable immediately removes signing authority');
select is(pg_temp.monitor_alert(1)->>'status', 'ignored', 'a disabled binding cannot replay an existing event');
select is(pg_temp.monitor_alert(51)->>'status', 'ignored', 'a disabled binding cannot queue a fresh event');
select is(public.admit_next_factory_monitoring_incident()->>'status', 'denied', 'disable also prevents queued work from starting');

select is(pg_temp.approve_monitor(p_binding => pg_temp.op651_id(272), p_secret => repeat('y', 64))->>'id',
  pg_temp.op651_id(272)::text, 'the manager approves a replacement binding for the same monitoring scope');
select is(public.read_factory_monitoring_secret(pg_temp.op651_id(272))->>'encryptedSecret', repeat('y', 64),
  'the replacement binding uses the rotated signing secret');
select is(pg_temp.monitor_alert(1, p_binding => pg_temp.op651_id(272)),
  jsonb_build_object('status', 'duplicate', 'incidentId', item->>'incidentId'),
  'an exact event replay after rotation returns the original admitted incident') from monitor_first;
select is(pg_temp.monitor_alert(8, p_binding => pg_temp.op651_id(272)),
  jsonb_build_object('status', 'suppressed', 'incidentId', item->>'incidentId'),
  'a fresh event after rotation shares the original admitted suppression window') from monitor_first;
select is(public.admit_next_factory_monitoring_incident(), null::jsonb,
  'replayed and suppressed alerts after rotation create no second session');

update internal.factory_monitoring_incidents set suppress_until = clock_timestamp() - interval '1 second'
where binding_id = pg_temp.op651_id(270) and sentry_issue_id = '751';
create temp table monitor_after_expiry as select pg_temp.monitor_alert(5, p_binding => pg_temp.op651_id(272)) item;
select ok(next.item->>'status' = 'queued' and next.item->>'incidentId' is not null
  and next.item->>'incidentId' <> original.item->>'incidentId',
  'a new qualified alert after expiry opens a new incident')
from monitor_after_expiry next cross join monitor_first original;
select is(pg_temp.monitor_alert(1, p_binding => pg_temp.op651_id(272))->>'incidentId', item->>'incidentId',
  'a replay after suppression expiry still resolves to the original incident') from monitor_first;

select pg_temp.monitor_alert(event, p_binding => pg_temp.op651_id(272)) from generate_series(10, 40) event;
select is((select count(*) from internal.factory_monitoring_signals where binding_id in
  (pg_temp.op651_id(270), pg_temp.op651_id(272))), 30::bigint,
  'the monitoring scope shares the signed burst limit across replacement bindings');
select is(pg_temp.monitor_alert(50, '753', p_binding => pg_temp.op651_id(272))->>'status', 'rate_limited',
  'another alert cannot exceed the scoped rate limit after rotation');
select is((select count(*) from internal.factory_monitoring_incidents where binding_id in
  (pg_temp.op651_id(270), pg_temp.op651_id(272))), 5::bigint, 'the burst adds no extra incident work');

select * from finish();
rollback;
