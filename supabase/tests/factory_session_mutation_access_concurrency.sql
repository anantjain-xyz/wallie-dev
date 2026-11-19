begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.mutation_access_id(slot integer) returns uuid language sql immutable as $$
  select ('57130000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
insert into auth.users(id,email) values
  (pg_temp.mutation_access_id(1),'mutation-lock-manager@example.test'),
  (pg_temp.mutation_access_id(2),'mutation-lock-member@example.test');
insert into public.workspaces(id,slug,name)
values (pg_temp.mutation_access_id(3),'session-mutation-access-locks','Session mutation lock order');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  (pg_temp.mutation_access_id(4),pg_temp.mutation_access_id(3),pg_temp.mutation_access_id(1),'human','owner'),
  (pg_temp.mutation_access_id(5),pg_temp.mutation_access_id(3),pg_temp.mutation_access_id(2),'human','member');
create temp table mutation_factory as select * from public.create_factory(
  pg_temp.mutation_access_id(3),pg_temp.mutation_access_id(1),'Restricted factory','mutation-lock-factory');
select public.grant_factory_membership(pg_temp.mutation_access_id(3),id,pg_temp.mutation_access_id(1),
  pg_temp.mutation_access_id(5),'member') from mutation_factory;
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions)
values (pg_temp.mutation_access_id(6),pg_temp.mutation_access_id(3),57130001,'https://github.test/installations/57130001',
  571300,'Organization','mutation-locks','{"contents":"write"}');
insert into public.github_repositories(id,workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch)
select pg_temp.mutation_access_id(7),workspace_id,id,pg_temp.mutation_access_id(6),57130007,'writer','fixture/writer',true,
  'https://github.test/fixture/writer','main' from mutation_factory;
create temp table mutation_policy as select * from public.save_execution_policy(pg_temp.mutation_access_id(3),pg_temp.mutation_access_id(1),0,
  '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":30000,"maxTotalTokens":null,"maxCostUsd":null}');
create temp table mutation_principal as select principal.* from mutation_factory factory
cross join lateral public.create_service_principal(factory.workspace_id,factory.id,pg_temp.mutation_access_id(1),
  'Service command','service-command') principal;
create temp table mutation_grant as select approved.* from mutation_principal principal cross join mutation_policy policy
cross join lateral public.approve_factory_execution_grant(principal.workspace_id,principal.factory_id,pg_temp.mutation_access_id(1),
  principal.id,pg_temp.mutation_access_id(7),'{}','{}',policy.id,pg_temp.mutation_access_id(4),clock_timestamp()+interval '1 hour',0,null,
  '{sessions:create}'::public.factory_command_scope[]) approved;

create function pg_temp.mutation_access_query() returns text language sql as $$
  select format($query$
    select internal.assert_session_mutation_actor(
      row(%L,%L,%L,null,null,%L,%L,%L,null)::internal.session_mutation_actor, 'create')::text
  $query$,workspace_id,factory_id,pg_temp.mutation_access_id(5),id,version,github_repository_id)
  from mutation_grant
$$;
select lives_ok(pg_temp.mutation_access_query(),'active delegated member can authorize the grant-backed command');
commit;

begin;
select extensions.dblink_connect('mutation_revoker',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('mutation_invoker',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('mutation_revoker',
  'set application_name=''mutation_revoker''; set lock_timeout=''3s''; set request.jwt.claim.role=''service_role''');
select extensions.dblink_exec('mutation_invoker',
  'set application_name=''mutation_invoker''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');
create temp table mutation_revoker_pid as select * from extensions.dblink('mutation_revoker','select pg_backend_pid()') result(pid integer);

create function pg_temp.wait_for_mutation_factory() returns boolean language plpgsql as $$
declare deadline timestamptz := clock_timestamp()+interval '5 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists (
      select 1 from pg_stat_activity activity cross join mutation_revoker_pid revoker
      where activity.application_name='mutation_invoker' and revoker.pid=any(pg_blocking_pids(activity.pid))
    ) then return true; end if;
    if clock_timestamp() >= deadline then return false; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;

-- Pause a separate revocation transaction just after taking the factory fence.
-- The old command order then held the revoked membership while waiting on us.
select extensions.dblink_exec('mutation_revoker','begin');
select result.id from mutation_factory factory
cross join lateral extensions.dblink('mutation_revoker',
  format('select id from public.factories where id=%L for update',factory.id)) result(id uuid);
select extensions.dblink_send_query('mutation_invoker',pg_temp.mutation_access_query());
select ok(pg_temp.wait_for_mutation_factory(),'the command waits on the revocation transaction’s factory fence');

select is((select count(*) from mutation_factory factory cross join lateral extensions.dblink('mutation_revoker',
  format('select id from public.revoke_factory_membership(%L,%L,%L,%L)',
    factory.workspace_id,factory.id,pg_temp.mutation_access_id(1),pg_temp.mutation_access_id(5)),
  false) result(id uuid)),1::bigint,'membership revocation can lock its target and finish without a lock cycle');
select extensions.dblink_exec('mutation_revoker','commit');
select is((select count(*) from extensions.dblink_get_result('mutation_invoker',false) result(authorized text)),0::bigint,
  'the racing command cannot continue using the revoked membership');
select ok(extensions.dblink_error_message('mutation_invoker') like '%no longer has factory access%',
  'the waiting command observes the committed access denial');
select count(*) from extensions.dblink_get_result('mutation_invoker',false) result(authorized text);
select extensions.dblink_disconnect('mutation_invoker');
select extensions.dblink_disconnect('mutation_revoker');

delete from public.workspaces where id=pg_temp.mutation_access_id(3);
delete from auth.users where id in (pg_temp.mutation_access_id(1),pg_temp.mutation_access_id(2));
select * from finish();
commit;
