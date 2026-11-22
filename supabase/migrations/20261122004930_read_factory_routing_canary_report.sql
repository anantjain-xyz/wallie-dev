-- Use one read snapshot for an enrollment window and its currently observed outcomes.
create function internal.read_factory_routing_canary_report(
  p_workspace_id uuid, p_factory_id uuid, p_canary_id uuid,
  p_from timestamptz, p_to timestamptz
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  canary public.factory_routing_canaries;
  benchmark_key text;
  frozen_scorer_revision_id uuid;
  baseline_definition jsonb;
  baseline_primary jsonb;
  observed_at timestamptz := statement_timestamp();
  window_from timestamptz;
  window_to timestamptz;
  result jsonb;
begin
  if auth.uid() is null or not internal.can_manage_factory(p_workspace_id, p_factory_id) then
    raise exception 'Routing canary report is unavailable.' using errcode = '42501';
  end if;
  select designation.* into canary
  from public.factory_routing_canaries designation
  where (designation.workspace_id, designation.factory_id) = (p_workspace_id, p_factory_id)
    and (p_canary_id is null or designation.id = p_canary_id)
  order by designation.activation_number desc limit 1;
  if not found then return null; end if;

  window_from := coalesce(p_from, canary.created_at);
  window_to := least(coalesce(p_to, observed_at), observed_at);
  if (p_from is not null and not isfinite(p_from)) or (p_to is not null and not isfinite(p_to))
      or window_from > window_to or (window_from = window_to and (p_from is not null or p_to is not null)) then
    raise exception 'The routing canary enrollment window is invalid.' using errcode = '22023';
  end if;

  select evidence.candidate_key, (evidence.evidence->>'scorerRevisionId')::uuid
  into benchmark_key, frozen_scorer_revision_id
  from public.factory_routing_activations reviewed
  join public.factory_routing_draft_evidence evidence
    on (evidence.workspace_id, evidence.factory_id, evidence.draft_id) =
       (reviewed.workspace_id, reviewed.factory_id, reviewed.benchmark_evidence_draft_id)
  where (reviewed.workspace_id, reviewed.factory_id, reviewed.activation_number, reviewed.revision_id) =
    (p_workspace_id, p_factory_id, canary.activation_number, canary.candidate_revision_id);

  select revision.definition_json::jsonb into baseline_definition
  from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id) =
    (p_workspace_id, p_factory_id, canary.baseline_revision_id);

  select rule.value->'configuration' into baseline_primary
  from jsonb_array_elements(baseline_definition#>'{modelRouting,taskClasses}') task_class(value)
  join jsonb_array_elements(baseline_definition#>'{modelRouting,rules}') rule(value)
    on rule.value->>'taskClassId' = task_class.value->>'id'
  where task_class.value->>'slug' = canary.task_class_slug;

  with assignments as materialized (
    select admission.session_id, admission.routing_canary_arm as arm,
      admission.routing_canary_eligible as eligible, admission.selected_stage_ids[1] as stage_id,
      admission.github_repository_id as repository_id,
      override.session_id is not null as overridden,
      case when admission.routing_canary_arm = 'candidate' then
        admission.routing_decision->>'source' is distinct from 'primary'
        or admission.routing_execution->>'benchmarkCandidateKey' is distinct from benchmark_key
      else admission.routing_canary_baseline_execution is not null
        and admission.routing_canary_baseline_execution->'configuration' is distinct from baseline_primary
      end as fallback,
      case when admission.routing_canary_arm = 'candidate' then admission.routing_execution
        else admission.routing_canary_baseline_execution end as execution,
      admission.model_provider, admission.model_name,
      owner.phase_status = 'approved' or owner.archived_at is not null
        or owner.execution_exhausted_at is not null as workflow_closed
    from public.session_factory_admission_inputs admission
    join public.sessions owner
      on (owner.workspace_id, owner.factory_id, owner.id) =
         (admission.workspace_id, admission.factory_id, admission.session_id)
    left join public.session_factory_routing_overrides override
      on (override.workspace_id, override.factory_id, override.activation_number, override.session_id) =
         (admission.workspace_id, admission.factory_id, admission.activation_number, admission.session_id)
    where (admission.workspace_id, admission.factory_id, admission.routing_canary_id, admission.activation_number) =
          (p_workspace_id, p_factory_id, canary.id, canary.activation_number)
      and admission.created_at >= window_from and admission.created_at < window_to
      and owner.execution_purpose = 'production' and owner.execute_pinned_definition
  ), members as materialized (
    select * from assignments where eligible
  ), attempts as (
    select member.session_id, run.status::text as status,
      case when run.status in ('success', 'error', 'canceled') and run.finished_at between run.started_at and observed_at
        then extract(epoch from (run.finished_at - run.started_at)) * 1000 end as latency_ms,
      case when run.status not in ('success', 'error', 'canceled') then 'pending'
        when run.usage_finalized_at <= observed_at and run.total_cost_usd >= 0
          and run.total_cost_usd not in ('NaN'::numeric, 'Infinity'::numeric)
          and run.cost_provenance in ('measured', 'estimated') then run.cost_provenance
        else 'unavailable' end as cost_state,
      run.total_cost_usd as cost_usd,
      (run.model_provider, run.model_name, run.agent_id::text, run.agent_prompt_revision_id::text)
        is distinct from (
          coalesce(member.execution#>>'{configuration,harness}', baseline_definition#>>'{agent,provider}', member.model_provider),
          coalesce(member.execution->>'modelName', baseline_definition#>>'{agent,model}', member.model_name),
          coalesce(member.execution#>>'{implementationAgent,agentId}', baseline_definition#>>'{implementationAgent,agentId}', run.agent_id::text),
          coalesce(member.execution#>>'{implementationAgent,promptRevisionId}', baseline_definition#>>'{implementationAgent,promptRevisionId}', run.agent_prompt_revision_id::text)
        ) or (member.execution is not null and (manifest.run_id is null
          or (manifest.worker_runtime, manifest.sandbox_provider, manifest.sandbox_connection_revision::text,
            manifest.agent_effort) is distinct from (
            member.execution#>>'{configuration,workerRuntime}', member.execution->>'sandboxProvider',
            member.execution->>'sandboxConnectionRevision', case when member.execution#>>'{configuration,harness}' = 'codex'
              then coalesce(member.execution->>'effort', 'xhigh') end))) as exposure_mismatch
    from members member
    join public.agent_runs run on (run.workspace_id, run.session_id) = (p_workspace_id, member.session_id)
    left join public.session_attempt_manifests manifest
      on (manifest.workspace_id, manifest.session_id, manifest.run_id, manifest.attempt_count) =
         (run.workspace_id, run.session_id, run.id, run.attempt_count)
    where run.started_at <= observed_at
  ), usage_by_session as (
    select session_id, count(*) as started, count(*) filter (where status = 'success') as succeeded,
      count(*) filter (where status = 'error') as failed, count(*) filter (where status = 'canceled') as canceled,
      count(*) filter (where status not in ('success', 'error', 'canceled')) as pending,
      count(*) filter (where cost_state = 'measured') as measured,
      count(*) filter (where cost_state = 'estimated') as estimated,
      count(*) filter (where cost_state = 'unavailable') as unavailable,
      count(*) filter (where cost_state = 'pending') as pending_cost,
      sum(cost_usd) filter (where cost_state in ('measured', 'estimated')) as known_spend,
      count(latency_ms) as measured_latencies, sum(latency_ms) as measured_wall_ms,
      bool_or(exposure_mismatch) as exposure_mismatch
    from attempts group by session_id
  ), session_evidence as materialized (
    select member.*, usage.started, usage.succeeded, usage.failed, usage.canceled, usage.pending,
      usage.measured, usage.estimated, usage.unavailable, usage.pending_cost, usage.known_spend,
      coalesce(usage.exposure_mismatch, false) as exposure_mismatch,
      case when member.workflow_closed and not open_jobs.present and usage.measured + usage.estimated = usage.started
        then usage.known_spend end as complete_spend,
      case when member.workflow_closed and not open_jobs.present and usage.measured_latencies = usage.started
        then usage.measured_wall_ms end as complete_wall_ms,
      score.status as score_status, score.numeric_score, score.scoring_contract
    from members member
    left join usage_by_session usage using (session_id)
    cross join lateral (
      select exists (select 1 from public.agent_jobs job
        where (job.workspace_id, job.session_id) = (p_workspace_id, member.session_id)
          and job.status in ('queued', 'started', 'running')) as present
    ) open_jobs
    -- Fix the observed quality target before looking at samples or judgments.
    -- The first approved output of the matching stage is stable after reruns.
    left join lateral (
      select artifact as item
      from public.session_stage_approval_receipts approval
      join public.session_artifacts artifact
        on (artifact.workspace_id, artifact.session_id, artifact.stage_id, artifact.id, artifact.version) =
           (approval.workspace_id, approval.session_id, approval.stage_id, approval.artifact_id, approval.artifact_version)
      where (approval.workspace_id, approval.session_id, approval.stage_id) =
        (p_workspace_id, member.session_id, member.stage_id) and approval.approved_at <= observed_at
      order by approval.approval_number limit 1
    ) accepted on true
    left join lateral internal.factory_session_artifact_producer(accepted.item, member.repository_id) producer on true
    left join lateral (
      select case
          when sample.outcome <> 'sampled' then sample.outcome
          when skipped.sample_receipt_id is not null or job.status = 'canceled' then 'skipped'
          when job.status in ('queued', 'claimed') or job.id is null then 'pending'
          when job.status = 'succeeded' then case
            when receipt.status in ('pass', 'fail') and receipt.profile_revision_id is null then 'inconclusive'
            else receipt.status end
          else 'error' end as status,
        case when job.status = 'succeeded' and receipt.status in ('pass', 'fail')
          and receipt.profile_revision_id is not null
          and receipt.result#>>'{score,kind}' = 'numeric' then (receipt.result#>>'{score,value}')::numeric end as numeric_score,
        case when job.status = 'succeeded' and receipt.status in ('pass', 'fail')
          and receipt.profile_revision_id is not null then jsonb_build_array(
          sample.policy_id, receipt.profile_revision_id, receipt.provider_name, receipt.provider_model,
          receipt.adapter_runtime, receipt.worker_runtime, receipt.result#>>'{score,kind}') end as scoring_contract
      from public.factory_scorer_sample_receipts sample
      left join public.factory_scorer_admission_skips skipped on skipped.sample_receipt_id = sample.id
      left join public.factory_evaluation_jobs job
        on (job.workspace_id, job.factory_id, job.session_id, job.run_id, job.scorer_revision_id, job.sample_receipt_id, job.target_commit_sha) =
           (sample.workspace_id, sample.factory_id, sample.session_id, sample.run_id, sample.scorer_revision_id, sample.id, sample.target_commit_sha)
        and job.source_attempt_id is null
      left join lateral (
        select recorded.* from public.factory_evaluation_receipts recorded
        where (recorded.workspace_id, recorded.factory_id, recorded.session_id, recorded.run_id,
          recorded.scorer_revision_id, recorded.job_id, recorded.sample_receipt_id, recorded.target_commit_sha) =
          (job.workspace_id, job.factory_id, job.session_id, job.run_id,
            job.scorer_revision_id, job.id, job.sample_receipt_id, job.target_commit_sha)
          and recorded.finished_at <= observed_at
        order by recorded.attempt_number desc limit 1
      ) receipt on true
      where (sample.workspace_id, sample.factory_id, sample.session_id, sample.run_id, sample.attempt_count,
        sample.scorer_revision_id, sample.target_commit_sha) = (p_workspace_id, p_factory_id, member.session_id,
        producer.run_id, producer.attempt_count, frozen_scorer_revision_id, producer.commit_sha)
        and sample.benchmark_trial_id is null and sample.policy_id is not null and sample.created_at <= observed_at
      order by (job.id is not null) desc, sample.created_at, sample.id limit 1
    ) score on true
  ), score_semantics as (
    select count(distinct scoring_contract) > 1 as mixed from session_evidence
  ), arm_totals as (
    select arm.name, count(evidence.session_id) as assignments,
      count(evidence.complete_spend) as spend_support, count(evidence.complete_wall_ms) as latency_support,
      count(*) filter (where evidence.score_status in ('pass', 'fail')) as score_support,
      coalesce(sum(evidence.unavailable + evidence.pending_cost), 0) > 0 as incomplete_usage,
      coalesce(bool_or(evidence.overridden or evidence.fallback or evidence.exposure_mismatch), false) as deviated,
      jsonb_build_object(
        'assignedSessions', count(evidence.session_id), 'startedSessions', count(evidence.started),
        'startedAttempts', coalesce(sum(evidence.started), 0), 'succeededAttempts', coalesce(sum(evidence.succeeded), 0),
        'failedAttempts', coalesce(sum(evidence.failed), 0), 'canceledAttempts', coalesce(sum(evidence.canceled), 0),
        'pendingAttempts', coalesce(sum(evidence.pending), 0),
        'overriddenSessions', count(*) filter (where evidence.overridden),
        'fallbackSessions', count(*) filter (where evidence.fallback),
        'exposureMismatchSessions', count(*) filter (where evidence.exposure_mismatch),
        'measuredCostAttempts', coalesce(sum(evidence.measured), 0), 'estimatedCostAttempts', coalesce(sum(evidence.estimated), 0),
        'unavailableCostAttempts', coalesce(sum(evidence.unavailable), 0), 'pendingCostAttempts', coalesce(sum(evidence.pending_cost), 0),
        'knownSpendUsd', sum(evidence.known_spend), 'completeSpendSessions', count(evidence.complete_spend),
        'meanSpendUsd', avg(evidence.complete_spend), 'knownLatencySessions', count(evidence.complete_wall_ms),
        'meanLatencyMs', avg(evidence.complete_wall_ms),
        'scoredSessions', count(*) filter (where evidence.score_status in ('pass', 'fail')),
        'scorePasses', count(*) filter (where evidence.score_status = 'pass'),
        'scoreFailures', count(*) filter (where evidence.score_status = 'fail'),
        'scoreInconclusiveSessions', count(*) filter (where evidence.score_status = 'inconclusive'),
        'scorePendingSessions', count(*) filter (where evidence.score_status = 'pending'),
        'scoreNotSampledSessions', count(*) filter (where evidence.score_status = 'not_sampled'),
        'unavailableScoreSessions', count(evidence.session_id) filter (where coalesce(evidence.score_status, '') not in ('pass', 'fail')),
        'meanNumericScore', case when not (select mixed from score_semantics) then avg(evidence.numeric_score) end
      ) as metrics
    from (values ('baseline'), ('candidate')) as arm(name)
    left join session_evidence evidence on evidence.arm = arm.name
    group by arm.name
  ), reliability as (
    select array_remove(array[
      case when min(assignments) < canary.minimum_support then 'insufficient_enrollment' end,
      case when min(score_support) < canary.minimum_support then 'insufficient_quality' end,
      case when min(spend_support) < canary.minimum_support then 'insufficient_spend' end,
      case when min(latency_support) < canary.minimum_support then 'insufficient_latency' end,
      case when (select mixed from score_semantics) then 'incomparable_scores' end,
      case when bool_or(incomplete_usage) then 'incomplete_usage' end,
      case when bool_or(deviated) then 'exposure_deviations' end
    ], null) as reasons
    from arm_totals
  )
  select jsonb_build_object(
    'canary', jsonb_build_object(
      'id', canary.id, 'activationNumber', canary.activation_number, 'baselineActivationNumber', canary.baseline_activation_number,
      'candidateRevisionId', canary.candidate_revision_id, 'baselineRevisionId', canary.baseline_revision_id,
      'taskClassId', canary.task_class_id, 'taskClassSlug', canary.task_class_slug,
      'candidateBps', canary.candidate_bps, 'minimumSupport', canary.minimum_support, 'createdAt', canary.created_at,
      'scorerRevisionId', frozen_scorer_revision_id),
    'window', jsonb_build_object('from', window_from, 'to', window_to, 'asOf', observed_at),
    'status', case when cardinality(reliability.reasons) = 0 then 'comparable' else 'inconclusive' end,
    'reasons', to_jsonb(reliability.reasons),
    'outsideClassSessions', (select count(*) from assignments where not eligible),
    'baseline', (select metrics from arm_totals where name = 'baseline'),
    'candidate', (select metrics from arm_totals where name = 'candidate')
  ) into result from reliability;
  return result;
end;
$$;
revoke all on function internal.read_factory_routing_canary_report(uuid, uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function internal.read_factory_routing_canary_report(uuid, uuid, uuid, timestamptz, timestamptz)
  to authenticated;

create function public.get_factory_routing_canary_report(
  p_workspace_id uuid, p_factory_id uuid, p_canary_id uuid default null,
  p_from timestamptz default null, p_to timestamptz default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.read_factory_routing_canary_report(p_workspace_id, p_factory_id, p_canary_id, p_from, p_to);
$$;
revoke all on function public.get_factory_routing_canary_report(uuid, uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.get_factory_routing_canary_report(uuid, uuid, uuid, timestamptz, timestamptz)
  to authenticated;
