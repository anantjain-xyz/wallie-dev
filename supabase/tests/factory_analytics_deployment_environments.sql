begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '766bc7d1-9a00-4074-a100-000000000001';

insert into auth.users(id,email) values
  ('766bc7d1-9a00-4074-a100-000000000001','analytics-env-owner@example.test'),
  ('766bc7d1-9a00-4074-a100-000000000002','analytics-env-reader@example.test');
insert into public.workspaces(id,slug,name) values
  ('766bc7d1-9a00-4074-a100-000000000003','analytics-env-fixture','Analytics environment fixture');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  ('766bc7d1-9a00-4074-a100-000000000004','766bc7d1-9a00-4074-a100-000000000003','766bc7d1-9a00-4074-a100-000000000001','human','owner'),
  ('766bc7d1-9a00-4074-a100-000000000005','766bc7d1-9a00-4074-a100-000000000003','766bc7d1-9a00-4074-a100-000000000002','human','member');
create temp table analytics_env_factories as
  select id, workspace_id, slug from public.create_factory(
    '766bc7d1-9a00-4074-a100-000000000003','766bc7d1-9a00-4074-a100-000000000001','Analytics Visible','analytics-visible')
  union all
  select id, workspace_id, slug from public.create_factory(
    '766bc7d1-9a00-4074-a100-000000000003','766bc7d1-9a00-4074-a100-000000000001','Analytics Restricted','analytics-restricted')
  union all
  select id, workspace_id, slug from public.create_factory(
    '766bc7d1-9a00-4074-a100-000000000003','766bc7d1-9a00-4074-a100-000000000001','Analytics Empty','analytics-empty');
select public.grant_factory_membership(workspace_id,id,'766bc7d1-9a00-4074-a100-000000000001','766bc7d1-9a00-4074-a100-000000000005')
from analytics_env_factories where slug <> 'analytics-restricted';
insert into internal.factory_deployments (
  workspace_id, factory_id, repository_id, provider, provider_project_id, environment, external_deployment_id
)
select factory.workspace_id, factory.id, '766bc7d1-9a00-4074-a100-000000000006',
  'fixture', 'fixture', sample.environment, sample.deployment_id
from analytics_env_factories factory
join (values
  ('analytics-visible','production','prod-1'),
  ('analytics-visible','production','prod-2'),
  ('analytics-visible','preview','preview-1'),
  ('analytics-restricted','restricted-environment','private-1')
) sample(slug,environment,deployment_id) using (slug);
grant select on analytics_env_factories to authenticated;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '766bc7d1-9a00-4074-a100-000000000002';
select is(
  (select public.list_factory_analytics_deployment_environments(workspace_id,id)
   from analytics_env_factories where slug = 'analytics-visible'),
  array['preview','production']::text[],
  'Visible factory returns sorted distinct slugs without other factory data'
);
select is(
  (select public.list_factory_analytics_deployment_environments(workspace_id,id)
   from analytics_env_factories where slug = 'analytics-empty'),
  array[]::text[],
  'A visible factory with no deployments returns an empty array'
);
select throws_ok(
  $$select public.list_factory_analytics_deployment_environments(workspace_id,id)
    from analytics_env_factories where slug = 'analytics-restricted'$$,
  'PT404', 'Factory not found.', 'Workspace membership alone does not expose a restricted factory'
);
select ok(
  not has_function_privilege('anon','public.list_factory_analytics_deployment_environments(uuid,uuid)','EXECUTE'),
  'Anonymous callers cannot use the read'
);
reset role;
select * from finish();
rollback;
