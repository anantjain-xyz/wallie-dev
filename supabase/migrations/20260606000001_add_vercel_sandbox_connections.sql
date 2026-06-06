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

revoke all on public.workspace_vercel_sandbox_connections from anon, authenticated;
grant all on public.workspace_vercel_sandbox_connections to service_role;
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
