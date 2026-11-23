begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65310000
\set op653_test_validation_seconds 600
\ir fixtures/factory_workflow_repository_delivery.psql

select is(pg_temp.finish_multi_validation(), true, 'the exact passing secondary run durably seals its own candidate');
select is(pg_temp.multi_status() #>> '{repositories,0,validationRunId}', (select claim->>'runId' from secondary_claim),
  'the delivery read preserves the validation identity without exposing the lease');

create function pg_temp.claim_secondary_delivery() returns jsonb language sql as $$
  select public.claim_factory_workflow_repository_delivery(root_session_id,workspace_id,factory_id,generation,ownership_token,
    join_id,repository_id) from public.list_factory_workflow_repository_deliveries()
$$;
create function pg_temp.settle_secondary_delivery(p_lease jsonb,p_action text,p_remote_sha text default null)
returns text language sql as $$
  select public.settle_factory_workflow_repository_delivery(
    owner."sessionId",owner.workspace_id,owner.factory_id,owner.execution_generation,owner.ownership_token,
    (receipt->>'joinId')::uuid,pg_temp.op651_id(62),(p_lease->>'leaseId')::uuid,p_action,
    (p_lease#>>'{target,repository_numeric_id}')::bigint,p_lease#>>'{intent,retained_ref}',p_remote_sha)
  from multi_owner owner cross join multi_join
$$;

create temp table first_secondary_lease as select pg_temp.claim_secondary_delivery() as claim;
select is((select public.claim_factory_workflow_repository_delivery(
    owner."sessionId",owner.workspace_id,owner.factory_id,owner.execution_generation,owner.ownership_token,
    (receipt->>'joinId')::uuid,pg_temp.op651_id(62)) from multi_owner owner cross join multi_join), null::jsonb,
  'an exact live publication lease cannot be concurrently replaced');
select is((select pg_temp.settle_secondary_delivery(claim,'adopt',repeat('9',40)) from first_secondary_lease),
  'proof_mismatch', 'an incompatible remote SHA cannot be adopted');
create function pg_temp.probe_rejected_repository_delivery(p_case text)
returns text language plpgsql as $$
declare
  result text;
  lease jsonb;
  writer public.factory_execution_grants;
begin
  select claim into strict lease from first_secondary_lease;
  if p_case = 'revoked' then
    select value.* into strict writer from secondary_grant value;
    perform public.revoke_factory_execution_grant(writer.workspace_id, writer.factory_id,
      pg_temp.op651_id(1), writer.id, writer.version, null);
    result := pg_temp.settle_secondary_delivery(lease, 'adopt', repeat('4',40));
  elsif p_case = 'stale' then
    update internal.factory_workflow_secondary_repository_heads set receipt_id = gen_random_uuid()
    where repository_id = pg_temp.op651_id(62);
    result := pg_temp.settle_secondary_delivery(lease, 'adopt', repeat('4',40));
  else
    result := pg_temp.settle_secondary_delivery(lease, 'incompatible_ref', repeat('9',40));
    if not exists (select 1 from internal.factory_workflow_repository_delivery_state
      where blocker = 'incompatible_ref' and observed_conflicting_sha = repeat('9',40)) then
      result := 'missing_conflict_proof';
    end if;
  end if;
  raise exception using errcode = 'P7777', message = 'Revert the isolated negative probe.';
exception when sqlstate 'P7777' then
  return result;
end;
$$;
select is(pg_temp.probe_rejected_repository_delivery('revoked'), 'authority_unavailable',
  'revoking the actual repository grant prevents an exact existing lease from adopting');
select is(pg_temp.probe_rejected_repository_delivery('stale'), 'stale_repository_head',
  'the same commit under a newer head receipt cannot satisfy causal adoption');
select is(pg_temp.probe_rejected_repository_delivery('incompatible'), 'incompatible_ref',
  'the ledger retains exact conflicting ref evidence for reconciliation');
select is((select pg_temp.settle_secondary_delivery(claim,'retry') from first_secondary_lease),
  'publication_unavailable', 'transient remote failure retains immutable validated bytes and releases its lease');
select is(pg_temp.multi_status() #>> '{repositories,0,blocker}', 'publication_unavailable',
  'publication failure surfaces as a recoverable repository-specific obligation');
update internal.factory_workflow_repository_delivery_state set next_attempt_at = clock_timestamp()
where status = 'pending';
create temp table second_secondary_lease as select pg_temp.claim_secondary_delivery() as claim;
select ok((select first.claim->>'leaseId' <> second.claim->>'leaseId'
  and first.claim->'intent' = second.claim->'intent' from first_secondary_lease first cross join second_secondary_lease second),
  'restart claims the same retained ref and candidate with a new lease');
select is((select pg_temp.settle_secondary_delivery(claim,'adopt',repeat('4',40)) from first_secondary_lease),
  'stale_lease', 'the earlier worker cannot adopt the exact candidate after recovery replaced its lease');
select is((select pg_temp.settle_secondary_delivery(claim,'adopt',repeat('4',40)) from second_secondary_lease),
  'adopted', 'the new worker can adopt the same verified repository ref');
select is(pg_temp.multi_status()->>'status', 'adopted', 'the parent reports complete only after all repositories are adopted');
select ok(exists(select 1 from internal.factory_workflow_node_results r join multi_join q
  on r.occurrence_id = (q.receipt->>'occurrenceId')::uuid where r.outcome = 'succeeded'),
  'the last repository adoption publishes exactly one causal join result');

select is((select count(*) from internal.factory_workflow_node_occurrences occurrence
  join multi_owner owner on owner."sessionId" = occurrence.root_session_id
  where occurrence.node_kind = 'review'), 1::bigint,
  'the durable whole-repository result admits the configured review once');
select is((select public.claim_factory_workflow_exact_review(owner."sessionId", owner.workspace_id, owner.factory_id,
    owner.execution_generation, owner.ownership_token, occurrence.occurrence_id, pg_temp.op651_id(490))->>'checkpointRunId'
  from internal.factory_workflow_node_occurrences occurrence join multi_owner owner on owner."sessionId" = occurrence.root_session_id
  where occurrence.node_kind = 'review'),
  (select claim->>'runId' from primary_claim),
  'the review pins the exact accepted primary checkpoint');

select * from finish();
rollback;
