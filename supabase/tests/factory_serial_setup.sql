begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

insert into auth.users(id, email) values
  ('ba130000-0000-4000-8000-000000000001', 'serial-setup-owner@example.test'),
  ('ba130000-0000-4000-8000-000000000002', 'serial-setup-member@example.test');
insert into public.workspaces(id, slug, name) values
  ('ba130000-1000-4000-8000-000000000001', 'serial-setup-test', 'Setup fixture'),
  ('ba130000-1000-4000-8000-000000000002', 'serial-setup-other', 'Other setup fixture');
insert into public.workspace_members(workspace_id, user_id, kind, role) values
  ('ba130000-1000-4000-8000-000000000001', 'ba130000-0000-4000-8000-000000000001', 'human', 'owner'),
  ('ba130000-1000-4000-8000-000000000001', 'ba130000-0000-4000-8000-000000000002', 'human', 'member'),
  ('ba130000-1000-4000-8000-000000000002', 'ba130000-0000-4000-8000-000000000001', 'human', 'owner');

create temp table setup_scope as
select 'ba130000-1000-4000-8000-000000000001'::uuid as workspace_id,
  'ba130000-0000-4000-8000-000000000001'::uuid as owner_id,
  'ba130000-0000-4000-8000-000000000002'::uuid as member_id,
  (public.create_factory('ba130000-1000-4000-8000-000000000001', 'ba130000-0000-4000-8000-000000000001', 'Docs', 'docs')).id as factory_id;

insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
select ('ba130000-2000-4000-8000-00000000000' || suffix)::uuid, workspace_id, (1301 || suffix)::bigint,
  'https://github.com/settings/installations/1301' || suffix, 1300, 'Organization', 'Fixture', '{}'
from (values
  ('1', 'ba130000-1000-4000-8000-000000000001'::uuid),
  ('2', 'ba130000-1000-4000-8000-000000000002'::uuid)
) fixture(suffix, workspace_id);

insert into public.github_repositories(id, workspace_id, github_installation_id, repo_id, name, full_name, private, html_url, default_branch, is_archived)
select ('ba130000-3000-4000-8000-00000000000' || suffix)::uuid,
  ('ba130000-1000-4000-8000-00000000000' || workspace_suffix)::uuid,
  ('ba130000-2000-4000-8000-00000000000' || workspace_suffix)::uuid,
  (1302 || suffix)::bigint, name, 'fixture/' || name, true, 'https://github.com/fixture/' || name,
  'main', archived
from (values ('1', '1', 'a-default', false), ('2', '1', 'b-spare', false),
  ('3', '1', 'c-in-draft', false), ('4', '1', 'd-archived', true), ('5', '2', 'e-foreign', false)
) fixture(suffix, workspace_suffix, name, archived);

insert into public.pipelines(id, workspace_id, name, is_default) values
  ('ba130000-4000-4000-8000-000000000001', 'ba130000-1000-4000-8000-000000000001', 'Existing pipeline', true);
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name) values
  ('ba130000-5000-4000-8000-000000000001','ba130000-4000-4000-8000-000000000001',
   'ba130000-1000-4000-8000-000000000001',1,'old-stage','Existing stage');
insert into public.workspace_secrets(id, workspace_id, key, encrypted_value) values
  ('ba130000-6000-4000-8000-000000000001','ba130000-1000-4000-8000-000000000001','FIXTURE_ONLY','fixture-ciphertext');

select (
  public.save_factory_definition_draft(
    s.workspace_id, f.id, s.owner_id, 0, d.payload, encode(sha256(convert_to(d.payload, 'UTF8')), 'hex')
  )
).id
from setup_scope s
join public.factories f on f.workspace_id = s.workspace_id and f.is_default
cross join (values ('{"kind":"serial","schemaVersion":1,"pipelineId":"ba130000-4000-4000-8000-000000000001","repositoryId":"ba130000-3000-4000-8000-000000000001","readContextRepositoryIds":["ba130000-3000-4000-8000-000000000003"]}')) d(payload);

grant select on setup_scope to authenticated;
set local role authenticated;
set local request.jwt.claim.sub = 'ba130000-0000-4000-8000-000000000001';
select results_eq(
  $$select r.full_name from setup_scope s
    cross join lateral public.list_factory_setup_repositories(s.workspace_id, s.factory_id) r$$,
  $$values ('fixture/b-spare'::text)$$,
  'an owner sees only unused, live repositories in the same workspace'
);
set local request.jwt.claim.sub = 'ba130000-0000-4000-8000-000000000002';
select is((select count(*) from setup_scope s
  cross join lateral public.list_factory_setup_repositories(s.workspace_id, s.factory_id)), 0::bigint,
  'workspace members cannot read the inventory for a factory they do not manage');
select throws_ok($$select public.provision_factory_serial_setup(
  'ba130000-1000-4000-8000-000000000001', (select factory_id from setup_scope),
  'ba130000-0000-4000-8000-000000000001', 0)$$,
  '42501', 'permission denied for function provision_factory_serial_setup',
  'an authenticated client cannot forge the actor of a provisioning command');
reset role;
set local request.jwt.claim.role = 'service_role';

create function pg_temp.provision(p_repository_id uuid default null, p_expected_activation bigint default 0,
  p_expected_draft uuid default null, p_as_member boolean default false)
returns uuid language sql as $$
  select public.provision_factory_serial_setup(s.workspace_id, s.factory_id,
    case when p_as_member then s.member_id else s.owner_id end, p_expected_activation, p_expected_draft, p_repository_id)
  from setup_scope s;
$$;
select throws_ok($$select pg_temp.provision(p_as_member => true)$$, '42501', null, 'the database also checks the actor role');
select throws_ok($$select pg_temp.provision()$$, 'PT422',
  'Assign a connected repository before creating a pipeline.', 'an empty factory cannot bypass repository setup');
select throws_ok($$select pg_temp.provision('ba130000-3000-4000-8000-000000000001')$$, 'PT409',
  'This repository is already used by the default factory. Choose an unused repository.', 'the existing default repository stays in place');
select throws_ok($$select pg_temp.provision('ba130000-3000-4000-8000-000000000003')$$, 'PT409',
  null, 'an existing draft protects its read-context repository');
select throws_ok($$select pg_temp.provision('ba130000-3000-4000-8000-000000000004')$$, 'P0002',
  null, 'an archived repository cannot be assigned');
select throws_ok($$select pg_temp.provision('ba130000-3000-4000-8000-000000000005')$$, 'P0002',
  null, 'an owner of both workspaces cannot use a cross-workspace repository');
select throws_ok($$select pg_temp.provision('ba130000-3000-4000-8000-000000000006')$$, 'P0002',
  null, 'a nonexistent repository cannot be assigned');
select throws_ok($$select pg_temp.provision('ba130000-3000-4000-8000-000000000002', 1)$$, 'PT409',
  null, 'a stale activation cannot provision a repository');
select throws_ok($$select pg_temp.provision('ba130000-3000-4000-8000-000000000002', 0,
  'ba130000-0000-4000-8000-000000000099')$$, 'PT409',
  'The factory draft changed. Reload before continuing setup.', 'a stale draft cannot provision a repository');

create temp table assignment as select pg_temp.provision('ba130000-3000-4000-8000-000000000002') as id;
select results_eq($$select r.full_name, r.repo_id, r.default_branch from assignment a
  join public.github_repositories r using(id) join setup_scope s using(workspace_id, factory_id)$$,
  $$values ('fixture/b-spare'::text, 13022::bigint, 'main'::text)$$,
  'assignment preserves GitHub identity and creates a factory-scoped row');
select is((select count(*) from public.github_repositories
  where id = 'ba130000-3000-4000-8000-000000000002'), 0::bigint, 'the former scope identity is retired');
insert into public.github_repositories(workspace_id, github_installation_id, repo_id, name, full_name, private, html_url)
values ('ba130000-1000-4000-8000-000000000001', 'ba130000-2000-4000-8000-000000000001', 13022,
  'b-spare', 'fixture/b-spare', true, 'https://github.com/fixture/b-spare')
on conflict (github_installation_id, repo_id) do update set full_name = excluded.full_name;
select is((select r.factory_id from public.github_repositories r join assignment a using(id)),
  (select factory_id from setup_scope), 'GitHub metadata refresh retains the explicit assignment');
select throws_ok($$select pg_temp.provision('ba130000-3000-4000-8000-000000000002')$$, 'P0002',
  null, 'a stale picker cannot assign the old identity again');

create temp table provisioned_pipeline as select pg_temp.provision() as id;
select is((select count(*) from public.pipelines p join provisioned_pipeline k using(id)
  join setup_scope s using(workspace_id, factory_id) where not p.is_default), 1::bigint,
  'the factory receives its own serial pipeline anchor');
select is((select count(*) from public.pipeline_stages ps join provisioned_pipeline p on p.id = ps.pipeline_id),
  0::bigint, 'new stages are authored in a draft rather than copied from the default');
select is((select p.operating_rules_md from public.pipelines p join provisioned_pipeline k using(id)),
  '', 'the new pipeline starts without copied operating rules');
select throws_ok($$select pg_temp.provision()$$, 'PT409',
  'This factory already has a pipeline. Reload to edit it.', 'a stale tab cannot create a duplicate pipeline');
select results_eq($$select p.name, s.name from public.pipelines p join public.pipeline_stages s on s.pipeline_id=p.id
  where p.id='ba130000-4000-4000-8000-000000000001'$$,
  $$values ('Existing pipeline'::text, 'Existing stage'::text)$$, 'the default pipeline and stages are unchanged');
select is((select encrypted_value from public.workspace_secrets where id = 'ba130000-6000-4000-8000-000000000001'),
  'fixture-ciphertext', 'provisioning does not copy or modify workspace or user credentials');
select is((select count(*) from public.factory_execution_grants g join setup_scope s using(workspace_id, factory_id)),
  0::bigint, 'the new factory does not inherit execution authority');
select is((select count(*) from public.factory_members m join setup_scope s using(workspace_id, factory_id)),
  1::bigint, 'provisioning does not add membership grants');
select results_eq($$select a.action from public.factory_audit_events a
  join setup_scope s using(workspace_id, factory_id) where a.action <> 'factory.created' order by a.id$$,
  $$values ('factory.repository_assigned'::text), ('factory.pipeline_created'::text)$$,
  'both setup changes are recorded in the target factory');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'ba130000-0000-4000-8000-000000000002';
select is((select count(*) from public.github_repositories
  where workspace_id = 'ba130000-1000-4000-8000-000000000001' and full_name = 'fixture/b-spare'),
  0::bigint, 'the assigned repository is no longer visible to a default-only member');
reset role;

select * from finish();
rollback;
