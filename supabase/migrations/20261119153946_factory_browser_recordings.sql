-- Keep the existing immutable browser receipt and exact private Storage owner
-- for both media kinds. Text and PNG retain their one-MiB limits.
update storage.buckets set public = false, file_size_limit = 8388608,
  allowed_mime_types = array['text/plain','application/json','image/png','video/webm']
where id = 'session-validation-evidence';

alter table public.session_browser_verification_assets
  drop constraint session_browser_verification_assets_check,
  drop constraint session_browser_verification_assets_content_type_check,
  drop constraint session_browser_verification_assets_evidence_key_check,
  drop constraint session_browser_verification_assets_size_bytes_check,
  add column duration_ms integer,
  add column width_px integer,
  add column height_px integer,
  add column frame_offsets_ms integer[],
  add column capture_started_at timestamptz,
  add column capture_completed_at timestamptz,
  add constraint browser_verification_asset_media_check check (
    (content_type = 'image/png' and evidence_key ~ '^browser:screenshot:[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
      and size_bytes between 1 and 1048576
      and storage_path = workspace_id::text || '/' || run_id::text || '/browser/' || id::text || '.png'
      and duration_ms is null and width_px is null and height_px is null and frame_offsets_ms is null
      and capture_started_at is null and capture_completed_at is null)
    or
    (content_type = 'video/webm' and evidence_key ~ '^browser:video:[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
      and size_bytes between 1 and 8388608
      and storage_path = workspace_id::text || '/' || run_id::text || '/browser/' || id::text || '.webm'
      and duration_ms is not null and duration_ms between 500 and 6500
      and width_px is not null and width_px between 2 and 960 and width_px % 2 = 0
      and height_px is not null and height_px between 2 and 540 and height_px % 2 = 0
      and frame_offsets_ms is not null and cardinality(frame_offsets_ms) between 1 and 13
      and duration_ms = cardinality(frame_offsets_ms) * 500
      and capture_started_at is not null and isfinite(capture_started_at)
      and capture_completed_at is not null and isfinite(capture_completed_at) and capture_completed_at >= capture_started_at)
  );

alter function internal.guard_browser_screenshot_reservation() rename to guard_browser_media_reservation;
alter function internal.guard_browser_screenshot_storage() rename to guard_browser_media_storage;
create or replace function internal.guard_browser_media_reservation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if split_part(new.resource_id, '/', 1) is distinct from new.workspace_id::text
    or new.resource_id !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/browser/[0-9a-f-]{36}[.](png|webm)$' then
    raise exception 'Invalid browser media reservation path.' using errcode = '23514';
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

create function public.authorize_session_browser_video(
  p_run_id uuid, p_attempt_count integer, p_commit_sha text, p_validation_tree_sha text,
  p_approval_scope_id text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  pinned public.session_validation_plans;
begin
  perform internal.assert_checkpoint_publication_service();
  pinned := internal.lock_browser_verification_plan(p_run_id, p_attempt_count, p_commit_sha, p_validation_tree_sha);
  if not coalesce(p_approval_scope_id ~ '/record_video$', false) then return false; end if;
  if exists(select 1 from public.session_browser_verification_receipts receipt where receipt.run_id = pinned.run_id)
    or not exists (
      select 1 from jsonb_array_elements(pinned.plan->'browser') check_spec
      cross join lateral jsonb_array_elements(check_spec->'evidence') evidence
      where evidence->>'kind' = 'video'
    ) then return false; end if;
  begin
    perform internal.require_current_browser_verification(pinned, true, p_approval_scope_id);
  exception when insufficient_privilege then
    return false;
  end;
  return true;
end;
$$;

create function internal.record_session_browser_media_verification(
  p_run_id uuid, p_attempt_count integer, p_commit_sha text, p_validation_tree_sha text,
  p_records jsonb, p_transfers jsonb, p_screenshot_approval_scope_id text, p_video_approval_scope_id text
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
  capture_kind text;
  capture_mime text;
  capture_scope text;
  receipt_keys text[];
  has_screenshot boolean := false;
  has_video boolean := false;
  run_started_at timestamptz;
  video_started_at timestamptz;
  video_completed_at timestamptz;
  video_duration integer;
  video_width integer;
  video_height integer;
  video_offsets integer[];
  expected_frames integer;
  timestamp_pattern constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{3})?Z$';
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
  if jsonb_array_length(p_records) <> expected_count or jsonb_array_length(p_transfers) > 10 then
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
      capture_kind := receipt->>'kind';
      manifest := receipt->'manifest';
      receipt_keys := array['key','kind','path','policy','status','browserSessionId','manifest'];
      if capture_kind = 'video' then receipt_keys := receipt_keys || array['startedAt','completedAt']; end if;
      if (select count(*) from jsonb_object_keys(receipt)) <> cardinality(receipt_keys)
        or not receipt ?& receipt_keys
        or jsonb_typeof(receipt->'browserSessionId') is distinct from 'string'
        or receipt->>'browserSessionId' !~ uuid_pattern
        or jsonb_typeof(manifest) is distinct from 'object' then
        raise exception 'Invalid trusted browser media receipt.' using errcode = '23514';
      end if;
      capture_mime := case when capture_kind = 'screenshot' then 'image/png' else 'video/webm' end;
      if (select count(*) from jsonb_object_keys(manifest)) <> (case when capture_kind = 'screenshot' then 4 else 8 end)
        or jsonb_typeof(manifest->'assetId') is distinct from 'string' or manifest->>'assetId' !~ uuid_pattern
        or jsonb_typeof(manifest->'sha256') is distinct from 'string' or manifest->>'sha256' !~ '^[0-9a-f]{64}$'
        or manifest->'contentType' is distinct from to_jsonb(capture_mime)
        or jsonb_typeof(manifest->'sizeBytes') is distinct from 'number' then
        raise exception 'Invalid private browser media manifest.' using errcode = '23514';
      end if;
      if (manifest->>'sizeBytes')::numeric not between 1 and (case when capture_kind = 'screenshot' then 1048576 else 8388608 end)
        or (manifest->>'sizeBytes')::numeric <> trunc((manifest->>'sizeBytes')::numeric)
        or (manifest->>'assetId')::uuid = any(asset_ids)
        or (receipt->>'browserSessionId')::uuid = any(browser_ids) then
        raise exception 'Invalid private browser media manifest.' using errcode = '23514';
      end if;
      if capture_kind = 'video' then
        has_video := true;
        expected_frames := jsonb_array_length(planned->'interactions') + 1;
        if jsonb_typeof(manifest->'durationMs') is distinct from 'number'
          or jsonb_typeof(manifest->'widthPx') is distinct from 'number'
          or jsonb_typeof(manifest->'heightPx') is distinct from 'number'
          or jsonb_typeof(receipt->'startedAt') is distinct from 'string' or receipt->>'startedAt' !~ timestamp_pattern
          or jsonb_typeof(receipt->'completedAt') is distinct from 'string' or receipt->>'completedAt' !~ timestamp_pattern
          or not pg_input_is_valid(receipt->>'startedAt', 'timestamp with time zone')
          or not pg_input_is_valid(receipt->>'completedAt', 'timestamp with time zone')
          or manifest->'frameOffsetsMs' is distinct from (
            select jsonb_agg(frame * 500 order by frame) from generate_series(0, expected_frames - 1) frame
          ) then
          raise exception 'Invalid complete browser video manifest.' using errcode = '23514';
        end if;
        if (manifest->>'durationMs')::numeric <> expected_frames * 500
          or expected_frames * 500 > (planned->>'timeoutSeconds')::integer * 1000
          or (manifest->>'widthPx')::numeric not between 2 and 960
          or mod((manifest->>'widthPx')::numeric, 2) <> 0
          or (manifest->>'heightPx')::numeric not between 2 and 540
          or mod((manifest->>'heightPx')::numeric, 2) <> 0
          or (receipt->>'completedAt')::timestamptz < (receipt->>'startedAt')::timestamptz
          or (receipt->>'completedAt')::timestamptz - (receipt->>'startedAt')::timestamptz >
            make_interval(secs => (planned->>'timeoutSeconds')::integer + 5) then
          raise exception 'Browser video is incomplete or exceeds its frozen capture limits.' using errcode = '23514';
        end if;
      else
        has_screenshot := true;
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
      raise exception 'Invalid browser media transfer.' using errcode = '23514';
    end if;
    if (select count(*) from jsonb_object_keys(transfer)) <> 2
      or jsonb_typeof(transfer->'assetId') is distinct from 'string' or transfer->>'assetId' !~ uuid_pattern
      or jsonb_typeof(transfer->'operationId') is distinct from 'string' or transfer->>'operationId' !~ uuid_pattern then
      raise exception 'Invalid browser media transfer.' using errcode = '23514';
    end if;
    asset_id := (transfer->>'assetId')::uuid;
    operation_id := (transfer->>'operationId')::uuid;
    if asset_id = any(transfer_asset_ids) or operation_id = any(operation_ids) or not (asset_id = any(asset_ids)) then
      raise exception 'Browser media transfers must match the captured manifests.' using errcode = '23514';
    end if;
    transfer_asset_ids := array_append(transfer_asset_ids, asset_id);
    operation_ids := array_append(operation_ids, operation_id);
  end loop;
  if cardinality(asset_ids) <> cardinality(transfer_asset_ids) then
    raise exception 'Browser media transfers must match the captured manifests.' using errcode = '23514';
  end if;

  select * into prior from public.session_browser_verification_receipts existing where existing.run_id = p_run_id;
  if found then
    if prior.records = p_records and not exists (
      select 1 from public.session_browser_verification_assets asset where asset.run_id = p_run_id
        and asset.approval_scope_id is distinct from
          case when asset.content_type = 'image/png' then p_screenshot_approval_scope_id else p_video_approval_scope_id end
    ) then return prior; end if;
    raise exception 'Browser verification has already been recorded.' using errcode = 'PT409';
  end if;
  if has_video and (not coalesce(p_video_approval_scope_id ~ '/record_video$', false)
    or (has_screenshot and p_video_approval_scope_id is not distinct from p_screenshot_approval_scope_id)) then
    raise exception 'The distinct browser video operation is not approved.' using errcode = '42501';
  end if;
  if has_video and has_screenshot and not exists (
    select 1 from public.sessions owner where (owner.id, owner.workspace_id) = (pinned.session_id, pinned.workspace_id)
      and internal.pinned_session_execution_definition(owner)->'toolIds' ? p_video_approval_scope_id
  ) then
    raise exception 'The exact browser video operation is not approved.' using errcode = '42501';
  end if;
  -- The shared live check validates every scope in the pinned definition. The
  -- extra check above requires both selected kinds to name their own scopes.
  perform internal.require_current_browser_verification(pinned, cardinality(asset_ids) > 0,
    case when has_screenshot then p_screenshot_approval_scope_id else p_video_approval_scope_id end);
  if has_video then
    select run.started_at into strict run_started_at from public.agent_runs run where run.id = pinned.run_id;
  end if;

  insert into public.session_browser_verification_receipts(run_id, session_id, workspace_id, records)
    values(p_run_id, pinned.session_id, pinned.workspace_id, p_records) returning * into result;
  foreach asset_id in array asset_ids loop
    select value into strict receipt from jsonb_array_elements(p_records)
      where value#>>'{manifest,assetId}' = asset_id::text;
    manifest := receipt->'manifest';
    select value into strict planned from jsonb_array_elements(pinned.plan->'browser') where value->'key' = receipt->'key';
    capture_kind := receipt->>'kind';
    capture_mime := manifest->>'contentType';
    capture_scope := case when capture_kind = 'screenshot' then p_screenshot_approval_scope_id else p_video_approval_scope_id end;
    path := pinned.workspace_id::text || '/' || pinned.run_id::text || '/browser/' || asset_id::text ||
      (case when capture_kind = 'screenshot' then '.png' else '.webm' end);
    operation_id := operation_ids[array_position(transfer_asset_ids, asset_id)];
    select op.* into upload from public.workspace_resource_operations op
    where (op.id, op.workspace_id, op.kind, op.storage_bucket, op.resource_id) =
      (operation_id, pinned.workspace_id, 'upload', 'session-validation-evidence', path) for update;
    if not found or upload.settled_at is not null or upload.recovery_after <= clock_timestamp()
      or not exists (
        select 1 from storage.objects object where (object.bucket_id, object.name) = ('session-validation-evidence', path)
          and object.metadata->>'mimetype' = capture_mime
          and object.metadata->>'size' = manifest->>'sizeBytes'
      ) then
      raise exception 'Private browser media upload is unavailable for this capture.' using errcode = '23514';
    end if;
    video_started_at := null;
    video_completed_at := null;
    video_duration := null;
    video_width := null;
    video_height := null;
    video_offsets := null;
    if capture_kind = 'video' then
      video_started_at := (receipt->>'startedAt')::timestamptz;
      video_completed_at := (receipt->>'completedAt')::timestamptz;
      if run_started_at is null or video_started_at < run_started_at - interval '5 seconds'
        or video_completed_at > clock_timestamp() + interval '5 seconds' then
        raise exception 'Video capture timestamps do not belong to this run.' using errcode = '23514';
      end if;
      video_duration := (manifest->>'durationMs')::numeric::integer;
      video_width := (manifest->>'widthPx')::numeric::integer;
      video_height := (manifest->>'heightPx')::numeric::integer;
      video_offsets := array(select value::numeric::integer
        from jsonb_array_elements_text(manifest->'frameOffsetsMs') with ordinality frame(value, position)
        order by position);
    end if;
    insert into public.session_browser_verification_assets(
      id, run_id, workspace_id, session_id, evidence_key, browser_session_id, approval_scope_id, required,
      storage_path, sha256, content_type, size_bytes, duration_ms, width_px, height_px, frame_offsets_ms,
      capture_started_at, capture_completed_at
    ) values (
      asset_id, pinned.run_id, pinned.workspace_id, pinned.session_id, 'browser:' || capture_kind || ':' || (receipt->>'key'),
      (receipt->>'browserSessionId')::uuid, capture_scope, (
        select (value->>'required')::boolean from jsonb_array_elements(planned->'evidence') where value->>'kind' = capture_kind
      ), path, manifest->>'sha256', capture_mime, (manifest->>'sizeBytes')::numeric::integer, video_duration, video_width,
      video_height, video_offsets, video_started_at, video_completed_at
    );
    perform public.settle_workspace_resource_operation(operation_id, true);
  end loop;
  return result;
end;
$$;


create function public.record_session_browser_media_verification(
  p_run_id uuid, p_attempt_count integer, p_commit_sha text, p_validation_tree_sha text,
  p_records jsonb, p_transfers jsonb, p_screenshot_approval_scope_id text default null, p_video_approval_scope_id text default null
) returns public.session_browser_verification_receipts language sql security definer set search_path = '' as $$
  select internal.record_session_browser_media_verification(
    p_run_id, p_attempt_count, p_commit_sha, p_validation_tree_sha, p_records, p_transfers,
    p_screenshot_approval_scope_id, p_video_approval_scope_id
  );
$$;

create or replace function internal.record_session_browser_screenshot_verification(
  p_run_id uuid, p_attempt_count integer, p_commit_sha text, p_validation_tree_sha text,
  p_records jsonb, p_transfers jsonb, p_approval_scope_id text
) returns public.session_browser_verification_receipts language sql set search_path = '' as $$
  select internal.record_session_browser_media_verification(
    p_run_id, p_attempt_count, p_commit_sha, p_validation_tree_sha, p_records, p_transfers, p_approval_scope_id, null
  );
$$;

revoke all on function internal.record_session_browser_media_verification(uuid,integer,text,text,jsonb,jsonb,text,text)
from public, anon, authenticated, service_role;
revoke all on function public.authorize_session_browser_video(uuid,integer,text,text,text),
  public.record_session_browser_media_verification(uuid,integer,text,text,jsonb,jsonb,text,text)
from public, anon, authenticated, service_role;
grant execute on function public.authorize_session_browser_video(uuid,integer,text,text,text),
  public.record_session_browser_media_verification(uuid,integer,text,text,jsonb,jsonb,text,text) to service_role;
