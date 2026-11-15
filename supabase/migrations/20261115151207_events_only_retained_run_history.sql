-- Activity is stored once in agent_run_events. The messages table still
-- contains worker diagnostics and structured terminal failure receipts.
drop function public.list_run_legacy_transcript(uuid,uuid,timestamptz,uuid,text,integer);

drop trigger skip_expired_run_message on public.agent_run_messages;
drop function internal.skip_expired_run_message();

alter policy agent_run_messages_select_membership on public.agent_run_messages using (
  workspace_id in (select internal.current_user_workspace_ids())
  and exists (select 1 from public.workspaces w
    where w.id = agent_run_messages.workspace_id and w.deletion_requested_at is null)
  and kind in ('run_failure', 'worker_error', 'worker_progress', 'worker_completion')
);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'agent_run_events') then
    alter publication supabase_realtime add table public.agent_run_events;
  end if;
end;
$$;

create or replace function public.mark_expired_workspace_run_content(
  p_workspace_limit integer default 4,
  p_item_limit integer default 25
) returns table (transcripts_expired integer, evidence_expired integer)
language plpgsql security definer set search_path = '' as $$
declare
  target uuid;
  policy public.workspace_run_retention;
  item_limit integer := least(greatest(coalesce(p_item_limit, 25), 1), 100);
  sweep_time timestamptz := statement_timestamp();
  transcript_cutoff timestamptz;
  evidence_cutoff timestamptz;
  changed integer;
begin
  transcripts_expired := 0;
  evidence_expired := 0;

  for target in
    select w.id from public.workspace_run_retention settings
    join public.workspaces w on w.id = settings.workspace_id
    where (settings.transcript_days is not null or settings.evidence_days is not null)
      and w.deletion_requested_at is null
    order by settings.last_swept_at asc nulls first, settings.workspace_id
    limit least(greatest(coalesce(p_workspace_limit, 4), 1), 10)
    for no key update of w skip locked
  loop
    -- Take the workspace lock before reading policy or changing availability.
    -- Settings, export snapshots and workspace deletion use this same fence.
    select * into strict policy from public.workspace_run_retention where workspace_id = target;

    if policy.transcript_days is not null then
      transcript_cutoff := sweep_time - internal.run_retention_duration(policy.transcript_days);
      insert into public.agent_run_transcript_expirations(run_id, workspace_id)
      select r.id, r.workspace_id from public.agent_runs r
      where r.workspace_id = target and r.status in ('success', 'error', 'canceled')
        and coalesce(r.finished_at, r.updated_at) <= transcript_cutoff
        and not exists (select 1 from public.agent_run_transcript_expirations expiry where expiry.run_id = r.id)
        and exists (
          select 1 from public.agent_run_events e
          where (e.agent_run_id, e.workspace_id, e.attempt_count) = (r.id, target, r.attempt_count)
        )
      order by coalesce(r.finished_at, r.updated_at), r.id
      limit item_limit for update of r skip locked
      on conflict (run_id) do nothing;
      get diagnostics changed = row_count;
      transcripts_expired := transcripts_expired + changed;
    end if;

    if policy.evidence_days is not null then
      evidence_cutoff := sweep_time - internal.run_retention_duration(policy.evidence_days);
      insert into public.session_validation_asset_withholdings(asset_id, state)
      select a.id, 'expired' from public.agent_runs r
      join public.session_validation_evidence e
        on (e.run_id, e.workspace_id, e.session_id, e.job_id, e.attempt_count) =
           (r.id, r.workspace_id, r.session_id, r.agent_job_id, r.attempt_count)
      join public.session_validation_assets a
        on (a.run_id, a.workspace_id, a.session_id) = (e.run_id, e.workspace_id, e.session_id)
      join public.sessions s on (s.id, s.workspace_id) = (r.session_id, r.workspace_id)
      where r.workspace_id = target and r.status in ('success', 'error', 'canceled')
        and coalesce(r.finished_at, r.updated_at) <= evidence_cutoff
        and e.created_at <= evidence_cutoff
        and (not a.required or s.archived_at is not null)
        and not exists (select 1 from public.session_validation_asset_withholdings x where x.asset_id = a.id)
      order by coalesce(r.finished_at, r.updated_at), r.id, a.id
      limit item_limit for share of s skip locked
      on conflict (asset_id) do nothing;
      get diagnostics changed = row_count;
      evidence_expired := evidence_expired + changed;
    end if;

    update public.workspace_run_retention set last_swept_at = sweep_time where workspace_id = target;
  end loop;

  return next;
end;
$$;

create or replace function public.purge_expired_run_transcripts(
  p_run_limit integer default 8,
  p_entry_limit integer default 250
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  expiry public.agent_run_transcript_expirations;
  max_entries integer := least(greatest(coalesce(p_entry_limit, 250), 1), 1000);
  events_deleted integer;
  completed integer := 0;
begin
  for expiry in
    select x.* from public.agent_run_transcript_expirations x
    join public.workspaces w on w.id = x.workspace_id
    where x.purged_at is null and w.deletion_requested_at is null
    order by x.expired_at, x.run_id
    limit least(greatest(coalesce(p_run_limit, 8), 1), 50)
    for update of x skip locked
  loop
    delete from public.agent_run_events where ctid in (
      select e.ctid from public.agent_run_events e
      where e.agent_run_id = expiry.run_id and e.workspace_id = expiry.workspace_id
      order by e.attempt_count, e.sequence limit max_entries
    );
    get diagnostics events_deleted = row_count;

    if events_deleted < max_entries then
      update public.agent_run_transcript_expirations
        set purged_at = clock_timestamp() where run_id = expiry.run_id;
      completed := completed + 1;
    end if;
  end loop;
  return completed;
end;
$$;

drop function public.list_workspace_run_catalog(uuid,timestamptz,uuid,uuid,public.agent_run_status,text,uuid,uuid,integer);
create function public.list_workspace_run_catalog(
  p_workspace_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_session_id uuid default null,
  p_status public.agent_run_status default null,
  p_provider text default null,
  p_stage_id uuid default null,
  p_run_id uuid default null,
  p_limit integer default 20
) returns table (
  run_id uuid,
  session_id uuid,
  session_number integer,
  session_title text,
  job_id uuid,
  attempt_count integer,
  stage_id uuid,
  stage_name text,
  model_provider text,
  model_name text,
  status public.agent_run_status,
  created_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_activity_at timestamptz,
  source_recovery_required boolean,
  has_events boolean,
  capture_ended boolean,
  capture_interrupted boolean,
  failure_receipt text,
  input_tokens bigint,
  output_tokens bigint,
  total_cost_usd numeric,
  token_provenance text,
  cost_provenance text,
  usage_finalized_at timestamptz,
  transcript_expired_at timestamptz
) language plpgsql stable security invoker set search_path = ''
  set plan_cache_mode = force_custom_plan as $$
begin
  if not exists(select 1 from public.workspaces w
    where w.id = p_workspace_id and w.deletion_requested_at is null) then
    raise exception 'Run catalog workspace is unavailable.' using errcode = 'P0002';
  end if;
  -- RLS applies independently to runs, sessions, messages and events. The
  -- bounded page is selected before any per-run transcript metadata lookup.
  return query
  with page as materialized (
    select r.id, r.session_id, s.number, left(s.title, 200) as title,
      r.agent_job_id, r.attempt_count, r.stage_id, left(r.stage_name, 128) as stage_name,
      left(r.model_provider, 64) as model_provider, left(r.model_name, 128) as model_name,
      r.status, r.created_at, r.started_at, r.finished_at, r.last_activity_at,
      r.source_recovery_required, r.input_tokens, r.output_tokens, r.total_cost_usd,
      r.token_provenance, r.cost_provenance, r.usage_finalized_at
    from public.agent_runs r
    join public.sessions s on s.id = r.session_id and s.workspace_id = r.workspace_id
    where r.workspace_id = p_workspace_id
      and (p_session_id is null or r.session_id = p_session_id)
      and (p_status is null or r.status = p_status)
      and (p_provider is null or r.model_provider = p_provider)
      and (p_stage_id is null or r.stage_id = p_stage_id)
      and (p_run_id is null or r.id = p_run_id)
      and ((p_before_created_at is null and p_before_id is null)
        or (p_before_created_at is not null and p_before_id is not null
          and (r.created_at, r.id) < (p_before_created_at, p_before_id)))
    order by r.created_at desc, r.id desc
    limit least(greatest(coalesce(p_limit, 20), 1), 51)
  )
  select p.id, p.session_id, p.number, p.title, p.agent_job_id, p.attempt_count,
    p.stage_id, p.stage_name, p.model_provider, p.model_name, p.status,
    p.created_at, p.started_at, p.finished_at, p.last_activity_at, p.source_recovery_required,
    event_presence.present is true,
    capture_end.sequence is not null,
    coalesce(capture_end.status = 'interrupted', false),
    case when receipt.value->'version' = '1'::jsonb
      and (receipt.value->>'category', receipt.value->>'code') in (
        ('configuration', 'credentials'), ('configuration', 'sandbox_configuration'),
        ('configuration', 'repository_configuration'), ('configuration', 'agent_configuration'),
        ('agent_exit', 'agent_exit'), ('agent_exit', 'agent_incomplete'),
        ('timeout', 'timeout'), ('budget', 'budget'), ('publication', 'publication'), ('unknown', 'unknown'))
      then jsonb_build_object('version', 1, 'category', receipt.value->>'category',
        'code', receipt.value->>'code')::text
      else null end,
    p.input_tokens, p.output_tokens, p.total_cost_usd,
    p.token_provenance, p.cost_provenance, p.usage_finalized_at, expiry.expired_at
  from page p
  left join public.agent_run_transcript_expirations expiry
    on expiry.run_id = p.id and expiry.workspace_id = p_workspace_id
  left join lateral (
    select true as present from public.agent_run_events e
    where e.agent_run_id = p.id and e.workspace_id = p_workspace_id
      and e.attempt_count = p.attempt_count
    limit 1
  ) event_presence on true
  left join lateral (
    select e.sequence, e.payload->>'status' as status
    from public.agent_run_events e
    where e.agent_run_id = p.id and e.workspace_id = p_workspace_id
      and e.attempt_count = p.attempt_count and e.kind = 'capture_end'
    order by e.sequence desc limit 1
  ) capture_end on true
  left join lateral (
    select case when octet_length(m.message_md) <= 512 then
      case when m.message_md is json object then m.message_md::jsonb else null end
      else null end as value
    from public.agent_run_messages m
    where m.agent_run_id = p.id and m.workspace_id = p_workspace_id and m.kind = 'run_failure'
    limit 1
  ) receipt on true
  order by p.created_at desc, p.id desc;
end;
$$;

revoke all on function public.list_workspace_run_catalog(uuid,timestamptz,uuid,uuid,public.agent_run_status,text,uuid,uuid,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_workspace_run_catalog(uuid,timestamptz,uuid,uuid,public.agent_run_status,text,uuid,uuid,integer)
  to authenticated;

comment on function public.list_workspace_run_catalog(uuid,timestamptz,uuid,uuid,public.agent_run_status,text,uuid,uuid,integer)
  is 'Tenant-scoped run metadata only, at most 51 rows. Preserve timestamp precision in the descending created_at/id cursor; refresh the head for concurrent appends.';

drop index internal.run_export_entries_transcript_idx;
create index run_export_entries_transcript_idx on internal.run_export_entries(run_id, export_id)
  where record_kind = 'event' and availability in ('available', 'gap');

create or replace function internal.snapshot_run_export(p_job public.run_exports)
returns table(item_count bigint, source_expires_at timestamptz, snapshot_visibility pg_snapshot)
language plpgsql security invoker set search_path = '' as $$
begin
  with runs as materialized (
    select r.id, r.session_id, s.number as session_number, left(s.title, 200) as session_title,
      r.agent_job_id, r.attempt_count, r.stage_id, left(r.stage_slug, 128) as stage_slug,
      left(r.stage_name, 128) as stage_name, left(r.model_provider, 64) as model_provider,
      left(r.model_name, 128) as model_name, r.status, r.created_at, r.started_at,
      r.finished_at, r.last_activity_at, r.input_tokens, r.output_tokens, r.total_cost_usd,
      r.token_provenance, r.cost_provenance, r.usage_finalized_at,
      coalesce(expiry.expired_at, transcript_deadline.expired_at) as expired_at,
      s.archived_at as session_archived_at, policy.evidence_days,
      case when r.status in ('success', 'error', 'canceled') then coalesce(r.finished_at, r.updated_at)
        else p_job.snapshot_at end as terminal_at,
      case when r.status in ('success', 'error', 'canceled') then coalesce(r.finished_at, r.updated_at)
        else p_job.snapshot_at end + internal.run_retention_duration(policy.transcript_days) as transcript_cutoff
    from public.agent_runs r
    join public.sessions s on (s.id, s.workspace_id) = (r.session_id, r.workspace_id)
    left join public.agent_run_transcript_expirations expiry
      on (expiry.run_id, expiry.workspace_id) = (r.id, r.workspace_id)
    left join public.workspace_run_retention policy on policy.workspace_id = r.workspace_id
    left join lateral (
      select coalesce(r.finished_at, r.updated_at) + internal.run_retention_duration(policy.transcript_days) as expired_at
      where expiry.run_id is null and policy.transcript_days is not null
        and r.status in ('success', 'error', 'canceled')
        and coalesce(r.finished_at, r.updated_at) <= p_job.snapshot_at - internal.run_retention_duration(policy.transcript_days)
        and exists (
          select 1 from public.agent_run_events o
          where (o.agent_run_id, o.workspace_id, o.attempt_count) = (r.id, r.workspace_id, r.attempt_count)
        )
    ) transcript_deadline on true
    where r.workspace_id = p_job.workspace_id
  ),
  events as materialized (
    select e.agent_run_id, e.attempt_count, e.sequence, e.causation_sequence, e.kind,
      e.schema_version, e.truncated, e.created_at,
      case when e.kind = 'capture_end' then e.payload->>'status' end as capture_status,
      lag(e.sequence, 1, 0) over (partition by e.agent_run_id order by e.sequence) as previous_sequence
    from runs r join public.agent_run_events e
      on (e.agent_run_id, e.attempt_count) = (r.id, r.attempt_count)
    where e.workspace_id = p_job.workspace_id and r.expired_at is null
  ),
  capture_ends as (
    select distinct on (agent_run_id) agent_run_id, capture_status
    from events where kind = 'capture_end' order by agent_run_id, sequence desc
  ),
  diagnostics as materialized (
    select m.id, m.agent_run_id, r.attempt_count, m.kind, m.created_at,
      case when octet_length(m.message_md) > 1048576 then 'inaccessible' else 'available' end as state
    from runs r join public.agent_run_messages m on m.agent_run_id = r.id
    where m.workspace_id = p_job.workspace_id
      and m.kind in ('run_failure', 'worker_error', 'worker_progress', 'worker_completion')
  ),
  checkpoints as materialized (
    select c.run_id, c.session_id, c.artifact_id, c.attempt_count, c.repository_id,
      c.initial_base_sha, c.input_sha, c.output_sha, c.output_kind, c.bundle_sha256, c.created_at
    from runs r join public.session_git_checkpoints c
      on (c.run_id, c.session_id, c.job_id, c.attempt_count) =
         (r.id, r.session_id, r.agent_job_id, r.attempt_count)
    where c.workspace_id = p_job.workspace_id
  ),
  receipts as materialized (
    select e.run_id, e.session_id, e.job_id, e.attempt_count, e.repository_id, e.commit_sha,
      e.validation_tree_sha, e.created_at, r.session_archived_at, r.evidence_days, r.terminal_at, r.status
    from runs r join public.session_validation_evidence e
      on (e.run_id, e.session_id, e.job_id, e.attempt_count) =
         (r.id, r.session_id, r.agent_job_id, r.attempt_count)
    where e.workspace_id = p_job.workspace_id
  ),
  stage_artifacts as (
    select a.id, a.session_id, c.run_id, c.attempt_count, a.stage_id, a.stage_slug, a.version,
      a.created_at, markdown.body
    from public.session_artifacts a
    join public.sessions s on (s.id, s.workspace_id) = (a.session_id, a.workspace_id)
    left join checkpoints c on (c.artifact_id, c.session_id) = (a.id, a.session_id)
    cross join lateral (
      select case when jsonb_typeof(a.artifact_json) = 'string' then a.artifact_json #>> '{}' end as body
    ) markdown
    where a.workspace_id = p_job.workspace_id
  ),
  validation_assets as materialized (
    select a.id, a.run_id, a.session_id, a.kind, a.evidence_key, a.required, a.sha256,
      a.size_bytes, a.content_type, e.attempt_count, e.commit_sha, e.validation_tree_sha,
      a.required and e.session_archived_at is null as requires_archive,
      greatest(e.created_at, e.terminal_at) + internal.run_retention_duration(e.evidence_days) as age_deadline,
      coalesce(w.state, case when e.evidence_days is not null and (not a.required or e.session_archived_at is not null)
        and e.status in ('success', 'error', 'canceled')
        and greatest(e.created_at, e.terminal_at) <= p_job.snapshot_at - internal.run_retention_duration(e.evidence_days)
        then 'expired' else 'recorded' end) as state
    from receipts e join public.session_validation_assets a
      on (a.run_id, a.session_id) = (e.run_id, e.session_id)
    left join public.session_validation_asset_withholdings w on w.asset_id = a.id
    where a.workspace_id = p_job.workspace_id
  ),
  entries as (
    select 1 as rank, 'run' as kind, r.id as source_id, r.id as run_id, r.attempt_count,
      null::integer as event_sequence, 'available' as state,
      to_jsonb(r) - '{id,expired_at,session_archived_at,evidence_days,terminal_at,transcript_cutoff}'::text[] as metadata
    from runs r

    union all
    select 2, 'event', md5('agent_run_event:' || e.agent_run_id::text || ':' ||
      e.attempt_count::text || ':' || e.sequence::text)::uuid,
      e.agent_run_id, e.attempt_count, e.sequence,
      case when e.kind = 'capture_gap' then 'gap' else 'available' end,
      to_jsonb(e) - 'agent_run_id' - 'previous_sequence' - 'capture_status'
    from events e

    union all
    select 3, 'run_diagnostic', d.id, d.agent_run_id, d.attempt_count, null, d.state,
      jsonb_strip_nulls(jsonb_build_object('kind', d.kind, 'created_at', d.created_at,
        'reason', case when d.state = 'inaccessible' then 'diagnostic_exceeds_limit' end))
    from diagnostics d

    union all
    select 4, 'capture_gap', r.id, r.id, r.attempt_count, null,
      case when r.expired_at is not null then 'expired' else 'gap' end,
      jsonb_strip_nulls(jsonb_build_object('expired_at', r.expired_at, 'reason', case
        when r.expired_at is not null then 'retention_expired'
        when ce.capture_status = 'interrupted' then 'capture_interrupted'
        when exists(select 1 from events e where e.agent_run_id = r.id) then 'capture_end_missing'
        else 'no_retained_transcript' end))
    from runs r left join capture_ends ce on ce.agent_run_id = r.id
    where r.expired_at is not null or ce.capture_status is distinct from 'complete'

    union all
    select 4, 'capture_gap',
      md5('agent_run_export_gap:' || e.agent_run_id::text || ':' || e.attempt_count::text ||
        ':' || e.sequence::text)::uuid,
      e.agent_run_id, e.attempt_count, e.sequence, 'gap',
      jsonb_build_object('reason', 'missing_event_sequences', 'first_sequence', e.previous_sequence + 1,
        'last_sequence', e.sequence - 1)
    from events e where e.sequence > e.previous_sequence + 1

    union all
    select 5, 'stage_markdown', a.id, a.run_id, a.attempt_count, null,
      case when octet_length(a.body) <= 1048576 then 'available' else 'inaccessible' end,
      jsonb_strip_nulls(jsonb_build_object('session_id', a.session_id, 'stage_id', a.stage_id,
        'stage_slug', left(a.stage_slug, 128), 'version', a.version, 'created_at', a.created_at,
        'content_type', 'text/markdown', 'size_bytes', octet_length(a.body),
        'sha256', case when octet_length(a.body) <= 1048576
          then encode(sha256(convert_to(a.body, 'UTF8')), 'hex') end,
        'provenance', case when a.run_id is null then 'legacy_unlinked' else 'accepted_checkpoint' end,
        'reason', case when a.body is null then 'unsupported_markdown_encoding'
          when octet_length(a.body) > 1048576 then 'markdown_exceeds_limit' end))
    from stage_artifacts a

    union all
    select 6, 'checkpoint', c.run_id, c.run_id, c.attempt_count, null, 'metadata_only',
      to_jsonb(c) - 'run_id' || jsonb_build_object('reason', 'private_source_checkpoint')
    from checkpoints c

    union all
    select 7, 'validation_receipt', e.run_id, e.run_id, e.attempt_count, null, 'available',
      to_jsonb(e) - '{run_id,session_archived_at,evidence_days,terminal_at,status}'::text[]
    from receipts e

    union all
    select 8, 'validation_asset', a.id, a.run_id, a.attempt_count, null, a.state,
      jsonb_build_object('session_id', a.session_id, 'kind', a.kind, 'key', a.evidence_key,
        'required', a.required, 'sha256', a.sha256, 'size_bytes', a.size_bytes,
        'content_type', a.content_type, 'validation_commit_sha', a.commit_sha,
        'validation_tree_sha', a.validation_tree_sha)
    from validation_assets a
  ),
  roster as (
    insert into internal.run_export_entries(
      export_id, ordinal, record_kind, record_id, run_id, attempt_count, event_sequence, availability, metadata
    )
    select p_job.id, row_number() over (order by x.rank, x.run_id, x.event_sequence, x.source_id),
      x.kind, x.source_id, x.run_id, x.attempt_count, x.event_sequence, x.state, x.metadata
    from entries x
    returning 1
  ),
  archive_deadlines as (
    insert into internal.run_export_archive_deadlines(export_id, session_id, age_deadline)
    select p_job.id, a.session_id, min(a.age_deadline) from validation_assets a
    where a.state = 'recorded' and a.requires_archive and a.age_deadline is not null
    group by a.session_id
  )
  select (select count(*) from roster), least(
    (select min(a.age_deadline) from validation_assets a where a.state = 'recorded' and not a.requires_archive),
    (select min(r.transcript_cutoff) from runs r
      where exists(select 1 from events e where e.agent_run_id = r.id))
  ), pg_current_snapshot() into item_count, source_expires_at, snapshot_visibility;
  return next;
end;
$$;

create or replace function public.read_run_export_page(p_export_id uuid, p_lease_token uuid, p_limit integer default 50)
returns table (
  ordinal bigint,
  record_kind text,
  record_id uuid,
  run_id uuid,
  availability text,
  metadata jsonb,
  payload jsonb,
  source_asset_id uuid
) language sql stable security definer set search_path = '' as $$
  with page as materialized (
    select i.*, j.workspace_id
    from public.run_exports j
    join public.workspaces w on w.id = j.workspace_id and w.deletion_requested_at is null
    join internal.run_export_entries i on i.export_id = j.id
    where j.id = p_export_id and j.status = 'running' and j.lease_token = p_lease_token
      and j.expires_at > statement_timestamp() and j.lease_expires_at > statement_timestamp()
      and coalesce(internal.run_export_source_expiry(j) > statement_timestamp(), true)
      and i.ordinal >= j.next_ordinal
    order by i.ordinal
    limit least(greatest(coalesce(p_limit, 50), 1), 50)
  ),
  bodies as (
    select p.*, case
      when p.record_kind = 'event' then e.payload
      when p.record_kind = 'run_diagnostic' and p.availability = 'available'
        and octet_length(m.message_md) <= 1048576 then to_jsonb(m.message_md)
      when p.record_kind = 'stage_markdown' and p.availability = 'available'
        and jsonb_typeof(a.artifact_json) = 'string'
        and octet_length(a.artifact_json #>> '{}') <= 1048576
        and encode(sha256(convert_to(a.artifact_json #>> '{}', 'UTF8')), 'hex') = p.metadata->>'sha256'
        then a.artifact_json
      when p.record_kind = 'validation_receipt' then r.records end as body
    from page p
    left join public.agent_run_events e on p.record_kind = 'event'
      and (e.workspace_id, e.agent_run_id, e.attempt_count, e.sequence) =
          (p.workspace_id, p.run_id, p.attempt_count, p.event_sequence)
    left join public.agent_run_messages m on p.record_kind = 'run_diagnostic'
      and (m.workspace_id, m.agent_run_id, m.id, m.kind) =
          (p.workspace_id, p.run_id, p.record_id, p.metadata->>'kind')
      and m.kind in ('run_failure', 'worker_error', 'worker_progress', 'worker_completion')
    left join public.session_artifacts a on p.record_kind = 'stage_markdown'
      and (a.workspace_id, a.id, a.session_id::text) =
          (p.workspace_id, p.record_id, p.metadata->>'session_id')
    left join public.session_validation_evidence r on p.record_kind = 'validation_receipt'
      and (r.workspace_id, r.run_id, r.attempt_count, r.session_id::text, r.job_id::text) =
          (p.workspace_id, p.run_id, p.attempt_count, p.metadata->>'session_id', p.metadata->>'job_id')
  ),
  sized as (
    select b.*, sum(octet_length(b.metadata::text) + coalesce(octet_length(b.body::text), 0) + 512)
      over (order by b.ordinal rows unbounded preceding) as page_bytes,
      min(b.ordinal) over () as first_ordinal
    from bodies b
  )
  select s.ordinal, s.record_kind, s.record_id, s.run_id,
    case when s.availability = 'available' and s.record_kind in (
      'event', 'run_diagnostic', 'stage_markdown', 'validation_receipt'
    ) and s.body is null then 'missing' else s.availability end,
    s.metadata, s.body,
    case when s.record_kind = 'validation_asset' and s.availability = 'recorded' then s.record_id end
  from sized s where s.ordinal = s.first_ordinal or s.page_bytes <= 2097152
  order by s.ordinal;
$$;

create or replace function internal.revoke_run_exports_for_source()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid;
begin
  if tg_table_name = 'agent_run_transcript_expirations' then
    owner_id := new.workspace_id;
  else
    select a.workspace_id into owner_id from public.session_validation_assets a where a.id = new.asset_id;
  end if;
  perform 1 from public.workspaces where id = owner_id for no key update;

  if tg_table_name = 'agent_run_transcript_expirations' then
    update public.run_exports j set status = 'expired', failure_code = 'source_withheld',
      expires_at = clock_timestamp(), lease_token = null, lease_expires_at = null
    where j.workspace_id = owner_id and j.status in ('running', 'completed') and exists (
      select 1 from internal.run_export_entries i where i.export_id = j.id and i.run_id = new.run_id
        and i.record_kind = 'event' and i.availability in ('available', 'gap')
    );
  else
    update public.run_exports j set status = 'expired', failure_code = 'source_withheld',
      expires_at = clock_timestamp(), lease_token = null, lease_expires_at = null
    where j.workspace_id = owner_id and j.status in ('running', 'completed') and exists (
      select 1 from internal.run_export_entries i where i.export_id = j.id and i.record_id = new.asset_id
        and i.record_kind = 'validation_asset' and i.availability = 'recorded'
    );
  end if;
  return new;
end;
$$;

-- Frozen legacy pages cannot resume with the events-only schema. Retire those
-- exports through the existing cleanup path and preserve unrelated jobs.
update public.run_exports j set status = 'expired', failure_code = 'source_withheld',
  expires_at = clock_timestamp(), lease_token = null, lease_expires_at = null
where j.status in ('running', 'completed') and exists (
  select 1 from internal.run_export_entries i where i.export_id = j.id and i.record_kind = 'legacy_message'
);
