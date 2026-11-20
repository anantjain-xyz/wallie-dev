-- Terminal attempt facts use the same independent token and cost axes as
-- production usage accounting. An unavailable axis has no numeric value.
create function internal.valid_factory_evaluation_usage(
  p_input_tokens bigint, p_output_tokens bigint, p_token_provenance text,
  p_cost_usd numeric, p_cost_provenance text, p_estimation_revision text
) returns boolean language sql immutable set search_path = '' as $$
  select (
    case p_token_provenance
      when 'unavailable' then p_input_tokens is null and p_output_tokens is null
      when 'measured' then p_input_tokens between 0 and 1501199875790165 and p_output_tokens between 0 and 1501199875790165
      when 'estimated' then p_input_tokens between 0 and 1501199875790165 and p_output_tokens between 0 and 1501199875790165
      else false end
    and case p_cost_provenance
      when 'unavailable' then p_cost_usd is null
      when 'measured' then p_cost_usd between 0 and 1501199875790165
      when 'estimated' then p_cost_usd between 0 and 1501199875790165
      else false end
    and case when 'estimated' in (p_token_provenance, p_cost_provenance)
      then p_estimation_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
      else p_estimation_revision is null end
  ) is true
$$;

create table public.factory_evaluation_receipts (
  attempt_id uuid primary key references public.factory_evaluation_attempts(id) on delete cascade,
  workspace_id uuid not null,
  factory_id uuid not null,
  job_id uuid not null,
  session_id uuid not null,
  run_id uuid not null,
  scorer_revision_id uuid not null,
  sample_receipt_id uuid not null,
  target_commit_sha text not null check (target_commit_sha ~ '^[a-f0-9]{40}$'),
  attempt_number integer not null check (attempt_number between 1 and 6),
  attempt_outcome text not null check (attempt_outcome in ('succeeded', 'retryable_failure', 'permanent_failure', 'lease_expired', 'canceled')),
  profile_revision_id uuid,
  provider_model text,
  provider_name text,
  provider_request_id text,
  adapter_runtime text,
  worker_runtime text,
  evidence_digest text,
  status text not null check (status in ('pass', 'fail', 'inconclusive', 'skipped', 'error')),
  reason text check (reason in ('between_thresholds', 'ambiguous_evidence', 'missing_evidence', 'unsupported_evidence',
    'evidence_unavailable', 'profile_unavailable', 'invalid_output', 'provider_unavailable', 'timeout',
    'judgment_unavailable', 'lease_expired', 'canceled')),
  result jsonb,
  explanation text check (char_length(explanation) between 1 and 640 and btrim(explanation) <> ''),
  evidence_locations jsonb check (jsonb_typeof(evidence_locations) = 'array' and jsonb_array_length(evidence_locations) <= 5),
  claimed_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz not null,
  latency_ms bigint not null check (latency_ms >= 0),
  input_tokens bigint,
  output_tokens bigint,
  token_provenance text not null default 'unavailable',
  cost_usd numeric,
  cost_provenance text not null default 'unavailable',
  estimation_revision text,
  foreign key (job_id, workspace_id, factory_id)
    references public.factory_evaluation_jobs(id, workspace_id, factory_id) on delete cascade,
  check ((status in ('pass', 'fail')) = (reason is null)),
  check (claimed_at <= finished_at and (started_at is null or started_at between claimed_at and finished_at)),
  check (internal.valid_factory_evaluation_usage(input_tokens, output_tokens, token_provenance,
    cost_usd, cost_provenance, estimation_revision))
);
create index factory_evaluation_receipts_factory_time_idx
  on public.factory_evaluation_receipts(workspace_id, factory_id, finished_at desc, attempt_id desc);
create index factory_evaluation_receipts_job_time_idx
  on public.factory_evaluation_receipts(job_id, finished_at desc, attempt_id desc);
alter table public.factory_evaluation_receipts enable row level security;
revoke all on public.factory_evaluation_receipts from public, anon, authenticated, service_role;

create function internal.preserve_factory_evaluation_receipt()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.factory_evaluation_attempts attempt where attempt.id = old.attempt_id)
    or not exists (select 1 from public.factory_evaluation_jobs job where job.id = old.job_id)
  ) then return old; end if;
  raise exception 'Evaluation receipts are immutable.' using errcode = '23514';
end;
$$;
create trigger factory_evaluation_receipts_immutable before update or delete on public.factory_evaluation_receipts
  for each row execute function internal.preserve_factory_evaluation_receipt();

create function internal.valid_factory_evaluation_locations(p_result jsonb, p_locations jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare citation jsonb; reference jsonb; loc jsonb; start_value jsonb; end_value jsonb;
begin
  if p_locations is null then return true; end if;
  if p_result is null or jsonb_typeof(p_locations) is distinct from 'array'
    or octet_length(p_locations::text) > 8192 then return false; end if;
  if jsonb_array_length(p_locations) > 5 then return false; end if;

  for citation in select value from jsonb_array_elements(p_locations)
  loop
    reference := citation->'reference';
    loc := citation->'location';
    if jsonb_typeof(citation) is distinct from 'object' or citation - array['reference', 'location'] <> '{}'::jsonb
      or jsonb_typeof(reference) is distinct from 'object' or jsonb_typeof(loc) is distinct from 'object'
      or not exists (select 1 from jsonb_array_elements(p_result->'evidence') linked where linked.value = reference)
      then return false; end if;
    if loc->>'kind' = 'whole' then
      if loc - 'kind' <> '{}'::jsonb then return false; end if;
      continue;
    elsif loc->>'kind' = 'lines' and reference->>'kind' in ('code_diff', 'artifact', 'validation_report') then
      if loc - array['kind', 'startLine', 'endLine'] <> '{}'::jsonb then return false; end if;
      start_value := loc->'startLine';
      end_value := loc->'endLine';
    elsif loc->>'kind' = 'time' and reference->>'kind' = 'browser_recording' then
      if loc - array['kind', 'startMs', 'endMs'] <> '{}'::jsonb then return false; end if;
      start_value := loc->'startMs';
      end_value := loc->'endMs';
    else return false; end if;
    if jsonb_typeof(start_value) is distinct from 'number' or jsonb_typeof(end_value) is distinct from 'number'
      or start_value::text !~ '^(0|[1-9][0-9]{0,9})$' or end_value::text !~ '^(0|[1-9][0-9]{0,9})$'
      then return false; end if;
    if (start_value::text)::bigint < (case when loc->>'kind' = 'lines' then 1 else 0 end)
      or (end_value::text)::bigint > 2147483647
      or (start_value::text)::bigint > (end_value::text)::bigint
      or (loc->>'kind' = 'time' and start_value = end_value) then return false; end if;
  end loop;
  return true;
end;
$$;

-- Call with the exact terminal attempt owned by the caller's transaction.
-- Recovery and historical attempts have no accepted provider measurements.
create function internal.record_factory_evaluation_receipt(
  p_attempt public.factory_evaluation_attempts,
  p_explanation text default null, p_evidence_locations jsonb default null,
  p_input_tokens bigint default null, p_output_tokens bigint default null, p_token_provenance text default 'unavailable',
  p_cost_usd numeric default null, p_cost_provenance text default 'unavailable', p_estimation_revision text default null
) returns void language plpgsql set search_path = '' as $$
declare
  job public.factory_evaluation_jobs;
  invocation public.factory_judge_invocations;
  verdict jsonb;
  receipt_status text;
  receipt_reason text;
begin
  if p_attempt.settled_at is null then
    raise exception 'An evaluation receipt requires a terminal attempt.' using errcode = '23514';
  end if;
  select * into strict job from public.factory_evaluation_jobs target
    where (target.id, target.workspace_id, target.factory_id) = (p_attempt.job_id, p_attempt.workspace_id, p_attempt.factory_id);
  select * into invocation from public.factory_judge_invocations trace
    where (trace.attempt_id, trace.job_id, trace.workspace_id, trace.factory_id) =
      (p_attempt.id, job.id, job.workspace_id, job.factory_id);

  if p_attempt.outcome = 'canceled' then
    receipt_status := 'skipped';
    receipt_reason := 'canceled';
  elsif p_attempt.outcome = 'lease_expired' then
    receipt_status := 'error';
    receipt_reason := 'lease_expired';
  else
    verdict := invocation.candidate_result;
    receipt_status := coalesce(verdict->>'status', case
      when invocation.status in ('missing_evidence', 'unsupported_evidence') then 'inconclusive'
      else 'error' end);
    receipt_reason := case
      when receipt_status in ('pass', 'fail') then null
      else coalesce(verdict->>'reason', case when invocation.status not in ('started', 'completed')
        then invocation.status end, 'judgment_unavailable')
    end;
  end if;

  insert into public.factory_evaluation_receipts (
    attempt_id, workspace_id, factory_id, job_id, session_id, run_id, scorer_revision_id,
    sample_receipt_id, target_commit_sha, attempt_number, attempt_outcome, profile_revision_id,
    provider_model, provider_name, provider_request_id, adapter_runtime, worker_runtime, evidence_digest,
    status, reason, result, explanation, evidence_locations, claimed_at, started_at, finished_at, latency_ms,
    input_tokens, output_tokens, token_provenance, cost_usd, cost_provenance, estimation_revision
  ) values (
    p_attempt.id, job.workspace_id, job.factory_id, job.id, job.session_id, job.run_id, job.scorer_revision_id,
    job.sample_receipt_id, job.target_commit_sha, p_attempt.attempt_number, p_attempt.outcome, invocation.profile_revision_id,
    invocation.provider_model, invocation.provider_name, invocation.provider_request_id,
    invocation.adapter_runtime, invocation.worker_runtime, invocation.evidence_digest,
    receipt_status, receipt_reason, verdict, p_explanation, p_evidence_locations,
    p_attempt.claimed_at, invocation.started_at, p_attempt.settled_at,
    floor(extract(epoch from (p_attempt.settled_at - p_attempt.claimed_at)) * 1000)::bigint,
    p_input_tokens, p_output_tokens, p_token_provenance, p_cost_usd, p_cost_provenance, p_estimation_revision
  );
end;
$$;

create function internal.record_factory_evaluation_terminal_fallback()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- A normal judge completion adopts the supplied metadata in its wrapper.
  if new.outcome not in ('canceled', 'lease_expired') and exists (
    select 1 from public.factory_judge_invocations invocation
    where invocation.attempt_id = new.id and invocation.status <> 'started'
  ) then return new; end if;
  perform internal.record_factory_evaluation_receipt(new);
  return new;
end;
$$;
create trigger record_factory_evaluation_terminal_fallback after update of settled_at, outcome
  on public.factory_evaluation_attempts for each row
  when (old.settled_at is null and new.settled_at is not null)
  execute function internal.record_factory_evaluation_terminal_fallback();

alter function public.finish_factory_judge_invocation(uuid, uuid, uuid, uuid, uuid, text, jsonb, text, text, text)
  set schema internal;
alter function internal.finish_factory_judge_invocation(uuid, uuid, uuid, uuid, uuid, text, jsonb, text, text, text)
  rename to finish_factory_judge_invocation_core;
revoke all on function internal.finish_factory_judge_invocation_core(uuid, uuid, uuid, uuid, uuid, text, jsonb, text, text, text)
  from public, anon, authenticated, service_role;

create function public.finish_factory_judge_invocation(
  p_workspace_id uuid, p_factory_id uuid, p_job_id uuid, p_attempt_id uuid, p_lease_id uuid,
  p_status text, p_candidate_result jsonb default null, p_provider_model text default null,
  p_provider_name text default null, p_provider_request_id text default null,
  p_explanation text default null, p_evidence_locations jsonb default null,
  p_input_tokens bigint default null, p_output_tokens bigint default null, p_token_provenance text default 'unavailable',
  p_cost_usd numeric default null, p_cost_provenance text default 'unavailable', p_estimation_revision text default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  attempt public.factory_evaluation_attempts;
  invocation public.factory_judge_invocations;
begin
  -- The core keeps the exact job and attempt locked and validates the typed
  -- candidate. A failed receipt write rolls back its terminal transition.
  if internal.finish_factory_judge_invocation_core(p_workspace_id, p_factory_id, p_job_id, p_attempt_id, p_lease_id,
    p_status, p_candidate_result, p_provider_model, p_provider_name, p_provider_request_id) is not true then
    return false;
  end if;
  select * into strict attempt from public.factory_evaluation_attempts settled
    where (settled.workspace_id, settled.factory_id, settled.job_id, settled.id, settled.lease_id) =
      (p_workspace_id, p_factory_id, p_job_id, p_attempt_id, p_lease_id);
  select * into strict invocation from public.factory_judge_invocations trace where trace.attempt_id = attempt.id;
  if not internal.valid_factory_evaluation_usage(p_input_tokens, p_output_tokens, p_token_provenance,
      p_cost_usd, p_cost_provenance, p_estimation_revision)
    or (invocation.started_at is null and (p_token_provenance <> 'unavailable' or p_cost_provenance <> 'unavailable'))
    or (p_status <> 'completed' and (p_explanation is not null or p_evidence_locations is not null))
    or (p_explanation is not null and (char_length(p_explanation) not between 1 and 640 or btrim(p_explanation) = ''))
    or not internal.valid_factory_evaluation_locations(invocation.candidate_result, p_evidence_locations) then
    raise exception 'Invalid evaluation receipt metadata.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_evidence_locations) citation
    where citation#>>'{location,kind}' = 'time' and not exists (
      select 1 from public.session_browser_verification_assets asset
      join public.factory_evaluation_jobs target on (target.workspace_id, target.session_id, target.run_id) =
        (asset.workspace_id, asset.session_id, asset.run_id)
      where target.id = attempt.job_id and asset.id::text = citation#>>'{reference,id}'
        and asset.content_type = 'video/webm'
        and asset.duration_ms >= (citation#>>'{location,endMs}')::bigint
    )
  ) then raise exception 'Invalid evaluation evidence location.' using errcode = '22023'; end if;
  perform internal.record_factory_evaluation_receipt(attempt, p_explanation, p_evidence_locations,
    p_input_tokens, p_output_tokens, p_token_provenance, p_cost_usd, p_cost_provenance, p_estimation_revision);
  return true;
end;
$$;

-- The queue-only settlement path remains available for attempts that never
-- used the judge. A judge permit requires the exact receipt adoption path.
create or replace function public.settle_factory_evaluation_attempt(
  p_workspace_id uuid, p_factory_id uuid, p_job_id uuid, p_attempt_id uuid, p_lease_id uuid, p_outcome text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare job public.factory_evaluation_jobs; attempt public.factory_evaluation_attempts;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_outcome is null or p_outcome not in ('succeeded', 'retryable_failure', 'permanent_failure') then
    raise exception 'Invalid evaluation attempt outcome.' using errcode = '22023';
  end if;
  attempt := internal.lock_factory_evaluation_claim(p_workspace_id, p_factory_id, p_job_id, p_attempt_id, p_lease_id);
  if attempt.id is null or exists (
    select 1 from public.factory_judge_invocations invocation where invocation.attempt_id = attempt.id
  ) then return false; end if;
  select * into strict job from public.factory_evaluation_jobs target where target.id = attempt.job_id;
  perform internal.settle_locked_factory_evaluation_attempt(job, attempt, p_outcome);
  return true;
end;
$$;

-- A profile could already have run between the two feature deployments. Keep
-- its evidence and verdict, and leave any measurement we never stored unknown.
do $$
declare attempt public.factory_evaluation_attempts;
begin
  for attempt in select * from public.factory_evaluation_attempts where settled_at is not null loop
    perform internal.record_factory_evaluation_receipt(attempt);
  end loop;
end;
$$;

-- The service supplies the signed-in actor. Mirror the current
-- can_access_factory/can_access_session human read policy without inheriting the
-- service-role bypass of those RLS helpers.
create function internal.can_read_factory_evaluation_receipts(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid
) returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.workspaces workspace
    join public.factories factory on (factory.workspace_id, factory.id) = (workspace.id, p_factory_id)
    join public.workspace_members member on (member.workspace_id, member.user_id) = (workspace.id, p_actor_user_id)
    where workspace.id = p_workspace_id and workspace.deletion_requested_at is null
      and member.kind = 'human' and member.is_active and (
        member.role in ('owner', 'admin') or exists (
          select 1 from public.factory_members membership
          where (membership.workspace_id, membership.factory_id, membership.member_id) =
            (workspace.id, factory.id, member.id) and membership.revoked_at is null
        )
      )
  )
$$;

create function internal.factory_evaluation_receipt_evidence_availability(p_receipt public.factory_evaluation_receipts)
returns text language plpgsql stable set search_path = '' as $$
declare ref jsonb; kind text; evidence_id uuid; available boolean := true;
begin
  if exists (
    select 1 from public.session_retained_content_erasures erasure
    where (erasure.workspace_id, erasure.factory_id, erasure.session_id) =
      (p_receipt.workspace_id, p_receipt.factory_id, p_receipt.session_id)
  ) then return 'withheld'; end if;
  if p_receipt.result is null or jsonb_array_length(p_receipt.result->'evidence') = 0 then return 'unavailable'; end if;

  for ref in select value from jsonb_array_elements(p_receipt.result->'evidence')
  loop
    kind := ref->>'kind';
    evidence_id := (ref->>'id')::uuid;
    case kind
      when 'artifact' then
        if not exists (
          select 1 from public.session_artifacts artifact
          join public.session_git_checkpoints checkpoint
            on (checkpoint.workspace_id, checkpoint.session_id, checkpoint.artifact_id) =
              (artifact.workspace_id, artifact.session_id, artifact.id)
          where (artifact.workspace_id, artifact.session_id, artifact.id, checkpoint.run_id, checkpoint.output_sha) =
            (p_receipt.workspace_id, p_receipt.session_id, evidence_id, p_receipt.run_id, p_receipt.target_commit_sha)
            and jsonb_typeof(artifact.artifact_json) = 'string' and octet_length(artifact.artifact_json #>> '{}') > 0
        ) then available := false; end if;
      when 'code_diff' then
        if not exists (
          select 1 from public.session_git_checkpoints checkpoint
          where (checkpoint.workspace_id, checkpoint.session_id, checkpoint.run_id, checkpoint.output_sha) =
            (p_receipt.workspace_id, p_receipt.session_id, p_receipt.run_id, p_receipt.target_commit_sha)
            and checkpoint.run_id = evidence_id and (checkpoint.input_sha = checkpoint.output_sha or exists (
              select 1 from public.github_repositories repository
              join public.github_installations installation on (installation.workspace_id, installation.id) =
                (repository.workspace_id, repository.github_installation_id)
              where (repository.workspace_id, repository.factory_id, repository.id) =
                (p_receipt.workspace_id, p_receipt.factory_id, checkpoint.repository_id)
                and not repository.is_archived and not installation.suspended
            ))
        ) then available := false; end if;
      when 'validation_report' then
        if exists (select 1 from public.session_validation_asset_withholdings withheld where withheld.asset_id = evidence_id)
          then return 'withheld'; end if;
        if not exists (
          select 1 from public.session_validation_assets asset
          join storage.objects object on object.bucket_id = 'session-validation-evidence' and object.name = asset.storage_path
          where (asset.workspace_id, asset.session_id, asset.run_id, asset.id) =
            (p_receipt.workspace_id, p_receipt.session_id, p_receipt.run_id, evidence_id) and asset.kind = 'report'
            and object.metadata->>'size' = asset.size_bytes::text and object.metadata->>'mimetype' = asset.content_type
        ) then available := false; end if;
      when 'browser_screenshot', 'browser_recording' then
        if exists (select 1 from public.session_browser_asset_withholdings withheld where withheld.asset_id = evidence_id)
          then return 'withheld'; end if;
        if not exists (
          select 1 from public.session_browser_verification_assets asset
          join storage.objects object on object.bucket_id = 'session-validation-evidence' and object.name = asset.storage_path
          where (asset.workspace_id, asset.session_id, asset.run_id, asset.id) =
            (p_receipt.workspace_id, p_receipt.session_id, p_receipt.run_id, evidence_id)
            and asset.content_type = (case when kind = 'browser_screenshot' then 'image/png' else 'video/webm' end)
            and object.metadata->>'size' = asset.size_bytes::text and object.metadata->>'mimetype' = asset.content_type
        ) then available := false; end if;
      else
        available := false;
    end case;
  end loop;
  return case when available then 'available' else 'unavailable' end;
end;
$$;

create function internal.project_factory_evaluation_receipt(p_receipt public.factory_evaluation_receipts)
returns jsonb language plpgsql stable set search_path = '' as $$
declare availability text := internal.factory_evaluation_receipt_evidence_availability(p_receipt);
begin
  return to_jsonb(p_receipt) || jsonb_build_object(
    'evidence_availability', availability,
    'score', p_receipt.result->'score',
    'result', case when availability = 'available' then p_receipt.result end,
    'explanation', case when availability = 'available' then p_receipt.explanation end,
    'evidence_locations', case when availability = 'available' then p_receipt.evidence_locations end,
    'evidence_digest', case when availability = 'available' then p_receipt.evidence_digest end
  );
end;
$$;

create function public.list_factory_evaluation_receipts(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_job_id uuid default null, p_limit integer default 25,
  p_before_finished_at timestamptz default null, p_before_attempt_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; usage jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if not internal.can_read_factory_evaluation_receipts(p_workspace_id, p_factory_id, p_actor_user_id) then
    raise exception 'Evaluation factory is unavailable.' using errcode = 'P0002';
  end if;
  if p_limit is null or p_limit not between 1 and 100
    or (p_before_finished_at is null) <> (p_before_attempt_id is null)
    or not isfinite(p_before_finished_at) then
    raise exception 'Invalid evaluation receipt page.' using errcode = '22023';
  end if;

  -- An exact job has at most six attempts. Include its full visible aggregate
  -- independently of the page cursor, preserving unknown totals per axis.
  if p_job_id is not null then
    select jsonb_build_object(
      'attempt_count', count(*),
      'input_tokens', case when bool_and(receipt.token_provenance <> 'unavailable') then sum(receipt.input_tokens) end,
      'output_tokens', case when bool_and(receipt.token_provenance <> 'unavailable') then sum(receipt.output_tokens) end,
      'token_unavailable_count', count(*) filter (where receipt.token_provenance = 'unavailable'),
      'token_estimated_count', count(*) filter (where receipt.token_provenance = 'estimated'),
      'cost_usd', case when bool_and(receipt.cost_provenance <> 'unavailable') then sum(receipt.cost_usd) end,
      'cost_unavailable_count', count(*) filter (where receipt.cost_provenance = 'unavailable'),
      'cost_estimated_count', count(*) filter (where receipt.cost_provenance = 'estimated')
    ) into usage
    from public.factory_evaluation_receipts receipt
    join public.agent_runs run on (run.workspace_id, run.session_id, run.id) =
      (receipt.workspace_id, receipt.session_id, receipt.run_id)
    join public.sessions owner on (owner.workspace_id, owner.factory_id, owner.id) =
      (receipt.workspace_id, receipt.factory_id, run.session_id)
    where (receipt.workspace_id, receipt.factory_id, receipt.job_id) = (p_workspace_id, p_factory_id, p_job_id);
  end if;

  with page as materialized (
    select receipt as item, receipt.finished_at, receipt.attempt_id
    from public.factory_evaluation_receipts receipt
    join public.agent_runs run on (run.workspace_id, run.session_id, run.id) =
      (receipt.workspace_id, receipt.session_id, receipt.run_id)
    join public.sessions owner on (owner.workspace_id, owner.factory_id, owner.id) =
      (receipt.workspace_id, receipt.factory_id, run.session_id)
    where (receipt.workspace_id, receipt.factory_id) = (p_workspace_id, p_factory_id)
      and (p_job_id is null or receipt.job_id = p_job_id)
      and (p_before_finished_at is null or (receipt.finished_at, receipt.attempt_id) < (p_before_finished_at, p_before_attempt_id))
    order by receipt.finished_at desc, receipt.attempt_id desc limit p_limit + 1
  ), visible as materialized (
    select * from page order by finished_at desc, attempt_id desc limit p_limit
  ), boundary as (
    select visible.finished_at, visible.attempt_id from visible
    where (select count(*) from page) > p_limit
    order by visible.finished_at, visible.attempt_id limit 1
  )
  select jsonb_build_object(
    'receipts', coalesce((select jsonb_agg(internal.project_factory_evaluation_receipt(item)
      order by finished_at desc, attempt_id desc) from visible), '[]'),
    'usage', usage,
    'next_finished_at', (select finished_at from boundary),
    'next_attempt_id', (select attempt_id from boundary)
  ) into result;
  return result;
end;
$$;

revoke all on function internal.valid_factory_evaluation_usage(bigint, bigint, text, numeric, text, text),
  internal.valid_factory_evaluation_locations(jsonb, jsonb), internal.preserve_factory_evaluation_receipt(),
  internal.record_factory_evaluation_receipt(public.factory_evaluation_attempts, text, jsonb, bigint, bigint, text, numeric, text, text),
  internal.record_factory_evaluation_terminal_fallback(),
  internal.can_read_factory_evaluation_receipts(uuid, uuid, uuid),
  internal.factory_evaluation_receipt_evidence_availability(public.factory_evaluation_receipts),
  internal.project_factory_evaluation_receipt(public.factory_evaluation_receipts),
  public.finish_factory_judge_invocation(uuid, uuid, uuid, uuid, uuid, text, jsonb, text, text, text, text, jsonb,
    bigint, bigint, text, numeric, text, text),
  public.list_factory_evaluation_receipts(uuid, uuid, uuid, uuid, integer, timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_factory_judge_invocation(uuid, uuid, uuid, uuid, uuid, text, jsonb, text, text, text, text,
    jsonb, bigint, bigint, text, numeric, text, text),
  public.list_factory_evaluation_receipts(uuid, uuid, uuid, uuid, integer, timestamptz, uuid) to service_role;
