begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.browser_id(category integer, slot integer default 1) returns uuid
language sql immutable as $$
  select ('58400000-' || lpad(category::text, 4, '0') || '-4000-8000-' || lpad(slot::text, 12, '0'))::uuid;
$$;

select public.set_git_continuity_release(true, revision, 'Private screenshot database fixture')
from public.get_git_continuity_release_state() where not enabled;
insert into auth.users(id,email) values
  (pg_temp.browser_id(0), 'browser-screenshot-owner@example.test'),
  (pg_temp.browser_id(0,2), 'browser-screenshot-outsider@example.test');
insert into public.workspaces(id,slug,name) values
  (pg_temp.browser_id(1), 'private-screenshot-fixture', 'Private screenshot fixture'),
  (pg_temp.browser_id(1,2), 'private-screenshot-foreign', 'Unrelated screenshot workspace');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  (pg_temp.browser_id(2), pg_temp.browser_id(1), pg_temp.browser_id(0), 'human','owner'),
  (pg_temp.browser_id(2,2), pg_temp.browser_id(1,2), pg_temp.browser_id(0,2), 'human','owner');
create temp table browser_factory as
select workspace_id,id from public.factories where workspace_id=pg_temp.browser_id(1) and is_default;
insert into public.pipelines(id,workspace_id,factory_id,name,is_default)
select pg_temp.browser_id(3),workspace_id,id,'Visual checks',true from browser_factory;
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name)
values (pg_temp.browser_id(4),pg_temp.browser_id(3),pg_temp.browser_id(1),1,'visual-build','Build');
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions)
values (pg_temp.browser_id(5),pg_temp.browser_id(1),58400001,'https://github.test/installations/58400001',
  58400,'Organization','fixture','{"contents":"write"}');
insert into public.github_repositories(id,workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch)
select pg_temp.browser_id(6),workspace_id,id,pg_temp.browser_id(5),58400001,'writer','fixture/writer',true,
  'https://github.test/fixture/writer','main' from browser_factory;
select public.save_execution_policy(pg_temp.browser_id(1),pg_temp.browser_id(0),0,
  '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":30000,"maxTotalTokens":1000,"maxCostUsd":1}');
create temp table browser_prompt as
select prompt.* from browser_factory factory cross join lateral public.create_factory_agent(factory.workspace_id,factory.id,
  pg_temp.browser_id(0),'Browser builder','browser-builder','Synthetic build prompt') prompt;
create temp table browser_tool as
select tool.* from browser_factory factory cross join lateral public.create_factory_mcp_server(factory.workspace_id,factory.id,
  pg_temp.browser_id(0),'Trusted browser fixture','browser-fixture','https://browser.example.test/mcp',
  array['capture'],'none') tool;
create temp table browser_grant as
select approved.* from browser_factory factory join public.execution_policies policy using(workspace_id)
cross join browser_tool tool
cross join lateral public.create_service_principal(factory.workspace_id,factory.id,pg_temp.browser_id(0),
  'Browser fixture service','browser-fixture-service') principal
cross join lateral public.approve_factory_execution_grant(factory.workspace_id,factory.id,pg_temp.browser_id(0),principal.id,
  pg_temp.browser_id(6),'{}'::uuid[],array[tool.id::text || '/capture'],policy.current_revision_id,
  pg_temp.browser_id(2),clock_timestamp()+interval '1 hour',0) approved;
create temp table browser_definition as
select jsonb_build_object(
  'schemaVersion',1,'kind','serial','pipelineId',pg_temp.browser_id(3),'repositoryId',approved.github_repository_id,
  'executionPolicyRevisionId',approved.execution_policy_revision_id,
  'executionGrant',jsonb_build_object('id',approved.id,'version',approved.version),
  'agent',jsonb_build_object('provider','codex','model','gpt-5.5'),'sandboxProvider','e2b',
  'implementationAgent',jsonb_build_object('agentId',prompt.agent_id,'promptRevisionId',prompt.id,
    'promptMd',prompt.prompt_md,'promptSha256',prompt.prompt_sha256),
  'toolIds',to_jsonb(approved.tool_ids),
  'mcpManifest',jsonb_build_object('agentId',prompt.agent_id,'servers',jsonb_build_array(jsonb_build_object(
    'toolRevisionId',tool.id,'serverId',tool.server_id,'serverSlug','browser-fixture','revisionNumber',tool.revision_number,
    'endpoint',tool.endpoint,'operations',tool.operation_names,'auth',jsonb_build_object('kind','none')))),
  'stages',jsonb_build_array(jsonb_build_object('id',pg_temp.browser_id(4),'slug','visual-build','name','Build'))
) as value from browser_grant approved cross join browser_tool tool cross join browser_prompt prompt;
with revision as (
  insert into public.factory_definition_revisions(workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
  select factory.workspace_id,factory.id,1,definition.value::text,encode(sha256(convert_to(definition.value::text,'UTF8')),'hex'),
    pg_temp.browser_id(0) from browser_factory factory cross join browser_definition definition
  returning id,workspace_id,factory_id,created_by
)
insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,id,1,created_by from revision;

create function pg_temp.capture_plan() returns jsonb language sql immutable as $$
  select '{"version":2,"commands":[{"key":"tests","command":"pnpm test","timeoutSeconds":60,"reports":[]}],"browser":[
    {"key":"open","path":"/fixtures/open","timeoutSeconds":5,"interactions":[],"regionTestId":"main",
      "excludedTestIds":["private"],"evidence":[{"kind":"screenshot","required":true}]},
    {"key":"review","path":"/fixtures/review","timeoutSeconds":5,"interactions":[],"regionTestId":"main",
      "excludedTestIds":[],"evidence":[{"kind":"screenshot","required":true}]}]}'::jsonb;
$$;
create function pg_temp.browser_run(p_label text)
returns table(session_id uuid,job_id uuid,run_id uuid) language plpgsql as $$
declare queued record; owner public.sessions; active_run uuid;
begin
  select * into strict queued from public.create_session_with_first_job(pg_temp.browser_id(1),pg_temp.browser_id(2),
    p_label,'Private capture fixture','codex','gpt-5.5',session_github_repository_id => pg_temp.browser_id(6));
  select * into strict owner from public.sessions current_session where current_session.id=queued.session_id;
  update public.agent_jobs job set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()),
    status='running',attempt_count=1 where job.id=queued.job_id;
  active_run:=public.start_session_job_attempt(queued.job_id,1,owner.current_stage_id,owner.current_artifact_version,
    'codex','gpt-5.5','project','wallie/screenshot-' || queued.job_id::text);
  perform public.pin_session_job_git_input(queued.job_id,1,active_run,pg_temp.browser_id(6),'main',repeat('a',40));
  perform public.pin_session_validation_plan(active_run,repeat('b',40),repeat('c',40),pg_temp.capture_plan());
  return query select queued.session_id,queued.job_id,active_run;
end;
$$;
create temp table screenshot_runs as
select label,run.* from (values ('complete'),('partial'),('revoked')) fixture(label)
cross join lateral pg_temp.browser_run('Screenshot run ' || label) run;
create function pg_temp.run_id(p_label text default 'complete') returns uuid language sql stable as $$
  select run_id from screenshot_runs where label=p_label;
$$;
create function pg_temp.scope_id() returns text language sql stable as $$select id::text || '/capture' from browser_tool$$;
create function pg_temp.browser_path(p_run_id uuid,p_asset_id uuid) returns text language sql immutable as $$
  select pg_temp.browser_id(1)::text || '/' || p_run_id::text || '/browser/' || p_asset_id::text || '.png';
$$;
create function pg_temp.reserve_screenshot(p_run_id uuid,p_asset_id uuid) returns uuid language sql as $$
  select public.begin_workspace_resource_operation(pg_temp.browser_id(1),'upload','',pg_temp.browser_path(p_run_id,p_asset_id),
    'session-validation-evidence',clock_timestamp()+interval '5 minutes');
$$;
create function pg_temp.store_screenshot(p_run_id uuid,p_asset_id uuid,p_size integer default 120)
returns void language sql as $$
  insert into storage.objects(bucket_id,name,metadata) values ('session-validation-evidence',pg_temp.browser_path(p_run_id,p_asset_id),
    jsonb_build_object('size',p_size,'mimetype','image/png'));
$$;
create function pg_temp.receipt(p_key text,p_asset_slot integer,p_size integer default 120) returns jsonb language sql immutable as $$
  select jsonb_build_object('key',p_key,'kind','screenshot','path','/fixtures/' || p_key,'policy','isolated-fixture-v1',
    'status','captured','browserSessionId',pg_temp.browser_id(7,p_asset_slot),'manifest',jsonb_build_object(
      'assetId',pg_temp.browser_id(8,p_asset_slot),'sizeBytes',p_size,'contentType','image/png','sha256',repeat('d',64)));
$$;
create function pg_temp.transfers(p_run_id uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('assetId',split_part(split_part(operation.resource_id,'/',4),'.',1),
    'operationId',operation.id) order by operation.resource_id),'[]'::jsonb)
  from public.workspace_resource_operations operation
  where split_part(operation.resource_id,'/',2)=p_run_id::text and split_part(operation.resource_id,'/',3)='browser';
$$;
create function pg_temp.submit_browser(
  p_run_id uuid,p_records jsonb,p_transfers jsonb,p_scope text default pg_temp.scope_id()
) returns public.session_browser_verification_receipts language sql as $$
  select public.record_session_browser_screenshot_verification(p_run_id,1,repeat('b',40),repeat('c',40),
    p_records,p_transfers,p_scope);
$$;

select ok((select not public and file_size_limit>=1048576 and 'image/png'=any(allowed_mime_types)
  and 'text/plain'=any(allowed_mime_types) and 'application/json'=any(allowed_mime_types)
  from storage.buckets where id='session-validation-evidence'),'the evidence bucket admits bounded PNG and stays private');
select ok(public.authorize_session_browser_screenshot(pg_temp.run_id(),1,repeat('b',40),repeat('c',40),pg_temp.scope_id()),
  'a currently owned exact run with the approved operation may invoke the trusted runtime');
select is(public.authorize_session_browser_screenshot(pg_temp.run_id(),1,repeat('b',40),repeat('c',40),
  replace(pg_temp.scope_id(),'/capture','/not-approved')),false,'a different operation cannot authorize capture');
select throws_ok($$select public.authorize_session_browser_screenshot(pg_temp.run_id(),2,repeat('b',40),repeat('c',40),pg_temp.scope_id())$$,
  '23514',null,'capture authorization cannot move to a different attempt');
select throws_ok($$select public.authorize_session_browser_screenshot(pg_temp.run_id(),1,repeat('b',40),repeat('e',40),pg_temp.scope_id())$$,
  '23514',null,'capture authorization cannot move to a different validation tree');
select throws_ok($$select pg_temp.store_screenshot(pg_temp.run_id(),pg_temp.browser_id(8))$$,
  '23514',null,'the browser namespace cannot accept uploads without an active cleanup reservation');
select throws_ok($$insert into storage.objects(bucket_id,name,metadata) values ('session-validation-evidence',
  pg_temp.browser_id(1)::text || '/' || pg_temp.run_id()::text || '/' || pg_temp.browser_id(8)::text,
  '{"mimetype":"image/png","size":120}')$$,'23514',null,'command paths cannot store trusted PNG evidence');
select throws_ok($$select public.record_session_validation_evidence(pg_temp.run_id(),repeat('b',40),repeat('c',40),'[]',jsonb_build_array(
  jsonb_build_object('id',pg_temp.browser_id(8),'key','tests/log','kind','screenshot','required',false,
    'storagePath',pg_temp.browser_id(1)::text || '/' || pg_temp.run_id()::text || '/' || pg_temp.browser_id(8)::text,
    'sha256',repeat('d',64),'contentType','image/png','sizeBytes',120)))$$,
  '23514',null,'the command writer cannot register raw PNG as evidence');

select pg_temp.reserve_screenshot(pg_temp.run_id(),pg_temp.browser_id(8));
select pg_temp.reserve_screenshot(pg_temp.run_id(),pg_temp.browser_id(8,2));
select throws_ok($$select pg_temp.reserve_screenshot(pg_temp.run_id(),pg_temp.browser_id(8))$$,
  '23505',null,'one upload path has only one cleanup owner');
select throws_ok($$select pg_temp.store_screenshot(pg_temp.run_id(),pg_temp.browser_id(8),1048577)$$,
  '23514',null,'oversized screenshot storage metadata is rejected');
select pg_temp.store_screenshot(pg_temp.run_id(),pg_temp.browser_id(8));
create temp table complete_inputs as select jsonb_build_array(pg_temp.receipt('open',1),pg_temp.receipt('review',2)) as records,
  pg_temp.transfers(pg_temp.run_id()) as transfers;
select throws_ok($$select public.record_session_browser_verification(pg_temp.run_id(),1,repeat('b',40),repeat('c',40),
  (select records from complete_inputs))$$,'23514',null,'the legacy outcome writer cannot mint positive captures');
select throws_ok($$select pg_temp.submit_browser(pg_temp.run_id(),jsonb_set(records,'{0,path}','"/wrong"'),transfers)
  from complete_inputs$$,'23514',null,'a receipt cannot retarget the isolated page');
select throws_ok($$select pg_temp.submit_browser(pg_temp.run_id(),jsonb_set(records,'{0,manifest,contentType}','"image/svg+xml"'),transfers)
  from complete_inputs$$,'23514',null,'only bounded PNG manifests can claim screenshot success');
select throws_ok($$select pg_temp.submit_browser(pg_temp.run_id(),records,transfers,null) from complete_inputs$$,
  '42501',null,'upload metadata alone cannot substitute for live runtime approval');
insert into storage.objects(bucket_id,name,metadata)
values ('session-validation-evidence',pg_temp.browser_path(pg_temp.run_id(),pg_temp.browser_id(8,2)),
  '{"mimetype":"image/png"}');
select throws_ok($$select pg_temp.submit_browser(pg_temp.run_id(),records,transfers) from complete_inputs$$,
  '23514',null,'a staged storage placeholder cannot complete the receipt or transfer');
select is((select count(*) from public.session_browser_verification_assets),0::bigint,'a partial transaction retains no asset metadata');
select is((select count(*) from public.session_browser_verification_receipts),0::bigint,'a partial transaction retains no successful receipt');
select is(jsonb_array_length(pg_temp.transfers(pg_temp.run_id())),2,'failed transfer leaves both reservations for cleanup');
update storage.objects set metadata='{"size":120,"mimetype":"image/png"}'
where name=pg_temp.browser_path(pg_temp.run_id(),pg_temp.browser_id(8,2));
create temp table retained_receipt as select result.* from complete_inputs cross join lateral
  pg_temp.submit_browser(pg_temp.run_id(),records,transfers) result;
select is((select records from retained_receipt),(select records from complete_inputs),'both planned capture outcomes are durable');
select is((select count(*) from public.session_browser_verification_assets where run_id=pg_temp.run_id()),2::bigint,
  'two captures own exactly two PNG assets');
select is(jsonb_array_length(pg_temp.transfers(pg_temp.run_id())),0,'the same transaction transfers both cleanup reservations');
select is((select (pg_temp.submit_browser(pg_temp.run_id(),records,transfers)).created_at from complete_inputs),
  (select created_at from retained_receipt),'an exact replay reuses the receipt after reservations are consumed');
select throws_ok($$select pg_temp.reserve_screenshot(pg_temp.run_id(),pg_temp.browser_id(8))$$,'23514',null,
  'an already retained path cannot acquire a new cleanup operation');
select throws_ok($$update storage.objects set metadata=jsonb_set(metadata,'{size}','121')
  where name=pg_temp.browser_path(pg_temp.run_id(),pg_temp.browser_id(8))$$,'23514',null,
  'a delayed metadata write cannot replace a transferred object');
select throws_ok($$update public.session_browser_verification_assets set size_bytes=0$$,'23514',null,
  'asset metadata stays immutable even with table-owner rights');

select pg_temp.reserve_screenshot(pg_temp.run_id('partial'),pg_temp.browser_id(8,3));
select pg_temp.store_screenshot(pg_temp.run_id('partial'),pg_temp.browser_id(8,3));
select pg_temp.submit_browser(pg_temp.run_id('partial'),jsonb_build_array(pg_temp.receipt('open',3),
  '{"key":"review","kind":"screenshot","path":"/fixtures/review","policy":"isolated-fixture-v1",
   "status":"failed","reason":"capture_failed"}'::jsonb),pg_temp.transfers(pg_temp.run_id('partial')));
select is((select records->1->>'status' from public.session_browser_verification_receipts where run_id=pg_temp.run_id('partial')),
  'failed','a failed required capture remains explicitly nonpassing next to a valid capture');
select is((select count(*) from public.session_browser_verification_assets where run_id=pg_temp.run_id('partial')),1::bigint,
  'a failed capture owns no asset');

select ok(public.authorize_session_browser_screenshot(pg_temp.run_id('revoked'),1,repeat('b',40),repeat('c',40),pg_temp.scope_id()),
  'the grant is live before capture starts');
select pg_temp.reserve_screenshot(pg_temp.run_id('revoked'),pg_temp.browser_id(8,4));
select pg_temp.store_screenshot(pg_temp.run_id('revoked'),pg_temp.browser_id(8,4));
select public.revoke_factory_execution_grant(workspace_id,factory_id,pg_temp.browser_id(0),id,version,'Revoked while capturing')
from browser_grant;
select throws_ok($$select pg_temp.submit_browser(pg_temp.run_id('revoked'),jsonb_build_array(pg_temp.receipt('open',4),
  '{"key":"review","kind":"screenshot","path":"/fixtures/review","policy":"isolated-fixture-v1",
   "status":"failed","reason":"capture_failed"}'::jsonb),pg_temp.transfers(pg_temp.run_id('revoked')))$$,
  '42501',null,'tool approval revoked between capture and transfer prevents publication');
select is(jsonb_array_length(pg_temp.transfers(pg_temp.run_id('revoked'))),1,'revoked capture leaves the upload for cleanup');

grant select on screenshot_runs to authenticated;
set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='58400000-0000-4000-8000-000000000001';
select is((select count(*) from public.session_browser_verification_assets where run_id=pg_temp.run_id()),2::bigint,
  'the exact authorized session reviewer can inspect durable metadata');
select is((select count(*) from storage.objects where name=pg_temp.browser_path(pg_temp.run_id(),pg_temp.browser_id(8))),
  0::bigint,'the reviewer uses the authorized proxy and cannot directly access or sign screenshot Storage');
select is((select count(*) from storage.objects where name=pg_temp.browser_path(pg_temp.run_id('revoked'),pg_temp.browser_id(8,4))),
  0::bigint,'unpublished uploaded pixels remain private even to the workspace owner');
select throws_ok($$select public.authorize_session_browser_screenshot(pg_temp.run_id(),1,repeat('b',40),repeat('c',40),'untrusted')$$,
  '42501',null,'browser clients cannot invoke the trusted capture authorization');
set local request.jwt.claim.sub='58400000-0000-4000-8000-000000000002';
select is((select count(*) from public.session_browser_verification_assets),0::bigint,'another workspace cannot inspect screenshot manifests');
select is((select count(*) from storage.objects where bucket_id='session-validation-evidence'),0::bigint,
  'another workspace cannot read stored screenshot bytes');
reset role;

select * from finish();
rollback;
