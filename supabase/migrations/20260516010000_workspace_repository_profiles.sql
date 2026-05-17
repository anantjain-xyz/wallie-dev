-- Workspace-selected repository profiles and static setup inference metadata.

create table public.workspace_repository_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  github_repository_id uuid not null references public.github_repositories(id) on delete cascade,
  is_primary boolean not null default true,
  package_manager text,
  language_hints text[] not null default '{}',
  framework_hints text[] not null default '{}',
  install_command text,
  build_command text,
  test_command text,
  env_key_suggestions text[] not null default '{}',
  setup_notes text not null default '',
  inference_confidence text not null default 'low',
  inference_sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_repository_profiles_workspace_repo_unique
    unique (workspace_id, github_repository_id),
  constraint workspace_repository_profiles_known_confidence check (
    inference_confidence in ('low', 'medium', 'high', 'manual')
  ),
  constraint workspace_repository_profiles_inference_sources_array check (
    jsonb_typeof(inference_sources) = 'array'
  )
);

create unique index workspace_repository_profiles_one_primary_per_workspace
  on public.workspace_repository_profiles (workspace_id)
  where is_primary;

create index workspace_repository_profiles_workspace_idx
  on public.workspace_repository_profiles (workspace_id);

create index workspace_repository_profiles_repository_idx
  on public.workspace_repository_profiles (github_repository_id);

create or replace function internal.enforce_workspace_repository_profile_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(
    new.workspace_id,
    'public.github_repositories',
    new.github_repository_id,
    'github_repository_id'
  );

  return new;
end;
$$;

create trigger workspace_repository_profiles_touch_updated_at
before update on public.workspace_repository_profiles
for each row
execute function internal.touch_updated_at();

create trigger workspace_repository_profiles_enforce_refs
before insert or update on public.workspace_repository_profiles
for each row
execute function internal.enforce_workspace_repository_profile_refs();

alter table public.workspace_repository_profiles enable row level security;

revoke all on public.workspace_repository_profiles from anon, authenticated;

grant select on public.workspace_repository_profiles to authenticated;
grant insert, update, delete on public.workspace_repository_profiles to authenticated;

create policy workspace_repository_profiles_select_membership
  on public.workspace_repository_profiles
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy workspace_repository_profiles_insert_managers
  on public.workspace_repository_profiles
  for insert
  to authenticated
  with check (public.can_manage_workspace(workspace_id));

create policy workspace_repository_profiles_update_managers
  on public.workspace_repository_profiles
  for update
  to authenticated
  using (public.can_manage_workspace(workspace_id))
  with check (public.can_manage_workspace(workspace_id));

create policy workspace_repository_profiles_delete_managers
  on public.workspace_repository_profiles
  for delete
  to authenticated
  using (public.can_manage_workspace(workspace_id));

create or replace function public.save_workspace_repository_profile(
  target_workspace_id uuid,
  target_github_repository_id uuid,
  selected_package_manager text,
  selected_language_hints text[],
  selected_framework_hints text[],
  selected_install_command text,
  selected_build_command text,
  selected_test_command text,
  selected_env_key_suggestions text[],
  selected_setup_notes text,
  selected_inference_confidence text,
  selected_inference_sources jsonb
)
returns public.workspace_repository_profiles
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved_profile public.workspace_repository_profiles;
begin
  update public.workspace_repository_profiles
     set is_primary = false
   where workspace_id = target_workspace_id
     and github_repository_id <> target_github_repository_id
     and is_primary;

  insert into public.workspace_repository_profiles (
    workspace_id,
    github_repository_id,
    is_primary,
    package_manager,
    language_hints,
    framework_hints,
    install_command,
    build_command,
    test_command,
    env_key_suggestions,
    setup_notes,
    inference_confidence,
    inference_sources
  )
  values (
    target_workspace_id,
    target_github_repository_id,
    true,
    selected_package_manager,
    selected_language_hints,
    selected_framework_hints,
    selected_install_command,
    selected_build_command,
    selected_test_command,
    selected_env_key_suggestions,
    selected_setup_notes,
    selected_inference_confidence,
    selected_inference_sources
  )
  on conflict (workspace_id, github_repository_id)
  do update set
    is_primary = true,
    package_manager = excluded.package_manager,
    language_hints = excluded.language_hints,
    framework_hints = excluded.framework_hints,
    install_command = excluded.install_command,
    build_command = excluded.build_command,
    test_command = excluded.test_command,
    env_key_suggestions = excluded.env_key_suggestions,
    setup_notes = excluded.setup_notes,
    inference_confidence = excluded.inference_confidence,
    inference_sources = excluded.inference_sources
  returning * into saved_profile;

  return saved_profile;
end;
$$;

grant execute on function public.save_workspace_repository_profile(
  uuid,
  uuid,
  text,
  text[],
  text[],
  text,
  text,
  text,
  text[],
  text,
  text,
  jsonb
) to authenticated;
