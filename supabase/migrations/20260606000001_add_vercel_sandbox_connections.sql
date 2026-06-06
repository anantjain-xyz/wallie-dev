-- Workspace-owned Vercel Sandbox credentials.
--
-- The encrypted token is service-role only. Authenticated members can read
-- preview/status columns through RLS so settings pages can show connection
-- health without exposing secrets.

create table public.workspace_vercel_sandbox_connections (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  encrypted_token text not null,
  token_preview text,
  team_id text not null,
  project_id text not null,
  project_name text,
  status text not null default 'connected',
  last_validated_at timestamptz,
  last_validation_error text,
  created_by_member_id uuid references public.workspace_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_vercel_sandbox_connections_status_check
    check (status in ('connected', 'error')),
  constraint workspace_vercel_sandbox_connections_team_project_check
    check (length(team_id) between 1 and 128 and length(project_id) between 1 and 128)
);

alter table public.agent_runs
  add column sandbox_provider text,
  add column sandbox_vercel_team_id text,
  add column sandbox_vercel_project_id text,
  add constraint agent_runs_sandbox_provider_check
    check (sandbox_provider is null or sandbox_provider in ('vercel', 'fake')),
  add constraint agent_runs_vercel_sandbox_metadata_check
    check (
      sandbox_provider is distinct from 'vercel'
      or (
        sandbox_vercel_team_id is not null
        and sandbox_vercel_project_id is not null
      )
    );

alter table public.sandbox_capability_checks
  add column sandbox_id text,
  add column sandbox_provider text,
  add column sandbox_vercel_team_id text,
  add column sandbox_vercel_project_id text,
  add constraint sandbox_capability_checks_sandbox_provider_check
    check (sandbox_provider is null or sandbox_provider in ('vercel', 'fake')),
  add constraint sandbox_capability_checks_vercel_sandbox_metadata_check
    check (
      sandbox_provider is distinct from 'vercel'
      or (
        sandbox_id is not null
        and sandbox_vercel_team_id is not null
        and sandbox_vercel_project_id is not null
      )
    );

create index agent_runs_active_vercel_sandbox_idx
  on public.agent_runs (
    workspace_id,
    sandbox_provider,
    sandbox_vercel_team_id,
    sandbox_vercel_project_id,
    sandbox_id
  )
  where sandbox_id is not null
    and status in ('queued', 'started', 'running');

create index sandbox_capability_checks_vercel_sandbox_idx
  on public.sandbox_capability_checks (
    workspace_id,
    sandbox_provider,
    sandbox_vercel_team_id,
    sandbox_vercel_project_id,
    sandbox_id
  )
  where sandbox_id is not null;

create table public.workspace_vercel_sandbox_connection_mutations (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  created_at timestamptz not null default now()
);

revoke insert, update, delete on public.sandbox_capability_checks from authenticated;

create or replace function public.begin_vercel_sandbox_connection_mutation(
  target_workspace_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text, 0));

  if exists (
    select 1
    from public.workspace_vercel_sandbox_connection_mutations
    where workspace_id = target_workspace_id
  ) then
    return 'locked';
  end if;

  if exists (
    select 1
    from public.agent_runs
    where workspace_id = target_workspace_id
      and status in ('queued', 'started', 'running')
  ) or exists (
    select 1
    from public.agent_jobs
    where workspace_id = target_workspace_id
      and status in ('queued', 'started', 'running')
  ) or exists (
    select 1
    from public.sandbox_capability_checks
    where workspace_id = target_workspace_id
      and status = 'running'
  ) then
    return 'active';
  end if;

  insert into public.workspace_vercel_sandbox_connection_mutations (workspace_id)
  values (target_workspace_id);

  return 'acquired';
end;
$$;

create or replace function public.start_sandbox_capability_check(
  target_workspace_id uuid,
  target_github_repository_id uuid
)
returns public.sandbox_capability_checks
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted public.sandbox_capability_checks%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text, 0));

  if exists (
    select 1
    from public.workspace_vercel_sandbox_connection_mutations
    where workspace_id = target_workspace_id
  ) then
    raise exception 'Vercel Sandbox connection update is in progress. Try again shortly.';
  end if;

  insert into public.sandbox_capability_checks (
    workspace_id,
    github_repository_id,
    status,
    capabilities
  )
  values (
    target_workspace_id,
    target_github_repository_id,
    'running',
    '{}'::jsonb
  )
  returning * into inserted;

  return inserted;
end;
$$;

create or replace function public.claim_next_agent_job(
  default_concurrency_limit int default 2
)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.agent_jobs%rowtype;
  configured_limit int;
  effective_limit int;
  running_count int;
begin
  for candidate in
    select *
    from public.agent_jobs
    where status = 'queued'
      and (scheduled_at is null or scheduled_at <= now())
    order by created_at asc
    for update skip locked
  loop
    perform pg_advisory_xact_lock(hashtextextended(candidate.workspace_id::text, 0));

    if exists (
      select 1
      from public.workspace_vercel_sandbox_connection_mutations
      where workspace_id = candidate.workspace_id
    ) then
      continue;
    end if;

    configured_limit := null;

    select (value_json)::int into configured_limit
    from public.workspace_agent_config
    where workspace_id = candidate.workspace_id
      and key = 'concurrency_limit'
      and jsonb_typeof(value_json) = 'number';

    effective_limit := coalesce(configured_limit, default_concurrency_limit);

    select count(*) into running_count
    from public.agent_jobs
    where workspace_id = candidate.workspace_id
      and status = 'running';

    if running_count >= effective_limit then
      continue;
    end if;

    return query
    update public.agent_jobs
    set
      status = 'running',
      attempt_count = attempt_count + 1,
      last_error = null,
      started_at = coalesce(started_at, now()),
      scheduled_at = null
    where id = candidate.id
      and status = 'queued'
    returning *;

    return;
  end loop;

  return;
end;
$$;

create or replace function internal.enforce_workspace_vercel_sandbox_connection_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(
    new.workspace_id,
    'public.workspace_members',
    new.created_by_member_id,
    'created_by_member_id'
  );
  return new;
end;
$$;

create trigger workspace_vercel_sandbox_connections_touch_updated_at
before update on public.workspace_vercel_sandbox_connections
for each row
execute function internal.touch_updated_at();

create trigger workspace_vercel_sandbox_connections_enforce_refs
before insert or update on public.workspace_vercel_sandbox_connections
for each row
execute function internal.enforce_workspace_vercel_sandbox_connection_refs();

alter table public.workspace_vercel_sandbox_connections enable row level security;
alter table public.workspace_vercel_sandbox_connection_mutations enable row level security;

revoke all on public.workspace_vercel_sandbox_connections from anon, authenticated;
revoke all on public.workspace_vercel_sandbox_connection_mutations from anon, authenticated;
grant all on public.workspace_vercel_sandbox_connections to service_role;
grant all on public.workspace_vercel_sandbox_connection_mutations to service_role;
grant select (
  workspace_id,
  token_preview,
  team_id,
  project_id,
  project_name,
  status,
  last_validated_at,
  last_validation_error,
  created_by_member_id,
  created_at,
  updated_at
) on public.workspace_vercel_sandbox_connections to authenticated;

revoke all on function public.begin_vercel_sandbox_connection_mutation(uuid)
  from public, anon, authenticated;
revoke all on function public.start_sandbox_capability_check(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_next_agent_job(integer)
  from public, anon, authenticated;
grant execute on function public.begin_vercel_sandbox_connection_mutation(uuid)
  to service_role;
grant execute on function public.start_sandbox_capability_check(uuid, uuid)
  to service_role;
grant execute on function public.claim_next_agent_job(integer)
  to service_role;

create policy workspace_vercel_sandbox_connections_select_membership
  on public.workspace_vercel_sandbox_connections
  for select
  to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()));

create policy workspace_vercel_sandbox_connections_service_only
  on public.workspace_vercel_sandbox_connections
  for all
  to authenticated
  using (false)
  with check (false);

create policy workspace_vercel_sandbox_connection_mutations_service_only
  on public.workspace_vercel_sandbox_connection_mutations
  for all
  to authenticated
  using (false)
  with check (false);
