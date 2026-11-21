create function public.read_factory_benchmark_evaluation(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_actor_user_id uuid,
  p_after_trial_id uuid default null, p_after_scorer_revision_id uuid default null, p_limit integer default 50
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  evaluation jsonb;
  experiment public.factory_benchmark_experiments;
  schedule public.factory_benchmark_schedules;
  snapshot jsonb;
  scoring record;
  schedule_state text := 'unconfigured';
  execution_spent numeric := 0;
  execution_reserved numeric := 0;
  execution_unavailable bigint := 0;
  admitted_count integer := 0;
  budget_block text;
  cells jsonb;
  next_cursor jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if not coalesce(p_limit between 1 and 100, false) or (p_after_trial_id is null) <> (p_after_scorer_revision_id is null)
  then raise exception 'Invalid benchmark evaluation page.' using errcode = '22023'; end if;

  evaluation := internal.factory_benchmark_evaluation_plan(p_workspace_id, p_factory_id, p_experiment_id);
  if evaluation is null then raise exception 'The benchmark evaluation plan is unavailable.' using errcode = 'P0002'; end if;
  select * into strict experiment from public.factory_benchmark_experiments frozen
  where (frozen.workspace_id, frozen.factory_id, frozen.id) = (p_workspace_id, p_factory_id, p_experiment_id);
  select * into schedule from public.factory_benchmark_schedules existing
  where (existing.workspace_id, existing.factory_id, existing.experiment_id) = (p_workspace_id, p_factory_id, p_experiment_id)
  for update;
  if found then
    perform internal.refresh_factory_benchmark_schedule_costs(schedule);
    snapshot := internal.factory_benchmark_schedule_snapshot(schedule);
    budget_block := internal.factory_benchmark_evaluation_budget_block(schedule, (evaluation->>'budgetLimitUsd')::numeric);
    schedule_state := schedule.state;
    execution_spent := (snapshot->>'executionSpentUsd')::numeric;
    execution_unavailable := (snapshot->>'unavailableExecutionCount')::bigint;
    admitted_count := (snapshot->>'admittedTrialCount')::integer;
  end if;
  select * into strict scoring from internal.factory_benchmark_evaluation_spend(schedule);
  execution_reserved := coalesce((snapshot->>'reservedUsd')::numeric - scoring.reserved_usd, 0);

  -- Paginate the frozen eligible cross product first. Joining only admitted
  -- jobs would silently lose failed, canceled, and never-started denominators.
  with page as materialized (
    select frozen.trial_id, frozen.task_revision_id, frozen.candidate_key, frozen.repetition, dimension.scorer_revision_id
    from public.factory_benchmark_experiment_trials frozen
    join public.factory_benchmark_evaluation_dimensions dimension on
      (dimension.workspace_id, dimension.factory_id, dimension.experiment_id) =
      (frozen.workspace_id, frozen.factory_id, frozen.experiment_id)
    where (frozen.workspace_id, frozen.factory_id, frozen.experiment_id) = (p_workspace_id, p_factory_id, p_experiment_id)
      and frozen.replay_eligibility = 'eligible'
      and (p_after_trial_id is null or (frozen.trial_id, dimension.scorer_revision_id) >
        (p_after_trial_id, p_after_scorer_revision_id))
    order by frozen.trial_id, dimension.scorer_revision_id
    limit p_limit + 1
  ), visible as materialized (
    select * from page order by trial_id, scorer_revision_id limit p_limit
  ), projected as (
    select visible.trial_id, visible.scorer_revision_id, jsonb_build_object(
      'trialId', visible.trial_id, 'taskRevisionId', visible.task_revision_id, 'candidateKey', visible.candidate_key,
      'repetition', visible.repetition, 'scorerRevisionId', visible.scorer_revision_id,
      'status', case
        when job.status = 'canceled' then 'skipped'
        when job.status in ('succeeded', 'failed') and (latest.block_reason is not null
          or latest.reason in ('evidence_unavailable', 'profile_unavailable')) then 'unavailable'
        when job.status in ('succeeded', 'failed') then coalesce(latest.status, 'unavailable')
        when trial.status = 'error' or reason.value in ('expansion_limit_reached', 'trial_result_unavailable',
          'source_unavailable', 'missing_evidence', 'evaluation_budget_exhausted') then 'unavailable'
        when reason.value in ('schedule_canceled', 'trial_canceled') then 'skipped'
        else 'pending' end,
      'reason', reason.value,
      'evaluationJobId', job.id,
      'attemptId', case when job.status in ('succeeded', 'failed', 'canceled') then latest.attempt_id end,
      'score', case when job.status in ('succeeded', 'failed') then latest.score end
    ) as item
    from visible
    join public.factory_scorer_revisions revision on (revision.workspace_id, revision.factory_id, revision.id) =
      (p_workspace_id, p_factory_id, visible.scorer_revision_id)
    left join public.factory_benchmark_schedule_trials reservation on reservation.trial_id = visible.trial_id
    left join public.factory_benchmark_trials trial on (trial.id, trial.run_id) = (reservation.trial_id, reservation.run_id)
    left join internal.factory_benchmark_evaluation_outputs output on (output.trial_id, output.run_id) = (trial.id, trial.run_id)
    left join public.factory_scorer_sample_receipts sample on
      (sample.benchmark_trial_id, sample.scorer_revision_id, sample.benchmark_result_digest) =
      (output.trial_id, visible.scorer_revision_id, output.result_digest)
    left join public.factory_evaluation_jobs job on (job.workspace_id, job.factory_id, job.run_id, job.scorer_revision_id,
      job.sample_receipt_id, job.target_commit_sha) =
      (p_workspace_id, p_factory_id, output.run_id, visible.scorer_revision_id, sample.id, output.output_commit_sha)
      and job.source_attempt_id is null
    left join lateral (
      select receipt.attempt_id, receipt.status, receipt.reason, receipt.result->'score' as score, blocked.reason as block_reason
      from public.factory_evaluation_receipts receipt
      left join internal.factory_benchmark_evaluation_blocks blocked on blocked.attempt_id = receipt.attempt_id
      where (receipt.workspace_id, receipt.factory_id, receipt.job_id, receipt.sample_receipt_id, receipt.run_id,
        receipt.scorer_revision_id, receipt.target_commit_sha) =
        (p_workspace_id, p_factory_id, job.id, sample.id, job.run_id, visible.scorer_revision_id, output.output_commit_sha)
      order by receipt.attempt_number desc limit 1
    ) latest on job.status in ('succeeded', 'failed', 'canceled')
    cross join lateral (
      select case
        when job.status = 'canceled' then coalesce(latest.block_reason, latest.reason, 'canceled')
        when job.status in ('succeeded', 'failed') then coalesce(latest.block_reason, latest.reason,
          case when latest.attempt_id is null then 'receipt_unavailable' end)
        when trial.status = 'error' then 'trial_failed'
        when trial.status = 'canceled' then 'trial_canceled'
        when schedule_state = 'canceled' then 'schedule_canceled'
        when trial.id is null and admitted_count >= schedule.max_admitted_trials then 'expansion_limit_reached'
        when trial.id is null and schedule_state = 'unconfigured' then 'schedule_unconfigured'
        when schedule_state = 'paused' then 'schedule_paused'
        when trial.id is null then 'trial_not_admitted'
        when trial.status = 'queued' then 'trial_queued'
        when trial.status = 'running' then 'trial_running'
        when output.trial_id is null then 'trial_result_unavailable'
        when not internal.factory_benchmark_evaluation_source_available(output) then 'source_unavailable'
        when jsonb_array_length(internal.factory_benchmark_evaluation_evidence(output, revision.definition, false))
          <> jsonb_array_length(revision.definition->'requiredEvidence') then 'missing_evidence'
        when job.status = 'claimed' then 'evaluation_running'
        when budget_block is not null then budget_block
        when internal.is_factory_evaluation_scorer_paused(p_workspace_id, p_factory_id, visible.scorer_revision_id)
          then 'scorer_paused'
        when job.status = 'queued' then 'evaluation_queued'
        else 'evaluation_not_admitted' end as value
    ) reason
  ), boundary as (
    select trial_id, scorer_revision_id from visible where (select count(*) from page) > p_limit
    order by trial_id desc, scorer_revision_id desc limit 1
  )
  select coalesce((select jsonb_agg(item order by trial_id, scorer_revision_id) from projected), '[]'::jsonb),
    (select jsonb_build_object('trialId', trial_id, 'scorerRevisionId', scorer_revision_id) from boundary)
  into cells, next_cursor;

  return jsonb_build_object(
    'experimentId', p_experiment_id,
    'evaluation', evaluation,
    'scheduleState', schedule_state,
    'eligibleTrialCount', experiment.eligible_trial_count,
    'denominator', experiment.eligible_trial_count * jsonb_array_length(evaluation->'scorerRevisionIds'),
    'spend', jsonb_build_object(
      'execution', jsonb_build_object('spentUsd', execution_spent, 'reservedUsd', execution_reserved,
        'unavailableCount', execution_unavailable),
      'evaluation', jsonb_build_object('spentUsd', scoring.spent_usd, 'reservedUsd', scoring.reserved_usd,
        'unavailableCount', scoring.unavailable_count),
      'combined', jsonb_build_object('spentUsd', execution_spent + scoring.spent_usd,
        'reservedUsd', execution_reserved + scoring.reserved_usd,
        'unavailableCount', execution_unavailable + scoring.unavailable_count)
    ),
    'cells', cells, 'nextCursor', next_cursor
  );
end;
$$;

revoke all on function public.read_factory_benchmark_evaluation(uuid,uuid,uuid,uuid,uuid,uuid,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.read_factory_benchmark_evaluation(uuid,uuid,uuid,uuid,uuid,uuid,integer) to service_role;
