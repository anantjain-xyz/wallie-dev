begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';
insert into public.workspaces(id,name,slug) values
 ('af130000-0000-4000-8000-000000000001','Setup write first','setup-write-first'),
 ('af130000-0000-4000-8000-000000000002','Setup deletion first','setup-deletion-first');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
 ('af130000-0000-4000-8000-000000000031','af130000-0000-4000-8000-000000000001','a1b2c3d4-0001-4000-8000-000000000001','human','owner'),
 ('af130000-0000-4000-8000-000000000032','af130000-0000-4000-8000-000000000002','a1b2c3d4-0001-4000-8000-000000000001','human','owner');
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions) values
 ('af130000-0000-4000-8000-000000000021','af130000-0000-4000-8000-000000000001',981321,'https://github.com/installations/981321',9813,'Organization','Setup admission','{}'),
 ('af130000-0000-4000-8000-000000000022','af130000-0000-4000-8000-000000000002',981322,'https://github.com/installations/981322',9813,'Organization','Setup admission','{}');
insert into public.github_repositories(id,workspace_id,github_installation_id,repo_id,name,full_name,private,html_url) values
 ('af130000-0000-4000-8000-000000000011','af130000-0000-4000-8000-000000000001','af130000-0000-4000-8000-000000000021',981311,'a','admission/a',true,'https://github.com/admission/a'),
 ('af130000-0000-4000-8000-000000000012','af130000-0000-4000-8000-000000000002','af130000-0000-4000-8000-000000000022',981312,'b','admission/b',true,'https://github.com/admission/b'),
 ('af130000-0000-4000-8000-000000000013','af130000-0000-4000-8000-000000000002','af130000-0000-4000-8000-000000000022',981313,'c','admission/c',true,'https://github.com/admission/c');
insert into public.repository_onboarding_status(workspace_id,github_repository_id,status,setup_branch_name,setup_pr_number,setup_pr_state,setup_pr_updated_at) values
 ('af130000-0000-4000-8000-000000000001','af130000-0000-4000-8000-000000000011','pr_open','wallie/setup-a',81,'open','2026-10-11 00:00:01Z'),
 ('af130000-0000-4000-8000-000000000002','af130000-0000-4000-8000-000000000012','pr_open','wallie/setup-b',82,'open','2026-10-11 00:00:01Z');
create temp table setup_observation as select public.begin_github_pull_request_observation(
 'af130000-0000-4000-8000-000000000002','af130000-0000-4000-8000-000000000012',
 'wallie/setup-b',82,'closed',false,'2026-10-11 00:00:01Z') as token;
commit;
begin;
set local request.jwt.claim.role='service_role';

create function pg_temp.wait_setup_admission_lock(application text) returns void language plpgsql as $$
declare deadline timestamptz:=clock_timestamp()+interval '5 seconds';
begin
 while not exists(select 1 from pg_stat_activity where application_name=application and wait_event_type='Lock') loop
  if clock_timestamp()>deadline then raise exception 'Expected setup admission lock not reached by %',application; end if;
  perform pg_sleep(0.01);
 end loop;
end;
$$;
select extensions.dblink_connect('setup_writer',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
 'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('setup_deletion',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
 'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('setup_writer','set application_name=''setup_writer''; set statement_timeout=''15s''; set role service_role');
select extensions.dblink_exec('setup_deletion','set application_name=''setup_deletion''; set statement_timeout=''15s''; set role service_role');

-- A service-role writer holds admission through its commit; deletion cannot
-- take effect in the middle of a successfully admitted manual-ready update.
select extensions.dblink_exec('setup_writer','begin');
select extensions.dblink_exec('setup_writer',$$
 update public.repository_onboarding_status set status='ready'
 where github_repository_id='af130000-0000-4000-8000-000000000011'$$);
select extensions.dblink_send_query('setup_deletion',$$
 select public.begin_workspace_deletion('af130000-0000-4000-8000-000000000001',
 'af130000-0000-4000-8000-000000000031','Setup write first')$$);
select pg_temp.wait_setup_admission_lock('setup_deletion');
select ok((select deletion_requested_at is null from public.workspaces where id='af130000-0000-4000-8000-000000000001'),
 'deletion waits for the admitted setup write to commit');
select extensions.dblink_exec('setup_writer','commit');
select ok(requested_at is not null,'deletion proceeds after setup commits')
from extensions.dblink_get_result('setup_deletion') as result(requested_at timestamptz);
select * from extensions.dblink_get_result('setup_deletion') as result(requested_at timestamptz);
select is((select status from public.repository_onboarding_status where github_repository_id='af130000-0000-4000-8000-000000000011'),
 'ready','the accepted setup write precedes the deletion fence');

-- The application saw an active workspace, but deletion owns the row before
-- its later upsert. Service-role RLS bypass must not bypass admission.
select ok((select deletion_requested_at is null from public.workspaces where id='af130000-0000-4000-8000-000000000002'),
 'application initial read observes an active workspace');
select extensions.dblink_exec('setup_deletion','begin');
select * from extensions.dblink('setup_deletion',$$
 select public.begin_workspace_deletion('af130000-0000-4000-8000-000000000002',
 'af130000-0000-4000-8000-000000000032','Setup deletion first')$$) as result(requested_at timestamptz);
select extensions.dblink_send_query('setup_writer',$$
 insert into public.repository_onboarding_status(workspace_id,github_repository_id,status)
 values('af130000-0000-4000-8000-000000000002','af130000-0000-4000-8000-000000000012','conflict')
 on conflict(workspace_id,github_repository_id) do update set status=excluded.status returning status$$);
select pg_temp.wait_setup_admission_lock('setup_writer');
select extensions.dblink_exec('setup_deletion','commit');
select is((select count(*) from extensions.dblink_get_result('setup_writer',false) as result(status text)),0::bigint,
 'late service-role upsert returns no written row');
select ok(extensions.dblink_error_message('setup_writer') like '%Workspace deletion is in progress.%',
 'late upsert sees the committed deletion marker');
select is((select status from public.repository_onboarding_status where github_repository_id='af130000-0000-4000-8000-000000000012'),
 'pr_open','rejected conflict-only upsert preserves the old setup state');
select throws_ok($$update public.repository_onboarding_status set status='ready'
 where github_repository_id='af130000-0000-4000-8000-000000000012'$$,
 'P0010','Workspace deletion is in progress.','manual-ready update cannot write after fencing');
select throws_ok($$insert into public.repository_onboarding_status(workspace_id,github_repository_id,status)
 values('af130000-0000-4000-8000-000000000002','af130000-0000-4000-8000-000000000013','ready')$$,
 'P0010','Workspace deletion is in progress.','already-ready result cannot insert after fencing');
select throws_ok($$select public.apply_github_pull_request_event('af130000-0000-4000-8000-000000000002',
 'af130000-0000-4000-8000-000000000012','wallie/setup-b',82,'https://github.com/admission/b/pull/82',
 'closed',false,'2026-10-11 00:00:02Z')$$,'P0010','Workspace deletion is in progress.',
 'ordinary webhook reconciliation observes the same admission fence');
select throws_ok($$select public.finish_github_pull_request_observation('af130000-0000-4000-8000-000000000002',
 'af130000-0000-4000-8000-000000000012','wallie/setup-b',82,'https://github.com/admission/b/pull/82',
 'closed',false,'2026-10-11 00:00:01Z',(select token from setup_observation))$$,
 'P0010','Workspace deletion is in progress.','an observation admitted before deletion cannot write its late result');

select extensions.dblink_disconnect('setup_writer');
select extensions.dblink_disconnect('setup_deletion');
select ok(public.finish_workspace_deletion('af130000-0000-4000-8000-000000000001'),'normal deletion still cascades setup rows');
select ok(public.finish_workspace_deletion('af130000-0000-4000-8000-000000000002'),'deletion can finish after rejected setup writes');
select throws_ok($$insert into public.repository_onboarding_status(workspace_id,github_repository_id,status)
 values('af130000-0000-4000-8000-000000000002','af130000-0000-4000-8000-000000000013','ready')$$,
 '23503','Workspace not found.','a fully removed workspace returns the specific admission error');
select * from finish();
commit;
