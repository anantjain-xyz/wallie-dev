-- Both experiment identities are frozen before either schedule becomes visible.
-- A proposal revision has one immutable holdout and threshold decision.
create table internal.factory_improvement_validations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  proposal_id uuid not null,
  proposal_revision_id uuid not null,
  request_id uuid not null,
  author_member_id uuid not null,
  targeted_experiment_id uuid not null,
  holdout_experiment_id uuid not null,
  intent jsonb not null check (jsonb_typeof(intent) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, proposal_id, proposal_revision_id),
  unique (workspace_id, factory_id, request_id),
  unique (workspace_id, factory_id, targeted_experiment_id),
  unique (workspace_id, factory_id, holdout_experiment_id),
  check (targeted_experiment_id <> holdout_experiment_id),
  foreign key (workspace_id, factory_id, proposal_id, proposal_revision_id)
    references internal.factory_improvement_proposal_revisions(workspace_id, factory_id, proposal_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, targeted_experiment_id)
    references public.factory_benchmark_experiments(workspace_id, factory_id, id) deferrable initially deferred,
  foreign key (workspace_id, factory_id, holdout_experiment_id)
    references public.factory_benchmark_experiments(workspace_id, factory_id, id) deferrable initially deferred
);
alter table internal.factory_improvement_validations enable row level security;
revoke all on internal.factory_improvement_validations from public, anon, authenticated, service_role;
create trigger preserve_factory_improvement_validations before update or delete
  on internal.factory_improvement_validations for each row execute function internal.preserve_factory_improvement_history();

create function internal.assert_factory_improvement_validation_suites(
  proposal internal.factory_improvement_proposal_revisions, p_targeted uuid, p_holdout uuid
) returns void language plpgsql set search_path = '' as $$
declare
  source_count integer;
  member_count integer;
begin
  if not exists (select 1 from public.factory_benchmark_suite_revisions suite
    where (suite.workspace_id, suite.factory_id, suite.id, suite.purpose) =
      (proposal.workspace_id, proposal.factory_id, p_targeted, 'regression'))
    or not exists (select 1 from public.factory_benchmark_suite_revisions suite
    where (suite.workspace_id, suite.factory_id, suite.id, suite.purpose) =
      (proposal.workspace_id, proposal.factory_id, p_holdout, 'holdout')) then
    raise exception 'Select frozen targeted regression and held-out suites in this factory.' using errcode = 'PT422';
  end if;
  select count(distinct task.source_session_id), count(*) into source_count, member_count
  from public.factory_benchmark_suite_members member
  join public.factory_benchmark_tasks task using (workspace_id, factory_id)
  where (member.workspace_id, member.factory_id) = (proposal.workspace_id, proposal.factory_id)
    and member.suite_revision_id in (p_targeted, p_holdout) and member.task_id = task.id;
  if source_count <> member_count then
    raise exception 'The two suites must use distinct source sessions.' using errcode = 'PT422';
  end if;

  -- A source may be captured in more than one task revision. Detect prior
  -- exposure by the original session and exact configuration digest.
  if exists (
    select 1 from public.factory_benchmark_suite_members member
    join public.factory_benchmark_tasks task
      on (task.workspace_id, task.factory_id, task.id) = (member.workspace_id, member.factory_id, member.task_id)
    where (member.workspace_id, member.factory_id, member.suite_revision_id) =
      (proposal.workspace_id, proposal.factory_id, p_holdout) and (
      exists (select 1 from public.factory_benchmark_tasks prior_task
        join public.factory_benchmark_experiment_trials trial
          on (trial.workspace_id, trial.factory_id, trial.task_id) =
          (prior_task.workspace_id, prior_task.factory_id, prior_task.id)
        join public.factory_benchmark_experiment_candidates candidate
          on (candidate.workspace_id, candidate.factory_id, candidate.experiment_id, candidate.candidate_key) =
          (trial.workspace_id, trial.factory_id, trial.experiment_id, trial.candidate_key)
        where (prior_task.workspace_id, prior_task.factory_id, prior_task.source_session_id) =
          (task.workspace_id, task.factory_id, task.source_session_id)
          and candidate.definition_digest = proposal.candidate_digest)
      or exists (select 1 from internal.factory_improvement_proposals identity
        join internal.factory_diagnoses diagnosis
          on (diagnosis.workspace_id, diagnosis.factory_id, diagnosis.id) =
          (identity.workspace_id, identity.factory_id, identity.diagnosis_id)
        cross join lateral jsonb_array_elements(diagnosis.evidence) frozen(value)
        where (identity.workspace_id, identity.factory_id, identity.id) =
          (proposal.workspace_id, proposal.factory_id, proposal.proposal_id)
          and frozen.value->>'session_id' = task.source_session_id::text)
      or exists (select 1 from public.session_factory_admission_inputs admission
        where (admission.workspace_id, admission.factory_id, admission.session_id, admission.definition_digest) =
          (task.workspace_id, task.factory_id, task.source_session_id, proposal.candidate_digest))
      or exists (select 1 from public.factory_benchmark_task_inputs frozen
        left join public.factory_definition_revisions definition on (definition.workspace_id, definition.factory_id, definition.id) =
          (frozen.workspace_id, frozen.factory_id, frozen.definition_revision_id)
        where (frozen.workspace_id, frozen.factory_id, frozen.task_id) = (task.workspace_id, task.factory_id, task.id)
          and coalesce(frozen.definition_digest, definition.canonical_digest) = proposal.candidate_digest)
    )
  ) then raise exception 'Held-out source sessions were already used for the candidate or its diagnosis.' using errcode = 'PT422'; end if;
end;
$$;

create function internal.factory_improvement_validation_diagnosis_current(p_workspace_id uuid, p_factory_id uuid, p_proposal_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from internal.factory_improvement_proposals identity
    join internal.factory_diagnoses diagnosis on (diagnosis.workspace_id, diagnosis.factory_id, diagnosis.id) =
      (identity.workspace_id, identity.factory_id, identity.diagnosis_id)
    where (identity.workspace_id, identity.factory_id, identity.id) =
      (p_workspace_id, p_factory_id, p_proposal_id)
      and diagnosis.status = 'completed' and internal.factory_diagnosis_sources_current(diagnosis));
$$;

create function internal.factory_improvement_validation_split(
  validation internal.factory_improvement_validations, p_experiment_id uuid, p_targeted boolean
) returns jsonb language sql stable set search_path = '' as $$
  with draft as materialized (
    select revision.* from internal.factory_improvement_proposal_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.proposal_id, revision.id) =
      (validation.workspace_id, validation.factory_id, validation.proposal_id, validation.proposal_revision_id)
  ), experiment as materialized (
    select frozen.suite_revision_id, frozen.expected_trial_count,
      coalesce(schedule.state, 'unconfigured') as schedule_state,
      not exists (select 1 from internal.factory_benchmark_replay_revocations revoked
        where revoked.policy_revision_id = frozen.policy_revision_id)
      and exists (select 1 from internal.factory_benchmark_inference_connections connection
        where (connection.workspace_id, connection.factory_id, connection.id) =
          (frozen.workspace_id, frozen.factory_id, schedule.inference_connection_revision)
          and connection.revoked_at is null) as replay_authority_current
    from public.factory_benchmark_experiments frozen
    left join public.factory_benchmark_schedules schedule
      on (schedule.workspace_id, schedule.factory_id, schedule.experiment_id) = (frozen.workspace_id, frozen.factory_id, frozen.id)
    where (frozen.workspace_id, frozen.factory_id, frozen.id) =
      (validation.workspace_id, validation.factory_id, p_experiment_id)
  ), identities as materialized (
    select case when frozen.definition_revision_id = draft.base_revision_id then 'baseline' else 'candidate' end as arm,
      frozen.candidate_key
    from public.factory_benchmark_experiment_candidates frozen cross join draft
    where (frozen.workspace_id, frozen.factory_id, frozen.experiment_id) =
      (validation.workspace_id, validation.factory_id, p_experiment_id)
      and (frozen.definition_revision_id, frozen.definition_digest) in (
        (draft.base_revision_id, draft.base_digest), (draft.candidate_revision_id, draft.candidate_digest))
  ), current_inputs as materialized (
    select selected.task_id, pin.checkout_sha,
      owner.id is not null and input_run.id is not null and pin.checkout_sha is not null
        and not exists (select 1 from public.session_retained_content_erasures erasure
          where (erasure.workspace_id, erasure.factory_id, erasure.session_id) =
            (pin.workspace_id, pin.factory_id, pin.source_session_id))
        and internal.can_read_factory_benchmark_source(owner) as available
    from (
      select distinct grid.task_id from public.factory_benchmark_experiment_trials grid
      where (grid.workspace_id, grid.factory_id, grid.experiment_id) =
        (validation.workspace_id, validation.factory_id, p_experiment_id)
    ) selected
    left join public.factory_benchmark_task_inputs pin on (pin.workspace_id, pin.factory_id, pin.task_id) =
      (validation.workspace_id, validation.factory_id, selected.task_id)
    left join public.sessions owner on (owner.workspace_id, owner.factory_id, owner.id, owner.factory_definition_revision_id) =
      (pin.workspace_id, pin.factory_id, pin.source_session_id, pin.definition_revision_id)
      and owner.execution_purpose = 'production'
    left join public.agent_runs input_run on
      (input_run.workspace_id, input_run.session_id, input_run.id, input_run.agent_job_id, input_run.attempt_count) =
      (pin.workspace_id, pin.source_session_id, pin.source_run_id, pin.source_job_id, pin.source_attempt_count)
      and input_run.status in ('success','error','canceled') and input_run.finished_at is not null
  ), cells as materialized (
    select identity.arm, fact.trial_id, fact.task_revision_id, fact.candidate_key, fact.repetition, fact.seed, fact.timeout_ms,
      fact.eligibility, fact.open_work, fact.comparable, fact.verdict, fact.judge_signature, fact.cost_state, fact.measured_usd,
      task.source_session_id, duration.wall_runtime_ms, present.available,
      present.available and (fact.verdict is not null or failed.sealed) as resolved, failed.sealed as known_nonpass,
      coalesce(result.input_bundle_sha256, case when failed.sealed then binding.input_bundle_sha256 end) as input_bundle,
      coalesce(result.input_commit_sha, case when failed.sealed then source.checkout_sha end) as input_commit,
      result.input_tree_sha as input_tree
    from internal.factory_benchmark_frontier_trial_facts(validation.workspace_id,
      validation.factory_id, p_experiment_id, (validation.intent->>'scorerRevisionId')::uuid) fact
    join identities identity using (candidate_key)
    join public.factory_benchmark_experiment_trials grid on grid.trial_id = fact.trial_id
    join public.factory_benchmark_tasks task on (task.workspace_id, task.factory_id, task.id) =
      (grid.workspace_id, grid.factory_id, grid.task_id)
    join current_inputs source on source.task_id = task.id
    join internal.factory_benchmark_comparison_trial_facts(validation.workspace_id,
      validation.factory_id, p_experiment_id, statement_timestamp()) duration on duration.trial_id = fact.trial_id
    left join public.factory_benchmark_trials trial on (trial.workspace_id, trial.factory_id, trial.id, trial.run_id) =
      (validation.workspace_id, validation.factory_id, fact.trial_id, duration.run_id)
    left join public.factory_benchmark_trial_results result on
      (result.workspace_id, result.factory_id, result.trial_id, result.run_id, result.result_digest) =
      (validation.workspace_id, validation.factory_id, fact.trial_id, duration.run_id, duration.result_digest)
    left join internal.factory_benchmark_live_sandbox_bindings binding on binding.trial_id = trial.id
    left join public.factory_benchmark_replay_executions replay on
      (replay.workspace_id, replay.factory_id, replay.id, replay.task_id, replay.task_revision_id,
       replay.policy_revision_id, replay.policy_digest, replay.restoration_receipt_sha256) =
      (trial.workspace_id, trial.factory_id, trial.id, trial.task_id, trial.task_revision_id,
       trial.policy_revision_id, trial.policy_digest, binding.restoration_receipt_sha256)
    cross join lateral (
      select source.available and not exists (select 1 from public.session_retained_content_erasures erasure
        where (erasure.workspace_id, erasure.factory_id, erasure.session_id) =
          (trial.workspace_id, trial.factory_id, trial.session_id)) as available
    ) present
    cross join lateral (
      -- Failed runs do not publish an output tree. Only a comparable observed
      -- model on an exact ready replay can supply a hard nonpass.
      select fact.known_nonpass and duration.reason in ('candidate_failed','deadline_elapsed')
        and replay.id is not null and binding.ready_at is not null and binding.input_bundle_sha256 is not null
        and source.checkout_sha is not null as sealed
    ) failed
  ), pairs as materialized (
    select baseline.source_session_id, baseline.eligibility = 'eligible' and candidate.eligibility = 'eligible' as eligible,
      baseline.resolved and candidate.resolved and input.identity = 'matched' as resolved,
      (baseline.open_work or candidate.open_work) as open_work, baseline.available and candidate.available as available,
      input.identity,
      baseline.available and candidate.available and input.identity = 'matched' and baseline.verdict = 'pass'
        and (candidate.known_nonpass or (candidate.verdict = 'fail' and baseline.judge_signature = candidate.judge_signature))
        as regressed
    from cells baseline join cells candidate using (task_revision_id, repetition, seed, timeout_ms)
    cross join lateral (select case
      when num_nulls(baseline.input_bundle, baseline.input_commit, candidate.input_bundle, candidate.input_commit) <> 0
        then 'unknown'
      when (baseline.input_bundle, baseline.input_commit) <> (candidate.input_bundle, candidate.input_commit)
        or (baseline.input_tree is not null and candidate.input_tree is not null and baseline.input_tree <> candidate.input_tree)
        then 'mismatched'
      else 'matched' end as identity) input
    where baseline.arm = 'baseline' and candidate.arm = 'candidate'
  ), pair_counts as (
    select count(*) as planned, count(*) filter (where eligible) as eligible,
      count(*) filter (where eligible and resolved) as resolved,
      count(distinct source_session_id) filter (where eligible and resolved) as independent,
      count(*) filter (where eligible and regressed) as regressions,
      count(*) filter (where eligible and identity = 'matched') as matching,
      count(*) filter (where eligible and identity = 'mismatched') as mismatched,
      count(*) filter (where eligible and identity = 'unknown') as unproven,
      coalesce(bool_and(available), false) as sources_current,
      coalesce(bool_or(open_work) filter (where eligible), false) as open_work
    from pairs
  ), arms as (
    select identity.arm, identity.candidate_key, count(cell.trial_id) as planned,
      count(*) filter (where cell.eligibility = 'eligible') as eligible,
      count(*) filter (where cell.eligibility = 'eligible' and cell.resolved) as resolved,
      count(*) filter (where cell.eligibility = 'eligible' and cell.resolved and cell.verdict = 'pass') as passes,
      count(*) filter (where cell.eligibility = 'eligible' and cell.comparable and cell.cost_state = 'measured'
        and cell.measured_usd is not null and cell.available) as measured_costs,
      count(*) filter (where cell.eligibility = 'eligible' and cell.comparable and cell.wall_runtime_ms is not null
        and cell.available) as measured_latency,
      case when count(*) filter (where cell.eligibility = 'eligible' and cell.verdict is not null and cell.judge_signature is null) = 0
        and count(distinct cell.judge_signature) = 1 then max(cell.judge_signature) end as judge_signature,
      avg(cell.measured_usd) filter (where cell.eligibility = 'eligible' and cell.comparable and cell.cost_state = 'measured'
        and cell.available) as mean_cost,
      percentile_disc(0.95) within group (order by cell.wall_runtime_ms)
        filter (where cell.eligibility = 'eligible' and cell.comparable and cell.wall_runtime_ms is not null
          and cell.available) as p95_latency
    from identities identity left join cells cell using (arm, candidate_key)
    group by identity.arm, identity.candidate_key
  ), measured as materialized (
    select arm.*, round(passes * 10000::numeric / nullif(eligible, 0), 4) as pass_rate,
      jsonb_build_object('candidateKey', candidate_key, 'plannedTrials', planned, 'resolvedTrials', resolved,
        'passes', passes, 'measuredCostTrials', measured_costs, 'measuredLatencyTrials', measured_latency,
        'passRateBps', case when resolved = eligible then round(passes * 10000::numeric / nullif(eligible, 0), 4) end,
        'meanCostUsd', case when measured_costs = eligible then mean_cost end,
        'p95LatencyMs', case when measured_latency = eligible then p95_latency end) as summary
    from arms arm
  ), assessed as (
    select pairs.*, experiment.*, baseline.summary as baseline, candidate.summary as candidate,
      baseline.judge_signature,
      coalesce(round(pairs.resolved * 10000::numeric / nullif(pairs.planned, 0), 4), 0) as coverage,
      array_remove(array[
        case when pairs.regressions > 0 then 'known_regression' end,
        case when pairs.resolved = pairs.eligible and pairs.eligible > 0
          and baseline.judge_signature is not null and baseline.judge_signature = candidate.judge_signature
          and candidate.pass_rate < (validation.intent#>>'{thresholds,minimumCandidatePassRateBps}')::numeric
          then 'quality_below_floor' end,
        case when pairs.resolved = pairs.eligible and pairs.eligible > 0
          and baseline.judge_signature is not null and baseline.judge_signature = candidate.judge_signature
          and baseline.pass_rate - candidate.pass_rate > (validation.intent#>>'{thresholds,maxPassRateDropBps}')::numeric
          then 'quality_regression' end,
        case when pairs.matching = pairs.eligible and pairs.sources_current
          and baseline.measured_costs = pairs.eligible and candidate.measured_costs = pairs.eligible
          and candidate.mean_cost * 10000 > baseline.mean_cost *
            (10000 + (validation.intent#>>'{thresholds,maxMeanCostIncreaseBps}')::numeric) then 'cost_regression' end,
        case when pairs.matching = pairs.eligible and pairs.sources_current
          and baseline.measured_latency = pairs.eligible and candidate.measured_latency = pairs.eligible
          and candidate.p95_latency * 10000::numeric > baseline.p95_latency *
            (10000 + (validation.intent#>>'{thresholds,maxP95LatencyIncreaseBps}')::numeric) then 'latency_regression' end
      ], null) as failures,
      array_remove(array[
        case when 2 * pairs.planned <> experiment.expected_trial_count or pairs.eligible = 0
          or baseline.planned <> pairs.planned or candidate.planned <> pairs.planned
          or baseline.eligible <> pairs.eligible or candidate.eligible <> pairs.eligible then 'incomplete_grid' end,
        case when pairs.independent < (validation.intent#>>'{thresholds,minimumIndependentTasks}')::integer
          then 'insufficient_independent_tasks' end,
        case when pairs.resolved * 10000::numeric < pairs.planned *
          (validation.intent#>>'{thresholds,minimumCoverageBps}')::numeric then 'insufficient_coverage' end,
        case when not pairs.sources_current then 'source_unavailable' end,
        case when not experiment.replay_authority_current then 'replay_authority_unavailable' end,
        case when pairs.unproven > 0 then 'unproven_input_identity' end,
        case when pairs.mismatched > 0 then 'mismatched_input_identity' end,
        case when pairs.open_work then 'pending_work' end,
        case when experiment.schedule_state = 'canceled' then 'schedule_canceled' end,
        case when pairs.resolved <> pairs.eligible or pairs.eligible = 0 then 'unknown_quality' end,
        case when baseline.judge_signature is null or baseline.judge_signature is distinct from candidate.judge_signature
          then 'incomparable_judges' end,
        case when baseline.measured_costs <> pairs.eligible or candidate.measured_costs <> pairs.eligible
          or pairs.eligible = 0 then 'unknown_cost' end,
        case when baseline.measured_latency <> pairs.eligible or candidate.measured_latency <> pairs.eligible
          or pairs.eligible = 0 then 'unknown_latency' end,
        case when p_targeted and not coalesce(candidate.pass_rate > baseline.pass_rate
          or candidate.mean_cost < baseline.mean_cost or candidate.p95_latency < baseline.p95_latency, false)
          then 'no_observed_improvement' end
      ], null) as limits
    from pair_counts pairs cross join experiment
    join measured baseline on baseline.arm = 'baseline'
    join measured candidate on candidate.arm = 'candidate'
  )
  select jsonb_build_object('suiteRevisionId', suite_revision_id, 'experimentId', p_experiment_id,
    'scheduleState', schedule_state,
    'status', case when cardinality(failures) > 0 then 'failed'
      when cardinality(limits) > 0 then 'inconclusive' else 'qualified' end,
    'reasons', failures || limits, 'independentTasks', independent, 'plannedPairs', planned,
    'resolvedPairs', resolved, 'coverageBps', coverage, 'regressions', regressions,
    'baseline', baseline, 'candidate', candidate, 'judgeSignature', judge_signature)
  from assessed;
$$;

create function internal.project_factory_improvement_validation(validation internal.factory_improvement_validations)
returns jsonb language sql stable set search_path = '' as $$
  with draft as materialized (
    select revision.* from internal.factory_improvement_proposal_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.proposal_id, revision.id) =
      (validation.workspace_id, validation.factory_id, validation.proposal_id, validation.proposal_revision_id)
  ), evidence as materialized (
    select internal.factory_improvement_validation_split(validation, validation.targeted_experiment_id, true) as targeted,
      internal.factory_improvement_validation_split(validation, validation.holdout_experiment_id, false) as holdout
  ), currentness as (
    select array_remove(array[
      case when exists (select 1 from internal.factory_improvement_proposal_revisions later
        where (later.workspace_id, later.factory_id, later.proposal_id) =
          (draft.workspace_id, draft.factory_id, draft.proposal_id) and later.revision_number > draft.revision_number)
        then 'stale_proposal' end,
      case when internal.current_factory_improvement_base(draft.workspace_id, draft.factory_id) is distinct from draft.intent->'base'
        then 'stale_base' end,
      case when not exists (select 1 from public.factories current_factory
        where (current_factory.workspace_id, current_factory.id, current_factory.status) =
          (draft.workspace_id, draft.factory_id, 'active')) then 'factory_unavailable' end
    ], null) as stale, internal.factory_improvement_validation_diagnosis_current(draft.workspace_id, draft.factory_id, draft.proposal_id) as diagnosis_current
    from draft
  )
  select jsonb_build_object(
    'id', validation.id, 'proposalId', validation.proposal_id, 'proposalRevisionId', validation.proposal_revision_id,
    'requestId', validation.request_id, 'createdAt', validation.created_at, 'authorMemberId', validation.author_member_id,
    'asOf', statement_timestamp(), 'base', draft.intent->'base',
    'candidate', jsonb_build_object('revisionId', draft.candidate_revision_id, 'digest', draft.candidate_digest),
    'policyRevisionId', validation.intent->'policyRevisionId', 'scorerRevisionId', validation.intent->'scorerRevisionId',
    'thresholds', validation.intent->'thresholds', 'execution', validation.intent->'execution', 'axes', validation.intent->'axes',
    'status', case when cardinality(currentness.stale) > 0 then 'stale'
      when not currentness.diagnosis_current then 'inconclusive'
      when evidence.targeted->>'status' = 'failed' or evidence.holdout->>'status' = 'failed' then 'failed'
      when evidence.targeted->>'status' = 'qualified' and evidence.holdout->>'status' = 'qualified'
        and evidence.targeted->>'judgeSignature' = evidence.holdout->>'judgeSignature' then 'qualified'
      else 'inconclusive' end,
    'reasons', to_jsonb(currentness.stale) || (select coalesce(jsonb_agg(distinct reason order by reason), '[]'::jsonb)
      from (
        select value as reason from jsonb_array_elements_text(evidence.targeted->'reasons')
        union all select value from jsonb_array_elements_text(evidence.holdout->'reasons')
        union all select 'diagnosis_evidence_unavailable' where not currentness.diagnosis_current
        union all select 'incomparable_judges_across_suites'
        where evidence.targeted->>'judgeSignature' is not null and evidence.holdout->>'judgeSignature' is not null
          and evidence.targeted->>'judgeSignature' <> evidence.holdout->>'judgeSignature'
      ) notes),
    'targeted', evidence.targeted - 'judgeSignature', 'holdout', evidence.holdout - 'judgeSignature')
  from draft cross join evidence cross join currentness;
$$;

create function public.start_factory_improvement_validation(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_proposal_id uuid, p_proposal_revision_id uuid,
  p_request_id uuid, p_targeted_suite_revision_id uuid, p_holdout_suite_revision_id uuid, p_policy_revision_id uuid,
  p_scorer_revision_id uuid, p_targeted_candidates jsonb, p_holdout_candidates jsonb, p_execution jsonb, p_thresholds jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  proposal internal.factory_improvement_proposal_revisions;
  validation internal.factory_improvement_validations;
  actor uuid;
  request_intent jsonb;
  targeted_id uuid := gen_random_uuid();
  holdout_id uuid := gen_random_uuid();
  evaluation_plan jsonb;
  execution_fields text[] := array['repetitions','seed','timeoutMs','inferenceConnectionRevision',
    'executionReserveUsd','evaluationReserveUsd','evaluationBudgetLimitUsd','targetedBudgetLimitUsd','holdoutBudgetLimitUsd',
    'factoryConcurrencyLimit','maxAdmittedTrials'];
  threshold_fields text[] := array['minimumIndependentTasks','minimumCoverageBps','minimumCandidatePassRateBps',
    'maxPassRateDropBps','maxMeanCostIncreaseBps','maxP95LatencyIncreaseBps'];
  scorer_family uuid;
  scorer_definition jsonb;
  experiment_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  actor := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if num_nulls(p_proposal_id, p_proposal_revision_id, p_request_id, p_targeted_suite_revision_id,
      p_holdout_suite_revision_id, p_policy_revision_id, p_scorer_revision_id) <> 0
    or jsonb_typeof(p_targeted_candidates) is distinct from 'array'
    or jsonb_typeof(p_holdout_candidates) is distinct from 'array'
    or jsonb_typeof(p_execution) is distinct from 'object' or not (p_execution ?& execution_fields)
    or p_execution - execution_fields <> '{}'::jsonb
    or jsonb_typeof(p_thresholds) is distinct from 'object' or not (p_thresholds ?& threshold_fields)
    or p_thresholds - threshold_fields <> '{}'::jsonb then
    raise exception 'Provide exact proposal validation inputs.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_targeted_candidates) <> 2 or p_targeted_candidates is distinct from p_holdout_candidates
    or not coalesce(pg_input_is_valid(p_execution->>'inferenceConnectionRevision', 'uuid'), false)
    or exists (select 1 from unnest(execution_fields) key where case
      when key = 'inferenceConnectionRevision' then jsonb_typeof(p_execution->key) <> 'string'
      when key in ('repetitions','seed','timeoutMs','factoryConcurrencyLimit','maxAdmittedTrials') then
        jsonb_typeof(p_execution->key) <> 'number' or not coalesce(pg_input_is_valid(p_execution->>key, 'integer'), false)
      else jsonb_typeof(p_execution->key) <> 'number' end)
    or exists (select 1 from (values ('minimumIndependentTasks',2,500), ('minimumCoverageBps',1,10000),
        ('minimumCandidatePassRateBps',0,10000), ('maxPassRateDropBps',0,10000),
        ('maxMeanCostIncreaseBps',0,100000), ('maxP95LatencyIncreaseBps',0,100000)) bounds(key, low, high)
      where case when jsonb_typeof(p_thresholds->key) <> 'number'
        or not coalesce(pg_input_is_valid(p_thresholds->>key, 'integer'), false) then true
        else (p_thresholds->>key)::integer not between low and high end) then
    raise exception 'Provide the same candidate pair and valid reviewed thresholds for both suites.' using errcode = '22023';
  end if;

  request_intent := jsonb_build_object('targetedSuiteRevisionId', p_targeted_suite_revision_id,
    'holdoutSuiteRevisionId', p_holdout_suite_revision_id, 'policyRevisionId', p_policy_revision_id,
    'scorerRevisionId', p_scorer_revision_id, 'axes', p_targeted_candidates, 'execution', p_execution, 'thresholds', p_thresholds);
  select * into validation from internal.factory_improvement_validations saved
  where (saved.workspace_id, saved.factory_id, saved.request_id) = (p_workspace_id, p_factory_id, p_request_id);
  if found then
    if (validation.proposal_id, validation.proposal_revision_id, validation.author_member_id, validation.intent)
      is distinct from (p_proposal_id, p_proposal_revision_id, actor, request_intent) then
      raise exception 'This validation request already refers to different inputs.' using errcode = 'PT409';
    end if;
    return jsonb_build_object('validation', internal.project_factory_improvement_validation(validation), 'replay', true);
  end if;

  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  select * into proposal from internal.factory_improvement_proposal_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.proposal_id) = (p_workspace_id, p_factory_id, p_proposal_id)
  order by revision.revision_number desc limit 1;
  if not found then raise exception 'Improvement proposal is unavailable.' using errcode = 'P0002'; end if;
  if proposal.id is distinct from p_proposal_revision_id
    or internal.current_factory_improvement_base(p_workspace_id, p_factory_id) is distinct from proposal.intent->'base' then
    raise exception 'The proposal revision or its active base changed. Reload before validating.' using errcode = 'PT409';
  end if;
  if proposal.candidate_revision_id is null or proposal.candidate_digest = proposal.base_digest
    or p_targeted_candidates#>>'{0,definitionRevisionId}' is distinct from proposal.base_revision_id::text
    or p_targeted_candidates#>>'{1,definitionRevisionId}' is distinct from proposal.candidate_revision_id::text
    or p_targeted_candidates#>>'{0,workerRuntime}' is distinct from 'workerd'
    or p_targeted_candidates#>>'{1,workerRuntime}' is distinct from 'workerd' then
    raise exception 'Select the exact compiled baseline and candidate with Workerd qualification.' using errcode = 'PT422';
  end if;
  if exists (select 1 from internal.factory_improvement_validations saved
    where (saved.workspace_id, saved.factory_id, saved.proposal_id, saved.proposal_revision_id) =
      (p_workspace_id, p_factory_id, p_proposal_id, p_proposal_revision_id)) then
    raise exception 'This revision already has a frozen validation decision.' using errcode = 'PT409';
  end if;
  select scorer.scorer_id, scorer.definition into scorer_family, scorer_definition
  from public.factory_scorer_revisions scorer
  where (scorer.workspace_id, scorer.factory_id, scorer.id) = (p_workspace_id, p_factory_id, p_scorer_revision_id);
  if not found or exists (select 1 from jsonb_array_elements(proposal.intent->'edits') edit
    where edit->>'kind' = 'scorer_revision' and edit->>'scorerId' = scorer_family::text) then
    raise exception 'Select a neutral scorer revision outside the proposal’s scorer changes.' using errcode = 'PT422';
  end if;
  if not (scorer_definition->'requiredEvidence' <@ '["artifact","validation_report"]') then
    raise exception 'The selected scorer requires evidence that benchmark trials do not provide.' using errcode = 'PT422';
  end if;
  if (p_execution->>'evaluationReserveUsd')::numeric <= 0
    or (p_execution->>'evaluationBudgetLimitUsd')::numeric < (p_execution->>'evaluationReserveUsd')::numeric then
    raise exception 'Provide a positive evaluation reserve and sufficient evaluation budget.' using errcode = '22023';
  end if;
  if not internal.factory_improvement_validation_diagnosis_current(p_workspace_id, p_factory_id, p_proposal_id) then
    raise exception 'Current diagnosis evidence is required to validate this proposal.' using errcode = 'PT422';
  end if;
  perform internal.assert_factory_improvement_validation_suites(proposal, p_targeted_suite_revision_id, p_holdout_suite_revision_id);
  evaluation_plan := jsonb_build_object('scorerRevisionIds', jsonb_build_array(p_scorer_revision_id),
    'budgetLimitUsd', p_execution->'evaluationBudgetLimitUsd');

  perform public.freeze_factory_benchmark_experiment_axes_with_evaluation(p_workspace_id, p_factory_id, p_actor_user_id,
    targeted_id, p_targeted_suite_revision_id, p_policy_revision_id, p_targeted_candidates,
    (p_execution->>'repetitions')::integer, (p_execution->>'seed')::integer, (p_execution->>'timeoutMs')::integer, evaluation_plan);
  perform public.freeze_factory_benchmark_experiment_axes_with_evaluation(p_workspace_id, p_factory_id, p_actor_user_id,
    holdout_id, p_holdout_suite_revision_id, p_policy_revision_id, p_holdout_candidates,
    (p_execution->>'repetitions')::integer, (p_execution->>'seed')::integer, (p_execution->>'timeoutMs')::integer, evaluation_plan);

  if (select count(*) from public.factory_benchmark_experiment_candidates frozen
    where (frozen.workspace_id, frozen.factory_id) = (p_workspace_id, p_factory_id)
      and frozen.experiment_id in (targeted_id, holdout_id)
      and (frozen.definition_revision_id, frozen.definition_digest) in (
        (proposal.base_revision_id, proposal.base_digest), (proposal.candidate_revision_id, proposal.candidate_digest))) <> 4 then
    raise exception 'Both experiments must freeze the proposal’s exact revision pair.' using errcode = 'PT422';
  end if;
  insert into internal.factory_improvement_validations(workspace_id, factory_id, proposal_id, proposal_revision_id, request_id,
    author_member_id, targeted_experiment_id, holdout_experiment_id, intent)
  values (p_workspace_id, p_factory_id, p_proposal_id, p_proposal_revision_id, p_request_id, actor, targeted_id, holdout_id, request_intent)
  returning * into validation;

  foreach experiment_id in array array[targeted_id, holdout_id] loop
    perform public.configure_factory_benchmark_live_schedule(p_workspace_id, p_factory_id, experiment_id, p_actor_user_id,
      (p_execution->>'inferenceConnectionRevision')::uuid, (p_execution->>'executionReserveUsd')::numeric,
      (p_execution->>'evaluationReserveUsd')::numeric,
      (p_execution->>case when experiment_id = targeted_id then 'targetedBudgetLimitUsd' else 'holdoutBudgetLimitUsd' end)::numeric,
      (p_execution->>'factoryConcurrencyLimit')::integer, (p_execution->>'maxAdmittedTrials')::integer);
  end loop;
  return jsonb_build_object('validation', internal.project_factory_improvement_validation(validation), 'replay', false);
end;
$$;

create function public.get_factory_improvement_validation(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_proposal_id uuid, p_proposal_revision_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  if internal.factory_benchmark_comparison_manager(p_workspace_id, p_factory_id, p_actor_user_id) is null then
    raise exception 'Factory improvement validation is unavailable.' using errcode = '42501';
  end if;
  return (select internal.project_factory_improvement_validation(validation)
    from internal.factory_improvement_validations validation
    where (validation.workspace_id, validation.factory_id, validation.proposal_id, validation.proposal_revision_id) =
      (p_workspace_id, p_factory_id, p_proposal_id, p_proposal_revision_id));
end;
$$;

revoke all on function
  internal.assert_factory_improvement_validation_suites(internal.factory_improvement_proposal_revisions, uuid, uuid),
  internal.factory_improvement_validation_diagnosis_current(uuid, uuid, uuid),
  internal.factory_improvement_validation_split(internal.factory_improvement_validations, uuid, boolean),
  internal.project_factory_improvement_validation(internal.factory_improvement_validations),
  public.start_factory_improvement_validation(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb),
  public.get_factory_improvement_validation(uuid,uuid,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.start_factory_improvement_validation(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb),
  public.get_factory_improvement_validation(uuid,uuid,uuid,uuid,uuid)
  to service_role;
