begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.erasure_id(slot integer) returns uuid language sql immutable as $$
  select ('58810000-0000-4000-8000-' || lpad(slot::text,12,'0'))::uuid
$$;
create function pg_temp.storage_path() returns text language sql immutable as $$
  select pg_temp.erasure_id(2)::text || '/' || pg_temp.erasure_id(7)::text || '/browser/' || pg_temp.erasure_id(8)::text || '.png'
$$;
insert into auth.users(id,email) values (pg_temp.erasure_id(1),'content-erasure-race@example.test');
insert into public.workspaces(id,slug,name) values (pg_temp.erasure_id(2),'content-erasure-race','Content erasure race');
insert into public.workspace_members(id,workspace_id,user_id,kind,role)
values (pg_temp.erasure_id(3),pg_temp.erasure_id(2),pg_temp.erasure_id(1),'human','owner');
insert into public.pipelines(id,workspace_id,factory_id,name)
select pg_temp.erasure_id(4),workspace_id,id,'Erasure test' from public.factories
where workspace_id=pg_temp.erasure_id(2) and is_default;
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name)
values (pg_temp.erasure_id(5),pg_temp.erasure_id(4),pg_temp.erasure_id(2),1,'erase','Erasure test');
insert into public.sessions(id,number,workspace_id,factory_id,creator_member_id,pipeline_id,current_stage_id,title,prompt_md,archived_at)
select pg_temp.erasure_id(6),1,workspace_id,id,pg_temp.erasure_id(3),pg_temp.erasure_id(4),pg_temp.erasure_id(5),
  'Archived scope','Synthetic request','2026-01-01T00:00:00Z'
from public.factories where workspace_id=pg_temp.erasure_id(2) and is_default;
insert into public.agent_runs(id,workspace_id,session_id,run_type,model_provider,model_name,status,attempt_count)
values (pg_temp.erasure_id(7),pg_temp.erasure_id(2),pg_temp.erasure_id(6),'project','codex','fixture','error',1);
select public.begin_workspace_resource_operation(pg_temp.erasure_id(2),'upload','',pg_temp.storage_path(),
  'session-validation-evidence',clock_timestamp()+interval '5 min');
insert into storage.objects(bucket_id,name,metadata)
values ('session-validation-evidence',pg_temp.storage_path(),'{"mimetype":"image/png"}');
commit;

begin;
select extensions.dblink_connect('retained_erase',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('retained_late_upload',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('retained_erase',$sql$
  set application_name='retained_erase'; set statement_timeout='15 s';
  set request.jwt.claim.role='authenticated';
  set request.jwt.claim.sub='58810000-0000-4000-8000-000000000001';
$sql$);
select extensions.dblink_exec('retained_late_upload',$sql$
  set application_name='retained_late_upload'; set statement_timeout='15 s'; set request.jwt.claim.role='service_role';
$sql$);

create function pg_temp.erase_race_scope() returns uuid language sql as $$
  select erased.session_id
  from public.sessions session cross join lateral public.erase_session_retained_content(
    session.workspace_id,session.factory_id,session.id,session.archived_at) erased
  where session.id=pg_temp.erasure_id(6)
$$;
select extensions.dblink_exec('retained_late_upload','begin');
select * from extensions.dblink('retained_late_upload',format(
  'select id from public.sessions where id=%L for no key update',pg_temp.erasure_id(6))) as locked(id uuid);
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='58810000-0000-4000-8000-000000000001';
set local statement_timeout='3 s';
select throws_ok($$select pg_temp.erase_race_scope()$$,'PT409',
  'Session activity changed. Retry retained content erasure.',
  'a legacy session-first holder receives a prompt retryable response instead of a workspace/session deadlock');
set local statement_timeout='0';
set local request.jwt.claim.role='service_role';
select extensions.dblink_exec('retained_late_upload','commit');

select extensions.dblink_exec('retained_erase','begin');
select is((select id from extensions.dblink('retained_erase',format(
  'select (public.erase_session_retained_content(workspace_id,factory_id,id,archived_at)).session_id
     from public.sessions where id=%L',pg_temp.erasure_id(6))) result(id uuid)),pg_temp.erasure_id(6),
  'a retry acquires the now-free session and records the exact erasure');
select is(extensions.dblink_send_query('retained_late_upload',format(
  'update storage.objects set metadata=%L where bucket_id=%L and name=%L returning name',
  '{"mimetype":"image/png","size":99}', 'session-validation-evidence', pg_temp.storage_path())),1,
  'late upload finalization starts while the erasure owns the workspace fence');

create function pg_temp.wait_erasure_upload_lock() returns void language plpgsql as $$
declare deadline timestamptz := clock_timestamp()+interval '5 seconds';
begin
  while not exists(select 1 from pg_stat_activity
    where application_name='retained_late_upload' and wait_event_type='Lock') loop
    if clock_timestamp()>deadline then raise exception 'Late upload did not reach the workspace fence'; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;
select pg_temp.wait_erasure_upload_lock();
select extensions.dblink_exec('retained_erase','commit');
select is((select count(*) from extensions.dblink_get_result('retained_late_upload',false) as result(name text)),0::bigint,
  'after the competing erasure commits the previously started update does not finalize bytes');
select matches(extensions.dblink_error_message('retained_late_upload'),'Browser media content has been erased',
  'late finalize rechecks the marker after waiting on the workspace');
select ok((select metadata->>'size' is null from storage.objects
  where bucket_id='session-validation-evidence' and name=pg_temp.storage_path()),
  'the only remaining provisional row belongs to cleanup, never to a captured asset');
select extensions.dblink_disconnect('retained_late_upload');
select extensions.dblink_disconnect('retained_erase');

select * from finish();
-- Synthetic Storage metadata is the only storage resource created in this test.
set local storage.allow_delete_query='true';
delete from storage.objects where bucket_id='session-validation-evidence' and name=pg_temp.storage_path();
delete from public.workspaces where id=pg_temp.erasure_id(2);
delete from auth.users where id=pg_temp.erasure_id(1);
commit;
