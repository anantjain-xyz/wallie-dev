begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65340000
\set op653_test_validation_seconds 600
\ir fixtures/factory_workflow_repository_delivery.psql

create temp table retired_validation as select claim from secondary_claim;
create function pg_temp.change_repository_workflow(p_action text, p_request_slot integer)
returns jsonb language sql as $$
  select public.control_factory_workflow_lifecycle(owner."sessionId", owner.workspace_id, owner.factory_id,
    state.generation, pg_temp.op651_id(p_request_slot), p_action)
  from multi_owner owner join internal.factory_workflow_executions state on state.root_session_id = owner."sessionId"
$$;
create temp table paused_validation as select pg_temp.change_repository_workflow('pause', 460) as receipt;
select ok((select receipt->>'lifecycleStatus' = 'paused' and exists (
    select 1 from jsonb_array_elements(receipt->'retired') retired
    cross join lateral jsonb_array_elements(retired->'jobs') job
    where job->>'jobId' = claim->>'jobId'
      and job->>'attemptCount' = claim->>'attemptCount'
  ) from paused_validation cross join retired_validation),
  'pause durably records the exact repository job and attempt that it retired');
select is(public.dispatch_next_factory_workflow_repository_validation(), false,
  'maintenance does not admit a new validation while the workflow is paused');
select is(pg_temp.multi_status() #>> '{repositories,0,status}', 'awaiting_validation',
  'pausing an unsealed attempt keeps its delivery obligation');

select is(pg_temp.change_repository_workflow('resume', 461)->>'lifecycleStatus', 'running',
  'resume returns the workflow to its running state');
select is(public.dispatch_next_factory_workflow_repository_validation(), true,
  'maintenance re-admits the exact pending target under the resumed generation');

-- Expire the queued target inside a reversible subtransaction. Its deadline is
-- immutable in production and a real repository-set deadline is 30 minutes.
create function pg_temp.observe_queued_expiry() returns jsonb language plpgsql as $$
declare
  observed jsonb;
  current_marker internal.factory_workflow_repository_validation_jobs;
  dispatched boolean;
begin
  select marker.* into strict current_marker
  from internal.factory_workflow_repository_validation_jobs marker
  join multi_join exact on marker.join_id = (exact.receipt->>'joinId')::uuid
  order by marker.admitted_generation desc limit 1;
  alter table internal.factory_workflow_repository_delivery_targets
    disable trigger freeze_factory_workflow_repository_target;
  update internal.factory_workflow_repository_delivery_targets set deadline_at = clock_timestamp() - interval '1 second'
  where (root_session_id, join_id, repository_id) =
    (current_marker.root_session_id, current_marker.join_id, current_marker.repository_id);
  alter table internal.factory_workflow_repository_delivery_targets
    enable trigger freeze_factory_workflow_repository_target;
  dispatched := public.dispatch_next_factory_workflow_repository_validation();
  select jsonb_build_object('dispatched', dispatched, 'blocker', pg_temp.multi_status() #>> '{repositories,0,blocker}',
    'jobStatus', job.status, 'runStatus', run.status)
  into observed from public.agent_jobs job join public.agent_runs run on run.agent_job_id = job.id
  where (job.id, run.id) = (current_marker.job_id, current_marker.queued_run_id);
  raise exception using errcode = 'P7777', message = 'Revert the isolated expiration probe.';
exception when sqlstate 'P7777' then
  return observed;
end;
$$;
select is(pg_temp.observe_queued_expiry(), '{"dispatched":true,"blocker":"deadline_expired","jobStatus":"canceled","runStatus":"canceled"}'::jsonb,
  'maintenance expires the delivery and retires its exact queued job and run together');

truncate secondary_claim;
insert into secondary_claim select pg_temp.claim_multi_join();
select ok((select resumed.claim->>'kind' = 'repository'
    and resumed.claim->>'generation' <> retired.claim->>'generation'
    and resumed.claim->>'jobId' <> retired.claim->>'jobId' and resumed.claim->>'runId' <> retired.claim->>'runId'
    and resumed.claim->>'baseReceiptId' = retired.claim->>'baseReceiptId'
  from secondary_claim resumed cross join retired_validation retired),
  'resume validates the same sealed repository base with a fresh job and fresh run');
select ok((select old_job.status = 'canceled' and old_run.status = 'canceled'
  from retired_validation retired join public.agent_jobs old_job on old_job.id = (retired.claim->>'jobId')::uuid
  join public.agent_runs old_run on old_run.id = (retired.claim->>'runId')::uuid),
  'the earlier exact attempt remains canceled even after the replacement starts');
select is(pg_temp.finish_multi_validation(), false,
  'matching commit and tree evidence from the paused attempt cannot validate the replacement');
select pg_temp.record_multi_evidence((claim->>'runId')::uuid, repeat('4',40), repeat('5',40)) from secondary_claim;
select is(pg_temp.finish_multi_validation(), true, 'the replacement run can seal its own validated output');
select is(pg_temp.multi_status() #>> '{repositories,0,validationRunId}', (select claim->>'runId' from secondary_claim),
  'the immutable delivery intent points to the replacement proof');

select pg_temp.change_repository_workflow('pause', 462);
select pg_temp.change_repository_workflow('resume', 463);
select is(public.dispatch_next_factory_workflow_repository_validation(), false,
  'pausing and resuming after sealing does not re-admit validation');
select is((select count(*) from internal.factory_workflow_repository_validation_jobs marker
  join multi_join exact on marker.join_id = (exact.receipt->>'joinId')::uuid), 2::bigint,
  'the target keeps its two admitted job identities and creates no third job');
select is((select count(*) from public.list_factory_workflow_repository_deliveries()), 1::bigint,
  'the already sealed repository publication remains independently due after resume');

select * from finish();
rollback;
