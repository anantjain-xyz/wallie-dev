-- Factory outcome evidence lives in its own tenant-scoped ledger. Its lifetime
-- is independent of outbound subscriptions and browser performance telemetry.
create table internal.factory_outcome_observations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  event_type text not null check (event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  source_kind text not null check (source_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  source_key text not null check (char_length(source_key) between 1 and 200),
  occurred_at timestamptz not null,
  observed_at timestamptz not null default clock_timestamp(),
  capture_mode text not null check (capture_mode in ('live', 'backfill')),
  session_id uuid,
  job_id uuid,
  run_id uuid,
  attempt_count integer check (attempt_count is null or (attempt_count > 0 and num_nonnulls(job_id, run_id) > 0)),
  stage_id uuid,
  artifact_id uuid,
  actor_member_id uuid,
  actor_service_principal_id uuid,
  definition_revision_id uuid,
  repository_id uuid,
  status text check (status ~ '^[a-z][a-z0-9_]{0,63}$'),
  trigger_type text check (trigger_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  check (num_nonnulls(actor_member_id, actor_service_principal_id) <= 1),
  foreign key (workspace_id, factory_id)
    references public.factories (workspace_id, id) on delete cascade,
  foreign key (session_id, workspace_id, factory_id)
    references public.sessions (id, workspace_id, factory_id) on delete cascade,
  unique (workspace_id, factory_id, event_type, source_kind, source_key)
);
create index factory_outcome_observations_occurred_idx
  on internal.factory_outcome_observations (workspace_id, factory_id, occurred_at, id);
create index factory_outcome_observations_observed_idx
  on internal.factory_outcome_observations (workspace_id, factory_id, observed_at, id);
create index factory_outcome_observations_session_idx
  on internal.factory_outcome_observations (session_id, workspace_id, factory_id, occurred_at, id)
  where session_id is not null;
alter table internal.factory_outcome_observations enable row level security;
revoke all on internal.factory_outcome_observations from public, anon, authenticated, service_role;

create function internal.guard_factory_outcome_observation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.factories where (workspace_id, id) = (old.workspace_id, old.factory_id))
    or (old.session_id is not null and not exists (
      select 1 from public.sessions where (id, workspace_id, factory_id) =
        (old.session_id, old.workspace_id, old.factory_id)
    ))
  ) then return old; end if;
  raise exception 'Factory outcome observations are immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.guard_factory_outcome_observation() from public, anon, authenticated, service_role;
create trigger factory_outcome_observations_immutable
  before update or delete on internal.factory_outcome_observations
  for each row execute function internal.guard_factory_outcome_observation();

-- Trusted producers pass typed values from the owning rows. Both live capture
-- and exact historical repair use the same source identity for deduplication.
create function internal.record_factory_outcome_observation(
  p_workspace_id uuid, p_factory_id uuid, p_event_type text, p_source_kind text,
  p_source_key text, p_occurred_at timestamptz,
  p_session_id uuid default null, p_job_id uuid default null, p_run_id uuid default null,
  p_attempt_count integer default null, p_stage_id uuid default null, p_artifact_id uuid default null,
  p_actor_member_id uuid default null, p_actor_service_principal_id uuid default null,
  p_definition_revision_id uuid default null, p_repository_id uuid default null,
  p_status text default null, p_trigger_type text default null, p_capture_mode text default 'live'
) returns void language sql set search_path = '' as $$
  insert into internal.factory_outcome_observations (
    workspace_id, factory_id, event_type, source_kind, source_key, occurred_at,
    session_id, job_id, run_id, attempt_count, stage_id, artifact_id,
    actor_member_id, actor_service_principal_id, definition_revision_id, repository_id,
    status, trigger_type, capture_mode
  ) values (
    p_workspace_id, p_factory_id, p_event_type, p_source_kind, p_source_key, p_occurred_at,
    p_session_id, p_job_id, p_run_id, p_attempt_count, p_stage_id, p_artifact_id,
    p_actor_member_id, p_actor_service_principal_id, p_definition_revision_id, p_repository_id,
    p_status, p_trigger_type, p_capture_mode
  ) on conflict (workspace_id, factory_id, event_type, source_kind, source_key) do nothing;
$$;
revoke all on function internal.record_factory_outcome_observation(
  uuid, uuid, text, text, text, timestamptz, uuid, uuid, uuid, integer, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text
) from public, anon, authenticated, service_role;

-- A backfilled point can be exact without proving completeness for its period.
create table internal.factory_outcome_capture_coverage (
  source text primary key check (source ~ '^[a-z][a-z0-9_]{0,63}$'),
  live_from timestamptz not null
);
alter table internal.factory_outcome_capture_coverage enable row level security;
revoke all on internal.factory_outcome_capture_coverage from public, anon, authenticated, service_role;

create table internal.factory_outcome_metric_revisions (
  metric_key text not null check (metric_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  revision integer not null check (revision > 0),
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and definition <> '{}'::jsonb),
  created_at timestamptz not null default clock_timestamp(),
  primary key (metric_key, revision)
);
alter table internal.factory_outcome_metric_revisions enable row level security;
revoke all on internal.factory_outcome_metric_revisions from public, anon, authenticated, service_role;

create function internal.guard_factory_outcome_metric_revision()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Factory outcome metric revisions are immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.guard_factory_outcome_metric_revision() from public, anon, authenticated, service_role;
create trigger factory_outcome_metric_revisions_immutable
  before update or delete on internal.factory_outcome_metric_revisions
  for each row execute function internal.guard_factory_outcome_metric_revision();

insert into internal.factory_outcome_metric_revisions (metric_key, revision, definition) values
  ('workflow_flow', 1, '{
    "unit":"seconds","population":"admitted_sessions","observationSources":["lifecycle"],
    "segments":["queued","active","blocked","review","delivery"],"missingBounds":"unknown"
  }'),
  ('request_to_merge', 1, '{
    "unit":"seconds","population":"admitted_sessions","observationSources":["lifecycle","pull_requests"],
    "start":"session.created","end":"pull_request.merged","missingBounds":"censored"
  }'),
  ('request_to_deployment', 1, '{
    "unit":"seconds","population":"admitted_sessions","observationSources":["lifecycle","deployments"],
    "start":"session.created","end":"deployment.succeeded","missingBounds":"censored"
  }');

-- Progress describes a successfully reconciled snapshot. Event time and
-- sequence/UUID ordering cannot represent visibility or prove completeness.
create table internal.factory_outcome_projection_watermarks (
  workspace_id uuid not null,
  factory_id uuid not null,
  metric_key text not null,
  metric_revision integer not null,
  last_attempt_at timestamptz not null,
  last_success_at timestamptz,
  source_snapshot_at timestamptz,
  status text not null check (status in ('building', 'ready', 'failed')),
  primary key (workspace_id, factory_id, metric_key, metric_revision),
  foreign key (workspace_id, factory_id)
    references public.factories (workspace_id, id) on delete cascade,
  foreign key (metric_key, metric_revision)
    references internal.factory_outcome_metric_revisions (metric_key, revision),
  check ((last_success_at is null) = (source_snapshot_at is null)),
  check (source_snapshot_at is null or source_snapshot_at <= last_success_at),
  check (status <> 'ready' or last_success_at is not null)
);
create index factory_outcome_projection_watermarks_revision_idx
  on internal.factory_outcome_projection_watermarks (metric_key, metric_revision);
alter table internal.factory_outcome_projection_watermarks enable row level security;
revoke all on internal.factory_outcome_projection_watermarks from public, anon, authenticated, service_role;

comment on column internal.factory_outcome_projection_watermarks.source_snapshot_at is
  'Wall clock of last coherent source snapshot. A late observation can require reconciliation even when its source time predates this snapshot.';
