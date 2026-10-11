begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set local search_path = public, extensions;
grant usage on schema extensions to anon, authenticated, service_role;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

insert into public.workspaces(id,slug,name) values
 ('af110000-0000-4000-8000-000000000001','github-freshness-race','GitHub freshness');
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions) values
 ('af110000-0000-4000-8000-000000000010','af110000-0000-4000-8000-000000000001',981001,'https://github.com/installations/981001',9810,'Organization','Freshness','{}');
insert into public.github_repositories(id,workspace_id,github_installation_id,repo_id,name,full_name,private,html_url) values
 ('af110000-0000-4000-8000-000000000011','af110000-0000-4000-8000-000000000001','af110000-0000-4000-8000-000000000010',981011,'a','freshness/a',true,'https://github.com/freshness/a'),
 ('af110000-0000-4000-8000-000000000012','af110000-0000-4000-8000-000000000001','af110000-0000-4000-8000-000000000010',981012,'b','freshness/b',true,'https://github.com/freshness/b');
insert into public.pipelines(id,workspace_id,name,is_default) values
 ('af110000-0000-4000-8000-000000000020','af110000-0000-4000-8000-000000000001','Default',true);
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name) values
 ('af110000-0000-4000-8000-000000000021','af110000-0000-4000-8000-000000000020','af110000-0000-4000-8000-000000000001',1,'plan','Plan');
insert into public.sessions(id,workspace_id,number,title,pipeline_id,current_stage_id,github_repository_id) values
 ('af110000-0000-4000-8000-000000000031','af110000-0000-4000-8000-000000000001',1,'Session A','af110000-0000-4000-8000-000000000020','af110000-0000-4000-8000-000000000021','af110000-0000-4000-8000-000000000011'),
 ('af110000-0000-4000-8000-000000000032','af110000-0000-4000-8000-000000000001',2,'Session B','af110000-0000-4000-8000-000000000020','af110000-0000-4000-8000-000000000021','af110000-0000-4000-8000-000000000012');

-- Commit only this test namespace so independent transactions can contend.
select public.record_session_pull_request('af110000-0000-4000-8000-000000000031','af110000-0000-4000-8000-000000000001',
 'af110000-0000-4000-8000-000000000011','wallie/build-race',42,'https://github.com/freshness/a/pull/42','open',false,'2026-10-10 00:00:01Z');
insert into public.repository_onboarding_status(workspace_id,github_repository_id,status,setup_branch_name,setup_pr_number,conflict_report) values
 ('af110000-0000-4000-8000-000000000001','af110000-0000-4000-8000-000000000011','pr_open','wallie/setup-race',81,'[]');
commit;
begin;

create function pg_temp.wait_github_lock(application text) returns void language plpgsql as $$
declare deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
 while not exists(select 1 from pg_stat_activity where application_name=application and wait_event_type='Lock') loop
  if clock_timestamp()>deadline then raise exception 'Expected GitHub lock not reached by %', application; end if;
  perform pg_sleep(0.01);
 end loop;
end;
$$;
select extensions.dblink_connect('github_newer',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
 'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('github_older',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
 'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('github_newer','set application_name=''github_newer''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');
select extensions.dblink_exec('github_older','set application_name=''github_older''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');

-- Newer delivery holds the row; the earlier snapshot begins before it commits.
select extensions.dblink_exec('github_newer','begin');
select ok(applied,'newer delivery applies while retaining its lock') from extensions.dblink('github_newer',$$
 select public.apply_github_pull_request_event('af110000-0000-4000-8000-000000000001','af110000-0000-4000-8000-000000000011',
 'wallie/build-race',42,'https://github.com/freshness/a/pull/42','closed',false,'2026-10-10 00:00:03Z')$$) as result(applied boolean);
select extensions.dblink_send_query('github_older',$$
 select public.apply_github_pull_request_event('af110000-0000-4000-8000-000000000001','af110000-0000-4000-8000-000000000011',
 'wallie/build-race',42,'https://github.com/freshness/a/pull/42','open',false,'2026-10-10 00:00:02Z')$$);
select pg_temp.wait_github_lock('github_older');
select extensions.dblink_exec('github_newer','commit');
select ok(not applied,'blocked old delivery rechecks the committed provider watermark') from extensions.dblink_get_result('github_older') as result(applied boolean);
select * from extensions.dblink_get_result('github_older') as result(applied boolean);
select is((select pull_request_state from public.session_pull_requests where branch_name='wallie/build-race'),'closed','concurrent arrival cannot regress accepted state');

-- Worker snapshot is also stale when a newer merge is still in flight.
select extensions.dblink_exec('github_newer','begin');
select ok(applied,'merge applies while retaining its lock') from extensions.dblink('github_newer',$$
 select public.apply_github_pull_request_event('af110000-0000-4000-8000-000000000001','af110000-0000-4000-8000-000000000011',
 'wallie/build-race',42,'https://github.com/freshness/a/pull/42','merged',false,'2026-10-10 00:00:05Z')$$) as result(applied boolean);
select extensions.dblink_send_query('github_older',$$
 select (public.record_session_pull_request('af110000-0000-4000-8000-000000000031','af110000-0000-4000-8000-000000000001',
 'af110000-0000-4000-8000-000000000011','wallie/build-race',42,'https://github.com/freshness/a/pull/42','open',false,'2026-10-10 00:00:04Z')).pull_request_state$$);
select pg_temp.wait_github_lock('github_older');
select extensions.dblink_exec('github_newer','commit');
select is(state,'merged','blocked worker retry returns the canonical merged row') from extensions.dblink_get_result('github_older') as result(state text);
select * from extensions.dblink_get_result('github_older') as result(state text);

-- Setup state derives conflicts from the locked row, not an earlier application read.
select extensions.dblink_exec('github_newer','begin');
select extensions.dblink_exec('github_newer',$$update public.repository_onboarding_status set conflict_report='[{"path":"changed.md"}]'
 where github_repository_id='af110000-0000-4000-8000-000000000011'$$);
select extensions.dblink_send_query('github_older',$$
 select public.apply_github_pull_request_event('af110000-0000-4000-8000-000000000001','af110000-0000-4000-8000-000000000011',
 'wallie/setup-race',81,'https://github.com/freshness/a/pull/81','merged',false,'2026-10-10 00:00:05Z')$$);
select pg_temp.wait_github_lock('github_older');
select extensions.dblink_exec('github_newer','commit');
select ok(applied,'setup merge waits for concurrent conflict changes') from extensions.dblink_get_result('github_older') as result(applied boolean);
select * from extensions.dblink_get_result('github_older') as result(applied boolean);
select is((select status from public.repository_onboarding_status where github_repository_id='af110000-0000-4000-8000-000000000011'),'conflict','merge preserves conflicts committed while waiting');
select extensions.dblink_disconnect('github_newer');
select extensions.dblink_disconnect('github_older');
select * from finish();
-- Fixture cleanup also removes the namespaced repositories, links, and sessions.
delete from public.workspaces where id='af110000-0000-4000-8000-000000000001';
commit;
