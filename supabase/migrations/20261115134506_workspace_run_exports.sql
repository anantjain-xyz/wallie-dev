-- Export snapshots freeze membership and catalog metadata in one MVCC statement.
-- The roster keeps source identities, while private Storage owns published bytes.
create table public.run_exports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  requested_by uuid not null,
  request_id uuid not null,
  requested_at timestamptz not null default clock_timestamp(),
  snapshot_at timestamptz,
  snapshot_visibility pg_snapshot,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'expired')),
  item_count bigint not null default 0 check (item_count >= 0),
  next_ordinal bigint not null default 1 check (next_ordinal between 1 and item_count + 1),
  completed_at timestamptz,
  source_expires_at timestamptz,
  expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
  failure_code text check (failure_code in ('build_timeout', 'source_withheld')),
  lease_token uuid,
  lease_expires_at timestamptz,
  ready_at timestamptz not null default clock_timestamp(),
  cleaned_at timestamptz,
  unique (id, workspace_id),
  unique (workspace_id, requested_by, request_id),
  check ((lease_token is null) = (lease_expires_at is null))
);

create unique index run_exports_active_workspace_idx
  on public.run_exports(workspace_id) where status in ('queued', 'running');
create index run_exports_workspace_requested_idx on public.run_exports(workspace_id, requested_at desc, id desc);
create index run_exports_claim_idx on public.run_exports(ready_at, requested_at, id)
  where status in ('queued', 'running');
create index run_exports_cleanup_idx on public.run_exports(expires_at, id)
  where cleaned_at is null;

create table internal.run_export_entries (
  export_id uuid not null references public.run_exports(id) on delete cascade,
  ordinal bigint not null,
  record_kind text not null,
  record_id uuid not null,
  run_id uuid,
  attempt_count integer,
  event_sequence integer,
  availability text not null,
  metadata jsonb not null,
  primary key (export_id, ordinal)
);
create index run_export_entries_transcript_idx on internal.run_export_entries(run_id, export_id)
  where record_kind in ('event', 'legacy_message') and availability in ('available', 'gap');
create index run_export_entries_asset_idx on internal.run_export_entries(record_id, export_id)
  where record_kind = 'validation_asset' and availability = 'recorded';

create table public.run_export_pages (
  export_id uuid not null,
  workspace_id uuid not null,
  first_ordinal bigint not null check (first_ordinal > 0),
  last_ordinal bigint not null check (last_ordinal >= first_ordinal),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  primary key (export_id, first_ordinal),
  foreign key (export_id, workspace_id) references public.run_exports(id, workspace_id) on delete cascade
);

create table public.run_export_assets (
  export_id uuid not null,
  workspace_id uuid not null,
  asset_id uuid not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes integer not null check (size_bytes between 0 and 1048576),
  content_type text not null check (content_type in ('application/json', 'text/plain')),
  primary key (export_id, asset_id),
  foreign key (export_id, workspace_id) references public.run_exports(id, workspace_id) on delete cascade
);

-- A required report remains protected while its session is active. Record
-- later archive transitions without taking export/workspace locks in the
-- lifecycle transaction. Transaction visibility finds archives that committed
-- after the snapshot even when their transaction's timestamp predates it.
create table internal.run_export_archive_deadlines (
  export_id uuid not null references public.run_exports(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  age_deadline timestamptz not null,
  primary key (export_id, session_id)
);
create index run_export_archive_deadlines_session_idx on internal.run_export_archive_deadlines(session_id);

create table internal.run_export_session_archives (
  session_id uuid not null references public.sessions(id) on delete cascade,
  archived_at timestamptz not null,
  archive_transaction xid8 not null,
  primary key (session_id, archive_transaction, archived_at)
);

create function internal.record_run_export_session_archive()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into internal.run_export_session_archives(session_id, archived_at, archive_transaction)
  values (new.id, new.archived_at, pg_current_xact_id()) on conflict do nothing;
  return new;
end;
$$;

create trigger record_run_export_session_archive after update of archived_at on public.sessions
  for each row when (new.archived_at is not null and new.archived_at is distinct from old.archived_at)
  execute function internal.record_run_export_session_archive();

create function internal.run_export_source_expiry(p_job public.run_exports)
returns timestamptz language sql stable security invoker set search_path = '' as $$
  select least(p_job.source_expires_at, (
    select min(greatest(d.age_deadline, a.archived_at))
    from internal.run_export_archive_deadlines d
    join lateral (
      select x.archived_at from internal.run_export_session_archives x
      where x.session_id = d.session_id
        and (x.archived_at >= p_job.snapshot_at or (
          x.archive_transaction >= pg_snapshot_xmin(p_job.snapshot_visibility)
          and not pg_visible_in_snapshot(x.archive_transaction, p_job.snapshot_visibility)
        ))
      order by x.archived_at limit 1
    ) a on true
    where d.export_id = p_job.id
  ));
$$;

alter table public.run_exports enable row level security;
alter table public.run_export_pages enable row level security;
alter table public.run_export_assets enable row level security;
alter table internal.run_export_entries enable row level security;
alter table internal.run_export_archive_deadlines enable row level security;
alter table internal.run_export_session_archives enable row level security;
revoke all on public.run_exports, public.run_export_pages, public.run_export_assets,
  internal.run_export_entries, internal.run_export_archive_deadlines, internal.run_export_session_archives
  from public, anon, authenticated, service_role;
grant select on public.run_exports, public.run_export_pages, public.run_export_assets to service_role;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('workspace-run-exports', 'workspace-run-exports', false, 4194304, array['application/json', 'text/plain']);

create function internal.is_run_export_manager(p_workspace_id uuid, p_user_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    join public.workspaces w on w.id = m.workspace_id and w.deletion_requested_at is null
    where m.workspace_id = p_workspace_id and m.user_id = p_user_id
      and m.is_active and m.kind = 'human' and m.role in ('owner', 'admin')
  );
$$;

create function public.request_run_export(p_workspace_id uuid, p_requested_by uuid, p_request_id uuid)
returns public.run_exports language plpgsql security definer set search_path = '' as $$
declare job public.run_exports;
begin
  perform 1 from public.workspaces w where w.id = p_workspace_id and w.deletion_requested_at is null
    for no key update;
  if not found then
    raise exception 'Run export workspace is unavailable.' using errcode = 'P0002';
  end if;
  perform 1 from public.workspace_members m
  where (m.workspace_id, m.user_id) = (p_workspace_id, p_requested_by)
    and m.is_active and m.kind = 'human' and m.role in ('owner', 'admin')
  for share;
  if not found then
    raise exception 'Run export workspace is unavailable.' using errcode = 'P0002';
  end if;
  if p_request_id is null then
    raise exception 'Run export request ID is required.' using errcode = '22023';
  end if;

  select * into job from public.run_exports e
  where (e.workspace_id, e.requested_by, e.request_id) = (p_workspace_id, p_requested_by, p_request_id);
  if found then return internal.run_export_current_status(job); end if;

  update public.run_exports e set status = current.status, failure_code = current.failure_code,
    lease_token = null, lease_expires_at = null, expires_at = current.expires_at
  from public.run_exports existing
  cross join lateral internal.run_export_current_status(existing) current
  where e.id = existing.id and e.workspace_id = p_workspace_id and e.status in ('queued', 'running')
    and current.status in ('failed', 'expired');

  if exists(select 1 from public.run_exports e
    where e.workspace_id = p_workspace_id and e.status in ('queued', 'running')) then
    raise exception 'A run export is already in progress.' using errcode = '55000';
  end if;

  insert into public.run_exports(workspace_id, requested_by, request_id)
  values (p_workspace_id, p_requested_by, p_request_id) returning * into job;
  return job;
end;
$$;

create function internal.run_export_current_status(p_job public.run_exports)
returns public.run_exports language plpgsql stable security invoker set search_path = '' as $$
declare
  source_expiry timestamptz := internal.run_export_source_expiry(p_job);
begin
  p_job.expires_at := least(p_job.expires_at, source_expiry);
  if p_job.status in ('queued', 'running', 'completed') and source_expiry <= statement_timestamp() then
    p_job.status := 'expired';
    p_job.failure_code := 'source_withheld';
  elsif p_job.expires_at <= statement_timestamp() then
    if p_job.status = 'completed' then
      p_job.status := 'expired';
    elsif p_job.status in ('queued', 'running') then
      p_job.status := 'failed';
      p_job.failure_code := 'build_timeout';
    end if;
  end if;
  return p_job;
end;
$$;

create function public.list_run_exports(p_workspace_id uuid, p_user_id uuid, p_limit integer default 10)
returns setof public.run_exports language sql stable security definer set search_path = '' as $$
  select internal.run_export_current_status(j) from public.run_exports j
  where j.workspace_id = p_workspace_id and internal.is_run_export_manager(p_workspace_id, p_user_id)
  order by j.requested_at desc, j.id desc
  limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

create function public.get_run_export_access(
  p_workspace_id uuid, p_export_id uuid, p_user_id uuid, p_session_id uuid
) returns setof public.run_exports language sql stable security definer set search_path = '' as $$
  select internal.run_export_current_status(j) from public.run_exports j
  where (j.workspace_id, j.id) = (p_workspace_id, p_export_id)
    and internal.is_run_export_manager(p_workspace_id, p_user_id)
    and exists(select 1 from auth.sessions s where (s.id, s.user_id) = (p_session_id, p_user_id)
      and (s.not_after is null or s.not_after > statement_timestamp()));
$$;

create function internal.snapshot_run_export(p_job public.run_exports)
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
        and (
          exists(select 1 from public.agent_run_events o where o.agent_run_id = r.id and o.workspace_id = r.workspace_id)
          or exists(select 1 from public.agent_run_messages m where m.agent_run_id = r.id
            and m.workspace_id = r.workspace_id and m.kind <> 'run_failure')
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
  projection_ids as (
    select md5('agent_run_event:' || e.agent_run_id::text || ':' || e.attempt_count::text ||
      ':' || e.sequence::text)::uuid as id
    from events e where e.kind in ('text', 'progress', 'tool_call', 'tool_result', 'terminal')
      and not e.truncated
  ),
  legacy_messages as materialized (
    select m.id, m.agent_run_id, left(m.kind, 64) as kind, m.created_at,
      case when m.kind not in ('user', 'assistant', 'text', 'progress', 'tool_use', 'completion', 'error', 'run_failure')
        or octet_length(m.message_md) > 1048576 then 'inaccessible' else 'available' end as state,
      case when m.kind not in ('user', 'assistant', 'text', 'progress', 'tool_use', 'completion', 'error', 'run_failure')
        then 'unknown_legacy_message_kind'
        when octet_length(m.message_md) > 1048576 then 'legacy_message_exceeds_limit' end as reason
    from runs r join public.agent_run_messages m on m.agent_run_id = r.id
    where m.workspace_id = p_job.workspace_id and (r.expired_at is null or m.kind = 'run_failure')
      and not exists(select 1 from projection_ids p where p.id = m.id)
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
    select 3, 'legacy_message', m.id, m.agent_run_id, null, null, m.state,
      jsonb_strip_nulls(jsonb_build_object('kind', m.kind, 'created_at', m.created_at,
        'provenance', 'legacy_unsequenced', 'reason', m.reason))
    from legacy_messages m

    union all
    select 4, 'capture_gap', r.id, r.id, r.attempt_count, null,
      case when r.expired_at is not null then 'expired' else 'gap' end,
      jsonb_strip_nulls(jsonb_build_object('expired_at', r.expired_at, 'reason', case
        when r.expired_at is not null then 'retention_expired'
        when ce.capture_status = 'interrupted' then 'capture_interrupted'
        when exists(select 1 from events e where e.agent_run_id = r.id) then 'capture_end_missing'
        when exists(select 1 from legacy_messages m where m.agent_run_id = r.id) then 'legacy_unsequenced'
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
      where r.expired_at is null and (exists(select 1 from events e where e.agent_run_id = r.id)
        or exists(select 1 from legacy_messages m where m.agent_run_id = r.id
          and m.kind <> 'run_failure' and m.state = 'available')))
  ), pg_current_snapshot() into item_count, source_expires_at, snapshot_visibility;
  return next;
end;
$$;

create function public.claim_run_export()
returns table (
  export_id uuid, workspace_id uuid, lease_token uuid, snapshot_at timestamptz, next_ordinal bigint, status text
) language plpgsql security definer set search_path = '' as $$
declare
  candidate uuid;
  job public.run_exports;
begin
  select e.id into candidate from public.run_exports e
  join public.workspaces w on w.id = e.workspace_id and w.deletion_requested_at is null
  where e.status in ('queued', 'running') and e.expires_at > clock_timestamp()
    and coalesce(internal.run_export_source_expiry(e) > clock_timestamp(), true)
    and e.ready_at <= clock_timestamp()
    and (e.lease_expires_at is null or e.lease_expires_at <= clock_timestamp())
  order by e.ready_at, e.requested_at, e.id
  limit 1 for no key update of w skip locked;
  if not found then return; end if;

  select * into strict job from public.run_exports e where e.id = candidate for update;
  if job.status not in ('queued', 'running') or job.expires_at <= clock_timestamp()
    or job.ready_at > clock_timestamp() or job.lease_expires_at > clock_timestamp() then
    return;
  end if;
  if job.snapshot_at is null then
    job.snapshot_at := clock_timestamp();
    select x.item_count, x.source_expires_at, x.snapshot_visibility
      into job.item_count, job.source_expires_at, job.snapshot_visibility
    from internal.snapshot_run_export(job) x;
  end if;

  return query update public.run_exports e set status = 'running', lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + interval '2 minutes',
    snapshot_at = job.snapshot_at, snapshot_visibility = job.snapshot_visibility,
    item_count = job.item_count, source_expires_at = job.source_expires_at
  where e.id = candidate
  returning e.id, e.workspace_id, e.lease_token, e.snapshot_at, e.next_ordinal, e.status;
end;
$$;

create function public.read_run_export_page(p_export_id uuid, p_lease_token uuid, p_limit integer default 50)
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
      when p.record_kind = 'legacy_message' and p.availability = 'available'
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
    left join public.agent_run_messages m on p.record_kind = 'legacy_message'
      and (m.workspace_id, m.agent_run_id, m.id) = (p.workspace_id, p.run_id, p.record_id)
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
      'event', 'legacy_message', 'stage_markdown', 'validation_receipt'
    ) and s.body is null then 'missing' else s.availability end,
    s.metadata, s.body,
    case when s.record_kind = 'validation_asset' and s.availability = 'recorded' then s.record_id end
  from sized s where s.ordinal = s.first_ordinal or s.page_bytes <= 2097152
  order by s.ordinal;
$$;

-- Every state-changing processing RPC acquires the workspace before the
-- export row, matching withholdings, retention and deletion.
create function internal.lock_run_export_lease(p_export_id uuid, p_lease_token uuid)
returns public.run_exports language plpgsql security invoker set search_path = '' as $$
declare
  target uuid;
  job public.run_exports;
begin
  select e.workspace_id into target from public.run_exports e where e.id = p_export_id;
  perform 1 from public.workspaces where id = target and deletion_requested_at is null for share;
  if not found then return null; end if;
  select * into job from public.run_exports e where e.id = p_export_id and e.status = 'running'
    and e.lease_token = p_lease_token and e.lease_expires_at > clock_timestamp()
    and e.expires_at > clock_timestamp()
    and coalesce(internal.run_export_source_expiry(e) > clock_timestamp(), true) for update;
  return job;
end;
$$;

create function internal.run_export_has_object(p_path text, p_size integer)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists(select 1 from storage.objects
    where bucket_id = 'workspace-run-exports' and name = p_path and metadata->>'size' = p_size::text
  );
$$;

create function public.commit_run_export_page(
  p_export_id uuid,
  p_lease_token uuid,
  p_first_ordinal bigint,
  p_page_sha256 text,
  p_page_size_bytes integer,
  p_entries jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  job public.run_exports;
  entry_count integer;
  last_ordinal bigint;
  object_prefix text;
  invalid_entries boolean;
begin
  job := internal.lock_run_export_lease(p_export_id, p_lease_token);
  if job.id is null or p_first_ordinal is distinct from job.next_ordinal then return false; end if;
  if p_page_sha256 is null or p_page_sha256 !~ '^[a-f0-9]{64}$'
    or p_page_size_bytes is null or p_page_size_bytes not between 1 and 4194304
    or jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'Invalid run export page.' using errcode = '22023';
  end if;
  entry_count := jsonb_array_length(p_entries);
  last_ordinal := p_first_ordinal + entry_count - 1;
  if entry_count not between 1 and 50 or last_ordinal > job.item_count then
    raise exception 'Run export page is outside the snapshot.' using errcode = '22023';
  end if;

  object_prefix := job.workspace_id::text || '/' || job.id::text;
  if not internal.run_export_has_object(
    object_prefix || '/pages/' || p_first_ordinal::text || '-' || p_page_sha256 || '.json', p_page_size_bytes
  ) then
    raise exception 'Run export page object is missing.' using errcode = '23514';
  end if;

  with supplied as (
    select * from jsonb_to_recordset(p_entries)
      as x(ordinal bigint, availability text, asset_sha256 text, asset_size_bytes integer)
  ),
  matched as (
    select x.*, i.availability as snapshot_state, i.record_kind, i.record_id, i.metadata
    from supplied x left join internal.run_export_entries i
      on i.export_id = job.id and i.ordinal = x.ordinal
  )
  select count(distinct m.ordinal) <> entry_count or count(*) filter (
    where m.ordinal not between p_first_ordinal and last_ordinal
      or m.snapshot_state is null or m.availability is null
      or (m.snapshot_state = 'recorded' and m.availability not in (
        'available', 'missing', 'inaccessible', 'redacted', 'expired'
      ))
      or (m.snapshot_state = 'available' and m.availability not in ('available', 'missing', 'inaccessible'))
      or (m.snapshot_state not in ('available', 'recorded') and m.snapshot_state <> m.availability)
      or case when m.record_kind = 'validation_asset' and m.availability = 'available' then
        (m.asset_sha256, m.asset_size_bytes::text) is distinct from
          (m.metadata->>'sha256', m.metadata->>'size_bytes')
        or not internal.run_export_has_object(
          object_prefix || '/assets/' || m.record_id::text || '-' || m.asset_sha256, m.asset_size_bytes
        )
      else m.asset_sha256 is not null or m.asset_size_bytes is not null end
  ) > 0 into invalid_entries from matched m;
  if invalid_entries then
    raise exception 'Run export page omits or mislabels snapshot entries.' using errcode = '23514';
  end if;

  insert into public.run_export_pages(export_id, workspace_id, first_ordinal, last_ordinal, sha256, size_bytes)
  values (job.id, job.workspace_id, p_first_ordinal, last_ordinal, p_page_sha256, p_page_size_bytes);

  insert into public.run_export_assets(export_id, workspace_id, asset_id, sha256, size_bytes, content_type)
  select job.id, job.workspace_id, i.record_id, x.asset_sha256, x.asset_size_bytes, i.metadata->>'content_type'
  from jsonb_to_recordset(p_entries)
    as x(ordinal bigint, availability text, asset_sha256 text, asset_size_bytes integer)
  join internal.run_export_entries i on i.export_id = job.id and i.ordinal = x.ordinal
  where i.record_kind = 'validation_asset' and x.availability = 'available';

  update public.run_exports set next_ordinal = last_ordinal + 1,
    lease_expires_at = clock_timestamp() + interval '2 minutes'
  where id = job.id;
  return true;
end;
$$;

create function public.complete_run_export(p_export_id uuid, p_lease_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  job public.run_exports;
  finished timestamptz := clock_timestamp();
begin
  job := internal.lock_run_export_lease(p_export_id, p_lease_token);
  -- Only contiguous committed pages advance the ordinal. Snapshot membership
  -- cannot be altered by workers, so reaching its end proves coverage.
  if job.id is null or job.snapshot_at is null or job.next_ordinal <> job.item_count + 1 then return false; end if;
  update public.run_exports set status = 'completed', completed_at = finished,
    expires_at = least(finished + interval '168 hours', internal.run_export_source_expiry(job)),
    lease_token = null, lease_expires_at = null where id = job.id;
  return true;
end;
$$;

create function public.release_run_export(p_export_id uuid, p_lease_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  job public.run_exports;
begin
  job := internal.lock_run_export_lease(p_export_id, p_lease_token);
  if job.id is null then return false; end if;
  update public.run_exports set lease_token = null, lease_expires_at = null,
    ready_at = clock_timestamp() + interval '5 seconds' where id = job.id;
  return true;
end;
$$;

create function public.list_run_export_cleanup(p_limit integer default 10)
returns table (export_id uuid, workspace_id uuid)
language sql security definer set search_path = '' as $$
  with candidates as (
    select j.id, current.status, current.failure_code, current.expires_at from public.run_exports j
    cross join lateral internal.run_export_current_status(j) current
    where j.cleaned_at is null and j.ready_at <= statement_timestamp()
      and current.status in ('failed', 'expired')
    order by current.expires_at, j.id
    limit least(greatest(coalesce(p_limit, 10), 1), 50)
    for update of j skip locked
  )
  update public.run_exports j
  set status = c.status, failure_code = c.failure_code, expires_at = c.expires_at,
    lease_token = null, lease_expires_at = null, ready_at = statement_timestamp() + interval '2 minutes'
  from candidates c where j.id = c.id
  returning j.id, j.workspace_id;
$$;

create function public.finish_run_export_cleanup(p_export_id uuid, p_workspace_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  job public.run_exports;
begin
  select * into job from public.run_exports
    where (id, workspace_id) = (p_export_id, p_workspace_id) for update;
  if not found or job.cleaned_at is not null then return true; end if;
  if job.status not in ('expired', 'failed') or exists(
    select 1 from storage.objects where bucket_id = 'workspace-run-exports'
      and name like p_workspace_id::text || '/' || p_export_id::text || '/%'
  ) then return false; end if;
  delete from internal.run_export_archive_deadlines where export_id = job.id;
  delete from internal.run_export_entries where export_id = job.id;
  delete from public.run_export_pages where export_id = job.id;
  delete from public.run_export_assets where export_id = job.id;
  update public.run_exports set cleaned_at = clock_timestamp() where id = job.id;
  return true;
end;
$$;

-- Once bytes are exported, source expiry or redaction also revokes that export.
-- The snapshot and this revocation take the same workspace lock, so concurrent
-- changes either appear in the roster or revoke the snapshot that missed them.
create function internal.revoke_run_exports_for_source()
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
        and i.record_kind in ('event', 'legacy_message') and i.availability in ('available', 'gap')
        and (i.record_kind <> 'legacy_message' or i.metadata->>'kind' <> 'run_failure')
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

create trigger revoke_exports_on_transcript_expiry after insert on public.agent_run_transcript_expirations
  for each row execute function internal.revoke_run_exports_for_source();
create trigger revoke_exports_on_evidence_withholding after insert on public.session_validation_asset_withholdings
  for each row execute function internal.revoke_run_exports_for_source();

create function internal.revoke_run_exports_for_retention_policy()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.transcript_days is not null and
      (tg_op = 'INSERT' or old.transcript_days is null or new.transcript_days < old.transcript_days))
    or (new.evidence_days is not null and
      (tg_op = 'INSERT' or old.evidence_days is null or new.evidence_days < old.evidence_days)) then
    update public.run_exports j set status = 'expired', failure_code = 'source_withheld',
      expires_at = clock_timestamp(), lease_token = null, lease_expires_at = null
    where j.workspace_id = new.workspace_id and j.status in ('running', 'completed');
  end if;
  return new;
end;
$$;

create trigger revoke_exports_on_stricter_retention after insert or update of transcript_days, evidence_days
  on public.workspace_run_retention for each row execute function internal.revoke_run_exports_for_retention_policy();

-- Content-addressed export writes can only settle while a matching workspace
-- and export admit them. This closes late uploads racing expiry or deletion.
create function internal.guard_run_export_storage_admission()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := split_part(new.name, '/', 1)::uuid;
  export_name text := split_part(new.name, '/', 2);
begin
  if tg_op = 'UPDATE' and old.bucket_id = 'workspace-run-exports' then
    if (new.name, new.bucket_id, new.version, new.metadata) is distinct from
      (old.name, old.bucket_id, old.version, old.metadata) then
      raise exception 'Run export objects are immutable.' using errcode = '23514';
    end if;
    return new;
  end if;

  perform internal.assert_workspace_accepts_work(owner_id);
  if export_name !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    or new.name !~ ('^' || owner_id::text || '/' || export_name || '/('
      || 'pages/[1-9][0-9]*-[a-f0-9]{64}[.]json'
      || '|assets/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-[a-f0-9]{64})$') then
    raise exception 'Run export object path is invalid.' using errcode = '23514';
  end if;
  perform 1 from public.run_exports j where (j.id, j.workspace_id) = (export_name::uuid, owner_id)
    and j.status = 'running' and j.lease_expires_at > clock_timestamp() and j.expires_at > clock_timestamp()
    and coalesce(internal.run_export_source_expiry(j) > clock_timestamp(), true)
    for share;
  if not found then
    raise exception 'Run export upload lease is inactive.' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger run_export_storage_insert before insert on storage.objects
  for each row when (new.bucket_id = 'workspace-run-exports')
  execute function internal.guard_run_export_storage_admission();
create trigger run_export_storage_update before update on storage.objects
  for each row when (old.bucket_id = 'workspace-run-exports' or new.bucket_id = 'workspace-run-exports')
  execute function internal.guard_run_export_storage_admission();

create policy run_export_objects_service_only on storage.objects as restrictive
  for all to anon, authenticated
  using (bucket_id <> 'workspace-run-exports') with check (bucket_id <> 'workspace-run-exports');

create or replace function public.finish_workspace_deletion(p_workspace_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare target public.workspaces%rowtype;
begin
  select * into target from public.workspaces where id = p_workspace_id for update;
  if not found then return true; end if;
  if target.deletion_requested_at is null then return false; end if;
  if exists(select 1 from public.workspace_resource_operations where workspace_id = p_workspace_id)
    or exists(select 1 from public.workspace_sandbox_connection_mutations where workspace_id = p_workspace_id
      and expires_at > now())
    or exists(select 1 from public.agent_jobs where workspace_id = p_workspace_id
      and status in ('queued', 'started', 'running'))
    or exists(select 1 from public.agent_runs where workspace_id = p_workspace_id
      and status in ('queued', 'started', 'running'))
    or exists(select 1 from public.session_source_deliveries where workspace_id = p_workspace_id
      and status = 'claimed' and lease_expires_at > now())
    or exists(select 1 from public.session_pr_operations where workspace_id = p_workspace_id
      and status = 'claimed' and lease_expires_at > clock_timestamp())
    or exists(select 1 from public.session_checkpoint_cleanup where workspace_id = p_workspace_id
      and status = 'claimed' and lease_expires_at > clock_timestamp())
    or exists(select 1 from storage.objects where bucket_id in (
      'workspace-avatars', 'session-attachments', 'session-source-checkpoints',
      'session-validation-evidence', 'workspace-run-exports'
    ) and split_part(name, '/', 1) = p_workspace_id::text) then
    return false;
  end if;
  delete from public.workspaces where id = p_workspace_id;
  return true;
end;
$$;

revoke all on function internal.is_run_export_manager(uuid, uuid),
  internal.snapshot_run_export(public.run_exports),
  internal.run_export_source_expiry(public.run_exports),
  internal.record_run_export_session_archive(),
  internal.guard_run_export_storage_admission(),
  internal.run_export_current_status(public.run_exports),
  internal.lock_run_export_lease(uuid, uuid),
  internal.run_export_has_object(text, integer),
  internal.revoke_run_exports_for_source(),
  internal.revoke_run_exports_for_retention_policy()
from public, anon, authenticated, service_role;

revoke all on function public.request_run_export(uuid, uuid, uuid),
  public.list_run_exports(uuid, uuid, integer),
  public.get_run_export_access(uuid, uuid, uuid, uuid),
  public.claim_run_export(),
  public.read_run_export_page(uuid, uuid, integer),
  public.commit_run_export_page(uuid, uuid, bigint, text, integer, jsonb),
  public.complete_run_export(uuid, uuid),
  public.release_run_export(uuid, uuid),
  public.list_run_export_cleanup(integer),
  public.finish_run_export_cleanup(uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function public.request_run_export(uuid, uuid, uuid),
  public.list_run_exports(uuid, uuid, integer),
  public.get_run_export_access(uuid, uuid, uuid, uuid),
  public.claim_run_export(),
  public.read_run_export_page(uuid, uuid, integer),
  public.commit_run_export_page(uuid, uuid, bigint, text, integer, jsonb),
  public.complete_run_export(uuid, uuid),
  public.release_run_export(uuid, uuid),
  public.list_run_export_cleanup(integer),
  public.finish_run_export_cleanup(uuid, uuid)
to service_role;
