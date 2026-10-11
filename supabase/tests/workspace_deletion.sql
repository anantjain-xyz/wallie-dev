begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';
-- Synthetic metadata has no uploaded blob; clean it inside this rollback only.
set local storage.allow_delete_query = 'true';

insert into public.workspaces(id, name, slug) values
  ('de100000-0000-4000-8000-000000000001', 'Deletion fixture', 'deletion-fixture');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  ('de100000-0000-4000-8000-000000000002', 'de100000-0000-4000-8000-000000000001',
    'a1b2c3d4-0001-4000-8000-000000000001', 'human', 'owner');
insert into public.workspace_e2b_sandbox_connections(workspace_id, encrypted_api_key)
  values('de100000-0000-4000-8000-000000000001', 'encrypted-fixture');
insert into storage.objects(bucket_id, name)
  values ('workspace-avatars', 'de100000-0000-4000-8000-000000000001/retained.png');
set local role service_role;

select is(public.finish_workspace_deletion('de100000-0000-4000-8000-000000000001'), false,
  'an unfenced workspace cannot be finalized');
select throws_ok($$select public.begin_workspace_deletion('de100000-0000-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001', 'Deletion fixture')$$, '42501',
  'Only the workspace owner can delete this workspace.', 'an owner of another workspace cannot fence this workspace');
select throws_ok($$select public.begin_workspace_deletion('de100000-0000-4000-8000-000000000001',
  'de100000-0000-4000-8000-000000000002', 'Wrong name')$$, '22023',
  'Type the workspace name exactly to confirm deletion.', 'confirmation is checked while holding the workspace lock');

create temp table old_connection as select connection_revision from public.workspace_e2b_sandbox_connections
  where workspace_id='de100000-0000-4000-8000-000000000001';
update public.workspace_e2b_sandbox_connections set encrypted_api_key='rotated-fixture'
  where workspace_id='de100000-0000-4000-8000-000000000001';
select throws_ok($$select public.begin_workspace_resource_operation(
  'de100000-0000-4000-8000-000000000001','sandbox','e2b','','',now()+interval '1 hour',
  (select connection_revision from old_connection))$$, 'P0011',
  'Sandbox connection changed. Refresh and try again.', 'a preloaded stale connection cannot acquire a sandbox');
create temp table deletion_operation as select public.begin_workspace_resource_operation(
  'de100000-0000-4000-8000-000000000001', 'sandbox', 'e2b', '', '', now()+interval '1 hour',
  (select connection_revision from public.workspace_e2b_sandbox_connections where workspace_id='de100000-0000-4000-8000-000000000001')) as id;
select throws_ok($$update public.workspace_e2b_sandbox_connections set encrypted_api_key='replacement'
  where workspace_id='de100000-0000-4000-8000-000000000001'$$, 'P0010',
  'Sandbox acquisition cleanup is still pending.', 'unsettled acquisitions retain their provider credentials');
create temp table deletion_fence as select public.begin_workspace_deletion(
  'de100000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000002', ' Deletion fixture ') as requested_at;
select is(public.begin_workspace_deletion('de100000-0000-4000-8000-000000000001',
  'de100000-0000-4000-8000-000000000002', 'Deletion fixture'),
  (select requested_at from deletion_fence), 'retry preserves the original deletion fence');
select is(public.finish_workspace_deletion('de100000-0000-4000-8000-000000000001'), false,
  'an unknown acquisition prevents hard deletion');

select throws_ok($$select public.begin_workspace_resource_operation('de100000-0000-4000-8000-000000000001',
  'upload', '', 'de100000-0000-4000-8000-000000000001/new.png', 'workspace-avatars', now()+interval '1 minute')$$,
  'P0010', 'Workspace deletion is in progress.', 'new external uploads cannot be admitted');
select throws_ok($$insert into storage.objects(bucket_id,name) values
  ('session-attachments','de100000-0000-4000-8000-000000000001/late.png')$$,
  'P0010', 'Workspace deletion is in progress.', 'a delayed Storage request cannot publish after fencing');
select throws_ok($$delete from public.workspace_e2b_sandbox_connections
  where workspace_id='de100000-0000-4000-8000-000000000001'$$,
  'P0010', 'Workspace deletion is in progress.', 'provider credentials survive failed cleanup');
select throws_ok($$insert into public.sandbox_capability_checks(workspace_id,status)
  values('de100000-0000-4000-8000-000000000001','running')$$,
  'P0010', 'Workspace deletion is in progress.', 'a new probe cannot be admitted');
select throws_ok($$insert into public.codex_device_auth_flows(workspace_id,user_id,status,sandbox_id,command_id,expires_at)
  values('de100000-0000-4000-8000-000000000001','a1b2c3d4-0001-4000-8000-000000000001','starting','provisioning:late','provisioning',now()+interval '1 hour')$$,
  'P0010', 'Workspace deletion is in progress.', 'device authentication cannot provision a new sandbox');
select throws_ok($$insert into public.session_attachments(workspace_id,original_filename,content_type,size_bytes,storage_path,expires_at)
  values('de100000-0000-4000-8000-000000000001','late.png','image/png',8,
  'de100000-0000-4000-8000-000000000001/late.png',now()+interval '1 hour')$$,
  'P0010', 'Workspace deletion is in progress.', 'attachment metadata cannot appear after deletion admission closes');
select throws_ok($$insert into public.workspace_sandbox_connection_mutations(workspace_id,provider)
  values('de100000-0000-4000-8000-000000000001','e2b')$$,
  'P0010', 'Workspace deletion is in progress.', 'a connection mutation cannot be admitted');
select is(public.record_workspace_resource_operation((select id from deletion_operation), 'sandbox-late'), false,
  'a late creator is refused execution after fencing');
select is((select resource_id from public.workspace_resource_operations where id=(select id from deletion_operation)),
  'sandbox-late', 'the refused creator still records its cleanup identity');
select is(public.record_workspace_resource_operation((select id from deletion_operation), 'sandbox-wrong'), false,
  'a different resource cannot replace the recorded cleanup owner');
select is((select resource_id from public.workspace_resource_operations where id=(select id from deletion_operation)),
  'sandbox-late', 'cleanup identity remains immutable');
select public.settle_workspace_resource_operation((select id from deletion_operation), true);
select is((select count(*) from public.workspace_resource_operations where id=(select id from deletion_operation)), 1::bigint,
  'ownership transfer after fencing retains the reservation');
delete from public.workspace_resource_operations where id=(select id from deletion_operation);
select is(public.finish_workspace_deletion('de100000-0000-4000-8000-000000000001'), false,
  'remaining Storage metadata prevents finalization after sandbox cleanup');
delete from storage.objects where name='de100000-0000-4000-8000-000000000001/retained.png';
select is(public.finish_workspace_deletion('de100000-0000-4000-8000-000000000001'), true,
  'hard deletion succeeds after all durable obligations are removed');
select is((select count(*) from public.workspace_e2b_sandbox_connections
  where workspace_id='de100000-0000-4000-8000-000000000001'), 0::bigint, 'credentials cascade only after cleanup');
select is(public.finish_workspace_deletion('de100000-0000-4000-8000-000000000001'), true,
  'finalization remains idempotent after deletion');

-- Existing real generation RPCs must observe the same fence. This fixture uses
-- the seeded pipeline but all mutations roll back with the test transaction.
insert into public.sessions(id,workspace_id,number,title,prompt_md,creator_member_id,pipeline_id,current_stage_id)
select 'de200000-0000-4000-8000-000000000001', stage.workspace_id, 99003001, 'Deletion generation', 'Test',
  'c1b2c3d4-0001-4000-8000-000000000001',stage.pipeline_id,stage.id
from public.pipeline_stages stage join public.pipelines pipeline on pipeline.id=stage.pipeline_id
where stage.workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and pipeline.is_default and stage.slug='plan';
insert into public.agent_jobs(id,workspace_id,session_id,stage_id,stage_slug,stage_name,trigger_type,status,attempt_count)
select 'de200000-0000-4000-8000-000000000002',s.workspace_id,s.id,s.current_stage_id,'plan','Plan','assignment','running',1
from public.sessions s where s.id='de200000-0000-4000-8000-000000000001';
insert into public.agent_runs(id,workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,model_provider,model_name,run_type)
select 'de200000-0000-4000-8000-000000000003',j.workspace_id,j.session_id,j.id,j.stage_id,j.stage_slug,j.stage_name,'codex','gpt-5.5','project'
from public.agent_jobs j where j.id='de200000-0000-4000-8000-000000000002';
select public.begin_workspace_deletion('b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001', (select name from public.workspaces where id='b1b2c3d4-0001-4000-8000-000000000001'));
select throws_ok($$select public.start_session_job_attempt('de200000-0000-4000-8000-000000000002',1,
  (select current_stage_id from public.sessions where id='de200000-0000-4000-8000-000000000001'),0,'codex','gpt-5.5','project','wallie/test')$$,
  'P0010','Workspace deletion is in progress.','an admitted queue claim cannot start a generation after fencing');
select lives_ok($$select public.cancel_session_job_attempts('de200000-0000-4000-8000-000000000001',
  'b1b2c3d4-0001-4000-8000-000000000001','Workspace deleted.')$$,'cancellation remains permitted after fencing');
select is((select status::text from public.agent_runs where id='de200000-0000-4000-8000-000000000003'),
  'canceled','the owned generation is canceled durably');
select throws_ok($$update public.agent_jobs set status='queued' where id='de200000-0000-4000-8000-000000000002'$$,
  'P0010','Workspace deletion is in progress.','retry cannot revive a canceled job');
select throws_ok($$insert into public.sessions(workspace_id,number,title,prompt_md)
  values('b1b2c3d4-0001-4000-8000-000000000001',99003002,'Late create','Test')$$,
  'P0010','Workspace deletion is in progress.','new sessions cannot bypass the fence');
select * from finish();
rollback;
