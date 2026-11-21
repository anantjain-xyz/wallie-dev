-- Definition preview uses the manager's RLS-scoped client to resolve a named scorer.
grant select on public.factory_benchmark_evaluation_dimensions to authenticated;
create policy factory_benchmark_evaluation_dimensions_read_manager
  on public.factory_benchmark_evaluation_dimensions for select to authenticated
  using (internal.can_manage_factory(workspace_id, factory_id));

-- Restrict admission evidence before joining trial, run, and evaluator data.
-- The existing four-argument readers keep their whole-experiment behavior.
create function internal.factory_benchmark_comparison_trial_facts(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_as_of timestamptz, p_candidate_key text
) returns table (
  trial_id uuid, task_id uuid, task_revision_id uuid, task_revision_number integer, task_name text,
  candidate_key text, candidate_position integer, repetition integer, seed integer, timeout_ms integer,
  eligibility text, eligibility_reason text, disposition text, reason text, admitted boolean, started boolean,
  run_id uuid, started_at timestamptz, finished_at timestamptz, deadline_at timestamptz, wall_runtime_ms bigint,
  deadline_elapsed boolean, runner_revision text, actual_runtime text, model_provider text, model_name text,
  result_digest text, evaluation_commit_sha text, execution_provenance text, execution_actual_usd numeric,
  execution_reserved_usd numeric
) language sql stable set search_path = '' as $$
  with admitted as (
    select count(*) as count
    from public.factory_benchmark_schedule_trials reservation
    where (reservation.workspace_id, reservation.factory_id, reservation.experiment_id) =
      (p_workspace_id, p_factory_id, p_experiment_id)
  ), facts as (
    select frozen.trial_id, frozen.task_id, frozen.task_revision_id,
      task.revision_number, task.name, frozen.candidate_key, candidate.comparison_position, frozen.repetition, frozen.seed, frozen.timeout_ms,
      frozen.replay_eligibility, frozen.eligibility_reason,
      case
        when frozen.replay_eligibility <> 'eligible' then 'excluded'
        when trial.status = 'success' and result.trial_id is not null and run.status = 'success' then 'succeeded'
        when trial.status = 'success' or (reservation.trial_id is not null and (trial.id is null or run.id is null)) then 'unavailable'
        when trial.status = 'error' and trial.failure_code = 'deadline_elapsed' then 'timed_out'
        when trial.status = 'error' then 'failed'
        when trial.status = 'canceled' or (trial.id is null and schedule.state = 'canceled') then 'canceled'
        when trial.id is null and admitted.count >= schedule.max_admitted_trials then 'unavailable'
        when trial.status = 'running' then 'running'
        else 'pending'
      end as disposition,
      case
        when frozen.replay_eligibility <> 'eligible' then coalesce(frozen.eligibility_reason, frozen.replay_eligibility)
        when trial.status = 'success' then case when result.trial_id is null or run.status is distinct from 'success' then 'result_unavailable' end
        when reservation.trial_id is not null and (trial.id is null or run.id is null) then 'execution_unavailable'
        when trial.status = 'error' then trial.failure_code
        when trial.status = 'canceled' then 'trial_canceled'
        when trial.id is null and schedule.state = 'canceled' then 'schedule_canceled'
        when trial.id is null and admitted.count >= schedule.max_admitted_trials then 'expansion_limit_reached'
        when trial.status = 'running' then null
        when factory.status = 'archived' then 'factory_archived'
        when schedule.state = 'paused' then 'schedule_paused'
        when schedule.experiment_id is null then 'schedule_unconfigured'
        when trial.id is null then coalesce(schedule.admission_issue, 'trial_not_admitted')
        else 'trial_queued'
      end as reason,
      reservation.trial_id is not null as admitted, run.started_at is not null as started, reservation.run_id, run.started_at,
      trial.finished_at, trial.deadline_at,
      case when run.finished_at >= run.started_at then floor(extract(epoch from (run.finished_at - run.started_at)) * 1000)::bigint end
        as wall_runtime_ms,
      coalesce(trial.failure_code = 'deadline_elapsed', false)
        or coalesce(trial.deadline_at <= coalesce(trial.finished_at, p_as_of), false) as deadline_elapsed,
      case when run.started_at is not null then trial.runner_revision end as runner_revision,
      case when run.started_at is not null then result.runtime end as actual_runtime,
      case when run.started_at is not null then run.model_provider end as model_provider,
      case when run.started_at is not null then run.model_name end as model_name,
      case when run.status = 'success' then result.result_digest end as result_digest,
      case when run.status = 'success' then result.output_commit_sha end as evaluation_commit_sha,
      case
        when reservation.trial_id is null then null
        when reservation.accounted_at is not null then reservation.cost_provenance
        when trial.status in ('success', 'error', 'canceled') and run.status in ('success', 'error', 'canceled') then case
          when run.started_at is null then 'never_started'
          when run.usage_finalized_at is not null and run.cost_provenance in ('measured', 'estimated')
            and run.total_cost_usd >= 0 and run.total_cost_usd < 'Infinity'::numeric then run.cost_provenance
          else 'unavailable'
        end
        else 'pending'
      end as execution_provenance,
      case when reservation.accounted_at is not null then reservation.actual_usd else run.total_cost_usd end as observed_usd,
      reservation.reserve_usd
    from public.factory_benchmark_experiment_trials frozen
    join public.factories factory on (factory.workspace_id, factory.id) = (frozen.workspace_id, frozen.factory_id)
    join public.factory_benchmark_task_revisions task on (task.workspace_id, task.factory_id, task.task_id, task.id) =
      (frozen.workspace_id, frozen.factory_id, frozen.task_id, frozen.task_revision_id)
    join public.factory_benchmark_experiment_candidates candidate
      on (candidate.workspace_id, candidate.factory_id, candidate.experiment_id, candidate.candidate_key) =
        (frozen.workspace_id, frozen.factory_id, frozen.experiment_id, frozen.candidate_key)
    left join public.factory_benchmark_schedules schedule on (schedule.workspace_id, schedule.factory_id, schedule.experiment_id) =
      (frozen.workspace_id, frozen.factory_id, frozen.experiment_id)
    left join public.factory_benchmark_schedule_trials reservation
      on (reservation.workspace_id, reservation.factory_id, reservation.experiment_id, reservation.trial_id) =
        (frozen.workspace_id, frozen.factory_id, frozen.experiment_id, frozen.trial_id)
    left join public.factory_benchmark_trials trial
      on (trial.workspace_id, trial.factory_id, trial.id, trial.run_id, trial.task_revision_id) =
        (reservation.workspace_id, reservation.factory_id, reservation.trial_id, reservation.run_id, frozen.task_revision_id)
    left join public.agent_runs run on (run.workspace_id, run.session_id, run.id) =
      (trial.workspace_id, trial.session_id, trial.run_id)
    left join public.factory_benchmark_trial_results result
      on (result.workspace_id, result.factory_id, result.trial_id, result.run_id) =
        (trial.workspace_id, trial.factory_id, trial.id, trial.run_id) and trial.status = 'success'
    cross join admitted
    where (frozen.workspace_id, frozen.factory_id, frozen.experiment_id) = (p_workspace_id, p_factory_id, p_experiment_id)
      and (p_candidate_key is null or frozen.candidate_key = p_candidate_key)
  )
  select trial_id, task_id, task_revision_id, revision_number, name, candidate_key, comparison_position,
    repetition, seed, timeout_ms, replay_eligibility, eligibility_reason, disposition, reason, admitted, started, run_id,
    started_at, finished_at, deadline_at, wall_runtime_ms, deadline_elapsed, runner_revision, actual_runtime, model_provider,
    model_name, result_digest, evaluation_commit_sha, execution_provenance,
    case when execution_provenance in ('measured', 'estimated') then observed_usd end,
    case when execution_provenance in ('pending', 'unavailable') then reserve_usd else 0 end
  from facts;
$$;
revoke all on function internal.factory_benchmark_comparison_trial_facts(uuid,uuid,uuid,timestamptz,text)
  from public, anon, authenticated, service_role;

create or replace function internal.factory_benchmark_comparison_trial_facts(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_as_of timestamptz
) returns table (
  trial_id uuid, task_id uuid, task_revision_id uuid, task_revision_number integer, task_name text,
  candidate_key text, candidate_position integer, repetition integer, seed integer, timeout_ms integer,
  eligibility text, eligibility_reason text, disposition text, reason text, admitted boolean, started boolean,
  run_id uuid, started_at timestamptz, finished_at timestamptz, deadline_at timestamptz, wall_runtime_ms bigint,
  deadline_elapsed boolean, runner_revision text, actual_runtime text, model_provider text, model_name text,
  result_digest text, evaluation_commit_sha text, execution_provenance text, execution_actual_usd numeric,
  execution_reserved_usd numeric
) language sql stable set search_path = '' as $$
  select * from internal.factory_benchmark_comparison_trial_facts(p_workspace_id,p_factory_id,p_experiment_id,p_as_of,null::text);
$$;

create function internal.factory_benchmark_frontier_trial_facts(
  p_workspace_id uuid,p_factory_id uuid,p_experiment_id uuid,p_scorer_revision_id uuid, p_candidate_key text
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
    from internal.factory_benchmark_comparison_trial_facts(p_workspace_id,p_factory_id,p_experiment_id,statement_timestamp(),p_candidate_key) fact
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
revoke all on function internal.factory_benchmark_frontier_trial_facts(uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;

create or replace function internal.factory_benchmark_frontier_trial_facts(
  p_workspace_id uuid,p_factory_id uuid,p_experiment_id uuid,p_scorer_revision_id uuid
) returns table (
  trial_id uuid,task_revision_id uuid,candidate_key text,repetition integer,seed integer,timeout_ms integer,eligibility text,disposition text,
  started boolean,comparable boolean,verdict text,judge_signature text,known_nonpass boolean,open_work boolean,
  measured_usd numeric,estimated_usd numeric,cost_state text
) language sql stable set search_path = '' as $$
  select * from internal.factory_benchmark_frontier_trial_facts(p_workspace_id,p_factory_id,p_experiment_id,p_scorer_revision_id,null::text);
$$;

-- This resolver observes the exact configuration a routing policy would choose.
-- Production continues to use its admitted profile while routing is in shadow mode.
create function internal.factory_model_routing_evidence_reason(
  workspace_id uuid, factory_id uuid, experiment_id uuid, candidate_key text, scorer_revision_ref text,
  constraints jsonb
) returns text language plpgsql stable set search_path = '' as $$
declare
  scorer_ids uuid[];
  coverage record;
  latency_coverage record;
  max_cost numeric;
  max_latency integer;
begin
  if jsonb_typeof(constraints) is distinct from 'object'
    or not (constraints ?& array['qualityFloorBps','minResolvedTrials','maxMeanCostUsd','maxLatencyMs','minConfidenceBps'])
    or not coalesce(pg_input_is_valid(constraints->>'qualityFloorBps', 'integer'), false)
    or not coalesce(pg_input_is_valid(constraints->>'minResolvedTrials', 'integer'), false)
    or jsonb_typeof(constraints->'maxMeanCostUsd') not in ('number', 'null')
    or (constraints->>'maxLatencyMs' is not null and not pg_input_is_valid(constraints->>'maxLatencyMs', 'integer')) then
    return 'invalid_policy';
  end if;
  max_cost := (constraints->>'maxMeanCostUsd')::numeric;
  max_latency := (constraints->>'maxLatencyMs')::integer;
  if (constraints->>'qualityFloorBps')::integer not between 0 and 10000
    or (constraints->>'minResolvedTrials')::integer not between 2 and 10000
    or max_cost < 0 or max_latency < 1 then return 'invalid_policy'; end if;
  select array_agg(dimension.scorer_revision_id) into scorer_ids
  from public.factory_benchmark_evaluation_dimensions dimension
  where (dimension.workspace_id, dimension.factory_id, dimension.experiment_id) =
    (factory_model_routing_evidence_reason.workspace_id, factory_model_routing_evidence_reason.factory_id,
     factory_model_routing_evidence_reason.experiment_id)
    and (scorer_revision_ref is null or dimension.scorer_revision_id::text = scorer_revision_ref);
  if cardinality(scorer_ids) is distinct from 1 then return 'evidence_unavailable'; end if;

  select count(*) as eligible,
    count(*) filter (where cell.comparable and (cell.known_nonpass or cell.verdict is not null)) as resolved,
    count(*) filter (where cell.comparable and cell.verdict = 'pass') as passed,
    count(distinct cell.judge_signature) as judge_profiles,
    count(*) filter (where cell.verdict is not null and cell.judge_signature is null) as unverified,
    count(*) filter (where cell.cost_state = 'measured' and cell.measured_usd is not null) as measured,
    avg(cell.measured_usd) filter (where cell.cost_state = 'measured') as mean_cost,
    coalesce(bool_or(cell.open_work), false) as pending
  into coverage
  from internal.factory_benchmark_frontier_trial_facts(workspace_id, factory_id, experiment_id, scorer_ids[1], candidate_key) cell
  where cell.eligibility = 'eligible' and cell.candidate_key = factory_model_routing_evidence_reason.candidate_key;
  if coverage.pending or coverage.eligible = 0 or coverage.resolved <> coverage.eligible
    or coverage.unverified > 0 or coverage.judge_profiles > 1 then
    return 'evidence_unavailable';
  end if;
  if coverage.resolved < (constraints->>'minResolvedTrials')::integer
    or coverage.passed * 10000 < coverage.eligible * (constraints->>'qualityFloorBps')::integer then
    return 'threshold_not_met';
  end if;
  if max_cost is not null then
    if coverage.measured <> coverage.eligible then return 'cost_unavailable'; end if;
    if coverage.mean_cost > max_cost then return 'threshold_not_met'; end if;
  end if;
  if max_latency is not null then
    select count(fact.wall_runtime_ms) as measured,
      ceil(percentile_cont(0.95) within group (order by fact.wall_runtime_ms)) as p95
    into latency_coverage
    from internal.factory_benchmark_comparison_trial_facts(workspace_id, factory_id, experiment_id, statement_timestamp(), candidate_key) fact
    where fact.eligibility = 'eligible' and fact.candidate_key = factory_model_routing_evidence_reason.candidate_key;
    if latency_coverage.measured <> coverage.eligible then return 'latency_unavailable'; end if;
    if latency_coverage.p95 > max_latency then return 'threshold_not_met'; end if;
  end if;
  if constraints->>'minConfidenceBps' is not null then return 'confidence_unavailable'; end if;
  return null;
end;
$$;
revoke all on function internal.factory_model_routing_evidence_reason(uuid, uuid, uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;

create function internal.check_factory_model_routing_target(
  admission public.session_factory_admission_inputs, session_row public.sessions,
  configuration jsonb, constraints jsonb
) returns table (benchmark_candidate_key text, reason text)
language plpgsql set search_path = '' as $$
declare
  candidate record;
  current_grant public.factory_execution_grants;
  target_definition jsonb;
  target_agent_id uuid;
  capability_ok boolean;
  credential_status text;
begin
  if not coalesce(pg_input_is_valid(configuration->>'experimentId', 'uuid'), false)
    or not coalesce(pg_input_is_valid(configuration->>'definitionRevisionId', 'uuid'), false)
    or not coalesce(pg_input_is_valid(configuration->>'qualificationId', 'uuid'), false)
    or not coalesce(pg_input_is_valid(configuration->>'agentId', 'uuid'), false) then
    return query select null::text, 'invalid_policy'::text;
    return;
  end if;

  select stored.*, experiment.suite_revision_id, revision.definition_json::jsonb as definition
  into candidate
  from public.factory_benchmark_experiment_candidates stored
  join public.factory_benchmark_experiments experiment
    on (experiment.workspace_id, experiment.factory_id, experiment.id) =
       (stored.workspace_id, stored.factory_id, stored.experiment_id)
  join public.factory_definition_revisions revision
    on (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
       (stored.workspace_id, stored.factory_id, stored.definition_revision_id, stored.definition_digest)
  join public.factory_agents agent
    on (agent.workspace_id, agent.factory_id, agent.id) =
       (stored.workspace_id, stored.factory_id, (configuration->>'agentId')::uuid)
  where (stored.workspace_id, stored.factory_id, stored.experiment_id, stored.definition_revision_id,
         stored.qualification_id, stored.canonical_model_key, stored.harness, stored.worker_runtime) =
        (admission.workspace_id, admission.factory_id, (configuration->>'experimentId')::uuid,
         (configuration->>'definitionRevisionId')::uuid, (configuration->>'qualificationId')::uuid,
         configuration->>'modelKey', configuration->>'harness', configuration->>'workerRuntime')
    and revision.definition_json::jsonb#>>'{implementationAgent,agentId}' = agent.id::text;
  if not found then
    return query select null::text, 'configuration_unavailable'::text;
    return;
  end if;
  target_definition := candidate.definition;
  target_agent_id := (configuration->>'agentId')::uuid;
  if admission.github_repository_id is null
    or target_definition->>'repositoryId' is distinct from admission.github_repository_id::text then
    return query select null::text, 'repository_mismatch'::text;
    return;
  end if;

  select exists (
    select 1 from internal.factory_benchmark_axis_profiles(
      admission.workspace_id, admission.factory_id, candidate.suite_revision_id,
      array[candidate.definition_revision_id]
    ) profile
    where (profile.id, profile.definition_id, profile.definition_digest, profile.model_key,
           profile.harness, profile.harness_model, profile.worker_runtime, profile.sandbox_provider,
           profile.sandbox_connection_revision, profile.toolchain_digest) =
          (candidate.qualification_id, candidate.definition_revision_id, candidate.definition_digest,
           candidate.canonical_model_key, candidate.harness, candidate.model, candidate.worker_runtime,
           candidate.sandbox_provider, candidate.sandbox_connection_revision, candidate.toolchain_digest)
      and profile.unavailable_reason is null
  ) into capability_ok;
  if not capability_ok then
    return query select null::text, 'qualification_unavailable'::text;
    return;
  end if;

  if admission.execution_grant_id is null and not (target_definition ? 'executionGrant') then
    credential_status := public.check_session_agent_credential(
      admission.workspace_id, admission.credential_owner_member_id, candidate.harness, candidate.model);
  elsif admission.execution_grant_id is not null
    and target_definition#>>'{executionGrant,id}' = admission.execution_grant_id::text
    and target_definition#>>'{executionGrant,version}' = admission.execution_grant_version::text
    and target_definition->>'executionPolicyRevisionId' = admission.execution_policy_revision_id::text
    and pg_input_is_valid(target_definition->>'credentialBindingId', 'uuid')
    and (session_row.creator_service_principal_id is null or target_agent_id::text =
      internal.pinned_session_execution_definition(session_row)#>>'{implementationAgent,agentId}') then
    begin
      current_grant := internal.resolve_definition_execution_grant(admission.workspace_id, admission.factory_id,
        target_definition, admission.github_repository_id, admission.execution_policy_revision_id);
    exception when sqlstate '42501' or sqlstate 'PT409' or sqlstate 'PT422' then
      return query select null::text, 'authority_unavailable'::text;
      return;
    end;
    if current_grant.service_principal_id is distinct from admission.credential_owner_service_principal_id then
      return query select null::text, 'authority_unavailable'::text;
      return;
    end if;
    credential_status := public.check_factory_credential_binding(admission.workspace_id, admission.factory_id,
      (target_definition->>'credentialBindingId')::uuid, current_grant.id, current_grant.version,
      target_agent_id, candidate.harness, candidate.model);
  else
    return query select null::text, 'authority_unavailable'::text;
    return;
  end if;
  if credential_status is distinct from 'ready' then
    return query select null::text, 'credential_unavailable'::text;
    return;
  end if;

  return query select candidate.candidate_key, internal.factory_model_routing_evidence_reason(
    admission.workspace_id, admission.factory_id, candidate.experiment_id, candidate.candidate_key,
    configuration->>'scorerRevisionId', constraints);
exception when data_exception then
  return query select null::text, 'invalid_policy'::text;
end;
$$;
revoke all on function internal.check_factory_model_routing_target(
  public.session_factory_admission_inputs, public.sessions, jsonb, jsonb
) from public, anon, authenticated, service_role;

create function internal.resolve_factory_model_routing(
  admission public.session_factory_admission_inputs, session_row public.sessions, task_class_slug text
) returns jsonb language plpgsql set search_path = '' as $$
declare
  policy jsonb;
  matching_classes jsonb;
  matching_rules jsonb;
  task_class_id text;
  rule jsonb;
  configuration jsonb;
  constraints jsonb;
  prefix jsonb;
  decision record;
  source text;
  reason text;
  initial_reason text;
begin
  select revision.definition_json::jsonb->'modelRouting' into policy
  from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
    (admission.workspace_id, admission.factory_id, admission.definition_revision_id, admission.definition_digest);
  if policy is null then return null; end if;

  if policy->'version' is distinct from '1'::jsonb
    or jsonb_typeof(policy->'taskClasses') is distinct from 'array'
    or jsonb_typeof(policy->'rules') is distinct from 'array' then
    reason := 'invalid_policy';
  else
    select jsonb_agg(entry) into matching_classes
    from jsonb_array_elements(policy->'taskClasses') as classes(entry)
    where entry->>'slug' = task_class_slug;
    if jsonb_array_length(matching_classes) > 1 then
      reason := 'ambiguous_class';
    else
      task_class_id := matching_classes->0->>'id';
      select jsonb_agg(entry) into matching_rules
      from jsonb_array_elements(policy->'rules') as rules(entry)
      where entry->>'taskClassId' = task_class_id;
      if jsonb_array_length(matching_rules) > 1 then
        reason := 'ambiguous_rule';
      else
        rule := matching_rules->0;
      end if;
    end if;
  end if;
  prefix := jsonb_build_object('version', 1, 'mode', 'shadow',
    'policyRevisionId', admission.definition_revision_id, 'policyDigest', admission.definition_digest,
    'taskClassSlug', task_class_slug, 'taskClassId', task_class_id, 'ruleId', rule->>'id');

  if reason is null and rule is null then
    reason := case when task_class_id is null then 'unmatched_class' else 'no_rule' end;
    if policy#>>'{onUnmatched,kind}' = 'fallback' then
      configuration := policy#>'{onUnmatched,configuration}';
      constraints := policy#>'{onUnmatched,constraints}';
      source := 'unmatched_fallback';
      initial_reason := reason;
    end if;
  elsif reason is null then
    configuration := rule->'configuration';
    constraints := rule->'constraints';
    source := 'primary';
  end if;

  if configuration is not null then
    select * into decision from internal.check_factory_model_routing_target(admission, session_row, configuration, constraints);
    reason := decision.reason;
    if reason is not null and source = 'primary' and rule#>>'{onUnavailable,kind}' = 'fallback' then
      initial_reason := reason;
      configuration := rule#>'{onUnavailable,configuration}';
      source := 'rule_fallback';
      select * into decision from internal.check_factory_model_routing_target(admission, session_row, configuration, constraints);
      reason := decision.reason;
    end if;
    if reason is null then
      return prefix || jsonb_build_object('disposition', 'selected', 'source', source, 'reason', 'qualified',
        'configuration', configuration, 'benchmarkCandidateKey', decision.benchmark_candidate_key,
        'initialReason', initial_reason);
    end if;
  end if;
  return prefix || jsonb_build_object('disposition', 'escalated', 'source', null, 'reason', coalesce(reason, 'invalid_policy'),
    'configuration', null, 'benchmarkCandidateKey', null, 'initialReason', initial_reason);
end;
$$;
revoke all on function internal.resolve_factory_model_routing(
  public.session_factory_admission_inputs, public.sessions, text
) from public, anon, authenticated, service_role;
