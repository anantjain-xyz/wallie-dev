-- Store the GitHub identity Wallie uses for commit author metadata. GitHub
-- repository access and PR creation still use the workspace GitHub App
-- installation token; this table only controls git author name/email.

create table if not exists public.user_github_identities (
  user_id uuid primary key references auth.users(id) on delete cascade,
  github_user_id bigint not null,
  github_login text not null,
  github_avatar_url text,
  author_name text not null,
  author_email text not null,
  author_email_source text not null default 'github_noreply',
  connected_at timestamptz not null default now(),
  author_email_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_github_identities_login_present check (length(trim(github_login)) > 0),
  constraint user_github_identities_author_name_present check (length(trim(author_name)) > 0),
  constraint user_github_identities_author_email_present check (length(trim(author_email)) > 0),
  constraint user_github_identities_author_email_source_known
    check (author_email_source in ('github_noreply'))
);

create unique index if not exists user_github_identities_github_user_id_unique
  on public.user_github_identities (github_user_id);

drop trigger if exists user_github_identities_touch_updated_at
  on public.user_github_identities;

create trigger user_github_identities_touch_updated_at
before update on public.user_github_identities
for each row
execute function internal.touch_updated_at();

alter table public.user_github_identities enable row level security;

revoke all on public.user_github_identities from anon, authenticated;

grant all on public.user_github_identities to service_role;
grant select, delete on public.user_github_identities to authenticated;

create policy user_github_identities_select_self
  on public.user_github_identities
  for select
  to authenticated
  using (user_id = auth.uid());

create policy user_github_identities_delete_self
  on public.user_github_identities
  for delete
  to authenticated
  using (user_id = auth.uid());
