begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users(id, email) values
  ('55100000-0000-4000-8000-000000000001', 'factory-scope-owner@example.test'),
  ('55100000-0000-4000-8000-000000000002', 'factory-scope-reader@example.test');
insert into public.workspaces(id, slug, name) values
  ('55100000-1000-4000-8000-000000000001', 'factory-candidate-scope-test', 'Factory candidate scope');
insert into public.workspace_members(workspace_id, user_id, kind, role) values
  ('55100000-1000-4000-8000-000000000001', '55100000-0000-4000-8000-000000000001', 'human', 'owner'),
  ('55100000-1000-4000-8000-000000000001', '55100000-0000-4000-8000-000000000002', 'human', 'member');
insert into public.factories(id, workspace_id, name, slug, is_default) values
  ('55100000-2000-4000-8000-000000000002', '55100000-1000-4000-8000-000000000001', 'Sibling', 'sibling', false);

insert into public.github_installations(id, workspace_id, installation_id, installation_url,
  app_id, target_type, target_name, permissions) values
  ('55100000-3000-4000-8000-000000000001', '55100000-1000-4000-8000-000000000001',
    55100001, 'https://github.com/settings/installations/55100001', 55100, 'Organization', 'fixture', '{}');
insert into public.pipelines(id, workspace_id, name) values
  ('55100000-4000-4000-8000-000000000001', '55100000-1000-4000-8000-000000000001', 'Default fixture');
insert into public.pipelines(id, workspace_id, factory_id, name) values
  ('55100000-4000-4000-8000-000000000002', '55100000-1000-4000-8000-000000000001',
    '55100000-2000-4000-8000-000000000002', 'Sibling fixture');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id,
  repo_id, name, full_name, private, html_url) values
  ('55100000-5000-4000-8000-000000000001', '55100000-1000-4000-8000-000000000001', null,
    '55100000-3000-4000-8000-000000000001', 551001, 'default', 'fixture/default', true, 'https://github.com/fixture/default'),
  ('55100000-5000-4000-8000-000000000002', '55100000-1000-4000-8000-000000000001',
    '55100000-2000-4000-8000-000000000002', '55100000-3000-4000-8000-000000000001',
    551002, 'sibling', 'fixture/sibling', true, 'https://github.com/fixture/sibling');

create function pg_temp.save_fixture_candidate(p_pipeline_id uuid, p_repository_id uuid)
returns uuid language sql as $$
  select (public.save_factory_definition_draft(
    factory.workspace_id, factory.id, '55100000-0000-4000-8000-000000000001', 0,
    candidate.definition, encode(sha256(convert_to(candidate.definition, 'UTF8')), 'hex'))).id
  from public.factories factory
  cross join lateral (select jsonb_build_object('schemaVersion',1,'kind','serial',
    'pipelineId',p_pipeline_id,'repositoryId',p_repository_id)::text as definition) candidate
  where factory.workspace_id = '55100000-1000-4000-8000-000000000001' and factory.is_default;
$$;
select lives_ok($$select pg_temp.save_fixture_candidate(
  '55100000-4000-4000-8000-000000000001', '55100000-5000-4000-8000-000000000001')$$,
  'a saved candidate can use its own pipeline and repository');
select throws_ok($$select pg_temp.save_fixture_candidate(
  '55100000-4000-4000-8000-000000000002', '55100000-5000-4000-8000-000000000001')$$,
  'PT422', 'The definition pipeline is outside the factory scope.', 'draft storage enforces pipeline ownership');
select throws_ok($$select pg_temp.save_fixture_candidate(
  '55100000-4000-4000-8000-000000000001', '55100000-5000-4000-8000-000000000002')$$,
  'PT422', 'The definition repository is outside the factory scope.', 'draft storage enforces repository ownership');

insert into public.repository_onboarding_status(workspace_id, github_repository_id)
select workspace_id, id from public.github_repositories
where workspace_id = '55100000-1000-4000-8000-000000000001';
insert into public.workspace_repository_profiles(workspace_id, github_repository_id, is_primary)
select workspace_id, id, false from public.github_repositories
where workspace_id = '55100000-1000-4000-8000-000000000001';
insert into public.sandbox_capability_checks(workspace_id, github_repository_id)
select workspace_id, id from public.github_repositories
where workspace_id = '55100000-1000-4000-8000-000000000001';

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '55100000-0000-4000-8000-000000000002';
select results_eq($$select github_repository_id from public.repository_onboarding_status
  where workspace_id = '55100000-1000-4000-8000-000000000001'$$,
  $$values ('55100000-5000-4000-8000-000000000001'::uuid)$$,
  'a factory member reads onboarding status only for accessible repositories');
select results_eq($$select github_repository_id from public.workspace_repository_profiles
  where workspace_id = '55100000-1000-4000-8000-000000000001'$$,
  $$values ('55100000-5000-4000-8000-000000000001'::uuid)$$,
  'a factory member reads profiles only for accessible repositories');
select results_eq($$select github_repository_id from public.sandbox_capability_checks
  where workspace_id = '55100000-1000-4000-8000-000000000001'$$,
  $$values ('55100000-5000-4000-8000-000000000001'::uuid)$$,
  'a factory member reads live capability checks only for accessible repositories');
set local request.jwt.claim.sub = '55100000-0000-4000-8000-000000000001';
select is((select count(*) from public.workspace_repository_profiles
  where workspace_id = '55100000-1000-4000-8000-000000000001'), 2::bigint,
  'workspace operators retain visibility over every factory profile');
reset role;

-- Retain the old snapshot while the referenced repository is unavailable.
-- The activation transaction must recheck ownership if that identity reappears.
insert into public.factory_definition_revisions(
  id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
)
select '55100000-6000-4000-8000-000000000001', factory.workspace_id, factory.id, 1,
  candidate.definition, encode(sha256(convert_to(candidate.definition, 'UTF8')), 'hex'),
  '55100000-0000-4000-8000-000000000001'
from public.factories factory
cross join lateral (select jsonb_build_object('schemaVersion',1,'kind','serial',
  'pipelineId','55100000-4000-4000-8000-000000000001',
  'repositoryId','55100000-5000-4000-8000-000000000003')::text as definition) candidate
where factory.workspace_id = '55100000-1000-4000-8000-000000000001' and factory.is_default;
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id,
  repo_id, name, full_name, private, html_url) values
  ('55100000-5000-4000-8000-000000000003', '55100000-1000-4000-8000-000000000001',
    '55100000-2000-4000-8000-000000000002', '55100000-3000-4000-8000-000000000001',
    551003, 'restored', 'fixture/restored', true, 'https://github.com/fixture/restored');
select throws_ok($$insert into public.factory_definition_activations(
  workspace_id, factory_id, revision_id, activation_number, created_by
) select factory.workspace_id, factory.id, '55100000-6000-4000-8000-000000000001',
  1, '55100000-0000-4000-8000-000000000001'
from public.factories factory
where factory.workspace_id = '55100000-1000-4000-8000-000000000001' and factory.is_default$$,
  'PT422', 'The definition repository is outside the factory scope.',
  'an activation cannot append a snapshot with a repository outside its factory');

select * from finish();
rollback;
