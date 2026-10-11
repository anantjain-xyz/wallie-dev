begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
insert into public.workspaces(id,name,slug) values
  ('de300000-0000-4000-8000-000000000001','Deletion admission first','deletion-admission-first'),
  ('de300000-0000-4000-8000-000000000002','Deletion fence first','deletion-fence-first');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  ('de300000-0000-4000-8000-000000000011','de300000-0000-4000-8000-000000000001','a1b2c3d4-0001-4000-8000-000000000001','human','owner'),
  ('de300000-0000-4000-8000-000000000012','de300000-0000-4000-8000-000000000002','a1b2c3d4-0001-4000-8000-000000000001','human','owner');
insert into public.workspace_e2b_sandbox_connections(workspace_id,encrypted_api_key) values
  ('de300000-0000-4000-8000-000000000001','fixture'),('de300000-0000-4000-8000-000000000002','fixture');
commit;
begin;

create function pg_temp.wait_deletion_lock(target_application text) returns void language plpgsql as $$
declare deadline timestamptz := clock_timestamp()+interval '5 seconds';
begin
  while not exists(select 1 from pg_catalog.pg_stat_activity where application_name=target_application and wait_event_type='Lock') loop
    if clock_timestamp()>deadline then raise exception 'Expected lock boundary not reached by %',target_application; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;
select extensions.dblink_connect('deletion_owner',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('deletion_contender',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('deletion_owner','set application_name=''deletion_owner''; set statement_timeout=''15s''');
select extensions.dblink_exec('deletion_contender','set application_name=''deletion_contender''; set statement_timeout=''15s''');

-- An acquisition owns admission before deletion takes the workspace lock.
select extensions.dblink_exec('deletion_owner','begin');
create temp table admitted_operation as select * from extensions.dblink('deletion_owner',$q$
  select public.begin_workspace_resource_operation('de300000-0000-4000-8000-000000000001',
    'sandbox','e2b','','',now()+interval '1 hour',
    (select connection_revision from public.workspace_e2b_sandbox_connections where workspace_id='de300000-0000-4000-8000-000000000001'))
$q$) as result(id uuid);
select extensions.dblink_send_query('deletion_contender',$q$
  select public.begin_workspace_deletion('de300000-0000-4000-8000-000000000001',
    'de300000-0000-4000-8000-000000000011','Deletion admission first')
$q$);
select pg_temp.wait_deletion_lock('deletion_contender');
select ok((select deletion_requested_at is null from public.workspaces where id='de300000-0000-4000-8000-000000000001'),
  'deletion waits until the admitted acquisition commits its cleanup obligation');
select extensions.dblink_exec('deletion_owner','commit');
select * from extensions.dblink_get_result('deletion_contender') as result(requested_at timestamptz);
select count(*) from extensions.dblink_get_result('deletion_contender') as result(requested_at timestamptz);
select is((select count(*) from public.workspace_resource_operations where workspace_id='de300000-0000-4000-8000-000000000001'),
  1::bigint,'admitted acquisition remains recoverable after concurrent deletion');
select is(public.finish_workspace_deletion('de300000-0000-4000-8000-000000000001'),false,
  'the concurrent delete cannot cascade an outstanding acquisition');
select is(public.record_workspace_resource_operation((select id from admitted_operation),'late-concurrent-sandbox'),false,
  'late publication refuses execution after the concurrent deletion commits');
select is((select resource_id from public.workspace_resource_operations where id=(select id from admitted_operation)),
  'late-concurrent-sandbox','late publication retains the sandbox cleanup ID');

-- Deletion owns the workspace lock before another process attempts admission.
select extensions.dblink_exec('deletion_owner','begin');
select * from extensions.dblink('deletion_owner',$q$
  select public.begin_workspace_deletion('de300000-0000-4000-8000-000000000002',
    'de300000-0000-4000-8000-000000000012','Deletion fence first')
$q$) as result(requested_at timestamptz);
select extensions.dblink_send_query('deletion_contender',$q$
  select public.begin_workspace_resource_operation('de300000-0000-4000-8000-000000000002',
    'sandbox','e2b','','',now()+interval '1 hour')
$q$);
select pg_temp.wait_deletion_lock('deletion_contender');
select ok(exists(select 1 from pg_catalog.pg_stat_activity where application_name='deletion_contender' and wait_event_type='Lock'),
  'a racing creator waits for the deletion fence');
select extensions.dblink_exec('deletion_owner','commit');
select is((select count(*) from extensions.dblink_get_result('deletion_contender',false) as result(id uuid)),0::bigint,
  'the creator receives no reservation after deletion wins');
select ok(extensions.dblink_error_message('deletion_contender') like '%Workspace deletion is in progress.%',
  'the creator sees the committed deletion state rather than a stale read');
select is((select count(*) from public.workspace_resource_operations where workspace_id='de300000-0000-4000-8000-000000000002'),
  0::bigint,'the losing admission leaves no remote acquisition obligation');
select extensions.dblink_disconnect('deletion_owner');
select extensions.dblink_disconnect('deletion_contender');
select * from finish();
commit;

-- These committed fixtures have no real provider resources.
begin;
delete from public.workspace_resource_operations where workspace_id in
  ('de300000-0000-4000-8000-000000000001','de300000-0000-4000-8000-000000000002');
select public.finish_workspace_deletion('de300000-0000-4000-8000-000000000001');
select public.finish_workspace_deletion('de300000-0000-4000-8000-000000000002');
commit;
