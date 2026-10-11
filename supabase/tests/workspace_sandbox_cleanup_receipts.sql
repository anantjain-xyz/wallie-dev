begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

insert into public.workspaces(id,name,slug) values
  ('de500000-0000-4000-8000-000000000001','Receipt fixture','receipt-fixture');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  ('de500000-0000-4000-8000-000000000002','de500000-0000-4000-8000-000000000001',
   'a1b2c3d4-0001-4000-8000-000000000001','human','owner');
insert into public.workspace_e2b_sandbox_connections(workspace_id,encrypted_api_key)
  values ('de500000-0000-4000-8000-000000000001','encrypted-fixture');

select ok(not has_table_privilege('authenticated','public.workspace_sandbox_cleanup_receipts','SELECT'),
  'members cannot read service-owned cleanup receipts');
select ok(not has_table_privilege('authenticated','public.workspace_sandbox_cleanup_receipts','INSERT'),
  'members cannot forge cleanup receipts');
select ok(not has_table_privilege('anon','public.workspace_sandbox_cleanup_receipts','INSERT'),
  'anonymous clients cannot forge cleanup receipts');
set local role service_role;
insert into public.workspace_sandbox_cleanup_receipts(workspace_id,provider,connection_revision,sandbox_id)
  select workspace_id,'e2b',connection_revision,'sandbox-cleaned'
  from public.workspace_e2b_sandbox_connections
  where workspace_id='de500000-0000-4000-8000-000000000001';
select is((select count(*) from public.workspace_sandbox_cleanup_receipts
  where workspace_id='de500000-0000-4000-8000-000000000001' and sandbox_id='sandbox-cleaned'),1::bigint,
  'the service can persist a confirmed provider stop');
select is((select count(*) from public.workspace_sandbox_cleanup_receipts
  where workspace_id='de500000-0000-4000-8000-000000000001' and provider='daytona'),0::bigint,
  'the same identifier under another provider has no receipt');
select is((select count(*) from public.workspace_sandbox_cleanup_receipts
  where workspace_id='de500000-0000-4000-8000-000000000001'
  and connection_revision='de500000-0000-4000-8000-000000000003'),0::bigint,
  'a different credential revision has no receipt');
delete from public.workspace_e2b_sandbox_connections
  where workspace_id='de500000-0000-4000-8000-000000000001';
select is((select count(*) from public.workspace_sandbox_cleanup_receipts
  where workspace_id='de500000-0000-4000-8000-000000000001'),1::bigint,
  'a verified cleanup receipt survives provider disconnect');
select public.begin_workspace_deletion('de500000-0000-4000-8000-000000000001',
  'de500000-0000-4000-8000-000000000002','Receipt fixture');
select is(public.finish_workspace_deletion('de500000-0000-4000-8000-000000000001'),true,
  'receipts do not block finalization after cleanup');
select is((select count(*) from public.workspace_sandbox_cleanup_receipts
  where workspace_id='de500000-0000-4000-8000-000000000001'),0::bigint,
  'workspace finalization removes its audit receipts');
select * from finish();
rollback;
