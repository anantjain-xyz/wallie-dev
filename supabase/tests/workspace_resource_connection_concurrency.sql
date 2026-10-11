begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
insert into public.workspaces(id,name,slug) values
  ('de400000-0000-4000-8000-000000000001','Reservation first','reservation-first'),
  ('de400000-0000-4000-8000-000000000002','Rotation first','rotation-first');
insert into public.workspace_e2b_sandbox_connections(workspace_id,encrypted_api_key) values
  ('de400000-0000-4000-8000-000000000001','original-fixture'),
  ('de400000-0000-4000-8000-000000000002','original-fixture');
commit;
begin;
create function pg_temp.wait_resource_lock(target_application text) returns void language plpgsql as $$
declare deadline timestamptz := clock_timestamp()+interval '5 seconds';
begin
  while not exists(select 1 from pg_catalog.pg_stat_activity where application_name=target_application and wait_event_type='Lock') loop
    if clock_timestamp()>deadline then raise exception 'Expected lock boundary not reached by %',target_application; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;
select extensions.dblink_connect('resource_owner',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('resource_contender',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('resource_owner','set application_name=''resource_owner''; set statement_timeout=''15s''');
select extensions.dblink_exec('resource_contender','set application_name=''resource_contender''; set statement_timeout=''15s''');

select extensions.dblink_exec('resource_owner','begin');
select * from extensions.dblink('resource_owner',$q$
  select public.begin_workspace_resource_operation('de400000-0000-4000-8000-000000000001',
    'sandbox','e2b','','',now()+interval '1 hour',
    (select connection_revision from public.workspace_e2b_sandbox_connections where workspace_id='de400000-0000-4000-8000-000000000001'))
$q$) as result(id uuid);
select extensions.dblink_send_query('resource_contender',$q$
  update public.workspace_e2b_sandbox_connections set encrypted_api_key='rotated-fixture'
  where workspace_id='de400000-0000-4000-8000-000000000001'
$q$);
select pg_temp.wait_resource_lock('resource_contender');
select ok(exists(select 1 from pg_catalog.pg_stat_activity where application_name='resource_contender' and wait_event_type='Lock'),
  'credential rotation waits behind admission while the cleanup obligation is uncommitted');
select extensions.dblink_exec('resource_owner','commit');
select count(*) from extensions.dblink_get_result('resource_contender',false) as result(status text);
select ok(extensions.dblink_error_message('resource_contender') like '%Sandbox acquisition cleanup is still pending.%',
  'rotation sees the admitted acquisition and refuses to discard its credentials');
select is((select encrypted_api_key from public.workspace_e2b_sandbox_connections where workspace_id='de400000-0000-4000-8000-000000000001'),
  'original-fixture','the admitted sandbox keeps its exact cleanup credentials');
select count(*) from extensions.dblink_get_result('resource_contender') as result(status text);

create temp table preloaded_connection as select connection_revision from public.workspace_e2b_sandbox_connections
  where workspace_id='de400000-0000-4000-8000-000000000002';
select extensions.dblink_exec('resource_owner','begin');
select extensions.dblink_exec('resource_owner',$q$
  update public.workspace_e2b_sandbox_connections set encrypted_api_key='rotated-fixture'
  where workspace_id='de400000-0000-4000-8000-000000000002'
$q$);
select extensions.dblink_send_query('resource_contender',format($q$
  select public.begin_workspace_resource_operation('de400000-0000-4000-8000-000000000002',
    'sandbox','e2b','','',now()+interval '1 hour',%L::uuid)
$q$,(select connection_revision from preloaded_connection)));
select pg_temp.wait_resource_lock('resource_contender');
select ok(exists(select 1 from pg_catalog.pg_stat_activity where application_name='resource_contender' and wait_event_type='Lock'),
  'a creator with a preloaded connection waits behind the in-flight rotation');
select extensions.dblink_exec('resource_owner','commit');
select is((select count(*) from extensions.dblink_get_result('resource_contender',false) as result(id uuid)),0::bigint,
  'the stale creator receives no permission to provision');
select ok(extensions.dblink_error_message('resource_contender') like '%Sandbox connection changed. Refresh and try again.%',
  'admission validates the connection revision after rotation commits');
select is((select count(*) from public.workspace_resource_operations where workspace_id='de400000-0000-4000-8000-000000000002'),
  0::bigint,'rejected stale credentials cannot create a cleanup obligation for the wrong project');
select extensions.dblink_disconnect('resource_owner');
select extensions.dblink_disconnect('resource_contender');
select * from finish();
commit;

begin;
delete from public.workspace_resource_operations where workspace_id in
  ('de400000-0000-4000-8000-000000000001','de400000-0000-4000-8000-000000000002');
delete from public.workspaces where id in
  ('de400000-0000-4000-8000-000000000001','de400000-0000-4000-8000-000000000002');
commit;
