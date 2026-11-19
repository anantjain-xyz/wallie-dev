-- A canonical provider PR contributes a single merge identity, even when
-- several generations run, publish or observe it.
create table internal.factory_canonical_pull_request_merges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  source_host text not null default 'github.com' check (source_host = 'github.com'),
  repository_id uuid not null,
  github_repository_id bigint not null check (github_repository_id between 1 and 9007199254740991),
  pull_request_number integer not null check (pull_request_number > 0),
  session_id uuid not null,
  epoch_id uuid not null references public.session_pr_epochs(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) on delete cascade,
  unique (workspace_id, source_host, github_repository_id, pull_request_number)
);
create index factory_canonical_pull_request_merges_factory_idx
  on internal.factory_canonical_pull_request_merges (workspace_id, factory_id, id);
create index factory_canonical_pull_request_merges_epoch_idx
  on internal.factory_canonical_pull_request_merges (epoch_id);
create index factory_canonical_pull_request_merges_session_idx
  on internal.factory_canonical_pull_request_merges (session_id);

create table internal.factory_canonical_pull_request_merge_observations (
  id uuid primary key default gen_random_uuid(),
  merge_id uuid not null references internal.factory_canonical_pull_request_merges(id) on delete cascade,
  provider_updated_at timestamptz not null check (isfinite(provider_updated_at)),
  merged_at timestamptz not null check (isfinite(merged_at) and merged_at <= provider_updated_at),
  merge_commit_sha text not null check (merge_commit_sha ~ '^[a-f0-9]{40}$'),
  merge_source_head_sha text not null check (merge_source_head_sha ~ '^[a-f0-9]{40}$'),
  observed_at timestamptz not null default clock_timestamp(),
  source text not null check (source in ('sync', 'webhook')),
  unique (merge_id, provider_updated_at, merged_at, merge_commit_sha, merge_source_head_sha)
);

-- A fence token may confirm the same snapshot as a previous reader. Bind
-- each accepted token once so replay cannot substitute a different snapshot.
create table internal.factory_canonical_pull_request_merge_receipts (
  id uuid primary key,
  observation_id uuid not null
    references internal.factory_canonical_pull_request_merge_observations(id) on delete cascade,
  source text not null check (source in ('sync', 'webhook')),
  observed_at timestamptz not null default clock_timestamp()
);
create index factory_canonical_pull_request_merge_receipts_observation_idx
  on internal.factory_canonical_pull_request_merge_receipts (observation_id);

create table internal.factory_canonical_pull_request_merge_runs (
  observation_id uuid not null
    references internal.factory_canonical_pull_request_merge_observations(id) on delete cascade,
  run_id uuid not null,
  attempt_count integer not null check (attempt_count > 0),
  operation_id uuid not null,
  primary key (observation_id, run_id, attempt_count)
);

alter table internal.factory_canonical_pull_request_merges enable row level security;
alter table internal.factory_canonical_pull_request_merge_observations enable row level security;
alter table internal.factory_canonical_pull_request_merge_receipts enable row level security;
alter table internal.factory_canonical_pull_request_merge_runs enable row level security;
revoke all on internal.factory_canonical_pull_request_merges,
  internal.factory_canonical_pull_request_merge_observations,
  internal.factory_canonical_pull_request_merge_receipts,
  internal.factory_canonical_pull_request_merge_runs from public, anon, authenticated, service_role;

create function internal.guard_factory_canonical_merge_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    case tg_table_name
      when 'factory_canonical_pull_request_merges' then
        if not exists (select 1 from public.sessions where id = old.session_id)
          or not exists (select 1 from public.session_pr_epochs where id = old.epoch_id)
        then return old; end if;
      when 'factory_canonical_pull_request_merge_observations' then
        if not exists (select 1 from internal.factory_canonical_pull_request_merges where id = old.merge_id)
        then return old; end if;
      else
        if not exists (
          select 1 from internal.factory_canonical_pull_request_merge_observations where id = old.observation_id
        ) then return old; end if;
    end case;
  end if;
  raise exception 'Canonical pull request merge evidence is immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.guard_factory_canonical_merge_history() from public, anon, authenticated, service_role;
create trigger factory_canonical_merge_history_immutable
  before update or delete on internal.factory_canonical_pull_request_merges
  for each row execute function internal.guard_factory_canonical_merge_history();
create trigger factory_canonical_merge_observation_immutable
  before update or delete on internal.factory_canonical_pull_request_merge_observations
  for each row execute function internal.guard_factory_canonical_merge_history();
create trigger factory_canonical_merge_receipt_immutable
  before update or delete on internal.factory_canonical_pull_request_merge_receipts
  for each row execute function internal.guard_factory_canonical_merge_history();
create trigger factory_canonical_merge_run_immutable
  before update or delete on internal.factory_canonical_pull_request_merge_runs
  for each row execute function internal.guard_factory_canonical_merge_history();

-- A strictly newer provider snapshot supersedes older proof. Equal provider
-- timestamps cannot order conflicting values, so such evidence stays unresolved.
create view internal.current_factory_canonical_pull_request_merges with (security_invoker = true) as
select merge.*, snapshot.provider_updated_at,
  case when ambiguity.conflicting then 'conflicting' else 'observed' end as status,
  case when not ambiguity.conflicting then snapshot.id end as observation_id,
  case when not ambiguity.conflicting then snapshot.merged_at end as merged_at,
  case when not ambiguity.conflicting then snapshot.merge_commit_sha end as merge_commit_sha,
  case when not ambiguity.conflicting then snapshot.merge_source_head_sha end as merge_source_head_sha,
  snapshot.observed_at
from internal.factory_canonical_pull_request_merges merge
cross join lateral (
  select fact.* from internal.factory_canonical_pull_request_merge_observations fact
  where fact.merge_id = merge.id
  order by fact.provider_updated_at desc, fact.observed_at, fact.id
  limit 1
) snapshot
cross join lateral (
  select exists (
    select 1 from internal.factory_canonical_pull_request_merge_observations other
    where (other.merge_id, other.provider_updated_at) = (merge.id, snapshot.provider_updated_at)
      and other.id <> snapshot.id
  ) as conflicting
) ambiguity;
revoke all on internal.current_factory_canonical_pull_request_merges from public, anon, authenticated, service_role;

create function internal.validate_canonical_merge_proof(
  p_observation_id uuid, p_pr_state text, p_is_draft boolean, p_pr_head_sha text,
  p_pr_updated_at timestamptz, p_merged_at timestamptz,
  p_merge_commit_sha text, p_merge_source_head_sha text
) returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_observation_id is null or p_pr_state is distinct from 'merged' or p_is_draft is distinct from false
    or p_merged_at is null or not isfinite(p_merged_at)
    or p_pr_updated_at is null or not isfinite(p_pr_updated_at) or p_merged_at > p_pr_updated_at
    or p_merge_commit_sha is null or p_merge_commit_sha !~ '^[a-f0-9]{40}$'
    or p_merge_source_head_sha is null or p_merge_source_head_sha !~ '^[a-f0-9]{40}$'
    or (p_pr_head_sha is not null and p_pr_head_sha <> p_merge_source_head_sha)
  then raise exception 'Exact canonical GitHub merge proof is required.' using errcode = '22023';
  end if;
end;
$$;
revoke all on function internal.validate_canonical_merge_proof(uuid, text, boolean, text, timestamptz, timestamptz, text, text)
  from public, anon, authenticated, service_role;

create function internal.record_canonical_merge_after_fence(
  p_epoch_id uuid, p_observation_id uuid, p_pr_updated_at timestamptz, p_merged_at timestamptz,
  p_merge_commit_sha text, p_merge_source_head_sha text, p_source text
) returns boolean language plpgsql set search_path = '' as $$
declare
  epoch record;
  owner internal.factory_canonical_pull_request_merges%rowtype;
  prior record;
  fact_id uuid;
begin
  select pr.id, pr.session_id, pr.workspace_id, pr.repository_id, pr.github_repository_id,
    pr.pr_number, pr.pr_updated_at, session.factory_id, session.factory_definition_revision_id
  into epoch
  from public.session_pr_epochs pr
  join public.sessions session on (session.id, session.workspace_id) = (pr.session_id, pr.workspace_id)
  join public.github_repositories repository on
    (repository.id, repository.workspace_id, repository.factory_id, repository.repo_id) =
    (pr.repository_id, pr.workspace_id, session.factory_id, pr.github_repository_id)
  where pr.id = p_epoch_id and pr.pr_state = 'merged' and pr.pr_number is not null;
  if not found then return false; end if;

  select fact.*, receipt.source as receipt_source into prior
  from internal.factory_canonical_pull_request_merge_receipts receipt
  join internal.factory_canonical_pull_request_merge_observations fact on fact.id = receipt.observation_id
  where receipt.id = p_observation_id;
  if found then
    return (prior.receipt_source, prior.provider_updated_at, prior.merged_at,
      prior.merge_commit_sha, prior.merge_source_head_sha) is not distinct from
      (p_source, p_pr_updated_at, p_merged_at, p_merge_commit_sha, p_merge_source_head_sha)
      and exists (
        select 1 from internal.factory_canonical_pull_request_merges existing
        where existing.id = prior.merge_id and existing.epoch_id = epoch.id
      );
  end if;
  -- Older callers could settle a terminal operation without merge evidence.
  -- Its replay cannot introduce proof against a different provider snapshot.
  if epoch.pr_updated_at is distinct from p_pr_updated_at then return false; end if;

  insert into internal.factory_canonical_pull_request_merges (
    workspace_id, factory_id, repository_id, github_repository_id, pull_request_number, session_id, epoch_id
  ) values (
    epoch.workspace_id, epoch.factory_id, epoch.repository_id, epoch.github_repository_id,
    epoch.pr_number, epoch.session_id, epoch.id
  ) on conflict (workspace_id, source_host, github_repository_id, pull_request_number) do nothing;
  select merge.* into strict owner
  from internal.factory_canonical_pull_request_merges merge
  where (merge.workspace_id, merge.source_host, merge.github_repository_id, merge.pull_request_number) =
    (epoch.workspace_id, 'github.com', epoch.github_repository_id, epoch.pr_number)
  for no key update;
  if (owner.factory_id, owner.repository_id, owner.session_id, owner.epoch_id) is distinct from
    (epoch.factory_id, epoch.repository_id, epoch.session_id, epoch.id)
  then raise exception 'Canonical merge evidence belongs to another PR epoch.' using errcode = '23514';
  end if;

  insert into internal.factory_canonical_pull_request_merge_observations (
    merge_id, provider_updated_at, merged_at, merge_commit_sha, merge_source_head_sha, source
  ) values (owner.id, p_pr_updated_at, p_merged_at, p_merge_commit_sha, p_merge_source_head_sha, p_source)
  on conflict (merge_id, provider_updated_at, merged_at, merge_commit_sha, merge_source_head_sha) do nothing
  returning id into fact_id;
  if fact_id is null then
    select fact.id into strict fact_id
    from internal.factory_canonical_pull_request_merge_observations fact
    where (fact.merge_id, fact.provider_updated_at, fact.merged_at, fact.merge_commit_sha, fact.merge_source_head_sha) =
      (owner.id, p_pr_updated_at, p_merged_at, p_merge_commit_sha, p_merge_source_head_sha);
  else
    perform internal.record_factory_outcome_observation(owner.workspace_id, owner.factory_id,
      'pull_request.merged', 'github_canonical_pull_request', fact_id::text, p_merged_at,
      p_session_id => owner.session_id, p_definition_revision_id => epoch.factory_definition_revision_id,
      p_repository_id => owner.repository_id, p_status => 'merged');
  end if;
  insert into internal.factory_canonical_pull_request_merge_receipts (id, observation_id, source)
  values (p_observation_id, fact_id, p_source);

  -- The epoch ties the merge to its session. A source run requires a separate
  -- exact publication receipt, including its expected remote fence and head.
  insert into internal.factory_canonical_pull_request_merge_runs (observation_id, run_id, attempt_count, operation_id)
  select fact_id, checkpoint.run_id, checkpoint.attempt_count, operation.id
  from public.session_pr_operations operation
  join public.session_git_checkpoints checkpoint on
    (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id) =
    (operation.checkpoint_run_id, operation.workspace_id, operation.session_id)
  where operation.epoch_id = owner.epoch_id
    and operation.receipted_at is not null and operation.status in ('succeeded', 'terminal')
    and operation.receipt_pr_number = owner.pull_request_number
    and operation.receipt_fence_sha = operation.desired_fence_sha
    and operation.receipt_head_sha = operation.desired_sha
    and (operation.desired_sha, checkpoint.output_sha) = (p_merge_source_head_sha, p_merge_source_head_sha)
    and (operation.receipt_pr_head_sha = p_merge_source_head_sha or (
      operation.receipt_pr_head_sha is null and operation.receipt_observation_id = p_observation_id
    ))
  order by operation.id
  on conflict (observation_id, run_id, attempt_count) do nothing;
  return true;
end;
$$;
revoke all on function internal.record_canonical_merge_after_fence(uuid, uuid, timestamptz, timestamptz, text, text, text)
  from public, anon, authenticated, service_role;

create function public.finish_session_pr_sync_with_merge(
  p_operation_id uuid, p_claim_id uuid, p_observed_head_sha text, p_observed_fence_sha text,
  p_pr_number integer, p_pr_url text, p_pr_state text, p_is_draft boolean, p_pr_head_sha text,
  p_pr_updated_at timestamptz, p_observation_id uuid, p_merged_at timestamptz,
  p_merge_commit_sha text, p_merge_source_head_sha text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare epoch_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.validate_canonical_merge_proof(p_observation_id, p_pr_state, p_is_draft, p_pr_head_sha,
    p_pr_updated_at, p_merged_at, p_merge_commit_sha, p_merge_source_head_sha);
  if not internal.finish_session_pr_sync(p_operation_id, p_claim_id, p_observed_head_sha, p_observed_fence_sha,
    p_pr_number, p_pr_url, p_pr_state, p_is_draft, p_pr_head_sha, p_pr_updated_at, p_observation_id)
  then return false; end if;
  select operation.epoch_id into strict epoch_id
  from public.session_pr_operations operation where operation.id = p_operation_id;
  return internal.record_canonical_merge_after_fence(epoch_id, p_observation_id, p_pr_updated_at,
    p_merged_at, p_merge_commit_sha, p_merge_source_head_sha, 'sync');
end;
$$;

create function public.finish_session_pr_observation_with_merge(
  p_observation_id uuid, p_pr_url text, p_pr_state text, p_is_draft boolean, p_pr_head_sha text,
  p_pr_updated_at timestamptz, p_merged_at timestamptz, p_merge_commit_sha text, p_merge_source_head_sha text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare epoch_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.validate_canonical_merge_proof(p_observation_id, p_pr_state, p_is_draft, p_pr_head_sha,
    p_pr_updated_at, p_merged_at, p_merge_commit_sha, p_merge_source_head_sha);
  select epoch.id into epoch_id from public.session_pr_epochs epoch where epoch.observation_id = p_observation_id;
  if epoch_id is null or not internal.finish_session_pr_observation(p_observation_id, p_pr_url, p_pr_state,
    p_is_draft, p_pr_head_sha, p_pr_updated_at)
  then return false; end if;
  return internal.record_canonical_merge_after_fence(epoch_id, p_observation_id, p_pr_updated_at,
    p_merged_at, p_merge_commit_sha, p_merge_source_head_sha, 'webhook');
end;
$$;
revoke all on function public.finish_session_pr_sync_with_merge(
  uuid, uuid, text, text, integer, text, text, boolean, text, timestamptz, uuid, timestamptz, text, text
), public.finish_session_pr_observation_with_merge(
  uuid, text, text, boolean, text, timestamptz, timestamptz, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.finish_session_pr_sync_with_merge(
  uuid, uuid, text, text, integer, text, text, boolean, text, timestamptz, uuid, timestamptz, text, text
), public.finish_session_pr_observation_with_merge(
  uuid, text, text, boolean, text, timestamptz, timestamptz, text, text
) to service_role;

insert into internal.factory_outcome_capture_coverage (source, live_from)
values ('pull_requests', clock_timestamp());
