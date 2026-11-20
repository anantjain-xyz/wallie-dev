-- Freeze the append-only facts across chart and drilldown reads. The lock
-- taken when these columns are installed closes the pre-existing NULL baseline.
alter table public.factory_scorer_sample_receipts add column recorded_xact_id xid8;
alter table public.factory_scorer_sample_receipts alter column recorded_xact_id set default pg_current_xact_id();
alter table public.factory_evaluation_receipts add column recorded_xact_id xid8;
alter table public.factory_evaluation_receipts alter column recorded_xact_id set default pg_current_xact_id();
alter table public.factory_evaluation_jobs add column canceled_recorded_xact_id xid8,
  add constraint factory_evaluation_jobs_cancel_watermark_check
    check (status = 'canceled' or canceled_recorded_xact_id is null);

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
      new.sample_receipt_id, new.target_commit_sha, new.created_at, new.attempt_limit, new.canceled_recorded_xact_id)
    is not distinct from
    (old.id, old.workspace_id, old.factory_id, old.session_id, old.run_id, old.scorer_revision_id,
      old.sample_receipt_id, old.target_commit_sha, old.created_at, old.attempt_limit, old.canceled_recorded_xact_id) then
    if new.status = 'canceled' then new.canceled_recorded_xact_id := pg_current_xact_id(); end if;
    return new;
  end if;
  raise exception 'Evaluation job identity and terminal history are immutable.' using errcode = '23514';
end;
$$;

-- Keep the OP-606 projection stable when adding its private scan watermark.
create or replace function internal.project_factory_evaluation_receipt(p_receipt public.factory_evaluation_receipts)
returns jsonb language plpgsql stable set search_path = '' as $$
declare availability text := internal.factory_evaluation_receipt_evidence_availability(p_receipt);
begin
  return (to_jsonb(p_receipt) - 'recorded_xact_id') || jsonb_build_object(
    'evidence_availability', availability,
    'score', p_receipt.result->'score',
    'result', case when availability = 'available' then p_receipt.result end,
    'explanation', case when availability = 'available' then p_receipt.explanation end,
    'evidence_locations', case when availability = 'available' then p_receipt.evidence_locations end,
    'evidence_digest', case when availability = 'available' then p_receipt.evidence_digest end
  );
end;
$$;

create index factory_scorer_sampling_policies_trend_options_idx
  on public.factory_scorer_sampling_policies(workspace_id, factory_id, created_at desc, id desc);
create index factory_scorer_sample_receipts_run_latest_idx
  on public.factory_scorer_sample_receipts(workspace_id, factory_id, run_id, scorer_revision_id, created_at desc, id desc);

create function internal.require_factory_score_read(p_workspace_id uuid, p_factory_id uuid)
returns void language plpgsql stable set search_path = '' as $$
begin
  if auth.uid() is null or not internal.can_read_factory_evaluation_receipts(p_workspace_id, p_factory_id, auth.uid()) then
    raise exception 'Evaluation factory is unavailable.' using errcode = 'P0002';
  end if;
end;
$$;

create function internal.factory_score_cohort_metadata(
  p_policy public.factory_scorer_sampling_policies,
  p_revision public.factory_scorer_revisions,
  p_scorer public.factory_scorers
) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'policy_id', p_policy.id,
    'policy_revision_number', p_policy.revision_number,
    'scorer_id', p_scorer.id,
    'scorer_revision_id', p_revision.id,
    'scorer_revision_number', p_revision.revision_number,
    'scorer_name', p_scorer.name,
    'scorer_slug', p_scorer.slug,
    'rate_bps', p_policy.rate_bps,
    'terminal_statuses', p_policy.terminal_statuses,
    'stage_ids', p_policy.stage_ids,
    'created_at', p_policy.created_at
  )
$$;

create function public.list_factory_score_cohorts(
  p_workspace_id uuid, p_factory_id uuid,
  p_scorer_id uuid default null, p_scorer_revision_id uuid default null,
  p_limit integer default 25, p_before_created_at timestamptz default null, p_before_policy_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform internal.require_factory_score_read(p_workspace_id, p_factory_id);
  if p_limit is null or p_limit not between 1 and 100
    or (p_before_created_at is null) <> (p_before_policy_id is null)
    or not isfinite(p_before_created_at) then
    raise exception 'Invalid evaluation cohort page.' using errcode = '22023';
  end if;
  with page as materialized (
    select policy.created_at, policy.id,
      internal.factory_score_cohort_metadata(policy, revision, scorer) as item
    from public.factory_scorer_sampling_policies policy
    join public.factory_scorer_revisions revision
      on (revision.workspace_id, revision.factory_id, revision.id) =
        (policy.workspace_id, policy.factory_id, policy.scorer_revision_id)
    join public.factory_scorers scorer on (scorer.workspace_id, scorer.factory_id, scorer.id) =
      (revision.workspace_id, revision.factory_id, revision.scorer_id)
    where (policy.workspace_id, policy.factory_id) = (p_workspace_id, p_factory_id)
      and (p_scorer_id is null or scorer.id = p_scorer_id)
      and (p_scorer_revision_id is null or revision.id = p_scorer_revision_id)
      and (p_before_created_at is null or (policy.created_at, policy.id) < (p_before_created_at, p_before_policy_id))
    order by policy.created_at desc, policy.id desc limit p_limit + 1
  ), visible as materialized (
    select * from page order by created_at desc, id desc limit p_limit
  ), boundary as (
    select visible.created_at, visible.id from visible where (select count(*) from page) > p_limit
    order by visible.created_at, visible.id limit 1
  )
  select jsonb_build_object(
    'cohorts', coalesce((select jsonb_agg(item order by created_at desc, id desc) from visible), '[]'),
    'next_created_at', (select created_at from boundary),
    'next_policy_id', (select id from boundary)
  ) into result;
  return result;
end;
$$;

-- Use the existing private sampling signing key with a separate purpose
-- domain. The cursor fixes the scope, policy, time window and closed XID prefix.
create function internal.factory_score_cohort_snapshot(
  p_workspace_id uuid, p_factory_id uuid, p_policy_id uuid,
  p_from timestamptz, p_to timestamptz, p_horizon text
) returns text language sql stable strict set search_path = '' as $$
  select p_horizon || '.' || encode(extensions.hmac(convert_to(jsonb_build_array(
    'factory-score-cohort-v1', p_workspace_id, p_factory_id, p_policy_id,
    extract(epoch from p_from), extract(epoch from p_to), p_horizon
  )::text, 'UTF8'), control.backfill_signing_key, 'sha256'), 'hex')
  from internal.factory_scorer_sampling_cursor control where control.singleton
$$;

create function public.read_factory_score_cohort(
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
      case when cancellation.visible then 'canceled' else coalesce(latest.reason, sample.reason) end as reason,
      case when not cancellation.visible then latest.result->'score' end as score
    from population sample
    cross join bounds
    left join public.factory_evaluation_jobs job
      on sample.outcome = 'sampled'
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

-- The run panel presents a GitHub compare only for a scope-checked, retained
-- diff that this exact evaluation used. It has no credential or private path.
create function internal.factory_score_diff_facts(
  p_receipt public.factory_evaluation_receipts, p_projected_receipt jsonb
) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'repository_full_name', repository.full_name,
    'input_sha', checkpoint.input_sha,
    'output_sha', checkpoint.output_sha
  )
  from public.session_git_checkpoints checkpoint
  join public.github_repositories repository on (repository.workspace_id, repository.factory_id, repository.id) =
    (p_receipt.workspace_id, p_receipt.factory_id, checkpoint.repository_id)
  join public.github_installations installation on (installation.workspace_id, installation.id) =
    (repository.workspace_id, repository.github_installation_id)
  where (checkpoint.workspace_id, checkpoint.session_id, checkpoint.run_id, checkpoint.output_sha) =
    (p_receipt.workspace_id, p_receipt.session_id, p_receipt.run_id, p_receipt.target_commit_sha)
    and not repository.is_archived and not installation.suspended
    and repository.full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
    and p_projected_receipt->>'evidence_availability' = 'available'
    and exists (
      select 1 from jsonb_array_elements(p_projected_receipt#>'{result,evidence}') item
      where item->>'kind' = 'code_diff' and item->>'id' = checkpoint.run_id::text
    )
$$;

create function public.list_factory_run_score_results(
  p_workspace_id uuid, p_factory_id uuid, p_run_id uuid, p_attempt_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; result_count integer;
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
    select job.id, job.status, job.sample_receipt_id, job.scorer_revision_id
    from public.factory_evaluation_jobs job
    where (job.workspace_id, job.factory_id, job.run_id) = (p_workspace_id, p_factory_id, p_run_id)
  ), latest_unqueued_samples as (
    select distinct on (sample.scorer_revision_id) sample.id, sample.scorer_revision_id
    from public.factory_scorer_sample_receipts sample
    where (sample.workspace_id, sample.factory_id, sample.run_id) = (p_workspace_id, p_factory_id, p_run_id)
      and not exists (select 1 from scoped_jobs job where job.scorer_revision_id = sample.scorer_revision_id)
    order by sample.scorer_revision_id, sample.created_at desc, sample.id desc
  ), selection as (
    select job.id as evaluation_job_id, job.status as job_status, job.sample_receipt_id, job.scorer_revision_id
    from scoped_jobs job
    union all
    select null::uuid, null::text, sample.id, sample.scorer_revision_id from latest_unqueued_samples sample
  ), results as materialized (
    select scorer.name, scorer.id as scorer_id, revision.revision_number, selected.evaluation_job_id, jsonb_build_object(
      'evaluation_job_id', selected.evaluation_job_id,
      'scorer_id', scorer.id,
      'scorer_revision_id', revision.id,
      'scorer_revision_number', revision.revision_number,
      'scorer_name', scorer.name,
      'scorer_slug', scorer.slug,
      'job_status', selected.job_status,
      'sample_outcome', membership.outcome,
      'sample_reason', membership.reason,
      'receipt', projection.receipt,
      'diff', internal.factory_score_diff_facts(latest.item, projection.receipt)
    ) as item
    from selection selected
    join public.factory_scorer_sample_receipts membership
      on (membership.workspace_id, membership.factory_id, membership.run_id, membership.scorer_revision_id, membership.id) =
        (p_workspace_id, p_factory_id, p_run_id, selected.scorer_revision_id, selected.sample_receipt_id)
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
    order by scorer.name, scorer.id, revision.revision_number, selected.evaluation_job_id limit 33
  )
  select count(*), coalesce(jsonb_agg(item order by name, scorer_id, revision_number, evaluation_job_id), '[]')
    into result_count, result from results;
  if result_count > 32 then raise exception 'Too many scorer results for one run.' using errcode = 'PT422'; end if;
  return result;
end;
$$;

revoke all on function internal.require_factory_score_read(uuid, uuid),
  internal.factory_score_cohort_metadata(public.factory_scorer_sampling_policies, public.factory_scorer_revisions, public.factory_scorers),
  internal.factory_score_cohort_snapshot(uuid, uuid, uuid, timestamptz, timestamptz, text),
  internal.factory_score_diff_facts(public.factory_evaluation_receipts, jsonb),
  public.list_factory_score_cohorts(uuid, uuid, uuid, uuid, integer, timestamptz, uuid),
  public.read_factory_score_cohort(uuid, uuid, uuid, timestamptz, timestamptz, text, timestamptz, text, timestamptz, uuid, integer),
  public.list_factory_run_score_results(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_factory_score_cohorts(uuid, uuid, uuid, uuid, integer, timestamptz, uuid),
  public.read_factory_score_cohort(uuid, uuid, uuid, timestamptz, timestamptz, text, timestamptz, text, timestamptz, uuid, integer),
  public.list_factory_run_score_results(uuid, uuid, uuid, uuid) to authenticated;
