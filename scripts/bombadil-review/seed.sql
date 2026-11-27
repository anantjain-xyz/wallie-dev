begin;
set local request.jwt.claim.role = 'service_role';
select public.set_git_continuity_release(true, revision, 'Disposable review fixture')
from public.get_git_continuity_release_state() where not enabled;

update auth.users set email = 'reviewer@example.invalid',
  raw_user_meta_data = raw_user_meta_data || '{"email":"reviewer@example.invalid","full_name":"Fixture Reviewer"}'
where id = 'a1b2c3d4-0001-4000-8000-000000000001';
update auth.identities set identity_data = identity_data || '{"email":"reviewer@example.invalid"}'
where user_id = 'a1b2c3d4-0001-4000-8000-000000000001' and provider = 'email';
update public.workspace_members set email = 'reviewer@example.invalid', full_name = 'Fixture Reviewer'
where id = 'c1b2c3d4-0001-4000-8000-000000000001';
update public.profiles set primary_email = 'reviewer@example.invalid', full_name = 'Fixture Reviewer'
where id = 'a1b2c3d4-0001-4000-8000-000000000001';

commit;
