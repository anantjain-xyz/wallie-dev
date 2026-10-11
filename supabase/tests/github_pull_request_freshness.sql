begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
grant usage on schema extensions to anon, authenticated, service_role;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

insert into public.workspaces(id,slug,name) values
 ('af100000-0000-4000-8000-000000000001','github-freshness','GitHub freshness');
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions) values
 ('af100000-0000-4000-8000-000000000010','af100000-0000-4000-8000-000000000001',981001,'https://github.com/installations/981001',9810,'Organization','Freshness','{}');
insert into public.github_repositories(id,workspace_id,github_installation_id,repo_id,name,full_name,private,html_url) values
 ('af100000-0000-4000-8000-000000000011','af100000-0000-4000-8000-000000000001','af100000-0000-4000-8000-000000000010',981011,'a','freshness/a',true,'https://github.com/freshness/a'),
 ('af100000-0000-4000-8000-000000000012','af100000-0000-4000-8000-000000000001','af100000-0000-4000-8000-000000000010',981012,'b','freshness/b',true,'https://github.com/freshness/b');
insert into public.pipelines(id,workspace_id,name,is_default) values
 ('af100000-0000-4000-8000-000000000020','af100000-0000-4000-8000-000000000001','Default',true);
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name) values
 ('af100000-0000-4000-8000-000000000021','af100000-0000-4000-8000-000000000020','af100000-0000-4000-8000-000000000001',1,'plan','Plan');
insert into public.sessions(id,workspace_id,number,title,pipeline_id,current_stage_id,github_repository_id) values
 ('af100000-0000-4000-8000-000000000031','af100000-0000-4000-8000-000000000001',1,'Session A','af100000-0000-4000-8000-000000000020','af100000-0000-4000-8000-000000000021','af100000-0000-4000-8000-000000000011'),
 ('af100000-0000-4000-8000-000000000032','af100000-0000-4000-8000-000000000001',2,'Session B','af100000-0000-4000-8000-000000000020','af100000-0000-4000-8000-000000000021','af100000-0000-4000-8000-000000000012');

create function pg_temp.deliver(number integer, state text, source_time timestamptz,
 repository uuid default 'af100000-0000-4000-8000-000000000011', branch text default 'wallie/build-shared', draft boolean default false)
returns boolean language sql as $$
 select public.apply_github_pull_request_event('af100000-0000-4000-8000-000000000001',repository,branch,number,
  'https://github.com/freshness/pr/'||number,state,draft,source_time);
$$;
create function pg_temp.record(number integer, state text, source_time timestamptz,
 repository uuid default 'af100000-0000-4000-8000-000000000011', session uuid default 'af100000-0000-4000-8000-000000000031')
returns public.session_pull_requests language sql as $$
 select public.record_session_pull_request(session,'af100000-0000-4000-8000-000000000001',repository,'wallie/build-shared',number,
  'https://github.com/freshness/pr/'||number,state,false,source_time);
$$;

set local role service_role;
select is((pg_temp.record(42,'open','2026-10-10 00:00:02Z')).pull_request_state,'open','worker creates the exact repository PR link');
select ok(pg_temp.deliver(42,'closed','2026-10-10 00:00:03Z'),'newer close delivery applies');
select ok(not pg_temp.deliver(42,'open','2026-10-10 00:00:01Z'),'older distinct open delivery is ignored');
select is((select pull_request_state from public.session_pull_requests where branch_name='wallie/build-shared'),'closed','arrival order cannot regress closed to open');
select ok(pg_temp.deliver(42,'open','2026-10-10 00:00:04Z'),'newer legitimate reopen applies');
select ok(pg_temp.deliver(42,'open','2026-10-10 00:00:05Z',draft=>true),'newer draft conversion applies');
select ok(not pg_temp.deliver(42,'open','2026-10-10 00:00:04Z'),'stale ready-for-review delivery is ignored');
select is((select is_draft from public.session_pull_requests where branch_name='wallie/build-shared'),true,'stale events cannot regress draft state');
select ok(pg_temp.deliver(42,'merged','2026-10-10 00:00:05Z'),'merged wins the equal-second timestamp tie');
select ok(not pg_temp.deliver(42,'open','2026-10-10 00:00:06Z'),'merged is terminal for this exact PR even with a newer open snapshot');
select is((pg_temp.record(42,'open','2026-10-10 00:00:04Z')).pull_request_state,'merged','stale worker read returns the canonical merged row');
select ok(not pg_temp.deliver(42,'open','2026-10-10 00:00:07Z','af100000-0000-4000-8000-000000000012'),'another repository with the same branch and number cannot claim the link');
select is((select github_repository_id from public.session_pull_requests where branch_name='wallie/build-shared'),'af100000-0000-4000-8000-000000000011'::uuid,'repository identity is preserved');
select ok(not pg_temp.deliver(42,'open','2026-10-10 00:00:07Z','af100000-0000-4000-8000-000000000099'),'unknown repositories cannot claim branch links');
select ok(not pg_temp.deliver(43,'open','2026-10-10 00:00:07Z'),'webhooks cannot replace a known PR number using branch fallback');
select is((pg_temp.record(43,'open','2026-10-10 00:00:01Z')).github_updated_at,'2026-10-10 00:00:01Z'::timestamptz,'replacement identity starts with its own source watermark');
select ok(not pg_temp.deliver(42,'merged','2026-10-10 00:00:09Z'),'old PR delivery cannot overwrite its replacement');
select is((pg_temp.record(42,'merged','2026-10-10 00:00:09Z')).pull_request_number,43,'old worker retry cannot overwrite a newer PR identity');
select throws_ok($$select pg_temp.record(44,'open','2026-10-10 00:00:10Z','af100000-0000-4000-8000-000000000012')$$,
 '23514','Pull request repository must match its session','writer validates session repository scope');
select throws_ok($$select pg_temp.record(44,'open','2026-10-10 00:00:10Z','af100000-0000-4000-8000-000000000012','af100000-0000-4000-8000-000000000032')$$,
 '23514','Pull request branch belongs to another session or repository','writer refuses a second repository and session with the same branch');
select throws_ok($$select pg_temp.record(44,'open',null)$$,'22023','Invalid GitHub pull request snapshot','missing provider time is rejected at the durable boundary');

-- Older sessions use the workspace-selected repository rather than an explicit pin.
update public.sessions set github_repository_id=null where id='af100000-0000-4000-8000-000000000031';
select is((public.record_session_pull_request('af100000-0000-4000-8000-000000000031','af100000-0000-4000-8000-000000000001',
 'af100000-0000-4000-8000-000000000011','wallie/fallback',51,'https://github.com/freshness/a/pull/51','open',false,'2026-10-10 00:00:01Z')).pull_request_number,
 51,'service writer can record the resolved workspace repository for an unpinned session');
update public.sessions set github_repository_id='af100000-0000-4000-8000-000000000011' where id='af100000-0000-4000-8000-000000000031';

-- Legacy links require positive repository evidence from their owning session.
insert into public.session_pull_requests(session_id,workspace_id,branch_name) values
 ('af100000-0000-4000-8000-000000000031','af100000-0000-4000-8000-000000000001','wallie/legacy');
select ok(not pg_temp.deliver(71,'open','2026-10-10 00:00:01Z','af100000-0000-4000-8000-000000000012','wallie/legacy'),'legacy null repository link cannot be claimed by the wrong session repository');
select ok(pg_temp.deliver(71,'open','2026-10-10 00:00:01Z',branch=>'wallie/legacy'),'legacy link resolves using its session repository');
select ok(not pg_temp.deliver(72,'open','2026-10-10 00:00:02Z',branch=>'wallie/legacy'),'once resolved a legacy link cannot be rebound by branch alone');

insert into public.session_pull_requests(session_id,workspace_id,branch_name,pull_request_number,pull_request_state,github_updated_at) values
 ('af100000-0000-4000-8000-000000000031','af100000-0000-4000-8000-000000000001','wallie/unknown-origin',99,'merged','2026-10-10 00:00:10Z');
select ok(not pg_temp.deliver(99,'open','2026-10-10 00:00:20Z',branch=>'wallie/unknown-origin'),'known PR without repository evidence cannot be rebound by a webhook after repository deletion');
select is((public.record_session_pull_request('af100000-0000-4000-8000-000000000031','af100000-0000-4000-8000-000000000001',
 'af100000-0000-4000-8000-000000000011','wallie/unknown-origin',51,'https://github.com/freshness/a/pull/51','open',false,'2026-10-10 00:00:01Z')).pull_request_number,
 51,'trusted worker resolving the exact repository branch replaces an unknown-origin identity with its own watermark');

insert into public.repository_onboarding_status(workspace_id,github_repository_id,status,setup_branch_name,setup_pr_number,setup_pr_url,conflict_report) values
 ('af100000-0000-4000-8000-000000000001','af100000-0000-4000-8000-000000000011','pr_open','wallie/setup-a',81,'https://github.com/freshness/a/pull/81','[]');
select ok(pg_temp.deliver(81,'merged','2026-10-10 00:00:05Z',branch=>'wallie/setup-a'),'setup merge applies');
select ok(pg_temp.deliver(81,'open','2026-10-10 00:00:02Z',branch=>'wallie/setup-a'),'stale setup event is acknowledged without falling through to session links');
select is((select status from public.repository_onboarding_status where github_repository_id='af100000-0000-4000-8000-000000000011'),'ready','older open cannot regress ready onboarding');
update public.repository_onboarding_status set setup_pr_number=82,status='conflict',conflict_report='[{"path":"conflict.md"}]'
 where github_repository_id='af100000-0000-4000-8000-000000000011';
select ok((select setup_pr_updated_at is null and setup_pr_state is null from public.repository_onboarding_status where github_repository_id='af100000-0000-4000-8000-000000000011'),'replacement setup identity clears previous watermark and state');
select ok(not pg_temp.deliver(81,'closed','2026-10-10 00:00:10Z',branch=>'wallie/setup-a'),'prior setup PR cannot claim replacement setup identity');
select ok(pg_temp.deliver(82,'merged','2026-10-10 00:00:01Z',branch=>'wallie/setup-a'),'replacement setup PR accepts its own provider time');
select is((select status from public.repository_onboarding_status where github_repository_id='af100000-0000-4000-8000-000000000011'),'conflict','merge retains unresolved setup file conflicts');
select ok(pg_temp.deliver(82,'closed','2026-10-10 00:00:02Z',branch=>'wallie/setup-a'),'merged conflicted setup also absorbs later impossible close events');
select is((select status from public.repository_onboarding_status where github_repository_id='af100000-0000-4000-8000-000000000011'),'conflict','merged conflicted setup does not regress to error');

update public.repository_onboarding_status set conflict_report='[]',setup_pr_number=83,status='conflict'
 where github_repository_id='af100000-0000-4000-8000-000000000011';
select ok(pg_temp.deliver(83,'merged','2026-10-10 00:00:01Z',branch=>'wallie/setup-a'),'setup merge applies with a status-only conflict');
select is((select status from public.repository_onboarding_status where github_repository_id='af100000-0000-4000-8000-000000000011'),'conflict','status-only conflicts are preserved as before');
update public.repository_onboarding_status set status='ready',setup_pr_state='merged',setup_pr_updated_at=null
 where github_repository_id='af100000-0000-4000-8000-000000000011';
select ok(pg_temp.deliver(83,'open','2026-10-10 00:00:01Z',branch=>'wallie/setup-a'),'ready setup backfill without a timestamp acknowledges stale delivery');
select is((select status from public.repository_onboarding_status where github_repository_id='af100000-0000-4000-8000-000000000011'),'ready','pre-watermark merged setup state remains ready');

reset role;
select ok(not has_function_privilege('anon','public.apply_github_pull_request_event(uuid,uuid,text,integer,text,text,boolean,timestamptz)','execute'),'anonymous callers cannot reconcile webhooks');
select ok(not has_function_privilege('authenticated','public.apply_github_pull_request_event(uuid,uuid,text,integer,text,text,boolean,timestamptz)','execute'),'authenticated callers cannot spoof webhooks');
select ok(not has_function_privilege('authenticated','public.record_session_pull_request(uuid,uuid,uuid,text,integer,text,text,boolean,timestamptz)','execute'),'authenticated callers cannot write worker PR metadata');
select ok(not has_function_privilege('anon','public.record_session_pull_request(uuid,uuid,uuid,text,integer,text,text,boolean,timestamptz)','execute'),'anonymous callers cannot write worker PR metadata');
select * from finish();
rollback;
