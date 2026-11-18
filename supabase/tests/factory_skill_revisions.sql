begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

insert into auth.users(id, email) values
  ('55300000-0000-4000-8000-000000000001', 'skills-owner@example.test'),
  ('55300000-0000-4000-8000-000000000002', 'skills-member@example.test');
insert into public.workspaces(id, slug, name) values
  ('55300000-1000-4000-8000-000000000001', 'skill-revision-fixture', 'Skill revision fixture'),
  ('55300000-1000-4000-8000-000000000002', 'skill-other-workspace', 'Other skill workspace');
insert into public.workspace_members(workspace_id, user_id, kind, role) values
  ('55300000-1000-4000-8000-000000000001', '55300000-0000-4000-8000-000000000001', 'human', 'owner'),
  ('55300000-1000-4000-8000-000000000001', '55300000-0000-4000-8000-000000000002', 'human', 'member');
insert into public.factories(id, workspace_id, name, slug, is_default) values
  ('55300000-2000-4000-8000-000000000001', '55300000-1000-4000-8000-000000000001', 'Separate skill factory', 'restricted', false);

create temporary table skill_fixture(key text primary key, id uuid not null);
insert into skill_fixture select 'factory', id from public.factories
where workspace_id = '55300000-1000-4000-8000-000000000001' and is_default;
insert into skill_fixture select 'other_factory', id from public.factories
where workspace_id = '55300000-1000-4000-8000-000000000002' and is_default;

select is((select count(*) from public.factory_skill_revisions
  where factory_id = (select id from skill_fixture where key = 'factory')
    and source_kind = 'wallie_builtin' and revision_number = 1), 7::bigint,
  'a newly provisioned factory receives all seven onboarding skills');
select ok(not has_table_privilege('authenticated', 'public.factory_skills', 'INSERT')
  and not has_table_privilege('service_role', 'public.factory_skill_revisions', 'UPDATE'),
  'registry writes require scoped mutation RPCs');
select ok(not has_function_privilege('authenticated',
  'public.create_factory_skill(uuid,uuid,uuid,text,text,text,text,text)', 'EXECUTE'),
  'authenticated clients cannot assert a trusted factory skill directly');

insert into skill_fixture select 'manual', id from public.create_factory_skill(
  '55300000-1000-4000-8000-000000000001', (select id from skill_fixture where key = 'factory'),
  '55300000-0000-4000-8000-000000000001', 'Test procedure', 'test-procedure', 'Use the existing smoke tests.');
insert into skill_fixture select 'skill', skill_id from public.factory_skill_revisions
where id = (select id from skill_fixture where key = 'manual');
select is((select content_sha256 from public.factory_skill_revisions
  where id = (select id from skill_fixture where key = 'manual')),
  encode(sha256(convert_to('Use the existing smoke tests.', 'UTF8')), 'hex'),
  'a manager-authored skill retains the digest of its exact bytes');
select throws_ok($sql$select public.create_factory_skill(
  '55300000-1000-4000-8000-000000000001', (select id from skill_fixture where key = 'factory'),
  '55300000-0000-4000-8000-000000000002', 'Unapproved', 'unapproved', 'Unapproved instructions')$sql$,
  '42501', 'Factory manager access is required.', 'a regular member cannot register trusted instructions');
select throws_ok($sql$select public.create_factory_skill(
  '55300000-1000-4000-8000-000000000001', (select id from skill_fixture where key = 'factory'),
  '55300000-0000-4000-8000-000000000001', 'Forged trust', 'forged-trust', 'Custom bytes',
  'wallie_builtin', 'wallie-onboarding/v5/.agents/skills/commit/SKILL.md')$sql$,
  'PT422', 'Provide manual or repository skill content.', 'only fixed provisioning can register Wallie built-ins');

insert into public.github_installations(
  id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions
) values ('55300000-3000-4000-8000-000000000001', '55300000-1000-4000-8000-000000000001',
  55300001, 'https://github.com/installations/55300001', 5530, 'Organization', 'Fixture', '{}');
insert into public.github_repositories(
  id, workspace_id, github_installation_id, repo_id, name, full_name, private, html_url, default_branch
) values ('55300000-4000-4000-8000-000000000001', '55300000-1000-4000-8000-000000000001',
  '55300000-3000-4000-8000-000000000001', 55300011, 'skill-fixture', 'fixture/skill-fixture', true,
  'https://github.com/fixture/skill-fixture', 'main');
insert into skill_fixture select 'repository', id from public.create_factory_skill(
  '55300000-1000-4000-8000-000000000001', (select id from skill_fixture where key = 'factory'),
  '55300000-0000-4000-8000-000000000001', 'Declared repository skill', 'repository-skill', 'Text from the repository.',
  'repository', '55300000-4000-4000-8000-000000000001@' || repeat('a', 40) || ':skills/test.md');
select is((select source_ref from public.factory_skill_revisions
  where id = (select id from skill_fixture where key = 'repository')),
  '55300000-4000-4000-8000-000000000001@' || repeat('a', 40) || ':skills/test.md',
  'repository Markdown retains its declared repository, commit, and file path');
select throws_ok($sql$select public.create_factory_skill(
  '55300000-1000-4000-8000-000000000001', '55300000-2000-4000-8000-000000000001',
  '55300000-0000-4000-8000-000000000001', 'Foreign source', 'foreign-source', 'Text',
  'repository', '55300000-4000-4000-8000-000000000001@' || repeat('a', 40) || ':skills/test.md')$sql$,
  'PT422', 'The source repository is unavailable in this factory.', 'repository provenance cannot cross factories');

create function pg_temp.save_skill_candidate(p_skill_ids jsonb) returns uuid language sql as $$
  select (public.save_factory_definition_draft(
    '55300000-1000-4000-8000-000000000001', (select id from skill_fixture where key = 'factory'),
    '55300000-0000-4000-8000-000000000001', 0,
    candidate.definition, encode(sha256(convert_to(candidate.definition, 'UTF8')), 'hex'))).id
  from (select jsonb_build_object('schemaVersion', 1, 'kind', 'serial', 'skillIds', p_skill_ids)::text as definition) candidate;
$$;

select lives_ok($sql$select pg_temp.save_skill_candidate(jsonb_build_array(
  (select id from skill_fixture where key = 'manual'), (select id from skill_fixture where key = 'repository')))$sql$,
  'the same-factory trusted instructions and repository context can both be pinned');
select throws_ok($sql$select pg_temp.save_skill_candidate('["mutable-alias"]')$sql$,
  'PT422', 'Select exact skill revision IDs.', 'a definition cannot select a mutable alias');
select throws_ok($sql$select pg_temp.save_skill_candidate(jsonb_build_array(gen_random_uuid()))$sql$,
  'PT422', 'A selected skill revision is missing, revoked, or unavailable in this factory.',
  'a definition cannot select an unknown revision');
select throws_ok($sql$select pg_temp.save_skill_candidate(jsonb_build_array((select id
  from public.factory_skill_revisions
  where factory_id = '55300000-2000-4000-8000-000000000001' limit 1)))$sql$,
  'PT422', 'A selected skill revision is missing, revoked, or unavailable in this factory.',
  'a definition cannot select a revision in another factory');
select throws_ok($sql$select pg_temp.save_skill_candidate(jsonb_build_array((select id
  from public.factory_skill_revisions
  where factory_id = (select id from skill_fixture where key = 'other_factory') limit 1)))$sql$,
  'PT422', 'A selected skill revision is missing, revoked, or unavailable in this factory.',
  'a definition cannot select a revision in another workspace');
select throws_ok($sql$select pg_temp.save_skill_candidate((select jsonb_agg(gen_random_uuid())
  from generate_series(1, 21)))$sql$,
  'PT422', 'Select at most 20 skill revisions.', 'a definition cannot bypass the skill bundle bound');

insert into public.pipelines(id, workspace_id, name) values
  ('55300000-5000-4000-8000-000000000001', '55300000-1000-4000-8000-000000000001', 'Skill pipeline');
insert into public.pipeline_stages(id, workspace_id, pipeline_id, slug, name, position) values
  ('55300000-6000-4000-8000-000000000001', '55300000-1000-4000-8000-000000000001',
    '55300000-5000-4000-8000-000000000001', 'inspect', 'Inspect', 1);
insert into public.factory_definition_revisions(
  id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
)
select '55300000-7000-4000-8000-000000000001', '55300000-1000-4000-8000-000000000001',
  (select id from skill_fixture where key = 'factory'), 1, definition,
  encode(sha256(convert_to(definition, 'UTF8')), 'hex'), '55300000-0000-4000-8000-000000000001'
from (select jsonb_build_object('schemaVersion', 1, 'kind', 'serial',
  'pipelineId', '55300000-5000-4000-8000-000000000001',
  'skillIds', jsonb_build_array((select id from skill_fixture where key = 'manual')))::text as definition) candidate;

create function pg_temp.admit_skill_session(p_number integer) returns uuid language sql as $$
  insert into public.sessions(workspace_id, number, title, pipeline_id, current_stage_id,
    factory_definition_provenance, factory_definition_revision_id, execute_pinned_definition) values
    ('55300000-1000-4000-8000-000000000001', p_number, 'Pinned skill execution',
      '55300000-5000-4000-8000-000000000001', '55300000-6000-4000-8000-000000000001',
      'pinned', '55300000-7000-4000-8000-000000000001', true)
  returning id;
$$;
insert into skill_fixture select 'session', pg_temp.admit_skill_session(1);
insert into skill_fixture select 'newer', id from public.save_factory_skill_revision(
  '55300000-1000-4000-8000-000000000001', (select id from skill_fixture where key = 'factory'),
  '55300000-0000-4000-8000-000000000001', (select id from skill_fixture where key = 'skill'),
  1, 'Run the full validation suite.');
select is((select revision_number from public.factory_skill_revisions
  where id = (select id from skill_fixture where key = 'newer')), 2,
  'editing skill content appends a new revision');
select throws_ok($sql$select public.save_factory_skill_revision(
  '55300000-1000-4000-8000-000000000001', (select id from skill_fixture where key = 'factory'),
  '55300000-0000-4000-8000-000000000001', (select id from skill_fixture where key = 'skill'),
  1, 'Stale editor')$sql$, 'PT409', 'The skill changed. Reload its revision before saving.',
  'a stale editor cannot append against an old revision number');
select lives_ok($sql$select pg_temp.admit_skill_session(2)$sql$,
  'appending a revision does not replace the selected existing revision for admission');
select throws_ok($sql$update public.factory_skill_revisions set source_kind = 'repository'
  where id = (select id from skill_fixture where key = 'manual')$sql$,
  '23514', 'Skill identities and revision content are immutable.', 'revision source cannot be rewritten');

select public.revoke_factory_skill_revision(
  '55300000-1000-4000-8000-000000000001', (select id from skill_fixture where key = 'factory'),
  '55300000-0000-4000-8000-000000000001', (select id from skill_fixture where key = 'skill'),
  (select id from skill_fixture where key = 'manual'));
select throws_ok($sql$select pg_temp.admit_skill_session(3)$sql$,
  'PT422', 'A selected skill revision is missing, revoked, or unavailable in this factory.',
  'new admission fails clearly for the revoked selected revision');
select throws_ok($sql$select pg_temp.save_skill_candidate(jsonb_build_array(
  (select id from skill_fixture where key = 'manual')))$sql$,
  'PT422', 'A selected skill revision is missing, revoked, or unavailable in this factory.',
  'a revoked revision cannot enter a new draft');
select lives_ok($sql$select pg_temp.save_skill_candidate(jsonb_build_array(
  (select id from skill_fixture where key = 'newer')))$sql$,
  'an unrevoked newer revision remains eligible for future activation');
select is((select internal.pinned_session_execution_definition(session)->'skillIds'
  from public.sessions session where id = (select id from skill_fixture where key = 'session')),
  jsonb_build_array((select id from skill_fixture where key = 'manual')),
  'the admitted session retains its previously selected revision after revocation');
select is((select content_md from public.factory_skill_revisions
  where id = (select id from skill_fixture where key = 'manual')),
  'Use the existing smoke tests.', 'the revoked original bytes remain available for admitted retry');
select is((select count(*) from public.factory_audit_events
  where workspace_id = '55300000-1000-4000-8000-000000000001' and action = 'skill.revision_revoked'),
  1::bigint, 'revocation is audited');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '55300000-0000-4000-8000-000000000002';
select is((select count(*) from public.factory_skills), 9::bigint,
  'member reads only permitted factory identities');
select is((select count(*) from public.factory_skill_revisions), 10::bigint,
  'revision history is isolated by factory membership and workspace');

select * from finish();
rollback;
