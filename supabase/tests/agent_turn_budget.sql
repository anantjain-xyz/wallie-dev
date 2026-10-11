begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';
delete from public.workspace_agent_config where workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and key='max_turns';
select lives_ok($q$insert into public.workspace_agent_config(workspace_id,key,value_json)
  values('b1b2c3d4-0001-4000-8000-000000000001','max_turns','5'::jsonb)$q$, 'default turn budget is writable');
select lives_ok($q$update public.workspace_agent_config set value_json='100'::jsonb
  where workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and key='max_turns'$q$, 'upper turn budget is writable');
select throws_ok(format('update public.workspace_agent_config set value_json=%L::jsonb where workspace_id=%L::uuid and key=''max_turns''',
  value, 'b1b2c3d4-0001-4000-8000-000000000001'), '23514', null::text, 'database rejects invalid budget ' || value)
from (values ('0'),('101'),('1.5'),('"5"'),('null')) invalid(value);
select * from finish();
rollback;
