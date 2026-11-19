-- The queue is written in the same transaction as each source observation.
-- A timestamp cursor alone could skip an observation committed out of order.
create table internal.factory_flow_projection_dirty_sessions (
  session_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  queued_at timestamptz not null,
  foreign key (session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) on delete cascade
);
create index factory_flow_projection_dirty_queue_idx
  on internal.factory_flow_projection_dirty_sessions (queued_at, session_id);
create index factory_flow_projection_dirty_scope_idx
  on internal.factory_flow_projection_dirty_sessions (workspace_id, factory_id, queued_at, session_id);

create table internal.factory_flow_projection_sessions (
  session_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  requested_at timestamptz,
  request_observation_id uuid,
  last_observation_at timestamptz,
  source_snapshot_at timestamptz not null,
  open_phases text[] not null,
  foreign key (session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) on delete cascade,
  unique (session_id, workspace_id, factory_id),
  check ((requested_at is null) = (request_observation_id is null))
);
create index factory_flow_projection_sessions_cohort_idx
  on internal.factory_flow_projection_sessions (workspace_id, factory_id, requested_at, session_id);

create table internal.factory_flow_projection_segments (
  session_id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  phase text not null check (phase in ('queued', 'active', 'blocked', 'review', 'delivery', 'unknown')),
  started_at timestamptz not null,
  ended_at timestamptz not null check (ended_at > started_at),
  observation_ids uuid[] not null check (cardinality(observation_ids) > 0),
  primary key (session_id, started_at),
  foreign key (session_id, workspace_id, factory_id)
    references internal.factory_flow_projection_sessions(session_id, workspace_id, factory_id) on delete cascade
);
create index factory_flow_projection_segments_cohort_idx
  on internal.factory_flow_projection_segments (workspace_id, factory_id, started_at, session_id);

alter table internal.factory_flow_projection_dirty_sessions enable row level security;
alter table internal.factory_flow_projection_sessions enable row level security;
alter table internal.factory_flow_projection_segments enable row level security;
revoke all on internal.factory_flow_projection_dirty_sessions, internal.factory_flow_projection_sessions,
  internal.factory_flow_projection_segments from public, anon, authenticated, service_role;

create function internal.queue_factory_flow_session()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.session_id is null then return new; end if;
  insert into internal.factory_flow_projection_dirty_sessions as dirty(session_id, workspace_id, factory_id, queued_at)
  values (new.session_id, new.workspace_id, new.factory_id, new.observed_at)
  on conflict (session_id) do update set queued_at = least(dirty.queued_at, excluded.queued_at);
  return new;
end;
$$;
revoke all on function internal.queue_factory_flow_session() from public, anon, authenticated, service_role;
create trigger queue_factory_flow_session after insert on internal.factory_outcome_observations
  for each row when (new.session_id is not null) execute function internal.queue_factory_flow_session();

insert into internal.factory_flow_projection_dirty_sessions(session_id, workspace_id, factory_id, queued_at)
select session_id, workspace_id, factory_id, min(observed_at)
from internal.factory_outcome_observations
where session_id is not null
group by session_id, workspace_id, factory_id
on conflict (session_id) do nothing;

create function internal.factory_flow_observed_intervals(p_session_id uuid)
returns table (phase text, started_at timestamptz, ended_at timestamptz, start_id uuid, end_id uuid)
language sql stable set search_path = '' as $$
  with facts as materialized (
    select observation.* from internal.factory_outcome_observations observation
    where observation.session_id = p_session_id
  )
  select 'queued', queued.occurred_at, endpoint.occurred_at, queued.id, endpoint.id
  from facts queued
  left join lateral (
    select fact.id, fact.occurred_at from facts fact
    where fact.job_id = queued.job_id and fact.occurred_at >= queued.occurred_at and (
      (fact.event_type = 'run.started' and fact.attempt_count = queued.attempt_count)
      or (queued.capture_mode = 'live' and (
        (fact.event_type = 'job.queued' and fact.attempt_count = queued.attempt_count + 1)
        or (fact.event_type = 'job.finished' and fact.status in ('canceled', 'error')
          and coalesce(fact.attempt_count, 0) in (queued.attempt_count - 1, queued.attempt_count))
      ))
    )
    order by fact.occurred_at, fact.id limit 1
  ) endpoint on true
  where queued.event_type = 'job.queued'

  union all
  select 'active', started.occurred_at, endpoint.occurred_at, started.id, endpoint.id
  from facts started
  left join lateral (
    select fact.id, fact.occurred_at from facts fact
    where fact.event_type = 'run.finished' and (fact.run_id, fact.attempt_count) =
      (started.run_id, started.attempt_count) and fact.occurred_at >= started.occurred_at
    order by fact.occurred_at, fact.id limit 1
  ) endpoint on true
  where started.event_type = 'run.started'

  union all
  select 'review', ready.occurred_at, endpoint.occurred_at, ready.id, endpoint.id
  from facts ready
  left join lateral (
    select fact.id, fact.occurred_at from facts fact
    where fact.occurred_at >= ready.occurred_at and (
      (fact.artifact_id = ready.artifact_id and fact.event_type in ('review.approved', 'review.changes_requested'))
      or (fact.event_type = 'session.canceled' and fact.run_id = ready.run_id)
    )
    order by fact.occurred_at, fact.id limit 1
  ) endpoint on true
  where ready.event_type = 'review.ready'

  union all
  select 'blocked', requested.occurred_at, endpoint.occurred_at, requested.id, endpoint.id
  from facts requested
  left join lateral (
    select fact.id, fact.occurred_at from facts fact
    where fact.occurred_at >= requested.occurred_at and (
      (fact.event_type = 'review.clarification_answered' and (fact.source_kind, fact.source_key) =
        (requested.source_kind, requested.source_key))
      or (fact.event_type = 'session.canceled' and fact.run_id = requested.run_id)
    )
    order by fact.occurred_at, fact.id limit 1
  ) endpoint on true
  where requested.event_type = 'review.clarification_requested'

  union all
  select 'delivery', approval.occurred_at, endpoint.occurred_at, approval.id, endpoint.id
  from facts approval
  left join lateral (
    select fact.id, fact.occurred_at from internal.current_factory_canonical_pull_request_merges merge
    join facts fact on fact.event_type = 'pull_request.merged'
      and fact.source_kind = 'github_canonical_pull_request' and fact.source_key = merge.observation_id::text
    where (merge.workspace_id, merge.factory_id, merge.session_id) =
      (approval.workspace_id, approval.factory_id, approval.session_id)
      and merge.status = 'observed' and merge.merged_at between approval.occurred_at and statement_timestamp()
    order by merge.merged_at, merge.id limit 1
  ) endpoint on true
  where approval.event_type = 'review.approved' and approval.status = 'approved'
$$;
revoke all on function internal.factory_flow_observed_intervals(uuid) from public, anon, authenticated, service_role;

create function internal.rebuild_factory_flow_session(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid, p_snapshot_at timestamptz
) returns void language plpgsql set search_path = '' as $$
declare
  request internal.factory_outcome_observations%rowtype;
  last_observed_at timestamptz;
  unfinished text[];
begin
  select fact.* into request from internal.factory_outcome_observations fact
  where (fact.session_id, fact.workspace_id, fact.factory_id) = (p_session_id, p_workspace_id, p_factory_id)
    and fact.event_type = 'session.created'
  order by fact.occurred_at, fact.id limit 1;
  select max(fact.observed_at) into last_observed_at from internal.factory_outcome_observations fact
  where (fact.session_id, fact.workspace_id, fact.factory_id) = (p_session_id, p_workspace_id, p_factory_id);
  select coalesce(array_agg(distinct interval.phase order by interval.phase), '{}'::text[]) into unfinished
  from internal.factory_flow_observed_intervals(p_session_id) interval
  where interval.ended_at is null;

  insert into internal.factory_flow_projection_sessions (
    session_id, workspace_id, factory_id, requested_at, request_observation_id,
    last_observation_at, source_snapshot_at, open_phases
  ) values (
    p_session_id, p_workspace_id, p_factory_id, request.occurred_at, request.id,
    last_observed_at, p_snapshot_at, unfinished
  ) on conflict (session_id) do update set
    requested_at = excluded.requested_at, request_observation_id = excluded.request_observation_id,
    last_observation_at = excluded.last_observation_at, source_snapshot_at = excluded.source_snapshot_at,
    open_phases = excluded.open_phases;

  delete from internal.factory_flow_projection_segments where session_id = p_session_id;
  -- Sweep all observed boundaries. Nested clarification and execution spans
  -- take precedence. Empty gaps stay unknown and every edge retains its source IDs.
  insert into internal.factory_flow_projection_segments (
    session_id, workspace_id, factory_id, phase, started_at, ended_at, observation_ids
  )
  with candidates as materialized (
    select interval.* from internal.factory_flow_observed_intervals(p_session_id) interval
    where interval.ended_at > interval.started_at
  ), boundary_observations as (
    select fact.occurred_at as edge, fact.id as observation_id
    from internal.factory_outcome_observations fact
    where fact.session_id = p_session_id and fact.event_type in (
      'session.created', 'session.canceled', 'job.queued', 'job.finished', 'run.started', 'run.finished',
      'review.ready', 'review.approved', 'review.changes_requested',
      'review.clarification_requested', 'review.clarification_answered'
    )
    union all
    select candidate.ended_at, candidate.end_id
    from candidates candidate where candidate.phase = 'delivery'
  ), points as (
    select boundary.edge,
      array_agg(distinct boundary.observation_id order by boundary.observation_id) as edge_ids
    from boundary_observations boundary group by boundary.edge
  ), subintervals as (
    select edge, edge_ids, lead(edge) over (order by edge) as next_edge,
      lead(edge_ids) over (order by edge) as next_edge_ids
    from points
  )
  select p_session_id, p_workspace_id, p_factory_id, coalesce(chosen.phase, 'unknown'), span.edge, span.next_edge,
    array(
      select distinct value
      from unnest(span.edge_ids || span.next_edge_ids ||
        case when chosen.start_id is null then '{}'::uuid[] else array[chosen.start_id, chosen.end_id] end) value
      order by value
    )
  from subintervals span
  left join lateral (
    select candidate.* from candidates candidate
    where candidate.started_at <= span.edge and candidate.ended_at >= span.next_edge
    order by array_position(array['active', 'blocked', 'review', 'queued', 'delivery'], candidate.phase),
      candidate.started_at, candidate.start_id limit 1
  ) chosen on true
  where span.next_edge is not null;
end;
$$;
revoke all on function internal.rebuild_factory_flow_session(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

create function public.enqueue_factory_flow_rebuild(
  p_workspace_id uuid, p_factory_id uuid, p_after_session_id uuid default null, p_limit integer default 100
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare enqueued integer; next_session_id uuid;
begin
  if p_limit is null or p_limit not between 1 and 250 then
    raise exception 'Invalid factory flow rebuild batch size.' using errcode = '22023';
  end if;
  if not internal.can_manage_factory(p_workspace_id, p_factory_id) or not exists (
    select 1 from public.factories factory
    join public.workspaces workspace on workspace.id = factory.workspace_id
    where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id) and workspace.deletion_requested_at is null
  ) then raise exception 'Factory flow projection is unavailable.' using errcode = 'PT404'; end if;
  with batch as materialized (
    select session.id from public.sessions session
    where (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id)
      and (p_after_session_id is null or session.id > p_after_session_id)
    order by session.id limit p_limit
  ), queued as (
    insert into internal.factory_flow_projection_dirty_sessions as dirty(session_id, workspace_id, factory_id, queued_at)
    select id, p_workspace_id, p_factory_id, clock_timestamp() from batch
    on conflict (session_id) do update set queued_at = least(dirty.queued_at, excluded.queued_at)
    returning session_id
  )
  select count(*)::integer, (array_agg(session_id order by session_id desc))[1]
    into enqueued, next_session_id from queued;
  return jsonb_build_object('enqueued', enqueued, 'nextSessionId',
    case when enqueued = p_limit then next_session_id end);
end;
$$;
revoke all on function public.enqueue_factory_flow_rebuild(uuid, uuid, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.enqueue_factory_flow_rebuild(uuid, uuid, uuid, integer) to authenticated, service_role;

create function public.process_factory_flow_projection(p_limit integer default 25)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner record;
  work record;
  processed integer := 0;
  snapshot_at timestamptz := clock_timestamp();
  exhausted boolean;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception 'Invalid factory flow projection batch size.' using errcode = '22023';
  end if;
  select dirty.workspace_id, dirty.factory_id into owner
  from internal.factory_flow_projection_dirty_sessions dirty
  join public.workspaces workspace on workspace.id = dirty.workspace_id
  where workspace.deletion_requested_at is null
  order by dirty.queued_at, dirty.session_id limit 1;
  if not found then return jsonb_build_object('processed', 0, 'hasMore', false); end if;
  -- Only one batch owns a factory's watermark. Session facts still enqueue
  -- concurrently and wait only if they touch a session being projected.
  if not pg_try_advisory_xact_lock(hashtextextended(
    'factory-flow:' || owner.workspace_id::text || ':' || owner.factory_id::text, 0
  )) then return jsonb_build_object('processed', 0, 'hasMore', true); end if;
  perform 1 from public.workspaces workspace
  where workspace.id = owner.workspace_id and workspace.deletion_requested_at is null for share;
  if not found then return jsonb_build_object('processed', 0, 'hasMore', true); end if;

  for work in
    select dirty.session_id from internal.factory_flow_projection_dirty_sessions dirty
    where (dirty.workspace_id, dirty.factory_id) = (owner.workspace_id, owner.factory_id)
    order by dirty.queued_at, dirty.session_id limit p_limit for update skip locked
  loop
    perform internal.rebuild_factory_flow_session(owner.workspace_id, owner.factory_id, work.session_id, snapshot_at);
    delete from internal.factory_flow_projection_dirty_sessions where session_id = work.session_id;
    processed := processed + 1;
  end loop;
  exhausted := not exists (
    select 1 from internal.factory_flow_projection_dirty_sessions dirty
    where (dirty.workspace_id, dirty.factory_id) = (owner.workspace_id, owner.factory_id)
  );
  if processed > 0 then
    insert into internal.factory_outcome_projection_watermarks as watermark (
      workspace_id, factory_id, metric_key, metric_revision, last_attempt_at, last_success_at, source_snapshot_at, status
    ) select owner.workspace_id, owner.factory_id, key, 1, snapshot_at,
      case when exhausted then clock_timestamp() end, case when exhausted then snapshot_at end,
      case when exhausted then 'ready' else 'building' end
    from unnest(array['request_to_deployment', 'request_to_merge', 'workflow_flow']) key
    on conflict (workspace_id, factory_id, metric_key, metric_revision) do update set
      last_attempt_at = excluded.last_attempt_at,
      last_success_at = coalesce(excluded.last_success_at, watermark.last_success_at),
      source_snapshot_at = coalesce(excluded.source_snapshot_at, watermark.source_snapshot_at),
      status = excluded.status;
  end if;
  return jsonb_build_object('processed', processed, 'hasMore',
    exists (select 1 from internal.factory_flow_projection_dirty_sessions));
end;
$$;
revoke all on function public.process_factory_flow_projection(integer) from public, anon, authenticated, service_role;
grant execute on function public.process_factory_flow_projection(integer) to service_role;
