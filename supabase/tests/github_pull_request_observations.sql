begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
grant usage on schema extensions to anon, authenticated, service_role;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

insert into public.workspaces(id,slug,name) values
 ('af120000-0000-4000-8000-000000000001','github-observation','GitHub freshness');
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions) values
 ('af120000-0000-4000-8000-000000000010','af120000-0000-4000-8000-000000000001',981001,'https://github.com/installations/981001',9810,'Organization','Freshness','{}');
insert into public.github_repositories(id,workspace_id,github_installation_id,repo_id,name,full_name,private,html_url) values
 ('af120000-0000-4000-8000-000000000011','af120000-0000-4000-8000-000000000001','af120000-0000-4000-8000-000000000010',981011,'a','freshness/a',true,'https://github.com/freshness/a'),
 ('af120000-0000-4000-8000-000000000012','af120000-0000-4000-8000-000000000001','af120000-0000-4000-8000-000000000010',981012,'b','freshness/b',true,'https://github.com/freshness/b');
insert into public.pipelines(id,workspace_id,name,is_default) values
 ('af120000-0000-4000-8000-000000000020','af120000-0000-4000-8000-000000000001','Default',true);
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name) values
 ('af120000-0000-4000-8000-000000000021','af120000-0000-4000-8000-000000000020','af120000-0000-4000-8000-000000000001',1,'plan','Plan');
insert into public.sessions(id,workspace_id,number,title,pipeline_id,current_stage_id,github_repository_id) values
 ('af120000-0000-4000-8000-000000000031','af120000-0000-4000-8000-000000000001',1,'Session A','af120000-0000-4000-8000-000000000020','af120000-0000-4000-8000-000000000021','af120000-0000-4000-8000-000000000011'),
 ('af120000-0000-4000-8000-000000000032','af120000-0000-4000-8000-000000000001',2,'Session B','af120000-0000-4000-8000-000000000020','af120000-0000-4000-8000-000000000021','af120000-0000-4000-8000-000000000012');

create temporary table observation_tokens(name text primary key, token uuid);
create function pg_temp.observe(state text, draft boolean default false, number integer default 42,
 branch text default 'wallie/build-tie', source_time timestamptz default '2026-10-10 00:00:01Z')
returns uuid language sql as $$
 select public.begin_github_pull_request_observation('af120000-0000-4000-8000-000000000001',
 'af120000-0000-4000-8000-000000000011',branch,number,state,draft,source_time);
$$;
create function pg_temp.complete(token uuid, state text, draft boolean default false, number integer default 42,
 branch text default 'wallie/build-tie', source_time timestamptz default '2026-10-10 00:00:01Z')
returns boolean language sql as $$
 select public.finish_github_pull_request_observation('af120000-0000-4000-8000-000000000001',
 'af120000-0000-4000-8000-000000000011',branch,number,'https://github.com/freshness/a/pull/'||number,
 state,draft,source_time,token);
$$;
create function pg_temp.deliver(state text, draft boolean default false,
 source_time timestamptz default '2026-10-10 00:00:01Z')
returns boolean language sql as $$
 select public.apply_github_pull_request_event('af120000-0000-4000-8000-000000000001',
 'af120000-0000-4000-8000-000000000011','wallie/build-tie',42,'https://github.com/freshness/a/pull/42',state,draft,source_time);
$$;

select public.record_session_pull_request('af120000-0000-4000-8000-000000000031',
 'af120000-0000-4000-8000-000000000001','af120000-0000-4000-8000-000000000011',
 'wallie/build-tie',42,'https://github.com/freshness/a/pull/42','closed',false,'2026-10-10 00:00:01Z');
select ok(not pg_temp.deliver('open'),'equal-time reopen cannot order itself by delivery arrival');
insert into observation_tokens values ('reopen',pg_temp.observe('open'));
select ok((select token is not null from observation_tokens where name='reopen'),'conflicting reopen admits an authoritative read');
select ok(pg_temp.complete((select token from observation_tokens where name='reopen'),'open'),'authoritative same-second reopen applies');
select is((select pull_request_state from public.session_pull_requests where branch_name='wallie/build-tie'),'open','closed PR is reopened');
select ok(not pg_temp.complete((select token from observation_tokens where name='reopen'),'closed'),'observation token cannot be replayed');
select is((public.record_session_pull_request('af120000-0000-4000-8000-000000000031',
 'af120000-0000-4000-8000-000000000001','af120000-0000-4000-8000-000000000011',
 'wallie/build-tie',42,'https://github.com/freshness/a/pull/42','closed',false,'2026-10-10 00:00:01Z')).pull_request_state,
 'open','ordinary cached worker snapshot has no equal-time authority');
select is(pg_temp.observe('open'),null::uuid,'identical state without an active observation needs no GitHub read');
select is(pg_temp.observe('closed',source_time=>'2026-10-10 00:00:00Z'),null::uuid,'older provider snapshot needs no authoritative read');
select is(pg_temp.observe('closed',number=>999),null::uuid,'different PR number cannot reserve an observation');
select is(public.begin_github_pull_request_observation('af120000-0000-4000-8000-000000000001',
 'af120000-0000-4000-8000-000000000012','wallie/build-tie',42,'closed',false,'2026-10-10 00:00:01Z'),null::uuid,'same branch in another repository cannot reserve authority');

select ok(pg_temp.deliver('open',true,'2026-10-10 00:00:02Z'),'newer draft conversion applies normally');
insert into observation_tokens values ('ready',pg_temp.observe('open',false,source_time=>'2026-10-10 00:00:02Z'));
select ok((select token is not null from observation_tokens where name='ready'),'draft-only tie admits a read');
select ok(pg_temp.complete((select token from observation_tokens where name='ready'),'open',false,source_time=>'2026-10-10 00:00:02Z'),'authoritative same-second ready transition applies');
select is((select is_draft from public.session_pull_requests where branch_name='wallie/build-tie'),false,'PR is ready for review');

insert into observation_tokens values ('old',pg_temp.observe('closed',source_time=>'2026-10-10 00:00:02Z'));
insert into observation_tokens values ('new',pg_temp.observe('open',source_time=>'2026-10-10 00:00:02Z'));
select ok((select token is not null from observation_tokens where name='new'),'matching arrival also supersedes a pending contradictory read');
select ok(not pg_temp.complete((select token from observation_tokens where name='old'),'closed',source_time=>'2026-10-10 00:00:02Z'),'delayed older read cannot finish after newer begin');
select ok(pg_temp.complete((select token from observation_tokens where name='new'),'open',source_time=>'2026-10-10 00:00:02Z'),'latest observation wins without regressing current state');

insert into observation_tokens values ('before_update',pg_temp.observe('closed',source_time=>'2026-10-10 00:00:02Z'));
select ok(pg_temp.deliver('closed',false,'2026-10-10 00:00:03Z'),'new provider timestamp advances state during read');
select ok(not pg_temp.complete((select token from observation_tokens where name='before_update'),'open',source_time=>'2026-10-10 00:00:03Z'),'accepted ordinary state invalidates in-flight authority');
insert into observation_tokens values ('behind',pg_temp.observe('open',source_time=>'2026-10-10 00:00:03Z'));
select ok(not pg_temp.complete((select token from observation_tokens where name='behind'),'open',source_time=>'2026-10-10 00:00:02Z'),'authority cannot accept an older provider timestamp');
select ok(pg_temp.deliver('merged',false,'2026-10-10 00:00:03Z'),'merge dominates a provider timestamp tie');
select is(pg_temp.observe('open',source_time=>'2026-10-10 00:00:03Z'),null::uuid,'merged state never admits a reopen');
select ok(not pg_temp.complete((select token from observation_tokens where name='behind'),'open',source_time=>'2026-10-10 00:00:04Z'),'pre-merge observation cannot undo terminal merge');

insert into public.repository_onboarding_status(workspace_id,github_repository_id,status,setup_branch_name,setup_pr_number,setup_pr_state,setup_pr_updated_at,conflict_report) values
 ('af120000-0000-4000-8000-000000000001','af120000-0000-4000-8000-000000000011','error','wallie/setup-tie',81,'closed','2026-10-10 00:00:01Z','[]');
insert into observation_tokens values ('setup',pg_temp.observe('open',number=>81,branch=>'wallie/setup-tie'));
select ok(pg_temp.complete((select token from observation_tokens where name='setup'),'open',number=>81,branch=>'wallie/setup-tie'),'setup closed/reopened tie reconciles');
select is((select status from public.repository_onboarding_status where setup_pr_number=81),'pr_open','setup is usable again after reopening');
insert into observation_tokens values ('setup_changed',pg_temp.observe('closed',number=>81,branch=>'wallie/setup-tie'));
update public.repository_onboarding_status set conflict_report='[{"path":"user-change.md"}]',status='conflict' where setup_pr_number=81;
select ok(not pg_temp.complete((select token from observation_tokens where name='setup_changed'),'closed',number=>81,branch=>'wallie/setup-tie'),'local setup writes invalidate earlier reads');
insert into observation_tokens values ('setup_identity',pg_temp.observe('closed',number=>81,branch=>'wallie/setup-tie'));
update public.repository_onboarding_status set setup_pr_number=82 where setup_pr_number=81;
select is((select setup_pr_observation_token from public.repository_onboarding_status where setup_pr_number=82),null::uuid,'replacement setup identity clears observation authority');
select ok(not pg_temp.complete((select token from observation_tokens where name='setup_identity'),'closed',number=>81,branch=>'wallie/setup-tie'),'old setup identity cannot finish after replacement');

select ok(not has_function_privilege('anon','public.begin_github_pull_request_observation(uuid,uuid,text,integer,text,boolean,timestamptz)','execute'),'anonymous caller cannot reserve authority');
select ok(not has_function_privilege('authenticated','public.begin_github_pull_request_observation(uuid,uuid,text,integer,text,boolean,timestamptz)','execute'),'authenticated caller cannot reserve authority');
select ok(not has_function_privilege('anon','public.finish_github_pull_request_observation(uuid,uuid,text,integer,text,text,boolean,timestamptz,uuid)','execute'),'anonymous caller cannot finish authority');
select ok(not has_function_privilege('authenticated','public.finish_github_pull_request_observation(uuid,uuid,text,integer,text,text,boolean,timestamptz,uuid)','execute'),'authenticated caller cannot finish authority');

-- Commit the namespaced fixture so two independent transactions can contend.
select public.record_session_pull_request('af120000-0000-4000-8000-000000000031',
 'af120000-0000-4000-8000-000000000001','af120000-0000-4000-8000-000000000011',
 'wallie/build-tie',43,'https://github.com/freshness/a/pull/43','open',false,'2026-10-10 00:00:01Z');
insert into observation_tokens values ('race_old',pg_temp.observe('closed',number=>43));
commit;
begin;
create extension if not exists dblink with schema extensions;
create function pg_temp.wait_observation_lock(application text) returns void language plpgsql as $$
declare deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
 while not exists(select 1 from pg_stat_activity where application_name=application and wait_event_type='Lock') loop
  if clock_timestamp()>deadline then raise exception 'Expected observation lock not reached by %',application; end if;
  perform pg_sleep(0.01);
 end loop;
end;
$$;
select extensions.dblink_connect('observation_newer',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
 'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('observation_older',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
 'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('observation_newer','set application_name=''observation_newer''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');
select extensions.dblink_exec('observation_older','set application_name=''observation_older''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');
select extensions.dblink_exec('observation_newer','begin');
insert into observation_tokens select 'race_new',token from extensions.dblink('observation_newer',$$
 select public.begin_github_pull_request_observation('af120000-0000-4000-8000-000000000001',
 'af120000-0000-4000-8000-000000000011','wallie/build-tie',43,'closed',false,'2026-10-10 00:00:01Z')$$) as result(token uuid);
select extensions.dblink_send_query('observation_older',format($$
 select public.finish_github_pull_request_observation('af120000-0000-4000-8000-000000000001',
 'af120000-0000-4000-8000-000000000011','wallie/build-tie',43,'https://github.com/freshness/a/pull/43',
 'closed',false,'2026-10-10 00:00:01Z',%L::uuid)$$,(select token from observation_tokens where name='race_old')));
select pg_temp.wait_observation_lock('observation_older');
select extensions.dblink_exec('observation_newer','commit');
select ok(not applied,'blocked older finish rechecks the newer committed observation token') from extensions.dblink_get_result('observation_older') as result(applied boolean);
select * from extensions.dblink_get_result('observation_older') as result(applied boolean);
set local request.jwt.claim.role='service_role';
select ok(pg_temp.complete((select token from observation_tokens where name='race_new'),'closed',number=>43),'newest observation can finish after the race');
select is((select pull_request_state from public.session_pull_requests where branch_name='wallie/build-tie'),'closed','canonical state reflects newest observation');
select extensions.dblink_disconnect('observation_newer');
select extensions.dblink_disconnect('observation_older');
select * from finish();
delete from public.workspaces where id='af120000-0000-4000-8000-000000000001';
commit;
