-- Workspace onboarding state, setup-health foundations, and create-workspace
-- seed behavior.

create table public.workspace_onboarding (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  status text not null default 'not_started',
  current_step text not null default 'github',
  completed_steps text[] not null default '{}',
  skipped_steps text[] not null default '{}',
  dismissed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_onboarding_known_status check (
    status in ('not_started', 'in_progress', 'dismissed', 'completed')
  ),
  constraint workspace_onboarding_known_current_step check (
    current_step in ('github', 'repository', 'pipeline', 'linear', 'runtime', 'verify')
  ),
  constraint workspace_onboarding_known_completed_steps check (
    completed_steps <@ array['github', 'repository', 'pipeline', 'linear', 'runtime', 'verify']::text[]
  ),
  constraint workspace_onboarding_known_skipped_steps check (
    skipped_steps <@ array['github', 'repository', 'pipeline', 'linear', 'runtime', 'verify']::text[]
  )
);

insert into public.workspace_onboarding (workspace_id)
select workspace_record.id
from public.workspaces workspace_record
on conflict (workspace_id) do nothing;

create trigger workspace_onboarding_touch_updated_at
before update on public.workspace_onboarding
for each row
execute function internal.touch_updated_at();

alter table public.workspace_onboarding enable row level security;

revoke all on public.workspace_onboarding from anon, authenticated;

grant select on public.workspace_onboarding to authenticated;
grant insert, update on public.workspace_onboarding to authenticated;

create policy workspace_onboarding_select_membership
  on public.workspace_onboarding
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy workspace_onboarding_insert_managers
  on public.workspace_onboarding
  for insert
  to authenticated
  with check (public.can_manage_workspace(workspace_id));

create policy workspace_onboarding_update_managers
  on public.workspace_onboarding
  for update
  to authenticated
  using (public.can_manage_workspace(workspace_id))
  with check (public.can_manage_workspace(workspace_id));

create or replace function public.create_workspace(
  workspace_name text,
  requested_slug text default null
)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  actor_email text := nullif(auth.jwt() ->> 'email', '');
  actor_full_name text := nullif(
    coalesce(
      auth.jwt() -> 'user_metadata' ->> 'full_name',
      auth.jwt() -> 'user_metadata' ->> 'name'
    ),
    ''
  );
  actor_avatar_url text := nullif(
    coalesce(
      auth.jwt() -> 'user_metadata' ->> 'avatar_url',
      auth.jwt() -> 'user_metadata' ->> 'picture'
    ),
    ''
  );
  base_slug text;
  candidate_slug text;
  suffix integer := 0;
  created_workspace public.workspaces%rowtype;
  profile_row public.profiles%rowtype;
  default_pipeline_id uuid;
begin
  if actor_id is null then
    raise exception 'Authenticated user required to create a workspace'
      using errcode = '42501';
  end if;

  workspace_name := btrim(coalesce(workspace_name, ''));

  if workspace_name = '' then
    raise exception 'workspace_name is required'
      using errcode = '22023';
  end if;

  base_slug := internal.slugify_workspace_value(
    coalesce(nullif(btrim(requested_slug), ''), workspace_name)
  );

  if base_slug = '' then
    base_slug := 'workspace';
  end if;

  candidate_slug := base_slug;

  while exists (
    select 1
    from public.workspaces workspace_record
    where workspace_record.slug = candidate_slug
  ) loop
    suffix := suffix + 1;
    candidate_slug := base_slug || '-' || suffix;
  end loop;

  select *
  into profile_row
  from public.profiles profile_record
  where profile_record.id = actor_id;

  insert into public.workspaces (
    slug,
    name,
    created_by
  )
  values (
    candidate_slug,
    workspace_name,
    actor_id
  )
  returning *
  into created_workspace;

  insert into public.workspace_members (
    workspace_id,
    user_id,
    kind,
    role,
    email,
    full_name,
    avatar_url
  )
  values (
    created_workspace.id,
    actor_id,
    'human',
    'owner',
    coalesce(profile_row.primary_email, actor_email),
    coalesce(profile_row.full_name, actor_full_name),
    coalesce(profile_row.avatar_url, actor_avatar_url)
  );

  insert into public.workspace_members (
    workspace_id,
    kind,
    role,
    username,
    full_name
  )
  values (
    created_workspace.id,
    'system',
    'agent',
    'wallie',
    'Wallie'
  );

  insert into internal.workspace_issue_counters (
    workspace_id,
    last_issue_number
  )
  values (
    created_workspace.id,
    0
  )
  on conflict (workspace_id) do nothing;

  -- Seed the default pipeline so new workspaces have a working flow without
  -- needing to open settings first. Owners can edit/replace it from the UI.
  insert into public.pipelines (workspace_id, name, is_default)
  values (created_workspace.id, 'Default', true)
  returning id into default_pipeline_id;

  insert into public.pipeline_stages (
    pipeline_id, workspace_id, position, slug, name, description, prompt_template_md
  )
  select
    default_pipeline_id,
    created_workspace.id,
    s.stage_position,
    s.slug,
    s.name,
    s.description,
    s.prompt_template_md
  from internal.default_pipeline_stages() s;

  insert into public.workspace_onboarding (workspace_id)
  values (created_workspace.id);

  return created_workspace;
end;
$$;
