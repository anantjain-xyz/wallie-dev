begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

insert into auth.users(id, email) values
  ('55a00000-0000-4000-8000-000000000001', 'factory-lock-owner@example.test'),
  ('55a00000-0000-4000-8000-000000000002', 'factory-lock-inherited@example.test'),
  ('55a00000-0000-4000-8000-000000000003', 'factory-lock-delegated@example.test');
insert into public.workspaces(id, name, slug)
values ('55a00000-0001-4000-8000-000000000001', 'Factory membership lock ordering', 'factory-membership-locks');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  ('55a00000-0002-4000-8000-000000000001', '55a00000-0001-4000-8000-000000000001',
    '55a00000-0000-4000-8000-000000000001', 'human', 'owner'),
  ('55a00000-0002-4000-8000-000000000002', '55a00000-0001-4000-8000-000000000001',
    '55a00000-0000-4000-8000-000000000002', 'human', 'admin'),
  ('55a00000-0002-4000-8000-000000000003', '55a00000-0001-4000-8000-000000000001',
    '55a00000-0000-4000-8000-000000000003', 'human', 'admin');

select is((select role from public.read_factory_scope(
  '55a00000-0001-4000-8000-000000000001', '55a00000-0000-4000-8000-000000000002'
) where is_default), 'manager', 'the current workspace admin is a factory operator');
update public.workspace_members set role = 'member'
where id = '55a00000-0002-4000-8000-000000000002';
select is((select role from public.read_factory_scope(
  '55a00000-0001-4000-8000-000000000001', '55a00000-0000-4000-8000-000000000002'
) where is_default), 'member', 'workspace demotion keeps ordinary default-factory access');
select throws_ok($sql$
  select public.archive_factory(
    '55a00000-0001-4000-8000-000000000001',
    (select id from public.factories where workspace_id = '55a00000-0001-4000-8000-000000000001' and is_default),
    '55a00000-0000-4000-8000-000000000002'
  )
$sql$, '42501', 'Factory manager access is required.',
  'workspace demotion removes inherited operator authority');

select public.create_factory('55a00000-0001-4000-8000-000000000001',
  '55a00000-0000-4000-8000-000000000001', 'Delegation', 'delegation');
select public.grant_factory_membership(
  '55a00000-0001-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55a00000-0001-4000-8000-000000000001' and slug = 'delegation'),
  '55a00000-0000-4000-8000-000000000001', '55a00000-0002-4000-8000-000000000003', 'manager'
);
update public.workspace_members set role = 'member'
where id = '55a00000-0002-4000-8000-000000000003';
select is((select role from public.read_factory_scope(
  '55a00000-0001-4000-8000-000000000001', '55a00000-0000-4000-8000-000000000003'
) where slug = 'delegation'), 'manager', 'workspace demotion preserves explicit factory delegation');
commit;

begin;
create function pg_temp.wait_factory_membership_lock() returns void language plpgsql as $$
declare deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
  while not exists (
    select 1 from pg_catalog.pg_stat_activity
    where application_name = 'factory_member_contender' and wait_event_type = 'Lock'
  ) loop
    if clock_timestamp() > deadline then
      raise exception 'Expected factory membership lock boundary not reached';
    end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;

select extensions.dblink_connect('factory_member_owner', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('factory_member_contender', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('factory_member_owner',
  'set application_name = ''factory_member_owner''; set statement_timeout = ''15s''; set request.jwt.claim.role = ''service_role''');
select extensions.dblink_exec('factory_member_contender',
  'set application_name = ''factory_member_contender''; set statement_timeout = ''15s''; set request.jwt.claim.role = ''service_role''');

-- Removal and a grant to the same workspace member can complete in lock order.
select extensions.dblink_exec('factory_member_owner', 'begin');
select * from extensions.dblink('factory_member_owner', $sql$
  select id from public.workspace_members where id = '55a00000-0002-4000-8000-000000000002' for no key update
$sql$) as result(id uuid);
select extensions.dblink_send_query('factory_member_contender', $sql$
  select id from public.grant_factory_membership(
    '55a00000-0001-4000-8000-000000000001',
    (select id from public.factories where workspace_id = '55a00000-0001-4000-8000-000000000001' and is_default),
    '55a00000-0000-4000-8000-000000000001', '55a00000-0002-4000-8000-000000000002', 'manager'
  )
$sql$);
select pg_temp.wait_factory_membership_lock();
select is((select count(*) from extensions.dblink('factory_member_owner', $sql$
  select id from public.remove_workspace_member('55a00000-0002-4000-8000-000000000002',
    '55a00000-0001-4000-8000-000000000001')
$sql$) as result(id uuid)), 1::bigint, 'workspace removal completes while the grant waits on its member row');
select extensions.dblink_exec('factory_member_owner', 'commit');
select is((select count(*) from extensions.dblink_get_result('factory_member_contender', false) as result(id uuid)),
  0::bigint, 'the losing grant creates no membership');
select ok(extensions.dblink_error_message('factory_member_contender') like '%An active workspace member is required.%',
  'the losing grant observes the committed inactive state');
select count(*) from extensions.dblink_get_result('factory_member_contender', false) as result(id uuid);

-- Acting on a delegated manager grant waits for the factory and then checks
-- the grant that still exists after the revocation commits.
select extensions.dblink_exec('factory_member_owner', 'begin');
select * from extensions.dblink('factory_member_owner', $sql$
  select id from public.revoke_factory_membership(
    '55a00000-0001-4000-8000-000000000001',
    (select id from public.factories where workspace_id = '55a00000-0001-4000-8000-000000000001' and slug = 'delegation'),
    '55a00000-0000-4000-8000-000000000001', '55a00000-0002-4000-8000-000000000003'
  )
$sql$) as result(id uuid);
select extensions.dblink_send_query('factory_member_contender', $sql$
  select id from public.archive_factory(
    '55a00000-0001-4000-8000-000000000001',
    (select id from public.factories where workspace_id = '55a00000-0001-4000-8000-000000000001' and slug = 'delegation'),
    '55a00000-0000-4000-8000-000000000003'
  )
$sql$);
select pg_temp.wait_factory_membership_lock();
select extensions.dblink_exec('factory_member_owner', 'commit');
select is((select count(*) from extensions.dblink_get_result('factory_member_contender', false) as result(id uuid)),
  0::bigint, 'revocation winning the factory lock blocks the queued command');
select ok(extensions.dblink_error_message('factory_member_contender') like '%Factory manager access is required.%',
  'the queued command rechecks the delegated grant after the lock');
select count(*) from extensions.dblink_get_result('factory_member_contender', false) as result(id uuid);

select extensions.dblink_disconnect('factory_member_owner');
select extensions.dblink_disconnect('factory_member_contender');

-- A workspace operator can manage a factory whose sole explicit manager was
-- removed. Fallback must avoid storing an unnecessary delegated grant.
set local request.jwt.claim.role = 'service_role';
update public.workspace_members set role = 'admin'
where id = '55a00000-0002-4000-8000-000000000003';
select public.create_factory('55a00000-0001-4000-8000-000000000001',
  '55a00000-0000-4000-8000-000000000003', 'Operator fallback', 'operator-fallback');
select public.grant_factory_membership(
  '55a00000-0001-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55a00000-0001-4000-8000-000000000001'
    and slug = 'operator-fallback'),
  '55a00000-0000-4000-8000-000000000003', '55a00000-0002-4000-8000-000000000001', 'member'
);
select id from public.remove_workspace_member('55a00000-0002-4000-8000-000000000003',
  '55a00000-0001-4000-8000-000000000001');
select is((select membership.role from public.factory_members membership
  join public.factories factory on factory.id = membership.factory_id
  where factory.slug = 'operator-fallback'
    and membership.member_id = '55a00000-0002-4000-8000-000000000001' and membership.revoked_at is null),
  'member', 'operator fallback preserves the existing ordinary grant');
select is((select role from public.read_factory_scope(
  '55a00000-0001-4000-8000-000000000001', '55a00000-0000-4000-8000-000000000001'
) where slug = 'operator-fallback'), 'manager', 'the live workspace operator can manage the factory');

select * from finish();
delete from public.workspaces where id = '55a00000-0001-4000-8000-000000000001';
delete from auth.users where id in ('55a00000-0000-4000-8000-000000000001',
  '55a00000-0000-4000-8000-000000000002', '55a00000-0000-4000-8000-000000000003');
commit;
