begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.browser_id(category integer, slot integer default 1) returns uuid
language sql immutable as $$
  select ('58600000-' || lpad(category::text, 4, '0') || '-4000-8000-' || lpad(slot::text, 12, '0'))::uuid;
$$;

select public.set_git_continuity_release(true, revision, 'Private WebM database fixture')
from public.get_git_continuity_release_state() where not enabled;
insert into auth.users(id,email) values
  (pg_temp.browser_id(0), 'browser-video-owner@example.test'),
  (pg_temp.browser_id(0,2), 'browser-video-outsider@example.test');
insert into public.workspaces(id,slug,name) values
  (pg_temp.browser_id(1), 'private-video-fixture', 'Private video fixture'),
  (pg_temp.browser_id(1,2), 'private-video-foreign', 'Unrelated video workspace');
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
values (pg_temp.browser_id(5),pg_temp.browser_id(1),58600001,'https://github.test/installations/58600001',
  58600,'Organization','fixture','{"contents":"write"}');
insert into public.github_repositories(id,workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch)
select pg_temp.browser_id(6),workspace_id,id,pg_temp.browser_id(5),58600001,'writer','fixture/writer',true,
  'https://github.test/fixture/writer','main' from browser_factory;
select public.save_execution_policy(pg_temp.browser_id(1),pg_temp.browser_id(0),0,
  '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":30000,"maxTotalTokens":1000,"maxCostUsd":1}');
create temp table browser_prompt as
select prompt.* from browser_factory factory cross join lateral public.create_factory_agent(factory.workspace_id,factory.id,
  pg_temp.browser_id(0),'Browser builder','browser-builder','Synthetic build prompt') prompt;
create temp table browser_tool as
select tool.* from browser_factory factory cross join lateral public.create_factory_mcp_server(factory.workspace_id,factory.id,
  pg_temp.browser_id(0),'Trusted browser fixture','browser-fixture','https://browser.example.test/mcp',
  array['capture','record_video'],'none') tool;
create temp table browser_grant as
select approved.* from browser_factory factory join public.execution_policies policy using(workspace_id)
cross join browser_tool tool
cross join lateral public.create_service_principal(factory.workspace_id,factory.id,pg_temp.browser_id(0),
  'Browser fixture service','browser-fixture-service') principal
cross join lateral public.approve_factory_execution_grant(factory.workspace_id,factory.id,pg_temp.browser_id(0),principal.id,
  pg_temp.browser_id(6),'{}'::uuid[],array[tool.id::text || '/capture',tool.id::text || '/record_video'],policy.current_revision_id,
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
  select '{"version":2,"commands":[],"browser":[
    {"key":"workflow","path":"/fixtures/workflow","timeoutSeconds":5,
      "interactions":[{"action":"expectVisible","testId":"main"}],"regionTestId":"main","excludedTestIds":["private"],
      "evidence":[{"kind":"screenshot","required":false},{"kind":"video","required":true}]}]}'::jsonb;
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
select label,run.* from (values ('complete'),('incomplete'),('revoked')) fixture(label)
cross join lateral pg_temp.browser_run('Media run ' || label) run;
create function pg_temp.run_id(p_label text default 'complete') returns uuid language sql stable as $$
  select run_id from screenshot_runs where label=p_label;
$$;
create function pg_temp.scope_id() returns text language sql stable as $$select id::text || '/capture' from browser_tool$$;
create function pg_temp.video_scope() returns text language sql stable as $$
  select id::text || '/record_video' from browser_tool;
$$;
create function pg_temp.media_path(p_run_id uuid,p_asset_id uuid,p_extension text) returns text language sql immutable as $$
  select pg_temp.browser_id(1)::text || '/' || p_run_id::text || '/browser/' || p_asset_id::text || '.' || p_extension;
$$;
create function pg_temp.reserve_media(p_run_id uuid,p_asset_id uuid,p_extension text) returns uuid language sql as $$
  select public.begin_workspace_resource_operation(pg_temp.browser_id(1),'upload','',
    pg_temp.media_path(p_run_id,p_asset_id,p_extension),'session-validation-evidence',clock_timestamp()+interval '5 minutes');
$$;
create function pg_temp.staged_transfers(p_run_id uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('assetId',split_part(split_part(operation.resource_id,'/',4),'.',1),
    'operationId',operation.id) order by operation.resource_id),'[]'::jsonb)
  from public.workspace_resource_operations operation
  where split_part(operation.resource_id,'/',2)=p_run_id::text and split_part(operation.resource_id,'/',3)='browser';
$$;
create function pg_temp.record_media(
  p_run_id uuid,p_records jsonb,p_transfers jsonb,p_png_scope text default pg_temp.scope_id(),
  p_video_scope text default pg_temp.video_scope()
) returns public.session_browser_verification_receipts language sql as $$
  select public.record_session_browser_media_verification(p_run_id,1,repeat('b',40),repeat('c',40),
    p_records,p_transfers,p_png_scope,p_video_scope);
$$;
create function pg_temp.capture_receipts() returns jsonb language sql stable as $$
  select jsonb_build_array(
    jsonb_build_object('key','workflow','kind','screenshot','path','/fixtures/workflow','policy','isolated-fixture-v1',
      'status','captured','browserSessionId',pg_temp.browser_id(7,1),'manifest',jsonb_build_object(
        'assetId',pg_temp.browser_id(8,1),'sizeBytes',120,'contentType','image/png','sha256',repeat('d',64))),
    jsonb_build_object('key','workflow','kind','video','path','/fixtures/workflow','policy','isolated-fixture-v1',
      'status','captured','browserSessionId',pg_temp.browser_id(7,2),
      'startedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'completedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'manifest',jsonb_build_object('assetId',pg_temp.browser_id(8,2),'sizeBytes',1200000,'contentType','video/webm',
        'sha256',repeat('e',64),'durationMs',1000,'widthPx',320,'heightPx',240,'frameOffsetsMs',jsonb_build_array(0,500)))
  );
$$;

select ok((select not public and file_size_limit=8388608 and 'video/webm'=any(allowed_mime_types)
  and 'image/png'=any(allowed_mime_types) and 'text/plain'=any(allowed_mime_types) and 'application/json'=any(allowed_mime_types)
  from storage.buckets where id='session-validation-evidence'),'the shared evidence bucket accepts bounded private WebM');
select ok(public.authorize_session_browser_video(pg_temp.run_id(),1,repeat('b',40),repeat('c',40),pg_temp.video_scope()),
  'the exact video operation authorizes the current frozen workflow');
select is(public.authorize_session_browser_video(pg_temp.run_id(),1,repeat('b',40),repeat('c',40),pg_temp.scope_id()),false,
  'the known approved screenshot operation cannot authorize video');
select is(public.authorize_session_browser_video(pg_temp.run_id(),1,repeat('b',40),repeat('c',40),
  pg_temp.browser_id(5,2)::text || '/record_video'),false,'correctly shaped but unapproved video scope cannot authorize');
select throws_ok($$select public.authorize_session_browser_video(pg_temp.run_id(),1,repeat('f',40),repeat('c',40),pg_temp.video_scope())$$,
  '23514',null,'video authorization cannot retarget a different commit');
select throws_ok($$insert into storage.objects(bucket_id,name,metadata)
  values ('session-validation-evidence',pg_temp.browser_id(1)::text || '/' || pg_temp.run_id()::text || '/command',
    '{"mimetype":"text/plain","size":1048577}')$$,
  '23514',null,'the larger shared bucket leaves the original text object cap intact');
select throws_ok($$insert into storage.objects(bucket_id,name,metadata)
  values ('session-validation-evidence',pg_temp.media_path(pg_temp.run_id(),pg_temp.browser_id(8,2),'webm'),
    '{"mimetype":"video/webm"}')$$,
  '23514',null,'even provisional WebM requires its exact upload reservation');
select pg_temp.reserve_media(pg_temp.run_id(),pg_temp.browser_id(8,1),'png');
select pg_temp.reserve_media(pg_temp.run_id(),pg_temp.browser_id(8,2),'webm');
insert into storage.objects(bucket_id,name,metadata) values
  ('session-validation-evidence',pg_temp.media_path(pg_temp.run_id(),pg_temp.browser_id(8,1),'png'),
    '{"mimetype":"image/png","size":120}'),
  ('session-validation-evidence',pg_temp.media_path(pg_temp.run_id(),pg_temp.browser_id(8,2),'webm'),
    '{"mimetype":"video/webm"}');
create temp table media_inputs as select pg_temp.capture_receipts() as records,pg_temp.staged_transfers(pg_temp.run_id()) as transfers;
select throws_ok($$select pg_temp.record_media(pg_temp.run_id(),records,transfers) from media_inputs$$,
  '23514',null,'unfinalized video is not playable and cannot transfer either asset');
select is((select count(*) from public.session_browser_verification_receipts where run_id=pg_temp.run_id()),0::bigint,
  'an unfinalized video did not publish a mixed receipt');
select is(jsonb_array_length(pg_temp.staged_transfers(pg_temp.run_id())),2,
  'the provisional uploads remain cleanup obligations');
select throws_ok($$update storage.objects set metadata='{"mimetype":"image/png","size":120}'
  where name=pg_temp.media_path(pg_temp.run_id(),pg_temp.browser_id(8,2),'webm')$$,
  '23514',null,'video extension cannot conceal a different MIME type');
update storage.objects set metadata='{"mimetype":"video/webm","size":1200000}'
where name=pg_temp.media_path(pg_temp.run_id(),pg_temp.browser_id(8,2),'webm');
select throws_ok($$select pg_temp.record_media(pg_temp.run_id(),records,transfers,pg_temp.scope_id(),pg_temp.scope_id()) from media_inputs$$,
  '42501',null,'the transfer does not accept a screenshot-only approval as the video scope');
select throws_ok($$select pg_temp.record_media(pg_temp.run_id(),records,transfers,pg_temp.video_scope(),pg_temp.video_scope()) from media_inputs$$,
  '42501',null,'PNG and WebM on the same workflow must use distinct approved scopes');
select throws_ok($$select pg_temp.record_media(pg_temp.run_id(),jsonb_set(records,'{1,manifest,durationMs}','1500'),transfers)
  from media_inputs$$,'23514',null,'a truncated or inconsistent duration cannot claim completed video');
select throws_ok($$select pg_temp.record_media(pg_temp.run_id(),jsonb_set(records,'{1,manifest,frameOffsetsMs}','[0,600]'),transfers)
  from media_inputs$$,'23514',null,'the retained frame positions must exactly match the planned workflow');
select throws_ok($$select pg_temp.record_media(pg_temp.run_id(),jsonb_set(records,'{1,manifest,widthPx}','961'),transfers)
  from media_inputs$$,'23514',null,'unsupported or odd-size picture dimensions cannot be published');
select throws_ok($$select pg_temp.record_media(pg_temp.run_id(),jsonb_set(jsonb_set(records,'{1,startedAt}','"2023-01-01T00:00:00.000Z"'),
  '{1,completedAt}','"2023-01-01T00:00:00.400Z"'),transfers) from media_inputs$$,
  '23514',null,'a recording time from a previous run does not belong to this attempt');

create temp table published_media as select result.* from media_inputs cross join lateral
  pg_temp.record_media(pg_temp.run_id(),records,transfers) result;
select is((select records from published_media),(select records from media_inputs),'both captured receipts atomically belong to one run');
select ok((select duration_ms=1000 and width_px=320 and height_px=240 and frame_offsets_ms=array[0,500]
  and capture_completed_at>=capture_started_at and size_bytes=1200000 and required and approval_scope_id=pg_temp.video_scope()
  from public.session_browser_verification_assets where id=pg_temp.browser_id(8,2)),
  'the video retains exact cadence, timing, dimensions, bytes, and authorized provenance');
select ok((select duration_ms is null and width_px is null and height_px is null and frame_offsets_ms is null
  and capture_started_at is null and capture_completed_at is null and not required and approval_scope_id=pg_temp.scope_id()
  from public.session_browser_verification_assets where id=pg_temp.browser_id(8,1)),
  'the PNG uses its existing MIME contract and has no video metadata');
select is(jsonb_array_length(pg_temp.staged_transfers(pg_temp.run_id())),0,'successful mixed transfer consumes both cleanup owners');
select is((select (pg_temp.record_media(pg_temp.run_id(),records,transfers)).created_at from media_inputs),
  (select created_at from published_media),'exact mixed-batch retry does not need another upload');
select throws_ok($$select pg_temp.record_media(pg_temp.run_id('incomplete'),records,transfers) from media_inputs$$,
  '23514',null,'a video created for one run cannot settle for another run');

select pg_temp.reserve_media(pg_temp.run_id('incomplete'),pg_temp.browser_id(8,3),'webm');
insert into storage.objects(bucket_id,name,metadata) values
  ('session-validation-evidence',pg_temp.media_path(pg_temp.run_id('incomplete'),pg_temp.browser_id(8,3),'webm'),
    '{"mimetype":"video/webm","size":100}');
select pg_temp.record_media(pg_temp.run_id('incomplete'),
  '[{"key":"workflow","kind":"screenshot","path":"/fixtures/workflow","policy":"isolated-fixture-v1",
     "status":"unavailable","reason":"runtime_unavailable"},
    {"key":"workflow","kind":"video","path":"/fixtures/workflow","policy":"isolated-fixture-v1",
     "status":"failed","reason":"capture_failed"}]','[]',null,null);
select is((select records->1->>'status' from public.session_browser_verification_receipts where run_id=pg_temp.run_id('incomplete')),
  'failed','an incomplete required recording can record a nonpassing outcome only');
select is((select count(*) from public.session_browser_verification_assets where run_id=pg_temp.run_id('incomplete')),
  0::bigint,'the incomplete run has no playable asset even with staged bytes');
select is(jsonb_array_length(pg_temp.staged_transfers(pg_temp.run_id('incomplete'))),1,
  'unretained staged video remains owned by orphan cleanup');

select ok(public.authorize_session_browser_video(pg_temp.run_id('revoked'),1,repeat('b',40),repeat('c',40),pg_temp.video_scope()),
  'the distinct video scope is live before capture');
select pg_temp.reserve_media(pg_temp.run_id('revoked'),pg_temp.browser_id(8,4),'webm');
insert into storage.objects(bucket_id,name,metadata) values
  ('session-validation-evidence',pg_temp.media_path(pg_temp.run_id('revoked'),pg_temp.browser_id(8,4),'webm'),
    '{"mimetype":"video/webm","size":1200000}');
select public.revoke_factory_execution_grant(workspace_id,factory_id,pg_temp.browser_id(0),id,version,'Revoked while recording')
from browser_grant;
select throws_ok($$select pg_temp.record_media(pg_temp.run_id('revoked'),jsonb_build_array(
  '{"key":"workflow","kind":"screenshot","path":"/fixtures/workflow","policy":"isolated-fixture-v1",
    "status":"unavailable","reason":"runtime_unavailable"}'::jsonb,
  jsonb_set(jsonb_set(records->1,'{browserSessionId}',to_jsonb(pg_temp.browser_id(7,4))),
    '{manifest,assetId}',to_jsonb(pg_temp.browser_id(8,4)))),
  pg_temp.staged_transfers(pg_temp.run_id('revoked')),null,pg_temp.video_scope()) from media_inputs$$,
  '42501',null,'video grant revocation during recording prevents a completed transfer');
select is(jsonb_array_length(pg_temp.staged_transfers(pg_temp.run_id('revoked'))),1,
  'revoked recording remains an inaccessible cleanup obligation');

grant select on screenshot_runs to authenticated;
set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='58600000-0000-4000-8000-000000000001';
select is((select count(*) from public.session_browser_verification_assets where content_type='video/webm'),
  1::bigint,'a scoped reviewer can inspect the completed private video after capture ends');
select is((select count(*) from storage.objects where name=pg_temp.media_path(pg_temp.run_id(),pg_temp.browser_id(8,2),'webm')),
  1::bigint,'private storage recognizes its exact authorized review session');
select is((select count(*) from storage.objects where name=pg_temp.media_path(pg_temp.run_id('incomplete'),pg_temp.browser_id(8,3),'webm')),
  0::bigint,'staged unverified bytes are unavailable even to the authorized reviewer');
set local request.jwt.claim.sub='58600000-0000-4000-8000-000000000002';
select is((select count(*) from public.session_browser_verification_assets),0::bigint,'another workspace cannot see video evidence metadata');
select is((select count(*) from storage.objects where bucket_id='session-validation-evidence'),0::bigint,
  'another workspace cannot retrieve private evidence');
reset role;

select * from finish();
rollback;
