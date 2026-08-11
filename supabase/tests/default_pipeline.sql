begin;

create extension if not exists pgtap with schema extensions;

select plan(4);
set local "request.jwt.claim.role" = 'service_role';

select results_eq(
  $$
    select stage_position, slug
    from internal.default_pipeline_stages()
    order by stage_position
  $$,
  $$ values (1, 'plan'::text), (2, 'build'::text) $$,
  'new workspaces inherit the two-stage plan and build default'
);

select is(
  (
    select is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'workspace_linear_routing'
      and column_name = 'land_stage_slug'
  ),
  'YES',
  'land stage routing is optional'
);

select ok(
  (
    select column_default is null
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'workspace_linear_routing'
      and column_name = 'land_stage_slug'
  ),
  'new routing rows default to manual merge'
);

insert into public.workspaces (id, slug, name)
values ('f1b2c3d4-0001-4000-8000-000000000001', 'manual-merge-proof', 'Manual merge proof');

select is(
  (
    select land_stage_slug
    from public.workspace_linear_routing
    where workspace_id = 'f1b2c3d4-0001-4000-8000-000000000001'
  ),
  null::text,
  'workspace routing trigger creates a manual-merge route'
);

select * from finish();
rollback;
