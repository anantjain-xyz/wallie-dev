-- Provider time belongs to a repository/PR identity, not to delivery arrival time.
alter table public.session_pull_requests add column github_updated_at timestamptz;
alter table public.repository_onboarding_status
  add column setup_pr_updated_at timestamptz,
  add column setup_pr_state text check (setup_pr_state in ('open', 'closed', 'merged'));

-- Existing ready setup rows already represent a merged PR. Preserve that terminal
-- evidence even though older deliveries predate the provider watermark.
update public.repository_onboarding_status set setup_pr_state = 'merged'
where status = 'ready' and setup_pr_number is not null;

create function internal.github_pull_request_is_fresh(
  current_state text, current_source_time timestamptz,
  incoming_state text, incoming_source_time timestamptz
) returns boolean language sql immutable set search_path = '' as $$
  select (current_state is distinct from 'merged' or incoming_state = 'merged')
    and (current_source_time is null or incoming_source_time > current_source_time
      -- GitHub timestamps have second precision. A merge dominates a tie; other
      -- conflicting equal-time snapshots retain the already accepted state.
      or (incoming_source_time = current_source_time
        and incoming_state = 'merged' and current_state is distinct from 'merged'));
$$;

-- Setup creation writes a new identity independently of webhook delivery. Never
-- carry the previous PR's watermark into its replacement, even on the same branch.
create function internal.reset_setup_pull_request_source_state()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.github_repository_id is distinct from old.github_repository_id
    or new.workspace_id is distinct from old.workspace_id
    or new.setup_pr_number is distinct from old.setup_pr_number
    or new.setup_branch_name is distinct from old.setup_branch_name then
    new.setup_pr_updated_at := null;
    new.setup_pr_state := null;
  end if;
  return new;
end;
$$;
create trigger reset_setup_pull_request_source_state
before update on public.repository_onboarding_status
for each row execute function internal.reset_setup_pull_request_source_state();

create function public.apply_github_pull_request_event(
  target_workspace_id uuid, target_repository_id uuid, target_branch_name text,
  source_pull_request_number integer, source_pull_request_url text,
  source_pull_request_state text, source_is_draft boolean, source_updated_at timestamptz
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  onboarding public.repository_onboarding_status%rowtype;
  affected integer;
  has_conflicts boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if source_updated_at is null or not isfinite(source_updated_at)
    or source_pull_request_number is null or source_pull_request_number <= 0
    or source_pull_request_state is null or source_pull_request_state not in ('open', 'closed', 'merged')
    or source_is_draft is null or nullif(source_pull_request_url, '') is null
    or nullif(target_branch_name, '') is null then
    raise exception 'Invalid GitHub pull request snapshot' using errcode = '22023';
  end if;
  if not exists (select 1 from public.github_repositories
    where id = target_repository_id and workspace_id = target_workspace_id) then
    return false;
  end if;

  select * into onboarding from public.repository_onboarding_status
  where workspace_id = target_workspace_id and github_repository_id = target_repository_id
    and setup_branch_name = target_branch_name and setup_pr_number = source_pull_request_number
  for update;
  if found then
    if internal.github_pull_request_is_fresh(onboarding.setup_pr_state,
      onboarding.setup_pr_updated_at, source_pull_request_state, source_updated_at) then
      has_conflicts := onboarding.status = 'conflict'
        or case when jsonb_typeof(onboarding.conflict_report) = 'array'
          then jsonb_array_length(onboarding.conflict_report) > 0 else false end;
      update public.repository_onboarding_status set
        setup_pr_url = source_pull_request_url,
        setup_pr_updated_at = source_updated_at,
        setup_pr_state = source_pull_request_state,
        conflict_report = case when source_pull_request_state = 'merged' and not has_conflicts
          then '[]'::jsonb else onboarding.conflict_report end,
        status = case
          when source_pull_request_state = 'closed' then 'error'
          when has_conflicts then 'conflict'
          when source_pull_request_state = 'merged' then 'ready'
          else 'pr_open' end,
        last_error = case when source_pull_request_state = 'closed'
          then 'Setup PR was closed without merging.' else null end
      where id = onboarding.id;
    end if;
    return true;
  end if;

  -- Existing identities match by repository/number. A not-yet-linked branch is
  -- eligible only with positive repository evidence from the link or its session.
  update public.session_pull_requests link set
    github_repository_id = target_repository_id,
    pull_request_number = source_pull_request_number,
    pull_request_url = source_pull_request_url,
    pull_request_state = source_pull_request_state,
    is_draft = source_is_draft,
    github_updated_at = source_updated_at
  where link.workspace_id = target_workspace_id
    and (link.github_repository_id = target_repository_id
      or (link.github_repository_id is null and link.pull_request_number is null and exists (
        select 1 from public.sessions session where session.id = link.session_id
          and session.workspace_id = target_workspace_id
          and session.github_repository_id = target_repository_id)))
    and (link.pull_request_number = source_pull_request_number
      or (link.pull_request_number is null and link.branch_name = target_branch_name))
    and internal.github_pull_request_is_fresh(link.pull_request_state,
      link.github_updated_at, source_pull_request_state, source_updated_at);
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

-- Workers and webhook deliveries share the watermark. Retried reads cannot
-- undo a newer delivery, and replacement PRs start with their own provider time.
create function public.record_session_pull_request(
  target_session_id uuid, target_workspace_id uuid, target_repository_id uuid,
  target_branch_name text, source_pull_request_number integer,
  source_pull_request_url text, source_pull_request_state text,
  source_is_draft boolean, source_updated_at timestamptz
) returns public.session_pull_requests
language plpgsql security definer set search_path = '' as $$
declare
  link public.session_pull_requests%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if source_updated_at is null or not isfinite(source_updated_at)
    or source_pull_request_number is null or source_pull_request_number <= 0
    or source_pull_request_state is null or source_pull_request_state not in ('open', 'closed', 'merged')
    or source_is_draft is null or nullif(source_pull_request_url, '') is null
    or nullif(target_branch_name, '') is null then
    raise exception 'Invalid GitHub pull request snapshot' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sessions session
    join public.github_repositories repository on repository.id = target_repository_id
      and repository.workspace_id = session.workspace_id
    where session.id = target_session_id and session.workspace_id = target_workspace_id
      and (session.github_repository_id is null or session.github_repository_id = target_repository_id)) then
    raise exception 'Pull request repository must match its session' using errcode = '23514';
  end if;

  insert into public.session_pull_requests (
    session_id, workspace_id, github_repository_id, branch_name, pull_request_number,
    pull_request_url, pull_request_state, is_draft, github_updated_at
  ) values (
    target_session_id, target_workspace_id, target_repository_id, target_branch_name,
    source_pull_request_number, source_pull_request_url, source_pull_request_state,
    source_is_draft, source_updated_at
  ) on conflict (workspace_id, branch_name) do nothing returning * into link;
  if found then return link; end if;

  select * into link from public.session_pull_requests
  where workspace_id = target_workspace_id and branch_name = target_branch_name for update;
  if not found then
    raise exception 'Pull request link changed concurrently; retry' using errcode = '40001';
  end if;
  if link.session_id <> target_session_id
    or (link.github_repository_id is not null and link.github_repository_id <> target_repository_id) then
    raise exception 'Pull request branch belongs to another session or repository' using errcode = '23514';
  end if;

  if link.github_repository_id is null or link.pull_request_number is null
    or source_pull_request_number > link.pull_request_number
    or (source_pull_request_number = link.pull_request_number
      and internal.github_pull_request_is_fresh(link.pull_request_state,
        link.github_updated_at, source_pull_request_state, source_updated_at)) then
    update public.session_pull_requests set
      github_repository_id = target_repository_id,
      pull_request_number = source_pull_request_number,
      pull_request_url = source_pull_request_url,
      pull_request_state = source_pull_request_state,
      is_draft = source_is_draft,
      github_updated_at = source_updated_at
    where id = link.id returning * into link;
  end if;
  return link;
end;
$$;

revoke all on function public.apply_github_pull_request_event(uuid, uuid, text, integer, text, text, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.record_session_pull_request(uuid, uuid, uuid, text, integer, text, text, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_github_pull_request_event(uuid, uuid, text, integer, text, text, boolean, timestamptz) to service_role;
grant execute on function public.record_session_pull_request(uuid, uuid, uuid, text, integer, text, text, boolean, timestamptz) to service_role;
