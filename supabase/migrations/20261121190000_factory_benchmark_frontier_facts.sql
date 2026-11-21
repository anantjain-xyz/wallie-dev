-- Reuse the comparison's exact execution and spend facts. Restrict judge
-- joins to the selected frozen scorer and each canonical adopted output.
create function internal.factory_benchmark_frontier_trial_facts(
  p_workspace_id uuid,p_factory_id uuid,p_experiment_id uuid,p_scorer_revision_id uuid
) returns table (
  trial_id uuid,task_revision_id uuid,candidate_key text,repetition integer,seed integer,timeout_ms integer,eligibility text,disposition text,
  started boolean,comparable boolean,verdict text,judge_signature text,known_nonpass boolean,open_work boolean,
  measured_usd numeric,estimated_usd numeric,cost_state text
) language sql stable set search_path = '' as $$
  with judge_admission as materialized (
    select scorer.definition
    from public.factory_benchmark_schedules schedule
    join public.factory_benchmark_evaluation_plans plan using (workspace_id,factory_id,experiment_id)
    join public.factories factory on (factory.workspace_id,factory.id) = (schedule.workspace_id,schedule.factory_id)
    join public.factory_scorer_revisions scorer on (scorer.workspace_id,scorer.factory_id,scorer.id) =
      (schedule.workspace_id,schedule.factory_id,p_scorer_revision_id)
    where (schedule.workspace_id,schedule.factory_id,schedule.experiment_id) = (p_workspace_id,p_factory_id,p_experiment_id)
      and factory.status = 'active' and schedule.state in ('active','paused')
      and internal.factory_benchmark_evaluation_budget_block(schedule,plan.budget_limit_usd)
        is distinct from 'evaluation_budget_exhausted'
  ), cells as materialized (
    select fact.*,trial.attempt_count,trial.session_id,
      coalesce(trial.runner_revision = 'openai-responses-v1' and fact.started and trial.attempt_count is not null
        and (trial.effective_execution_digest,trial.inference_connection_revision) =
          (candidate.candidate_key,candidate.live_inference_connection_revision)
        and candidate.worker_runtime = 'workerd' and candidate.canonical_model_key like 'openai/%'
        and case fact.disposition
          when 'succeeded' then fact.actual_runtime = 'workerd' and inference.id = result.inference_receipt_id
            and inference.observed_model = split_part(candidate.canonical_model_key,'/',2)
          when 'failed' then coalesce(inference.observed_model = split_part(candidate.canonical_model_key,'/',2),false)
            or observed.model_matched
          when 'timed_out' then coalesce(inference.observed_model = split_part(candidate.canonical_model_key,'/',2),false)
            or observed.model_matched
          else false end,false) as comparable
    from internal.factory_benchmark_comparison_trial_facts(p_workspace_id,p_factory_id,p_experiment_id,statement_timestamp()) fact
    join public.factory_benchmark_experiment_candidates candidate
      on (candidate.workspace_id,candidate.factory_id,candidate.experiment_id,candidate.candidate_key) =
        (p_workspace_id,p_factory_id,p_experiment_id,fact.candidate_key)
    left join public.factory_benchmark_trials trial on (trial.workspace_id,trial.factory_id,trial.id,trial.run_id) =
      (p_workspace_id,p_factory_id,fact.trial_id,fact.run_id)
    left join public.factory_benchmark_trial_results result on (result.workspace_id,result.factory_id,result.trial_id,result.run_id,
        result.result_digest) = (p_workspace_id,p_factory_id,fact.trial_id,fact.run_id,fact.result_digest)
    left join internal.factory_benchmark_inference_receipts inference on inference.trial_id = trial.id
    cross join lateral (
      select fact.disposition in ('failed','timed_out') and exists (
        select 1 from internal.factory_benchmark_inference_requests request
        where request.trial_id = trial.id and request.status <> 'started'
          and (request.expected_model,request.observed_model) =
            (split_part(candidate.canonical_model_key,'/',2),split_part(candidate.canonical_model_key,'/',2))
      ) as model_matched
    ) observed
  ), selected_jobs as materialized (
    select cell.trial_id,cell.run_id,sample.id as sample_id,sample.target_commit_sha,job.id as job_id,job.status as job_status
    from cells cell join public.factory_scorer_sample_receipts sample
      on (sample.workspace_id,sample.factory_id,sample.benchmark_trial_id,sample.session_id,sample.run_id,
          sample.benchmark_result_digest,sample.target_commit_sha,sample.scorer_revision_id) =
        (p_workspace_id,p_factory_id,cell.trial_id,cell.session_id,cell.run_id,
          cell.result_digest,cell.evaluation_commit_sha,p_scorer_revision_id)
    join public.factory_evaluation_jobs job on (job.workspace_id,job.factory_id,job.session_id,job.run_id,
        job.sample_receipt_id,job.scorer_revision_id,job.target_commit_sha) =
      (sample.workspace_id,sample.factory_id,sample.session_id,sample.run_id,
        sample.id,sample.scorer_revision_id,sample.target_commit_sha) and job.source_attempt_id is null
  ), attempts as materialized (
    select selected.trial_id,selected.job_status,
      row_number() over (partition by selected.job_id order by attempt.attempt_number desc) as newest,
      case when selected.job_status = 'succeeded' and attempt.outcome = 'succeeded' and invocation.status = 'completed'
        and settled.status in ('pass','fail') and settled.evidence_digest = invocation.evidence_digest
        and settled.profile_revision_id = invocation.profile_revision_id then settled.status end as verdict,
      case when settled.profile_revision_id is not null and nullif(btrim(settled.provider_model),'') is not null
        and nullif(btrim(settled.provider_name),'') is not null and settled.adapter_runtime is not null
        then jsonb_build_array(settled.profile_revision_id,settled.adapter_runtime,settled.provider_model,settled.provider_name)::text end as signature,
      case when reservation.accounted_at is not null then reservation.cost_provenance
        when settled.attempt_id is not null then case when settled.started_at is null then 'never_started' else settled.cost_provenance end
        when attempt.settled_at is null then 'pending'
        when invocation.started_at is not null then 'unavailable'
        else 'never_started' end as provenance,
      coalesce(reservation.actual_usd,settled.cost_usd) as observed_usd
    from selected_jobs selected join public.factory_evaluation_attempts attempt
      on (attempt.workspace_id,attempt.factory_id,attempt.job_id) = (p_workspace_id,p_factory_id,selected.job_id)
    left join public.factory_evaluation_receipts settled on (settled.workspace_id,settled.factory_id,settled.job_id,
        settled.attempt_id,settled.run_id,settled.scorer_revision_id,settled.sample_receipt_id,settled.target_commit_sha) =
      (p_workspace_id,p_factory_id,selected.job_id,attempt.id,selected.run_id,p_scorer_revision_id,selected.sample_id,selected.target_commit_sha)
    left join public.factory_judge_invocations invocation on (invocation.workspace_id,invocation.factory_id,invocation.job_id,invocation.attempt_id) =
      (p_workspace_id,p_factory_id,selected.job_id,attempt.id)
    left join public.factory_benchmark_schedule_evaluations reservation on (reservation.trial_id,reservation.attempt_id) =
      (selected.trial_id,attempt.id)
  ), judge as (
    select attempt.trial_id,max(attempt.verdict) filter (where attempt.newest = 1) as verdict,
      max(attempt.signature) filter (where attempt.newest = 1 and attempt.verdict is not null) as signature,
      bool_or(attempt.provenance = 'pending') as pending,
      bool_or(attempt.provenance = 'unavailable') as unavailable,
      bool_or(attempt.provenance = 'estimated') as estimated,
      sum(attempt.observed_usd) filter (where attempt.provenance = 'measured') as measured_usd,
      sum(attempt.observed_usd) filter (where attempt.provenance = 'estimated') as estimated_usd
    from attempts attempt group by attempt.trial_id
  )
  select cell.trial_id,cell.task_revision_id,cell.candidate_key,cell.repetition,cell.seed,cell.timeout_ms,cell.eligibility,cell.disposition,
    cell.started,cell.comparable,case when cell.comparable then judge.verdict end,
    case when cell.comparable then judge.signature end,
    cell.comparable and cell.disposition in ('failed','timed_out'),
    cell.disposition in ('pending','running') or coalesce(selected.job_status in ('queued','claimed'),false) or admission.pending,
    case when cell.execution_provenance = 'measured' then cell.execution_actual_usd + coalesce(judge.measured_usd,0)
      else judge.measured_usd end,
    case when cell.execution_provenance = 'estimated' then cell.execution_actual_usd + coalesce(judge.estimated_usd,0)
      else judge.estimated_usd end,
    case
      when cell.execution_provenance = 'unavailable' or judge.unavailable then 'unavailable'
      when cell.disposition in ('pending','running') or judge.pending or selected.job_status in ('queued','claimed')
        or admission.pending then 'pending'
      when not cell.started then 'never_started'
      when p_scorer_revision_id is not null and cell.disposition = 'succeeded' and selected.job_id is null then 'unavailable'
      when cell.execution_provenance = 'estimated' or judge.estimated then 'estimated'
      when cell.execution_provenance = 'measured' then 'measured'
      else 'unavailable' end
  from cells cell left join selected_jobs selected using (trial_id) left join judge using (trial_id)
  cross join lateral (
    -- Result adoption and judge admission are separate transactions. A ready
    -- exact output is still pending in the interval between them.
    select case when cell.comparable and cell.disposition = 'succeeded' and selected.job_id is null then exists (
      select 1 from internal.factory_benchmark_evaluation_outputs output cross join judge_admission policy
      where (output.workspace_id,output.factory_id,output.experiment_id,output.trial_id,output.run_id,output.result_digest) =
        (p_workspace_id,p_factory_id,p_experiment_id,cell.trial_id,cell.run_id,cell.result_digest)
        and jsonb_array_length(internal.factory_benchmark_evaluation_evidence(output,policy.definition,false)) =
          jsonb_array_length(policy.definition->'requiredEvidence')
    ) else false end as pending
  ) admission;
$$;
revoke all on function internal.factory_benchmark_frontier_trial_facts(uuid,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
