begin;

create extension if not exists pgtap with schema extensions;

select plan(5);
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

update public.workspace_linear_routing
set land_stage_slug = null
where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001';

create temp table manual_merge_session as
select *
from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'Manual merge approval proof',
  'Keep the approved Build session open until Linear Done.',
  'codex',
  'gpt-5.5',
  'linear-manual-merge-proof',
  'https://linear.app/example/issue/OP-TEST',
  null,
  'd1b2c3d4-0001-4000-8000-000000000001',
  array[
    (
      select id
      from public.pipeline_stages
      where pipeline_id = 'd1b2c3d4-0001-4000-8000-000000000001'
        and slug = 'build'
    )
  ]
);

update public.sessions session
set phase_status = 'awaiting_review', current_artifact_version = 1
from manual_merge_session created
where session.id = created.session_id;

create temp table manual_merge_approval as
select approved.*
from manual_merge_session created
cross join lateral public.approve_session_stage(
  created.session_id,
  'b1b2c3d4-0001-4000-8000-000000000001',
  1,
  'c1b2c3d4-0001-4000-8000-000000000001'
) approved;

select ok(
  (
    select phase_status = 'approved' and archived_at is null
    from manual_merge_approval
  ),
  'linked terminal approval stays open while waiting for a manual merge'
);

select * from finish();
rollback;
