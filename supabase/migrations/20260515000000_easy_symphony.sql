-- Easy Symphony foundation: repository onboarding, Linear status routing, and
-- sandbox capability probes.

create table public.repository_onboarding_status (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  github_repository_id uuid not null references public.github_repositories(id) on delete cascade,
  status text not null default 'not_set_up',
  setup_branch_name text,
  setup_pr_number integer,
  setup_pr_url text,
  installed_skill_version integer,
  installed_skill_hash text,
  conflict_report jsonb not null default '[]'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint repository_onboarding_status_known_status check (
    status in ('not_set_up', 'pr_open', 'ready', 'conflict', 'error')
  ),
  constraint repository_onboarding_status_version_positive check (
    installed_skill_version is null or installed_skill_version > 0
  ),
  constraint repository_onboarding_status_workspace_repo_unique
    unique (workspace_id, github_repository_id)
);

create table public.workspace_linear_routing (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status_mappings jsonb not null default '{
    "backlog": ["backlog"],
    "todo": ["todo"],
    "in_progress": ["in progress"],
    "in_review": ["in review"],
    "rework": ["rework"],
    "merging": ["merging"],
    "done": ["done"],
    "canceled": ["canceled", "cancelled", "duplicate"]
  }'::jsonb,
  rework_stage_slug text not null default 'engineering',
  land_stage_slug text not null default 'land',
  monitor_stage_slug text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_linear_routing_workspace_unique unique (workspace_id),
  constraint workspace_linear_routing_status_mappings_object check (
    jsonb_typeof(status_mappings) = 'object'
  ),
  constraint workspace_linear_routing_rework_slug_format check (
    rework_stage_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  constraint workspace_linear_routing_land_slug_format check (
    land_stage_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  constraint workspace_linear_routing_monitor_slug_format check (
    monitor_stage_slug is null or monitor_stage_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  )
);

create table public.sandbox_capability_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  github_repository_id uuid references public.github_repositories(id) on delete set null,
  status text not null default 'running',
  capabilities jsonb not null default '{}'::jsonb,
  error_text text,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sandbox_capability_checks_known_status check (
    status in ('running', 'success', 'error')
  ),
  constraint sandbox_capability_checks_capabilities_object check (
    jsonb_typeof(capabilities) = 'object'
  )
);

create index repository_onboarding_status_workspace_idx
  on public.repository_onboarding_status (workspace_id);

create index repository_onboarding_status_repository_idx
  on public.repository_onboarding_status (github_repository_id);

create index sandbox_capability_checks_workspace_checked_idx
  on public.sandbox_capability_checks (workspace_id, checked_at desc);

create or replace function internal.seed_workspace_linear_routing()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.workspace_linear_routing (workspace_id)
  values (new.id)
  on conflict (workspace_id) do nothing;

  return new;
end;
$$;

insert into public.workspace_linear_routing (workspace_id)
select w.id
from public.workspaces w
on conflict (workspace_id) do nothing;

create trigger workspaces_seed_linear_routing
after insert on public.workspaces
for each row
execute function internal.seed_workspace_linear_routing();

create trigger repository_onboarding_status_touch_updated_at
before update on public.repository_onboarding_status
for each row
execute function internal.touch_updated_at();

create trigger workspace_linear_routing_touch_updated_at
before update on public.workspace_linear_routing
for each row
execute function internal.touch_updated_at();

create trigger sandbox_capability_checks_touch_updated_at
before update on public.sandbox_capability_checks
for each row
execute function internal.touch_updated_at();

alter table public.repository_onboarding_status enable row level security;
alter table public.workspace_linear_routing enable row level security;
alter table public.sandbox_capability_checks enable row level security;

revoke all on public.repository_onboarding_status from anon, authenticated;
revoke all on public.workspace_linear_routing from anon, authenticated;
revoke all on public.sandbox_capability_checks from anon, authenticated;

grant select on public.repository_onboarding_status to authenticated;
grant select on public.workspace_linear_routing to authenticated;
grant select on public.sandbox_capability_checks to authenticated;

grant insert, update, delete on public.repository_onboarding_status to authenticated;
grant insert, update, delete on public.workspace_linear_routing to authenticated;
grant insert, update, delete on public.sandbox_capability_checks to authenticated;

create policy repository_onboarding_status_select_membership
  on public.repository_onboarding_status
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy repository_onboarding_status_manage
  on public.repository_onboarding_status
  for all
  to authenticated
  using (public.can_manage_workspace(workspace_id))
  with check (public.can_manage_workspace(workspace_id));

create policy workspace_linear_routing_select_membership
  on public.workspace_linear_routing
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy workspace_linear_routing_manage
  on public.workspace_linear_routing
  for all
  to authenticated
  using (public.can_manage_workspace(workspace_id))
  with check (public.can_manage_workspace(workspace_id));

create policy sandbox_capability_checks_select_membership
  on public.sandbox_capability_checks
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy sandbox_capability_checks_manage
  on public.sandbox_capability_checks
  for all
  to authenticated
  using (public.can_manage_workspace(workspace_id))
  with check (public.can_manage_workspace(workspace_id));
