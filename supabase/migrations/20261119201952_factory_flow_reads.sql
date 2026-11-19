create function internal.require_factory_flow_window(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_environment text
) returns void language plpgsql stable set search_path = '' as $$
begin
  if not internal.can_access_factory(p_workspace_id, p_factory_id) then
    raise exception 'Factory not found.' using errcode = 'PT404';
  end if;
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or (p_environment is not null and p_environment !~ '^[a-z0-9][a-z0-9._-]{0,63}$')
  then raise exception 'Invalid factory outcome window.' using errcode = '22023'; end if;
  if p_to <= p_from
    or extract(epoch from p_to) - extract(epoch from p_from) > extract(epoch from interval '366 days')
  then
    raise exception 'A factory outcome window must be within 366 days.' using errcode = '22023';
  end if;
end;
$$;
revoke all on function internal.require_factory_flow_window(uuid, uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;

create function internal.factory_flow_delivery_samples(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_environment text,
  p_limit integer default null, p_cursor_at timestamptz default null, p_cursor_session_id uuid default null
) returns table (
  session_id uuid, requested_at timestamptz, request_observation_id uuid,
  merge_status text, merged_at timestamptz, canonical_merge_id uuid, merge_observation_id uuid,
  deployment_status text, deployed_at timestamptz, deployment_id uuid, deployment_observation_id uuid,
  deployment_environment text, deployment_merge_id uuid, deployment_merge_observation_id uuid
) language sql stable set search_path = '' as $$
  with cohort as materialized (
    select projected.session_id, projected.requested_at, projected.request_observation_id
    from internal.factory_flow_projection_sessions projected
    where (projected.workspace_id, projected.factory_id) = (p_workspace_id, p_factory_id)
      and projected.requested_at >= p_from and projected.requested_at < p_to
      and (p_cursor_at is null or (projected.requested_at, projected.session_id) >
        (p_cursor_at, p_cursor_session_id))
    order by projected.requested_at, projected.session_id
    limit p_limit
  ), coverage as (
    select max(live_from) filter (where source = 'lifecycle') as lifecycle_from,
      max(live_from) filter (where source = 'pull_requests') as pull_requests_from,
      max(live_from) filter (where source = 'deployments') as deployments_from
    from internal.factory_outcome_capture_coverage
  ), delivery_ends as (
    select distinct on (request.session_id) request.session_id,
      source.deployment_id, source.deployment_observation_id, source.environment,
      source.deployed_at, source.canonical_merge_id, source.merge_observation_id,
      (source.merged_at >= request.requested_at and source.deployed_at <= statement_timestamp()) as eligible
    from internal.current_factory_linked_deployment_deliveries source
    join cohort request on request.session_id = source.session_id
    where (source.workspace_id, source.factory_id) = (p_workspace_id, p_factory_id)
      and (p_environment is null or source.environment = p_environment)
    order by request.session_id, eligible desc, source.deployed_at, source.deployment_id
  )
  select request.session_id, request.requested_at, request.request_observation_id,
    case when merge.eligible then 'measured'
      when merge.id is not null then 'unknown'
      when coverage.lifecycle_from is not null and coverage.pull_requests_from is not null
        and request.requested_at >= greatest(coverage.lifecycle_from, coverage.pull_requests_from)
        and request.requested_at <= statement_timestamp() then 'censored'
      else 'unknown' end as merge_status,
    case when merge.eligible then merge.merged_at end, merge.id, merge.observation_id,
    case when deployment.eligible then 'measured'
      when deployment.deployment_id is not null or (merge.id is not null and not merge.eligible)
        then 'unknown'
      when coverage.lifecycle_from is not null and coverage.pull_requests_from is not null
        and coverage.deployments_from is not null
        and request.requested_at >= greatest(coverage.lifecycle_from, coverage.pull_requests_from,
          coverage.deployments_from)
        and request.requested_at <= statement_timestamp() then 'censored'
      else 'unknown' end as deployment_status,
    case when deployment.eligible then deployment.deployed_at end,
    deployment.deployment_id, deployment.deployment_observation_id, deployment.environment,
    deployment.canonical_merge_id, deployment.merge_observation_id
  from cohort request
  cross join coverage
  left join lateral (
    select source.id, source.observation_id, source.merged_at,
      coalesce(source.status = 'observed' and source.merged_at >= request.requested_at
        and source.merged_at <= statement_timestamp(), false) as eligible
    from internal.current_factory_canonical_pull_request_merges source
    where (source.workspace_id, source.factory_id, source.session_id) =
      (p_workspace_id, p_factory_id, request.session_id)
    order by eligible desc, source.merged_at nulls last, source.id
    limit 1
  ) merge on true
  left join delivery_ends deployment on deployment.session_id = request.session_id
$$;
revoke all on function internal.factory_flow_delivery_samples(
  uuid, uuid, timestamptz, timestamptz, text, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;

create function public.get_factory_flow_summary(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz,
  p_environment text default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  summary jsonb;
begin
  perform internal.require_factory_flow_window(p_workspace_id, p_factory_id, p_from, p_to, p_environment);
  with phases(phase) as (
    values ('queued'), ('active'), ('blocked'), ('review'), ('delivery'), ('unknown')
  ), flow as (
    select segment.phase, count(*) as segments, count(distinct segment.session_id) as sessions,
      sum(extract(epoch from least(segment.ended_at, p_to) - greatest(segment.started_at, p_from))) as seconds
    from internal.factory_flow_projection_segments segment
    where (segment.workspace_id, segment.factory_id) = (p_workspace_id, p_factory_id)
      and segment.started_at < p_to and segment.ended_at > p_from
    group by segment.phase
  ), open_requests as (
    select open_phase.phase, count(*) as sessions
    from internal.factory_flow_projection_sessions request
    cross join lateral unnest(request.open_phases) open_phase(phase)
    where (request.workspace_id, request.factory_id) = (p_workspace_id, p_factory_id)
      and request.requested_at >= p_from and request.requested_at < p_to
    group by open_phase.phase
  ), coverage as (
    select max(live_from) filter (where source = 'lifecycle') as lifecycle_from,
      max(live_from) filter (where source = 'pull_requests') as pull_requests_from,
      max(live_from) filter (where source = 'deployments') as deployments_from
    from internal.factory_outcome_capture_coverage
  ), delivery as (
    select timing.kind, timing.status, extract(epoch from timing.delivered_at - sample.requested_at) as seconds
    from internal.factory_flow_delivery_samples(p_workspace_id, p_factory_id, p_from, p_to, p_environment) sample
    cross join lateral (values ('merge', sample.merge_status, sample.merged_at),
      ('deployment', sample.deployment_status, sample.deployed_at)) timing(kind, status, delivered_at)
  ), distributions as (
    select kind.name, count(delivery.status) as total,
      count(*) filter (where delivery.status = 'measured') as measured,
      count(*) filter (where delivery.status = 'censored') as censored,
      count(*) filter (where delivery.status = 'unknown') as unknown,
      case when count(delivery.seconds) > 0 then jsonb_build_object(
        'minSeconds', min(delivery.seconds),
        'p50Seconds', percentile_cont(0.5) within group (order by delivery.seconds::double precision),
        'p95Seconds', percentile_cont(0.95) within group (order by delivery.seconds::double precision),
        'maxSeconds', max(delivery.seconds)
      ) end as distribution
    from (values ('merge'), ('deployment')) kind(name)
    left join delivery on delivery.kind = kind.name
    group by kind.name
  )
  select jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to', p_to, 'deploymentEnvironment', p_environment),
    'metricRevisions', jsonb_build_object('workflow_flow', 1, 'request_to_merge', 1, 'request_to_deployment', 1),
    'coverage', jsonb_build_object(
      'lifecycleFrom', coverage.lifecycle_from,
      'pullRequestsFrom', coverage.pull_requests_from,
      'deploymentsFrom', coverage.deployments_from,
      'lifecycleWindowCovered', coalesce(p_from >= coverage.lifecycle_from and p_to <= statement_timestamp(), false),
      'deploymentProviderCompleteness', 'unknown',
      'openRequests', (
        select jsonb_object_agg(phases.phase, coalesce(open_requests.sessions, 0))
        from phases left join open_requests using (phase)
      ),
      'unplacedSessions', (
        select count(*) from internal.factory_flow_projection_sessions request
        where (request.workspace_id, request.factory_id) = (p_workspace_id, p_factory_id)
          and request.requested_at is null
      )
    ),
    'freshness', jsonb_build_object(
      'status', case when watermark.status = 'failed' then 'failed'
        when exists (
          select 1 from internal.factory_flow_projection_dirty_sessions dirty
          where (dirty.workspace_id, dirty.factory_id) = (p_workspace_id, p_factory_id)
        ) then 'building'
        else coalesce(watermark.status, 'unavailable') end,
      'lastSuccessAt', watermark.last_success_at,
      'sourceSnapshotAt', watermark.source_snapshot_at,
      'evaluatedAt', statement_timestamp()
    ),
    'flow', (
      select jsonb_object_agg(phases.phase, jsonb_build_object(
        'seconds', coalesce(flow.seconds, 0), 'segments', coalesce(flow.segments, 0),
        'sessions', coalesce(flow.sessions, 0)
      ))
      from phases left join flow using (phase)
    )
  ) || (
    select jsonb_object_agg(distributions.name, to_jsonb(distributions) - 'name')
    from distributions
  ) into summary
  from coverage
  left join internal.factory_outcome_projection_watermarks watermark on
    (watermark.workspace_id, watermark.factory_id, watermark.metric_key, watermark.metric_revision) =
    (p_workspace_id, p_factory_id, 'workflow_flow', 1);
  return summary;
end;
$$;
revoke all on function public.get_factory_flow_summary(uuid, uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_factory_flow_summary(uuid, uuid, timestamptz, timestamptz, text)
  to authenticated;

create function public.list_factory_flow_evidence(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_metric_key text,
  p_environment text default null, p_limit integer default 50, p_cursor_at timestamptz default null,
  p_cursor_session_id uuid default null, p_cursor_end_at timestamptz default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
begin
  perform internal.require_factory_flow_window(p_workspace_id, p_factory_id, p_from, p_to, p_environment);
  if p_metric_key is null or p_metric_key not in ('workflow_flow', 'request_to_merge', 'request_to_deployment')
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
      where p_metric_key = 'workflow_flow'
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
        case when p_metric_key = 'workflow_flow' then 0 else p_limit + 1 end,
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
    ) evidence
    order by evidence.cursor_at, evidence.session_id, evidence.cursor_end_at
    limit p_limit + 1
  ), visible as materialized (
    select * from page order by cursor_at, session_id, cursor_end_at limit p_limit
  )
  select jsonb_build_object(
    'metricRevision', 1,
    'items', coalesce(
      (select jsonb_agg(item order by cursor_at, session_id, cursor_end_at) from visible),
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
revoke all on function public.list_factory_flow_evidence(
  uuid, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.list_factory_flow_evidence(
  uuid, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid, timestamptz
) to authenticated;
