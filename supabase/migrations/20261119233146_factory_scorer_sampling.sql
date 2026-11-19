-- Sampling records contain eligibility and membership only. Evaluation
-- admission and execution have a separate lifecycle.
create table public.factory_scorer_sampling_policies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  scorer_revision_id uuid not null,
  revision_number integer not null check (revision_number > 0),
  rate_bps integer not null check (rate_bps between 0 and 10000),
  seed text not null check (octet_length(seed) between 1 and 128 and btrim(seed) <> ''),
  terminal_statuses text[] not null check (cardinality(terminal_statuses) between 1 and 3
    and terminal_statuses <@ array['success', 'error', 'canceled']::text[]),
  stage_ids uuid[] not null check (cardinality(stage_ids) <= 32),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id, scorer_revision_id),
  unique (workspace_id, factory_id, scorer_revision_id, revision_number),
  foreign key (workspace_id, factory_id, scorer_revision_id)
    references public.factory_scorer_revisions(workspace_id, factory_id, id) on delete cascade
);

create table public.factory_scorer_sample_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  policy_id uuid not null,
  scorer_revision_id uuid not null,
  definition_revision_id uuid not null,
  session_id uuid not null,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  attempt_count integer check (attempt_count is null or attempt_count > 0),
  run_finished_at timestamptz not null,
  target_commit_sha text check (target_commit_sha ~ '^[a-f0-9]{40}$'),
  outcome text not null check (outcome in ('sampled', 'not_sampled', 'excluded')),
  reason text check (reason in ('status_excluded', 'stage_excluded', 'unsupported_run', 'missing_evidence', 'withheld_evidence')),
  missing_evidence text[] not null check (cardinality(missing_evidence) <= 5),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) <= 5),
  created_at timestamptz not null default clock_timestamp(),
  unique (policy_id, run_id),
  foreign key (workspace_id, factory_id, policy_id, scorer_revision_id)
    references public.factory_scorer_sampling_policies(workspace_id, factory_id, id, scorer_revision_id) on delete cascade,
  check ((outcome = 'excluded') = (reason is not null)),
  check (outcome = 'excluded' or (
    attempt_count is not null and target_commit_sha is not null
    and cardinality(missing_evidence) = 0 and jsonb_array_length(evidence) > 0
  ))
);

create index factory_scorer_sample_receipts_run_idx
  on public.factory_scorer_sample_receipts(run_id);
create index factory_scorer_sample_receipts_cohort_idx
  on public.factory_scorer_sample_receipts(workspace_id, factory_id, policy_id, run_finished_at, run_id);
create index agent_runs_scorer_backfill_idx on public.agent_runs(workspace_id, finished_at, id)
  where finished_at is not null and status in ('success', 'error', 'canceled');

alter table public.factory_scorer_sampling_policies enable row level security;
alter table public.factory_scorer_sample_receipts enable row level security;
revoke all on public.factory_scorer_sampling_policies, public.factory_scorer_sample_receipts
  from public, anon, authenticated, service_role;
grant select on public.factory_scorer_sampling_policies to authenticated, service_role;
grant select on public.factory_scorer_sample_receipts to service_role;
create policy factory_scorer_sampling_policies_read on public.factory_scorer_sampling_policies
  for select to authenticated using (internal.can_access_factory(workspace_id, factory_id));

create function internal.guard_factory_scorer_sampling_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if not exists (
      select 1 from public.factories factory where (factory.workspace_id, factory.id) = (old.workspace_id, old.factory_id)
    ) then return old; end if;
    if tg_table_name = 'factory_scorer_sample_receipts' then
      if not exists (select 1 from public.agent_runs run where run.id = old.run_id) then return old; end if;
    end if;
  end if;
  raise exception 'Scorer sampling history is immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.guard_factory_scorer_sampling_history()
  from public, anon, authenticated, service_role;
create trigger factory_scorer_sampling_policies_immutable before update or delete
  on public.factory_scorer_sampling_policies for each row
  execute function internal.guard_factory_scorer_sampling_history();
create trigger factory_scorer_sample_receipts_immutable before update or delete
  on public.factory_scorer_sample_receipts for each row
  execute function internal.guard_factory_scorer_sampling_history();

create function public.save_factory_scorer_sampling_policy(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_scorer_revision_id uuid,
  p_expected_revision integer, p_rate_bps integer, p_seed text,
  p_terminal_statuses text[] default array['success']::text[], p_stage_ids uuid[] default '{}'::uuid[]
) returns public.factory_scorer_sampling_policies language plpgsql security definer set search_path = '' as $$
declare latest_revision integer; result public.factory_scorer_sampling_policies;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  -- The policy writer and the asynchronous live reader agree on the policy
  -- covering an event. Run completion does not take this lock.
  perform 1 from public.factory_scorer_revisions scorer
    where (scorer.workspace_id, scorer.factory_id, scorer.id) = (p_workspace_id, p_factory_id, p_scorer_revision_id)
    for no key update;
  if not found then raise exception 'Scorer revision is unavailable in this factory.' using errcode = 'P0002'; end if;

  select coalesce(max(policy.revision_number), 0) into latest_revision
  from public.factory_scorer_sampling_policies policy
  where (policy.workspace_id, policy.factory_id, policy.scorer_revision_id) =
    (p_workspace_id, p_factory_id, p_scorer_revision_id);
  if p_expected_revision is distinct from latest_revision then
    raise exception 'The sampling policy changed. Reload before saving.' using errcode = 'PT409';
  end if;
  if p_rate_bps is null or p_rate_bps not between 0 and 10000
    or p_seed is null or octet_length(p_seed) not between 1 and 128 or btrim(p_seed) = ''
    or p_terminal_statuses is null or array_ndims(p_terminal_statuses) is distinct from 1
    or not p_terminal_statuses <@ array['success', 'error', 'canceled']::text[]
    or cardinality(p_terminal_statuses) <> (select count(distinct status) from unnest(p_terminal_statuses) status)
    or p_stage_ids is null or coalesce(array_ndims(p_stage_ids), 1) <> 1 or cardinality(p_stage_ids) > 32
    or cardinality(p_stage_ids) <> (
      select count(distinct stage.id)
      from public.pipeline_stages stage
      join public.pipelines pipeline on (pipeline.workspace_id, pipeline.id) = (stage.workspace_id, stage.pipeline_id)
      where (pipeline.workspace_id, pipeline.factory_id) = (p_workspace_id, p_factory_id)
        and stage.id = any(p_stage_ids)
    ) then
    raise exception 'Invalid scorer sampling policy.' using errcode = '22023';
  end if;

  insert into public.factory_scorer_sampling_policies (
    workspace_id, factory_id, scorer_revision_id, revision_number, rate_bps, seed, terminal_statuses, stage_ids, created_by
  ) values (
    p_workspace_id, p_factory_id, p_scorer_revision_id, latest_revision + 1, p_rate_bps, p_seed,
    array(select status from unnest(p_terminal_statuses) status order by status),
    array(select id from unnest(p_stage_ids) id order by id), p_actor_user_id
  ) returning * into result;
  return result;
end;
$$;

create function internal.factory_scorer_sample_draw(p_seed text, p_run_id uuid)
returns bigint language sql immutable strict set search_path = '' as $$
  select (get_byte(hash, 0)::bigint << 24) + (get_byte(hash, 1)::bigint << 16)
    + (get_byte(hash, 2)::bigint << 8) + get_byte(hash, 3)
  from (
    select sha256(convert_to('wallie:factory-scorer-sampling:v1' || chr(10) || p_seed || chr(10) || p_run_id::text, 'UTF8')) hash
  ) fingerprint
$$;

create function internal.record_factory_scorer_sample(
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
    -- One stable representative per required kind proves eligibility. Asset
    -- reads still check current access, withholding and content integrity.
    with candidates(kind, id, withheld) as (
      select 'code_diff'::text, checkpoint.run_id, false
      union all
      select 'artifact', artifact.id, false
      from public.session_artifacts artifact
      where (artifact.workspace_id, artifact.session_id, artifact.id) =
        (p_policy.workspace_id, target.session_id, checkpoint.artifact_id)
      union all
      select 'validation_report', asset.id, withholding.asset_id is not null
      from public.session_validation_evidence validation
      join public.session_validation_assets asset on (asset.run_id, asset.workspace_id, asset.session_id) =
        (validation.run_id, validation.workspace_id, validation.session_id)
      left join public.session_validation_asset_withholdings withholding on withholding.asset_id = asset.id
      where (validation.run_id, validation.workspace_id, validation.session_id, validation.job_id,
        validation.attempt_count, validation.repository_id, validation.commit_sha) =
        (target.id, p_policy.workspace_id, target.session_id, target.agent_job_id,
          target.attempt_count, checkpoint.repository_id, checkpoint.output_sha)
        and asset.kind = 'report'
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
        (target.id, p_policy.workspace_id, target.session_id, target.agent_job_id,
          target.attempt_count, checkpoint.repository_id, checkpoint.output_sha)
        -- The asset's receipt is bound to this immutable plan by scoped FKs.
        -- The capture RPC verifies the plan's commit and tree before inserting both.
        and plan.plan->'version' = '2'::jsonb
        and asset.content_type in ('image/png', 'video/webm')
    ), requirements as (
      select requirement.kind, requirement.position, available.id,
        exists (select 1 from candidates candidate where candidate.kind = requirement.kind and candidate.withheld) as withheld
      from unnest(required_kinds) with ordinality requirement(kind, position)
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
    into retained_evidence, missing_kinds, includes_withheld
    from requirements;

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

create function public.record_factory_scorer_sample(
  p_workspace_id uuid, p_factory_id uuid, p_policy_id uuid, p_run_id uuid
) returns public.factory_scorer_sample_receipts language plpgsql security definer set search_path = '' as $$
declare policy public.factory_scorer_sampling_policies;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into policy from public.factory_scorer_sampling_policies candidate
    where (candidate.workspace_id, candidate.factory_id, candidate.id) = (p_workspace_id, p_factory_id, p_policy_id);
  if not found then raise exception 'Sampling policy is unavailable in this factory.' using errcode = 'P0002'; end if;
  return internal.record_factory_scorer_sample(policy, p_run_id);
end;
$$;

-- Timestamp and sequence ordering can skip an event whose transaction commits
-- late. Persist the top-level transaction ID on new observations, and advance
-- only through the prefix PostgreSQL confirms contains no in-flight writers.
alter table internal.factory_outcome_observations add column recorded_xact_id xid8;
alter table internal.factory_outcome_observations
  alter column recorded_xact_id set default pg_current_xact_id();
create index factory_outcome_observations_scorer_sampling_idx
  on internal.factory_outcome_observations(recorded_xact_id, id)
  where event_type = 'run.finished' and capture_mode = 'live' and recorded_xact_id is not null;
create table internal.factory_scorer_sampling_cursor (
  singleton boolean primary key default true check (singleton),
  last_xact_id xid8 not null,
  last_observation_id uuid not null,
  backfill_signing_key bytea not null default extensions.gen_random_bytes(32)
);
insert into internal.factory_scorer_sampling_cursor(last_xact_id, last_observation_id)
  values ('0'::xid8, '00000000-0000-0000-0000-000000000000');
alter table internal.factory_scorer_sampling_cursor enable row level security;
revoke all on internal.factory_scorer_sampling_cursor from public, anon, authenticated, service_role;

create function internal.factory_scorer_backfill_cursor(
  p_workspace_id uuid, p_factory_id uuid, p_policy_id uuid, p_before timestamptz,
  p_finished_at timestamptz, p_run_id uuid, p_horizon text
) returns text language sql stable strict set search_path = '' as $$
  select p_horizon || '.' || encode(extensions.hmac(convert_to(jsonb_build_array(
    p_workspace_id, p_factory_id, p_policy_id, extract(epoch from p_before),
    extract(epoch from p_finished_at), p_run_id, p_horizon
  )::text, 'UTF8'), control.backfill_signing_key, 'sha256'), 'hex')
  from internal.factory_scorer_sampling_cursor control where control.singleton;
$$;

create function public.backfill_factory_scorer_samples(
  p_workspace_id uuid, p_factory_id uuid, p_policy_id uuid, p_before timestamptz,
  p_after_finished_at timestamptz default null, p_after_run_id uuid default null,
  p_limit integer default 25, p_closed_before text default null
) returns table (
  candidate_count integer, eligible_count integer, sampled_count integer, excluded_count integer,
  next_finished_at timestamptz, next_run_id uuid, closed_before text
) language plpgsql security definer set search_path = '' as $$
declare
  policy public.factory_scorer_sampling_policies;
  candidate record;
  receipt public.factory_scorer_sample_receipts;
  horizon xid8 := pg_snapshot_xmin(pg_current_snapshot());
  cursor_horizon text;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_before is null or not isfinite(p_before) or p_before > clock_timestamp()
    or (p_after_finished_at is null) <> (p_after_run_id is null)
    or (p_after_finished_at is null) <> (p_closed_before is null)
    or not isfinite(p_after_finished_at)
    or p_after_finished_at >= p_before or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid scorer sampling backfill page.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.workspaces workspace where workspace.id = p_workspace_id and workspace.deletion_requested_at is null
  ) then raise exception 'Sampling workspace is unavailable.' using errcode = 'P0002'; end if;
  select * into policy from public.factory_scorer_sampling_policies scoped
    where (scoped.workspace_id, scoped.factory_id, scoped.id) = (p_workspace_id, p_factory_id, p_policy_id);
  if not found then raise exception 'Sampling policy is unavailable in this factory.' using errcode = 'P0002'; end if;
  if p_closed_before is not null then
    cursor_horizon := split_part(p_closed_before, '.', 1);
    if p_closed_before !~ '^[0-9]{1,20}[.][0-9a-f]{64}$' or p_closed_before is distinct from
      internal.factory_scorer_backfill_cursor(p_workspace_id, p_factory_id, p_policy_id, p_before,
        p_after_finished_at, p_after_run_id, cursor_horizon) then
      raise exception 'Invalid scorer sampling backfill cursor.' using errcode = '22023';
    end if;
    if cursor_horizon::xid8 > horizon then
      raise exception 'Scorer sampling backfill cursor is unavailable.' using errcode = '22023';
    end if;
    horizon := cursor_horizon::xid8;
  end if;

  candidate_count := 0;
  eligible_count := 0;
  sampled_count := 0;
  excluded_count := 0;
  for candidate in
    select run.id, run.finished_at from public.agent_runs run
    join public.sessions owner on (owner.workspace_id, owner.id) = (run.workspace_id, run.session_id)
    join public.workspaces workspace on workspace.id = owner.workspace_id and workspace.deletion_requested_at is null
    join public.factory_definition_revisions definition
      on (definition.workspace_id, definition.factory_id, definition.id) =
        (owner.workspace_id, owner.factory_id, owner.factory_definition_revision_id)
    where (owner.workspace_id, owner.factory_id) = (p_workspace_id, p_factory_id)
      and run.finished_at is not null and run.status in ('success', 'error', 'canceled')
      and run.finished_at < p_before
      and (p_after_finished_at is null or (run.finished_at, run.id) > (p_after_finished_at, p_after_run_id))
      and definition.schema_version = 2 and (definition.definition_json::jsonb->'scorerRevisionIds') ? policy.scorer_revision_id::text
      and exists (
        select 1 from internal.factory_outcome_observations observation
        -- This is the unique run.finished identity used by lifecycle capture.
        where (observation.workspace_id, observation.factory_id, observation.event_type, observation.source_kind,
          observation.source_key) = (run.workspace_id, p_factory_id, 'run.finished', 'run',
          run.id::text || ':' || coalesce(run.attempt_count, 0)::text)
          and (observation.run_id, observation.session_id, observation.definition_revision_id,
            observation.occurred_at, observation.status) =
            (run.id, run.session_id, definition.id, run.finished_at, run.status::text)
          and observation.job_id is not distinct from run.agent_job_id
          and observation.attempt_count is not distinct from run.attempt_count
          and observation.capture_mode = 'live'
          and (observation.recorded_xact_id is null or observation.recorded_xact_id < horizon)
      )
    order by run.finished_at, run.id limit p_limit + 1
  loop
    if candidate_count = p_limit then
      closed_before := internal.factory_scorer_backfill_cursor(p_workspace_id, p_factory_id, p_policy_id, p_before,
        next_finished_at, next_run_id, horizon::text);
      return next;
      return;
    end if;
    receipt := internal.record_factory_scorer_sample(policy, candidate.id);
    candidate_count := candidate_count + 1;
    eligible_count := eligible_count + (receipt.outcome <> 'excluded')::integer;
    sampled_count := sampled_count + (receipt.outcome = 'sampled')::integer;
    excluded_count := excluded_count + (receipt.outcome = 'excluded')::integer;
    next_finished_at := candidate.finished_at;
    next_run_id := candidate.id;
  end loop;
  next_finished_at := null;
  next_run_id := null;
  return next;
end;
$$;

create function public.process_factory_scorer_sampling(p_limit integer default 25)
returns table (candidate_count integer, eligible_count integer, sampled_count integer, excluded_count integer)
language plpgsql security definer set search_path = '' as $$
declare
  progress internal.factory_scorer_sampling_cursor;
  event record;
  scorer_id uuid;
  policy public.factory_scorer_sampling_policies;
  receipt public.factory_scorer_sample_receipts;
  closed_before xid8;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid live sampling batch size.' using errcode = '22023';
  end if;

  candidate_count := 0;
  eligible_count := 0;
  sampled_count := 0;
  excluded_count := 0;
  select * into progress from internal.factory_scorer_sampling_cursor for update skip locked;
  if not found then return next; return; end if;
  closed_before := pg_snapshot_xmin(pg_current_snapshot());

  for event in
    select observation.id, observation.recorded_xact_id, observation.workspace_id, observation.factory_id,
      observation.session_id, observation.run_id, observation.job_id, observation.attempt_count,
      observation.occurred_at, observation.observed_at, observation.status, observation.definition_revision_id
    from internal.factory_outcome_observations observation
    where observation.event_type = 'run.finished' and observation.capture_mode = 'live'
      and observation.recorded_xact_id is not null and observation.recorded_xact_id < closed_before
      and (observation.recorded_xact_id, observation.id) > (progress.last_xact_id, progress.last_observation_id)
    order by observation.recorded_xact_id, observation.id limit p_limit
  loop
    for scorer_id in
      select scorer.id
      from public.factory_definition_revisions definition
      join public.sessions owner on (owner.workspace_id, owner.factory_id, owner.factory_definition_revision_id) =
        (definition.workspace_id, definition.factory_id, definition.id)
      join public.workspaces workspace on workspace.id = owner.workspace_id and workspace.deletion_requested_at is null
      join public.agent_runs run on (run.workspace_id, run.session_id, run.id) = (owner.workspace_id, owner.id, event.run_id)
      cross join lateral jsonb_array_elements_text(definition.definition_json::jsonb->'scorerRevisionIds') as bind(id)
      join public.factory_scorer_revisions scorer
        on (scorer.workspace_id, scorer.factory_id, scorer.id) = (definition.workspace_id, definition.factory_id, bind.id::uuid)
      where (definition.workspace_id, definition.factory_id, definition.id) =
        (event.workspace_id, event.factory_id, event.definition_revision_id)
        and owner.id = event.session_id and definition.schema_version = 2
        and (run.finished_at, run.status::text) = (event.occurred_at, event.status)
        and run.agent_job_id is not distinct from event.job_id and run.attempt_count is not distinct from event.attempt_count
      order by scorer.id for share of scorer
    loop
      select * into policy from public.factory_scorer_sampling_policies revision
      where (revision.workspace_id, revision.factory_id, revision.scorer_revision_id) =
        (event.workspace_id, event.factory_id, scorer_id) and revision.created_at <= event.observed_at
      order by revision.revision_number desc limit 1;
      if not found then continue; end if;
      begin
        receipt := internal.record_factory_scorer_sample(policy, event.run_id);
      exception when no_data_found or foreign_key_violation then
        -- Deletion may commit between the candidate snapshot and receipt write.
        -- Skip only if the already-selected run's owning scope is now gone.
        if not exists (
          select 1 from public.agent_runs run
          join public.sessions owner on (owner.workspace_id, owner.id) = (run.workspace_id, run.session_id)
          join public.workspaces workspace on workspace.id = owner.workspace_id and workspace.deletion_requested_at is null
          where (run.id, owner.workspace_id, owner.factory_id, owner.id) =
            (event.run_id, event.workspace_id, event.factory_id, event.session_id)
        ) then continue; end if;
        raise;
      end;
      candidate_count := candidate_count + 1;
      eligible_count := eligible_count + (receipt.outcome <> 'excluded')::integer;
      sampled_count := sampled_count + (receipt.outcome = 'sampled')::integer;
      excluded_count := excluded_count + (receipt.outcome = 'excluded')::integer;
    end loop;
    progress.last_xact_id := event.recorded_xact_id;
    progress.last_observation_id := event.id;
  end loop;
  update internal.factory_scorer_sampling_cursor
    set last_xact_id = progress.last_xact_id, last_observation_id = progress.last_observation_id
    where (last_xact_id, last_observation_id) < (progress.last_xact_id, progress.last_observation_id);
  return next;
end;
$$;

revoke all on function internal.factory_scorer_sample_draw(text, uuid),
  internal.record_factory_scorer_sample(public.factory_scorer_sampling_policies, uuid),
  internal.factory_scorer_backfill_cursor(uuid, uuid, uuid, timestamptz, timestamptz, uuid, text),
  public.save_factory_scorer_sampling_policy(uuid, uuid, uuid, uuid, integer, integer, text, text[], uuid[]),
  public.record_factory_scorer_sample(uuid, uuid, uuid, uuid),
  public.backfill_factory_scorer_samples(uuid, uuid, uuid, timestamptz, timestamptz, uuid, integer, text),
  public.process_factory_scorer_sampling(integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.save_factory_scorer_sampling_policy(uuid, uuid, uuid, uuid, integer, integer, text, text[], uuid[]),
  public.record_factory_scorer_sample(uuid, uuid, uuid, uuid),
  public.backfill_factory_scorer_samples(uuid, uuid, uuid, timestamptz, timestamptz, uuid, integer, text),
  public.process_factory_scorer_sampling(integer) to service_role;
