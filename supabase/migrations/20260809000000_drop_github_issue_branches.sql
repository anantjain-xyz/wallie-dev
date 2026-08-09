-- Consolidate any residual legacy branch rows into the canonical PR relation
-- before removing the relation that application code no longer uses.
do $$
declare
  legacy_count bigint;
  canonical_count bigint;
  overlapping_count bigint;
  residual_count bigint;
  differing_count bigint;
begin
  select count(*) into legacy_count from public.github_issue_branches;
  select count(*) into canonical_count from public.session_pull_requests;
  select count(*)
  into overlapping_count
  from public.github_issue_branches as legacy
  join public.session_pull_requests as canonical
    on canonical.workspace_id = legacy.workspace_id
   and canonical.branch_name = legacy.branch_name;
  select count(*)
  into residual_count
  from public.github_issue_branches as legacy
  left join public.session_pull_requests as canonical
    on canonical.workspace_id = legacy.workspace_id
   and canonical.branch_name = legacy.branch_name
  where canonical.id is null;
  select count(*)
  into differing_count
  from public.github_issue_branches as legacy
  join public.session_pull_requests as canonical
    on canonical.workspace_id = legacy.workspace_id
   and canonical.branch_name = legacy.branch_name
  where row(
    legacy.session_id,
    legacy.github_repository_id,
    legacy.pull_request_number,
    legacy.pull_request_url,
    legacy.pull_request_state,
    legacy.is_draft
  ) is distinct from row(
    canonical.session_id,
    canonical.github_repository_id,
    canonical.pull_request_number,
    canonical.pull_request_url,
    canonical.pull_request_state,
    canonical.is_draft
  );

  raise notice
    'github_issue_branches migration: legacy=%, canonical=%, overlapping=%, residual=%, differing=%',
    legacy_count,
    canonical_count,
    overlapping_count,
    residual_count,
    differing_count;
end
$$;

insert into public.session_pull_requests (
  id,
  workspace_id,
  session_id,
  github_repository_id,
  branch_name,
  pull_request_number,
  pull_request_url,
  pull_request_state,
  is_draft,
  created_at,
  updated_at
)
select
  case
    when conflicting_id.id is null then legacy.id
    else gen_random_uuid()
  end,
  legacy.workspace_id,
  legacy.session_id,
  legacy.github_repository_id,
  legacy.branch_name,
  legacy.pull_request_number,
  legacy.pull_request_url,
  legacy.pull_request_state,
  legacy.is_draft,
  legacy.created_at,
  legacy.updated_at
from public.github_issue_branches as legacy
left join public.session_pull_requests as conflicting_id
  on conflicting_id.id = legacy.id
 and (
   conflicting_id.workspace_id <> legacy.workspace_id
   or conflicting_id.branch_name <> legacy.branch_name
 )
on conflict (workspace_id, branch_name) do update
set
  session_id = excluded.session_id,
  github_repository_id = excluded.github_repository_id,
  pull_request_number = excluded.pull_request_number,
  pull_request_url = excluded.pull_request_url,
  pull_request_state = excluded.pull_request_state,
  is_draft = excluded.is_draft,
  created_at = least(session_pull_requests.created_at, excluded.created_at),
  updated_at = excluded.updated_at
where excluded.updated_at > session_pull_requests.updated_at;

do $$
begin
  if exists (
    select 1
    from public.github_issue_branches as legacy
    left join public.session_pull_requests as canonical
      on canonical.workspace_id = legacy.workspace_id
     and canonical.branch_name = legacy.branch_name
    where canonical.id is null
  ) then
    raise exception 'Not every github_issue_branches row was migrated';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) and exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'github_issue_branches'
  ) then
    alter publication supabase_realtime
      drop table only public.github_issue_branches;
  end if;
end
$$;

drop policy if exists github_issue_branches_select_membership
  on public.github_issue_branches;

revoke all privileges on table public.github_issue_branches
  from public, anon, authenticated, service_role;

drop trigger if exists github_issue_branches_touch_updated_at
  on public.github_issue_branches;
drop trigger if exists github_issue_branches_enforce_refs
  on public.github_issue_branches;

drop index if exists public.github_issue_branches_session_created_at_idx;
alter table public.github_issue_branches
  drop constraint if exists github_issue_branches_workspace_branch_unique;

drop table public.github_issue_branches;
drop function internal.enforce_github_issue_branch_refs();
