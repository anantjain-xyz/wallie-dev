begin;

create extension if not exists pgtap with schema extensions;

select plan(12);
set local "request.jwt.claim.role" = 'service_role';

select is(
  (select public from storage.buckets where id = 'profile-avatars'),
  true,
  'profile avatar bucket is public'
);
select is(
  (select file_size_limit from storage.buckets where id = 'profile-avatars'),
  2097152::bigint,
  'profile avatar bucket limits files to 2 MB'
);
select is(
  (select allowed_mime_types from storage.buckets where id = 'profile-avatars'),
  array['image/jpeg', 'image/png', 'image/webp']::text[],
  'profile avatar bucket accepts the supported image types'
);

insert into public.workspaces (id, slug, name)
values (
  'f1b2c3d4-0001-4000-8000-000000000001',
  'profile-avatar-proof',
  'Profile avatar proof'
);

insert into public.workspace_members (
  id,
  workspace_id,
  user_id,
  kind,
  role,
  full_name,
  avatar_url,
  is_active
)
values (
  'f2b2c3d4-0001-4000-8000-000000000001',
  'f1b2c3d4-0001-4000-8000-000000000001',
  'a1b2c3d4-0001-4000-8000-000000000001',
  'human',
  'member',
  'Old name',
  'https://provider.example/old.png',
  false
);

select public.update_user_profile(
  'a1b2c3d4-0001-4000-8000-000000000001',
  'Avatar Owner',
  true,
  'http://127.0.0.1:54321/storage/v1/object/public/profile-avatars/a1b2c3d4-0001-4000-8000-000000000001/custom.png',
  'a1b2c3d4-0001-4000-8000-000000000001/custom.png'
);

select ok(
  (
    select avatar_overridden
      and avatar_path = 'a1b2c3d4-0001-4000-8000-000000000001/custom.png'
      and avatar_url like '%/custom.png'
    from public.profiles
    where id = 'a1b2c3d4-0001-4000-8000-000000000001'
  ),
  'an uploaded avatar becomes the explicit profile choice'
);
select ok(
  not exists (
    select 1
    from public.workspace_members
    where user_id = 'a1b2c3d4-0001-4000-8000-000000000001'
      and kind = 'human'
      and (
        full_name <> 'Avatar Owner'
        or avatar_url not like '%/custom.png'
      )
  ),
  'profile publication updates active and inactive human memberships'
);

insert into public.workspaces (id, slug, name)
values (
  'f1b2c3d4-0002-4000-8000-000000000002',
  'profile-avatar-custom-membership',
  'Profile avatar custom membership'
);
insert into public.workspace_members (
  workspace_id,
  user_id,
  kind,
  role,
  avatar_url
)
values (
  'f1b2c3d4-0002-4000-8000-000000000002',
  'a1b2c3d4-0001-4000-8000-000000000001',
  'human',
  'member',
  'https://provider.example/restored.png'
);

select is(
  (
    select avatar_url
    from public.workspace_members
    where workspace_id = 'f1b2c3d4-0002-4000-8000-000000000002'
      and user_id = 'a1b2c3d4-0001-4000-8000-000000000001'
  ),
  'http://127.0.0.1:54321/storage/v1/object/public/profile-avatars/a1b2c3d4-0001-4000-8000-000000000001/custom.png',
  'new memberships inherit the custom profile avatar instead of provider metadata'
);

select public.update_user_profile(
  'a1b2c3d4-0001-4000-8000-000000000001',
  'Avatar Owner',
  true,
  null,
  null
);

select ok(
  (
    select avatar_overridden and avatar_url is null and avatar_path is null
    from public.profiles
    where id = 'a1b2c3d4-0001-4000-8000-000000000001'
  ),
  'removal records an explicit initials choice'
);
select ok(
  not exists (
    select 1
    from public.workspace_members
    where user_id = 'a1b2c3d4-0001-4000-8000-000000000001'
      and kind = 'human'
      and avatar_url is not null
  ),
  'removal clears every human membership avatar'
);

set local role authenticated;
set local "request.jwt.claim.sub" = 'a1b2c3d4-0001-4000-8000-000000000001';

select is(
  (public.ensure_own_profile(
    'owner@example.com',
    'Provider Name',
    'https://provider.example/restored.png'
  )).avatar_url,
  null::text,
  'auth profile seeding cannot restore an explicitly removed avatar'
);

reset role;
set local "request.jwt.claim.role" = 'service_role';

insert into public.workspaces (id, slug, name)
values (
  'f1b2c3d4-0003-4000-8000-000000000003',
  'profile-avatar-removed-membership',
  'Profile avatar removed membership'
);
insert into public.workspace_members (
  workspace_id,
  user_id,
  kind,
  role,
  avatar_url
)
values (
  'f1b2c3d4-0003-4000-8000-000000000003',
  'a1b2c3d4-0001-4000-8000-000000000001',
  'human',
  'member',
  'https://provider.example/restored.png'
);

select is(
  (
    select avatar_url
    from public.workspace_members
    where workspace_id = 'f1b2c3d4-0003-4000-8000-000000000003'
      and user_id = 'a1b2c3d4-0001-4000-8000-000000000001'
  ),
  null::text,
  'new memberships preserve an explicit removal'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.update_user_profile(uuid, text, boolean, text, text)',
    'execute'
  ),
  'authenticated users cannot invoke the privileged profile publisher directly'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.update_user_profile(uuid, text, boolean, text, text)',
    'execute'
  ),
  'the service role can invoke the profile publisher'
);

select * from finish();
rollback;
