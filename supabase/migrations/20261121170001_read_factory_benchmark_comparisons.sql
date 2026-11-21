create function internal.factory_benchmark_comparison_counts(
  p_planned bigint, p_eligible bigint, p_excluded bigint, p_admitted bigint, p_started bigint,
  p_pending bigint, p_running bigint, p_succeeded bigint, p_failed bigint, p_timed_out bigint, p_canceled bigint,
  p_unavailable bigint
) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'planned', p_planned, 'eligible', p_eligible, 'excluded', p_excluded, 'admitted', p_admitted, 'started', p_started,
    'pending', p_pending, 'running', p_running, 'succeeded', p_succeeded, 'failed', p_failed, 'timedOut', p_timed_out,
    'canceled', p_canceled, 'unavailable', p_unavailable,
    'terminal', p_succeeded + p_failed + p_timed_out + p_canceled + p_unavailable
  );
$$;

-- Detail and export read the same statement snapshot. In particular, derive
-- terminal costs from their exact immutable receipts even if the scheduler
-- has not yet replaced the reservation with that receipt's known cost.
create function internal.factory_benchmark_comparison_projection(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_as_of timestamptz,
  p_after_trial_id uuid, p_limit integer, p_after_candidate_key text, p_candidate_limit integer
) returns jsonb language sql stable set search_path = '' as $$
  with header as materialized (
    select experiment.*, suite.suite_id, suite.revision_number as suite_revision_number, suite.name as suite_name,
      coalesce(schedule.state, 'unconfigured') as schedule_state, schedule.evaluation_reserve_usd,
      evaluation_plan.budget_limit_usd as evaluation_budget_limit_usd
    from public.factory_benchmark_experiments experiment
    join public.factory_benchmark_suite_revisions suite on (suite.workspace_id, suite.factory_id, suite.id) =
      (experiment.workspace_id, experiment.factory_id, experiment.suite_revision_id)
    left join public.factory_benchmark_schedules schedule on (schedule.workspace_id, schedule.factory_id, schedule.experiment_id) =
      (experiment.workspace_id, experiment.factory_id, experiment.id)
    left join public.factory_benchmark_evaluation_plans evaluation_plan
      on (evaluation_plan.workspace_id, evaluation_plan.factory_id, evaluation_plan.experiment_id) =
        (experiment.workspace_id, experiment.factory_id, experiment.id)
    where (experiment.workspace_id, experiment.factory_id, experiment.id) = (p_workspace_id, p_factory_id, p_experiment_id)
  ), candidates as materialized (
    select candidate.* from public.factory_benchmark_experiment_candidates candidate
    where (candidate.workspace_id, candidate.factory_id, candidate.experiment_id) = (p_workspace_id, p_factory_id, p_experiment_id)
  ), candidate_page as materialized (
    select candidate.* from candidates candidate
    where p_after_candidate_key is null or (coalesce(candidate.comparison_position, 101), candidate.candidate_key) >
      (select coalesce(cursor.comparison_position, 101), cursor.candidate_key
        from candidates cursor where cursor.candidate_key = p_after_candidate_key)
    order by candidate.comparison_position nulls last, candidate.candidate_key
    limit case when p_candidate_limit is not null then p_candidate_limit + 1 end
  ), visible_candidates as materialized (
    select * from candidate_page order by comparison_position nulls last, candidate_key limit p_candidate_limit
  ), candidate_boundary as (
    select candidate_key from visible_candidates
    where p_candidate_limit is not null and (select count(*) from candidate_page) > p_candidate_limit
    order by comparison_position desc nulls first, candidate_key desc limit 1
  ), scorers as materialized (
    select revision.id, revision.scorer_id, revision.revision_number, scorer.name, revision.definition
    from public.factory_benchmark_evaluation_dimensions selected
    join public.factory_scorer_revisions revision on (revision.workspace_id, revision.factory_id, revision.id) =
      (selected.workspace_id, selected.factory_id, selected.scorer_revision_id)
    join public.factory_scorers scorer on (scorer.workspace_id, scorer.factory_id, scorer.id) =
      (revision.workspace_id, revision.factory_id, revision.scorer_id)
    where (selected.workspace_id, selected.factory_id, selected.experiment_id) = (p_workspace_id, p_factory_id, p_experiment_id)
  ), trials as materialized (
    select facts.*, coalesce(facts.candidate_position, 101) as sort_position
    from internal.factory_benchmark_comparison_trial_facts(p_workspace_id, p_factory_id, p_experiment_id, p_as_of) facts
  ), outcomes as materialized (
    select trial.trial_id, trial.candidate_key, scorer.id as scorer_revision_id,
      case
        when job.job_status = 'canceled' then 'skipped'
        when job.job_status in ('succeeded','failed') then case
          when latest.block_reason is not null or latest.reason in ('evidence_unavailable','profile_unavailable') then 'unavailable'
          else coalesce(latest.status,'unavailable') end
        when trial.disposition in ('failed','timed_out','unavailable') then 'unavailable'
        when trial.disposition = 'canceled' or header.schedule_state = 'canceled' then 'skipped'
        when trial.disposition <> 'succeeded' then 'pending'
        when output.trial_id is null then 'unavailable'
        when jsonb_array_length(internal.factory_benchmark_evaluation_evidence(output, scorer.definition, false))
          <> jsonb_array_length(scorer.definition->'requiredEvidence') then 'unavailable'
        when header.evaluation_budget_limit_usd = 0 or header.evaluation_reserve_usd = 0 then 'unavailable'
        else 'pending'
      end as status,
      case
        when job.job_status = 'canceled' then coalesce(latest.block_reason, latest.reason, 'canceled')
        when job.job_status in ('succeeded','failed') then coalesce(latest.block_reason, latest.reason,
          case when latest.attempt_id is null then 'receipt_unavailable' end)
        when trial.disposition in ('failed','timed_out','unavailable','canceled') then trial.reason
        when header.schedule_state = 'canceled' then 'schedule_canceled'
        when trial.disposition <> 'succeeded' then coalesce(trial.reason, 'trial_running')
        when output.trial_id is null then 'trial_result_unavailable'
        when jsonb_array_length(internal.factory_benchmark_evaluation_evidence(output, scorer.definition, false))
          <> jsonb_array_length(scorer.definition->'requiredEvidence') then 'missing_evidence'
        when header.evaluation_budget_limit_usd = 0 or header.evaluation_reserve_usd = 0 then 'evaluation_budget_exhausted'
        when header.schedule_state = 'paused' then 'schedule_paused'
        when job.job_status = 'claimed' then 'evaluation_running'
        when job.job_status = 'queued' then 'evaluation_queued'
        else 'evaluation_not_admitted'
      end as reason,
      latest.attempt_id, latest.score
    from trials trial cross join scorers scorer cross join header
    left join internal.factory_benchmark_evaluation_outputs output
      on (output.workspace_id, output.factory_id, output.experiment_id, output.trial_id, output.run_id, output.result_digest) =
        (p_workspace_id, p_factory_id, p_experiment_id, trial.trial_id, trial.run_id, trial.result_digest)
    left join internal.factory_benchmark_comparison_evaluation_jobs(p_workspace_id, p_factory_id, p_experiment_id) job
      on (job.trial_id, job.scorer_revision_id) = (trial.trial_id, scorer.id)
    left join lateral (
      select receipt.attempt_id, receipt.status, receipt.reason, blocked.reason as block_reason, receipt.result->'score' as score
      from public.factory_evaluation_receipts receipt
      left join internal.factory_benchmark_evaluation_blocks blocked on blocked.attempt_id = receipt.attempt_id
      where (receipt.workspace_id, receipt.factory_id, receipt.job_id, receipt.sample_receipt_id, receipt.run_id,
        receipt.scorer_revision_id, receipt.target_commit_sha) =
        (p_workspace_id, p_factory_id, job.job_id, job.sample_receipt_id, job.run_id, job.scorer_revision_id, job.target_commit_sha)
      order by receipt.attempt_number desc limit 1
    ) latest on job.job_status in ('succeeded','failed','canceled')
    where trial.eligibility = 'eligible'
  ), cost_rows as materialized (
    select trial.trial_id, trial.candidate_key, 'execution'::text as phase, trial.execution_provenance as provenance,
      trial.execution_actual_usd as actual_usd, trial.execution_reserved_usd as reserved_usd
    from trials trial where trial.execution_provenance is not null
    union all
    select cost.trial_id, cost.candidate_key, 'evaluation', cost.provenance, cost.actual_usd, cost.reserved_usd
    from internal.factory_benchmark_comparison_evaluation_costs(p_workspace_id, p_factory_id, p_experiment_id) cost
  ), cost_rollup as (
    select candidate_key, trial_id, phase,
      internal.factory_benchmark_comparison_cost_bucket(
        coalesce(sum(actual_usd) filter (where provenance = 'measured'), 0),
        coalesce(sum(actual_usd) filter (where provenance = 'estimated'), 0),
        coalesce(sum(reserved_usd), 0), coalesce(sum(reserved_usd) filter (where provenance = 'unavailable'), 0),
        count(*) filter (where provenance = 'measured'), count(*) filter (where provenance = 'estimated'),
        count(*) filter (where provenance = 'unavailable'), count(*) filter (where provenance = 'pending'),
        count(*) filter (where provenance = 'never_started')
      ) as bucket,
      count(distinct trial_id) filter (where provenance = 'unavailable') as unknown_trial_count
    from cost_rows group by grouping sets ((candidate_key, phase), (trial_id, phase), (phase), (candidate_key), (trial_id), ())
  ), spend as (
    select candidate_key, trial_id, internal.factory_benchmark_comparison_spend(
      (jsonb_agg(bucket) filter (where phase = 'execution'))->0,
      (jsonb_agg(bucket) filter (where phase = 'evaluation'))->0,
      (jsonb_agg(bucket) filter (where phase is null))->0,
      max(unknown_trial_count) filter (where phase is null)
    ) as value
    from cost_rollup group by candidate_key, trial_id
  ), counts as (
    select candidate_key, internal.factory_benchmark_comparison_counts(
      count(*), count(*) filter (where eligibility = 'eligible'), count(*) filter (where disposition = 'excluded'),
      count(*) filter (where admitted), count(*) filter (where started),
      count(*) filter (where disposition = 'pending'), count(*) filter (where disposition = 'running'),
      count(*) filter (where disposition = 'succeeded'), count(*) filter (where disposition = 'failed'),
      count(*) filter (where disposition = 'timed_out'), count(*) filter (where disposition = 'canceled'),
      count(*) filter (where disposition = 'unavailable')
    ) as value, jsonb_build_object(
      'sampleCount', count(wall_runtime_ms), 'medianMs', percentile_cont(0.5) within group (order by wall_runtime_ms),
      'p95Ms', percentile_cont(0.95) within group (order by wall_runtime_ms)
    ) as latency
    from trials group by grouping sets ((candidate_key), ())
  ), quality as (
    select candidate.candidate_key, scorer.id as scorer_revision_id,
      jsonb_build_object('scorerRevisionId', scorer.id, 'denominator', count(outcome.trial_id),
        'pending', count(*) filter (where outcome.status = 'pending'), 'pass', count(*) filter (where outcome.status = 'pass'),
        'fail', count(*) filter (where outcome.status = 'fail'), 'inconclusive', count(*) filter (where outcome.status = 'inconclusive'),
        'skipped', count(*) filter (where outcome.status = 'skipped'), 'error', count(*) filter (where outcome.status = 'error'),
        'unavailable', count(*) filter (where outcome.status = 'unavailable')) as value
    from visible_candidates candidate cross join scorers scorer
    left join outcomes outcome on (outcome.candidate_key, outcome.scorer_revision_id) = (candidate.candidate_key, scorer.id)
    group by candidate.candidate_key, scorer.id
  ), positioned as materialized (
    select trial.* from trials trial
    where p_after_trial_id is null or (trial.sort_position, trial.candidate_key, trial.trial_id) >
      (select cursor.sort_position, cursor.candidate_key, cursor.trial_id from trials cursor where cursor.trial_id = p_after_trial_id)
    order by trial.sort_position, trial.candidate_key, trial.trial_id limit case when p_limit is not null then p_limit + 1 end
  ), visible as materialized (
    select * from positioned order by sort_position, candidate_key, trial_id limit p_limit
  ), boundary as (
    select trial_id from visible where p_limit is not null and (select count(*) from positioned) > p_limit
    order by sort_position desc, candidate_key desc, trial_id desc limit 1
  ), row_scores as (
    select outcome.trial_id, jsonb_agg(jsonb_build_object('scorerRevisionId', outcome.scorer_revision_id,
      'status', outcome.status, 'reason', outcome.reason, 'attemptId', outcome.attempt_id, 'score', outcome.score)
      order by outcome.scorer_revision_id) as value
    from outcomes outcome join visible using (trial_id)
    group by outcome.trial_id
  ), rows as (
    select trial.sort_position, trial.candidate_key, trial.trial_id, jsonb_build_object(
      'trialId', trial.trial_id, 'task', jsonb_build_object('id', trial.task_id, 'revisionId', trial.task_revision_id,
        'revisionNumber', trial.task_revision_number, 'name', trial.task_name),
      'candidateKey', trial.candidate_key, 'repetition', trial.repetition, 'seed', trial.seed, 'timeoutMs', trial.timeout_ms,
      'eligibility', trial.eligibility, 'eligibilityReason', trial.eligibility_reason, 'status', trial.disposition, 'reason', trial.reason,
      'admitted', trial.admitted, 'started', trial.started, 'runId', trial.run_id, 'startedAt', trial.started_at,
      'finishedAt', trial.finished_at, 'deadlineAt', trial.deadline_at, 'wallRuntimeMs', trial.wall_runtime_ms,
      'deadlineElapsed', trial.deadline_elapsed, 'resultDigest', trial.result_digest,
      'actualRunner', case when trial.runner_revision is not null then jsonb_build_object('runnerRevision', trial.runner_revision,
        'workerRuntime', trial.actual_runtime, 'modelProvider', trial.model_provider, 'modelName', trial.model_name) end,
      'spend', coalesce(spend.value, internal.factory_benchmark_comparison_spend()),
      'scores', coalesce(row_scores.value, '[]'::jsonb)
    ) as item from visible trial
    left join spend on spend.trial_id = trial.trial_id
    left join row_scores on row_scores.trial_id = trial.trial_id
  )
  select jsonb_build_object(
    'experimentId', header.id, 'createdAt', header.created_at,
    'suite', jsonb_build_object('id', header.suite_id, 'revisionId', header.suite_revision_id,
      'revisionNumber', header.suite_revision_number, 'name', header.suite_name),
    'policyRevisionId', header.policy_revision_id, 'policyDigest', header.policy_digest,
    'repetitions', header.repetitions, 'seed', header.seed, 'timeoutMs', header.timeout_ms,
    'scheduleState', header.schedule_state, 'counts', counts.value, 'spend', spend.value, 'candidateCount', header.candidate_count,
    'scorers', coalesce((select jsonb_agg(jsonb_build_object('id', scorer.id, 'scorerId', scorer.scorer_id,
      'revisionNumber', scorer.revision_number, 'name', scorer.name,
      'definitionDigest', encode(sha256(convert_to(scorer.definition::text, 'UTF8')), 'hex')) order by scorer.id)
      from scorers scorer), '[]'::jsonb),
    'candidates', coalesce((select jsonb_agg(jsonb_build_object(
      'candidateKey', candidate.candidate_key, 'position', candidate.comparison_position,
      'definitionRevisionId', candidate.definition_revision_id, 'definitionDigest', candidate.definition_digest,
      'qualificationId', candidate.qualification_id, 'plannedHarness', candidate.harness, 'plannedModel', candidate.model,
      'plannedRuntime', candidate.worker_runtime, 'sandboxProvider', candidate.sandbox_provider,
      'canonicalModelKey', candidate.canonical_model_key, 'toolchain', candidate.toolchain, 'toolchainDigest', candidate.toolchain_digest,
      'sandboxConnectionRevision', candidate.sandbox_connection_revision,
      'counts', candidate_counts.value, 'spend', coalesce(candidate_spend.value, internal.factory_benchmark_comparison_spend()),
      'latency', candidate_counts.latency,
      'quality', coalesce((select jsonb_agg(dimension.value order by dimension.scorer_revision_id) from quality dimension
        where dimension.candidate_key = candidate.candidate_key), '[]'::jsonb)
    ) order by candidate.comparison_position nulls last, candidate.candidate_key)
    from visible_candidates candidate join counts candidate_counts using (candidate_key)
    left join spend candidate_spend on candidate_spend.candidate_key = candidate.candidate_key and candidate_spend.trial_id is null), '[]'::jsonb),
    'nextCandidateCursor', (select jsonb_build_object('candidateKey', candidate_key) from candidate_boundary),
    'trialRows', coalesce((select jsonb_agg(item order by sort_position, candidate_key, trial_id) from rows), '[]'::jsonb),
    'nextCursor', (select jsonb_build_object('trialId', trial_id) from boundary)
  )
  from header join counts on counts.candidate_key is null
  join spend on spend.candidate_key is null and spend.trial_id is null;
$$;

create function public.read_factory_benchmark_comparison(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_actor_user_id uuid,
  p_after_trial_id uuid default null, p_limit integer default 50,
  p_after_candidate_key text default null, p_candidate_limit integer default 50
) returns jsonb language plpgsql stable security definer set search_path = '' set timezone = 'UTC' as $$
declare result jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if internal.factory_benchmark_comparison_manager(p_workspace_id,p_factory_id,p_actor_user_id) is null
  then raise exception 'Factory comparison is unavailable.' using errcode = '42501'; end if;
  if not coalesce(p_limit between 1 and 100, false) or (p_after_trial_id is not null and not exists (
    select 1 from public.factory_benchmark_experiment_trials trial
    where (trial.workspace_id, trial.factory_id, trial.experiment_id, trial.trial_id) =
      (p_workspace_id, p_factory_id, p_experiment_id, p_after_trial_id)
  )) then raise exception 'Invalid comparison trial page.' using errcode = '22023'; end if;

  if not coalesce(p_candidate_limit between 1 and 100, false) or (p_after_candidate_key is not null and not exists (
    select 1 from public.factory_benchmark_experiment_candidates candidate
    where (candidate.workspace_id,candidate.factory_id,candidate.experiment_id,candidate.candidate_key) =
      (p_workspace_id,p_factory_id,p_experiment_id,p_after_candidate_key)
  )) then raise exception 'Invalid comparison candidate page.' using errcode = '22023'; end if;

  result := internal.factory_benchmark_comparison_projection(p_workspace_id, p_factory_id, p_experiment_id,
    statement_timestamp(), p_after_trial_id, p_limit, p_after_candidate_key, p_candidate_limit);
  if result is null then raise exception 'Comparison is unavailable.' using errcode = 'P0002'; end if;
  return result;
end;
$$;

create function public.list_factory_benchmark_comparisons(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_suite_revision_id uuid default null,
  p_before_created_at timestamptz default null, p_before_experiment_id uuid default null, p_limit integer default 24
) returns jsonb language plpgsql stable security definer set search_path = '' set timezone = 'UTC' as $$
declare result jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if internal.factory_benchmark_comparison_manager(p_workspace_id,p_factory_id,p_actor_user_id) is null
  then raise exception 'Factory comparison is unavailable.' using errcode = '42501'; end if;
  if not coalesce(p_limit between 1 and 50, false)
    or (p_before_created_at is null) <> (p_before_experiment_id is null)
    or not coalesce(isfinite(p_before_created_at),true)
  then raise exception 'Invalid comparison list page.' using errcode = '22023'; end if;

  with page as materialized (
    select experiment.*, suite.suite_id, suite.revision_number as suite_revision_number, suite.name as suite_name,
      coalesce(schedule.state, 'unconfigured') as schedule_state
    from public.factory_benchmark_experiments experiment
    join public.factory_benchmark_suite_revisions suite on (suite.workspace_id, suite.factory_id, suite.id) =
      (experiment.workspace_id, experiment.factory_id, experiment.suite_revision_id)
    left join public.factory_benchmark_schedules schedule on (schedule.workspace_id, schedule.factory_id, schedule.experiment_id) =
      (experiment.workspace_id, experiment.factory_id, experiment.id)
    where (experiment.workspace_id, experiment.factory_id) = (p_workspace_id,p_factory_id)
      and (p_suite_revision_id is null or experiment.suite_revision_id = p_suite_revision_id)
      and (p_before_created_at is null or (experiment.created_at, experiment.id) < (p_before_created_at, p_before_experiment_id))
    order by experiment.created_at desc, experiment.id desc limit p_limit + 1
  ), visible as materialized (
    select * from page order by created_at desc, id desc limit p_limit
  ), boundary as (
    select created_at, id from visible where (select count(*) from page) > p_limit
    order by created_at, id limit 1
  )
  select jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'experimentId', experiment.id, 'createdAt', experiment.created_at, 'repetitions', experiment.repetitions,
      'suite', jsonb_build_object('id', experiment.suite_id, 'revisionId', experiment.suite_revision_id,
        'revisionNumber', experiment.suite_revision_number, 'name', experiment.suite_name),
      'scheduleState', experiment.schedule_state, 'counts', counts.value
    ) order by experiment.created_at desc, experiment.id desc)
    from visible experiment cross join lateral (
      select internal.factory_benchmark_comparison_counts(
        count(*), count(*) filter (where eligibility = 'eligible'), count(*) filter (where disposition = 'excluded'),
        count(*) filter (where admitted), count(*) filter (where started),
        count(*) filter (where disposition = 'pending'), count(*) filter (where disposition = 'running'),
        count(*) filter (where disposition = 'succeeded'), count(*) filter (where disposition = 'failed'),
        count(*) filter (where disposition = 'timed_out'), count(*) filter (where disposition = 'canceled'),
        count(*) filter (where disposition = 'unavailable')
      ) as value
      from internal.factory_benchmark_comparison_trial_facts(p_workspace_id, p_factory_id, experiment.id, statement_timestamp())
    ) counts
  ), '[]'::jsonb), 'nextCursor', (
    select jsonb_build_object('createdAt', created_at, 'experimentId', id) from boundary
  )) into result;
  return result;
end;
$$;

revoke all on function
  internal.factory_benchmark_comparison_counts(bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint),
  internal.factory_benchmark_comparison_projection(uuid,uuid,uuid,timestamptz,uuid,integer,text,integer),
  public.read_factory_benchmark_comparison(uuid,uuid,uuid,uuid,uuid,integer,text,integer),
  public.list_factory_benchmark_comparisons(uuid,uuid,uuid,uuid,timestamptz,uuid,integer)
from public, anon, authenticated, service_role;
grant execute on function public.read_factory_benchmark_comparison(uuid,uuid,uuid,uuid,uuid,integer,text,integer),
  public.list_factory_benchmark_comparisons(uuid,uuid,uuid,uuid,timestamptz,uuid,integer) to service_role;
