-- A context manifest keeps only provenance and digests. Later forgetting of
-- a source or message does not rewrite what the worker originally admitted.
create table public.session_run_context_manifests (
  run_id uuid primary key references public.agent_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  job_id uuid not null references public.agent_jobs(id) on delete cascade,
  attempt_count integer not null check (attempt_count > 0),
  origin_run_id uuid check (origin_run_id <> run_id),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object' and octet_length(manifest::text) <= 131072),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique (job_id, attempt_count)
);
create index session_run_context_manifests_session_idx
  on public.session_run_context_manifests(session_id, created_at desc);
alter table public.session_run_context_manifests enable row level security;
revoke all on public.session_run_context_manifests from public, anon, authenticated, service_role;
grant select on public.session_run_context_manifests to service_role;
create trigger run_context_manifests_immutable before update or delete on public.session_run_context_manifests
  for each row execute function internal.guard_validation_evidence_history();

-- Manual retry can have context even when no recoverable Git bundle exists.
-- Keep that exact chosen run ID independently of the checkpoint association.
create table internal.session_context_manual_retry_origins (
  job_id uuid primary key references public.agent_jobs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  requested_run_id uuid not null,
  origin_run_id uuid not null
);
alter table internal.session_context_manual_retry_origins enable row level security;
revoke all on internal.session_context_manual_retry_origins from public, anon, authenticated, service_role;
create function internal.guard_manual_run_context_origin_history() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (
    not exists(select 1 from public.agent_jobs job where job.id = old.job_id)
    or not exists(select 1 from public.sessions session where session.id = old.session_id)
    or not exists(select 1 from public.workspaces workspace where workspace.id = old.workspace_id)
  ) then return old; end if;
  raise exception 'The manual retry context origin is immutable.' using errcode = '23514';
end;
$$;
create trigger run_context_manual_retry_origins_immutable before update or delete on internal.session_context_manual_retry_origins
  for each row execute function internal.guard_manual_run_context_origin_history();

-- A run row is created before acquisition and is not evidence of agent
-- dispatch. Skip failed startup attempts that never froze any inputs.
create function internal.previous_run_context_dispatch(
  p_workspace_id uuid, p_session_id uuid, p_job_id uuid, p_stage_id uuid, p_attempt_count integer
) returns public.agent_runs language sql stable set search_path = '' as $$
  select prior.* from public.agent_runs prior
  where (prior.workspace_id, prior.session_id, prior.agent_job_id, prior.stage_id) =
    (p_workspace_id, p_session_id, p_job_id, p_stage_id)
    and prior.attempt_count < p_attempt_count
    and (exists (
      select 1 from public.session_run_context_manifests frozen
      where (frozen.run_id, frozen.workspace_id, frozen.session_id, frozen.job_id, frozen.attempt_count) =
        (prior.id, prior.workspace_id, prior.session_id, prior.agent_job_id, prior.attempt_count)
    ) or exists (
      select 1 from public.session_attempt_manifests dispatched
      where (dispatched.run_id, dispatched.workspace_id, dispatched.session_id, dispatched.job_id,
          dispatched.stage_id, dispatched.attempt_count) =
        (prior.id, prior.workspace_id, prior.session_id, prior.agent_job_id, prior.stage_id, prior.attempt_count)
    ))
  order by prior.attempt_count desc
  limit 1;
$$;

alter function internal.enqueue_session_retry_with_checkpoint(uuid,uuid,uuid,uuid,uuid,text,text,text)
  rename to enqueue_session_retry_with_checkpoint_before_context;
revoke all on function internal.enqueue_session_retry_with_checkpoint_before_context(uuid,uuid,uuid,uuid,uuid,text,text,text)
  from public, anon, authenticated, service_role;
create function internal.enqueue_session_retry_with_checkpoint(
  p_session_id uuid, p_workspace_id uuid, p_expected_stage_id uuid, p_requested_by_member_id uuid, p_retry_run_id uuid,
  p_agent_model_provider text, p_agent_model_name text, p_run_type text
) returns table(job_id uuid, run_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  queued record;
  requested public.agent_runs;
  previous public.agent_runs;
  accepted_origin uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into strict queued from internal.enqueue_session_retry_with_checkpoint_before_context(
    p_session_id, p_workspace_id, p_expected_stage_id, p_requested_by_member_id, p_retry_run_id,
    p_agent_model_provider, p_agent_model_name, p_run_type
  );
  if queued.created and queued.job_id is not null then
    select * into strict requested from public.agent_runs run
    where (run.id, run.workspace_id, run.session_id) = (p_retry_run_id, p_workspace_id, p_session_id);
    accepted_origin := requested.id;
    if not exists (
      select 1 from public.session_run_context_manifests frozen where frozen.run_id = requested.id
    ) and not exists (
      select 1 from public.session_attempt_manifests dispatched where dispatched.run_id = requested.id
    ) then
      -- A retry that failed before freezing can inherit its already selected
      -- origin. Preserve the requested run ID separately for attribution.
      previous := internal.previous_run_context_dispatch(requested.workspace_id, requested.session_id,
        requested.agent_job_id, requested.stage_id, requested.attempt_count);
      if previous.id is not null then
        accepted_origin := previous.id;
      else
        select binding.origin_run_id into accepted_origin from internal.session_context_manual_retry_origins binding
        where (binding.job_id, binding.workspace_id, binding.session_id) =
          (requested.agent_job_id, requested.workspace_id, requested.session_id);
        accepted_origin := coalesce(accepted_origin, requested.id);
      end if;
    end if;
    insert into internal.session_context_manual_retry_origins(job_id, workspace_id, session_id, requested_run_id, origin_run_id)
      values (queued.job_id, p_workspace_id, p_session_id, requested.id, accepted_origin);
  end if;
  return query select queued.job_id, queued.run_id, queued.created;
end;
$$;
create or replace function public.enqueue_session_retry_with_checkpoint(
  p_session_id uuid, p_workspace_id uuid, p_expected_stage_id uuid, p_requested_by_member_id uuid, p_retry_run_id uuid,
  p_agent_model_provider text, p_agent_model_name text, p_run_type text
) returns table(job_id uuid, run_id uuid, created boolean)
language sql security invoker set search_path = '' as $$
  select * from internal.enqueue_session_retry_with_checkpoint(
    p_session_id, p_workspace_id, p_expected_stage_id, p_requested_by_member_id, p_retry_run_id,
    p_agent_model_provider, p_agent_model_name, p_run_type
  );
$$;
revoke all on function internal.enqueue_session_retry_with_checkpoint(uuid,uuid,uuid,uuid,uuid,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function internal.enqueue_session_retry_with_checkpoint(uuid,uuid,uuid,uuid,uuid,text,text,text) to service_role;

create function internal.is_run_context_integer(value jsonb, minimum bigint, maximum bigint)
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(value) = 'number' and (value #>> '{}') ~ '^(0|[1-9][0-9]{0,15})$'
    then (value #>> '{}')::bigint between minimum and maximum else false end;
$$;

create function internal.is_run_context_digest(value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(value) = 'string' and (value #>> '{}') ~ '^[a-f0-9]{64}$', false);
$$;

create function internal.is_run_context_manifest(payload jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  required jsonb := payload->'required';
  documents jsonb := payload->'documents';
  conversation jsonb := payload->'conversation';
  budget jsonb := payload->'budget';
  item jsonb;
  path text;
  item_keys text[];
  required_keys text[] := '{}';
  source_ids text[] := '{}';
  last_sequence bigint := 0;
  used_bytes bigint := 0;
  uuid_pattern constant text := '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
begin
  if jsonb_typeof(payload) is distinct from 'object' or octet_length(payload::text) > 131072
    or not payload ?& array['version','required','documents','conversation','budget']
    or payload - array['version','required','documents','conversation','budget'] <> '{}'::jsonb
    or payload->'version' is distinct from '1'::jsonb
    or jsonb_typeof(required) is distinct from 'array' or jsonb_typeof(documents) is distinct from 'array'
    or jsonb_typeof(conversation) is distinct from 'object' or jsonb_typeof(budget) is distinct from 'object' then
    return false;
  end if;
  if jsonb_array_length(required) > 128 or jsonb_array_length(documents) > 8
    or not conversation ?& array['throughSequence','olderOmitted','messages']
    or conversation - array['throughSequence','olderOmitted','messages'] <> '{}'::jsonb
    or not internal.is_run_context_integer(conversation->'throughSequence', 0, 9007199254740991)
    or not internal.is_run_context_integer(conversation->'olderOmitted', 0, 9007199254740991)
    or jsonb_typeof(conversation->'messages') is distinct from 'array'
    or not budget ?& array['maxUtf8Bytes','maxEstimatedTokens','usedUtf8Bytes','estimatedTokens']
    or budget - array['maxUtf8Bytes','maxEstimatedTokens','usedUtf8Bytes','estimatedTokens'] <> '{}'::jsonb
    or not internal.is_run_context_integer(budget->'maxUtf8Bytes', 0, 131072)
    or not internal.is_run_context_integer(budget->'maxEstimatedTokens', 0, 32768)
    or not internal.is_run_context_integer(budget->'usedUtf8Bytes', 0, 131072)
    or not internal.is_run_context_integer(budget->'estimatedTokens', 0, 32768) then
    return false;
  end if;
  if jsonb_array_length(conversation->'messages') > 100
    or (conversation->>'olderOmitted')::bigint > (conversation->>'throughSequence')::bigint then
    return false;
  end if;

  item_keys := array['key','sha256','utf8Bytes'];
  for item in select value from jsonb_array_elements(required) loop
    if jsonb_typeof(item) is distinct from 'object' or not item ?& item_keys or item - item_keys <> '{}'::jsonb
      or jsonb_typeof(item->'key') is distinct from 'string' or length(item->>'key') > 512
      or item->>'key' !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]*$'
      or item->>'key' = any(required_keys) or not internal.is_run_context_digest(item->'sha256')
      or not internal.is_run_context_integer(item->'utf8Bytes', 0, 131072) then return false; end if;
    required_keys := array_append(required_keys, item->>'key');
    used_bytes := used_bytes + (item->>'utf8Bytes')::bigint;
  end loop;

  for item in select value from jsonb_array_elements(documents) loop
    if jsonb_typeof(item) is distinct from 'object' then return false; end if;
    item_keys := array['sourceId','revisionId','status','reason'];
    if not item ?& item_keys
      or jsonb_typeof(item->'sourceId') is distinct from 'string' or item->>'sourceId' !~ uuid_pattern
      or jsonb_typeof(item->'revisionId') is distinct from 'string' or item->>'revisionId' !~ uuid_pattern
      or item->>'sourceId' = any(source_ids) or jsonb_typeof(item->'status') is distinct from 'string'
      or jsonb_typeof(item->'reason') is distinct from 'string' then return false; end if;
    source_ids := array_append(source_ids, item->>'sourceId');
    if item->>'status' = 'selected' then
      item_keys := item_keys || array['filePath','upstreamRevision','contentSha256','contentBytes','stale','sha256','utf8Bytes'];
      path := item->>'filePath';
      if not item ?& item_keys or item - item_keys <> '{}'::jsonb or item->>'reason' <> 'exact_revision'
        or jsonb_typeof(item->'filePath') is distinct from 'string' or octet_length(path) not between 1 and 512
        or path <> btrim(path) or path ~ '(^/|/$|//|[[:cntrl:]])' or path ~ '(^|/)[.]{1,2}(/|$)'
        or strpos(path, chr(92)) > 0 or cardinality(string_to_array(path, '/')) > 12 or path !~* '[.](md|markdown|txt)$'
        or jsonb_typeof(item->'upstreamRevision') is distinct from 'string' or item->>'upstreamRevision' !~ '^[a-f0-9]{40}$'
        or not internal.is_run_context_digest(item->'contentSha256') or not internal.is_run_context_digest(item->'sha256')
        or not internal.is_run_context_integer(item->'contentBytes', 0, 131072)
        or not internal.is_run_context_integer(item->'utf8Bytes', 0, 131072)
        or jsonb_typeof(item->'stale') is distinct from 'boolean' then return false; end if;
      used_bytes := used_bytes + (item->>'utf8Bytes')::bigint;
    elsif item - item_keys <> '{}'::jsonb or not (
        (item->>'status' = 'excluded' and item->>'reason' in ('not_selected','byte_limit','context_budget'))
        or (item->>'status' = 'unavailable' and item->>'reason' in ('missing_revision','source_unavailable','access_revoked',
          'revision_changed','upstream_deleted','upstream_unavailable','revision_mismatch'))
      ) then return false;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(conversation->'messages') loop
    if jsonb_typeof(item) is distinct from 'object' or not internal.is_run_context_integer(item->'sequence',
      last_sequence + 1, (conversation->>'throughSequence')::bigint) then return false; end if;
    last_sequence := (item->>'sequence')::bigint;
    if item = jsonb_build_object('sequence', last_sequence, 'reason', 'context_budget') then continue; end if;
    item_keys := array['sequence','sha256','utf8Bytes'];
    if not item ?& item_keys or item - item_keys <> '{}'::jsonb or not internal.is_run_context_digest(item->'sha256')
      or not internal.is_run_context_integer(item->'utf8Bytes', 0, 131072) then return false; end if;
    used_bytes := used_bytes + (item->>'utf8Bytes')::bigint;
  end loop;
  return used_bytes <= (budget->>'maxUtf8Bytes')::bigint and used_bytes <= (budget->>'maxEstimatedTokens')::bigint
    and used_bytes = (budget->>'usedUtf8Bytes')::bigint and used_bytes = (budget->>'estimatedTokens')::bigint;
end;
$$;

create function internal.lock_factory_run_context_attempt(
  p_workspace_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer
) returns public.agent_jobs language plpgsql set search_path = '' as $$
declare
  control internal.git_continuity_release_control;
  owner public.sessions;
  job public.agent_jobs;
  run public.agent_runs;
  definition jsonb;
  invalid_attempt constant text := 'The worker does not own the current run context attempt.';
begin
  perform internal.assert_checkpoint_publication_service();
  if p_attempt_count is null or p_attempt_count <= 0 then
    raise exception '%', invalid_attempt using errcode = '42501';
  end if;
  -- Keep the attempt start lock order used by the original dispatch receipts.
  select * into strict control from internal.git_continuity_release_control where singleton for share;
  perform 1 from public.workspaces workspace where workspace.id = p_workspace_id
    and workspace.deletion_requested_at is null for share;
  if not found then raise exception '%', invalid_attempt using errcode = '42501'; end if;
  select session.* into owner from public.sessions session
  join public.agent_jobs queued on (queued.workspace_id, queued.session_id) = (session.workspace_id, session.id)
  where queued.id = p_job_id and session.workspace_id = p_workspace_id for no key update of session;
  if not found or owner.archived_at is not null or owner.phase_status is distinct from 'in_progress'
    or not owner.execute_pinned_definition then
    raise exception '%', invalid_attempt using errcode = '42501';
  end if;
  definition := internal.pinned_session_execution_definition(owner);
  if definition ? 'executionGrant' then
    perform internal.recheck_session_execution_grant(owner);
  else
    perform internal.assert_factory_accepts_work(owner.workspace_id, owner.factory_id);
    perform internal.assert_factory_grant_invoker(owner.workspace_id, owner.factory_id, owner.creator_member_id);
  end if;
  select * into job from public.agent_jobs queued where queued.id = p_job_id for update;
  if not found or (job.workspace_id, job.session_id) is distinct from (owner.workspace_id, owner.id)
    or job.status not in ('started','running') or job.attempt_count is distinct from p_attempt_count
    or job.stage_id is null or job.stage_id is distinct from owner.current_stage_id then
    raise exception '%', invalid_attempt using errcode = '42501';
  end if;
  if not control.enabled or job.git_continuity_release_revision is distinct from control.revision
    or not exists (select 1 from public.session_git_continuity_enrollments enrollment
      where (enrollment.session_id, enrollment.workspace_id) = (owner.id, owner.workspace_id)) then
    raise exception 'Git continuity admission is paused or requires a fresh session.' using errcode = 'P499P';
  end if;
  select * into run from public.agent_runs active where active.id = p_run_id for update;
  if not found or run.status is distinct from 'running'
    or (run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count, run.stage_id)
      is distinct from (owner.workspace_id, owner.id, job.id, p_attempt_count, job.stage_id) then
    raise exception '%', invalid_attempt using errcode = '42501';
  end if;
  return job;
end;
$$;

create function internal.read_run_context_origin(job public.agent_jobs, p_run_id uuid)
returns table(status text, origin_run_id uuid, manifest jsonb)
language plpgsql set search_path = '' as $$
declare
  origin public.agent_runs;
  frozen public.session_run_context_manifests;
  retry_ref uuid;
begin
  -- Re-reading an already-pinned current attempt must not reselect live input.
  select * into frozen from public.session_run_context_manifests pinned where pinned.run_id = p_run_id;
  if found then
    return query select 'replay'::text, frozen.run_id, frozen.manifest;
    return;
  end if;

  origin := internal.previous_run_context_dispatch(job.workspace_id, job.session_id, job.id, job.stage_id, job.attempt_count);
  if origin.id is null then
    select binding.origin_run_id into retry_ref from internal.session_context_manual_retry_origins binding
    where (binding.job_id, binding.workspace_id, binding.session_id) = (job.id, job.workspace_id, job.session_id);
    if found then
      select prior.* into origin from public.agent_runs prior
      join public.agent_jobs prior_job on (prior_job.id, prior_job.workspace_id, prior_job.session_id, prior_job.stage_id) =
        (prior.agent_job_id, prior.workspace_id, prior.session_id, prior.stage_id)
      where (prior.id, prior.workspace_id, prior.session_id, prior.stage_id) =
        (retry_ref, job.workspace_id, job.session_id, job.stage_id) and prior_job.id <> job.id;
      if not found then
        return query select 'missing'::text, null::uuid, null::jsonb;
        return;
      end if;
    elsif job.trigger_type = 'manual_retry' and job.requested_by_member_id is not null then
      return query select 'missing'::text, null::uuid, null::jsonb;
      return;
    else
      return query select 'fresh'::text, null::uuid, null::jsonb;
      return;
    end if;
  end if;

  if origin.status not in ('success','error','canceled') or origin.attempt_count is null then
    return query select 'missing'::text, null::uuid, null::jsonb;
    return;
  end if;
  select * into frozen from public.session_run_context_manifests pinned
  where (pinned.run_id, pinned.workspace_id, pinned.session_id, pinned.job_id, pinned.attempt_count) =
    (origin.id, origin.workspace_id, origin.session_id, origin.agent_job_id, origin.attempt_count);
  if not found then
    -- The exact manual target can support a first selection after a startup
    -- failure, provided no attempt of its original job reached dispatch.
    -- A user retry without an authoritative binding cannot become a fresh
    -- generation just because somebody subsequently retries its failed run.
    if retry_ref is not null and origin.status in ('error','canceled')
      and exists (
        select 1 from public.agent_jobs source_job where source_job.id = origin.agent_job_id
          and (source_job.trigger_type <> 'manual_retry' or source_job.requested_by_member_id is null)
      )
      and not exists (
        select 1 from internal.session_context_manual_retry_origins binding where binding.job_id = origin.agent_job_id
      )
      and not exists (
        select 1 from public.session_run_context_manifests existing where existing.job_id = origin.agent_job_id
      )
      and not exists (
        select 1 from public.session_attempt_manifests dispatched where dispatched.job_id = origin.agent_job_id
      ) then
      return query select 'fresh'::text, null::uuid, null::jsonb;
      return;
    end if;
    -- Legacy dispatched input cannot be inferred from current documents or messages.
    return query select 'missing'::text, null::uuid, null::jsonb;
    return;
  end if;
  return query select 'replay'::text, frozen.run_id, frozen.manifest;
end;
$$;

create function public.read_factory_run_context_origin(
  p_workspace_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer
) returns table(status text, origin_run_id uuid, manifest jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  job public.agent_jobs;
begin
  job := internal.lock_factory_run_context_attempt(p_workspace_id, p_job_id, p_run_id, p_attempt_count);
  return query select * from internal.read_run_context_origin(job, p_run_id);
end;
$$;

create function public.pin_factory_run_context(
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
  if not internal.is_run_context_manifest(p_manifest) then
    raise exception 'Invalid bounded run context manifest.' using errcode = '23514';
  end if;

  insert into public.session_run_context_manifests(run_id, workspace_id, session_id, job_id, attempt_count,
    origin_run_id, manifest, manifest_sha256)
  values(p_run_id, job.workspace_id, job.session_id, job.id, p_attempt_count, p_origin_run_id, p_manifest,
    encode(sha256(convert_to(p_manifest::text, 'UTF8')), 'hex')) returning * into prior;
  return prior;
end;
$$;

revoke all on function internal.is_run_context_integer(jsonb,bigint,bigint), internal.is_run_context_digest(jsonb),
  internal.is_run_context_manifest(jsonb), internal.lock_factory_run_context_attempt(uuid,uuid,uuid,integer),
  internal.previous_run_context_dispatch(uuid,uuid,uuid,uuid,integer),
  internal.guard_manual_run_context_origin_history(),
  internal.read_run_context_origin(public.agent_jobs,uuid) from public, anon, authenticated, service_role;
revoke all on function public.read_factory_run_context_origin(uuid,uuid,uuid,integer),
  public.pin_factory_run_context(uuid,uuid,uuid,integer,jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.read_factory_run_context_origin(uuid,uuid,uuid,integer),
  public.pin_factory_run_context(uuid,uuid,uuid,integer,jsonb,uuid) to service_role;
