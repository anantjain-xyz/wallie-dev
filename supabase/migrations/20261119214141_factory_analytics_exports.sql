-- Freeze only the metrics and receipts that the requester can already read.
create table internal.factory_analytics_exports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  requester_member_id uuid not null references public.workspace_members(id) on delete cascade,
  request_id uuid not null,
  captured_at timestamptz not null,
  expires_at timestamptz not null,
  requires_manager boolean not null,
  filters jsonb not null,
  payload jsonb not null,
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade,
  unique (workspace_id, factory_id, requester_member_id, request_id),
  check (expires_at > captured_at and expires_at <= captured_at + interval '24 hours'),
  check (octet_length(payload::text) <= 1048576)
);
create index factory_analytics_exports_expiry_idx
  on internal.factory_analytics_exports (expires_at, id);
alter table internal.factory_analytics_exports enable row level security;
revoke all on internal.factory_analytics_exports from public, anon, authenticated, service_role;

create function internal.factory_analytics_export_member(p_workspace_id uuid, p_factory_id uuid)
returns uuid language sql stable set search_path = '' as $$
  select member.id
  from public.workspace_members member
  join public.factories factory on (factory.workspace_id, factory.id) = (member.workspace_id, p_factory_id)
  join auth.sessions session on session.user_id = member.user_id and session.id = case
    when auth.jwt()->>'session_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then (auth.jwt()->>'session_id')::uuid end
  where auth.role() = 'authenticated' and member.user_id = auth.uid() and member.workspace_id = p_workspace_id
    and member.kind = 'human' and member.is_active
    and (session.not_after is null or session.not_after > statement_timestamp())
    and internal.can_access_factory(p_workspace_id, p_factory_id)
$$;
revoke all on function internal.factory_analytics_export_member(uuid, uuid)
from public, anon, authenticated, service_role;

-- All nested reads from this STABLE helper share the caller's single statement
-- snapshot, including the date used for freshness and revert maturity.
create function internal.capture_factory_analytics_export_period(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz,
  p_dimension text, p_environment text, p_period text
) returns jsonb language plpgsql stable set search_path = '' as $$
declare
  row_limit constant integer := 100;
  flow jsonb;
  merge_timing jsonb;
  deployment jsonb;
  delivery_cost jsonb;
  operating_cost jsonb;
  cost_merges jsonb;
  throughput jsonb;
  revert jsonb;
begin
  flow := public.list_factory_flow_evidence(p_workspace_id, p_factory_id, p_from, p_to,
    'workflow_flow', p_limit => row_limit);
  merge_timing := public.list_factory_flow_evidence(p_workspace_id, p_factory_id, p_from, p_to,
    'request_to_merge', p_limit => row_limit);
  deployment := public.list_factory_flow_evidence(p_workspace_id, p_factory_id, p_from, p_to,
    'request_to_deployment', p_environment, p_limit => row_limit);
  select coalesce(jsonb_agg(to_jsonb(fact) order by fact.run_id), '[]'::jsonb) into delivery_cost
  from public.list_factory_cost_contributions(p_workspace_id, p_factory_id, p_from, p_to,
    'delivery', p_limit => row_limit + 1) fact;
  select coalesce(jsonb_agg(to_jsonb(fact) order by fact.run_id), '[]'::jsonb) into operating_cost
  from public.list_factory_cost_contributions(p_workspace_id, p_factory_id, p_from, p_to,
    'operating', p_limit => row_limit + 1) fact;
  cost_merges := public.list_factory_cost_merges(p_workspace_id, p_factory_id, p_from, p_to, p_limit => row_limit);
  throughput := public.list_factory_throughput_contributions(p_workspace_id, p_factory_id, p_from, p_to,
    p_dimension, p_limit => row_limit);
  revert := public.list_factory_revert_evidence(p_workspace_id, p_factory_id, p_from, p_to, p_limit => row_limit);

  if exists (
    select 1 from unnest(array[flow, merge_timing, deployment, cost_merges, throughput, revert]) page
    where page->'nextCursor' is distinct from 'null'::jsonb
  ) or jsonb_array_length(delivery_cost) > row_limit or jsonb_array_length(operating_cost) > row_limit
    or exists (
      select 1 from jsonb_array_elements(revert->'items') row
      where (row->>'relationshipsTruncated')::boolean
        or (row->>'coverageCount')::integer > jsonb_array_length(row->'coverageIds')
    ) then
    raise exception 'Too many contributing observations for an analytics export.' using errcode = 'PT422';
  end if;

  return jsonb_build_object(
    'key', p_period, 'window', jsonb_build_object('from', p_from, 'to', p_to),
    'summaries', jsonb_build_object(
      'flow', public.get_factory_flow_summary(p_workspace_id, p_factory_id, p_from, p_to, p_environment),
      'cost', public.get_factory_cost_summary(p_workspace_id, p_factory_id, p_from, p_to),
      'throughput', public.get_factory_throughput_breakdown(p_workspace_id, p_factory_id, p_from, p_to, p_dimension),
      'revert', public.get_factory_revert_summary(p_workspace_id, p_factory_id, p_from, p_to)
    ),
    'rolesVisibility', throughput->>'rolesVisibility',
    'evidence', jsonb_build_object(
      'flow', flow->'items', 'merge', merge_timing->'items', 'deployment', deployment->'items',
      'deliveryCost', delivery_cost, 'operatingCost', operating_cost, 'costMerges', cost_merges->'items',
      'throughput', throughput->'items', 'revert', revert->'items'
    )
  );
end;
$$;
revoke all on function internal.capture_factory_analytics_export_period(
  uuid, uuid, timestamptz, timestamptz, text, text, text
) from public, anon, authenticated, service_role;

create function internal.capture_factory_analytics_export(
  p_workspace_id uuid, p_factory_id uuid, p_id uuid, p_filters jsonb, p_expires_at timestamptz
) returns jsonb language plpgsql stable set search_path = '' as $$
declare
  p_from timestamptz := (p_filters->>'from')::timestamptz;
  p_to timestamptz := (p_filters->>'to')::timestamptz;
  dimension text := p_filters->>'dimension';
  environment text := p_filters->>'deploymentEnvironment';
  periods jsonb;
  snapshot jsonb;
begin
  periods := jsonb_build_array(internal.capture_factory_analytics_export_period(
    p_workspace_id, p_factory_id, p_from, p_to, dimension, environment, 'primary'
  ));
  if (p_filters->>'comparePrevious')::boolean then
    periods := periods || jsonb_build_array(internal.capture_factory_analytics_export_period(
      p_workspace_id, p_factory_id, p_from - (p_to - p_from), p_from, dimension, environment, 'comparison'
    ));
  end if;
  if (select sum(jsonb_array_length(item.value)) from jsonb_array_elements(periods) period
    cross join lateral jsonb_each(period->'evidence') item) > 800 then
    raise exception 'Too many contributing observations for an analytics export.' using errcode = 'PT422';
  end if;
  snapshot := jsonb_build_object(
    'schemaVersion', 1, 'id', p_id, 'workspaceId', p_workspace_id, 'factoryId', p_factory_id,
    'capturedAt', statement_timestamp(), 'expiresAt', p_expires_at, 'filters', p_filters, 'periods', periods
  );
  if octet_length(snapshot::text) > 1048576 then
    raise exception 'Analytics export exceeds the snapshot size limit.' using errcode = 'PT422';
  end if;
  return snapshot;
end;
$$;
revoke all on function internal.capture_factory_analytics_export(uuid, uuid, uuid, jsonb, timestamptz)
from public, anon, authenticated, service_role;

create function public.create_factory_analytics_export(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_request_id uuid,
  p_dimension text default 'source', p_environment text default null, p_compare_previous boolean default false
) returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  requester uuid;
  filters jsonb;
  existing internal.factory_analytics_exports;
  snapshot_id uuid := gen_random_uuid();
  deadline timestamptz := statement_timestamp() + interval '24 hours';
  manager boolean;
begin
  select internal.factory_analytics_export_member(p_workspace_id, p_factory_id) into requester;
  if requester is null then
    raise exception 'Analytics export factory is unavailable.' using errcode = 'PT404';
  end if;
  perform internal.require_factory_flow_window(p_workspace_id, p_factory_id, p_from, p_to, p_environment);
  if p_request_id is null or p_compare_previous is null or p_dimension is null
    or p_dimension not in ('source', 'person', 'agent', 'model', 'harness', 'definition')
    or (p_from at time zone 'UTC')::time <> time '00:00'
    or (p_to at time zone 'UTC')::time <> time '00:00'
    or p_from < '0001-01-01T00:00:00Z'::timestamptz or p_to >= '10000-01-01T00:00:00Z'::timestamptz
    or (p_compare_previous and p_from - (p_to - p_from) < '0001-01-01T00:00:00Z'::timestamptz)
  then raise exception 'Invalid analytics export filters.' using errcode = '22023'; end if;

  filters := jsonb_build_object(
    'from', to_char(p_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'to', to_char(p_to at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'dimension', p_dimension, 'deploymentEnvironment', p_environment, 'comparePrevious', p_compare_previous
  );
  -- Serialize per factory across request retries and quota checks.
  perform pg_advisory_xact_lock(hashtextextended(
    'factory-analytics-export:' || p_workspace_id::text || ':' || p_factory_id::text, 0
  ));
  if internal.factory_analytics_export_member(p_workspace_id, p_factory_id) is distinct from requester then
    raise exception 'Analytics export factory is unavailable.' using errcode = 'PT404';
  end if;
  manager := internal.can_manage_factory(p_workspace_id, p_factory_id);
  select * into existing from internal.factory_analytics_exports snapshot
  where (snapshot.workspace_id, snapshot.factory_id, snapshot.requester_member_id, snapshot.request_id) =
    (p_workspace_id, p_factory_id, requester, p_request_id);
  if found then
    if existing.requires_manager and not manager then
      raise exception 'Analytics export factory is unavailable.' using errcode = 'PT404';
    elsif existing.filters is distinct from filters then
      raise exception 'Analytics export request ID is bound to different filters.' using errcode = 'PT409';
    elsif existing.expires_at <= clock_timestamp() then
      raise exception 'Analytics export is expired.' using errcode = 'PT410';
    end if;
    return jsonb_build_object('id', existing.id, 'createdAt', existing.captured_at, 'expiresAt', existing.expires_at);
  end if;

  if exists (
    select 1 from internal.factory_analytics_exports snapshot
    where (snapshot.workspace_id, snapshot.factory_id) = (p_workspace_id, p_factory_id)
      and snapshot.expires_at > clock_timestamp()
    having count(*) >= 100 or count(*) filter (where snapshot.requester_member_id = requester) >= 10
  ) then
    raise exception 'Too many active analytics exports.' using errcode = 'PT429';
  end if;
  insert into internal.factory_analytics_exports(
    id, workspace_id, factory_id, requester_member_id, request_id, captured_at, expires_at, requires_manager, filters, payload
  )
  select snapshot_id, p_workspace_id, p_factory_id, requester, p_request_id, statement_timestamp(), deadline,
    internal.can_manage_factory(p_workspace_id, p_factory_id), filters,
    internal.capture_factory_analytics_export(p_workspace_id, p_factory_id, snapshot_id, filters, deadline)
  where internal.factory_analytics_export_member(p_workspace_id, p_factory_id) = requester;
  if not found then
    raise exception 'Analytics export factory is unavailable.' using errcode = 'PT404';
  end if;
  return jsonb_build_object('id', snapshot_id, 'createdAt', statement_timestamp(), 'expiresAt', deadline);
end;
$$;

create function public.read_factory_analytics_export(p_workspace_id uuid, p_factory_id uuid, p_export_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select snapshot.payload::text
  from internal.factory_analytics_exports snapshot
  where (snapshot.workspace_id, snapshot.factory_id, snapshot.id) = (p_workspace_id, p_factory_id, p_export_id)
    and snapshot.requester_member_id = internal.factory_analytics_export_member(p_workspace_id, p_factory_id)
    and snapshot.expires_at > statement_timestamp()
    and (not snapshot.requires_manager or internal.can_manage_factory(p_workspace_id, p_factory_id))
$$;

create function public.prune_factory_analytics_exports(p_limit integer default 100)
returns integer language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_limit is null or p_limit not between 1 and 250 then
    raise exception 'Invalid analytics export pruning limit.' using errcode = '22023';
  end if;
  with expired as materialized (
    select id from internal.factory_analytics_exports
    where expires_at <= statement_timestamp()
    order by expires_at, id limit p_limit for update skip locked
  )
  delete from internal.factory_analytics_exports snapshot using expired where snapshot.id = expired.id;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.create_factory_analytics_export(uuid, uuid, timestamptz, timestamptz, uuid, text, text, boolean),
  public.read_factory_analytics_export(uuid, uuid, uuid), public.prune_factory_analytics_exports(integer)
from public, anon, authenticated, service_role;
grant execute on function public.create_factory_analytics_export(uuid, uuid, timestamptz, timestamptz, uuid, text, text, boolean),
  public.read_factory_analytics_export(uuid, uuid, uuid) to authenticated;
grant execute on function public.prune_factory_analytics_exports(integer) to service_role;
