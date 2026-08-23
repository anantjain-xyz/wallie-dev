alter table public.profiles
  add column avatar_path text,
  add column avatar_overridden boolean not null default false;

alter table public.profiles
  add constraint profiles_avatar_path_shape_check
  check (
    avatar_path is null
    or (
      avatar_overridden
      and nullif(btrim(avatar_url), '') is not null
      and avatar_path like id::text || '/%'
    )
  );

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'profile-avatars',
  'profile-avatars',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id)
do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Provider metadata may initialize an avatar until the user explicitly uploads
-- or removes one. After that explicit choice, auth refreshes must preserve it,
-- including a deliberate null that renders as initials.
create or replace function public.ensure_own_profile(
  actor_email text default null,
  actor_full_name text default null,
  actor_avatar_url text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_user_id uuid := auth.uid();
  normalized_full_name text := nullif(btrim(actor_full_name), '');
  saved_profile public.profiles%rowtype;
begin
  if actor_user_id is null then
    raise exception 'Authenticated user required to ensure a profile'
      using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(actor_user_id::text, 0)
  );

  if normalized_full_name is not null
    and char_length(normalized_full_name) > 100 then
    normalized_full_name := null;
  end if;

  insert into public.profiles as profile (
    id,
    primary_email,
    full_name,
    avatar_url
  )
  values (
    actor_user_id,
    nullif(btrim(actor_email), ''),
    normalized_full_name,
    nullif(btrim(actor_avatar_url), '')
  )
  on conflict (id)
  do update
    set primary_email = coalesce(excluded.primary_email, profile.primary_email),
        full_name = coalesce(nullif(btrim(profile.full_name), ''), excluded.full_name),
        avatar_url = case
          when profile.avatar_overridden then profile.avatar_url
          else coalesce(excluded.avatar_url, profile.avatar_url)
        end
  returning * into saved_profile;

  if nullif(btrim(saved_profile.full_name), '') is not null
    and char_length(btrim(saved_profile.full_name)) <= 100 then
    update public.workspace_members
    set full_name = btrim(saved_profile.full_name)
    where user_id = actor_user_id
      and kind = 'human'
      and nullif(btrim(full_name), '') is null;
  end if;

  return saved_profile;
end;
$$;

revoke all on function public.ensure_own_profile(text, text, text)
  from public, anon, authenticated;
grant execute on function public.ensure_own_profile(text, text, text)
  to authenticated;

-- Keep every newly created or reactivated human membership aligned with an
-- explicit profile-avatar choice. Existing provider-seeded profiles retain the
-- legacy creation and invitation fallback behavior.
create or replace function internal.preserve_profile_avatar_override()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  profile_avatar_overridden boolean;
  profile_avatar_url text;
begin
  if new.kind = 'human' and new.user_id is not null then
    select profile.avatar_overridden, profile.avatar_url
    into profile_avatar_overridden, profile_avatar_url
    from public.profiles as profile
    where profile.id = new.user_id;

    if found and profile_avatar_overridden then
      new.avatar_url := profile_avatar_url;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function internal.preserve_profile_avatar_override()
  from public, anon, authenticated;

create trigger workspace_members_preserve_profile_avatar_override
before insert or update of avatar_url, kind, user_id
on public.workspace_members
for each row
execute function internal.preserve_profile_avatar_override();

-- The service-role route authenticates the caller and generates storage URLs.
-- This function owns the atomic profile + membership publication boundary.
create or replace function public.update_user_profile(
  actor_user_id uuid,
  actor_full_name text,
  actor_avatar_changed boolean default false,
  actor_avatar_url text default null,
  actor_avatar_path text default null
)
returns public.profiles
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_full_name text := btrim(coalesce(actor_full_name, ''));
  normalized_avatar_url text := nullif(btrim(actor_avatar_url), '');
  normalized_avatar_path text := nullif(btrim(actor_avatar_path), '');
  saved_profile public.profiles%rowtype;
begin
  if actor_user_id is null then
    raise exception 'actor_user_id is required'
      using errcode = '22023';
  end if;

  if normalized_full_name = '' then
    raise exception 'actor_full_name is required'
      using errcode = '22023';
  end if;

  if char_length(normalized_full_name) > 100 then
    raise exception 'actor_full_name must be 100 characters or fewer'
      using errcode = '22023';
  end if;

  if not actor_avatar_changed
    and (normalized_avatar_url is not null or normalized_avatar_path is not null) then
    raise exception 'avatar values require actor_avatar_changed'
      using errcode = '22023';
  end if;

  if actor_avatar_changed
    and ((normalized_avatar_url is null) <> (normalized_avatar_path is null)) then
    raise exception 'avatar URL and path must both be set or both be null'
      using errcode = '22023';
  end if;

  if normalized_avatar_path is not null
    and normalized_avatar_path not like actor_user_id::text || '/%' then
    raise exception 'avatar path must belong to actor_user_id'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(actor_user_id::text, 0)
  );

  insert into public.profiles as profile (
    id,
    full_name,
    avatar_url,
    avatar_path,
    avatar_overridden
  )
  values (
    actor_user_id,
    normalized_full_name,
    case when actor_avatar_changed then normalized_avatar_url else null end,
    case when actor_avatar_changed then normalized_avatar_path else null end,
    actor_avatar_changed
  )
  on conflict (id)
  do update
    set full_name = excluded.full_name,
        avatar_url = case
          when actor_avatar_changed then excluded.avatar_url
          else profile.avatar_url
        end,
        avatar_path = case
          when actor_avatar_changed then excluded.avatar_path
          else profile.avatar_path
        end,
        avatar_overridden = case
          when actor_avatar_changed then true
          else profile.avatar_overridden
        end
  returning * into saved_profile;

  update public.workspace_members
  set full_name = normalized_full_name,
      avatar_url = saved_profile.avatar_url
  where user_id = actor_user_id
    and kind = 'human';

  return saved_profile;
end;
$$;

revoke all on function public.update_user_profile(uuid, text, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.update_user_profile(uuid, text, boolean, text, text)
  to service_role;

-- Retain the existing service-role API for callers that only update names.
create or replace function public.update_user_display_name(
  actor_user_id uuid,
  actor_full_name text
)
returns public.profiles
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.update_user_profile(
    actor_user_id,
    actor_full_name,
    false,
    null,
    null
  );
$$;

revoke all on function public.update_user_display_name(uuid, text)
  from public, anon, authenticated;
grant execute on function public.update_user_display_name(uuid, text)
  to service_role;
