create function public.get_factory_improvement_outcomes(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_proposal_id uuid, p_proposal_revision_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  adoption internal.factory_improvement_adoptions;
  manager_id uuid;
  projection_at timestamptz := statement_timestamp();
  minimum_completed constant integer := 10;
  restore_receipt jsonb;
  restore_eligible boolean;
  report jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  manager_id := internal.factory_benchmark_comparison_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  if manager_id is null then
    raise exception 'Factory improvement outcomes are unavailable.' using errcode = '42501';
  end if;

  select * into adoption from internal.factory_improvement_adoptions receipt
  where (receipt.workspace_id,receipt.factory_id,receipt.proposal_id,receipt.proposal_revision_id) =
    (p_workspace_id,p_factory_id,p_proposal_id,p_proposal_revision_id);
  if not found then return null; end if;

  select jsonb_build_object(
    'activationNumber',rollback.activation_number,'previousActivationNumber',rollback.previous_activation_number,
    'targetActivationNumber',rollback.target_activation_number,'targetRevisionId',rollback.target_revision_id,
    'restoredMode',rollback.restored_mode,'createdAt',rollback.created_at
  ) into restore_receipt
  from public.factory_routing_rollbacks rollback
  join public.factory_definition_activations restored on (restored.workspace_id,restored.factory_id,restored.activation_number) =
    (rollback.workspace_id,rollback.factory_id,rollback.activation_number)
  where (rollback.workspace_id,rollback.factory_id,rollback.activation_number,rollback.previous_activation_number,
    rollback.target_activation_number,rollback.target_revision_id,restored.revision_id) =
    (p_workspace_id,p_factory_id,adoption.activation_number + 1,adoption.activation_number,
      adoption.baseline_activation_number,adoption.baseline_revision_id,adoption.baseline_revision_id);

  select restore_receipt is null and exists (
    select 1 from public.factories factory
    join public.workspace_members member on (member.workspace_id,member.id) = (factory.workspace_id,manager_id)
    cross join lateral (
      select candidate.activation_number,candidate.revision_id
      from public.factory_definition_activations candidate
      where (candidate.workspace_id,candidate.factory_id) = (factory.workspace_id,factory.id)
      order by candidate.activation_number desc limit 1
    ) head
    where (factory.workspace_id,factory.id,factory.status) = (p_workspace_id,p_factory_id,'active')
      and member.role in ('owner','admin')
      and (head.activation_number,head.revision_id) = (adoption.activation_number,adoption.adopted_revision_id)
  ) into restore_eligible;

  with arms(name,activation_number,revision_id,digest) as (
    values ('baseline',adoption.baseline_activation_number,adoption.baseline_revision_id,adoption.baseline_digest),
      ('candidate',adoption.activation_number,adoption.adopted_revision_id,adoption.adopted_digest)
  ), exposures as materialized (
    select arm.name,admission.session_id,admission.created_at as admitted_at,
      owner.phase_status,owner.execution_exhausted_at,owner.execution_exhaustion_code
    from arms arm
    join public.session_factory_admission_inputs admission
      on (admission.workspace_id,admission.factory_id,admission.activation_number,
        admission.definition_revision_id,admission.definition_digest) =
         (p_workspace_id,p_factory_id,arm.activation_number,arm.revision_id,arm.digest)
    join public.sessions owner on (owner.workspace_id,owner.factory_id,owner.id) =
      (admission.workspace_id,admission.factory_id,admission.session_id)
    where owner.execution_purpose = 'production' and owner.execute_pinned_definition
      and admission.created_at <= projection_at
  ), attempts as (
    select exposure.session_id,run.total_cost_usd,
      case when run.status not in ('success','error','canceled') or run.finished_at > projection_at then 'pending'
        when run.finished_at >= run.started_at and run.usage_finalized_at <= projection_at and run.total_cost_usd >= 0
          and run.total_cost_usd not in ('NaN'::numeric,'Infinity'::numeric)
          and run.cost_provenance in ('measured','estimated') then run.cost_provenance
        else 'unavailable' end as cost_state
    from exposures exposure
    join public.agent_runs run on (run.workspace_id,run.session_id) = (p_workspace_id,exposure.session_id)
    where run.started_at between exposure.admitted_at and projection_at
  ), usage as (
    select attempt.session_id,count(*) as started,
      count(*) filter (where attempt.cost_state = 'measured') as measured,
      count(*) filter (where attempt.cost_state = 'estimated') as estimated,
      count(*) filter (where attempt.cost_state = 'unavailable') as unavailable,
      count(*) filter (where attempt.cost_state = 'pending') as pending,
      sum(attempt.total_cost_usd) filter (where attempt.cost_state in ('measured','estimated')) as known_usd
    from attempts attempt group by attempt.session_id
  ), outcomes as (
    select exposure.*,usage.started,usage.measured,usage.estimated,usage.unavailable,usage.pending,usage.known_usd,
      case when exposure.phase_status = 'approved' and exists (
        select 1 from internal.factory_outcome_observations approval
        where (approval.workspace_id,approval.factory_id,approval.session_id) = (p_workspace_id,p_factory_id,exposure.session_id)
          and (approval.event_type,approval.source_kind,approval.status) = ('review.approved','approval_receipt','approved')
          and approval.occurred_at between exposure.admitted_at and projection_at and approval.observed_at <= projection_at
      ) then 'approved'
        when exposure.phase_status <> 'approved' and usage.started > 0
          and exposure.execution_exhaustion_code in ('repair_attempts','elapsed_execution','tokens','spend')
          and exposure.execution_exhausted_at between exposure.admitted_at and projection_at
          then 'exhausted' else 'unresolved' end as outcome,
      exists (
        select 1 from internal.current_factory_canonical_pull_request_merges delivery
        where (delivery.workspace_id,delivery.factory_id,delivery.session_id) = (p_workspace_id,p_factory_id,exposure.session_id)
          and delivery.status = 'observed' and delivery.merged_at between exposure.admitted_at and delivery.observed_at
          and delivery.observed_at <= projection_at
      ) as verified_merge
    from exposures exposure left join usage using (session_id)
  ), coverage as (
    select arm.name,arm.activation_number,arm.revision_id,arm.digest,
      count(outcome.session_id) as admitted,count(outcome.started) as started,
      count(*) filter (where outcome.outcome = 'approved') as approved,
      count(*) filter (where outcome.outcome = 'exhausted') as exhausted,
      count(*) filter (where outcome.outcome = 'unresolved') as unresolved,
      count(*) filter (where outcome.verified_merge) as verified_merges,
      coalesce(sum(outcome.measured),0) as measured,coalesce(sum(outcome.estimated),0) as estimated,
      coalesce(sum(outcome.unavailable),0) as unavailable,coalesce(sum(outcome.pending),0) as pending,
      sum(outcome.known_usd) as known_usd
    from arms arm left join outcomes outcome on outcome.name = arm.name
    group by arm.name,arm.activation_number,arm.revision_id,arm.digest
  ), ranges as (
    select arm.*,
      floor(10000.0 * arm.approved / nullif(arm.admitted,0)) as lower,
      ceil(10000.0 * (arm.approved + arm.unresolved) / nullif(arm.admitted,0)) as upper,
      round(10000.0 * arm.approved / nullif(arm.approved + arm.exhausted,0)) as approval_rate
    from coverage arm
  ), reliability as (
    select array_remove(array[
      case when min(arm.approved + arm.exhausted) < minimum_completed then 'insufficient_completed_sessions' end,
      case when bool_or(arm.unresolved::numeric > arm.admitted * 0.2) then 'incomplete_outcome_coverage' end
    ],null) as reasons,
    max(arm.upper) filter (where arm.name = 'candidate') < max(arm.lower) filter (where arm.name = 'baseline') as degraded
    from ranges arm
  ), projected as (
    select jsonb_object_agg(arm.name,jsonb_build_object(
      'activationNumber',arm.activation_number,'revisionId',arm.revision_id,'digest',arm.digest,
      'admittedSessions',arm.admitted,'startedSessions',arm.started,'approvedSessions',arm.approved,
      'exhaustedSessions',arm.exhausted,'unresolvedSessions',arm.unresolved,'verifiedMerges',arm.verified_merges,
      'approvalRateBps',arm.approval_rate,
      'approvalLimitsBps',case when arm.admitted > 0 then jsonb_build_object('lower',arm.lower,'upper',arm.upper) end,
      'spend',jsonb_build_object(
        'state',case when arm.started = 0 then 'no_attempts' when arm.known_usd is null then 'unavailable'
          when arm.unavailable + arm.pending > 0 then 'partial' when arm.estimated > 0 then 'estimated' else 'measured' end,
        'knownUsd',arm.known_usd,'measuredAttempts',arm.measured,'estimatedAttempts',arm.estimated,
        'unavailableAttempts',arm.unavailable,'pendingAttempts',arm.pending
      )
    )) as cohorts from ranges arm
  )
  select jsonb_build_object('adoptionId',adoption.id,'observedAt',projection_at,'minimumCompleted',minimum_completed,
    'status',case when cardinality(reliability.reasons) > 0 then 'inconclusive'
      when reliability.degraded then 'degraded' else 'observed' end,
    'reasons',to_jsonb(reliability.reasons),'baseline',projected.cohorts->'baseline','candidate',projected.cohorts->'candidate',
    'restore',jsonb_build_object('eligible',restore_eligible,'receipt',restore_receipt)
  ) into report from reliability cross join projected;
  return report;
end;
$$;

revoke all on function public.get_factory_improvement_outcomes(uuid,uuid,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_factory_improvement_outcomes(uuid,uuid,uuid,uuid,uuid) to service_role;
