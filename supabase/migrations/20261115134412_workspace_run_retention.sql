-- Retention is opt-in at the workspace boundary. Retain run identity, usage,
-- accepted Markdown, source lineage and immutable validation receipts.
create table public.workspace_run_retention (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  transcript_days integer check (transcript_days between 1 and 3650),
  evidence_days integer check (evidence_days between 1 and 3650),
  updated_at timestamptz not null default clock_timestamp(),
  last_swept_at timestamptz
);
create index workspace_run_retention_due_idx
  on public.workspace_run_retention(last_swept_at asc nulls first, workspace_id)
  where transcript_days is not null or evidence_days is not null;
alter table public.workspace_run_retention enable row level security;
revoke all on public.workspace_run_retention from public, anon, authenticated, service_role;
grant select on public.workspace_run_retention to authenticated, service_role;
grant insert, update on public.workspace_run_retention to service_role;
create policy workspace_run_retention_read on public.workspace_run_retention
  for select to authenticated using (
    workspace_id in (select internal.current_user_workspace_ids())
    and exists (select 1 from public.workspaces w
      where w.id = workspace_run_retention.workspace_id and w.deletion_requested_at is null)
  );

create function public.save_workspace_run_retention(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_transcript_days integer default null,
  p_evidence_days integer default null
) returns public.workspace_run_retention language plpgsql security invoker set search_path = '' as $$
declare
  saved public.workspace_run_retention;
begin
  perform 1 from public.workspaces w
    where w.id = p_workspace_id and w.deletion_requested_at is null for no key update;
  if not found then raise exception 'Workspace is unavailable.' using errcode = 'P0002'; end if;
  perform 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = p_actor_user_id and m.kind = 'human'
      and m.is_active and m.role in ('owner', 'admin') for share;
  if not found then raise exception 'Workspace administrator access is required.' using errcode = '42501'; end if;

  insert into public.workspace_run_retention as current (workspace_id, transcript_days, evidence_days)
  values (p_workspace_id, p_transcript_days, p_evidence_days)
  on conflict (workspace_id) do update
  set transcript_days = excluded.transcript_days, evidence_days = excluded.evidence_days,
    updated_at = clock_timestamp(), last_swept_at = null
  where (current.transcript_days, current.evidence_days)
    is distinct from (excluded.transcript_days, excluded.evidence_days)
  returning * into saved;

  if saved.workspace_id is null then
    select * into strict saved from public.workspace_run_retention where workspace_id = p_workspace_id;
  end if;
  return saved;
end;
$$;
revoke all on function public.save_workspace_run_retention(uuid,uuid,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.save_workspace_run_retention(uuid,uuid,integer,integer) to service_role;

create table public.agent_run_transcript_expirations (
  run_id uuid primary key references public.agent_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  expired_at timestamptz not null default clock_timestamp(),
  purged_at timestamptz
);
create index agent_run_transcript_expirations_workspace_idx
  on public.agent_run_transcript_expirations(workspace_id);
create index agent_run_transcript_expirations_pending_idx
  on public.agent_run_transcript_expirations(expired_at, run_id) where purged_at is null;
alter table public.agent_run_transcript_expirations enable row level security;
revoke all on public.agent_run_transcript_expirations from public, anon, authenticated, service_role;
grant select on public.agent_run_transcript_expirations to authenticated, service_role;
grant insert, update on public.agent_run_transcript_expirations to service_role;
create policy agent_run_transcript_expirations_read on public.agent_run_transcript_expirations
  for select to authenticated using (
    workspace_id in (select internal.current_user_workspace_ids())
    and exists (select 1 from public.workspaces w
      where w.id = agent_run_transcript_expirations.workspace_id and w.deletion_requested_at is null)
  );

-- The marker fences both API reads and direct/realtime reads immediately.
alter policy agent_run_events_select_membership on public.agent_run_events using (
  workspace_id in (select internal.current_user_workspace_ids())
  and exists (select 1 from public.workspaces w
    where w.id = agent_run_events.workspace_id and w.deletion_requested_at is null)
  and not exists (select 1 from public.agent_run_transcript_expirations expiry
    where expiry.run_id = agent_run_events.agent_run_id and expiry.workspace_id = agent_run_events.workspace_id)
);
alter policy agent_run_messages_select_membership on public.agent_run_messages using (
  workspace_id in (select internal.current_user_workspace_ids())
  and exists (select 1 from public.workspaces w
    where w.id = agent_run_messages.workspace_id and w.deletion_requested_at is null)
  and (kind = 'run_failure' or not exists (select 1 from public.agent_run_transcript_expirations expiry
    where expiry.run_id = agent_run_messages.agent_run_id and expiry.workspace_id = agent_run_messages.workspace_id))
);

-- A delayed cancellation or diagnostic write may arrive after the terminal
-- transition. A run-row lock orders it with expiry before checking the marker.
create function internal.skip_expired_run_message() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.agent_runs r
    where r.id = new.agent_run_id and r.workspace_id = new.workspace_id for key share;
  if exists (select 1 from public.agent_run_transcript_expirations expiry
    where expiry.run_id = new.agent_run_id and expiry.workspace_id = new.workspace_id) then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function internal.skip_expired_run_message() from public, anon, authenticated, service_role;
create trigger skip_expired_run_message before insert on public.agent_run_messages
  for each row when (new.kind <> 'run_failure') execute function internal.skip_expired_run_message();

create index agent_runs_retention_age_idx on public.agent_runs(
  workspace_id, (coalesce(finished_at, updated_at)), id
) where status in ('success', 'error', 'canceled');

alter table public.session_validation_asset_withholdings
  add column purged_at timestamptz,
  add column cleanup_claim_id uuid,
  add column cleanup_available_at timestamptz not null default clock_timestamp();
create index session_validation_asset_withholdings_pending_idx
  on public.session_validation_asset_withholdings(cleanup_available_at, asset_id)
  where purged_at is null;
grant update (purged_at, cleanup_claim_id, cleanup_available_at)
  on public.session_validation_asset_withholdings to service_role;
grant delete on public.agent_run_events to service_role;

-- Retention days are elapsed 24-hour periods, including through DST changes.
create function internal.run_retention_duration(p_days integer)
returns interval language sql immutable strict security invoker set search_path = '' as $$
  select p_days * interval '24 hours';
$$;
revoke all on function internal.run_retention_duration(integer) from public, anon, authenticated, service_role;
grant execute on function internal.run_retention_duration(integer) to service_role;

create function public.mark_expired_workspace_run_content(
  p_workspace_limit integer default 4,
  p_item_limit integer default 25
) returns table (transcripts_expired integer, evidence_expired integer)
language plpgsql security invoker set search_path = '' as $$
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
        and (
          exists (select 1 from public.agent_run_events e where e.agent_run_id = r.id and e.workspace_id = target)
          or exists (select 1 from public.agent_run_messages m
            where m.agent_run_id = r.id and m.workspace_id = target and m.kind <> 'run_failure')
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
revoke all on function public.mark_expired_workspace_run_content(integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.mark_expired_workspace_run_content(integer,integer) to service_role;

create function public.purge_expired_run_transcripts(
  p_run_limit integer default 8,
  p_entry_limit integer default 250
) returns integer language plpgsql security invoker set search_path = '' as $$
declare
  expiry public.agent_run_transcript_expirations;
  max_entries integer := least(greatest(coalesce(p_entry_limit, 250), 1), 1000);
  events_deleted integer;
  messages_deleted integer;
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

    delete from public.agent_run_messages where id in (
      select m.id from public.agent_run_messages m
      where m.agent_run_id = expiry.run_id and m.workspace_id = expiry.workspace_id and m.kind <> 'run_failure'
      order by m.created_at, m.id limit max_entries
    );
    get diagnostics messages_deleted = row_count;

    if events_deleted < max_entries and messages_deleted < max_entries then
      update public.agent_run_transcript_expirations
        set purged_at = clock_timestamp() where run_id = expiry.run_id;
      completed := completed + 1;
    end if;
  end loop;
  return completed;
end;
$$;
revoke all on function public.purge_expired_run_transcripts(integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.purge_expired_run_transcripts(integer,integer) to service_role;

create function public.claim_run_evidence_purges(p_limit integer default 50)
returns table (asset_id uuid, storage_path text, claim_id uuid)
language sql security invoker set search_path = '' as $$
  with due as materialized (
    select x.asset_id, a.storage_path, gen_random_uuid() as claim_id
    from public.session_validation_asset_withholdings x
    join public.session_validation_assets a on a.id = x.asset_id
    join public.workspaces w on w.id = a.workspace_id
    where x.purged_at is null and x.cleanup_available_at <= statement_timestamp() and w.deletion_requested_at is null
    order by x.cleanup_available_at, x.asset_id
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    for update of x skip locked
  )
  update public.session_validation_asset_withholdings x
  set cleanup_claim_id = due.claim_id, cleanup_available_at = clock_timestamp() + interval '2 min'
  from due where x.asset_id = due.asset_id
  returning x.asset_id, due.storage_path, due.claim_id;
$$;
revoke all on function public.claim_run_evidence_purges(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_run_evidence_purges(integer) to service_role;

create function public.complete_run_evidence_purges(p_claim_ids uuid[])
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  purged integer;
begin
  update public.session_validation_asset_withholdings x
  set purged_at = clock_timestamp(), cleanup_claim_id = null
  where x.cleanup_claim_id = any(p_claim_ids) and x.purged_at is null;
  get diagnostics purged = row_count;
  return purged;
end;
$$;
revoke all on function public.complete_run_evidence_purges(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.complete_run_evidence_purges(uuid[]) to service_role;

create unique index session_validation_asset_withholdings_claim_idx
  on public.session_validation_asset_withholdings(cleanup_claim_id) where cleanup_claim_id is not null;

-- Expose expiry on the existing bounded metadata read.
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
  has_legacy_messages boolean,
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
    message_presence.present is true,
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
    select true as present from public.agent_run_messages m
    where m.agent_run_id = p.id and m.workspace_id = p_workspace_id
    limit 1
  ) message_presence on true
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
