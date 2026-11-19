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
select label,run.* from (values ('complete'),('incomplete'),('revoked'),('aged')) fixture(label)
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
  0::bigint,'an authorized reviewer gets video through the Wallie proxy instead of direct Storage access');
select is((select count(*) from storage.objects where name=pg_temp.media_path(pg_temp.run_id('incomplete'),pg_temp.browser_id(8,3),'webm')),
  0::bigint,'staged unverified bytes are unavailable even to the authorized reviewer');
set local request.jwt.claim.sub='58600000-0000-4000-8000-000000000002';
select is((select count(*) from public.session_browser_verification_assets),0::bigint,'another workspace cannot see video evidence metadata');
select is((select count(*) from storage.objects where bucket_id='session-validation-evidence'),0::bigint,
  'another workspace cannot retrieve private evidence');
reset role;


set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '58600000-0000-4000-8000-000000000001';
select ok(has_table_privilege('service_role', 'public.session_browser_asset_withholdings', 'select')
  and not has_table_privilege('service_role', 'public.session_browser_asset_withholdings', 'insert')
  and not has_table_privilege('authenticated', 'public.session_browser_asset_withholdings', 'select')
  and not has_function_privilege('anon', 'public.erase_session_retained_content(uuid,uuid,uuid,timestamptz)', 'execute'),
  'private withholding is service-readable and permanent erasure is never anonymous');

-- Seed an aged copy with its exact plan and already retained manifest. The
-- ordinary capture tests above exercise acquisition and actual settlement.
insert into public.session_browser_verification_receipts
  (run_id, workspace_id, session_id, records, created_at)
select run_id,pg_temp.browser_id(1),session_id,'[]',clock_timestamp()-interval '3 days'
from screenshot_runs where label='aged';
insert into public.session_browser_verification_assets
  (id, run_id, workspace_id, session_id, evidence_key, browser_session_id, approval_scope_id, required,
   storage_path, sha256, content_type, size_bytes, duration_ms, width_px, height_px, frame_offsets_ms,
   capture_started_at, capture_completed_at)
select candidate.id,run.run_id,asset.workspace_id,run.session_id,asset.evidence_key,
  pg_temp.browser_id(9,candidate.slot),asset.approval_scope_id,asset.required,
  pg_temp.media_path(run.run_id,candidate.id,case when asset.content_type='image/png' then 'png' else 'webm' end),
  asset.sha256,asset.content_type,asset.size_bytes,asset.duration_ms,asset.width_px,asset.height_px,asset.frame_offsets_ms,
  asset.capture_started_at,asset.capture_completed_at
from public.session_browser_verification_assets asset
join (values (pg_temp.browser_id(8,1),pg_temp.browser_id(9,11),1),
  (pg_temp.browser_id(8,2),pg_temp.browser_id(9,12),2)) candidate(source_id,id,slot) on candidate.source_id=asset.id
cross join screenshot_runs run where run.label='aged';
select public.fail_session_job_attempt(job_id,1,'Fixture finished',false,2,run_id) from screenshot_runs where label='aged';
update public.agent_runs set finished_at=clock_timestamp()-interval '3 days' where id=pg_temp.run_id('aged');
select public.save_workspace_run_retention(pg_temp.browser_id(1),pg_temp.browser_id(0),p_evidence_days=>1);
select is((select evidence_expired from public.mark_expired_workspace_run_content()),1,
  'routine evidence retention expires old optional PNGs without expiring a required video in an active session');
select is((select state from public.session_browser_asset_withholdings where asset_id=pg_temp.browser_id(9,11)),
  'expired','an aged screenshot retains an explicit reason rather than an advertised asset');
select ok(not exists(select 1 from public.session_browser_asset_withholdings where asset_id=pg_temp.browser_id(9,12)),
  'the active required video has no withholding marker');
select public.archive_session_job_attempts(session_id,pg_temp.browser_id(1),'Temporarily archived')
from screenshot_runs where label='aged';
select is((select evidence_expired from public.mark_expired_workspace_run_content()),1,
  'the same aged required browser asset is eligible when its session is archived');
update public.sessions set archived_at=null where id=(select session_id from screenshot_runs where label='aged');
select is((select state from public.session_browser_asset_withholdings where asset_id=pg_temp.browser_id(9,12)),
  'expired','restoring an ordinary archive cannot resurrect withheld evidence');

-- Stage another provisional upload for the exact complete run while its
-- authorization still exists. There is no immutable receipt for this path.
create temp table late_browser_upload as
select pg_temp.reserve_media(pg_temp.run_id(),pg_temp.browser_id(9,20),'png') as operation_id;
insert into storage.objects(bucket_id,name,metadata) values
  ('session-validation-evidence',pg_temp.media_path(pg_temp.run_id(),pg_temp.browser_id(9,20),'png'),
    '{"mimetype":"image/png"}');

insert into public.session_artifacts(id,workspace_id,session_id,stage_id,stage_slug,version,artifact_json)
select pg_temp.browser_id(9,30),pg_temp.browser_id(1),session_id,pg_temp.browser_id(4),'visual-build',1,
  to_jsonb('Legacy stage output without a producer checkpoint'::text)
from screenshot_runs where label='complete';
insert into public.session_run_context_manifests(run_id,workspace_id,session_id,job_id,attempt_count,manifest,manifest_sha256)
select run_id,pg_temp.browser_id(1),session_id,job_id,1,payload,encode(sha256(convert_to(payload::text,'UTF8')),'hex')
from screenshot_runs
cross join (select '{"version":2,"required":[],"documents":[],"memories":[],"conversation":{"throughSequence":0,"olderOmitted":0,"messages":[]},
  "budget":{"maxUtf8Bytes":131072,"maxEstimatedTokens":32768,"usedUtf8Bytes":0,"estimatedTokens":0}}'::jsonb as payload) context
where label='incomplete';
-- The grant was revoked above. Seed the previously staged candidate's
-- immutable identity instead of making a fresh proposal as a revoked agent.
insert into internal.factory_run_memory_proposals
  (run_id,workspace_id,factory_id,session_id,attempt_count,artifact_sha256,body_md,body_sha256)
select run.run_id,factory.workspace_id,factory.id,run.session_id,1,repeat('a',64),'Pending private note',
  encode(sha256(convert_to('Pending private note','UTF8')),'hex')
from screenshot_runs run cross join browser_factory factory where run.label='incomplete';

insert into public.factory_memories(id,workspace_id,factory_id,title,source_session_id,source_artifact_id,
  source_artifact_version,source_run_id,source_attempt_count,source_commit_sha,source_content_sha256)
select pg_temp.browser_id(10,source.slot),factory.workspace_id,factory.id,'Derived private memory title',
  run.session_id,pg_temp.browser_id(9,30+source.slot),1,run.run_id,1,repeat('b',40),repeat('c',64)
from (values ('complete',1),('aged',2)) source(label,slot)
join screenshot_runs run using (label) cross join browser_factory factory;
insert into public.factory_memory_revisions(id,workspace_id,factory_id,memory_id,revision_number,content_sha256)
select pg_temp.browser_id(11,row_number() over (order by memory.id)::integer),memory.workspace_id,memory.factory_id,memory.id,1,
  encode(sha256(convert_to('Approved private memory body','UTF8')),'hex')
from public.factory_memories memory where memory.workspace_id=pg_temp.browser_id(1);
insert into public.factory_memory_revision_bodies(workspace_id,factory_id,memory_id,revision_id,body_md)
select revision.workspace_id,revision.factory_id,revision.memory_id,revision.id,'Approved private memory body'
from public.factory_memory_revisions revision where revision.workspace_id=pg_temp.browser_id(1);
insert into public.factory_memory_review_events(id,workspace_id,factory_id,memory_id,revision_id,actor_member_id,action)
select pg_temp.browser_id(12,1),r.workspace_id,r.factory_id,r.memory_id,r.id,pg_temp.browser_id(2),'approved'
from public.factory_memory_revisions r where r.memory_id=pg_temp.browser_id(10,1);
update public.factory_memories memory set current_revision_id=event.revision_id,current_approval_id=event.id
from public.factory_memory_review_events event where event.memory_id=memory.id;

create temp table old_browser_export as
select * from public.request_run_export(pg_temp.browser_id(1),pg_temp.browser_id(0),pg_temp.browser_id(13,1));
create temp table old_browser_export_claim as select * from public.claim_run_export();
select ok(exists(select 1 from internal.run_export_entries entry join old_browser_export_claim claim using (export_id)
  where entry.record_kind='stage_markdown' and entry.record_id=pg_temp.browser_id(9,30) and entry.run_id is null),
  'the existing workspace export contains a legacy unlinked artifact from the session');

grant select on browser_factory, screenshot_runs to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select throws_ok($$select public.erase_session_retained_content(factory.workspace_id,factory.id,run.session_id,null)
  from browser_factory factory cross join screenshot_runs run where run.label='complete'$$,
  'PT409',null,'an active session cannot be erased without a matching archive');
reset role;
set local request.jwt.claim.role = 'service_role';
update public.sessions set archived_at=clock_timestamp() where id=(select session_id from screenshot_runs where label='complete');
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select throws_ok($$select public.erase_session_retained_content(factory.workspace_id,factory.id,run.session_id,owner.archived_at)
  from browser_factory factory cross join screenshot_runs run join public.sessions owner on owner.id=run.session_id
  where run.label='complete'$$, 'PT409',null,'an archived flag alone cannot erase an active attempt');
reset role;
set local request.jwt.claim.role = 'service_role';
select public.archive_session_job_attempts(session_id,pg_temp.browser_id(1),'Cancel before permanent erasure')
from screenshot_runs where label in ('complete','incomplete');
create temp table erasure_targets as
select owner.workspace_id,owner.factory_id,owner.id as session_id,owner.archived_at,fixture.label
from screenshot_runs fixture join public.sessions owner on owner.id=fixture.session_id
where fixture.label in ('complete','incomplete');
grant select on erasure_targets to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '58600000-0000-4000-8000-000000000002';
select throws_ok($$select public.erase_session_retained_content(workspace_id,factory_id,session_id,archived_at)
  from erasure_targets where label='complete'$$, '42501',null,'a foreign workspace owner cannot erase the session');
set local request.jwt.claim.sub = '58600000-0000-4000-8000-000000000001';
select throws_ok($$select public.erase_session_retained_content(workspace_id,factory_id,session_id,
  archived_at-interval '1 second') from erasure_targets where label='complete'$$,
  'PT409',null,'a stale archive version cannot authorize permanent erasure');
create temp table erasure_receipts as
select target.label,receipt.* from erasure_targets target cross join lateral public.erase_session_retained_content(
  target.workspace_id,target.factory_id,target.session_id,target.archived_at) receipt;
select is((select (public.erase_session_retained_content(workspace_id,factory_id,session_id,archived_at)).erased_at
  from erasure_targets where label='complete'), (select erased_at from erasure_receipts where label='complete'),
  'repeating the exact erasure returns its original receipt');
select ok((select (public.get_session_retained_content_erasure(workspace_id,session_id)).actor_member_id=pg_temp.browser_id(2)
  from erasure_targets where label='complete'),'the authorized reviewer sees the exact erasure and human actor');
set local request.jwt.claim.sub = '58600000-0000-4000-8000-000000000002';
select is((select (public.get_session_retained_content_erasure(workspace_id,session_id)).erased_at
  from erasure_targets where label='complete'), null::timestamptz,'an unrelated viewer cannot read the erasure receipt');
reset role;
set local request.jwt.claim.role = 'service_role';

select throws_ok($$update public.sessions set archived_at=null where id=(select session_id from erasure_targets where label='complete')$$,
  'PT409',null,'an exact erased session cannot be restored through the normal update');
select throws_ok($$select pg_temp.reserve_media(pg_temp.run_id(),pg_temp.browser_id(9,21),'webm')$$,
  'PT409',null,'a new Storage reservation cannot target an erased run');
select throws_ok($$update storage.objects set metadata='{"mimetype":"image/png","size":123}'
  where bucket_id='session-validation-evidence' and name=pg_temp.media_path(pg_temp.run_id(),pg_temp.browser_id(9,20),'png')$$,
  'PT409',null,'a provisional upload cannot finalize after the owning session is erased');
select is((select count(*) from public.workspace_resource_operations where id=(select operation_id from late_browser_upload)),
  1::bigint,'the fenced late upload still belongs to the existing abandoned-upload cleanup');
select throws_ok($$select pg_temp.record_media(pg_temp.run_id(),records,transfers) from media_inputs$$,
  'PT409',null,'an erased browser receipt cannot be returned as a fresh adoption');
select throws_ok($$select public.authorize_session_browser_video(pg_temp.run_id(),1,repeat('b',40),repeat('c',40),
  pg_temp.video_scope())$$, 'PT409',null,'browser capture authorization rechecks the exact erasure marker');
select is((select count(*) from public.session_browser_asset_withholdings marker
  join public.session_browser_verification_assets asset on asset.id=marker.asset_id
  where asset.run_id=pg_temp.run_id() and marker.state='erased' and marker.purged_at is null),
  2::bigint,'both exact asset references are unavailable while their bytes still exist');
select is((select records from public.session_browser_verification_receipts where run_id=pg_temp.run_id()),
  (select records from published_media),'erasure leaves the immutable capture record unchanged');
select is((select count(*) from internal.factory_run_memory_proposals where run_id=pg_temp.run_id('incomplete')),
  0::bigint,'the staged note owned by the erased session is physically removed');
select ok((select forgotten_at is not null and title is null and current_revision_id is null
  from public.factory_memories where id=pg_temp.browser_id(10,1)), 'a memory sourced by the erased session is forgotten');
select is((select count(*) from public.factory_memory_revision_bodies where memory_id=pg_temp.browser_id(10,1)),
  0::bigint,'the source-owned note no longer has a private body');
select is((select count(*) from public.factory_memory_revision_bodies where memory_id=pg_temp.browser_id(10,2)),
  1::bigint,'another session and its memory are untouched');
select is((select count(*) from public.factory_memory_review_events where memory_id=pg_temp.browser_id(10,1)
  and action='forgotten' and actor_member_id=pg_temp.browser_id(2)),1::bigint,
  'session erasure records the same human memory forget decision');

select ok((select status='expired' and failure_code='source_withheld' and lease_token is null
  from public.run_exports where id=(select export_id from old_browser_export_claim)),
  'erasure atomically invalidates the prior export and its running lease');
select ok(not (select public.complete_run_export(export_id,lease_token) from old_browser_export_claim),
  'a previously claimed export cannot publish after erasure');
select is((select count(*) from old_browser_export_claim claim
  cross join lateral public.read_run_export_page(claim.export_id,claim.lease_token) page),0::bigint,
  'an old lease cannot read the pending export page');
select public.request_run_export(pg_temp.browser_id(1),pg_temp.browser_id(0),pg_temp.browser_id(13,2));
create temp table next_browser_export_claim as select * from public.claim_run_export();
select is((select count(*) from internal.run_export_entries entry join next_browser_export_claim claim using (export_id)
  where entry.run_id in (pg_temp.run_id(),pg_temp.run_id('incomplete')) or entry.record_id=pg_temp.browser_id(9,30)),
  0::bigint,'new snapshots omit erased run content and its legacy unlinked artifact');

create temp table first_browser_purge as select * from public.claim_run_evidence_purges(3);
select is((select count(*) from first_browser_purge),3::bigint,'the shared evidence claim honors its global batch cap');
create temp table rest_browser_purge as select * from public.claim_run_evidence_purges();
select is((select count(*) from rest_browser_purge),1::bigint,'leased evidence paths cannot be claimed by another worker');
create temp table browser_purge as select * from first_browser_purge union all select * from rest_browser_purge;
select is(public.complete_run_evidence_purges((select array_agg(claim_id) from browser_purge
  where asset_id in (pg_temp.browser_id(8,1),pg_temp.browser_id(8,2)))),0,
  'the browser cleanup acknowledgement cannot settle a physically present object');
update public.session_browser_asset_withholdings set cleanup_available_at=clock_timestamp()-interval '1 second'
where asset_id in (pg_temp.browser_id(8,1),pg_temp.browser_id(8,2));
create temp table retry_browser_purge as select * from public.claim_run_evidence_purges();
select results_eq($$select storage_path from retry_browser_purge order by storage_path$$,
  $$select storage_path from browser_purge where asset_id in (pg_temp.browser_id(8,1),pg_temp.browser_id(8,2)) order by storage_path$$,
  'lease recovery retries just the identical exact media paths');
-- These are synthetic Storage metadata rows with no backend bytes.
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id='session-validation-evidence' and name in (select storage_path from retry_browser_purge);
select is(public.complete_run_evidence_purges((select array_agg(claim_id) from browser_purge
  where asset_id in (pg_temp.browser_id(8,1),pg_temp.browser_id(8,2)))),0,'a stale lease cannot settle a retry');
select is(public.complete_run_evidence_purges((select array_agg(claim_id) from retry_browser_purge)),2,
  'the current lease acknowledges the exact absent PNG and WebM');
select is(public.complete_run_evidence_purges((select array_agg(claim_id) from retry_browser_purge)),0,
  'repeating a completed acknowledgement is idempotent');

select public.archive_session_job_attempts(session_id,pg_temp.browser_id(1),'Stop before workspace erase')
from screenshot_runs where label='revoked';
select public.begin_workspace_deletion(pg_temp.browser_id(1),pg_temp.browser_id(2),'Private video fixture');
select is(public.finish_workspace_deletion(pg_temp.browser_id(1)),false,
  'workspace deletion waits for remaining upload reservations and physical evidence');
delete from storage.objects where bucket_id='session-validation-evidence' and split_part(name,'/',1)=pg_temp.browser_id(1)::text;
delete from public.workspace_resource_operations where workspace_id=pg_temp.browser_id(1);
select is(public.finish_workspace_deletion(pg_temp.browser_id(1)),true,
  'workspace deletion can finish and cascade frozen browser evidence, memory and retention metadata');
select is((select count(*) from public.session_browser_asset_withholdings),0::bigint,
  'workspace cascade leaves no orphan browser withholding rows');
select is((select count(*) from public.session_retained_content_erasures),0::bigint,
  'workspace cascade leaves no orphan session erasure rows');

select * from finish();
rollback;
