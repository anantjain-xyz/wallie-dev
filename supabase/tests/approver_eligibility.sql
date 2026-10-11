begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

-- Dedicated fixtures remain visible to independent transactions; final cleanup
-- removes only this namespace and never alters the shared seed workspace.
insert into auth.users(id,email) values
  ('ad110000-0000-4000-8000-000000000001','approver-race@example.com'),
  ('ad110000-0000-4000-8000-000000000002','inactive-approver@example.com');
insert into public.workspaces(id,slug,name) values
  ('ad110000-0000-4000-8000-000000000010','approver-eligibility-fixture','Approver eligibility');
insert into public.workspace_members(id,workspace_id,user_id,kind,role,is_active) values
  ('ad110000-0000-4000-8000-000000000101','ad110000-0000-4000-8000-000000000010','ad110000-0000-4000-8000-000000000001','human','member',true),
  ('ad110000-0000-4000-8000-000000000102','ad110000-0000-4000-8000-000000000010',null,'system','agent',true),
  ('ad110000-0000-4000-8000-000000000103','ad110000-0000-4000-8000-000000000010','ad110000-0000-4000-8000-000000000002','human','member',false);
insert into public.pipelines(id,workspace_id,name,is_default) values
  ('ad110000-0000-4000-8000-000000000020','ad110000-0000-4000-8000-000000000010','Default',true);
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,anyone_can_approve) values
  ('ad110000-0000-4000-8000-000000000030','ad110000-0000-4000-8000-000000000020','ad110000-0000-4000-8000-000000000010',1,'plan','Plan',false);
commit;
begin;

create function pg_temp.approver_payload(member_id uuid) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('id','ad110000-0000-4000-8000-000000000030',
    'slug','plan','name','Plan','approverMemberIds',case when member_id is null then '[]'::jsonb else jsonb_build_array(member_id) end));
$$;
create function pg_temp.wait_approver_lock(application text) returns void language plpgsql as $$
declare deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
  while not exists(select 1 from pg_stat_activity where application_name=application and wait_event_type='Lock') loop
    if clock_timestamp()>deadline then raise exception 'Expected approver lock not reached by %', application; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;

select is(public.rewrite_default_pipeline('ad110000-0000-4000-8000-000000000010','Default',
  pg_temp.approver_payload('ad110000-0000-4000-8000-000000000103'),null)->>'error_code',
  'unknown_approver_member_ids','inactive human approvers are rejected');
select is(public.rewrite_default_pipeline('ad110000-0000-4000-8000-000000000010','Default',
  pg_temp.approver_payload('ad110000-0000-4000-8000-000000000102'),null)->>'error_code',
  'unknown_approver_member_ids','system members cannot be stage approvers');
select is(public.rewrite_default_pipeline('ad110000-0000-4000-8000-000000000010','Default',
  pg_temp.approver_payload('c1b2c3d4-0001-4000-8000-000000000001'),null)->>'error_code',
  'unknown_approver_member_ids','another workspace member cannot be an approver');
select is(public.rewrite_default_pipeline('ad110000-0000-4000-8000-000000000010','Default',
  pg_temp.approver_payload(null),null)->>'ok','true','empty list retains the established owner/admin fallback');
-- Release the locks acquired by validation before exercising remote contenders.
commit;
begin;

select extensions.dblink_connect('approver_editor',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('approver_remover',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('approver_editor','set application_name=''approver_editor''; set statement_timeout=''15s''');
select extensions.dblink_exec('approver_remover','set application_name=''approver_remover''; set statement_timeout=''15s''');

-- Editor wins first. Removal must wait, then prune the committed assignment.
select extensions.dblink_exec('approver_editor','begin');
select is((select result->>'ok' from extensions.dblink('approver_editor',format(
  'select public.rewrite_default_pipeline(%L::uuid,''Default'',%L::jsonb,null)',
  'ad110000-0000-4000-8000-000000000010',pg_temp.approver_payload('ad110000-0000-4000-8000-000000000101')))
  as rewrite(result jsonb)),'true','active human approver can be assigned');
select extensions.dblink_send_query('approver_remover',
  'select id from public.remove_workspace_member(''ad110000-0000-4000-8000-000000000101'',''ad110000-0000-4000-8000-000000000010'')');
select pg_temp.wait_approver_lock('approver_remover');
select ok(exists(select 1 from pg_stat_activity where application_name='approver_remover' and wait_event_type='Lock'),
  'removal waits for the assignment transaction');
select extensions.dblink_exec('approver_editor','commit');
select is((select id from extensions.dblink_get_result('approver_remover') as removed(id uuid)),
  'ad110000-0000-4000-8000-000000000101'::uuid,'waiting removal deactivates the member');
select count(*) from extensions.dblink_get_result('approver_remover') as removed(id uuid);
select is((select approver_member_ids from public.pipeline_stages where id='ad110000-0000-4000-8000-000000000030'),
  '{}'::uuid[],'removal prunes the assignment committed by the winning editor');

-- Removal wins first. A stale editor must revalidate after taking the lock.
update public.workspace_members set is_active=true where id='ad110000-0000-4000-8000-000000000101';
commit;
begin;
select extensions.dblink_exec('approver_remover','begin');
select count(*) from extensions.dblink('approver_remover',
  'select id from public.remove_workspace_member(''ad110000-0000-4000-8000-000000000101'',''ad110000-0000-4000-8000-000000000010'')') as removed(id uuid);
select extensions.dblink_send_query('approver_editor',format(
  'select public.rewrite_default_pipeline(%L::uuid,''Default'',%L::jsonb,null)',
  'ad110000-0000-4000-8000-000000000010',pg_temp.approver_payload('ad110000-0000-4000-8000-000000000101')));
select pg_temp.wait_approver_lock('approver_editor');
select ok(exists(select 1 from pg_stat_activity where application_name='approver_editor' and wait_event_type='Lock'),
  'stale editor waits for member removal');
select extensions.dblink_exec('approver_remover','commit');
select is((select result->>'error_code' from extensions.dblink_get_result('approver_editor') as rewrite(result jsonb)),
  'unknown_approver_member_ids','stale editor cannot restore a removed sole approver');
select count(*) from extensions.dblink_get_result('approver_editor') as rewrite(result jsonb);
select is((select approver_member_ids from public.pipeline_stages where id='ad110000-0000-4000-8000-000000000030'),
  '{}'::uuid[],'both lock orders leave the stage approvable through the default policy');
select extensions.dblink_disconnect('approver_editor');
select extensions.dblink_disconnect('approver_remover');
delete from public.workspaces where id='ad110000-0000-4000-8000-000000000010';
delete from auth.users where id in ('ad110000-0000-4000-8000-000000000001','ad110000-0000-4000-8000-000000000002');
select * from finish();
commit;
