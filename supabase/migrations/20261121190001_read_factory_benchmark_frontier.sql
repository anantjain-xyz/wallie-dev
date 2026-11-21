create function public.read_factory_benchmark_frontier(
  p_workspace_id uuid,p_factory_id uuid,p_experiment_id uuid,p_actor_user_id uuid,
  p_scorer_revision_id uuid default null,p_after_candidate_key text default null,p_limit integer default 50,
  p_quality_floor_bps integer default 8000,p_min_resolved_trials integer default 2
) returns jsonb language plpgsql stable security definer set search_path = '' set timezone = 'UTC' as $$
declare
  experiment public.factory_benchmark_experiments;
  scorer_revision uuid;
  cursor_position integer;
  payload jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if internal.factory_benchmark_comparison_manager(p_workspace_id,p_factory_id,p_actor_user_id) is null then
    raise exception 'Benchmark frontier is unavailable.' using errcode = '42501';
  end if;
  if not coalesce(p_limit between 1 and 100,false) or not coalesce(p_quality_floor_bps between 0 and 10000,false)
    or not coalesce(p_min_resolved_trials between 2 and 10000,false)
  then raise exception 'Invalid benchmark frontier policy or page.' using errcode = '22023'; end if;
  select * into experiment from public.factory_benchmark_experiments frozen
  where (frozen.workspace_id,frozen.factory_id,frozen.id) = (p_workspace_id,p_factory_id,p_experiment_id);
  if not found then raise exception 'Benchmark comparison is unavailable.' using errcode = 'P0002'; end if;
  if p_after_candidate_key is not null then
    select candidate.comparison_position into cursor_position from public.factory_benchmark_experiment_candidates candidate
    where (candidate.workspace_id,candidate.factory_id,candidate.experiment_id,candidate.candidate_key) =
      (p_workspace_id,p_factory_id,p_experiment_id,p_after_candidate_key);
    if not found then raise exception 'Invalid benchmark frontier cursor.' using errcode = '22023'; end if;
  end if;
  select selected.scorer_revision_id into scorer_revision from public.factory_benchmark_evaluation_dimensions selected
  where (selected.workspace_id,selected.factory_id,selected.experiment_id) = (p_workspace_id,p_factory_id,p_experiment_id)
    and (p_scorer_revision_id is null or selected.scorer_revision_id = p_scorer_revision_id)
  order by selected.scorer_revision_id limit 1;
  if p_scorer_revision_id is not null and scorer_revision is null then
    raise exception 'The scorer revision does not belong to this comparison.' using errcode = '22023';
  end if;

  with cells as materialized (
    select fact.*,fact.verdict is not null or fact.known_nonpass as resolved
    from internal.factory_benchmark_frontier_trial_facts(p_workspace_id,p_factory_id,p_experiment_id,scorer_revision) fact
  ), scope_slots as materialized (
    select distinct cell.task_revision_id,cell.repetition,cell.seed,cell.timeout_ms from cells cell where cell.eligibility = 'eligible'
  ), scope_counts as (
    select count(*) as slot_count,count(distinct task_revision_id) as tasks from scope_slots
  ), repetition_scope as (
    -- Freeze gives each repetition the same task revisions and timeout. An
    -- asymmetric historical repetition cannot sample a smaller or different set.
    select slot.repetition,count(*) as slot_count from scope_slots slot cross join scope_counts frozen
    group by slot.repetition,frozen.tasks
    having count(*) = frozen.tasks and count(distinct slot.task_revision_id) = frozen.tasks
      and min(slot.timeout_ms) = experiment.timeout_ms and max(slot.timeout_ms) = experiment.timeout_ms
  ), repetitions as (
    select cell.candidate_key,cell.repetition,
      count(*) filter (where cell.verdict = 'pass') as passes,
      count(*) filter (where cell.resolved) as resolved,
      count(*) filter (where cell.comparable and cell.cost_state = 'measured') as measured,
      sum(cell.measured_usd) as measured_usd
    from cells cell where cell.eligibility = 'eligible' group by cell.candidate_key,cell.repetition
  ), repeated as (
    select observed.candidate_key,
      count(*) filter (where observed.resolved = frozen.slot_count) as quality_repetitions,
      count(*) filter (where observed.measured = frozen.slot_count) as cost_repetitions,
      min(observed.passes::numeric * 10000 / frozen.slot_count) filter (where observed.resolved = frozen.slot_count) as min_pass_rate,
      max(observed.passes::numeric * 10000 / frozen.slot_count) filter (where observed.resolved = frozen.slot_count) as max_pass_rate,
      min(observed.measured_usd / frozen.slot_count) filter (where observed.measured = frozen.slot_count) as min_mean_usd,
      max(observed.measured_usd / frozen.slot_count) filter (where observed.measured = frozen.slot_count) as max_mean_usd
    from repetitions observed join repetition_scope frozen using (repetition) group by observed.candidate_key
  ), counts as (
    select cell.candidate_key,count(*) as planned,count(*) filter (where cell.eligibility = 'eligible') as eligible,
      count(*) filter (where cell.eligibility <> 'eligible') as excluded,count(*) filter (where cell.started) as started,
      count(*) filter (where cell.disposition in ('succeeded','failed','timed_out','canceled','unavailable')) as terminal,
      count(*) filter (where cell.comparable) as comparable,count(*) filter (where cell.resolved) as resolved,
      count(*) filter (where cell.verdict is not null) as scored,count(*) filter (where cell.verdict = 'pass') as pass,
      count(*) filter (where cell.verdict = 'fail') as fail,count(*) filter (where cell.known_nonpass) as nonpass,
      count(*) filter (where cell.verdict is not null and cell.judge_signature is null) as unverified_profiles,
      count(distinct cell.judge_signature) as profile_count,max(cell.judge_signature) as judge_signature,
      sum(cell.measured_usd) as measured_usd,sum(cell.estimated_usd) as estimated_usd,
      count(*) filter (where cell.eligibility = 'eligible' and cell.cost_state = 'measured') as measured_trials,
      count(*) filter (where cell.eligibility = 'eligible' and cell.cost_state = 'estimated') as estimated_trials,
      count(*) filter (where cell.eligibility = 'eligible' and cell.cost_state = 'unavailable') as unavailable_trials,
      count(*) filter (where cell.eligibility = 'eligible' and cell.cost_state = 'pending') as pending_trials,
      count(*) filter (where cell.eligibility = 'eligible' and cell.cost_state = 'never_started') as never_started_trials
    from cells cell group by cell.candidate_key
  ), candidates as materialized (
    select candidate.comparison_position as position,candidate.harness,candidate.model,candidate.worker_runtime,
      observed.*,frozen.slot_count,
      case when frozen.slot_count > 0 and observed.comparable = frozen.slot_count and observed.resolved = frozen.slot_count
        and observed.measured_trials = frozen.slot_count then observed.measured_usd / frozen.slot_count end as mean_usd,
      coalesce(spread.quality_repetitions,0) as quality_repetitions,coalesce(spread.cost_repetitions,0) as cost_repetitions,
      spread.min_pass_rate,spread.max_pass_rate,spread.min_mean_usd,spread.max_mean_usd,
      array_remove(array[
        case when scorer_revision is null then 'no_scorer' end,
        case when frozen.slot_count = 0 then 'no_eligible_trials' end,
        case when observed.comparable <> frozen.slot_count then 'incomplete_execution' end,
        case when observed.resolved <> frozen.slot_count then 'incomplete_quality' end,
        case when observed.unverified_profiles > 0 then 'unverified_judge_profile' end,
        case when observed.profile_count > 1 then 'mixed_judge_profile' end,
        case when observed.resolved < p_min_resolved_trials then 'insufficient_samples' end,
        case when frozen.slot_count > 0 and (observed.unavailable_trials + observed.pending_trials + observed.never_started_trials > 0
          or (observed.measured_trials = frozen.slot_count and observed.measured_usd is null)) then 'unavailable_cost' end,
        case when observed.estimated_trials > 0 then 'estimated_cost' end,
        case when observed.resolved = frozen.slot_count and observed.resolved > 0
          and observed.pass * 10000 < frozen.slot_count * p_quality_floor_bps then 'below_quality_floor' end
      ],null) as reasons
    from public.factory_benchmark_experiment_candidates candidate
    join counts observed on observed.candidate_key = candidate.candidate_key
    left join repeated spread on spread.candidate_key = candidate.candidate_key
    cross join scope_counts frozen
    where (candidate.workspace_id,candidate.factory_id,candidate.experiment_id) = (p_workspace_id,p_factory_id,p_experiment_id)
  ), judge_scope as (
    select count(distinct candidate.judge_signature) > 1 as mixed
    from candidates candidate where cardinality(candidate.reasons) = 0
  ), decisions as materialized (
    select candidate.*,case when calibration.mixed and cardinality(candidate.reasons) = 0
      then array['mixed_judge_profile'] else candidate.reasons end as exclusions
    from candidates candidate cross join judge_scope calibration
  ), rankable as materialized (
    select candidate.* from decisions candidate where cardinality(candidate.exclusions) = 0 and candidate.mean_usd is not null
  ), price_groups as (
    select measured_usd,max(pass) as best_here from rankable group by measured_usd
  ), earlier_prices as (
    select measured_usd,best_here,max(best_here) over (order by measured_usd
      rows between unbounded preceding and 1 preceding) as best_cheaper
    from price_groups
  ), best_by_quality as (
    select distinct on (pass) pass,candidate_key as best_candidate_key from rankable
    order by pass,measured_usd,position nulls last,candidate_key
  ), classifications as materialized (
    select candidate.*,
      case when cardinality(candidate.exclusions) > 0 then 'excluded'
        when dominator.best_candidate_key is not null then 'dominated' else 'frontier' end as standing,
      dominator.best_candidate_key as dominator_key
    from decisions candidate left join earlier_prices price
      on cardinality(candidate.exclusions) = 0 and candidate.measured_usd = price.measured_usd
    left join best_by_quality dominator on dominator.pass = case
      when price.best_cheaper >= candidate.pass then price.best_cheaper
      when price.best_here > candidate.pass then price.best_here end
  ), winner_group as (
    select standing.measured_usd,standing.pass from classifications standing where standing.standing = 'frontier'
    order by standing.measured_usd,standing.pass desc limit 1
  ), winners as materialized (
    select standing.* from classifications standing join winner_group cheapest using (measured_usd,pass)
    where standing.standing = 'frontier'
  ), winner_counts as (
    select count(*) as total,min(mean_usd) as mean_usd,min(pass) as pass from winners
  ), decision as (
    select case
      when scorer_revision is null then 'no_scorer'
      when frozen.slot_count = 0 then 'no_eligible_trials'
      when exists (select 1 from public.factory_benchmark_schedules schedule
        where (schedule.workspace_id,schedule.factory_id,schedule.experiment_id) = (p_workspace_id,p_factory_id,p_experiment_id)
          and schedule.state in ('active','paused'))
        and exists (select 1 from cells cell where cell.eligibility = 'eligible' and cell.open_work) then 'comparison_in_progress'
      when calibration.mixed then 'mixed_judge_profile'
      when best.total = 0 then 'no_eligible_candidate'
      when best.total > 1 then 'equal_measured_cost_quality'
      else 'lowest_measured_cost' end as reason,best.total,best.mean_usd,best.pass,frozen.slot_count
    from winner_counts best cross join scope_counts frozen cross join judge_scope calibration
  ), page as materialized (
    select * from classifications candidate
    where p_after_candidate_key is null or (coalesce(candidate.position,2147483647),candidate.candidate_key) >
      (coalesce(cursor_position,2147483647),p_after_candidate_key)
    order by candidate.position nulls last,candidate.candidate_key limit p_limit + 1
  ), visible as materialized (
    select * from page order by position nulls last,candidate_key limit p_limit
  ), boundary as (
    select candidate_key from visible where (select count(*) from page) > p_limit
    order by position desc nulls first,candidate_key desc limit 1
  ), scorer_rows as materialized (
    select revision.id,jsonb_build_object('id',revision.id,'scorerId',scorer.id,'name',scorer.name,'revisionNumber',revision.revision_number) as value
    from public.factory_benchmark_evaluation_dimensions selected
    join public.factory_scorer_revisions revision on (revision.workspace_id,revision.factory_id,revision.id) =
      (selected.workspace_id,selected.factory_id,selected.scorer_revision_id)
    join public.factory_scorers scorer on (scorer.workspace_id,scorer.factory_id,scorer.id) =
      (revision.workspace_id,revision.factory_id,revision.scorer_id)
    where (selected.workspace_id,selected.factory_id,selected.experiment_id) = (p_workspace_id,p_factory_id,p_experiment_id)
  )
  select jsonb_build_object('experimentId',p_experiment_id,'snapshotAt',statement_timestamp(),
    'suite',jsonb_build_object('id',suite.suite_id,'revisionId',suite.id,'revisionNumber',suite.revision_number,'name',suite.name),
    'policy',jsonb_build_object('revision','measured-usd-v1','qualityFloorBps',p_quality_floor_bps,
      'minimumResolved',p_min_resolved_trials,'costBasis','execution_plus_selected_judge'),
    'scorer',(select value from scorer_rows where id = scorer_revision),
    'scorers',coalesce((select jsonb_agg(value order by id) from scorer_rows),'[]'::jsonb),
    'cohort',jsonb_build_object('plannedTrialCount',experiment.expected_trial_count,'eligibleTrialCount',experiment.eligible_trial_count,
      'excludedTrialCount',experiment.ineligible_trial_count,'eligibleSlotCount',frozen.slot_count,'taskRevisionCount',frozen.tasks,
      'repetitions',experiment.repetitions),
    'candidateCount',experiment.candidate_count,'frontierCount',(select count(*) from classifications where standing = 'frontier'),
    'recommendation',jsonb_build_object('status',case outcome.reason when 'lowest_measured_cost' then 'recommended'
        when 'equal_measured_cost_quality' then 'tied' else 'unavailable' end,'reason',outcome.reason,
      'candidates',case when outcome.reason in ('lowest_measured_cost','equal_measured_cost_quality') then coalesce((
        select jsonb_agg(jsonb_build_object('candidateKey',preview.candidate_key,'position',preview.position,
          'plannedHarness',preview.harness,'plannedModel',preview.model) order by preview.position nulls last,preview.candidate_key)
        from (select * from winners order by position nulls last,candidate_key limit 8) preview
      ),'[]'::jsonb) else '[]'::jsonb end,
      'candidateCount',case when outcome.reason in ('lowest_measured_cost','equal_measured_cost_quality') then outcome.total else 0 end,
      'meanCostUsd',case when outcome.reason in ('lowest_measured_cost','equal_measured_cost_quality') then trim_scale(outcome.mean_usd)::text end,
      'passRateBps',case when outcome.reason in ('lowest_measured_cost','equal_measured_cost_quality')
        then floor(outcome.pass::numeric * 10000 / nullif(outcome.slot_count,0))::integer end),
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'candidateKey',item.candidate_key,'position',item.position,'plannedHarness',item.harness,'plannedModel',item.model,
      'plannedRuntime',item.worker_runtime,
      'counts',jsonb_build_object('planned',item.planned,'eligible',item.eligible,'excluded',item.excluded,
        'started',item.started,'terminal',item.terminal,'comparable',item.comparable,'resolved',item.resolved,
        'scored',item.scored,'pass',item.pass,'fail',item.fail,'nonPassFailure',item.nonpass,'unresolved',item.slot_count-item.resolved),
      'quality',jsonb_build_object('passRateBps',case when item.resolved = item.slot_count
          then floor(item.pass::numeric * 10000 / nullif(item.slot_count,0))::integer end,
        'scoredPassRateBps',floor(item.pass::numeric * 10000 / nullif(item.scored,0))::integer),
      'cost',jsonb_build_object('measuredUsd',trim_scale(item.measured_usd)::text,'estimatedUsd',trim_scale(item.estimated_usd)::text,
        'meanCostUsd',trim_scale(item.mean_usd)::text,'measuredTrials',item.measured_trials,'estimatedTrials',item.estimated_trials,
        'unavailableTrials',item.unavailable_trials,'pendingTrials',item.pending_trials,'neverStartedTrials',item.never_started_trials),
      'spread',jsonb_build_object('qualityRepetitions',item.quality_repetitions,'costRepetitions',item.cost_repetitions,
        'minPassRateBps',case when item.quality_repetitions >= 2 then floor(item.min_pass_rate)::integer end,
        'maxPassRateBps',case when item.quality_repetitions >= 2 then floor(item.max_pass_rate)::integer end,
        'minMeanCostUsd',case when item.cost_repetitions >= 2 then trim_scale(item.min_mean_usd)::text end,
        'maxMeanCostUsd',case when item.cost_repetitions >= 2 then trim_scale(item.max_mean_usd)::text end),
      'status',item.standing,'exclusions',item.exclusions,
      'isRecommended',outcome.reason in ('lowest_measured_cost','equal_measured_cost_quality') and winner.candidate_key is not null,
      'dominatedBy',case when rival.candidate_key is not null
        then jsonb_build_object('candidateKey',rival.candidate_key,'position',rival.position,
          'plannedHarness',rival.harness,'plannedModel',rival.model) end) order by item.position nulls last,item.candidate_key)
      from visible item left join classifications rival on rival.candidate_key = item.dominator_key
      left join winners winner on winner.candidate_key = item.candidate_key),'[]'::jsonb),
    'nextCursor',(select jsonb_build_object('candidateKey',candidate_key) from boundary)) into payload
  from public.factory_benchmark_suite_revisions suite cross join scope_counts frozen cross join decision outcome
  where (suite.workspace_id,suite.factory_id,suite.id) = (p_workspace_id,p_factory_id,experiment.suite_revision_id);
  return payload;
end;
$$;
revoke all on function public.read_factory_benchmark_frontier(uuid,uuid,uuid,uuid,uuid,text,integer,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.read_factory_benchmark_frontier(uuid,uuid,uuid,uuid,uuid,text,integer,integer,integer) to service_role;
