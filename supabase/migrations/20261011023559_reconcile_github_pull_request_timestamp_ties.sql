-- Provider timestamps have second precision. Conflicting ties require a fresh
-- GitHub read, admitted before that read and fenced against later observations.
alter table public.session_pull_requests add column github_observation_token uuid;
alter table public.repository_onboarding_status add column setup_pr_observation_token uuid;

create function internal.invalidate_session_pull_request_observation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.workspace_id, new.session_id, new.github_repository_id, new.branch_name,
      new.pull_request_number, new.pull_request_state, new.is_draft, new.github_updated_at)
    is distinct from
     (old.workspace_id, old.session_id, old.github_repository_id, old.branch_name,
      old.pull_request_number, old.pull_request_state, old.is_draft, old.github_updated_at) then
    new.github_observation_token := null;
  end if;
  return new;
end;
$$;
create trigger invalidate_session_pull_request_observation
before update on public.session_pull_requests
for each row execute function internal.invalidate_session_pull_request_observation();

create function internal.invalidate_setup_pull_request_observation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.workspace_id, new.github_repository_id, new.setup_branch_name,
      new.setup_pr_number, new.setup_pr_state, new.setup_pr_updated_at, new.status, new.conflict_report)
    is distinct from
     (old.workspace_id, old.github_repository_id, old.setup_branch_name,
      old.setup_pr_number, old.setup_pr_state, old.setup_pr_updated_at, old.status, old.conflict_report) then
    new.setup_pr_observation_token := null;
  end if;
  return new;
end;
$$;
create trigger invalidate_setup_pull_request_observation
before update on public.repository_onboarding_status
for each row execute function internal.invalidate_setup_pull_request_observation();

create function public.begin_github_pull_request_observation(
  target_workspace_id uuid, target_repository_id uuid, target_branch_name text,
  source_pull_request_number integer, source_pull_request_state text,
  source_is_draft boolean, source_updated_at timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  onboarding public.repository_onboarding_status%rowtype;
  observation uuid := gen_random_uuid();
  affected integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if source_updated_at is null or not isfinite(source_updated_at)
    or source_pull_request_number is null or source_pull_request_number <= 0
    or source_pull_request_state is null or source_pull_request_state not in ('open', 'closed', 'merged')
    or source_is_draft is null or nullif(target_branch_name, '') is null then
    raise exception 'Invalid GitHub pull request snapshot' using errcode = '22023';
  end if;

  select * into onboarding from public.repository_onboarding_status
  where workspace_id = target_workspace_id and github_repository_id = target_repository_id
    and setup_branch_name = target_branch_name and setup_pr_number = source_pull_request_number
  for update;
  if found then
    if onboarding.setup_pr_state is distinct from 'merged'
      and onboarding.setup_pr_updated_at = source_updated_at
      and (onboarding.setup_pr_state is distinct from source_pull_request_state
        or onboarding.setup_pr_observation_token is not null) then
      update public.repository_onboarding_status set setup_pr_observation_token = observation
      where id = onboarding.id;
      return observation;
    end if;
    return null;
  end if;

  update public.session_pull_requests set github_observation_token = observation
  where workspace_id = target_workspace_id and github_repository_id = target_repository_id
    and pull_request_number = source_pull_request_number
    and pull_request_state is distinct from 'merged' and github_updated_at = source_updated_at
    and (pull_request_state is distinct from source_pull_request_state
      or is_draft is distinct from source_is_draft or github_observation_token is not null);
  get diagnostics affected = row_count;
  return case when affected > 0 then observation else null end;
end;
$$;

-- Only a read admitted by begin can resolve an equal-time conflict. Every
-- accepted ordinary write invalidates its token via the triggers above. A later
-- begin supersedes an earlier read even if their network responses finish in
-- reverse order. Ordinary worker snapshots retain their strict watermark rule.
create function public.finish_github_pull_request_observation(
  target_workspace_id uuid, target_repository_id uuid, target_branch_name text,
  source_pull_request_number integer, source_pull_request_url text,
  source_pull_request_state text, source_is_draft boolean, source_updated_at timestamptz,
  observation_token uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  onboarding public.repository_onboarding_status%rowtype;
  has_conflicts boolean;
  affected integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if source_updated_at is null or not isfinite(source_updated_at)
    or source_pull_request_number is null or source_pull_request_number <= 0
    or source_pull_request_state is null or source_pull_request_state not in ('open', 'closed', 'merged')
    or source_is_draft is null or nullif(source_pull_request_url, '') is null
    or nullif(target_branch_name, '') is null or observation_token is null then
    raise exception 'Invalid GitHub pull request observation' using errcode = '22023';
  end if;

  select * into onboarding from public.repository_onboarding_status
  where workspace_id = target_workspace_id and github_repository_id = target_repository_id
    and setup_branch_name = target_branch_name and setup_pr_number = source_pull_request_number
  for update;
  if found then
    if onboarding.setup_pr_observation_token is distinct from observation_token
      or source_updated_at < onboarding.setup_pr_updated_at
      or (onboarding.setup_pr_state = 'merged' and source_pull_request_state <> 'merged') then
      return false;
    end if;
    has_conflicts := onboarding.status = 'conflict'
      or case when jsonb_typeof(onboarding.conflict_report) = 'array'
        then jsonb_array_length(onboarding.conflict_report) > 0 else false end;
    update public.repository_onboarding_status set
      setup_pr_url = source_pull_request_url,
      setup_pr_updated_at = source_updated_at,
      setup_pr_state = source_pull_request_state,
      setup_pr_observation_token = null,
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
    return true;
  end if;

  update public.session_pull_requests set
    pull_request_url = source_pull_request_url,
    pull_request_state = source_pull_request_state,
    is_draft = source_is_draft,
    github_updated_at = source_updated_at,
    github_observation_token = null
  where workspace_id = target_workspace_id and github_repository_id = target_repository_id
    and pull_request_number = source_pull_request_number
    and github_observation_token = observation_token
    and source_updated_at >= github_updated_at
    and (pull_request_state is distinct from 'merged' or source_pull_request_state = 'merged');
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function public.begin_github_pull_request_observation(uuid, uuid, text, integer, text, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.finish_github_pull_request_observation(uuid, uuid, text, integer, text, text, boolean, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.begin_github_pull_request_observation(uuid, uuid, text, integer, text, boolean, timestamptz) to service_role;
grant execute on function public.finish_github_pull_request_observation(uuid, uuid, text, integer, text, text, boolean, timestamptz, uuid) to service_role;
