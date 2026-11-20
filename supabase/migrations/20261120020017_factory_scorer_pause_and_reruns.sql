-- A manual target uses the same exact evidence and lease as a sampled job.
-- Its missing policy identifies it as outside all automatic cohorts.
alter table public.factory_scorer_sample_receipts
  alter column policy_id drop not null,
  add constraint factory_scorer_sample_receipts_manual_check check (policy_id is not null or outcome = 'sampled'),
  add constraint factory_scorer_sample_receipts_scorer_fk foreign key (workspace_id, factory_id, scorer_revision_id)
    references public.factory_scorer_revisions(workspace_id, factory_id, id) on delete cascade;
alter table public.factory_evaluation_jobs
  add column source_attempt_id uuid references public.factory_evaluation_receipts(attempt_id) deferrable initially deferred,
  add column requested_by uuid,
  add constraint factory_evaluation_jobs_manual_actor_check check ((source_attempt_id is null) = (requested_by is null)),
  drop constraint factory_evaluation_jobs_workspace_id_factory_id_run_id_scor_key;
create index factory_scorer_sample_receipts_revision_idx
  on public.factory_scorer_sample_receipts(workspace_id, factory_id, scorer_revision_id);
create unique index factory_evaluation_jobs_automatic_run_idx
  on public.factory_evaluation_jobs(workspace_id, factory_id, run_id, scorer_revision_id) where source_attempt_id is null;
create unique index factory_evaluation_jobs_manual_source_idx
  on public.factory_evaluation_jobs(source_attempt_id, scorer_revision_id) where source_attempt_id is not null;
create index factory_evaluation_jobs_run_idx
  on public.factory_evaluation_jobs(workspace_id, factory_id, run_id, scorer_revision_id);

create table public.factory_scorer_pauses (
  workspace_id uuid not null,
  factory_id uuid not null,
  scorer_id uuid not null,
  paused boolean not null,
  revision integer not null check (revision > 0),
  updated_by uuid not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, factory_id, scorer_id),
  foreign key (workspace_id, factory_id, scorer_id)
    references public.factory_scorers(workspace_id, factory_id, id) on delete cascade
);
create table public.factory_scorer_admission_skips (
  sample_receipt_id uuid primary key references public.factory_scorer_sample_receipts(id) on delete cascade,
  workspace_id uuid not null,
  factory_id uuid not null,
  scorer_id uuid not null,
  pause_revision integer not null check (pause_revision > 0),
  recorded_xact_id xid8 not null default pg_current_xact_id(),
  foreign key (workspace_id, factory_id, scorer_id)
    references public.factory_scorers(workspace_id, factory_id, id) on delete cascade
);
create index factory_scorer_admission_skips_scorer_idx
  on public.factory_scorer_admission_skips(workspace_id, factory_id, scorer_id);
alter table public.factory_scorer_pauses enable row level security;
alter table public.factory_scorer_admission_skips enable row level security;
revoke all on public.factory_scorer_pauses, public.factory_scorer_admission_skips
  from public, anon, authenticated, service_role;

create function internal.preserve_factory_scorer_admission_skip()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.factory_scorer_sample_receipts sample where sample.id = old.sample_receipt_id)
    or not exists (
      select 1 from public.factory_scorers scorer
      where (scorer.workspace_id, scorer.factory_id, scorer.id) = (old.workspace_id, old.factory_id, old.scorer_id)
    )
  ) then return old; end if;
  raise exception 'Scorer admission history is immutable.' using errcode = '23514';
end;
$$;
create trigger factory_scorer_admission_skips_immutable before update or delete
  on public.factory_scorer_admission_skips for each row execute function internal.preserve_factory_scorer_admission_skip();

create function public.get_factory_scorer_pause(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_scorer_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare state public.factory_scorer_pauses;
begin
  perform internal.assert_checkpoint_publication_service();
  if not internal.can_read_factory_evaluation_receipts(p_workspace_id, p_factory_id, p_actor_user_id)
    or not exists (
      select 1 from public.factory_scorers scorer
      where (scorer.workspace_id, scorer.factory_id, scorer.id) = (p_workspace_id, p_factory_id, p_scorer_id)
    ) then raise exception 'Scorer is unavailable.' using errcode = 'P0002'; end if;
  select * into state from public.factory_scorer_pauses pause
    where (pause.workspace_id, pause.factory_id, pause.scorer_id) = (p_workspace_id, p_factory_id, p_scorer_id);
  return jsonb_build_object('paused', coalesce(state.paused, false), 'revision', coalesce(state.revision, 0),
    'updated_at', state.updated_at);
end;
$$;

create function public.configure_factory_scorer_pause(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_scorer_id uuid,
  p_expected_revision integer, p_paused boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare state public.factory_scorer_pauses;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  if p_paused is null then raise exception 'Invalid scorer pause state.' using errcode = '22023'; end if;
  perform 1 from public.factory_scorers scorer
    where (scorer.workspace_id, scorer.factory_id, scorer.id) = (p_workspace_id, p_factory_id, p_scorer_id)
    for no key update;
  if not found then raise exception 'Scorer is unavailable.' using errcode = 'P0002'; end if;
  select * into state from public.factory_scorer_pauses pause
    where (pause.workspace_id, pause.factory_id, pause.scorer_id) = (p_workspace_id, p_factory_id, p_scorer_id);
  if p_expected_revision is distinct from coalesce(state.revision, 0) then
    raise exception 'Scorer pause state changed. Reload before saving.' using errcode = 'PT409';
  end if;
  if p_paused is distinct from coalesce(state.paused, false) then
    insert into public.factory_scorer_pauses (workspace_id, factory_id, scorer_id, paused, revision, updated_by)
      values (p_workspace_id, p_factory_id, p_scorer_id, p_paused, p_expected_revision + 1, p_actor_user_id)
      on conflict (workspace_id, factory_id, scorer_id) do update
        set paused = excluded.paused, revision = excluded.revision, updated_by = excluded.updated_by,
            updated_at = excluded.updated_at
      returning * into state;
  end if;
  return jsonb_build_object('paused', coalesce(state.paused, false), 'revision', coalesce(state.revision, 0),
    'updated_at', state.updated_at);
end;
$$;

create or replace function internal.admit_factory_evaluation_job(p_sample public.factory_scorer_sample_receipts)
returns boolean language plpgsql set search_path = '' as $$
declare target_scorer_id uuid; paused_revision integer;
begin
  if p_sample.policy_id is null or p_sample.outcome is distinct from 'sampled' then return false; end if;
  -- Keep workspace teardown before the scorer mutex.
  perform 1 from public.workspaces workspace
    where workspace.id = p_sample.workspace_id and workspace.deletion_requested_at is null for key share;
  if not found then return false; end if;
  -- Serialize with this scorer's pause mutation, never a production run row.
  select scorer.id into target_scorer_id
  from public.factory_scorer_sample_receipts receipt
  join public.workspaces workspace on workspace.id = receipt.workspace_id and workspace.deletion_requested_at is null
  join public.factory_scorer_revisions revision
    on (revision.workspace_id, revision.factory_id, revision.id) =
      (receipt.workspace_id, receipt.factory_id, receipt.scorer_revision_id)
  join public.factory_scorers scorer
    on (scorer.workspace_id, scorer.factory_id, scorer.id) = (revision.workspace_id, revision.factory_id, revision.scorer_id)
  where (receipt.workspace_id, receipt.factory_id, receipt.id) = (p_sample.workspace_id, p_sample.factory_id, p_sample.id)
  for share of scorer;
  if not found then return false; end if;

  if exists (
    select 1 from public.factory_evaluation_jobs existing
    where (existing.workspace_id, existing.factory_id, existing.run_id, existing.scorer_revision_id) =
      (p_sample.workspace_id, p_sample.factory_id, p_sample.run_id, p_sample.scorer_revision_id)
      and existing.source_attempt_id is null
  ) or exists (
    select 1 from public.factory_scorer_admission_skips skip where skip.sample_receipt_id = p_sample.id
  ) then return false; end if;

  select pause.revision into paused_revision from public.factory_scorer_pauses pause
    where (pause.workspace_id, pause.factory_id, pause.scorer_id) =
      (p_sample.workspace_id, p_sample.factory_id, target_scorer_id) and pause.paused;
  if found then
    insert into public.factory_scorer_admission_skips(sample_receipt_id, workspace_id, factory_id, scorer_id, pause_revision)
      values (p_sample.id, p_sample.workspace_id, p_sample.factory_id, target_scorer_id, paused_revision)
      on conflict (sample_receipt_id) do nothing;
    return false;
  end if;
  insert into public.factory_evaluation_lanes(workspace_id)
    values (p_sample.workspace_id) on conflict (workspace_id) do nothing;
  insert into public.factory_evaluation_jobs (
    workspace_id, factory_id, session_id, run_id, scorer_revision_id, sample_receipt_id, target_commit_sha
  ) values (
    p_sample.workspace_id, p_sample.factory_id, p_sample.session_id, p_sample.run_id,
    p_sample.scorer_revision_id, p_sample.id, p_sample.target_commit_sha
  ) on conflict (workspace_id, factory_id, run_id, scorer_revision_id) where source_attempt_id is null do nothing;
  return found;
end;
$$;

create or replace function internal.guard_factory_evaluation_job()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.factory_scorer_sample_receipts sample where sample.id = old.sample_receipt_id)
      or not exists (select 1 from public.factory_evaluation_lanes lane where lane.workspace_id = old.workspace_id) then
      return old;
    end if;
  elsif old.status in ('queued', 'claimed') and
    (new.id, new.workspace_id, new.factory_id, new.session_id, new.run_id, new.scorer_revision_id,
      new.sample_receipt_id, new.target_commit_sha, new.created_at, new.attempt_limit, new.canceled_recorded_xact_id,
      new.source_attempt_id, new.requested_by)
    is not distinct from
    (old.id, old.workspace_id, old.factory_id, old.session_id, old.run_id, old.scorer_revision_id,
      old.sample_receipt_id, old.target_commit_sha, old.created_at, old.attempt_limit, old.canceled_recorded_xact_id,
      old.source_attempt_id, old.requested_by) then
    if new.status = 'canceled' then new.canceled_recorded_xact_id := pg_current_xact_id(); end if;
    return new;
  end if;
  raise exception 'Evaluation job identity and terminal history are immutable.' using errcode = '23514';
end;
$$;

create or replace function public.maintain_factory_evaluation_queue(p_limit integer default 25)
returns table (
  receipts_processed integer, jobs_admitted integer, attempts_recovered integer, jobs_requeued integer, jobs_failed integer
) language plpgsql security definer set search_path = '' as $$
declare
  cursor_position internal.factory_evaluation_admission_progress;
  sample public.factory_scorer_sample_receipts;
  job public.factory_evaluation_jobs;
  attempt public.factory_evaluation_attempts;
  result public.factory_evaluation_jobs;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid evaluation maintenance batch size.' using errcode = '22023';
  end if;
  receipts_processed := 0;
  jobs_admitted := 0;
  attempts_recovered := 0;
  jobs_requeued := 0;
  jobs_failed := 0;

  select * into cursor_position from internal.factory_evaluation_admission_progress progress
    where progress.singleton and not progress.completed for update skip locked;
  if found then
    for sample in
      select receipt.* from public.factory_scorer_sample_receipts receipt
      join public.workspaces workspace on workspace.id = receipt.workspace_id and workspace.deletion_requested_at is null
      where receipt.outcome = 'sampled' and receipt.policy_id is not null
        and (receipt.created_at, receipt.id) <= (cursor_position.before_created_at, cursor_position.before_receipt_id)
        and (receipt.created_at, receipt.id) > (cursor_position.last_created_at, cursor_position.last_receipt_id)
        and not exists (
          select 1 from public.factory_evaluation_jobs queued
          where (queued.workspace_id, queued.factory_id, queued.run_id, queued.scorer_revision_id) =
            (receipt.workspace_id, receipt.factory_id, receipt.run_id, receipt.scorer_revision_id)
            and queued.source_attempt_id is null
        )
      order by receipt.created_at, receipt.id limit p_limit
    loop
      receipts_processed := receipts_processed + 1;
      begin
        jobs_admitted := jobs_admitted + internal.admit_factory_evaluation_job(sample)::integer;
      exception when foreign_key_violation then
        -- Teardown can commit after selection or the admission recheck.
        -- Only that lost scope may be skipped, leaving the cursor to advance.
        if exists (
          select 1 from public.factory_scorer_sample_receipts receipt
          join public.workspaces workspace on workspace.id = receipt.workspace_id and workspace.deletion_requested_at is null
          where (receipt.workspace_id, receipt.factory_id, receipt.id) = (sample.workspace_id, sample.factory_id, sample.id)
        ) then raise; end if;
      end;
      cursor_position.last_created_at := sample.created_at;
      cursor_position.last_receipt_id := sample.id;
    end loop;
    update internal.factory_evaluation_admission_progress progress set
      last_created_at = cursor_position.last_created_at, last_receipt_id = cursor_position.last_receipt_id,
      completed = receipts_processed < p_limit where progress.singleton;
  end if;

  for job in
    select target.* from public.factory_evaluation_attempts expired
    join public.factory_evaluation_jobs target on (target.id, target.attempt_count) = (expired.job_id, expired.attempt_number)
    where expired.settled_at is null and expired.lease_expires_at <= statement_timestamp() and target.status = 'claimed'
    order by expired.lease_expires_at, expired.job_id limit p_limit for update of target skip locked
  loop
    select * into attempt from public.factory_evaluation_attempts current_attempt
      where (current_attempt.job_id, current_attempt.attempt_number) = (job.id, job.attempt_count)
        and current_attempt.settled_at is null and current_attempt.lease_expires_at <= clock_timestamp() for update;
    if not found then continue; end if;
    result := internal.settle_locked_factory_evaluation_attempt(job, attempt, 'lease_expired');
    attempts_recovered := attempts_recovered + 1;
    jobs_requeued := jobs_requeued + (result.status = 'queued')::integer;
    jobs_failed := jobs_failed + (result.status = 'failed')::integer;
  end loop;
  return next;
end;
$$;

create function internal.is_factory_evaluation_scorer_paused(
  p_workspace_id uuid, p_factory_id uuid, p_scorer_revision_id uuid
) returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.factory_scorer_revisions revision
    join public.factory_scorer_pauses pause on (pause.workspace_id, pause.factory_id, pause.scorer_id) =
      (revision.workspace_id, revision.factory_id, revision.scorer_id)
    where (revision.workspace_id, revision.factory_id, revision.id) =
      (p_workspace_id, p_factory_id, p_scorer_revision_id) and pause.paused
  );
$$;

create or replace function internal.claim_factory_evaluation_job(p_require_profile boolean)
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
        and not internal.is_factory_evaluation_scorer_paused(queued.workspace_id, queued.factory_id, queued.scorer_revision_id)
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
    -- Pause takes the conflicting factory lock through assert_factory_manager.
    -- Recheck after locking in case it committed during head selection.
    if internal.is_factory_evaluation_scorer_paused(job.workspace_id, job.factory_id, job.scorer_revision_id)
      then continue; end if;
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

-- Exact checkpoint and tree verification are common to automatic sampling
-- and manually selected rubrics. Manual enqueue also checks current storage.
create function internal.select_factory_scorer_checkpoint_evidence(
  p_checkpoint public.session_git_checkpoints, p_factory_id uuid, p_required_kinds text[], p_require_retention boolean
) returns table (evidence jsonb, missing_kinds text[], includes_withheld boolean)
language sql stable set search_path = '' as $$
  with candidates(kind, id, withheld) as (
    select 'code_diff'::text, (p_checkpoint).run_id, false
    where not p_require_retention or (p_checkpoint).input_sha = (p_checkpoint).output_sha or exists (
      select 1 from public.github_repositories repository
      join public.github_installations installation on (installation.workspace_id, installation.id) =
        (repository.workspace_id, repository.github_installation_id)
      where (repository.workspace_id, repository.factory_id, repository.id) =
        ((p_checkpoint).workspace_id, p_factory_id, (p_checkpoint).repository_id)
        and not repository.is_archived and not installation.suspended
    )
    union all
    select 'artifact', artifact.id, false
    from public.session_artifacts artifact
    where (artifact.workspace_id, artifact.session_id, artifact.id) =
      ((p_checkpoint).workspace_id, (p_checkpoint).session_id, (p_checkpoint).artifact_id)
      and (not p_require_retention or (jsonb_typeof(artifact.artifact_json) = 'string'
        and octet_length(artifact.artifact_json #>> '{}') between 1 and 98304))
    union all
    select 'validation_report', asset.id, withholding.asset_id is not null
    from public.session_validation_evidence validation
    join public.session_validation_assets asset on (asset.run_id, asset.workspace_id, asset.session_id) =
      (validation.run_id, validation.workspace_id, validation.session_id)
    left join public.session_validation_asset_withholdings withholding on withholding.asset_id = asset.id
    where (validation.run_id, validation.workspace_id, validation.session_id, validation.job_id,
      validation.attempt_count, validation.repository_id, validation.commit_sha) =
      ((p_checkpoint).run_id, (p_checkpoint).workspace_id, (p_checkpoint).session_id, (p_checkpoint).job_id,
        (p_checkpoint).attempt_count, (p_checkpoint).repository_id, (p_checkpoint).output_sha)
      and asset.kind = 'report'
      and (not p_require_retention or withholding.asset_id is not null or exists (
        select 1 from storage.objects object
        where (object.bucket_id, object.name) = ('session-validation-evidence', asset.storage_path)
          and object.metadata->>'size' = asset.size_bytes::text and object.metadata->>'mimetype' = asset.content_type
      ))
      and exists (
        select 1 from public.session_validation_plans plan
        cross join lateral jsonb_array_elements(plan.plan->'commands') command(value)
        cross join lateral jsonb_array_elements(command.value->'reports') report(value)
        cross join lateral jsonb_array_elements(validation.records) result(value)
        where (plan.run_id, plan.workspace_id, plan.session_id, plan.job_id, plan.attempt_count,
          plan.repository_id, plan.commit_sha, plan.validation_tree_sha) =
          (validation.run_id, validation.workspace_id, validation.session_id, validation.job_id,
            validation.attempt_count, validation.repository_id, validation.commit_sha, validation.validation_tree_sha)
          and (command.value->>'key') || '/' || (report.value->>'key') = asset.evidence_key
          and report.value->>'kind' = 'report'
          and result.value->>'key' = command.value->>'key'
          and result.value->>'provenance' = 'harness' and result.value->>'status' in ('passed', 'failed')
          and result.value->>'commitSha' = plan.commit_sha and result.value->>'finalCommitSha' = plan.commit_sha
          and result.value->>'treeSha' = plan.validation_tree_sha and result.value->>'finalTreeSha' = plan.validation_tree_sha
      )
    union all
    select case asset.content_type when 'image/png' then 'browser_screenshot' else 'browser_recording' end,
      asset.id, withholding.asset_id is not null
    from public.session_validation_plans plan
    join public.session_browser_verification_assets asset on (asset.run_id, asset.workspace_id, asset.session_id) =
      (plan.run_id, plan.workspace_id, plan.session_id)
    left join public.session_browser_asset_withholdings withholding on withholding.asset_id = asset.id
    where (plan.run_id, plan.workspace_id, plan.session_id, plan.job_id,
      plan.attempt_count, plan.repository_id, plan.commit_sha) =
      ((p_checkpoint).run_id, (p_checkpoint).workspace_id, (p_checkpoint).session_id, (p_checkpoint).job_id,
        (p_checkpoint).attempt_count, (p_checkpoint).repository_id, (p_checkpoint).output_sha)
      -- The asset's receipt is bound to this immutable plan by scoped FKs.
      -- The capture RPC verifies the plan's commit and tree before inserting both.
      and plan.plan->'version' = '2'::jsonb
      and asset.content_type in ('image/png', 'video/webm')
      and (not p_require_retention or withholding.asset_id is not null or exists (
        select 1 from storage.objects object
        where (object.bucket_id, object.name) = ('session-validation-evidence', asset.storage_path)
          and object.metadata->>'size' = asset.size_bytes::text and object.metadata->>'mimetype' = asset.content_type
      ))
  ), requirements as (
    select requirement.kind, requirement.position, available.id,
      exists (select 1 from candidates candidate where candidate.kind = requirement.kind and candidate.withheld) as withheld
    from unnest(p_required_kinds) with ordinality requirement(kind, position)
    left join lateral (
      select candidate.id from candidates candidate
      where candidate.kind = requirement.kind and not candidate.withheld
      order by candidate.id limit 1
    ) available on true
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'id', id) order by position)
      filter (where id is not null), '[]'),
    coalesce(array_agg(kind order by position) filter (where id is null), '{}'),
    coalesce(bool_or(withheld) filter (where id is null), false)
  from requirements;
$$;

create or replace function internal.record_factory_scorer_sample(
  p_policy public.factory_scorer_sampling_policies, p_run_id uuid
) returns public.factory_scorer_sample_receipts language plpgsql set search_path = '' as $$
declare
  target record;
  checkpoint public.session_git_checkpoints;
  required_kinds text[];
  missing_kinds text[] := '{}';
  retained_evidence jsonb := '[]';
  includes_withheld boolean;
  decision text := 'excluded';
  decision_reason text;
  receipt public.factory_scorer_sample_receipts;
begin
  select * into receipt from public.factory_scorer_sample_receipts prior
  where (prior.policy_id, prior.run_id) = (p_policy.id, p_run_id);
  if found then return receipt; end if;

  select run.id, run.session_id, run.agent_job_id, run.attempt_count, run.stage_id, run.status, run.finished_at,
    owner.factory_definition_revision_id as definition_revision_id,
    array(select jsonb_array_elements_text(scorer.definition->'requiredEvidence')) as required_kinds
  into target
  from public.agent_runs run
  join public.sessions owner on (owner.workspace_id, owner.id) = (run.workspace_id, run.session_id)
  join public.workspaces workspace on workspace.id = owner.workspace_id and workspace.deletion_requested_at is null
  join public.factory_definition_revisions definition
    on (definition.workspace_id, definition.factory_id, definition.id) =
      (owner.workspace_id, owner.factory_id, owner.factory_definition_revision_id)
  join public.factory_scorer_revisions scorer
    on (scorer.workspace_id, scorer.factory_id, scorer.id) =
      (p_policy.workspace_id, p_policy.factory_id, p_policy.scorer_revision_id)
  where run.id = p_run_id
    and (owner.workspace_id, owner.factory_id) = (p_policy.workspace_id, p_policy.factory_id)
    and run.finished_at is not null and run.status in ('success', 'error', 'canceled')
    and definition.schema_version = 2
    and (definition.definition_json::jsonb->'scorerRevisionIds') ? scorer.id::text;
  if not found then raise exception 'Terminal run is unavailable for this scorer policy.' using errcode = 'P0002'; end if;

  required_kinds := target.required_kinds;
  select * into checkpoint from public.session_git_checkpoints exact
  where (exact.run_id, exact.workspace_id, exact.session_id, exact.job_id, exact.attempt_count) =
    (target.id, p_policy.workspace_id, target.session_id, target.agent_job_id, target.attempt_count);

  if not (target.status::text = any(p_policy.terminal_statuses)) then
    decision_reason := 'status_excluded';
  elsif cardinality(p_policy.stage_ids) > 0 and (target.stage_id = any(p_policy.stage_ids)) is not true then
    decision_reason := 'stage_excluded';
  elsif exists (
    select 1 from public.session_retained_content_erasures erasure
    where (erasure.workspace_id, erasure.factory_id, erasure.session_id) =
      (p_policy.workspace_id, p_policy.factory_id, target.session_id)
  ) then
    decision_reason := 'withheld_evidence';
    missing_kinds := required_kinds;
  elsif checkpoint.run_id is null then
    decision_reason := 'unsupported_run';
  else
    select selected.evidence, selected.missing_kinds, selected.includes_withheld
      into retained_evidence, missing_kinds, includes_withheld
      from internal.select_factory_scorer_checkpoint_evidence(checkpoint, p_policy.factory_id, required_kinds, false) selected;

    if cardinality(missing_kinds) > 0 then
      decision_reason := case when includes_withheld then 'withheld_evidence' else 'missing_evidence' end;
    elsif internal.factory_scorer_sample_draw(p_policy.seed, target.id) * 10000
      < p_policy.rate_bps::bigint * 4294967296 then
      decision := 'sampled';
    else
      decision := 'not_sampled';
    end if;
  end if;

  insert into public.factory_scorer_sample_receipts (
    workspace_id, factory_id, policy_id, scorer_revision_id, definition_revision_id, session_id,
    run_id, attempt_count, run_finished_at, target_commit_sha, outcome, reason, missing_evidence, evidence
  ) values (
    p_policy.workspace_id, p_policy.factory_id, p_policy.id, p_policy.scorer_revision_id, target.definition_revision_id,
    target.session_id, target.id, target.attempt_count, target.finished_at, checkpoint.output_sha,
    decision, decision_reason, missing_kinds, retained_evidence
  ) on conflict (policy_id, run_id) do nothing returning * into receipt;
  if found then return receipt; end if;

  -- A concurrent insert can win after this call's first snapshot. A new
  -- statement sees the committed winner and returns its exact receipt.
  select * into strict receipt from public.factory_scorer_sample_receipts prior
    where (prior.policy_id, prior.run_id) = (p_policy.id, p_run_id);
  return receipt;
end;
$$;

create function public.request_factory_scorer_reevaluation(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_prior_attempt_id uuid, p_target_revision_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  prior public.factory_evaluation_receipts;
  prior_sample public.factory_scorer_sample_receipts;
  prior_revision public.factory_scorer_revisions;
  target_revision public.factory_scorer_revisions;
  checkpoint public.session_git_checkpoints;
  admission public.session_factory_admission_inputs;
  selected record;
  sample_id uuid;
  job public.factory_evaluation_jobs;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  select receipt.* into prior
  from public.factory_evaluation_receipts receipt
  join public.agent_runs run
    on (run.workspace_id, run.session_id, run.id) = (receipt.workspace_id, receipt.session_id, receipt.run_id)
  join public.sessions owner
    on (owner.workspace_id, owner.factory_id, owner.id) = (run.workspace_id, receipt.factory_id, run.session_id)
  where (receipt.workspace_id, receipt.factory_id, receipt.attempt_id) =
    (p_workspace_id, p_factory_id, p_prior_attempt_id);
  if not found then raise exception 'Prior evaluation receipt is unavailable.' using errcode = 'P0002'; end if;

  select * into strict prior_revision from public.factory_scorer_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.id) = (p_workspace_id, p_factory_id, prior.scorer_revision_id);
  perform 1 from public.factory_scorers scorer
    where (scorer.workspace_id, scorer.factory_id, scorer.id) = (p_workspace_id, p_factory_id, prior_revision.scorer_id)
    for no key update;
  select * into target_revision from public.factory_scorer_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.scorer_id, revision.id) =
    (p_workspace_id, p_factory_id, prior_revision.scorer_id, p_target_revision_id)
    and revision.revision_number > prior_revision.revision_number;
  if not found then raise exception 'A newer revision of this scorer is unavailable.' using errcode = 'P0002'; end if;

  select * into job from public.factory_evaluation_jobs existing
  where (existing.workspace_id, existing.factory_id, existing.source_attempt_id, existing.scorer_revision_id) =
    (p_workspace_id, p_factory_id, p_prior_attempt_id, p_target_revision_id);
  if not found then
    if internal.is_factory_evaluation_scorer_paused(p_workspace_id, p_factory_id, p_target_revision_id) then
      raise exception 'Resume this scorer before requesting a re-evaluation.' using errcode = 'PT409';
    end if;
    select sample.* into strict prior_sample from public.factory_scorer_sample_receipts sample
    where (sample.workspace_id, sample.factory_id, sample.session_id, sample.run_id, sample.scorer_revision_id,
           sample.target_commit_sha, sample.id) =
      (prior.workspace_id, prior.factory_id, prior.session_id, prior.run_id, prior.scorer_revision_id,
       prior.target_commit_sha, prior.sample_receipt_id);

    select exact.* into checkpoint from public.session_git_checkpoints exact
    where (exact.workspace_id, exact.session_id, exact.run_id, exact.attempt_count, exact.output_sha) =
      (prior.workspace_id, prior.session_id, prior.run_id, prior_sample.attempt_count, prior.target_commit_sha);
    if not found or exists (
      select 1 from public.session_retained_content_erasures erasure
      where (erasure.workspace_id, erasure.factory_id, erasure.session_id) = (p_workspace_id, p_factory_id, prior.session_id)
    ) then raise exception 'Exact evidence is unavailable for the requested revision.' using errcode = 'PT422'; end if;

    select * into admission from public.session_factory_admission_inputs input
    where (input.workspace_id, input.factory_id, input.session_id, input.definition_revision_id) =
      (prior.workspace_id, prior.factory_id, prior.session_id, prior_sample.definition_revision_id);
    if admission.execution_grant_id is not null then
      begin
        perform internal.require_current_factory_execution_grant(p_workspace_id, p_factory_id,
          admission.execution_grant_id, admission.execution_grant_version, checkpoint.repository_id,
          '{}'::uuid[], '{}'::text[], admission.execution_policy_revision_id);
      exception when insufficient_privilege then
        raise exception 'Exact evidence is unavailable for the requested revision.' using errcode = 'PT422';
      end;
    end if;

    select evidence.* into selected from internal.select_factory_scorer_checkpoint_evidence(checkpoint, p_factory_id,
      array(select jsonb_array_elements_text(target_revision.definition->'requiredEvidence')), true) evidence;
    if cardinality(selected.missing_kinds) > 0 then
      raise exception 'Exact evidence is unavailable for the requested revision.' using errcode = 'PT422';
    end if;

    insert into public.factory_scorer_sample_receipts (
      workspace_id, factory_id, scorer_revision_id, definition_revision_id, session_id, run_id,
      attempt_count, run_finished_at, target_commit_sha, outcome, missing_evidence, evidence
    ) values (
      p_workspace_id, p_factory_id, p_target_revision_id, prior_sample.definition_revision_id, prior.session_id, prior.run_id,
      prior_sample.attempt_count, prior_sample.run_finished_at, prior.target_commit_sha, 'sampled', '{}', selected.evidence
    ) returning id into sample_id;

    insert into public.factory_evaluation_jobs (
      workspace_id, factory_id, session_id, run_id, scorer_revision_id, sample_receipt_id, target_commit_sha,
      source_attempt_id, requested_by
    ) values (
      p_workspace_id, p_factory_id, prior.session_id, prior.run_id, p_target_revision_id, sample_id,
      prior.target_commit_sha, prior.attempt_id, p_actor_user_id
    ) returning * into job;
  end if;
  return jsonb_build_object('job_id', job.id, 'prior_attempt_id', job.source_attempt_id,
    'target_scorer_revision_id', job.scorer_revision_id, 'status', job.status);
end;
$$;

create index factory_evaluation_jobs_manual_history_idx
  on public.factory_evaluation_jobs(workspace_id, factory_id, source_attempt_id, created_at desc, id desc)
  where source_attempt_id is not null;

create function public.list_factory_scorer_reevaluations(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_prior_attempt_id uuid,
  p_before_created_at timestamptz default null, p_before_job_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if not internal.can_read_factory_evaluation_receipts(p_workspace_id, p_factory_id, p_actor_user_id)
    or not exists (
      select 1 from public.factory_evaluation_receipts prior
      join public.agent_runs run
        on (run.workspace_id, run.session_id, run.id) = (prior.workspace_id, prior.session_id, prior.run_id)
      join public.sessions owner
        on (owner.workspace_id, owner.factory_id, owner.id) = (run.workspace_id, prior.factory_id, run.session_id)
      where (prior.workspace_id, prior.factory_id, prior.attempt_id) = (p_workspace_id, p_factory_id, p_prior_attempt_id)
    ) then raise exception 'Prior evaluation receipt is unavailable.' using errcode = 'P0002'; end if;

  if (p_before_created_at is null) <> (p_before_job_id is null)
    or (p_before_created_at is not null and not isfinite(p_before_created_at)) then
    raise exception 'Invalid re-evaluation history page.' using errcode = '22023';
  end if;

  with page as materialized (
    select candidate.id, candidate.workspace_id, candidate.factory_id, candidate.source_attempt_id,
      candidate.scorer_revision_id, candidate.status, candidate.created_at
    from public.factory_evaluation_jobs candidate
    where (candidate.workspace_id, candidate.factory_id, candidate.source_attempt_id) =
      (p_workspace_id, p_factory_id, p_prior_attempt_id)
      and (p_before_created_at is null or (candidate.created_at, candidate.id) < (p_before_created_at, p_before_job_id))
    order by candidate.created_at desc, candidate.id desc limit 33
  ), visible as materialized (
    select * from page order by created_at desc, id desc limit 32
  ), boundary as (
    select created_at, id from visible where (select count(*) from page) > 32 order by created_at, id limit 1
  )
  select jsonb_build_object(
    'jobs', coalesce(jsonb_agg(jsonb_build_object(
      'job_id', job.id, 'prior_attempt_id', job.source_attempt_id, 'target_scorer_revision_id', job.scorer_revision_id,
      'status', job.status, 'receipt', latest.receipt
    ) order by job.created_at desc, job.id desc), '[]'),
    'next_before_created_at', (select created_at from boundary),
    'next_before_job_id', (select id from boundary)
  ) into result
  from visible job
  left join lateral (
    select internal.project_factory_evaluation_receipt(receipt) as receipt from public.factory_evaluation_receipts receipt
    where (receipt.workspace_id, receipt.factory_id, receipt.job_id) = (job.workspace_id, job.factory_id, job.id)
    order by receipt.attempt_number desc limit 1
  ) latest on true;
  return result;
end;
$$;

revoke all on function internal.preserve_factory_scorer_admission_skip(),
  internal.is_factory_evaluation_scorer_paused(uuid, uuid, uuid),
  internal.select_factory_scorer_checkpoint_evidence(public.session_git_checkpoints, uuid, text[], boolean),
  public.get_factory_scorer_pause(uuid, uuid, uuid, uuid),
  public.configure_factory_scorer_pause(uuid, uuid, uuid, uuid, integer, boolean),
  public.request_factory_scorer_reevaluation(uuid, uuid, uuid, uuid, uuid),
  public.list_factory_scorer_reevaluations(uuid, uuid, uuid, uuid, timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_factory_scorer_pause(uuid, uuid, uuid, uuid),
  public.configure_factory_scorer_pause(uuid, uuid, uuid, uuid, integer, boolean),
  public.request_factory_scorer_reevaluation(uuid, uuid, uuid, uuid, uuid),
  public.list_factory_scorer_reevaluations(uuid, uuid, uuid, uuid, timestamptz, uuid) to service_role;

-- Cohort membership and its rates continue to use automatic evaluation only.
create or replace function public.read_factory_score_cohort(
  p_workspace_id uuid, p_factory_id uuid, p_policy_id uuid, p_from timestamptz, p_to timestamptz,
  p_snapshot text default null, p_bucket_at timestamptz default null, p_status text default null,
  p_before_run_finished_at timestamptz default null, p_before_run_id uuid default null, p_limit integer default 25
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  candidate_cap constant integer := 20000;
  horizon xid8 := pg_snapshot_xmin(pg_current_snapshot());
  signed_horizon text;
  snapshot text;
  cohort jsonb;
  result jsonb;
  overflow boolean;
begin
  perform internal.require_factory_score_read(p_workspace_id, p_factory_id);
  if p_policy_id is null
    or p_from is null or not isfinite(p_from) or p_to is null or not isfinite(p_to)
    or p_to <= p_from or p_to - p_from > interval '366 days'
    or p_limit is null or p_limit not between 1 and 100
    or (p_before_run_finished_at is null) <> (p_before_run_id is null)
    or not isfinite(p_before_run_finished_at)
    or (p_before_run_id is not null and (p_snapshot is null or p_before_run_finished_at < p_from or p_before_run_finished_at >= p_to))
    or (p_bucket_at is not null and (
      not isfinite(p_bucket_at) or p_bucket_at <> date_trunc('day', p_bucket_at, 'UTC')
      or p_bucket_at >= p_to or p_bucket_at + interval '24 hours' <= p_from
    ))
    or p_status not in ('excluded', 'not_sampled', 'unsettled', 'pass', 'fail', 'inconclusive', 'skipped', 'error') then
    raise exception 'Invalid score cohort filters.' using errcode = '22023';
  end if;

  select internal.factory_score_cohort_metadata(policy, revision, scorer) into cohort
  from public.factory_scorer_sampling_policies policy
  join public.factory_scorer_revisions revision on (revision.workspace_id, revision.factory_id, revision.id) =
    (policy.workspace_id, policy.factory_id, policy.scorer_revision_id)
  join public.factory_scorers scorer on (scorer.workspace_id, scorer.factory_id, scorer.id) =
    (revision.workspace_id, revision.factory_id, revision.scorer_id)
  where (policy.workspace_id, policy.factory_id, policy.id) = (p_workspace_id, p_factory_id, p_policy_id);
  if not found then raise exception 'Evaluation cohort is unavailable.' using errcode = 'P0002'; end if;

  if p_snapshot is not null then
    if p_snapshot !~ '^[0-9]{1,20}[.][a-f0-9]{64}$' then
      raise exception 'Invalid score cohort snapshot.' using errcode = '22023';
    end if;
    signed_horizon := split_part(p_snapshot, '.', 1);
    if p_snapshot is distinct from internal.factory_score_cohort_snapshot(
      p_workspace_id, p_factory_id, p_policy_id, p_from, p_to, signed_horizon
    ) then raise exception 'Invalid score cohort snapshot.' using errcode = '22023'; end if;
    if signed_horizon::xid8 > horizon then
      raise exception 'Score cohort snapshot is unavailable.' using errcode = '22023';
    end if;
    horizon := signed_horizon::xid8;
    snapshot := p_snapshot;
  else
    snapshot := internal.factory_score_cohort_snapshot(p_workspace_id, p_factory_id, p_policy_id, p_from, p_to, horizon::text);
  end if;

  with population as materialized (
    select receipt.id, receipt.workspace_id, receipt.factory_id, receipt.run_id, receipt.session_id,
      receipt.scorer_revision_id, receipt.run_finished_at, receipt.target_commit_sha, receipt.outcome, receipt.reason
    from public.factory_scorer_sample_receipts receipt
    join public.agent_runs run on (run.workspace_id, run.session_id, run.id) = (receipt.workspace_id, receipt.session_id, receipt.run_id)
    join public.sessions owner on (owner.workspace_id, owner.factory_id, owner.id) =
      (receipt.workspace_id, receipt.factory_id, run.session_id)
    where (receipt.workspace_id, receipt.factory_id, receipt.policy_id) = (p_workspace_id, p_factory_id, p_policy_id)
      and receipt.run_finished_at >= p_from and receipt.run_finished_at < p_to
      and (receipt.recorded_xact_id is null or receipt.recorded_xact_id < horizon)
    order by receipt.run_finished_at, receipt.run_id limit candidate_cap + 1
  ), bounds as materialized (
    select count(*) > candidate_cap as overflow from population
  ), members as materialized (
    select sample.id as sample_receipt_id, sample.run_id, sample.session_id, sample.run_finished_at,
      sample.target_commit_sha, sample.outcome as sample_outcome, sample.reason as sample_reason,
      date_trunc('day', sample.run_finished_at, 'UTC') as bucket_at,
      case when cancellation.visible or latest.attempt_id is not null then job.id end as evaluation_job_id,
      case when cancellation.visible or latest.attempt_id is not null then job.sample_receipt_id end as evaluation_sample_receipt_id,
      case when not cancellation.visible or latest.reason = 'canceled' then latest.attempt_id end as evaluation_attempt_id,
      case
        when cancellation.visible then 'skipped'
        when sample.outcome = 'sampled' then coalesce(latest.status, 'unsettled')
        else sample.outcome
      end as status,
      case
        when cancellation.visible then 'canceled'
        when latest.attempt_id is null and skipped.sample_receipt_id is not null then 'scorer_paused'
        else coalesce(latest.reason, sample.reason)
      end as reason,
      case when not cancellation.visible then latest.result->'score' end as score
    from population sample
    cross join bounds
    left join public.factory_scorer_admission_skips skipped
      on skipped.sample_receipt_id = sample.id and skipped.recorded_xact_id < horizon
    left join public.factory_evaluation_jobs job
      on sample.outcome = 'sampled' and job.source_attempt_id is null
      and (job.workspace_id, job.factory_id, job.run_id, job.session_id, job.scorer_revision_id, job.target_commit_sha) =
        (sample.workspace_id, sample.factory_id, sample.run_id, sample.session_id, sample.scorer_revision_id, sample.target_commit_sha)
    cross join lateral (
      select job.status is not distinct from 'canceled'
        and (job.canceled_recorded_xact_id is null or job.canceled_recorded_xact_id < horizon) as visible
    ) cancellation
    left join lateral (
      select receipt.attempt_id, receipt.status, receipt.reason, receipt.result
      from public.factory_evaluation_receipts receipt
      where (receipt.workspace_id, receipt.factory_id, receipt.job_id) = (sample.workspace_id, sample.factory_id, job.id)
        and (receipt.recorded_xact_id is null or receipt.recorded_xact_id < horizon)
      order by receipt.attempt_number desc limit 1
    ) latest on true
    where not bounds.overflow
  ), measurements as materialized (
    select bucket_at, jsonb_build_object(
      'candidate_count', count(*),
      'eligible_count', count(*) filter (where sample_outcome <> 'excluded'),
      'sampled_count', count(*) filter (where sample_outcome = 'sampled'),
      'not_sampled_count', count(*) filter (where sample_outcome = 'not_sampled'),
      'excluded_count', count(*) filter (where sample_outcome = 'excluded'),
      'usable_count', count(score),
      'decided_count', count(*) filter (where status in ('pass', 'fail')),
      'pass_count', count(*) filter (where status = 'pass'),
      'fail_count', count(*) filter (where status = 'fail'),
      'inconclusive_count', count(*) filter (where status = 'inconclusive'),
      'skipped_count', count(*) filter (where status = 'skipped'),
      'error_count', count(*) filter (where status = 'error'),
      'unsettled_count', count(*) filter (where status = 'unsettled'),
      'missing_evidence_count', count(*) filter (where reason = 'missing_evidence'),
      'withheld_evidence_count', count(*) filter (where reason = 'withheld_evidence'),
      'unsupported_evidence_count', count(*) filter (where reason in ('unsupported_run', 'unsupported_evidence')),
      'mean_numeric_score', avg(case when score->>'kind' = 'numeric' then (score->>'value')::numeric end)
    ) as metrics
    from members group by grouping sets ((), (bucket_at))
  ), matching as materialized (
    select * from members
    where (p_bucket_at is null or bucket_at = p_bucket_at)
      and (p_status is null or status = p_status)
  ), page as materialized (
    select * from matching where p_before_run_finished_at is null
      or (run_finished_at, run_id) < (p_before_run_finished_at, p_before_run_id)
    order by run_finished_at desc, run_id desc limit p_limit + 1
  ), visible as materialized (
    select * from page order by run_finished_at desc, run_id desc limit p_limit
  ), boundary as (
    select visible.run_finished_at, visible.run_id from visible where (select count(*) from page) > p_limit
    order by visible.run_finished_at, visible.run_id limit 1
  )
  select bounds.overflow, jsonb_build_object(
    'cohort', cohort,
    'from', p_from,
    'to', p_to,
    'snapshot', snapshot,
    'totals', (select metrics from measurements where bucket_at is null),
    'points', coalesce((select jsonb_agg(metrics || jsonb_build_object('bucket_at', bucket_at) order by bucket_at)
      from measurements where bucket_at is not null), '[]'),
    'row_count', (select count(*) from matching),
    'rows', coalesce((
      select jsonb_agg((to_jsonb(visible) - 'bucket_at') || jsonb_build_object(
        'evidence_availability', case when receipt.attempt_id is not null
          then internal.factory_evaluation_receipt_evidence_availability(receipt) end
      ) order by visible.run_finished_at desc, visible.run_id desc)
      from visible left join public.factory_evaluation_receipts receipt on receipt.attempt_id = visible.evaluation_attempt_id
    ), '[]'),
    'next_run_finished_at', (select run_finished_at from boundary),
    'next_run_id', (select run_id from boundary)
  ) into overflow, result from bounds;
  if overflow then raise exception 'Too many runs in this evaluation cohort. Choose a shorter date range.' using errcode = 'PT422'; end if;
  return result;
end;
$$;

create or replace function public.list_factory_run_score_results(
  p_workspace_id uuid, p_factory_id uuid, p_run_id uuid, p_attempt_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform internal.require_factory_score_read(p_workspace_id, p_factory_id);
  if not exists (
    select 1 from public.agent_runs run
    join public.sessions owner on (owner.workspace_id, owner.factory_id, owner.id) = (run.workspace_id, p_factory_id, run.session_id)
    where (run.workspace_id, run.id) = (p_workspace_id, p_run_id)
  ) or (p_attempt_id is not null and not exists (
    select 1 from public.factory_evaluation_receipts receipt
    where (receipt.workspace_id, receipt.factory_id, receipt.run_id, receipt.attempt_id) =
      (p_workspace_id, p_factory_id, p_run_id, p_attempt_id)
  )) then raise exception 'Evaluation run is unavailable.' using errcode = 'P0002'; end if;

  with scoped_jobs as materialized (
    select distinct on (job.scorer_revision_id) job.id, job.status, job.sample_receipt_id, job.scorer_revision_id,
      job.source_attempt_id, job.created_at, chosen_attempt.attempt_id is not null as selected_attempt
    from public.factory_evaluation_jobs job
    left join public.factory_evaluation_receipts chosen_attempt
      on (chosen_attempt.workspace_id, chosen_attempt.factory_id, chosen_attempt.job_id, chosen_attempt.attempt_id) =
        (p_workspace_id, p_factory_id, job.id, p_attempt_id)
    where (job.workspace_id, job.factory_id, job.run_id) = (p_workspace_id, p_factory_id, p_run_id)
    order by job.scorer_revision_id, (chosen_attempt.attempt_id is not null) desc,
      (job.source_attempt_id is null) desc, job.created_at desc, job.id desc
  ), latest_unqueued_samples as (
    select distinct on (sample.scorer_revision_id) sample.id, sample.scorer_revision_id
    from public.factory_scorer_sample_receipts sample
    where (sample.workspace_id, sample.factory_id, sample.run_id) = (p_workspace_id, p_factory_id, p_run_id)
      and sample.policy_id is not null
      and not exists (select 1 from scoped_jobs job where job.scorer_revision_id = sample.scorer_revision_id)
    order by sample.scorer_revision_id, sample.created_at desc, sample.id desc
  ), selection as (
    select job.id as evaluation_job_id, job.status as job_status, job.sample_receipt_id, job.scorer_revision_id,
      job.source_attempt_id, job.created_at, job.selected_attempt
    from scoped_jobs job
    union all
    select null::uuid, null::text, sample.id, sample.scorer_revision_id, null::uuid, null::timestamptz, false
    from latest_unqueued_samples sample
  ), display_selection as materialized (
    -- Keep direct historical links available even if this run accumulated
    -- many newer manual rubric revisions after the original sampling.
    select * from selection selected
    order by selected.selected_attempt desc, (selected.source_attempt_id is null) desc,
      selected.created_at desc nulls last, selected.scorer_revision_id
    limit 32
  ), results as materialized (
    select scorer.name, scorer.id as scorer_id, revision.revision_number, selected.evaluation_job_id, jsonb_build_object(
      'evaluation_job_id', selected.evaluation_job_id,
      'scorer_id', scorer.id,
      'scorer_revision_id', revision.id,
      'scorer_revision_number', revision.revision_number,
      'scorer_name', scorer.name,
      'scorer_slug', scorer.slug,
      'job_status', selected.job_status,
      'source_attempt_id', selected.source_attempt_id,
      'admission_paused', skipped.sample_receipt_id is not null,
      'sample_outcome', membership.outcome,
      'sample_reason', membership.reason,
      'receipt', projection.receipt,
      'diff', internal.factory_score_diff_facts(latest.item, projection.receipt)
    ) as item
    from display_selection selected
    join public.factory_scorer_sample_receipts membership
      on (membership.workspace_id, membership.factory_id, membership.run_id, membership.scorer_revision_id, membership.id) =
        (p_workspace_id, p_factory_id, p_run_id, selected.scorer_revision_id, selected.sample_receipt_id)
    left join public.factory_scorer_admission_skips skipped on skipped.sample_receipt_id = membership.id
    join public.factory_scorer_revisions revision on (revision.workspace_id, revision.factory_id, revision.id) =
      (p_workspace_id, p_factory_id, selected.scorer_revision_id)
    join public.factory_scorers scorer on (scorer.workspace_id, scorer.factory_id, scorer.id) =
      (revision.workspace_id, revision.factory_id, revision.scorer_id)
    left join lateral (
      select receipt as item, receipt.attempt_id
      from public.factory_evaluation_receipts receipt
      where (receipt.workspace_id, receipt.factory_id, receipt.job_id) = (p_workspace_id, p_factory_id, selected.evaluation_job_id)
      order by (receipt.attempt_id = p_attempt_id) desc nulls last, receipt.attempt_number desc limit 1
    ) latest on true
    cross join lateral (
      select case when latest.attempt_id is not null then internal.project_factory_evaluation_receipt(latest.item) end as receipt
    ) projection
  )
  select coalesce(jsonb_agg(item order by name, scorer_id, revision_number, evaluation_job_id), '[]')
    into result from results;
  return result;
end;
$$;
