begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

insert into auth.users(id, email) values
  ('55510000-0000-4000-8000-000000000001', 'grant-concurrency-owner@example.test');
insert into public.workspaces(id, slug, name) values
  ('55510000-1000-4000-8000-000000000001', 'execution-grant-concurrency', 'Execution grant concurrency');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  ('55510000-2000-4000-8000-000000000001', '55510000-1000-4000-8000-000000000001',
   '55510000-0000-4000-8000-000000000001', 'human', 'owner');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id,
  target_type, target_name, permissions) values
  ('55510000-3000-4000-8000-000000000001', '55510000-1000-4000-8000-000000000001', 55510001,
    'https://github.test/installations/55510001', 55501, 'Organization', 'fixture', '{"contents":"write"}');
insert into public.github_repositories(id, workspace_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch) values
  ('55510000-4000-4000-8000-000000000001', '55510000-1000-4000-8000-000000000001',
    '55510000-3000-4000-8000-000000000001', 555101, 'writer', 'fixture/writer', true,
    'https://github.test/fixture/writer', 'main');
select public.save_execution_policy('55510000-1000-4000-8000-000000000001',
  '55510000-0000-4000-8000-000000000001', 0,
  '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":30000,"maxTotalTokens":1000,"maxCostUsd":1}');
select public.create_service_principal(workspace_id, id, '55510000-0000-4000-8000-000000000001',
  'Release runner', 'release-runner')
from public.factories where workspace_id = '55510000-1000-4000-8000-000000000001' and is_default;
select public.approve_factory_execution_grant(principal.workspace_id, principal.factory_id,
  '55510000-0000-4000-8000-000000000001', principal.id, '55510000-4000-4000-8000-000000000001',
  '{}', array['files@1'], policy.current_revision_id, '55510000-2000-4000-8000-000000000001',
  clock_timestamp() + interval '1 hour', 0)
from public.service_principals principal join public.execution_policies policy using (workspace_id)
where principal.workspace_id = '55510000-1000-4000-8000-000000000001';
commit;

begin;
create function pg_temp.wait_for_stale_grant_edit() returns void language plpgsql as $$
declare deadline timestamptz := clock_timestamp() + interval '10 seconds';
begin
  while not exists (
    select 1 from pg_catalog.pg_stat_activity
    where application_name = 'op555_stale_approver' and wait_event_type = 'Lock'
  ) loop
    if clock_timestamp() > deadline then
      raise exception 'Stale grant edit never reached the decision lock';
    end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;

select extensions.dblink_connect('op555_revoke_holder', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('op555_stale_approver', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('op555_revoke_holder', 'set statement_timeout = ''20s''; set request.jwt.claim.role = ''service_role''');
select extensions.dblink_exec('op555_stale_approver',
  'set application_name = ''op555_stale_approver''; set statement_timeout = ''20s''; set request.jwt.claim.role = ''service_role''');

select extensions.dblink_exec('op555_revoke_holder', 'begin');
select is((select version from extensions.dblink('op555_revoke_holder', $sql$
  select (public.revoke_factory_execution_grant(workspace_id, factory_id,
    '55510000-0000-4000-8000-000000000001', id, 1, 'Concurrent revocation')).version
  from public.factory_execution_grants where workspace_id = '55510000-1000-4000-8000-000000000001'
$sql$) as decision(version bigint)), 2::bigint, 'the winner records revocation while holding the transaction open');

select is(extensions.dblink_send_query('op555_stale_approver', $sql$
  select (public.approve_factory_execution_grant(workspace_id, factory_id,
    '55510000-0000-4000-8000-000000000001', service_principal_id, github_repository_id,
    '{}', array['files@1', 'files@2'], execution_policy_revision_id, budget_payer_member_id,
    clock_timestamp() + interval '1 hour', 1, id)).version
  from public.factory_execution_grants where workspace_id = '55510000-1000-4000-8000-000000000001'
$sql$), 1, 'a concurrent edit attempts to expand the old version');
select pg_temp.wait_for_stale_grant_edit();
select extensions.dblink_exec('op555_revoke_holder', 'commit');
select is((select count(*) from extensions.dblink_get_result('op555_stale_approver', false) as decision(version bigint)),
  0::bigint, 'the queued edit does not restore revoked authority');
select ok(extensions.dblink_error_message('op555_stale_approver') like '%A revoked execution grant cannot be changed.%',
  'the queued edit observes the winning revocation after the lock');
select count(*) from extensions.dblink_get_result('op555_stale_approver', false) as decision(version bigint);

select ok((select revoked_at is not null and version = 2 and tool_ids = array['files@1']
    from public.factory_execution_grants where workspace_id = '55510000-1000-4000-8000-000000000001'),
  'the grant retains the winning version and original scope');
select results_eq($sql$select action from public.factory_audit_events
    where workspace_id = '55510000-1000-4000-8000-000000000001' and action like 'execution_grant.%' order by id$sql$,
  $sql$values ('execution_grant.approved'), ('execution_grant.revoked')$sql$,
  'the losing edit leaves no misleading approval audit');

select extensions.dblink_disconnect('op555_revoke_holder');
select extensions.dblink_disconnect('op555_stale_approver');
select * from finish();
delete from public.workspaces where id = '55510000-1000-4000-8000-000000000001';
delete from auth.users where id = '55510000-0000-4000-8000-000000000001';
commit;
