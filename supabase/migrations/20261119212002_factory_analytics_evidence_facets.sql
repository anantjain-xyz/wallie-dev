-- Match dashboard point membership at the source, before applying keyset limits.
drop function public.list_factory_flow_evidence(
  uuid, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid, timestamptz
);
drop function public.list_factory_cost_contributions(uuid, uuid, timestamptz, timestamptz, text, uuid, integer, uuid);
drop function public.list_factory_revert_evidence(uuid, uuid, timestamptz, timestamptz, text, integer, timestamptz, uuid);

create function public.list_factory_flow_evidence(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_metric_key text,
  p_environment text default null, p_limit integer default 50, p_cursor_at timestamptz default null,
  p_cursor_session_id uuid default null, p_cursor_end_at timestamptz default null,
  p_facet text default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
begin
  perform internal.require_factory_flow_window(p_workspace_id, p_factory_id, p_from, p_to, p_environment);
  if p_metric_key is null or p_metric_key not in ('workflow_flow', 'request_to_merge', 'request_to_deployment')
    or (p_facet is not null and case when p_metric_key = 'workflow_flow'
      then p_facet not in ('queued', 'active', 'blocked', 'review', 'delivery', 'unknown')
      else p_facet not in ('measured', 'censored', 'unknown') end)
    or p_limit is null or p_limit not between 1 and 100
    or num_nonnulls(p_cursor_at, p_cursor_session_id, p_cursor_end_at) not in (0, 3)
    or (p_cursor_at is not null and (not isfinite(p_cursor_at) or not isfinite(p_cursor_end_at)
      or (p_metric_key = 'workflow_flow' and p_cursor_at >= p_cursor_end_at)
      or (p_metric_key <> 'workflow_flow' and p_cursor_at <> p_cursor_end_at)))
  then raise exception 'Invalid factory outcome evidence cursor or metric.' using errcode = '22023'; end if;

  with page as materialized (
    select evidence.cursor_at, evidence.session_id, evidence.cursor_end_at, evidence.item
    from (
      select segment.started_at as cursor_at, segment.session_id, segment.ended_at as cursor_end_at,
        jsonb_build_object(
          'sessionId', segment.session_id, 'phase', segment.phase,
          'status', case when segment.phase = 'unknown' then 'unknown' else 'measured' end,
          'startedAt', greatest(segment.started_at, p_from), 'endedAt', least(segment.ended_at, p_to),
          'sourceStartedAt', segment.started_at, 'sourceEndedAt', segment.ended_at,
          'seconds', extract(epoch from least(segment.ended_at, p_to) - greatest(segment.started_at, p_from)),
          'observationIds', segment.observation_ids
        ) as item
      from internal.factory_flow_projection_segments segment
      where p_metric_key = 'workflow_flow' and (p_facet is null or segment.phase = p_facet)
        and (segment.workspace_id, segment.factory_id) = (p_workspace_id, p_factory_id)
        and segment.started_at < p_to and segment.ended_at > p_from
        and (p_cursor_at is null or (segment.started_at, segment.session_id, segment.ended_at) >
          (p_cursor_at, p_cursor_session_id, p_cursor_end_at))

      union all

      select sample.requested_at, sample.session_id, sample.requested_at,
        jsonb_build_object(
          'sessionId', sample.session_id, 'requestedAt', sample.requested_at,
          'requestObservationId', sample.request_observation_id, 'status', timing.status,
          'deliveredAt', timing.delivered_at, 'seconds', extract(epoch from timing.delivered_at - sample.requested_at),
          'canonicalMergeId', timing.canonical_merge_id, 'mergeObservationId', timing.merge_observation_id,
          'deploymentId', timing.deployment_id, 'deploymentObservationId', timing.deployment_observation_id,
          'deploymentEnvironment', timing.deployment_environment
        )
      from internal.factory_flow_delivery_samples(
        p_workspace_id, p_factory_id, p_from, p_to, p_environment,
        -- A delivery facet must restrict the exact sample set before pagination.
        case when p_metric_key = 'workflow_flow' then 0 when p_facet is null then p_limit + 1 end,
        p_cursor_at, p_cursor_session_id
      ) sample
      cross join lateral (
        select sample.merge_status, sample.merged_at, sample.canonical_merge_id, sample.merge_observation_id,
          null::uuid, null::uuid, null::text
        where p_metric_key = 'request_to_merge'
        union all
        select sample.deployment_status, sample.deployed_at,
          coalesce(sample.deployment_merge_id, sample.canonical_merge_id),
          coalesce(sample.deployment_merge_observation_id, sample.merge_observation_id),
          sample.deployment_id, sample.deployment_observation_id, sample.deployment_environment
        where p_metric_key = 'request_to_deployment'
      ) timing(status, delivered_at, canonical_merge_id, merge_observation_id,
        deployment_id, deployment_observation_id, deployment_environment)
      where p_facet is null or timing.status = p_facet
    ) evidence
    order by evidence.cursor_at, evidence.session_id, evidence.cursor_end_at
    limit p_limit + 1
  ), visible as materialized (
    select * from page order by cursor_at, session_id, cursor_end_at limit p_limit
  )
  select jsonb_build_object(
    'metricRevision', 1,
    'items', coalesce(
      (select jsonb_agg(item || case when p_metric_key = 'workflow_flow' then jsonb_build_object(
          'observations', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', fact.id, 'eventType', fact.event_type, 'occurredAt', fact.occurred_at,
              'observedAt', fact.observed_at, 'jobId', fact.job_id, 'runId', fact.run_id,
              'attemptCount', fact.attempt_count, 'artifactId', fact.artifact_id
            ) order by fact.occurred_at, fact.id)
            from jsonb_array_elements_text(item->'observationIds') source(id)
            join internal.factory_outcome_observations fact on fact.id = source.id::uuid
            where (fact.workspace_id, fact.factory_id, fact.session_id) =
              (p_workspace_id, p_factory_id, visible.session_id)
          ), '[]'::jsonb)) else '{}'::jsonb end order by cursor_at, session_id, cursor_end_at) from visible),
      '[]'::jsonb
    ),
    'nextCursor', case when (select count(*) from page) > p_limit then (
      select jsonb_build_object('at', cursor_at, 'sessionId', session_id, 'endAt', cursor_end_at)
      from visible order by cursor_at desc, session_id desc, cursor_end_at desc limit 1
    ) end
  ) into result;
  return result;
end;
$$;

create function public.list_factory_cost_contributions(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_basis text,
  p_after_run_id uuid default null, p_limit integer default 100, p_merge_id uuid default null,
  p_facet text default null
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
    or (p_merge_id is not null and p_basis <> 'delivery')
    or (p_facet is not null and p_facet not in (
      'known', 'measured', 'estimated', 'pending', 'unavailable', 'unresolved', 'unlinked'
    )) then
    raise exception 'Invalid factory cost contribution filter.' using errcode = '22023';
  end if;
  return query
  select contribution.* from internal.factory_cost_contributions(p_workspace_id, p_factory_id, p_from, p_to, p_basis) contribution
  where (p_after_run_id is null or contribution.run_id > p_after_run_id)
    and (p_merge_id is null or coalesce(contribution.merge_id, contribution.candidate_merge_id) = p_merge_id)
    and (
      p_facet is null
      or (p_facet = 'pending' and contribution.cost_state = 'pending')
      or (p_facet in ('unresolved', 'unlinked') and contribution.attribution = p_facet)
      or ((p_basis = 'operating' or contribution.merge_id is not null) and (
        (p_facet = 'known' and contribution.cost_state in ('measured', 'estimated'))
        or (p_facet in ('measured', 'estimated', 'unavailable') and contribution.cost_state = p_facet)
      ))
    )
  order by contribution.run_id
  limit p_limit;
end;
$$;

create function public.list_factory_revert_evidence(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz,
  p_status text default null, p_limit integer default 25,
  p_cursor_at timestamptz default null, p_cursor_merge_id uuid default null,
  p_has_verified_revert boolean default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
  as_of timestamptz := statement_timestamp();
begin
  perform internal.require_factory_flow_window(p_workspace_id, p_factory_id, p_from, p_to, null);
  if p_limit is null or p_limit not between 1 and 100
    or (p_status is not null and p_status not in ('covered', 'immature', 'partial', 'ambiguous'))
    or (p_cursor_at is null) <> (p_cursor_merge_id is null)
    or (p_cursor_at is not null and (not isfinite(p_cursor_at) or p_cursor_at < p_from or p_cursor_at >= p_to))
  then raise exception 'Invalid factory revert evidence filter or cursor.' using errcode = '22023'; end if;

  with page as materialized (
    select cohort.* from internal.factory_revert_cohort(p_workspace_id, p_factory_id, p_from, p_to, as_of) cohort
    where (p_status is null or cohort.status = p_status)
      and (p_has_verified_revert is null or cohort.has_verified_revert = p_has_verified_revert)
      and (p_cursor_at is null or (cohort.original_merged_at, cohort.original_merge_id) >
        (p_cursor_at, p_cursor_merge_id))
    order by cohort.original_merged_at, cohort.original_merge_id
    limit p_limit + 1
  ), visible as materialized (
    select * from page order by original_merged_at, original_merge_id limit p_limit
  )
  select jsonb_build_object(
    'metricKey', 'canonical_revert_rate', 'metricRevision', 1,
    'window', jsonb_build_object('from', p_from, 'to', p_to, 'asOf', as_of, 'observationWindowSeconds', 2592000),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'originalMergeId', fact.original_merge_id, 'originalObservationId', fact.original_observation_id,
        'originalMergeSha', fact.original_merge_sha, 'originalMergedAt', fact.original_merged_at,
        'sessionId', fact.session_id, 'repositoryId', fact.repository_id, 'baseBranch', fact.base_branch,
        'pullRequestNumber', fact.pull_request_number, 'windowEndsAt', fact.window_ends_at, 'status', fact.status,
        'hasCompleteCoverage', fact.has_complete_coverage, 'hasVerifiedRevert', fact.has_verified_revert,
        'verifiedRelationshipCount', fact.verified_relationship_count,
        'unresolvedRelationshipCount', fact.unresolved_relationship_count,
        'relationships', evidence.items, 'relationshipsTruncated', evidence.truncated,
        'coverageIds', coverage.ids, 'coverageCount', fact.coverage_count
      ) order by fact.original_merged_at, fact.original_merge_id)
      from visible fact
      cross join lateral (
        with revisions as materialized (
          select link.*, effective.id is not null as current,
            internal.factory_revert_link_state(link, fact.original_merge_sha, fact.original_merged_at, as_of) as state
          from internal.factory_revert_relationship_revisions link
          left join internal.current_factory_revert_relationships effective on effective.id = link.id
          where (link.workspace_id, link.factory_id, link.original_merge_id, link.repository_id, link.base_branch) =
            (p_workspace_id, p_factory_id, fact.original_merge_id, fact.repository_id, fact.base_branch)
            and link.observed_at <= as_of
          order by (effective.id is not null) desc, link.observed_at desc, link.id desc limit 51
        )
        select coalesce((
          select jsonb_agg(jsonb_build_object(
            'observationId', link.id, 'revision', link.revision, 'current', link.current,
            'status', link.status, 'evidenceState', link.state,
            'stale', (link.original_merge_sha, link.original_merged_at) is distinct from
              (fact.original_merge_sha, fact.original_merged_at),
            'originalObservationId', link.original_observation_id, 'originalMergeSha', link.original_merge_sha,
            'originalMergedAt', link.original_merged_at, 'revertPrNumber', link.revert_pr_number,
            'revertMergeSha', link.revert_merge_sha, 'revertMergedAt', link.revert_merged_at,
            'providerUpdatedAt', link.revert_provider_updated_at, 'observedAt', link.observed_at,
            'actorMemberId', link.actor_member_id,
            'withinWindow', link.state = 'confirmed' and link.revert_merged_at <= fact.window_ends_at
          ) order by link.current desc, link.observed_at desc, link.id desc)
          from (select * from revisions order by current desc, observed_at desc, id desc limit 50) link
        ), '[]'::jsonb) as items, (select count(*) > 50 from revisions) as truncated
      ) evidence
      cross join lateral (
        select coalesce(jsonb_agg(source.id order by source.coverage_from, source.id), '[]'::jsonb) as ids
        from (
          select covering.id, covering.coverage_from
          from internal.factory_revert_coverage_for_window(
            p_workspace_id, p_factory_id, fact.repository_id, fact.base_branch,
            fact.original_merged_at, fact.window_ends_at, as_of
          ) covering
          order by covering.coverage_from, covering.id limit 50
        ) source
      ) coverage
    ), '[]'::jsonb),
    'nextCursor', case when (select count(*) from page) > p_limit then (
      select jsonb_build_object('at', original_merged_at, 'mergeId', original_merge_id)
      from visible order by original_merged_at desc, original_merge_id desc limit 1
    ) end
  ) into result;
  return result;
end;
$$;

-- Cost ratios use the exact observed canonical merges from the cost summary.
-- Throughput and revert use different eligibility clocks.
create function public.list_factory_cost_merges(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz,
  p_limit integer default 50, p_cursor_at timestamptz default null, p_cursor_merge_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
begin
  perform internal.require_factory_cost_scope(p_workspace_id, p_factory_id, p_from, p_to);
  if p_limit is null or p_limit not between 1 and 100
    or num_nonnulls(p_cursor_at, p_cursor_merge_id) not in (0, 2)
    or (p_cursor_at is not null and (p_cursor_at < p_from or p_cursor_at >= p_to))
  then raise exception 'Invalid factory cost merge cursor.' using errcode = '22023'; end if;

  with page as materialized (
    select fact.id, fact.observation_id, fact.session_id, fact.repository_id, fact.pull_request_number,
      fact.merged_at, fact.merge_commit_sha
    from public.session_pr_epochs epoch
    join public.sessions session on (session.workspace_id, session.id) = (epoch.workspace_id, epoch.session_id)
    join internal.current_factory_canonical_pull_request_merges fact
      on (fact.workspace_id, fact.factory_id, fact.epoch_id) = (session.workspace_id, session.factory_id, epoch.id)
    where (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id)
      and epoch.pr_state = 'merged' and fact.status = 'observed' and fact.merged_at >= p_from and fact.merged_at < p_to
      and (p_cursor_at is null or (fact.merged_at, fact.id) > (p_cursor_at, p_cursor_merge_id))
    order by fact.merged_at, fact.id limit p_limit + 1
  ), visible as materialized (
    select * from page order by merged_at, id limit p_limit
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'mergeId', fact.id, 'mergeObservationId', fact.observation_id, 'sessionId', fact.session_id,
        'repositoryId', fact.repository_id, 'pullRequestNumber', fact.pull_request_number,
        'mergedAt', fact.merged_at, 'mergeCommitSha', fact.merge_commit_sha
      ) order by fact.merged_at, fact.id) from visible fact
    ), '[]'::jsonb),
    'nextCursor', case when (select count(*) from page) > p_limit then (
      select jsonb_build_object('at', merged_at, 'mergeId', id)
      from visible order by merged_at desc, id desc limit 1
    ) end
  ) into result;
  return result;
end;
$$;

revoke all on function public.list_factory_flow_evidence(
  uuid, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid, timestamptz, text
), public.list_factory_revert_evidence(
  uuid, uuid, timestamptz, timestamptz, text, integer, timestamptz, uuid, boolean
), public.list_factory_cost_contributions(uuid, uuid, timestamptz, timestamptz, text, uuid, integer, uuid, text),
  public.list_factory_cost_merges(uuid, uuid, timestamptz, timestamptz, integer, timestamptz, uuid)
from public, anon, authenticated, service_role;

grant execute on function public.list_factory_flow_evidence(
  uuid, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid, timestamptz, text
), public.list_factory_revert_evidence(
  uuid, uuid, timestamptz, timestamptz, text, integer, timestamptz, uuid, boolean
) to authenticated;
grant execute on function
  public.list_factory_cost_contributions(uuid, uuid, timestamptz, timestamptz, text, uuid, integer, uuid, text),
  public.list_factory_cost_merges(uuid, uuid, timestamptz, timestamptz, integer, timestamptz, uuid)
to authenticated, service_role;
