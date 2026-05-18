-- Track the repository selected during onboarding separately from the
-- repository profile inferred and saved in the following step.

alter table public.workspace_onboarding
  add column selected_github_repository_id uuid
    references public.github_repositories(id) on delete set null;

update public.workspace_onboarding onboarding
   set selected_github_repository_id = profile.github_repository_id
  from public.workspace_repository_profiles profile
 where profile.workspace_id = onboarding.workspace_id
   and profile.is_primary
   and onboarding.selected_github_repository_id is null;

create index workspace_onboarding_selected_repository_idx
  on public.workspace_onboarding (selected_github_repository_id);

create or replace function internal.enforce_workspace_onboarding_selected_repository_ref()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.selected_github_repository_id is null then
    return new;
  end if;

  perform internal.assert_workspace_match(
    new.workspace_id,
    'public.github_repositories',
    new.selected_github_repository_id,
    'selected_github_repository_id'
  );

  return new;
end;
$$;

create trigger workspace_onboarding_enforce_selected_repository_ref
before insert or update on public.workspace_onboarding
for each row
execute function internal.enforce_workspace_onboarding_selected_repository_ref();
