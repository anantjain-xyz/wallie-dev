update storage.buckets set public = false, file_size_limit = 1048576,
  allowed_mime_types = array['text/plain','application/json','image/png']
where id = 'session-validation-evidence';

-- Visual bytes belong to the separate browser receipt, never to an agent's
-- command report. The existing command asset table stays text/JSON only.
alter table public.session_browser_verification_receipts
  add unique (run_id, workspace_id, session_id);
create table public.session_browser_verification_assets (
  id uuid primary key,
  run_id uuid not null,
  workspace_id uuid not null,
  session_id uuid not null,
  evidence_key text not null check(evidence_key ~ '^browser:screenshot:[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'),
  browser_session_id uuid not null unique,
  approval_scope_id text not null,
  required boolean not null,
  storage_path text not null unique,
  sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  content_type text not null check(content_type = 'image/png'),
  size_bytes integer not null check(size_bytes between 1 and 1048576),
  foreign key (run_id, workspace_id, session_id)
    references public.session_browser_verification_receipts(run_id, workspace_id, session_id) on delete cascade,
  unique (run_id, evidence_key),
  check(storage_path = workspace_id::text || '/' || run_id::text || '/browser/' || id::text || '.png')
);
create index session_browser_verification_assets_session_idx
  on public.session_browser_verification_assets(session_id);
alter table public.session_browser_verification_assets enable row level security;
revoke all on public.session_browser_verification_assets from public, anon, authenticated, service_role;
grant select on public.session_browser_verification_assets to authenticated, service_role;
create policy session_browser_verification_assets_read
  on public.session_browser_verification_assets for select to authenticated
  using (internal.can_access_session(session_id));
create trigger browser_verification_assets_immutable before update or delete
  on public.session_browser_verification_assets for each row
  execute function internal.guard_validation_evidence_history();

create policy session_browser_verification_storage_read on storage.objects for select to authenticated using (
  bucket_id = 'session-validation-evidence'
  and exists (
    select 1 from public.session_browser_verification_assets asset
    join public.session_validation_plans plan
      on (plan.run_id, plan.workspace_id, plan.session_id) = (asset.run_id, asset.workspace_id, asset.session_id)
    join public.agent_runs run
      on (run.id, run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count) =
         (plan.run_id, plan.workspace_id, plan.session_id, plan.job_id, plan.attempt_count)
    where asset.storage_path = storage.objects.name and internal.can_access_session(asset.session_id)
  )
);

create unique index workspace_resource_operations_browser_screenshot_path_idx
  on public.workspace_resource_operations(resource_id)
  where kind = 'upload' and storage_bucket = 'session-validation-evidence'
    and split_part(resource_id, '/', 3) = 'browser';

create function internal.guard_browser_screenshot_reservation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if split_part(new.resource_id, '/', 1) is distinct from new.workspace_id::text
    or new.resource_id !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/browser/[0-9a-f-]{36}[.]png$' then
    raise exception 'Invalid browser screenshot reservation path.' using errcode = '23514';
  end if;
  if exists(select 1 from public.session_browser_verification_assets asset where asset.storage_path = new.resource_id) then
    raise exception 'Browser screenshot path is already retained.' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger browser_screenshot_reservation_guard
  after insert or update of workspace_id, kind, storage_bucket, resource_id on public.workspace_resource_operations
  for each row when (new.kind = 'upload' and new.storage_bucket = 'session-validation-evidence'
    and split_part(new.resource_id, '/', 3) = 'browser')
  execute function internal.guard_browser_screenshot_reservation();

create function internal.guard_browser_screenshot_storage() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  upload public.workspace_resource_operations;
  owner_id uuid;
begin
  if tg_op = 'UPDATE' and old.bucket_id = 'session-validation-evidence'
    and split_part(old.name, '/', 3) = 'browser'
    and (new.bucket_id, new.name) is distinct from (old.bucket_id, old.name) then
    raise exception 'Browser screenshot paths cannot be moved.' using errcode = '23514';
  end if;
  if new.bucket_id <> 'session-validation-evidence' or
    (split_part(new.name, '/', 3) <> 'browser' and new.metadata->>'mimetype' is distinct from 'image/png') then
    return new;
  end if;
  if new.name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/browser/[0-9a-f-]{36}[.]png$' then
    raise exception 'Invalid private browser screenshot object.' using errcode = '23514';
  end if;
  -- Storage first inserts a placeholder, then finalizes versioned bytes and
  -- metadata. The exact active reservation fences both writes. Publication
  -- still requires both final metadata fields to match the captured manifest.
  if new.metadata->>'mimetype' is not null and new.metadata->>'mimetype' <> 'image/png' then
    raise exception 'Invalid private browser screenshot object.' using errcode = '23514';
  end if;
  if new.metadata->>'size' is not null or (tg_op = 'UPDATE' and old.metadata->>'size' is not null) then
    if new.metadata->>'mimetype' is distinct from 'image/png'
      or not coalesce(new.metadata->>'size' ~ '^[1-9][0-9]{0,6}$', false) then
      raise exception 'Invalid private browser screenshot object.' using errcode = '23514';
    end if;
    if (new.metadata->>'size')::integer > 1048576 then
      raise exception 'Private browser screenshot exceeds the size limit.' using errcode = '23514';
    end if;
  end if;
  owner_id := split_part(new.name, '/', 1)::uuid;
  perform internal.assert_workspace_accepts_work(owner_id);
  select op.* into upload from public.workspace_resource_operations op
  where (op.workspace_id, op.kind, op.storage_bucket, op.resource_id) =
    (owner_id, 'upload', new.bucket_id, new.name)
  for update;
  if not found or upload.settled_at is not null or upload.recovery_after <= clock_timestamp() then
    raise exception 'Browser screenshot upload reservation is not active.' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger browser_screenshot_storage_guard before insert or update on storage.objects
  for each row execute function internal.guard_browser_screenshot_storage();

create function internal.lock_browser_verification_plan(
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
  return pinned;
end;
$$;

create function internal.require_current_browser_verification(
  pinned public.session_validation_plans, p_needs_approval boolean, p_approval_scope_id text
) returns void language plpgsql set search_path = '' as $$
declare
  owner public.sessions;
  job public.agent_jobs;
  run public.agent_runs;
  admission public.session_factory_admission_inputs;
  definition jsonb;
begin
  select * into strict owner from public.sessions session
  where (session.id, session.workspace_id) = (pinned.session_id, pinned.workspace_id);
  if p_needs_approval then
    if not owner.execute_pinned_definition or not coalesce(p_approval_scope_id ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_.-]{1,80}$', false) then
      raise exception 'The exact browser screenshot tool operation is not approved.' using errcode = '42501';
    end if;
    definition := internal.pinned_session_execution_definition(owner);
    if jsonb_typeof(definition->'toolIds') is distinct from 'array'
      or not ((definition->'toolIds') ? p_approval_scope_id) then
      raise exception 'The exact browser screenshot tool operation is not approved.' using errcode = '42501';
    end if;
    select * into admission from public.session_factory_admission_inputs input
    where (input.session_id, input.workspace_id, input.factory_id, input.definition_revision_id) =
      (owner.id, owner.workspace_id, owner.factory_id, owner.factory_definition_revision_id);
    if not found or admission.execution_grant_id is null or admission.execution_grant_version is null then
      raise exception 'The browser screenshot execution grant is unavailable.' using errcode = '42501';
    end if;
    -- As with credential release, recheck the live grant, exact tool revision
    -- and invoker before taking the job and run locks.
    perform internal.recheck_session_execution_grant(owner);
  end if;

  select * into job from public.agent_jobs where id = pinned.job_id for update;
  select * into run from public.agent_runs where id = pinned.run_id for update;
  if owner.archived_at is not null or owner.phase_status is distinct from 'in_progress'
    or job.workspace_id is distinct from owner.workspace_id or job.session_id is distinct from owner.id
    or job.stage_id is distinct from owner.current_stage_id or job.status not in ('started', 'running')
    or run.workspace_id is distinct from owner.workspace_id or run.session_id is distinct from owner.id
    or run.status is distinct from 'running' or run.stage_id is distinct from job.stage_id
    or run.agent_job_id is distinct from job.id
    or job.attempt_count is distinct from pinned.attempt_count
    or run.attempt_count is distinct from pinned.attempt_count
    or exists(select 1 from public.session_source_deliveries delivery where delivery.run_id = pinned.run_id) then
    raise exception 'Browser verification is no longer current.' using errcode = 'PT409';
  end if;
  if p_needs_approval and not exists (
    select 1 from internal.git_continuity_release_control control
    join public.session_git_continuity_enrollments enrollment
      on (enrollment.session_id, enrollment.workspace_id) = (owner.id, owner.workspace_id)
    where control.singleton and control.enabled and control.revision = job.git_continuity_release_revision
  ) then
    raise exception 'Git continuity admission is paused or requires a fresh session.' using errcode = 'P499P';
  end if;
end;
$$;

create function public.authorize_session_browser_screenshot(
  p_run_id uuid, p_attempt_count integer, p_commit_sha text, p_validation_tree_sha text,
  p_approval_scope_id text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  pinned public.session_validation_plans;
begin
  perform internal.assert_checkpoint_publication_service();
  pinned := internal.lock_browser_verification_plan(p_run_id, p_attempt_count, p_commit_sha, p_validation_tree_sha);
  if exists(select 1 from public.session_browser_verification_receipts receipt where receipt.run_id = pinned.run_id)
    or not exists (
      select 1 from jsonb_array_elements(pinned.plan->'browser') check_spec
      cross join lateral jsonb_array_elements(check_spec->'evidence') evidence
      where evidence->>'kind' = 'screenshot'
    ) then return false; end if;
  begin
    perform internal.require_current_browser_verification(pinned, true, p_approval_scope_id);
  exception when insufficient_privilege then
    return false;
  end;
  return true;
end;
$$;

create function internal.record_session_browser_screenshot_verification(
  p_run_id uuid, p_attempt_count integer, p_commit_sha text, p_validation_tree_sha text,
  p_records jsonb, p_transfers jsonb, p_approval_scope_id text
) returns public.session_browser_verification_receipts language plpgsql set search_path = '' as $$
declare
  pinned public.session_validation_plans;
  prior public.session_browser_verification_receipts;
  result public.session_browser_verification_receipts;
  receipt jsonb;
  planned jsonb;
  manifest jsonb;
  transfer jsonb;
  evidence_id text;
  identities text[] := '{}';
  browser_ids uuid[] := '{}';
  asset_ids uuid[] := '{}';
  transfer_asset_ids uuid[] := '{}';
  operation_ids uuid[] := '{}';
  asset_id uuid;
  operation_id uuid;
  path text;
  upload public.workspace_resource_operations;
  expected_count integer;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  perform internal.assert_checkpoint_publication_service();
  pinned := internal.lock_browser_verification_plan(p_run_id, p_attempt_count, p_commit_sha, p_validation_tree_sha);
  if jsonb_typeof(p_records) is distinct from 'array' or octet_length(p_records::text) > 16384
    or jsonb_typeof(p_transfers) is distinct from 'array' or octet_length(p_transfers::text) > 4096 then
    raise exception 'Invalid browser verification receipts.' using errcode = '23514';
  end if;
  select sum(jsonb_array_length(value->'evidence')) into expected_count
    from jsonb_array_elements(pinned.plan->'browser');
  if jsonb_array_length(p_records) <> expected_count or jsonb_array_length(p_transfers) > 5 then
    raise exception 'Browser verification receipts must match every planned capture.' using errcode = '23514';
  end if;

  for receipt in select * from jsonb_array_elements(p_records) loop
    if jsonb_typeof(receipt) is distinct from 'object' then
      raise exception 'Invalid browser verification receipt.' using errcode = '23514';
    end if;
    select value into planned from jsonb_array_elements(pinned.plan->'browser')
      where value->'key' = receipt->'key';
    evidence_id := (receipt->>'key') || ':' || (receipt->>'kind');
    if planned is null or evidence_id is null or evidence_id = any(identities)
      or receipt->'path' is distinct from planned->'path'
      or receipt->'policy' is distinct from '"isolated-fixture-v1"'::jsonb
      or not exists(select 1 from jsonb_array_elements(planned->'evidence') item where item->'kind' = receipt->'kind') then
      raise exception 'Browser verification receipt does not match its planned capture.' using errcode = '23514';
    end if;
    identities := array_append(identities, evidence_id);
    if receipt->>'status' = 'captured' then
      manifest := receipt->'manifest';
      if receipt->>'kind' is distinct from 'screenshot'
        or (select count(*) from jsonb_object_keys(receipt)) <> 7
        or not receipt ?& array['key','kind','path','policy','status','browserSessionId','manifest']
        or jsonb_typeof(receipt->'browserSessionId') is distinct from 'string'
        or receipt->>'browserSessionId' !~ uuid_pattern
        or jsonb_typeof(manifest) is distinct from 'object' then
        raise exception 'Invalid trusted screenshot receipt.' using errcode = '23514';
      end if;
      if (select count(*) from jsonb_object_keys(manifest)) <> 4
        or jsonb_typeof(manifest->'assetId') is distinct from 'string' or manifest->>'assetId' !~ uuid_pattern
        or jsonb_typeof(manifest->'sha256') is distinct from 'string' or manifest->>'sha256' !~ '^[0-9a-f]{64}$'
        or manifest->'contentType' is distinct from '"image/png"'::jsonb
        or jsonb_typeof(manifest->'sizeBytes') is distinct from 'number' then
        raise exception 'Invalid private browser screenshot manifest.' using errcode = '23514';
      end if;
      if (manifest->>'sizeBytes')::numeric not between 1 and 1048576
        or (manifest->>'sizeBytes')::numeric <> trunc((manifest->>'sizeBytes')::numeric)
        or (manifest->>'assetId')::uuid = any(asset_ids)
        or (receipt->>'browserSessionId')::uuid = any(browser_ids) then
        raise exception 'Invalid private browser screenshot manifest.' using errcode = '23514';
      end if;
      asset_ids := array_append(asset_ids, (manifest->>'assetId')::uuid);
      browser_ids := array_append(browser_ids, (receipt->>'browserSessionId')::uuid);
    elsif (select count(*) from jsonb_object_keys(receipt)) <> 6
      or not receipt ?& array['key','kind','path','policy','status','reason']
      or jsonb_typeof(receipt->'status') is distinct from 'string'
      or jsonb_typeof(receipt->'reason') is distinct from 'string'
      or not (
        (receipt->>'status' = 'unavailable'
          and receipt->>'reason' in ('runtime_unavailable','tool_not_approved','isolated_target_unavailable'))
        or (receipt->>'status' = 'failed'
          and receipt->>'reason' in ('capture_failed','policy_excluded','source_changed'))
      ) is true then
      raise exception 'Browser verification receipt does not match its planned capture.' using errcode = '23514';
    end if;
  end loop;

  for transfer in select * from jsonb_array_elements(p_transfers) loop
    if jsonb_typeof(transfer) is distinct from 'object' then
      raise exception 'Invalid browser screenshot transfer.' using errcode = '23514';
    end if;
    if (select count(*) from jsonb_object_keys(transfer)) <> 2
      or jsonb_typeof(transfer->'assetId') is distinct from 'string' or transfer->>'assetId' !~ uuid_pattern
      or jsonb_typeof(transfer->'operationId') is distinct from 'string' or transfer->>'operationId' !~ uuid_pattern then
      raise exception 'Invalid browser screenshot transfer.' using errcode = '23514';
    end if;
    asset_id := (transfer->>'assetId')::uuid;
    operation_id := (transfer->>'operationId')::uuid;
    if asset_id = any(transfer_asset_ids) or operation_id = any(operation_ids) or not (asset_id = any(asset_ids)) then
      raise exception 'Browser screenshot transfers must match the captured manifests.' using errcode = '23514';
    end if;
    transfer_asset_ids := array_append(transfer_asset_ids, asset_id);
    operation_ids := array_append(operation_ids, operation_id);
  end loop;
  if cardinality(asset_ids) <> cardinality(transfer_asset_ids) then
    raise exception 'Browser screenshot transfers must match the captured manifests.' using errcode = '23514';
  end if;

  select * into prior from public.session_browser_verification_receipts existing where existing.run_id = p_run_id;
  if found then
    if prior.records = p_records and not exists (
      select 1 from public.session_browser_verification_assets asset where asset.run_id = p_run_id
        and asset.approval_scope_id is distinct from p_approval_scope_id
    ) then return prior; end if;
    raise exception 'Browser verification has already been recorded.' using errcode = 'PT409';
  end if;
  perform internal.require_current_browser_verification(pinned, cardinality(asset_ids) > 0, p_approval_scope_id);

  insert into public.session_browser_verification_receipts(run_id, session_id, workspace_id, records)
    values(p_run_id, pinned.session_id, pinned.workspace_id, p_records) returning * into result;
  foreach asset_id in array asset_ids loop
    select value into strict receipt from jsonb_array_elements(p_records)
      where value#>>'{manifest,assetId}' = asset_id::text;
    manifest := receipt->'manifest';
    select value into strict planned from jsonb_array_elements(pinned.plan->'browser') where value->'key' = receipt->'key';
    path := pinned.workspace_id::text || '/' || pinned.run_id::text || '/browser/' || asset_id::text || '.png';
    operation_id := operation_ids[array_position(transfer_asset_ids, asset_id)];
    select op.* into upload from public.workspace_resource_operations op
    where (op.id, op.workspace_id, op.kind, op.storage_bucket, op.resource_id) =
      (operation_id, pinned.workspace_id, 'upload', 'session-validation-evidence', path) for update;
    if not found or upload.settled_at is not null or upload.recovery_after <= clock_timestamp()
      or not exists (
        select 1 from storage.objects object where (object.bucket_id, object.name) = ('session-validation-evidence', path)
          and object.metadata->>'mimetype' = 'image/png'
          and object.metadata->>'size' = manifest->>'sizeBytes'
      ) then
      raise exception 'Private screenshot upload is unavailable for this capture.' using errcode = '23514';
    end if;
    insert into public.session_browser_verification_assets(
      id, run_id, workspace_id, session_id, evidence_key, browser_session_id, approval_scope_id, required,
      storage_path, sha256, content_type, size_bytes
    ) values (
      asset_id, pinned.run_id, pinned.workspace_id, pinned.session_id, 'browser:screenshot:' || (receipt->>'key'),
      (receipt->>'browserSessionId')::uuid, p_approval_scope_id, (
        select (value->>'required')::boolean from jsonb_array_elements(planned->'evidence') where value->>'kind' = 'screenshot'
      ), path, manifest->>'sha256', 'image/png', (manifest->>'sizeBytes')::integer
    );
    perform public.settle_workspace_resource_operation(operation_id, true);
  end loop;
  return result;
end;
$$;

create function public.record_session_browser_screenshot_verification(
  p_run_id uuid, p_attempt_count integer, p_commit_sha text, p_validation_tree_sha text,
  p_records jsonb, p_transfers jsonb, p_approval_scope_id text default null
) returns public.session_browser_verification_receipts language sql security definer set search_path = '' as $$
  select internal.record_session_browser_screenshot_verification(
    p_run_id, p_attempt_count, p_commit_sha, p_validation_tree_sha, p_records, p_transfers, p_approval_scope_id
  );
$$;

create or replace function internal.record_session_browser_verification(
  p_run_id uuid, p_attempt_count integer, p_commit_sha text, p_validation_tree_sha text, p_records jsonb
) returns public.session_browser_verification_receipts language sql security definer set search_path = '' as $$
  select internal.record_session_browser_screenshot_verification(
    p_run_id, p_attempt_count, p_commit_sha, p_validation_tree_sha, p_records, '[]'::jsonb, null
  );
$$;

revoke all on function internal.guard_browser_screenshot_reservation(), internal.guard_browser_screenshot_storage(),
  internal.lock_browser_verification_plan(uuid,integer,text,text),
  internal.require_current_browser_verification(public.session_validation_plans,boolean,text),
  internal.record_session_browser_screenshot_verification(uuid,integer,text,text,jsonb,jsonb,text)
from public, anon, authenticated, service_role;
revoke all on function public.authorize_session_browser_screenshot(uuid,integer,text,text,text),
  public.record_session_browser_screenshot_verification(uuid,integer,text,text,jsonb,jsonb,text)
from public, anon, authenticated, service_role;
grant execute on function public.authorize_session_browser_screenshot(uuid,integer,text,text,text),
  public.record_session_browser_screenshot_verification(uuid,integer,text,text,jsonb,jsonb,text) to service_role;
