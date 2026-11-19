create function internal.is_factory_memory_run_context_manifest(payload jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  item jsonb;
  memories jsonb := payload->'memories';
  budget jsonb := payload->'budget';
  memory_ids text[] := '{}';
  revision_ids text[] := '{}';
  base_keys constant text[] := array['memoryId','revisionId','status'];
  uuid_pattern constant text := '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
  memory_bytes integer := 0;
  used_bytes integer;
begin
  if payload->'version' is distinct from '2'::jsonb then
    return internal.is_run_context_manifest(payload);
  end if;
  if octet_length(payload::text) > 131072
    or jsonb_typeof(memories) is distinct from 'array'
    or jsonb_typeof(budget) is distinct from 'object' then return false; end if;
  if jsonb_array_length(memories) > 8
    or not internal.is_run_context_integer(budget->'usedUtf8Bytes', 0, 131072)
    or not internal.is_run_context_integer(budget->'estimatedTokens', 0, 32768)
    or budget->'usedUtf8Bytes' <> budget->'estimatedTokens' then return false; end if;
  used_bytes := (budget->>'usedUtf8Bytes')::integer;

  for item in select value from jsonb_array_elements(memories) loop
    if jsonb_typeof(item) is distinct from 'object' or not item ?& base_keys
      or jsonb_typeof(item->'memoryId') is distinct from 'string'
      or jsonb_typeof(item->'revisionId') is distinct from 'string'
      or item->>'memoryId' !~ uuid_pattern or item->>'revisionId' !~ uuid_pattern
      or item->>'memoryId' = any(memory_ids) or item->>'revisionId' = any(revision_ids)
      then return false; end if;
    memory_ids := array_append(memory_ids, item->>'memoryId');
    revision_ids := array_append(revision_ids, item->>'revisionId');
    if item->'status' = '"selected"'::jsonb then
      if not item ?& array['approvalId','sha256','utf8Bytes']
        or item - (base_keys || array['approvalId','sha256','utf8Bytes']) <> '{}'::jsonb
        or jsonb_typeof(item->'approvalId') is distinct from 'string'
        or item->>'approvalId' !~ uuid_pattern
        or not internal.is_run_context_digest(item->'sha256')
        or not internal.is_run_context_integer(item->'utf8Bytes', 1, 4096)
        then return false; end if;
      memory_bytes := memory_bytes + (item->>'utf8Bytes')::integer;
    elsif item->'status' is distinct from '"excluded"'::jsonb
      or item->'reason' is distinct from '"context_budget"'::jsonb
      or item - (base_keys || array['reason']) <> '{}'::jsonb then return false;
    end if;
  end loop;

  if memory_bytes > used_bytes
    or not internal.is_run_context_integer(budget->'maxUtf8Bytes', used_bytes, 131072)
    or not internal.is_run_context_integer(budget->'maxEstimatedTokens', used_bytes, 32768)
    then return false; end if;
  -- Reuse the established validator for all non-memory fields.
  return internal.is_run_context_manifest(
    payload - 'memories' || jsonb_build_object('version', 1, 'budget',
      budget || jsonb_build_object('usedUtf8Bytes', used_bytes - memory_bytes,
        'estimatedTokens', used_bytes - memory_bytes)));
end;
$$;

create function internal.assert_factory_run_memory_eligible(
  scope_workspace uuid, scope_session uuid, payload jsonb, include_excluded boolean
) returns void language plpgsql set search_path = '' as $$
declare
  scope_factory uuid;
  refs jsonb;
  revision_ids uuid[];
begin
  if payload->'version' is distinct from '2'::jsonb then return; end if;
  select jsonb_agg(item), array_agg((item->>'revisionId')::uuid) into refs, revision_ids
    from jsonb_array_elements(payload->'memories') item
    where include_excluded or item->>'status' = 'selected';
  if refs is null then return; end if;
  select factory_id into strict scope_factory from public.sessions
    where (workspace_id, id) = (scope_workspace, scope_session);

  -- The family lock serializes pinning with correction, expiry decisions and
  -- forgetting. Revalidate the exact revision and approval after acquiring it.
  perform memory.id from public.factory_memories memory
    where (memory.workspace_id, memory.factory_id) = (scope_workspace, scope_factory)
      and memory.id in (select (item->>'memoryId')::uuid from jsonb_array_elements(refs) item)
    order by memory.id for share;
  if exists (
    select 1 from jsonb_array_elements(refs) item
    left join public.read_factory_memory_context(scope_workspace, scope_factory, revision_ids) eligible
      on (eligible.memory_id, eligible.revision_id) =
        ((item->>'memoryId')::uuid, (item->>'revisionId')::uuid)
    where eligible.revision_id is null or (
      item->>'status' = 'selected' and (
        eligible.approval_id is distinct from (item->>'approvalId')::uuid
        or eligible.content_sha256 is distinct from item->>'sha256'
        or encode(sha256(convert_to(eligible.body_md, 'UTF8')), 'hex') is distinct from item->>'sha256'
        or octet_length(eligible.body_md) is distinct from (item->>'utf8Bytes')::integer
      )
    )
  ) then
    raise exception 'A recorded factory memory is no longer eligible.' using errcode = 'PT409';
  end if;
end;
$$;

create or replace function public.pin_factory_run_context(
  p_workspace_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer, p_manifest jsonb,
  p_origin_run_id uuid default null
) returns public.session_run_context_manifests language plpgsql security definer set search_path = '' as $$
declare
  job public.agent_jobs;
  prior public.session_run_context_manifests;
  lineage record;
begin
  job := internal.lock_factory_run_context_attempt(p_workspace_id, p_job_id, p_run_id, p_attempt_count);
  select * into prior from public.session_run_context_manifests frozen where frozen.run_id = p_run_id;
  if found then
    if prior.manifest = p_manifest and (prior.origin_run_id is not distinct from p_origin_run_id or p_origin_run_id = p_run_id) then
      perform internal.assert_factory_run_memory_eligible(job.workspace_id, job.session_id, prior.manifest, false);
      return prior;
    end if;
    raise exception 'Run context has already been frozen.' using errcode = 'PT409';
  end if;
  select * into strict lineage from internal.read_run_context_origin(job, p_run_id);
  if lineage.status = 'missing' then
    raise exception 'The original run context is unavailable.' using errcode = 'PT409';
  end if;
  if p_origin_run_id is distinct from lineage.origin_run_id
    or (lineage.status = 'replay' and p_manifest is distinct from lineage.manifest) then
    raise exception 'Run context does not match the exact retry origin.' using errcode = '23514';
  end if;
  if not internal.is_factory_memory_run_context_manifest(p_manifest) then
    raise exception 'Invalid bounded run context manifest.' using errcode = '23514';
  end if;
  perform internal.assert_factory_run_memory_eligible(job.workspace_id, job.session_id, p_manifest, lineage.status = 'fresh');

  insert into public.session_run_context_manifests(run_id, workspace_id, session_id, job_id, attempt_count,
    origin_run_id, manifest, manifest_sha256)
  values(p_run_id, job.workspace_id, job.session_id, job.id, p_attempt_count, p_origin_run_id, p_manifest,
    encode(sha256(convert_to(p_manifest::text, 'UTF8')), 'hex')) returning * into prior;
  return prior;
end;
$$;

revoke all on function internal.is_factory_memory_run_context_manifest(jsonb),
  internal.assert_factory_run_memory_eligible(uuid,uuid,jsonb,boolean)
  from public, anon, authenticated, service_role;
