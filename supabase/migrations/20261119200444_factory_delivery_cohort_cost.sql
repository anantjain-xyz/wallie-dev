-- Retained attempt usage is authoritative. Cost reads never change execution
-- receipts or require the job row to survive with the run.
create index agent_runs_workspace_started_cost_idx
  on public.agent_runs (workspace_id, started_at, session_id, id)
  where started_at is not null;

insert into internal.factory_outcome_metric_revisions (metric_key, revision, definition) values
  ('delivery_cohort_cost_per_merge', 1, '{
    "currency":"USD","population":"unique_verified_merges","observationSources":["pull_requests","run_usage"],
    "numerator":"attributable_lifetime_product_attempts","attribution":["exact_publication_receipt","settled_session_window"],
    "denominator":"provider_merged_at","missingCost":"partial_or_unavailable"
  }'),
  ('period_operating_cost_per_merge', 1, '{
    "currency":"USD","population":"factory_operating_period","observationSources":["pull_requests","run_usage"],
    "numerator":"all_product_attempts_started_in_period","denominator":"provider_merged_at",
    "missingCost":"partial_or_unavailable"
  }');

create function internal.require_factory_cost_scope(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz
) returns void language plpgsql stable set search_path = '' as $$
begin
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_to <= p_from or p_to - p_from > interval '366 days' then
    raise exception 'Provide a nonempty factory cost period of at most 366 days.' using errcode = '22023';
  end if;
  if not internal.can_access_factory(p_workspace_id, p_factory_id) or not exists (
    select 1 from public.factories factory join public.workspaces workspace on workspace.id = factory.workspace_id
    where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id)
      and workspace.deletion_requested_at is null
  ) then raise exception 'Factory cost evidence is unavailable.' using errcode = '42501'; end if;
end;
$$;
revoke all on function internal.require_factory_cost_scope(uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

create function internal.factory_cost_contributions(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_basis text
) returns table (
  run_id uuid, session_id uuid, attempt_count integer, run_status text,
  started_at timestamptz, finished_at timestamptz,
  merge_id uuid, merge_observation_id uuid, candidate_merge_id uuid, attribution text,
  cost_state text, cost_usd numeric,
  usage_recorded_at timestamptz, usage_finalized_at timestamptz, usage_estimation_revision text
) language sql stable set search_path = '' as $$
  with verified_merges as materialized (
    select fact.id, fact.observation_id, fact.session_id, fact.epoch_id, fact.merged_at,
      epoch.epoch_number, epoch.created_at as epoch_created_at
    from internal.current_factory_canonical_pull_request_merges fact
    join public.session_pr_epochs epoch on epoch.id = fact.epoch_id
    where (fact.workspace_id, fact.factory_id) = (p_workspace_id, p_factory_id) and fact.status = 'observed'
  ), period_merges as materialized (
    select id, session_id from verified_merges where merged_at >= p_from and merged_at < p_to
  ), attempts as materialized (
    select run.id, run.session_id, run.attempt_count, run.status, run.started_at, run.finished_at,
      run.cost_provenance, run.total_cost_usd, run.usage_recorded_at, run.usage_finalized_at, run.usage_estimation_revision
    from public.agent_runs run join public.sessions session
      on (session.workspace_id, session.id) = (run.workspace_id, run.session_id)
    where (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id)
      and run.started_at is not null and (
        (p_basis = 'operating' and run.started_at >= p_from and run.started_at < p_to)
        or (p_basis = 'delivery' and exists (
          select 1 from period_merges merge where merge.session_id = run.session_id
        ))
      )
  ), assignment as (
    select attempt.*, exact.id as exact_merge_id, exact.observation_id as exact_observation_id,
      candidate.id as window_merge_id, candidate.observation_id as window_observation_id,
      candidate.id is not null and attempt.status in ('success', 'error', 'canceled')
        and attempt.finished_at between attempt.started_at and candidate.merged_at
        and not exists (
          select 1 from public.session_pr_epochs successor
          where (successor.workspace_id, successor.session_id) = (p_workspace_id, attempt.session_id)
            and successor.epoch_number > candidate.epoch_number and successor.created_at <= attempt.finished_at
        )
        and not exists (
          select 1 from public.session_pr_epochs previous
          left join verified_merges evidence on evidence.epoch_id = previous.id
          where (previous.workspace_id, previous.session_id) = (p_workspace_id, attempt.session_id)
            and previous.epoch_number < candidate.epoch_number and previous.pr_state = 'merged'
            and (
              (evidence.id is not null and evidence.merged_at >= attempt.started_at)
              or (evidence.id is null and candidate.epoch_created_at > attempt.started_at
                and (previous.pr_updated_at is null or previous.pr_updated_at >= attempt.started_at))
            )
        ) as window_proven
    from attempts attempt
    left join lateral (
      -- If a checkpoint really reached multiple successive PRs, its charge
      -- belongs to the first verified exact publication, once.
      select merge.id, merge.observation_id
      from internal.factory_canonical_pull_request_merge_runs source
      join verified_merges merge on merge.observation_id = source.observation_id
      where (source.run_id, source.attempt_count, merge.session_id) =
        (attempt.id, attempt.attempt_count, attempt.session_id)
      order by merge.epoch_number
      limit 1
    ) exact on true
    left join lateral (
      -- A failed or detached attempt may still belong to the next delivery.
      -- Choose its candidate before filtering the requested period.
      select merge.* from verified_merges merge
      where exact.id is null and merge.session_id = attempt.session_id and merge.merged_at >= attempt.started_at
        and not exists (
          select 1 from public.session_pr_epochs successor
          where (successor.workspace_id, successor.session_id) = (p_workspace_id, attempt.session_id)
            and successor.epoch_number > merge.epoch_number and successor.created_at <= attempt.started_at
        )
      order by merge.epoch_number
      limit 1
    ) candidate on true
  ), membership as (
    select assignment.*,
      coalesce(exact_merge_id, case when window_proven then window_merge_id end) as assigned_merge_id,
      coalesce(exact_observation_id, case when window_proven then window_observation_id end) as assigned_observation_id,
      case when exact_merge_id is not null then 'exact_publication_receipt'
        when window_proven then 'settled_session_window'
        when window_merge_id is not null then 'unresolved'
        else 'unlinked' end as assigned_by,
      case when status not in ('success', 'error', 'canceled') then 'pending'
        when usage_finalized_at is not null and total_cost_usd is not null and total_cost_usd >= 0
          and total_cost_usd not in ('NaN'::numeric, 'Infinity'::numeric)
          and cost_provenance in ('measured', 'estimated') then cost_provenance
        else 'unavailable' end as usage_state
    from assignment
  )
  select id, membership.session_id, membership.attempt_count, status::text, membership.started_at, membership.finished_at,
    assigned_merge_id, assigned_observation_id,
    case when assigned_by = 'unresolved' then window_merge_id end, assigned_by, usage_state,
    case when usage_state in ('measured', 'estimated') then total_cost_usd end,
    membership.usage_recorded_at, membership.usage_finalized_at, membership.usage_estimation_revision
  from membership
  where p_basis = 'operating' or exists (
    select 1 from period_merges merge where merge.id = coalesce(assigned_merge_id, window_merge_id)
  )
$$;
revoke all on function internal.factory_cost_contributions(uuid, uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;

create function public.get_factory_cost_summary(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare summary jsonb;
begin
  perform internal.require_factory_cost_scope(p_workspace_id, p_factory_id, p_from, p_to);
  with denominator as (
    select count(*) filter (where fact.status = 'observed' and fact.merged_at >= p_from and fact.merged_at < p_to) as merge_count,
      count(*) filter (where fact.status is distinct from 'observed' and session.created_at < p_to
        and (epoch.pr_updated_at is null or epoch.pr_updated_at >= p_from)) as unresolved_merge_count,
      (
        select coverage.live_from from internal.factory_outcome_capture_coverage coverage where coverage.source = 'pull_requests'
      ) as capture_start
    from public.session_pr_epochs epoch
    join public.sessions session on (session.workspace_id, session.id) = (epoch.workspace_id, epoch.session_id)
    left join internal.current_factory_canonical_pull_request_merges fact
      on (fact.workspace_id, fact.factory_id, fact.epoch_id) = (session.workspace_id, session.factory_id, epoch.id)
    where (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id) and epoch.pr_state = 'merged'
  ), costs as (
    select basis.key, basis.metric_key,
      count(*) filter (where contribution.included and contribution.cost_state = 'measured') as measured_count,
      count(*) filter (where contribution.included and contribution.cost_state = 'estimated') as estimated_count,
      count(*) filter (where contribution.included and contribution.cost_state = 'unavailable') as unavailable_count,
      count(*) filter (where contribution.cost_state = 'pending') as pending_count,
      count(*) filter (where contribution.attribution = 'unresolved') as unresolved_attribution_count,
      count(*) filter (where contribution.attribution = 'unlinked') as unlinked_count,
      sum(contribution.cost_usd) filter (where contribution.included) as known_cost
    from (values ('delivery', 'delivery_cohort_cost_per_merge'), ('operating', 'period_operating_cost_per_merge')) basis(key, metric_key)
    left join lateral (
      select facts.*, (basis.key = 'operating' or facts.merge_id is not null) as included
      from internal.factory_cost_contributions(p_workspace_id, p_factory_id, p_from, p_to, basis.key) facts
    ) contribution on true
    group by basis.key, basis.metric_key
  ), coverage as (
    select denominator.*, capture_start is null or p_from < capture_start or unresolved_merge_count > 0 as denominator_partial
    from denominator
  ), cost_states as (
    select costs.*, case
      when known_cost is null and unavailable_count + pending_count + unresolved_attribution_count = 0 then 'no_attempts'
      when known_cost is null then 'unavailable'
      when unavailable_count + pending_count > 0 or (key = 'delivery' and unresolved_attribution_count > 0) then 'partial'
      when estimated_count > 0 then 'estimated'
      else 'measured' end as cost_state
    from costs
  )
  select jsonb_build_object(
    'workspaceId', p_workspace_id, 'factoryId', p_factory_id, 'from', p_from, 'to', p_to,
    'observedAt', statement_timestamp(),
    'mergeCohort', jsonb_build_object(
      'observedMergeCount', coverage.merge_count, 'unresolvedMergeCount', coverage.unresolved_merge_count,
      'captureStartedAt', coverage.capture_start, 'partialCoverage', coverage.denominator_partial
    ),
    'costs', (
      select jsonb_object_agg(cost.key, jsonb_build_object(
        'metricKey', cost.metric_key, 'metricRevision', 1, 'category', 'product_attempt',
        'costState', cost.cost_state, 'knownCostUsd', cost.known_cost,
        'measuredAttempts', cost.measured_count, 'estimatedAttempts', cost.estimated_count,
        'unavailableAttempts', cost.unavailable_count, 'pendingAttempts', cost.pending_count,
        'unresolvedAttributionAttempts', cost.unresolved_attribution_count, 'unlinkedAttempts', cost.unlinked_count,
        'knownCostPerObservedMergeUsd', cost.known_cost / nullif(coverage.merge_count, 0),
        'ratioState', case
          when coverage.merge_count = 0 then 'no_observed_merges'
          when cost.known_cost is null then 'unavailable'
          when coverage.denominator_partial or cost.cost_state = 'partial' then 'partial'
          else cost.cost_state end
      )) from cost_states cost
    ),
    'unavailableCostCategories', (
      select jsonb_agg(jsonb_build_object('category', category, 'state', 'unavailable', 'reason', 'source_not_instrumented')
        order by category)
      from unnest(array['evaluation', 'experiment', 'maintenance', 'compute']) category
    )
  ) into summary from coverage;
  return summary;
end;
$$;

create function public.list_factory_cost_contributions(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_basis text,
  p_after_run_id uuid default null, p_limit integer default 100, p_merge_id uuid default null
) returns table (
  run_id uuid, session_id uuid, attempt_count integer, run_status text,
  started_at timestamptz, finished_at timestamptz,
  merge_id uuid, merge_observation_id uuid, candidate_merge_id uuid, attribution text,
  cost_state text, cost_usd numeric,
  usage_recorded_at timestamptz, usage_finalized_at timestamptz, usage_estimation_revision text
) language plpgsql stable security definer set search_path = '' as $$
begin
  perform internal.require_factory_cost_scope(p_workspace_id, p_factory_id, p_from, p_to);
  if p_basis is null or p_basis not in ('delivery', 'operating') or p_limit is null or p_limit not between 1 and 250
    or (p_merge_id is not null and p_basis <> 'delivery') then
    raise exception 'Invalid factory cost contribution filter.' using errcode = '22023';
  end if;
  return query
  select contribution.* from internal.factory_cost_contributions(p_workspace_id, p_factory_id, p_from, p_to, p_basis) contribution
  where (p_after_run_id is null or contribution.run_id > p_after_run_id)
    and (p_merge_id is null or coalesce(contribution.merge_id, contribution.candidate_merge_id) = p_merge_id)
  order by contribution.run_id
  limit p_limit;
end;
$$;

revoke all on function public.get_factory_cost_summary(uuid, uuid, timestamptz, timestamptz),
  public.list_factory_cost_contributions(uuid, uuid, timestamptz, timestamptz, text, uuid, integer, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_factory_cost_summary(uuid, uuid, timestamptz, timestamptz),
  public.list_factory_cost_contributions(uuid, uuid, timestamptz, timestamptz, text, uuid, integer, uuid)
to authenticated, service_role;
