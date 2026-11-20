-- An evaluator has a dedicated credential outside the production secret and
-- delegation tables. Only its current, explicitly approved revision can send.
create table public.factory_judge_profile_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  revision integer not null check (revision > 0),
  enabled boolean not null,
  provider text not null default 'openrouter' check (provider = 'openrouter'),
  model_id text not null check (octet_length(model_id) <= 160 and model_id not like 'openrouter/%'
    and model_id ~ '^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$'),
  provider_route text not null check (octet_length(provider_route) <= 120
    and provider_route ~ '^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)?$'),
  allow_images boolean not null,
  allow_video boolean not null,
  approved_by_member_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, revision),
  unique (workspace_id, id)
);

create table internal.factory_judge_credential_heads (
  workspace_id uuid primary key,
  profile_revision_id uuid not null,
  encrypted_api_key text not null check (octet_length(encrypted_api_key) <= 6045 and encrypted_api_key ~ '^v2[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$'),
  foreign key (workspace_id, profile_revision_id)
    references public.factory_judge_profile_revisions(workspace_id, id) on delete cascade
);

create table public.factory_judge_invocations (
  attempt_id uuid primary key references public.factory_evaluation_attempts(id) on delete cascade,
  workspace_id uuid not null,
  factory_id uuid not null,
  job_id uuid not null,
  profile_revision_id uuid,
  adapter_runtime text not null default 'openrouter-chat-v1' check (adapter_runtime = 'openrouter-chat-v1'),
  worker_runtime text check (worker_runtime in ('node', 'workerd')),
  evidence_digest text check (evidence_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('started', 'completed', 'missing_evidence', 'unsupported_evidence',
    'evidence_unavailable', 'profile_unavailable', 'invalid_output', 'provider_unavailable', 'timeout',
    'canceled', 'lease_expired')),
  provider_model text check (provider_model ~ '^[A-Za-z0-9._/:-]{1,160}$'),
  provider_name text check (provider_name ~ '^[A-Za-z0-9 ._()/:-]{1,120}$'),
  provider_request_id text check (provider_request_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  candidate_result jsonb check (jsonb_typeof(candidate_result) = 'object' and octet_length(candidate_result::text) <= 8192),
  started_at timestamptz,
  finished_at timestamptz,
  foreign key (job_id, workspace_id, factory_id)
    references public.factory_evaluation_jobs(id, workspace_id, factory_id) on delete cascade,
  foreign key (workspace_id, profile_revision_id)
    references public.factory_judge_profile_revisions(workspace_id, id) on delete cascade,
  check ((status = 'started') = (finished_at is null)),
  check ((started_at is null) = (evidence_digest is null)),
  check ((started_at is null) = (profile_revision_id is null)),
  check ((started_at is null) = (worker_runtime is null)),
  check (started_at is null or finished_at is null or finished_at >= started_at)
);
create index factory_judge_invocations_job_idx on public.factory_judge_invocations(job_id);
create index factory_judge_invocations_profile_idx on public.factory_judge_invocations(workspace_id, profile_revision_id)
  where profile_revision_id is not null;

alter table public.factory_judge_profile_revisions enable row level security;
alter table internal.factory_judge_credential_heads enable row level security;
alter table public.factory_judge_invocations enable row level security;
revoke all on public.factory_judge_profile_revisions, internal.factory_judge_credential_heads, public.factory_judge_invocations
  from public, anon, authenticated, service_role;
grant select on public.factory_judge_profile_revisions, public.factory_judge_invocations to service_role;

create function internal.preserve_factory_judge_profile_revision()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.workspaces workspace where workspace.id = old.workspace_id)
    then return old; end if;
  raise exception 'Judge profile revisions are immutable.' using errcode = '23514';
end;
$$;
create trigger factory_judge_profiles_immutable before update or delete on public.factory_judge_profile_revisions
  for each row execute function internal.preserve_factory_judge_profile_revision();

create function internal.preserve_factory_judge_invocation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.factory_evaluation_attempts attempt where attempt.id = old.attempt_id)
      or not exists (select 1 from public.factory_evaluation_jobs job where job.id = old.job_id)
      or not exists (select 1 from public.workspaces workspace where workspace.id = old.workspace_id) then return old; end if;
  elsif old.status = 'started' and new.finished_at is not null
    and (new.attempt_id, new.workspace_id, new.factory_id, new.job_id, new.profile_revision_id,
      new.adapter_runtime, new.worker_runtime, new.evidence_digest, new.started_at) is not distinct from
      (old.attempt_id, old.workspace_id, old.factory_id, old.job_id, old.profile_revision_id,
        old.adapter_runtime, old.worker_runtime, old.evidence_digest, old.started_at) then
    return new;
  end if;
  raise exception 'Judge invocation identity and finished history are immutable.' using errcode = '23514';
end;
$$;
create trigger factory_judge_invocations_immutable before update or delete on public.factory_judge_invocations
  for each row execute function internal.preserve_factory_judge_invocation();

-- The evaluation queue owns cancellation and lease expiry. Close an issued
-- permit in the same transaction without changing its pinned invocation data.
create function internal.close_factory_judge_invocation_on_attempt_settlement()
returns trigger language plpgsql set search_path = '' as $$
begin
  update public.factory_judge_invocations invocation set status = new.outcome, finished_at = new.settled_at
    where (invocation.attempt_id, invocation.workspace_id, invocation.factory_id, invocation.job_id) =
      (new.id, new.workspace_id, new.factory_id, new.job_id) and invocation.status = 'started';
  return new;
end;
$$;
create trigger close_factory_judge_invocation_on_attempt_settlement after update of settled_at, outcome
  on public.factory_evaluation_attempts for each row
  when (old.settled_at is null and new.settled_at is not null and new.outcome in ('canceled', 'lease_expired'))
  execute function internal.close_factory_judge_invocation_on_attempt_settlement();

create function public.get_factory_judge_profile(p_workspace_id uuid, p_actor_user_id uuid)
returns public.factory_judge_profile_revisions language plpgsql security definer set search_path = '' as $$
declare result public.factory_judge_profile_revisions;
begin
  perform internal.assert_factory_evaluation_workspace_manager(p_workspace_id, p_actor_user_id);
  select * into result from public.factory_judge_profile_revisions profile
    where profile.workspace_id = p_workspace_id order by profile.revision desc limit 1;
  if not found then return null; end if;
  return result;
end;
$$;

-- A shared lane row serializes configuration and the pre-send permit,
-- independently of the production session and its queue.
create function internal.editable_factory_judge_profile(
  p_workspace_id uuid, p_expected_revision integer
) returns public.factory_judge_profile_revisions language plpgsql set search_path = '' as $$
declare profile public.factory_judge_profile_revisions;
begin
  insert into public.factory_evaluation_lanes(workspace_id)
    values (p_workspace_id) on conflict (workspace_id) do nothing;
  perform 1 from public.factory_evaluation_lanes lane where lane.workspace_id = p_workspace_id for no key update;
  select * into profile from public.factory_judge_profile_revisions revision
    where revision.workspace_id = p_workspace_id order by revision.revision desc limit 1;
  if p_expected_revision is distinct from coalesce(profile.revision, 0) then
    raise exception 'The judge profile changed. Reload before saving.' using errcode = 'PT409';
  end if;
  return profile;
end;
$$;

create function public.configure_factory_judge_profile(
  p_workspace_id uuid, p_actor_user_id uuid, p_expected_revision integer,
  p_model_id text, p_provider_route text, p_allow_images boolean, p_allow_video boolean,
  p_encrypted_api_key text default null
) returns public.factory_judge_profile_revisions language plpgsql security definer set search_path = '' as $$
declare actor_id uuid; previous public.factory_judge_profile_revisions; result public.factory_judge_profile_revisions; cipher text;
begin
  actor_id := internal.assert_factory_evaluation_workspace_manager(p_workspace_id, p_actor_user_id);
  if p_expected_revision is null or p_expected_revision < 0
    or p_model_id is null or octet_length(p_model_id) > 160 or p_model_id like 'openrouter/%'
    or p_model_id !~ '^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$'
    or p_provider_route is null or octet_length(p_provider_route) > 120
    or p_provider_route !~ '^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)?$'
    or p_allow_images is null or p_allow_video is null
    or octet_length(p_encrypted_api_key) > 6045
    or p_encrypted_api_key !~ '^v2[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$' then
    raise exception 'Invalid judge profile.' using errcode = '22023';
  end if;
  previous := internal.editable_factory_judge_profile(p_workspace_id, p_expected_revision);
  cipher := p_encrypted_api_key;
  if cipher is null then
    select head.encrypted_api_key into cipher from internal.factory_judge_credential_heads head
      where (head.workspace_id, head.profile_revision_id) = (p_workspace_id, previous.id);
    if cipher is null then raise exception 'A dedicated judge credential is required.' using errcode = '22023'; end if;
  end if;
  insert into public.factory_judge_profile_revisions(
    workspace_id, revision, enabled, model_id, provider_route, allow_images, allow_video, approved_by_member_id
  ) values (p_workspace_id, p_expected_revision + 1, true, p_model_id, p_provider_route, p_allow_images, p_allow_video, actor_id)
  returning * into result;
  insert into internal.factory_judge_credential_heads(workspace_id, profile_revision_id, encrypted_api_key)
    values (p_workspace_id, result.id, cipher)
    on conflict (workspace_id) do update set profile_revision_id = excluded.profile_revision_id,
      encrypted_api_key = excluded.encrypted_api_key;
  return result;
end;
$$;

create function public.revoke_factory_judge_profile(
  p_workspace_id uuid, p_actor_user_id uuid, p_expected_revision integer
) returns public.factory_judge_profile_revisions language plpgsql security definer set search_path = '' as $$
declare actor_id uuid; previous public.factory_judge_profile_revisions; result public.factory_judge_profile_revisions;
begin
  actor_id := internal.assert_factory_evaluation_workspace_manager(p_workspace_id, p_actor_user_id);
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Invalid judge profile revision.' using errcode = '22023';
  end if;
  previous := internal.editable_factory_judge_profile(p_workspace_id, p_expected_revision);
  if previous.id is null then raise exception 'Judge profile is unavailable.' using errcode = 'P0002'; end if;
  if not previous.enabled then return previous; end if;
  insert into public.factory_judge_profile_revisions(
    workspace_id, revision, enabled, model_id, provider_route, allow_images, allow_video, approved_by_member_id
  ) values (p_workspace_id, p_expected_revision + 1, false, previous.model_id, previous.provider_route,
    previous.allow_images, previous.allow_video, actor_id)
  returning * into result;
  delete from internal.factory_judge_credential_heads head where head.workspace_id = p_workspace_id;
  return result;
end;
$$;

create function internal.claim_factory_evaluation_job(p_require_profile boolean)
returns table (
  job_id uuid, workspace_id uuid, factory_id uuid, session_id uuid, run_id uuid, scorer_revision_id uuid,
  sample_receipt_id uuid, target_commit_sha text, attempt_id uuid, attempt_number integer,
  lease_id uuid, lease_expires_at timestamptz
) language plpgsql set search_path = '' as $$
declare
  candidate record;
  job public.factory_evaluation_jobs;
  attempt public.factory_evaluation_attempts;
  capacity integer;
  checked_at timestamptz;
begin
  perform internal.assert_checkpoint_publication_service();
  for candidate in
    select ready.id, lane.workspace_id, ready.factory_id
    from public.factory_evaluation_lanes lane
    join public.workspaces workspace on workspace.id = lane.workspace_id and workspace.deletion_requested_at is null
    cross join lateral (
      select queued.id, queued.factory_id, queued.available_at
      from public.factory_evaluation_jobs queued
      join public.factories factory on (factory.workspace_id, factory.id) = (queued.workspace_id, queued.factory_id)
        and factory.status = 'active'
      where queued.workspace_id = lane.workspace_id and queued.status = 'queued' and queued.available_at <= statement_timestamp()
      order by queued.available_at, queued.id limit 1
    ) ready
    where not lane.paused
      and (not p_require_profile or exists (
        select 1 from internal.factory_judge_credential_heads head
        join public.factory_judge_profile_revisions profile
          on (profile.workspace_id, profile.id) = (head.workspace_id, head.profile_revision_id) and profile.enabled
        where head.workspace_id = lane.workspace_id
      ))
      and not exists (
      select 1 from public.factory_evaluation_attempts live
      where live.workspace_id = lane.workspace_id and live.settled_at is null and live.lease_expires_at > statement_timestamp()
      order by live.lease_expires_at desc offset (lane.max_concurrent - 1) limit 1
    )
    order by ready.available_at, ready.id limit 25
  loop
    -- Serialize with lifecycle changes, then take the separate capacity mutex
    -- before the job. This path never locks the production session, job or run.
    perform 1 from public.workspaces workspace
      where workspace.id = candidate.workspace_id and workspace.deletion_requested_at is null for share skip locked;
    if not found then continue; end if;
    perform 1 from public.factories factory
      where (factory.workspace_id, factory.id) = (candidate.workspace_id, candidate.factory_id)
        and factory.status = 'active' for share skip locked;
    if not found then continue; end if;
    select lane.max_concurrent into capacity from public.factory_evaluation_lanes lane
      where lane.workspace_id = candidate.workspace_id and not lane.paused for no key update skip locked;
    if not found then continue; end if;

    if p_require_profile and not exists (
      select 1 from internal.factory_judge_credential_heads head
      join public.factory_judge_profile_revisions profile
        on (profile.workspace_id, profile.id) = (head.workspace_id, head.profile_revision_id) and profile.enabled
      where head.workspace_id = candidate.workspace_id
    ) then continue; end if;

    select * into job from public.factory_evaluation_jobs current_job
      where current_job.id = candidate.id and current_job.status = 'queued' and current_job.available_at <= clock_timestamp()
      for update skip locked;
    if not found then continue; end if;
    checked_at := clock_timestamp();
    if exists (
      select 1 from public.factory_evaluation_attempts live
      where live.workspace_id = candidate.workspace_id and live.settled_at is null and live.lease_expires_at > checked_at
      order by live.lease_expires_at desc offset (capacity - 1) limit 1
    ) then continue; end if;

    update public.factory_evaluation_jobs current_job
      set status = 'claimed', attempt_count = job.attempt_count + 1, available_at = null
      where current_job.id = job.id returning * into job;
    insert into public.factory_evaluation_attempts(
      job_id, workspace_id, factory_id, attempt_number, claimed_at, lease_expires_at
    ) values (job.id, job.workspace_id, job.factory_id, job.attempt_count, checked_at, checked_at + interval '90 seconds')
    returning * into attempt;
    return query select job.id, job.workspace_id, job.factory_id, job.session_id, job.run_id,
      job.scorer_revision_id, job.sample_receipt_id, job.target_commit_sha, attempt.id, attempt.attempt_number,
      attempt.lease_id, attempt.lease_expires_at;
    return;
  end loop;
end;
$$;

create or replace function public.claim_factory_evaluation_job()
returns table (
  job_id uuid, workspace_id uuid, factory_id uuid, session_id uuid, run_id uuid, scorer_revision_id uuid,
  sample_receipt_id uuid, target_commit_sha text, attempt_id uuid, attempt_number integer,
  lease_id uuid, lease_expires_at timestamptz
) language sql security definer set search_path = '' as $$
  select * from internal.claim_factory_evaluation_job(false)
$$;

create function public.claim_factory_judge_job()
returns table (
  job_id uuid, workspace_id uuid, factory_id uuid, session_id uuid, run_id uuid, scorer_revision_id uuid,
  sample_receipt_id uuid, target_commit_sha text, attempt_id uuid, attempt_number integer,
  lease_id uuid, lease_expires_at timestamptz
) language sql security definer set search_path = '' as $$
  select * from internal.claim_factory_evaluation_job(true)
$$;

-- The sampling receipt already proved immutable run/source/plan lineage. This
-- plan rechecks the exact selected references and their current availability.
create function internal.factory_judge_invocation_plan(
  p_workspace_id uuid, p_factory_id uuid, p_job_id uuid, p_attempt_id uuid, p_lease_id uuid,
  p_include_content boolean
) returns jsonb language plpgsql set search_path = '' as $$
declare
  factory_status text;
  attempt public.factory_evaluation_attempts;
  job public.factory_evaluation_jobs;
  sample public.factory_scorer_sample_receipts;
  profile public.factory_judge_profile_revisions;
  checkpoint public.session_git_checkpoints;
  admission public.session_factory_admission_inputs;
  definition jsonb;
  ref jsonb;
  kind text;
  evidence_id uuid;
  descriptor jsonb;
  artifact_bytes integer;
  evidence jsonb := '[]';
  missing text[] := '{}';
  unsupported text[] := '{}';
begin
  -- Serialize the permit with workspace erasure and profile edits. Keep the
  -- same scope -> lane -> job -> attempt order as evaluation claims.
  perform 1 from public.workspaces workspace
    where workspace.id = p_workspace_id and workspace.deletion_requested_at is null for share;
  if not found then return jsonb_build_object('status', 'stale_claim'); end if;
  select factory.status into factory_status from public.factories factory
    where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id) for share;
  if not found then return jsonb_build_object('status', 'stale_claim'); end if;
  perform 1 from public.factory_evaluation_lanes lane where lane.workspace_id = p_workspace_id for share;
  if not found then return jsonb_build_object('status', 'stale_claim'); end if;
  attempt := internal.lock_factory_evaluation_claim(p_workspace_id, p_factory_id, p_job_id, p_attempt_id, p_lease_id);
  if attempt.id is null then return jsonb_build_object('status', 'stale_claim'); end if;
  if exists (select 1 from public.factory_judge_invocations invocation where invocation.attempt_id = attempt.id) then
    return jsonb_build_object('status', 'already_started');
  end if;
  if factory_status <> 'active' then return jsonb_build_object('status', 'profile_unavailable'); end if;

  select approved.* into profile from internal.factory_judge_credential_heads head
    join public.factory_judge_profile_revisions approved on (approved.workspace_id, approved.id) =
      (head.workspace_id, head.profile_revision_id)
    where head.workspace_id = p_workspace_id and approved.enabled;
  if not found then return jsonb_build_object('status', 'profile_unavailable'); end if;

  select * into strict job from public.factory_evaluation_jobs target where target.id = attempt.job_id;
  select * into strict sample from public.factory_scorer_sample_receipts receipt
    where (receipt.id, receipt.workspace_id, receipt.factory_id, receipt.session_id, receipt.run_id,
      receipt.scorer_revision_id, receipt.target_commit_sha) =
      (job.sample_receipt_id, p_workspace_id, p_factory_id, job.session_id, job.run_id,
        job.scorer_revision_id, job.target_commit_sha) and receipt.outcome = 'sampled';
  select scorer.definition into strict definition from public.factory_scorer_revisions scorer
    where (scorer.workspace_id, scorer.factory_id, scorer.id) = (p_workspace_id, p_factory_id, job.scorer_revision_id);
  select array(select jsonb_array_elements_text(definition->'requiredEvidence')) into missing
    where exists (
      select 1 from public.session_retained_content_erasures erasure
      where (erasure.workspace_id, erasure.factory_id, erasure.session_id) = (p_workspace_id, p_factory_id, job.session_id)
    );
  if found then return jsonb_build_object('status', 'missing_evidence', 'missing_evidence', missing); end if;
  missing := '{}';

  select exact.* into checkpoint from public.session_git_checkpoints exact
  where (exact.run_id, exact.workspace_id, exact.session_id, exact.attempt_count, exact.output_sha) =
    (job.run_id, p_workspace_id, job.session_id, sample.attempt_count, job.target_commit_sha);
  if not found then
    return jsonb_build_object('status', 'missing_evidence', 'missing_evidence', definition->'requiredEvidence');
  end if;

  -- For a service-admitted source, a pinned authorizing grant must still
  -- match its live version when the judge would expose evidence externally.
  select * into admission from public.session_factory_admission_inputs input
    where (input.workspace_id, input.factory_id, input.session_id, input.definition_revision_id) =
      (p_workspace_id, p_factory_id, job.session_id, sample.definition_revision_id);
  if admission.execution_grant_id is not null then
    begin
      perform internal.require_current_factory_execution_grant(p_workspace_id, p_factory_id,
        admission.execution_grant_id, admission.execution_grant_version, checkpoint.repository_id,
        '{}'::uuid[], '{}'::text[], admission.execution_policy_revision_id);
    exception when insufficient_privilege then
      return jsonb_build_object('status', 'missing_evidence', 'missing_evidence', definition->'requiredEvidence');
    end;
  end if;

  for ref in select value from jsonb_array_elements(sample.evidence)
  loop
    kind := ref->>'kind';
    evidence_id := (ref->>'id')::uuid;
    descriptor := null;
    if (kind = 'browser_screenshot' and not profile.allow_images) or (kind = 'browser_recording' and not profile.allow_video) then
      unsupported := array_append(unsupported, kind);
      continue;
    end if;

    case kind
      when 'code_diff' then
        if evidence_id = checkpoint.run_id then
          if checkpoint.input_sha = checkpoint.output_sha then
            descriptor := jsonb_build_object('input_sha', checkpoint.input_sha, 'output_sha', checkpoint.output_sha,
              'repository_id', checkpoint.repository_id, 'repository_full_name', checkpoint.repository_full_name,
              'github_repository_id', null, 'installation_id', null);
          else
            begin
              select jsonb_build_object('input_sha', checkpoint.input_sha, 'output_sha', checkpoint.output_sha,
                'repository_id', repository.id, 'repository_full_name', repository.full_name,
                'github_repository_id', repository.repo_id, 'installation_id', installation.installation_id)
              into descriptor
              from public.github_repositories repository
              join public.github_installations installation on (installation.workspace_id, installation.id) =
                (repository.workspace_id, repository.github_installation_id) and not installation.suspended
              where (repository.workspace_id, repository.factory_id, repository.id) = (p_workspace_id, p_factory_id, checkpoint.repository_id)
                and not repository.is_archived and repository.repo_id between 1 and 9007199254740991
                and installation.installation_id between 1 and 9007199254740991
              for share of repository, installation nowait;
            exception when lock_not_available then
              return jsonb_build_object('status', 'evidence_unavailable');
            end;
          end if;
        end if;
      when 'artifact' then
        select jsonb_build_object('content_md', case when p_include_content and octet_length(artifact.artifact_json #>> '{}') <= 98304
          then artifact.artifact_json #>> '{}' end), octet_length(artifact.artifact_json #>> '{}')
        into descriptor, artifact_bytes from public.session_artifacts artifact
        where (artifact.workspace_id, artifact.session_id, artifact.id) = (p_workspace_id, job.session_id, evidence_id)
          and artifact.id = checkpoint.artifact_id and jsonb_typeof(artifact.artifact_json) = 'string'
          and octet_length(artifact.artifact_json #>> '{}') > 0;
        if artifact_bytes > 98304 then
          unsupported := array_append(unsupported, kind);
          continue;
        end if;
      when 'validation_report' then
        select jsonb_build_object('workspace_id', asset.workspace_id, 'session_id', asset.session_id,
          'run_id', asset.run_id, 'storage_path', asset.storage_path, 'sha256', asset.sha256,
          'content_type', asset.content_type, 'size_bytes', asset.size_bytes)
        into descriptor from public.session_validation_assets asset
        where (asset.workspace_id, asset.session_id, asset.run_id, asset.id) = (p_workspace_id, job.session_id, job.run_id, evidence_id)
          and asset.kind = 'report' and not exists (
            select 1 from public.session_validation_asset_withholdings withheld where withheld.asset_id = asset.id
          );
      when 'browser_screenshot', 'browser_recording' then
        select jsonb_build_object('workspace_id', asset.workspace_id, 'session_id', asset.session_id,
          'run_id', asset.run_id, 'storage_path', asset.storage_path, 'sha256', asset.sha256,
          'content_type', asset.content_type, 'size_bytes', asset.size_bytes)
          || case when kind = 'browser_recording' then
            jsonb_build_object('duration_ms', asset.duration_ms, 'width_px', asset.width_px, 'height_px', asset.height_px,
              'frame_offsets_ms', asset.frame_offsets_ms, 'capture_started_at', asset.capture_started_at,
              'capture_completed_at', asset.capture_completed_at)
          else '{}' end
        into descriptor from public.session_browser_verification_assets asset
        where (asset.workspace_id, asset.session_id, asset.run_id, asset.id) = (p_workspace_id, job.session_id, job.run_id, evidence_id)
          and asset.content_type = (case when kind = 'browser_screenshot' then 'image/png' else 'video/webm' end)
          and not exists (select 1 from public.session_browser_asset_withholdings withheld where withheld.asset_id = asset.id);
      else
        raise exception 'An evaluation sample has an invalid evidence kind.' using errcode = '23514';
    end case;
    if descriptor is null then
      missing := array_append(missing, kind);
    else
      evidence := evidence || jsonb_build_array(ref || descriptor);
    end if;
  end loop;
  if cardinality(missing) > 0 then
    return jsonb_build_object('status', 'missing_evidence', 'missing_evidence', missing || unsupported);
  end if;
  if cardinality(unsupported) > 0 then
    return jsonb_build_object('status', 'unsupported_evidence', 'missing_evidence', unsupported);
  end if;
  if attempt.lease_expires_at <= clock_timestamp() then return jsonb_build_object('status', 'stale_claim'); end if;
  return jsonb_build_object('status', 'ready', 'profile', to_jsonb(profile), 'definition', definition,
    'sample_receipt_id', sample.id, 'scorer_revision_id', job.scorer_revision_id, 'target_commit_sha', job.target_commit_sha,
    'run_id', job.run_id, 'session_id', job.session_id, 'evidence', evidence);
end;
$$;

create function public.prepare_factory_judge_invocation(
  p_workspace_id uuid, p_factory_id uuid, p_job_id uuid, p_attempt_id uuid, p_lease_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  return internal.factory_judge_invocation_plan(p_workspace_id, p_factory_id, p_job_id, p_attempt_id, p_lease_id, true);
end;
$$;

create function public.begin_factory_judge_invocation(
  p_workspace_id uuid, p_factory_id uuid, p_job_id uuid, p_attempt_id uuid, p_lease_id uuid,
  p_profile_revision_id uuid, p_evidence_digest text, p_worker_runtime text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare plan jsonb; cipher text;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_profile_revision_id is null or p_evidence_digest is null or p_evidence_digest !~ '^[a-f0-9]{64}$'
    or p_worker_runtime is null or p_worker_runtime not in ('node', 'workerd') then
    raise exception 'Invalid judge invocation identity.' using errcode = '22023';
  end if;
  plan := internal.factory_judge_invocation_plan(p_workspace_id, p_factory_id, p_job_id, p_attempt_id, p_lease_id, false);
  if plan->>'status' <> 'ready' then return plan; end if;
  if plan#>>'{profile,id}' is distinct from p_profile_revision_id::text then
    return jsonb_build_object('status', 'profile_unavailable');
  end if;
  select head.encrypted_api_key into strict cipher from internal.factory_judge_credential_heads head
    where (head.workspace_id, head.profile_revision_id) = (p_workspace_id, p_profile_revision_id);
  insert into public.factory_judge_invocations(
    attempt_id, workspace_id, factory_id, job_id, profile_revision_id, worker_runtime, evidence_digest, status, started_at
  ) values (
    p_attempt_id, p_workspace_id, p_factory_id, p_job_id, p_profile_revision_id, p_worker_runtime,
    p_evidence_digest, 'started', clock_timestamp()
  ) on conflict (attempt_id) do nothing;
  if not found then return jsonb_build_object('status', 'already_started'); end if;
  return jsonb_build_object('status', 'authorized', 'encrypted_api_key', cipher);
end;
$$;

-- The terminal trace accepts only the typed result over the sampled evidence.
-- Numeric status is derived from the pinned scorer, never from judge prose.
create function internal.valid_factory_judge_candidate(
  p_status text, p_candidate jsonb, p_evidence jsonb, p_definition jsonb
) returns boolean language plpgsql immutable set search_path = '' as $$
declare score jsonb; rule jsonb; measured double precision; derived text; candidate_status text := p_candidate->>'status';
begin
  if p_candidate is null then return p_status <> 'completed'; end if;
  if p_status in ('evidence_unavailable', 'profile_unavailable') or jsonb_typeof(p_candidate) is distinct from 'object'
    or octet_length(p_candidate::text) > 8192 or p_candidate->'schemaVersion' is distinct from '1'::jsonb
    or jsonb_typeof(p_candidate->'evidence') is distinct from 'array' then return false; end if;
  if not (p_candidate->'evidence' <@ p_evidence)
    or jsonb_array_length(p_candidate->'evidence') <> (
      select count(distinct value) from jsonb_array_elements(p_candidate->'evidence')
    ) then return false; end if;

  if p_status = 'missing_evidence' then
    if candidate_status is distinct from 'inconclusive' or p_candidate->>'reason' is distinct from 'missing_evidence'
      or p_candidate - array['schemaVersion', 'status', 'reason', 'evidence', 'missingEvidence'] <> '{}'::jsonb
      or jsonb_typeof(p_candidate->'missingEvidence') is distinct from 'array' then return false; end if;
    return jsonb_array_length(p_candidate->'missingEvidence') between 1 and 5
      and jsonb_array_length(p_candidate->'missingEvidence') = (
        select count(distinct value) from jsonb_array_elements(p_candidate->'missingEvidence')
      )
      and (p_candidate->'missingEvidence') <@ (p_definition->'requiredEvidence')
      and not exists (select 1 from jsonb_array_elements(p_candidate->'evidence') item
        where (p_candidate->'missingEvidence') ? (item->>'kind'))
      and jsonb_array_length(p_candidate->'missingEvidence') + jsonb_array_length(p_candidate->'evidence')
        = jsonb_array_length(p_definition->'requiredEvidence');
  end if;
  if p_status = 'unsupported_evidence' then
    return candidate_status is not distinct from 'inconclusive'
      and p_candidate->>'reason' is not distinct from 'unsupported_evidence'
      and jsonb_array_length(p_candidate->'evidence') > 0
      and p_candidate - array['schemaVersion', 'status', 'reason', 'evidence'] = '{}'::jsonb;
  end if;
  if not (p_evidence <@ (p_candidate->'evidence')) or jsonb_array_length(p_candidate->'evidence') = 0 then return false; end if;
  if p_status in ('invalid_output', 'provider_unavailable', 'timeout') then
    return candidate_status is not distinct from 'error' and p_candidate->>'reason' is not distinct from p_status
      and p_candidate - array['schemaVersion', 'status', 'reason', 'evidence'] = '{}'::jsonb;
  end if;
  if p_status <> 'completed' then return false; end if;
  if candidate_status = 'inconclusive' and p_candidate->>'reason' = 'ambiguous_evidence' then
    return p_candidate - array['schemaVersion', 'status', 'reason', 'evidence'] = '{}'::jsonb;
  end if;

  score := p_candidate->'score';
  rule := p_definition->'scoring';
  if jsonb_typeof(score) is distinct from 'object' or score - array['kind', 'value'] <> '{}'::jsonb
    or score->>'kind' is distinct from rule->>'kind' then return false; end if;
  if rule->>'kind' = 'boolean' then
    if jsonb_typeof(score->'value') is distinct from 'boolean' then return false; end if;
    derived := case when score->'value' = rule->'passValue' then 'pass' else 'fail' end;
  else
    if jsonb_typeof(score->'value') is distinct from 'number' then return false; end if;
    measured := (score->>'value')::double precision;
    if measured not between (rule->>'min')::double precision and (rule->>'max')::double precision then return false; end if;
    derived := case
      when rule->>'direction' = 'higher_is_better' and measured >= (rule->>'passThreshold')::double precision then 'pass'
      when rule->>'direction' = 'higher_is_better' and measured <= (rule->>'failThreshold')::double precision then 'fail'
      when rule->>'direction' = 'lower_is_better' and measured <= (rule->>'passThreshold')::double precision then 'pass'
      when rule->>'direction' = 'lower_is_better' and measured >= (rule->>'failThreshold')::double precision then 'fail'
      else 'inconclusive'
    end;
  end if;
  if candidate_status is distinct from derived then return false; end if;
  if derived = 'inconclusive' then
    return p_candidate->>'reason' is not distinct from 'between_thresholds'
      and p_candidate - array['schemaVersion', 'status', 'reason', 'evidence', 'score'] = '{}'::jsonb;
  end if;
  return p_candidate - array['schemaVersion', 'status', 'evidence', 'score'] = '{}'::jsonb;
exception when numeric_value_out_of_range then
  return false;
end;
$$;

create function public.finish_factory_judge_invocation(
  p_workspace_id uuid, p_factory_id uuid, p_job_id uuid, p_attempt_id uuid, p_lease_id uuid,
  p_status text, p_candidate_result jsonb default null, p_provider_model text default null,
  p_provider_name text default null, p_provider_request_id text default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  attempt public.factory_evaluation_attempts;
  job public.factory_evaluation_jobs;
  invocation public.factory_judge_invocations;
  evidence jsonb;
  definition jsonb;
  approved_model text;
  disposition text;
  finished timestamptz;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_status is null or p_status not in ('completed', 'missing_evidence', 'unsupported_evidence',
    'evidence_unavailable', 'profile_unavailable', 'invalid_output', 'provider_unavailable', 'timeout')
    or p_provider_model !~ '^[A-Za-z0-9._/:-]{1,160}$'
    or p_provider_name !~ '^[A-Za-z0-9 ._()/:-]{1,120}$'
    or p_provider_request_id !~ '^[A-Za-z0-9_-]{1,200}$' then
    raise exception 'Invalid judge invocation outcome.' using errcode = '22023';
  end if;

  attempt := internal.lock_factory_evaluation_claim(p_workspace_id, p_factory_id, p_job_id, p_attempt_id, p_lease_id);
  if attempt.id is null then return false; end if;
  select * into invocation from public.factory_judge_invocations prior where prior.attempt_id = attempt.id;
  if invocation.attempt_id is not null then
    if invocation.status <> 'started' or p_status in ('evidence_unavailable', 'profile_unavailable')
      or (p_status in ('missing_evidence', 'unsupported_evidence') and
        (p_candidate_result is null or num_nonnulls(p_provider_model, p_provider_name, p_provider_request_id) > 0)) then
      return false;
    end if;
    if p_status = 'completed' then
      select profile.model_id into strict approved_model from public.factory_judge_profile_revisions profile
        where (profile.workspace_id, profile.id) = (p_workspace_id, invocation.profile_revision_id);
      if p_provider_model is distinct from approved_model then
        raise exception 'The result does not match the approved judge model.' using errcode = '22023';
      end if;
    end if;
  elsif p_status not in ('missing_evidence', 'unsupported_evidence', 'evidence_unavailable', 'profile_unavailable')
    or num_nonnulls(p_provider_model, p_provider_name, p_provider_request_id) > 0 then
    return false;
  end if;

  select * into strict job from public.factory_evaluation_jobs target where target.id = attempt.job_id;
  select sample.evidence, scorer.definition into strict evidence, definition
  from public.factory_scorer_sample_receipts sample
  join public.factory_scorer_revisions scorer
    on (scorer.workspace_id, scorer.factory_id, scorer.id) = (sample.workspace_id, sample.factory_id, sample.scorer_revision_id)
  where (sample.id, sample.workspace_id, sample.factory_id, sample.run_id, sample.target_commit_sha) =
    (job.sample_receipt_id, job.workspace_id, job.factory_id, job.run_id, job.target_commit_sha) and sample.outcome = 'sampled';
  if internal.valid_factory_judge_candidate(p_status, p_candidate_result, evidence, definition) is distinct from true then
    raise exception 'Invalid typed judge candidate.' using errcode = '22023';
  end if;

  finished := clock_timestamp();
  if attempt.lease_expires_at <= finished then return false; end if;
  if invocation.attempt_id is not null then
    update public.factory_judge_invocations terminal
      set status = p_status, candidate_result = p_candidate_result, provider_model = p_provider_model,
        provider_name = p_provider_name, provider_request_id = p_provider_request_id, finished_at = finished
      where terminal.attempt_id = attempt.id;
  else
    insert into public.factory_judge_invocations(
      attempt_id, workspace_id, factory_id, job_id, status, candidate_result, finished_at
    ) values (attempt.id, job.workspace_id, job.factory_id, job.id, p_status, p_candidate_result, finished);
  end if;
  disposition := case
    when p_status in ('evidence_unavailable', 'profile_unavailable', 'provider_unavailable', 'timeout') then 'retryable_failure'
    when p_status = 'invalid_output' then 'permanent_failure'
    else 'succeeded'
  end;
  perform internal.settle_locked_factory_evaluation_attempt(job, attempt, disposition);
  return true;
end;
$$;

revoke all on function internal.preserve_factory_judge_profile_revision(), internal.preserve_factory_judge_invocation(),
  internal.close_factory_judge_invocation_on_attempt_settlement(),
  internal.editable_factory_judge_profile(uuid, integer), internal.claim_factory_evaluation_job(boolean),
  internal.factory_judge_invocation_plan(uuid, uuid, uuid, uuid, uuid, boolean),
  internal.valid_factory_judge_candidate(text, jsonb, jsonb, jsonb),
  public.get_factory_judge_profile(uuid, uuid),
  public.configure_factory_judge_profile(uuid, uuid, integer, text, text, boolean, boolean, text),
  public.revoke_factory_judge_profile(uuid, uuid, integer), public.claim_factory_judge_job(),
  public.prepare_factory_judge_invocation(uuid, uuid, uuid, uuid, uuid),
  public.begin_factory_judge_invocation(uuid, uuid, uuid, uuid, uuid, uuid, text, text),
  public.finish_factory_judge_invocation(uuid, uuid, uuid, uuid, uuid, text, jsonb, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_factory_judge_profile(uuid, uuid),
  public.configure_factory_judge_profile(uuid, uuid, integer, text, text, boolean, boolean, text),
  public.revoke_factory_judge_profile(uuid, uuid, integer), public.claim_factory_judge_job(),
  public.prepare_factory_judge_invocation(uuid, uuid, uuid, uuid, uuid),
  public.begin_factory_judge_invocation(uuid, uuid, uuid, uuid, uuid, uuid, text, text),
  public.finish_factory_judge_invocation(uuid, uuid, uuid, uuid, uuid, text, jsonb, text, text, text)
  to service_role;
