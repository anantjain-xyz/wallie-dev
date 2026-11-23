create table internal.issue_automation_state_spans (
  workspace_id uuid not null,
  factory_id uuid not null,
  source_namespace text not null,
  source_issue_id text not null,
  source_span_id text not null,
  started_at timestamptz not null,
  source_updated_at timestamptz not null,
  event jsonb not null,
  baseline boolean not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, factory_id, source_namespace, source_issue_id, source_span_id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade,
  check (started_at <= source_updated_at)
);

create table internal.issue_automation_span_watermarks (
  workspace_id uuid not null,
  factory_id uuid not null,
  source_namespace text not null,
  source_issue_id text not null,
  source_span_id text not null,
  source_updated_at timestamptz not null,
  primary key (workspace_id, factory_id, source_namespace, source_issue_id),
  foreign key (workspace_id, factory_id, source_namespace, source_issue_id, source_span_id)
    references internal.issue_automation_state_spans(workspace_id, factory_id, source_namespace, source_issue_id, source_span_id)
    on delete cascade
);

create table internal.issue_automation_scan_cursors (
  source_namespace text not null,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  after_session_id uuid,
  generation bigint not null default 0 check (generation between 0 and 9007199254740991),
  unique nulls not distinct (source_namespace, workspace_id)
);

alter table internal.issue_automation_state_spans enable row level security;
alter table internal.issue_automation_span_watermarks enable row level security;
alter table internal.issue_automation_scan_cursors enable row level security;
revoke all on internal.issue_automation_state_spans, internal.issue_automation_span_watermarks,
  internal.issue_automation_scan_cursors from public, anon, authenticated, service_role;

-- The first coherent observation establishes a baseline. Later entries keep
-- their original scope and filter payload, independently of provider edits.
create function internal.record_issue_automation_state_span(
  p_workspace_id uuid, p_factory_id uuid, p_source_namespace text, p_issue_id text, p_span_id text,
  p_started_at timestamptz, p_source_updated_at timestamptz, p_event jsonb, p_retain_archived boolean default false
) returns integer language plpgsql set search_path = '' as $$
declare
  current_span record;
  prior_span internal.issue_automation_state_spans;
  rule record;
  occurrence jsonb;
  inserted integer := 0;
  active_factory boolean;
  source_key text := encode(sha256(convert_to(jsonb_build_array(p_issue_id, p_span_id)::text, 'UTF8')), 'hex');
begin
  perform 1 from public.workspaces workspace
  where workspace.id = p_workspace_id and workspace.deletion_requested_at is null for share;
  if not found then return 0; end if;
  select factory.status = 'active' into active_factory from public.factories factory
  where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id) for no key update;
  if not found or (not active_factory and not p_retain_archived) then return 0; end if;

  select span.* into prior_span from internal.issue_automation_state_spans span
  where (span.workspace_id, span.factory_id, span.source_namespace, span.source_issue_id, span.source_span_id) =
    (p_workspace_id, p_factory_id, p_source_namespace, p_issue_id, p_span_id);
  select span.source_span_id, span.started_at, watermark.source_updated_at into current_span
  from internal.issue_automation_span_watermarks watermark
  join internal.issue_automation_state_spans span
    using (workspace_id, factory_id, source_namespace, source_issue_id, source_span_id)
  where (watermark.workspace_id, watermark.factory_id, watermark.source_namespace, watermark.source_issue_id) =
    (p_workspace_id, p_factory_id, p_source_namespace, p_issue_id);

  if prior_span.source_span_id is not null then
    if (prior_span.started_at, prior_span.event->>'stateId') is distinct from (p_started_at, p_event->>'stateId') then
      raise exception 'An issue automation state span changed identity.' using errcode = '22023';
    end if;
    if prior_span.source_span_id = current_span.source_span_id and p_source_updated_at > current_span.source_updated_at then
      update internal.issue_automation_span_watermarks watermark set source_updated_at = p_source_updated_at
      where (watermark.workspace_id, watermark.factory_id, watermark.source_namespace, watermark.source_issue_id) =
        (p_workspace_id, p_factory_id, p_source_namespace, p_issue_id);
    end if;
    return 0;
  end if;
  if current_span.source_span_id is not null and (
    p_started_at < current_span.started_at or p_source_updated_at < current_span.source_updated_at
    or (p_started_at = current_span.started_at and p_source_updated_at <= current_span.source_updated_at)
  ) then
    return 0;
  end if;

  insert into internal.issue_automation_state_spans(
    workspace_id, factory_id, source_namespace, source_issue_id, source_span_id, started_at, source_updated_at, event, baseline
  ) values (
    p_workspace_id, p_factory_id, p_source_namespace, p_issue_id, p_span_id, p_started_at,
    p_source_updated_at, p_event, current_span.source_span_id is null
  );
  insert into internal.issue_automation_span_watermarks(
    workspace_id, factory_id, source_namespace, source_issue_id, source_span_id, source_updated_at
  ) values (p_workspace_id, p_factory_id, p_source_namespace, p_issue_id, p_span_id, p_source_updated_at)
  on conflict (workspace_id, factory_id, source_namespace, source_issue_id) do update
    set source_span_id = excluded.source_span_id, source_updated_at = excluded.source_updated_at;

  if current_span.source_span_id is null or not active_factory then return 0; end if;
  for rule in
    select automation.id, revision.id as revision_id
    from internal.factory_automations automation
    join internal.factory_automation_revisions revision
      on (revision.automation_id, revision.id) = (automation.id, automation.published_revision_id)
    where (automation.workspace_id, automation.factory_id) = (p_workspace_id, p_factory_id)
      and automation.archived_at is null and revision.definition#>>'{trigger,kind}' = 'issue-state'
      and internal.evaluate_factory_automation_event(revision.definition, p_event)->'matched' = 'true'::jsonb
    order by automation.id
  loop
    occurrence := public.record_factory_automation_occurrence(
      p_workspace_id, p_factory_id, rule.id, rule.revision_id, p_source_namespace, source_key, p_event
    );
    inserted := inserted + (occurrence->'replayed' = 'false'::jsonb)::integer;
  end loop;
  return inserted;
end;
$$;

create function internal.valid_linked_linear_automation_observation(observation jsonb)
returns boolean language sql stable set search_path = '' as $$
  select case when jsonb_typeof(observation) = 'object' then (
    observation ?& array['sessionId','linkedIssueId','issueId','spanId','startedAt','issueUpdatedAt','stateId','teamId','projectId']
    and observation - array['sessionId','linkedIssueId','issueId','spanId','startedAt','issueUpdatedAt','stateId','teamId','projectId'] = '{}'::jsonb
    and pg_input_is_valid(observation->>'sessionId', 'uuid')
    and pg_input_is_valid(observation->>'issueId', 'uuid')
    and internal.valid_factory_automation_filter_values(jsonb_build_array(observation->'spanId'))
    and internal.valid_factory_automation_filter_values(jsonb_build_array(observation->'linkedIssueId'))
    and pg_input_is_valid(observation->>'startedAt', 'timestamp with time zone')
    and pg_input_is_valid(observation->>'issueUpdatedAt', 'timestamp with time zone')
  ) is true else false end
$$;

-- A lifecycle route can remove the only active link before the batch cursor
-- reaches it. Retain that exact source observation without advancing the cursor.
create function public.retain_terminal_linear_automation_span(p_workspace_id uuid, p_observation jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  linked_session_id uuid;
  linked_factory_id uuid;
  canonical_issue_id text;
  observed_span_id text;
  observed_started_at timestamptz;
  observed_updated_at timestamptz;
  event jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if not internal.valid_linked_linear_automation_observation(p_observation) then
    raise exception 'A valid linked Linear state span is required.' using errcode = '22023';
  end if;
  linked_session_id := (p_observation->>'sessionId')::uuid;
  canonical_issue_id := (p_observation->>'issueId')::uuid::text;
  observed_span_id := p_observation->>'spanId';
  observed_started_at := (p_observation->>'startedAt')::timestamptz;
  observed_updated_at := (p_observation->>'issueUpdatedAt')::timestamptz;
  if observed_started_at > observed_updated_at or not isfinite(observed_started_at) or not isfinite(observed_updated_at) then
    raise exception 'A coherent linked Linear state span is required.' using errcode = '22023';
  end if;
  event := internal.normalize_factory_automation_event(jsonb_build_object(
    'kind', 'issue-state', 'stateId', p_observation->'stateId',
    'teamId', p_observation->'teamId', 'projectId', p_observation->'projectId'
  ));

  select session.factory_id into linked_factory_id from public.sessions session
  where (session.workspace_id, session.id) = (p_workspace_id, linked_session_id);
  if not found then return false; end if;
  perform 1 from public.workspaces workspace
  where workspace.id = p_workspace_id and workspace.deletion_requested_at is null for share;
  if not found then return false; end if;
  perform 1 from public.factories factory
  where (factory.workspace_id, factory.id) = (p_workspace_id, linked_factory_id) for no key update;
  if not found then return false; end if;
  perform 1 from public.sessions session
  where (session.workspace_id, session.factory_id, session.id) = (p_workspace_id, linked_factory_id, linked_session_id)
    and session.linear_issue_id = p_observation->>'linkedIssueId' and session.archived_at is null
    and session.phase_status in ('in_progress', 'awaiting_review', 'approved', 'rejected')
  for share;
  if not found then return false; end if;

  perform internal.record_issue_automation_state_span(p_workspace_id, linked_factory_id, 'linear.issue-state',
    canonical_issue_id, observed_span_id, observed_started_at, observed_updated_at, event, true);
  return exists (
    select 1 from internal.issue_automation_span_watermarks watermark
    where (watermark.workspace_id, watermark.factory_id, watermark.source_namespace, watermark.source_issue_id,
      watermark.source_span_id, watermark.source_updated_at) = (p_workspace_id, linked_factory_id, 'linear.issue-state',
      canonical_issue_id, observed_span_id, observed_updated_at)
  );
end;
$$;

create function public.read_linear_automation_span_cursor(p_workspace_id uuid default null)
returns table(after_session_id uuid, generation bigint)
language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  return query select cursor_row.after_session_id, coalesce(cursor_row.generation, 0::bigint)
  from (select 1) seed left join internal.issue_automation_scan_cursors cursor_row
    on cursor_row.source_namespace = 'linear.issue-state' and cursor_row.workspace_id is not distinct from p_workspace_id;
end;
$$;

create function public.commit_linear_automation_span_page(
  p_expected_generation bigint, p_session_ids uuid[], p_observations jsonb, p_workspace_id uuid default null
) returns table(after_session_id uuid, generation bigint, occurrence_count integer)
language plpgsql security definer set search_path = '' as $$
declare
  progress internal.issue_automation_scan_cursors;
  expected_ids uuid[];
  locked_ids uuid[];
  observed record;
  source_namespace constant text := 'linear.issue-state';
  inserted integer := 0;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_expected_generation is null or p_expected_generation < 0 or p_session_ids is null
    or cardinality(p_session_ids) > 50 or jsonb_typeof(p_observations) is distinct from 'array' then
    raise exception 'An exact Linear automation scan page is required.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_observations) > cardinality(p_session_ids) or octet_length(p_observations::text) > 65536 then
    raise exception 'The Linear automation scan page is too large.' using errcode = '22023';
  end if;

  if p_workspace_id is not null then
    perform 1 from public.workspaces workspace where workspace.id = p_workspace_id for share;
    if not found then
      raise exception 'The linked-session page workspace changed. Reload it and retry.' using errcode = 'PT409';
    end if;
  end if;

  insert into internal.issue_automation_scan_cursors(source_namespace, workspace_id)
  values (source_namespace, p_workspace_id) on conflict do nothing;
  select cursor_row.* into strict progress from internal.issue_automation_scan_cursors cursor_row
  where cursor_row.source_namespace = 'linear.issue-state' and cursor_row.workspace_id is not distinct from p_workspace_id
  for update;
  if progress.generation <> p_expected_generation then
    raise exception 'The Linear automation scan cursor changed. Reload it and retry.' using errcode = 'PT409';
  end if;

  select coalesce(array_agg(page.id order by page.id), '{}'::uuid[]) into expected_ids
  from (
    select session.id from public.sessions session where session.linear_issue_id is not null and session.archived_at is null
      and session.phase_status in ('in_progress', 'awaiting_review', 'approved', 'rejected')
      and (p_workspace_id is null or session.workspace_id = p_workspace_id)
      and (progress.after_session_id is null or session.id > progress.after_session_id)
    order by session.id limit 50
  ) page;
  if expected_ids is distinct from p_session_ids then
    raise exception 'The linked-session page changed. Reload it and retry.' using errcode = 'PT409';
  end if;

  -- Take scope locks before session locks, as terminal retention does.
  -- Hold the chosen links through validation, span persistence, and cursor advance.
  perform 1 from public.workspaces workspace where workspace.id in (
    select session.workspace_id from public.sessions session where session.id = any(expected_ids)
  ) order by workspace.id for share;
  perform 1 from public.factories factory where (factory.workspace_id, factory.id) in (
    select session.workspace_id, session.factory_id from public.sessions session where session.id = any(expected_ids)
  ) order by factory.workspace_id, factory.id for no key update;
  select coalesce(array_agg(page.id order by page.id), '{}'::uuid[]) into locked_ids
  from (
    select session.id from public.sessions session where session.id = any(expected_ids)
      and session.linear_issue_id is not null and session.archived_at is null
      and session.phase_status in ('in_progress', 'awaiting_review', 'approved', 'rejected')
      and (p_workspace_id is null or session.workspace_id = p_workspace_id)
    order by session.id for share
  ) page;
  if locked_ids is distinct from expected_ids then
    raise exception 'The linked-session page changed. Reload it and retry.' using errcode = 'PT409';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_observations) observation
    where not internal.valid_linked_linear_automation_observation(observation)
  ) then
    raise exception 'A valid linked Linear state span is required.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_observations) observation
    left join public.sessions session on session.id = (observation->>'sessionId')::uuid
    where session.id is null or not (session.id = any(locked_ids))
      or session.linear_issue_id is distinct from observation->>'linkedIssueId'
      or (observation->>'startedAt')::timestamptz > (observation->>'issueUpdatedAt')::timestamptz
      or not isfinite((observation->>'startedAt')::timestamptz) or not isfinite((observation->>'issueUpdatedAt')::timestamptz)
  ) or jsonb_array_length(p_observations) <> (
    select count(distinct (observation->>'sessionId')::uuid) from jsonb_array_elements(p_observations) observation
  ) then
    raise exception 'A state span must match one session in the exact scan page.' using errcode = 'PT409';
  end if;

  -- Legacy links can use either an identifier or the provider issue UUID.
  -- Prefer the latest coherent snapshot when several links refer to one issue.
  for observed in
    select distinct on (session.workspace_id, session.factory_id, (observation->>'issueId')::uuid)
      session.workspace_id, session.factory_id, (observation->>'issueId')::uuid::text as issue_id,
      observation->>'spanId' as span_id, (observation->>'startedAt')::timestamptz as started_at,
      (observation->>'issueUpdatedAt')::timestamptz as issue_updated_at,
      internal.normalize_factory_automation_event(jsonb_build_object(
        'kind', 'issue-state', 'stateId', observation->'stateId', 'teamId', observation->'teamId', 'projectId', observation->'projectId'
      )) as event
    from jsonb_array_elements(p_observations) observation
    join public.sessions session on session.id = (observation->>'sessionId')::uuid
    order by session.workspace_id, session.factory_id, (observation->>'issueId')::uuid,
      (observation->>'issueUpdatedAt')::timestamptz desc, (observation->>'startedAt')::timestamptz desc, session.id
  loop
    inserted := inserted + internal.record_issue_automation_state_span(observed.workspace_id, observed.factory_id,
      source_namespace, observed.issue_id, observed.span_id, observed.started_at, observed.issue_updated_at, observed.event);
  end loop;

  update internal.issue_automation_scan_cursors cursor_row
  set after_session_id = case when cardinality(expected_ids) = 50 then expected_ids[50] end,
    generation = cursor_row.generation + 1
  where cursor_row.source_namespace = 'linear.issue-state' and cursor_row.workspace_id is not distinct from p_workspace_id
  returning cursor_row.after_session_id, cursor_row.generation into after_session_id, generation;
  occurrence_count := inserted;
  return next;
end;
$$;

revoke all on function
  internal.record_issue_automation_state_span(uuid, uuid, text, text, text, timestamptz, timestamptz, jsonb, boolean),
  internal.valid_linked_linear_automation_observation(jsonb), public.retain_terminal_linear_automation_span(uuid, jsonb),
  public.read_linear_automation_span_cursor(uuid), public.commit_linear_automation_span_page(bigint, uuid[], jsonb, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.retain_terminal_linear_automation_span(uuid, jsonb),
  public.read_linear_automation_span_cursor(uuid),
  public.commit_linear_automation_span_page(bigint, uuid[], jsonb, uuid) to service_role;
