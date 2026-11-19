-- A withholding preserves exact evidence identity while blocking delivery
-- immediately. Storage removes the bytes outside the database transaction.
create table public.session_browser_asset_withholdings (
  asset_id uuid primary key references public.session_browser_verification_assets(id) on delete cascade,
  state text not null check (state in ('expired', 'erased')),
  recorded_at timestamptz not null default clock_timestamp(),
  purged_at timestamptz,
  cleanup_claim_id uuid,
  cleanup_available_at timestamptz not null default clock_timestamp(),
  check (purged_at is null or cleanup_claim_id is null)
);
create index session_browser_asset_withholdings_pending_idx
  on public.session_browser_asset_withholdings(cleanup_available_at, asset_id) where purged_at is null;
create unique index session_browser_asset_withholdings_claim_idx
  on public.session_browser_asset_withholdings(cleanup_claim_id) where cleanup_claim_id is not null;
alter table public.session_browser_asset_withholdings enable row level security;
revoke all on public.session_browser_asset_withholdings from public, anon, authenticated, service_role;
grant select on public.session_browser_asset_withholdings to service_role;

-- Authenticate review through Wallie's byte-verifying proxy. A general
-- Storage SELECT policy would also allow users to mint signed bearer URLs.
drop policy session_browser_verification_storage_read on storage.objects;
create policy session_browser_verification_storage_proxy_only on storage.objects as restrictive
  for all to anon, authenticated
  using (bucket_id <> 'session-validation-evidence' or split_part(name, '/', 3) <> 'browser')
  with check (bucket_id <> 'session-validation-evidence' or split_part(name, '/', 3) <> 'browser');

create table public.session_retained_content_erasures (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  workspace_id uuid not null,
  factory_id uuid not null,
  archived_at timestamptz not null,
  erased_at timestamptz not null default clock_timestamp(),
  actor_member_id uuid not null,
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);
alter table public.session_retained_content_erasures enable row level security;
revoke all on public.session_retained_content_erasures from public, anon, authenticated, service_role;
create index session_retained_content_erasures_factory_idx
  on public.session_retained_content_erasures(workspace_id, factory_id);
create index factory_memories_source_session_idx on public.factory_memories(workspace_id, factory_id, source_session_id, id)
  where forgotten_at is null;

create function public.get_session_retained_content_erasure(
  target_workspace_id uuid, target_session_id uuid
)
returns public.session_retained_content_erasures
language sql stable security definer set search_path = '' as $$
  select erasure from public.session_retained_content_erasures erasure
  join public.sessions owner on
    (owner.workspace_id, owner.factory_id, owner.id) = (erasure.workspace_id, erasure.factory_id, erasure.session_id)
  where (erasure.workspace_id, erasure.session_id) = (target_workspace_id, target_session_id)
    and auth.uid() is not null and internal.can_access_session(owner.id)
$$;
revoke all on function public.get_session_retained_content_erasure(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_session_retained_content_erasure(uuid, uuid) to authenticated;

create function internal.guard_erased_session_restore()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- UPDATE already owns the session row. Never take the workspace lock here:
  -- erasure takes workspace first, then this same session row.
  if exists (select 1 from public.session_retained_content_erasures erasure
    where (erasure.workspace_id, erasure.factory_id, erasure.session_id) = (old.workspace_id, old.factory_id, old.id)) then
    raise exception 'A session with erased retained content cannot be restored.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_erased_session_restore() from public, anon, authenticated, service_role;
create trigger guard_erased_session_restore before update of archived_at on public.sessions
  for each row when (old.archived_at is distinct from new.archived_at)
  execute function internal.guard_erased_session_restore();

create function public.erase_session_retained_content(
  target_workspace_id uuid, target_factory_id uuid, target_session_id uuid,
  expected_archived_at timestamptz
)
returns public.session_retained_content_erasures
language plpgsql security definer set search_path = '' as $$
declare actor_id uuid;
declare owner_session public.sessions;
declare erased public.session_retained_content_erasures;
declare sourced_memory public.factory_memories;
begin
  -- Export snapshots, source retention, and browser upload admission all
  -- participate in this fence. No Storage mutation holds this transaction.
  perform 1 from public.workspaces workspace
    where workspace.id = target_workspace_id and workspace.deletion_requested_at is null
    for no key update;
  if not found then raise exception 'Session workspace is unavailable.' using errcode = 'P0002'; end if;
  actor_id := internal.assert_factory_manager(target_workspace_id, target_factory_id, auth.uid());
  begin
    -- Older command-evidence and checkpoint code may briefly own the
    -- session before acquiring workspace SHARE. Return a retryable conflict
    -- instead of waiting on that inverse order while owning the workspace.
    select * into owner_session from public.sessions owner
    where (owner.workspace_id, owner.factory_id, owner.id) =
      (target_workspace_id, target_factory_id, target_session_id)
    for no key update nowait;
  exception when lock_not_available then
    raise exception 'Session activity changed. Retry retained content erasure.' using errcode = 'PT409';
  end;
  if not found then raise exception 'Session is unavailable.' using errcode = 'P0002'; end if;
  if owner_session.archived_at is null or owner_session.archived_at is distinct from expected_archived_at then
    raise exception 'Archive the current session before erasing retained content.' using errcode = 'PT409';
  end if;

  select * into erased from public.session_retained_content_erasures erasure
  where (erasure.workspace_id, erasure.factory_id, erasure.session_id) =
    (target_workspace_id, target_factory_id, target_session_id);
  if found then return erased; end if;
  if exists(select 1 from public.agent_jobs job
    where (job.workspace_id, job.session_id) = (target_workspace_id, target_session_id)
      and job.status in ('queued', 'started', 'running'))
    or exists(select 1 from public.agent_runs run
    where (run.workspace_id, run.session_id) = (target_workspace_id, target_session_id)
      and run.status in ('queued', 'started', 'running')) then
    raise exception 'Wait for the archived session attempts to stop before erasing retained content.' using errcode = 'PT409';
  end if;

  insert into public.session_retained_content_erasures(session_id, workspace_id, factory_id, archived_at, actor_member_id)
    values (target_session_id, target_workspace_id, target_factory_id, owner_session.archived_at, actor_id)
    returning * into erased;

  -- Cancel affected exports, including legacy Markdown roster entries with
  -- no producer run, before creating expiry markers or removing the payload.
  update public.run_exports export_job
  set status = 'expired', failure_code = 'source_withheld', expires_at = clock_timestamp(),
    lease_token = null, lease_expires_at = null, ready_at = clock_timestamp()
  where export_job.workspace_id = target_workspace_id and export_job.status in ('running', 'completed')
    and exists (select 1 from internal.run_export_entries entry where entry.export_id = export_job.id
      and ((entry.record_kind = 'stage_markdown' and entry.metadata->>'session_id' = target_session_id::text)
        or exists (select 1 from public.agent_runs run
          where (run.id, run.workspace_id, run.session_id) = (entry.run_id, target_workspace_id, target_session_id))));

  insert into public.agent_run_transcript_expirations(run_id, workspace_id)
    select run.id, run.workspace_id from public.agent_runs run
    where (run.workspace_id, run.session_id) = (target_workspace_id, target_session_id)
    on conflict (run_id) do nothing;
  insert into public.session_validation_asset_withholdings(asset_id, state)
    select asset.id, 'redacted' from public.session_validation_assets asset
    where (asset.workspace_id, asset.session_id) = (target_workspace_id, target_session_id)
    on conflict (asset_id) do nothing;
  insert into public.session_browser_asset_withholdings(asset_id, state)
    select asset.id, 'erased' from public.session_browser_verification_assets asset
    where (asset.workspace_id, asset.session_id) = (target_workspace_id, target_session_id)
    on conflict (asset_id) do update set state = 'erased'
    where session_browser_asset_withholdings.state <> 'erased';

  delete from internal.factory_run_memory_proposals proposal
  where (proposal.workspace_id, proposal.factory_id, proposal.session_id) =
    (target_workspace_id, target_factory_id, target_session_id);
  for sourced_memory in
    select family.* from public.factory_memories family
    where (family.workspace_id, family.factory_id, family.source_session_id) =
      (target_workspace_id, target_factory_id, target_session_id)
      and family.forgotten_at is null
    order by family.id for update
  loop
    perform public.forget_factory_memory(target_workspace_id, target_factory_id, sourced_memory.id,
      sourced_memory.current_revision_id, sourced_memory.pending_revision_id);
  end loop;

  return erased;
end;
$$;
revoke all on function public.erase_session_retained_content(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.erase_session_retained_content(uuid, uuid, uuid, timestamptz) to authenticated;

create function internal.browser_media_run_erased(target_workspace_id uuid, target_run_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.agent_runs run
    join public.session_retained_content_erasures erasure
      on (erasure.workspace_id, erasure.session_id) = (run.workspace_id, run.session_id)
    where (run.workspace_id, run.id) = (target_workspace_id, target_run_id)
  );
$$;
revoke all on function internal.browser_media_run_erased(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function internal.guard_browser_media_reservation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if split_part(new.resource_id, '/', 1) is distinct from new.workspace_id::text
    or new.resource_id !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/browser/[0-9a-f-]{36}[.](png|webm)$' then
    raise exception 'Invalid browser media reservation path.' using errcode = '23514';
  end if;
  perform internal.assert_workspace_accepts_work(new.workspace_id);
  if internal.browser_media_run_erased(new.workspace_id, split_part(new.resource_id, '/', 2)::uuid) then
    raise exception 'Browser media content has been erased.' using errcode = 'PT409';
  end if;
  if exists(select 1 from public.session_browser_verification_assets asset where asset.storage_path = new.resource_id) then
    raise exception 'Browser media path is already retained.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function internal.guard_browser_media_storage() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  upload public.workspace_resource_operations;
  owner_id uuid;
  expected_mime text;
  mime text := new.metadata->>'mimetype';
  size_bytes text := new.metadata->>'size';
begin
  if tg_op = 'UPDATE' and old.bucket_id = 'session-validation-evidence'
    and split_part(old.name, '/', 3) = 'browser'
    and (new.bucket_id, new.name) is distinct from (old.bucket_id, old.name) then
    raise exception 'Browser media paths cannot be moved.' using errcode = '23514';
  end if;
  if new.bucket_id <> 'session-validation-evidence' then return new; end if;
  if split_part(new.name, '/', 3) <> 'browser' and mime is distinct from 'image/png'
    and mime is distinct from 'video/webm' then
    -- Storage's broader shared bucket cap must not admit larger text objects.
    if size_bytes is not null and (not coalesce(size_bytes ~ '^[0-9]{1,7}$', false)
      or size_bytes::numeric > 1048576) then
      raise exception 'Command evidence exceeds its size limit.' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/browser/[0-9a-f-]{36}[.](png|webm)$' then
    raise exception 'Invalid private browser media object.' using errcode = '23514';
  end if;
  expected_mime := case when new.name like '%.png' then 'image/png' else 'video/webm' end;
  if mime is not null and mime <> expected_mime then
    raise exception 'Invalid private browser media object.' using errcode = '23514';
  end if;
  -- MIME-only provisional rows cannot transfer or become readable. Finalized
  -- writes must have exact bounded metadata for the reserved file extension.
  if size_bytes is not null or (tg_op = 'UPDATE' and old.metadata->>'size' is not null) then
    if mime is distinct from expected_mime or not coalesce(size_bytes ~ '^[1-9][0-9]{0,6}$', false) then
      raise exception 'Invalid private browser media object.' using errcode = '23514';
    end if;
    if size_bytes::integer > (case when expected_mime = 'image/png' then 1048576 else 8388608 end) then
      raise exception 'Private browser media exceeds its size limit.' using errcode = '23514';
    end if;
  end if;
  owner_id := split_part(new.name, '/', 1)::uuid;
  perform internal.assert_workspace_accepts_work(owner_id);
  if internal.browser_media_run_erased(owner_id, split_part(new.name, '/', 2)::uuid) then
    raise exception 'Browser media content has been erased.' using errcode = 'PT409';
  end if;
  select op.* into upload from public.workspace_resource_operations op
  where (op.workspace_id, op.kind, op.storage_bucket, op.resource_id) =
    (owner_id, 'upload', new.bucket_id, new.name)
  for update;
  if not found or upload.settled_at is not null or upload.recovery_after <= clock_timestamp() then
    raise exception 'Browser media upload reservation is not active.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function internal.lock_browser_verification_plan(
  p_run_id uuid, p_attempt_count integer, p_commit_sha text, p_validation_tree_sha text
) returns public.session_validation_plans language plpgsql set search_path = '' as $$
declare
  pinned public.session_validation_plans;
begin
  perform 1 from internal.git_continuity_release_control where singleton for share;
  select * into pinned from public.session_validation_plans plan where plan.run_id = p_run_id;
  if not found or pinned.plan->'version' is distinct from '2'::jsonb
    or pinned.attempt_count is distinct from p_attempt_count
    or pinned.commit_sha is distinct from p_commit_sha
    or pinned.validation_tree_sha is distinct from p_validation_tree_sha then
    raise exception 'Browser verification does not match the frozen run plan.' using errcode = '23514';
  end if;
  perform internal.assert_workspace_accepts_work(pinned.workspace_id);
  perform 1 from public.sessions session
  where (session.id, session.workspace_id) = (pinned.session_id, pinned.workspace_id) for no key update;
  if not found then raise exception 'Browser verification is unavailable.' using errcode = '42501'; end if;
  if internal.browser_media_run_erased(pinned.workspace_id, pinned.run_id) or exists (
    select 1 from public.session_browser_verification_assets asset
    join public.session_browser_asset_withholdings withholding on withholding.asset_id = asset.id
    where (asset.workspace_id, asset.session_id, asset.run_id) = (pinned.workspace_id, pinned.session_id, pinned.run_id)
  ) then
    raise exception 'Browser media is unavailable for this run.' using errcode = 'PT409';
  end if;
  return pinned;
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
    where (settings.transcript_days is not null or settings.evidence_days is not null or settings.context_days is not null)
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

      insert into public.session_browser_asset_withholdings(asset_id, state)
      select asset.id, 'expired' from public.agent_runs run
      join public.session_validation_plans plan
        on (plan.run_id, plan.workspace_id, plan.session_id, plan.job_id, plan.attempt_count) =
          (run.id, run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count)
      join public.session_browser_verification_receipts receipt
        on (receipt.run_id, receipt.workspace_id, receipt.session_id) = (plan.run_id, plan.workspace_id, plan.session_id)
      join public.session_browser_verification_assets asset
        on (asset.run_id, asset.workspace_id, asset.session_id) = (receipt.run_id, receipt.workspace_id, receipt.session_id)
      join public.sessions owner on (owner.id, owner.workspace_id) = (run.session_id, run.workspace_id)
      where run.workspace_id = target and run.status in ('success', 'error', 'canceled')
        and coalesce(run.finished_at, run.updated_at) <= evidence_cutoff
        and receipt.created_at <= evidence_cutoff
        and (not asset.required or owner.archived_at is not null)
        and not exists(select 1 from public.session_browser_asset_withholdings x where x.asset_id = asset.id)
      order by coalesce(run.finished_at, run.updated_at), run.id, asset.id
      limit item_limit for share of owner skip locked
      on conflict (asset_id) do nothing;
      get diagnostics changed = row_count;
      evidence_expired := evidence_expired + changed;
    end if;

    if policy.context_days is not null then
      perform internal.purge_factory_retained_context(
        target, sweep_time - internal.run_retention_duration(policy.context_days), item_limit
      );
    end if;

    update public.workspace_run_retention set last_swept_at = sweep_time where workspace_id = target;
  end loop;

  return next;
end;
$$;

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
      and not exists (select 1 from public.session_retained_content_erasures erasure
        where (erasure.workspace_id, erasure.session_id) = (r.workspace_id, r.session_id))
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
      and not exists (select 1 from public.session_retained_content_erasures erasure
        where (erasure.workspace_id, erasure.session_id) = (a.workspace_id, a.session_id))
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

-- Both evidence families use one bounded claim batch and the same Storage
-- bucket. Separate immutable foreign keys keep paths and receipts typed.
create or replace function public.claim_run_evidence_purges(p_limit integer default 50)
returns table (asset_id uuid, storage_path text, claim_id uuid)
language sql security definer set search_path = '' as $$
  with command_due as materialized (
    select marker.asset_id, asset.storage_path, marker.cleanup_available_at, false as browser
    from public.session_validation_asset_withholdings marker
    join public.session_validation_assets asset on asset.id = marker.asset_id
    join public.workspaces workspace on workspace.id = asset.workspace_id
    where marker.purged_at is null and marker.cleanup_available_at <= statement_timestamp()
      and workspace.deletion_requested_at is null
    order by marker.cleanup_available_at, marker.asset_id
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    for update of marker skip locked
  ), browser_due as materialized (
    select marker.asset_id, asset.storage_path, marker.cleanup_available_at, true as browser
    from public.session_browser_asset_withholdings marker
    join public.session_browser_verification_assets asset on asset.id = marker.asset_id
    join public.workspaces workspace on workspace.id = asset.workspace_id
    where marker.purged_at is null and marker.cleanup_available_at <= statement_timestamp()
      and workspace.deletion_requested_at is null
    order by marker.cleanup_available_at, marker.asset_id
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    for update of marker skip locked
  ), due as materialized (
    select candidate.*, gen_random_uuid() as claim_id from (
      select * from command_due union all select * from browser_due
    ) candidate
    order by candidate.cleanup_available_at, candidate.asset_id, candidate.browser
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
  ), command_claim as (
    update public.session_validation_asset_withholdings marker
    set cleanup_claim_id = due.claim_id, cleanup_available_at = clock_timestamp() + interval '2 min'
    from due where not due.browser and marker.asset_id = due.asset_id
    returning marker.asset_id, due.storage_path, due.claim_id
  ), browser_claim as (
    update public.session_browser_asset_withholdings marker
    set cleanup_claim_id = due.claim_id, cleanup_available_at = clock_timestamp() + interval '2 min'
    from due where due.browser and marker.asset_id = due.asset_id
    returning marker.asset_id, due.storage_path, due.claim_id
  )
  select * from command_claim union all select * from browser_claim;
$$;

create or replace function public.complete_run_evidence_purges(p_claim_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare command_purged integer;
declare browser_purged integer;
begin
  update public.session_validation_asset_withholdings marker
  set purged_at = clock_timestamp(), cleanup_claim_id = null
  where marker.cleanup_claim_id = any(p_claim_ids) and marker.purged_at is null;
  get diagnostics command_purged = row_count;

  update public.session_browser_asset_withholdings marker
  set purged_at = clock_timestamp(), cleanup_claim_id = null
  from public.session_browser_verification_assets asset
  where marker.asset_id = asset.id
    and marker.cleanup_claim_id = any(p_claim_ids) and marker.purged_at is null
    and marker.cleanup_available_at > clock_timestamp()
    and not exists (select 1 from storage.objects object
      where (object.bucket_id, object.name) = ('session-validation-evidence', asset.storage_path));
  get diagnostics browser_purged = row_count;
  return command_purged + browser_purged;
end;
$$;
