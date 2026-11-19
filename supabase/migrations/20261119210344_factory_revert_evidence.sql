-- A manager can attest a relationship. Exact GitHub merge evidence remains a
-- separate requirement for both ends of a verified revert.
create table internal.factory_revert_relationship_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  original_merge_id uuid not null references internal.factory_canonical_pull_request_merges(id) on delete cascade,
  original_observation_id uuid not null,
  original_merge_sha text not null check (original_merge_sha ~ '^[a-f0-9]{40}$'),
  original_merged_at timestamptz not null,
  repository_id uuid not null,
  base_branch text not null,
  revert_pr_number integer not null check (revert_pr_number > 0),
  revision integer not null check (revision > 0),
  status text not null check (status in ('candidate', 'confirmed', 'invalidated')),
  revert_merge_sha text check (revert_merge_sha ~ '^[a-f0-9]{40}$'),
  revert_merged_at timestamptz,
  revert_provider_updated_at timestamptz,
  observed_at timestamptz not null default clock_timestamp(),
  actor_member_id uuid not null,
  request_id uuid not null,
  unique (original_merge_id, revert_pr_number, revision),
  unique (workspace_id, factory_id, request_id),
  check (num_nonnulls(revert_merge_sha, revert_merged_at, revert_provider_updated_at) in (0, 3)),
  check (status <> 'confirmed' or revert_merge_sha is not null),
  check (status <> 'candidate' or revert_merge_sha is null),
  check (revert_merged_at is null or (
    isfinite(revert_merged_at) and isfinite(revert_provider_updated_at)
    and revert_merged_at > original_merged_at and revert_merged_at <= revert_provider_updated_at
    and revert_merge_sha <> original_merge_sha
  ))
);
create index factory_revert_relationship_revisions_scope_idx
  on internal.factory_revert_relationship_revisions (workspace_id, factory_id, original_merge_id);

create table internal.factory_revert_coverage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  repository_id uuid not null,
  base_branch text not null,
  coverage_from timestamptz not null,
  coverage_through timestamptz not null,
  actor_member_id uuid not null,
  recorded_at timestamptz not null default clock_timestamp(),
  request_id uuid not null,
  withdrawn_at timestamptz,
  withdrawn_by_member_id uuid,
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade,
  unique (workspace_id, factory_id, request_id),
  check (isfinite(coverage_from) and isfinite(coverage_through) and coverage_through > coverage_from),
  check ((withdrawn_at is null) = (withdrawn_by_member_id is null))
);
create index factory_revert_coverage_window_idx
  on internal.factory_revert_coverage (workspace_id, factory_id, repository_id, base_branch, coverage_from)
  where withdrawn_at is null;
create index factory_revert_coverage_owner_idx on internal.factory_revert_coverage (workspace_id, factory_id);
alter table internal.factory_revert_relationship_revisions enable row level security;
alter table internal.factory_revert_coverage enable row level security;
revoke all on internal.factory_revert_relationship_revisions, internal.factory_revert_coverage
  from public, anon, authenticated, service_role;

create function internal.guard_factory_revert_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'factory_revert_coverage' then
    if tg_op = 'DELETE' and not exists (
      select 1 from public.factories where (workspace_id, id) = (old.workspace_id, old.factory_id)
    ) then return old; end if;
    if tg_op = 'UPDATE' and old.withdrawn_at is null and new.withdrawn_at is not null
      and (to_jsonb(old) - 'withdrawn_at' - 'withdrawn_by_member_id') =
        (to_jsonb(new) - 'withdrawn_at' - 'withdrawn_by_member_id')
    then return new; end if;
  elsif tg_op = 'DELETE' and not exists (
    select 1 from internal.factory_canonical_pull_request_merges where id = old.original_merge_id
  ) then return old;
  end if;
  raise exception 'Factory revert evidence preserves its original observations.' using errcode = '23514';
end;
$$;
revoke all on function internal.guard_factory_revert_history() from public, anon, authenticated, service_role;
create trigger factory_revert_relationship_history_immutable
  before update or delete on internal.factory_revert_relationship_revisions
  for each row execute function internal.guard_factory_revert_history();
create trigger factory_revert_coverage_history_immutable
  before update or delete on internal.factory_revert_coverage
  for each row execute function internal.guard_factory_revert_history();

create view internal.current_factory_revert_relationships with (security_invoker = true) as
select distinct on (revision.original_merge_id, revision.revert_pr_number) revision.*
from internal.factory_revert_relationship_revisions revision
order by revision.original_merge_id, revision.revert_pr_number, revision.revision desc;
revoke all on internal.current_factory_revert_relationships from public, anon, authenticated, service_role;

create function internal.factory_revert_relationship_receipt(item internal.factory_revert_relationship_revisions)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', item.id, 'originalMergeId', item.original_merge_id,
    'originalObservationId', item.original_observation_id, 'originalMergeSha', item.original_merge_sha,
    'originalMergedAt', item.original_merged_at, 'revertPrNumber', item.revert_pr_number,
    'revision', item.revision, 'status', item.status, 'revertMergeSha', item.revert_merge_sha,
    'revertMergedAt', item.revert_merged_at, 'observedAt', item.observed_at, 'actorMemberId', item.actor_member_id)
$$;
revoke all on function internal.factory_revert_relationship_receipt(internal.factory_revert_relationship_revisions)
  from public, anon, authenticated, service_role;

create function internal.factory_revert_coverage_receipt(item internal.factory_revert_coverage)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', item.id, 'repositoryId', item.repository_id, 'baseBranch', item.base_branch,
    'from', item.coverage_from, 'through', item.coverage_through, 'recordedAt', item.recorded_at,
    'withdrawnAt', item.withdrawn_at, 'actorMemberId', item.actor_member_id)
$$;
revoke all on function internal.factory_revert_coverage_receipt(internal.factory_revert_coverage)
  from public, anon, authenticated, service_role;

create function public.get_factory_revert_target(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_original_merge_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare target jsonb;
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select jsonb_build_object('mergeId', original.id, 'observationId', original.observation_id,
    'repositoryId', original.repository_id, 'repositoryNumericId', original.github_repository_id,
    'repositoryFullName', repository.full_name, 'installationId', installation.installation_id,
    'baseBranch', epoch.base_branch, 'pullRequestNumber', original.pull_request_number,
    'mergeCommitSha', original.merge_commit_sha, 'mergedAt', original.merged_at) into target
  from internal.current_factory_canonical_pull_request_merges original
  join public.session_pr_epochs epoch on (epoch.id, epoch.workspace_id) = (original.epoch_id, original.workspace_id)
  join public.github_repositories repository on
    (repository.id, repository.repo_id, repository.workspace_id, repository.factory_id) =
    (original.repository_id, original.github_repository_id, original.workspace_id, original.factory_id)
  join public.github_installations installation on
    (installation.id, installation.workspace_id) = (repository.github_installation_id, repository.workspace_id)
  where (original.id, original.workspace_id, original.factory_id) = (p_original_merge_id, p_workspace_id, p_factory_id)
    and original.status = 'observed' and original.merged_at <= original.observed_at
    and not repository.is_archived and not installation.suspended;
  if not found then raise exception 'Verified original merge is unavailable.' using errcode = 'PT404'; end if;
  return target;
end;
$$;

create function public.save_factory_revert_relationship(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_original_merge_id uuid,
  p_revert_pr_number integer, p_expected_revision integer, p_request_id uuid, p_status text,
  p_original_observation_id uuid default null, p_proof jsonb default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  manager_id uuid;
  original internal.current_factory_canonical_pull_request_merges%rowtype;
  owner internal.factory_canonical_pull_request_merges%rowtype;
  previous internal.factory_revert_relationship_revisions%rowtype;
  receipt internal.factory_revert_relationship_revisions%rowtype;
  branch text;
  revert_sha text;
  revert_at timestamptz;
  revert_updated_at timestamptz;
  repository_number bigint;
  proof_pr_number integer;
  observed_at timestamptz := clock_timestamp();
begin
  manager_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_revert_pr_number is null or p_revert_pr_number <= 0 or p_expected_revision is null
    or p_expected_revision not between 0 and 2147483646 or p_request_id is null
    or p_status is null or p_status not in ('candidate', 'confirmed', 'invalidated')
    or (p_status <> 'confirmed' and p_proof is not null)
  then raise exception 'Invalid factory revert decision.' using errcode = '22023'; end if;
  -- Preserve latest provider proof and relationship revision in one ordering.
  select merge.* into owner from internal.factory_canonical_pull_request_merges merge
  where (merge.id, merge.workspace_id, merge.factory_id) = (p_original_merge_id, p_workspace_id, p_factory_id)
  for no key update;
  if not found then raise exception 'Original merge is unavailable.' using errcode = 'PT404'; end if;
  if p_revert_pr_number = owner.pull_request_number then
    raise exception 'A revert requires a separate pull request.' using errcode = '22023';
  end if;
  select revision.* into receipt from internal.factory_revert_relationship_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.request_id) =
    (p_workspace_id, p_factory_id, p_request_id);
  if found then
    if (receipt.original_merge_id, receipt.revert_pr_number, receipt.revision, receipt.status, receipt.actor_member_id)
      is distinct from (p_original_merge_id, p_revert_pr_number, p_expected_revision + 1, p_status, manager_id)
    then raise exception 'The revert request ID already identifies another decision.' using errcode = 'PT409'; end if;
    return internal.factory_revert_relationship_receipt(receipt);
  end if;
  select revision.* into previous from internal.current_factory_revert_relationships revision
  where (revision.original_merge_id, revision.revert_pr_number) = (owner.id, p_revert_pr_number);
  if coalesce(previous.revision, 0) <> p_expected_revision or (p_status = 'invalidated' and previous.id is null)
  then raise exception 'The revert decision has changed.' using errcode = 'PT409'; end if;

  if p_status = 'invalidated' then
    original.observation_id := previous.original_observation_id;
    original.merge_commit_sha := previous.original_merge_sha;
    original.merged_at := previous.original_merged_at;
    branch := previous.base_branch;
    revert_sha := previous.revert_merge_sha;
    revert_at := previous.revert_merged_at;
    revert_updated_at := previous.revert_provider_updated_at;
  else
    select merge.* into original from internal.current_factory_canonical_pull_request_merges merge
    where merge.id = owner.id and merge.status = 'observed' and merge.merged_at <= merge.observed_at;
    if not found or (p_original_observation_id is not null
      and p_original_observation_id is distinct from original.observation_id)
      or (p_status = 'confirmed' and p_original_observation_id is null)
    then raise exception 'Original merge evidence has changed.' using errcode = 'PT409'; end if;
    select epoch.base_branch into strict branch from public.session_pr_epochs epoch where epoch.id = owner.epoch_id;
    if p_status = 'confirmed' then
      if p_proof is null or jsonb_typeof(p_proof) <> 'object' or not exists (
        select 1 from public.github_repositories repository
        join public.github_installations installation on
          (installation.id, installation.workspace_id) = (repository.github_installation_id, repository.workspace_id)
        where (repository.id, repository.repo_id, repository.workspace_id, repository.factory_id) =
          (owner.repository_id, owner.github_repository_id, p_workspace_id, p_factory_id)
          and not repository.is_archived and not installation.suspended
      ) then raise exception 'An exact GitHub revert merge is required.' using errcode = '22023'; end if;
      begin
        repository_number := (p_proof->>'repositoryNumericId')::bigint;
        proof_pr_number := (p_proof->>'pullRequestNumber')::integer;
        revert_sha := p_proof->>'mergeCommitSha';
        revert_at := (p_proof->>'mergedAt')::timestamptz;
        revert_updated_at := (p_proof->>'updatedAt')::timestamptz;
      exception when invalid_text_representation or numeric_value_out_of_range
        or invalid_datetime_format or datetime_field_overflow then
        raise exception 'Invalid GitHub revert proof.' using errcode = '22023';
      end;
      if (repository_number, proof_pr_number, p_proof->>'baseBranch') is distinct from
        (owner.github_repository_id, p_revert_pr_number, branch)
        or revert_sha is null or revert_sha !~ '^[a-f0-9]{40}$' or revert_sha = original.merge_commit_sha
        or revert_at is null or revert_updated_at is null or not isfinite(revert_at) or not isfinite(revert_updated_at)
        or revert_at <= original.merged_at or revert_at > revert_updated_at or revert_updated_at > observed_at
      then raise exception 'Invalid GitHub revert proof.' using errcode = '22023'; end if;
    end if;
  end if;

  insert into internal.factory_revert_relationship_revisions (
    workspace_id, factory_id, original_merge_id, original_observation_id, original_merge_sha,
    original_merged_at, repository_id, base_branch, revert_pr_number, revision, status,
    revert_merge_sha, revert_merged_at, revert_provider_updated_at, observed_at, actor_member_id, request_id
  ) values (
    p_workspace_id, p_factory_id, owner.id, original.observation_id, original.merge_commit_sha,
    original.merged_at, owner.repository_id, branch, p_revert_pr_number, p_expected_revision + 1, p_status,
    revert_sha, revert_at, revert_updated_at, observed_at, manager_id, p_request_id
  ) returning * into receipt;
  return internal.factory_revert_relationship_receipt(receipt);
exception when unique_violation then
  raise exception 'The revert decision or request has changed.' using errcode = 'PT409';
end;
$$;

create function public.record_factory_revert_coverage(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_repository_id uuid, p_base_branch text,
  p_from timestamptz, p_through timestamptz, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare manager_id uuid; receipt internal.factory_revert_coverage%rowtype;
begin
  manager_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_request_id is null or p_base_branch is null or not internal.is_git_branch_ref('refs/heads/' || p_base_branch)
    or p_from is null or p_through is null or not isfinite(p_from) or not isfinite(p_through)
    or p_through <= p_from or p_through - p_from > interval '366 days' or p_through > clock_timestamp()
  then raise exception 'Invalid revert observation coverage.' using errcode = '22023'; end if;
  if not exists (
    select 1 from public.github_repositories repository
    where (repository.id, repository.workspace_id, repository.factory_id) =
      (p_repository_id, p_workspace_id, p_factory_id)
      and not repository.is_archived and (repository.default_branch = p_base_branch or exists (
        select 1 from public.session_pr_epochs epoch
        join public.sessions session on (session.id, session.workspace_id) = (epoch.session_id, epoch.workspace_id)
        where (epoch.repository_id, session.workspace_id, session.factory_id, epoch.base_branch) =
          (p_repository_id, p_workspace_id, p_factory_id, p_base_branch)
      ))
  ) then raise exception 'Repository or base branch is unavailable in this factory.' using errcode = 'PT404'; end if;
  insert into internal.factory_revert_coverage (
    workspace_id, factory_id, repository_id, base_branch, coverage_from, coverage_through, actor_member_id, request_id
  ) values (p_workspace_id, p_factory_id, p_repository_id, p_base_branch, p_from, p_through, manager_id, p_request_id)
  on conflict (workspace_id, factory_id, request_id) do nothing
  returning * into receipt;
  if not found then
    select coverage.* into strict receipt from internal.factory_revert_coverage coverage
    where (coverage.workspace_id, coverage.factory_id, coverage.request_id) = (p_workspace_id, p_factory_id, p_request_id);
    if (receipt.repository_id, receipt.base_branch, receipt.coverage_from, receipt.coverage_through, receipt.actor_member_id)
      is distinct from (p_repository_id, p_base_branch, p_from, p_through, manager_id)
    then raise exception 'The coverage request ID is already in use.' using errcode = 'PT409'; end if;
  end if;
  return internal.factory_revert_coverage_receipt(receipt);
end;
$$;

create function public.withdraw_factory_revert_coverage(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_coverage_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare manager_id uuid; receipt internal.factory_revert_coverage%rowtype;
begin
  manager_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select coverage.* into receipt from internal.factory_revert_coverage coverage
  where (coverage.id, coverage.workspace_id, coverage.factory_id) = (p_coverage_id, p_workspace_id, p_factory_id)
  for update;
  if not found then raise exception 'Revert coverage is unavailable.' using errcode = 'PT404'; end if;
  if receipt.withdrawn_at is null then
    update internal.factory_revert_coverage coverage set
      withdrawn_at = clock_timestamp(), withdrawn_by_member_id = manager_id
    where coverage.id = receipt.id returning * into receipt;
  end if;
  return internal.factory_revert_coverage_receipt(receipt);
end;
$$;

revoke all on function public.get_factory_revert_target(uuid, uuid, uuid, uuid),
  public.save_factory_revert_relationship(uuid, uuid, uuid, uuid, integer, integer, uuid, text, uuid, jsonb),
  public.record_factory_revert_coverage(uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, uuid),
  public.withdraw_factory_revert_coverage(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_factory_revert_target(uuid, uuid, uuid, uuid),
  public.save_factory_revert_relationship(uuid, uuid, uuid, uuid, integer, integer, uuid, text, uuid, jsonb),
  public.record_factory_revert_coverage(uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, uuid),
  public.withdraw_factory_revert_coverage(uuid, uuid, uuid, uuid)
  to service_role;

insert into internal.factory_outcome_capture_coverage (source, live_from)
values ('reverts', clock_timestamp());
