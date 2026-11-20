-- Evaluation has its own concurrency mutex, queue, and attempt history.
create table public.factory_evaluation_lanes (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  paused boolean not null default false,
  max_concurrent integer not null default 2 check (max_concurrent between 1 and 16),
  revision integer not null default 0 check (revision >= 0),
  updated_by uuid,
  updated_at timestamptz,
  check ((revision = 0 and updated_by is null and updated_at is null)
    or (revision > 0 and updated_by is not null and updated_at is not null))
);

create table public.factory_evaluation_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.factory_evaluation_lanes(workspace_id) on delete cascade,
  factory_id uuid not null,
  session_id uuid not null,
  run_id uuid not null,
  scorer_revision_id uuid not null,
  sample_receipt_id uuid not null references public.factory_scorer_sample_receipts(id) on delete cascade,
  target_commit_sha text not null check (target_commit_sha ~ '^[0-9a-f]{40}$'),
  status text not null default 'queued' check (status in ('queued', 'claimed', 'succeeded', 'failed', 'canceled')),
  attempt_count integer not null default 0,
  attempt_limit integer not null default 3 check (attempt_limit between 1 and 6),
  available_at timestamptz default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  unique (workspace_id, factory_id, run_id, scorer_revision_id),
  unique (id, workspace_id, factory_id),
  check (attempt_count between 0 and attempt_limit),
  check ((status = 'queued') = (available_at is not null)),
  check (status <> 'queued' or attempt_count < attempt_limit),
  check ((status in ('succeeded', 'failed', 'canceled')) = (finished_at is not null)),
  check (status in ('queued', 'canceled') or attempt_count > 0)
);

create table public.factory_evaluation_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  attempt_number integer not null check (attempt_number between 1 and 6),
  lease_id uuid not null default gen_random_uuid() unique,
  claimed_at timestamptz not null,
  lease_expires_at timestamptz not null check (lease_expires_at > claimed_at),
  settled_at timestamptz check (settled_at >= claimed_at),
  outcome text check (outcome in ('succeeded', 'retryable_failure', 'permanent_failure', 'lease_expired', 'canceled')),
  unique (job_id, attempt_number),
  foreign key (job_id, workspace_id, factory_id)
    references public.factory_evaluation_jobs(id, workspace_id, factory_id) on delete cascade,
  check ((settled_at is null) = (outcome is null))
);

create index factory_evaluation_jobs_ready_idx
  on public.factory_evaluation_jobs(workspace_id, available_at, id) where status = 'queued';
create index factory_evaluation_jobs_sample_idx on public.factory_evaluation_jobs(sample_receipt_id);
create unique index factory_evaluation_attempts_active_job_idx
  on public.factory_evaluation_attempts(job_id) where settled_at is null;
create index factory_evaluation_attempts_capacity_idx
  on public.factory_evaluation_attempts(workspace_id, lease_expires_at) where settled_at is null;
create index factory_evaluation_attempts_expiry_idx
  on public.factory_evaluation_attempts(lease_expires_at, job_id) where settled_at is null;

alter table public.factory_evaluation_lanes enable row level security;
alter table public.factory_evaluation_jobs enable row level security;
alter table public.factory_evaluation_attempts enable row level security;
revoke all on public.factory_evaluation_lanes, public.factory_evaluation_jobs, public.factory_evaluation_attempts
  from public, anon, authenticated, service_role;
grant select on public.factory_evaluation_lanes, public.factory_evaluation_jobs, public.factory_evaluation_attempts to service_role;

create function internal.guard_factory_evaluation_job()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.factory_scorer_sample_receipts sample where sample.id = old.sample_receipt_id)
      or not exists (select 1 from public.factory_evaluation_lanes lane where lane.workspace_id = old.workspace_id) then
      return old;
    end if;
  elsif old.status in ('queued', 'claimed') and
    (new.id, new.workspace_id, new.factory_id, new.session_id, new.run_id, new.scorer_revision_id,
      new.sample_receipt_id, new.target_commit_sha, new.created_at, new.attempt_limit)
    is not distinct from
    (old.id, old.workspace_id, old.factory_id, old.session_id, old.run_id, old.scorer_revision_id,
      old.sample_receipt_id, old.target_commit_sha, old.created_at, old.attempt_limit) then
    return new;
  end if;
  raise exception 'Evaluation job identity and terminal history are immutable.' using errcode = '23514';
end;
$$;
create trigger factory_evaluation_jobs_immutable before update or delete on public.factory_evaluation_jobs
  for each row execute function internal.guard_factory_evaluation_job();

create function internal.guard_factory_evaluation_attempt()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.factory_evaluation_jobs job where job.id = old.job_id) then return old; end if;
  elsif old.settled_at is null and new.settled_at is not null and
    (new.id, new.job_id, new.workspace_id, new.factory_id, new.attempt_number, new.lease_id, new.claimed_at, new.lease_expires_at)
    is not distinct from
    (old.id, old.job_id, old.workspace_id, old.factory_id, old.attempt_number, old.lease_id, old.claimed_at, old.lease_expires_at) then
    return new;
  end if;
  raise exception 'Evaluation attempt identity and settled history are immutable.' using errcode = '23514';
end;
$$;
create trigger factory_evaluation_attempts_immutable before update or delete on public.factory_evaluation_attempts
  for each row execute function internal.guard_factory_evaluation_attempt();

create function internal.admit_factory_evaluation_job(p_sample public.factory_scorer_sample_receipts)
returns boolean language plpgsql set search_path = '' as $$
begin
  if p_sample.outcome is distinct from 'sampled' then return false; end if;
  if not exists (
    select 1 from public.factory_scorer_sample_receipts receipt
    join public.workspaces workspace on workspace.id = receipt.workspace_id and workspace.deletion_requested_at is null
    where (receipt.workspace_id, receipt.factory_id, receipt.id) = (p_sample.workspace_id, p_sample.factory_id, p_sample.id)
  ) then return false; end if;
  insert into public.factory_evaluation_lanes(workspace_id)
    values (p_sample.workspace_id) on conflict (workspace_id) do nothing;
  insert into public.factory_evaluation_jobs (
    workspace_id, factory_id, session_id, run_id, scorer_revision_id, sample_receipt_id, target_commit_sha
  ) values (
    p_sample.workspace_id, p_sample.factory_id, p_sample.session_id, p_sample.run_id,
    p_sample.scorer_revision_id, p_sample.id, p_sample.target_commit_sha
  ) on conflict (workspace_id, factory_id, run_id, scorer_revision_id) do nothing;
  return found;
end;
$$;

create function internal.admit_sampled_factory_evaluation_job()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform internal.admit_factory_evaluation_job(new);
  return new;
end;
$$;

-- Freeze the initial backlog while installing the live receipt trigger. New
-- receipts after this transaction always take the live path.
create table internal.factory_evaluation_admission_progress (
  singleton boolean primary key default true check (singleton),
  before_created_at timestamptz not null,
  before_receipt_id uuid not null,
  last_created_at timestamptz not null default '-infinity',
  last_receipt_id uuid not null default '00000000-0000-0000-0000-000000000000',
  completed boolean not null default false
);
alter table internal.factory_evaluation_admission_progress enable row level security;
revoke all on internal.factory_evaluation_admission_progress from public, anon, authenticated, service_role;
create index factory_scorer_sample_receipts_evaluation_backlog_idx
  on public.factory_scorer_sample_receipts(created_at, id) where outcome = 'sampled';
create trigger factory_evaluation_job_from_sample after insert on public.factory_scorer_sample_receipts
  for each row when (new.outcome = 'sampled') execute function internal.admit_sampled_factory_evaluation_job();
insert into internal.factory_evaluation_admission_progress(before_created_at, before_receipt_id, completed)
select coalesce(latest.created_at, '-infinity'), coalesce(latest.id, '00000000-0000-0000-0000-000000000000'),
  latest.id is null
from (values (true)) as control(singleton)
left join lateral (
  select sample.created_at, sample.id from public.factory_scorer_sample_receipts sample
  where sample.outcome = 'sampled' order by sample.created_at desc, sample.id desc limit 1
) latest on control.singleton;

create function internal.assert_factory_evaluation_workspace_manager(p_workspace_id uuid, p_actor_user_id uuid)
returns uuid language plpgsql set search_path = '' as $$
declare actor_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  perform 1 from public.workspaces workspace
    where workspace.id = p_workspace_id and workspace.deletion_requested_at is null for share;
  if not found then raise exception 'Evaluation workspace is unavailable.' using errcode = 'P0002'; end if;

  select member.id into actor_id from public.workspace_members member
    where (member.workspace_id, member.user_id) = (p_workspace_id, p_actor_user_id)
      and member.kind = 'human' and member.is_active and member.role in ('owner', 'admin') for share;
  if not found then raise exception 'Workspace manager access is required.' using errcode = '42501'; end if;
  return actor_id;
end;
$$;

create function public.get_factory_evaluation_lane(p_workspace_id uuid, p_actor_user_id uuid)
returns public.factory_evaluation_lanes language plpgsql security definer set search_path = '' as $$
declare lane public.factory_evaluation_lanes;
begin
  perform internal.assert_factory_evaluation_workspace_manager(p_workspace_id, p_actor_user_id);
  select * into lane from public.factory_evaluation_lanes stored where stored.workspace_id = p_workspace_id;
  if not found then lane := row(p_workspace_id, false, 2, 0, null, null)::public.factory_evaluation_lanes; end if;
  return lane;
end;
$$;

create function public.configure_factory_evaluation_lane(
  p_workspace_id uuid, p_actor_user_id uuid, p_expected_revision integer, p_paused boolean, p_max_concurrent integer
) returns public.factory_evaluation_lanes language plpgsql security definer set search_path = '' as $$
declare actor_id uuid; lane public.factory_evaluation_lanes;
begin
  actor_id := internal.assert_factory_evaluation_workspace_manager(p_workspace_id, p_actor_user_id);
  if p_expected_revision is null or p_expected_revision < 0 or p_paused is null
    or p_max_concurrent is null or p_max_concurrent not between 1 and 16 then
    raise exception 'Invalid evaluation lane settings.' using errcode = '22023';
  end if;

  insert into public.factory_evaluation_lanes(workspace_id)
    values (p_workspace_id) on conflict (workspace_id) do nothing;
  update public.factory_evaluation_lanes stored
    set paused = p_paused, max_concurrent = p_max_concurrent, revision = stored.revision + 1,
      updated_by = actor_id, updated_at = clock_timestamp()
    where stored.workspace_id = p_workspace_id and stored.revision = p_expected_revision
    returning * into lane;
  if not found then raise exception 'The evaluation lane changed. Reload before saving.' using errcode = 'PT409'; end if;
  return lane;
end;
$$;

create function public.claim_factory_evaluation_job()
returns table (
  job_id uuid, workspace_id uuid, factory_id uuid, session_id uuid, run_id uuid, scorer_revision_id uuid,
  sample_receipt_id uuid, target_commit_sha text, attempt_id uuid, attempt_number integer,
  lease_id uuid, lease_expires_at timestamptz
) language plpgsql security definer set search_path = '' as $$
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
    where not lane.paused and not exists (
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

-- The lock and exact attempt check are shared with future result adoption.
create function internal.lock_factory_evaluation_claim(
  p_workspace_id uuid, p_factory_id uuid, p_job_id uuid, p_attempt_id uuid, p_lease_id uuid
) returns public.factory_evaluation_attempts language plpgsql set search_path = '' as $$
declare job public.factory_evaluation_jobs; attempt public.factory_evaluation_attempts;
begin
  select * into job from public.factory_evaluation_jobs candidate
    where (candidate.workspace_id, candidate.factory_id, candidate.id) = (p_workspace_id, p_factory_id, p_job_id)
      and candidate.status = 'claimed' for update;
  if not found then return null; end if;
  select * into attempt from public.factory_evaluation_attempts current_attempt
    where (current_attempt.job_id, current_attempt.attempt_number, current_attempt.id, current_attempt.lease_id) =
      (job.id, job.attempt_count, p_attempt_id, p_lease_id)
      and current_attempt.settled_at is null for update;
  if not found or attempt.lease_expires_at <= clock_timestamp() then return null; end if;
  return attempt;
end;
$$;

create function internal.settle_locked_factory_evaluation_attempt(
  p_job public.factory_evaluation_jobs, p_attempt public.factory_evaluation_attempts, p_outcome text
) returns public.factory_evaluation_jobs language plpgsql set search_path = '' as $$
declare
  next_status text;
  finished timestamptz := clock_timestamp();
  result public.factory_evaluation_jobs;
begin
  next_status := case
    when p_outcome = 'succeeded' then 'succeeded'
    when p_outcome = 'canceled' then 'canceled'
    when p_outcome = 'permanent_failure' or p_job.attempt_count >= p_job.attempt_limit then 'failed'
    else 'queued'
  end;
  update public.factory_evaluation_attempts attempt set settled_at = finished, outcome = p_outcome
    where (attempt.id, attempt.job_id, attempt.attempt_number, attempt.lease_id) =
      (p_attempt.id, p_job.id, p_job.attempt_count, p_attempt.lease_id) and attempt.settled_at is null;
  if not found then raise exception 'Evaluation attempt is no longer current.' using errcode = '23514'; end if;
  update public.factory_evaluation_jobs job set status = next_status,
    available_at = case when next_status = 'queued'
      then finished + make_interval(secs => least(60, 5 * (1 << (p_job.attempt_count - 1)))) end,
    finished_at = case when next_status <> 'queued' then finished end
    where (job.id, job.status, job.attempt_count) = (p_job.id, 'claimed', p_job.attempt_count)
    returning * into strict result;
  return result;
end;
$$;

create function public.settle_factory_evaluation_attempt(
  p_workspace_id uuid, p_factory_id uuid, p_job_id uuid, p_attempt_id uuid, p_lease_id uuid, p_outcome text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare job public.factory_evaluation_jobs; attempt public.factory_evaluation_attempts;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_outcome is null or p_outcome not in ('succeeded', 'retryable_failure', 'permanent_failure') then
    raise exception 'Invalid evaluation attempt outcome.' using errcode = '22023';
  end if;
  attempt := internal.lock_factory_evaluation_claim(p_workspace_id, p_factory_id, p_job_id, p_attempt_id, p_lease_id);
  if attempt.id is null then return false; end if;
  select * into strict job from public.factory_evaluation_jobs target where target.id = attempt.job_id;
  perform internal.settle_locked_factory_evaluation_attempt(job, attempt, p_outcome);
  return true;
end;
$$;

create function public.cancel_factory_evaluation_job(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_job_id uuid
) returns public.factory_evaluation_jobs language plpgsql security definer set search_path = '' as $$
declare job public.factory_evaluation_jobs; attempt public.factory_evaluation_attempts;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into job from public.factory_evaluation_jobs target
    where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_job_id) for update;
  if not found then raise exception 'Evaluation job is unavailable in this factory.' using errcode = 'P0002'; end if;
  if job.status = 'claimed' then
    select * into strict attempt from public.factory_evaluation_attempts current_attempt
      where (current_attempt.job_id, current_attempt.attempt_number) = (job.id, job.attempt_count)
        and current_attempt.settled_at is null for update;
    return internal.settle_locked_factory_evaluation_attempt(job, attempt, 'canceled');
  end if;
  if job.status = 'queued' then
    update public.factory_evaluation_jobs target
      set status = 'canceled', available_at = null, finished_at = clock_timestamp()
      where target.id = job.id returning * into job;
  end if;
  return job;
end;
$$;

create function public.maintain_factory_evaluation_queue(p_limit integer default 25)
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
      where receipt.outcome = 'sampled'
        and (receipt.created_at, receipt.id) <= (cursor_position.before_created_at, cursor_position.before_receipt_id)
        and (receipt.created_at, receipt.id) > (cursor_position.last_created_at, cursor_position.last_receipt_id)
        and not exists (
          select 1 from public.factory_evaluation_jobs queued
          where (queued.workspace_id, queued.factory_id, queued.run_id, queued.scorer_revision_id) =
            (receipt.workspace_id, receipt.factory_id, receipt.run_id, receipt.scorer_revision_id)
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

revoke all on function internal.guard_factory_evaluation_job(), internal.guard_factory_evaluation_attempt(),
  internal.admit_factory_evaluation_job(public.factory_scorer_sample_receipts), internal.admit_sampled_factory_evaluation_job(),
  internal.assert_factory_evaluation_workspace_manager(uuid, uuid),
  internal.lock_factory_evaluation_claim(uuid, uuid, uuid, uuid, uuid),
  internal.settle_locked_factory_evaluation_attempt(public.factory_evaluation_jobs, public.factory_evaluation_attempts, text),
  public.get_factory_evaluation_lane(uuid, uuid), public.configure_factory_evaluation_lane(uuid, uuid, integer, boolean, integer),
  public.claim_factory_evaluation_job(), public.settle_factory_evaluation_attempt(uuid, uuid, uuid, uuid, uuid, text),
  public.cancel_factory_evaluation_job(uuid, uuid, uuid, uuid), public.maintain_factory_evaluation_queue(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_factory_evaluation_lane(uuid, uuid),
  public.configure_factory_evaluation_lane(uuid, uuid, integer, boolean, integer),
  public.claim_factory_evaluation_job(), public.settle_factory_evaluation_attempt(uuid, uuid, uuid, uuid, uuid, text),
  public.cancel_factory_evaluation_job(uuid, uuid, uuid, uuid), public.maintain_factory_evaluation_queue(integer) to service_role;
