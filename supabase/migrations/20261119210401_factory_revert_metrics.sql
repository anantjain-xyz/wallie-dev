insert into internal.factory_outcome_metric_revisions (metric_key, revision, definition) values
  ('canonical_revert_rate', 1, '{
    "unit":"fraction","population":"unique_verified_merges","observationSources":["pull_requests","reverts"],
    "observationWindowSeconds":2592000,"numerator":"originals_with_verified_revert_in_window",
    "denominator":"mature_unambiguous_originals_with_continuous_exact_branch_coverage"
  }');

create function internal.factory_revert_link_state(
  p_link internal.factory_revert_relationship_revisions, p_original_merge_sha text,
  p_original_merged_at timestamptz, p_as_of timestamptz
) returns text language sql stable set search_path = '' as $$
  select case
    when p_link.status = 'invalidated' then 'invalidated'
    when (p_link.original_merge_sha, p_link.original_merged_at) is distinct from
      (p_original_merge_sha, p_original_merged_at) then 'stale'
    when p_link.status = 'candidate' then 'candidate'
    when p_link.status = 'confirmed' and p_link.revert_merge_sha is not null
      and p_link.revert_merged_at > p_original_merged_at
      and p_link.revert_merged_at <= least(p_link.observed_at, p_as_of) then 'confirmed'
    else 'untrusted'
  end
$$;
revoke all on function internal.factory_revert_link_state(
  internal.factory_revert_relationship_revisions, text, timestamptz, timestamptz
) from public, anon, authenticated, service_role;

create function internal.factory_revert_coverage_for_window(
  p_workspace_id uuid, p_factory_id uuid, p_repository_id uuid, p_base_branch text,
  p_window_start timestamptz, p_window_end timestamptz, p_as_of timestamptz
) returns setof internal.factory_revert_coverage language sql stable set search_path = '' as $$
  select coverage.*
  from internal.factory_revert_coverage coverage
  where (coverage.workspace_id, coverage.factory_id, coverage.repository_id, coverage.base_branch) =
    (p_workspace_id, p_factory_id, p_repository_id, p_base_branch)
    and coverage.coverage_from <= p_window_end and coverage.coverage_through >= p_window_start
    and coverage.recorded_at <= p_as_of and coverage.withdrawn_at is null
$$;
revoke all on function internal.factory_revert_coverage_for_window(
  uuid, uuid, uuid, text, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated, service_role;

create function internal.factory_revert_cohort(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_as_of timestamptz
) returns table (
  original_merge_id uuid, original_observation_id uuid, original_merge_sha text, original_merged_at timestamptz,
  session_id uuid, repository_id uuid, base_branch text, pull_request_number integer, window_ends_at timestamptz,
  status text, has_complete_coverage boolean, has_verified_revert boolean,
  verified_relationship_count bigint, unresolved_relationship_count bigint, coverage_count bigint
) language sql stable set search_path = '' as $$
  with originals as materialized (
    select merge.id, merge.observation_id, merge.merge_commit_sha, merge.merged_at,
      merge.session_id, merge.repository_id, epoch.base_branch, merge.pull_request_number,
      merge.merged_at + interval '720 hours' as window_ends_at
    from internal.current_factory_canonical_pull_request_merges merge
    join public.session_pr_epochs epoch on (epoch.id, epoch.workspace_id, epoch.session_id) =
      (merge.epoch_id, merge.workspace_id, merge.session_id)
    where (merge.workspace_id, merge.factory_id, merge.status) = (p_workspace_id, p_factory_id, 'observed')
      and merge.merged_at >= p_from and merge.merged_at < p_to
      and merge.merged_at <= merge.observed_at and merge.observed_at <= p_as_of
  ), findings as (
    select original.*, events.verified_count, events.unresolved_count,
      coverage.complete, coverage.coverage_count
    from originals original
    cross join lateral (
      select count(*) filter (where evidence.state = 'confirmed' and evidence.revert_merged_at <= original.window_ends_at) as verified_count,
        count(*) filter (where evidence.state in ('candidate', 'stale', 'untrusted')) as unresolved_count
      from (
        select link.revert_merged_at,
          internal.factory_revert_link_state(link, original.merge_commit_sha, original.merged_at, p_as_of) as state
        from internal.factory_revert_relationship_revisions link
        join internal.current_factory_revert_relationships effective on effective.id = link.id
        where (link.workspace_id, link.factory_id, link.original_merge_id, link.repository_id, link.base_branch) =
          (p_workspace_id, p_factory_id, original.id, original.repository_id, original.base_branch)
          and link.observed_at <= p_as_of
      ) evidence
    ) events
    cross join lateral (
      select coalesce(range_agg(tstzrange(coverage.coverage_from, coverage.coverage_through, '[]')) @>
          tstzrange(original.merged_at, original.window_ends_at, '[]'), false) as complete,
        count(*) as coverage_count
      from internal.factory_revert_coverage_for_window(
        p_workspace_id, p_factory_id, original.repository_id, original.base_branch,
        original.merged_at, original.window_ends_at, p_as_of
      ) coverage
    ) coverage
  )
  select fact.id, fact.observation_id, fact.merge_commit_sha, fact.merged_at,
    fact.session_id, fact.repository_id, fact.base_branch, fact.pull_request_number, fact.window_ends_at,
    case when fact.window_ends_at > p_as_of then 'immature'
      when fact.unresolved_count > 0 and fact.verified_count = 0 then 'ambiguous'
      when not fact.complete then 'partial'
      else 'covered' end,
    fact.complete, fact.verified_count > 0, fact.verified_count, fact.unresolved_count, fact.coverage_count
  from findings fact
$$;
revoke all on function internal.factory_revert_cohort(uuid, uuid, timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

create function public.get_factory_revert_summary(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
  as_of timestamptz := statement_timestamp();
begin
  perform internal.require_factory_flow_window(p_workspace_id, p_factory_id, p_from, p_to, null);
  with totals as (
    select count(*) as observed_count,
      count(*) filter (where cohort.status = 'covered') as covered_count,
      count(*) filter (where cohort.status = 'covered' and cohort.has_verified_revert) as reverted_covered_count,
      count(*) filter (where cohort.has_verified_revert) as verified_reverted_count,
      count(*) filter (where cohort.status = 'immature') as immature_count,
      count(*) filter (where cohort.status = 'partial') as partial_count,
      count(*) filter (where cohort.status = 'ambiguous') as ambiguous_count
    from internal.factory_revert_cohort(p_workspace_id, p_factory_id, p_from, p_to, as_of) cohort
  ), coverage as (
    select (
        select source.live_from from internal.factory_outcome_capture_coverage source where source.source = 'pull_requests'
      ) as capture_started_at,
      (
        select source.live_from from internal.factory_outcome_capture_coverage source where source.source = 'reverts'
      ) as revert_evidence_started_at,
      count(*) as unresolved_count
    from public.session_pr_epochs epoch
    join public.sessions session on (session.workspace_id, session.id) = (epoch.workspace_id, epoch.session_id)
    left join internal.current_factory_canonical_pull_request_merges merge
      on (merge.workspace_id, merge.factory_id, merge.epoch_id) = (session.workspace_id, session.factory_id, epoch.id)
    where (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id)
      and epoch.pr_state = 'merged' and (
        merge.status is distinct from 'observed' or merge.merged_at > merge.observed_at or merge.observed_at > as_of
      )
      and epoch.created_at < p_to and (epoch.pr_updated_at is null or epoch.pr_updated_at >= p_from)
  )
  select jsonb_build_object(
    'metricKey', 'canonical_revert_rate', 'metricRevision', 1,
    'window', jsonb_build_object('from', p_from, 'to', p_to, 'asOf', as_of, 'observationWindowSeconds', 2592000),
    'observedMergeCount', totals.observed_count, 'coveredMatureCount', totals.covered_count,
    'revertedCoveredCount', totals.reverted_covered_count, 'verifiedRevertedCount', totals.verified_reverted_count,
    'immatureCount', totals.immature_count, 'partialCount', totals.partial_count, 'ambiguousCount', totals.ambiguous_count,
    'revertRate', totals.reverted_covered_count::numeric / nullif(totals.covered_count, 0),
    'coverage', jsonb_build_object(
      'captureStartedAt', coverage.capture_started_at, 'revertEvidenceStartedAt', coverage.revert_evidence_started_at,
      'unresolvedOriginalCount', coverage.unresolved_count,
      'partial', coverage.capture_started_at is null or p_from < coverage.capture_started_at
        or p_to > as_of or coverage.unresolved_count > 0 or totals.observed_count > totals.covered_count
    )
  ) into result from totals cross join coverage;
  return result;
end;
$$;

create function public.list_factory_revert_evidence(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz,
  p_status text default null, p_limit integer default 25,
  p_cursor_at timestamptz default null, p_cursor_merge_id uuid default null
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

revoke all on function public.get_factory_revert_summary(uuid, uuid, timestamptz, timestamptz),
  public.list_factory_revert_evidence(uuid, uuid, timestamptz, timestamptz, text, integer, timestamptz, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_factory_revert_summary(uuid, uuid, timestamptz, timestamptz),
  public.list_factory_revert_evidence(uuid, uuid, timestamptz, timestamptz, text, integer, timestamptz, uuid)
to authenticated;
