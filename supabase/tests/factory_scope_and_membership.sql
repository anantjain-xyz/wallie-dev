begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local role service_role;

-- The seeded workspace predates this migration. Every existing resource must
-- have been adopted by exactly its workspace default factory.
select is(
  (select count(*) from public.pipelines pipeline
    join public.factories factory
      on factory.workspace_id = pipeline.workspace_id and factory.id = pipeline.factory_id
    where factory.is_default),
  (select count(*) from public.pipelines),
  'every seeded pipeline belongs to a default factory in its workspace'
);
select is(
  (select count(*) from public.github_repositories repository
    join public.factories factory
      on factory.workspace_id = repository.workspace_id and factory.id = repository.factory_id
    where factory.is_default),
  (select count(*) from public.github_repositories),
  'every seeded repository belongs to a default factory in its workspace'
);
select is(
  (select count(*) from public.sessions session
    join public.factories factory
      on factory.workspace_id = session.workspace_id and factory.id = session.factory_id
    where factory.is_default),
  (select count(*) from public.sessions),
  'every seeded session belongs to a default factory in its workspace'
);
select is(
  (select count(*) from public.factories factory
    where factory.is_default and (factory.name <> 'Default factory' or factory.slug <> 'default')),
  0::bigint,
  'default factories receive the stable name and slug'
);

insert into public.workspaces(id, slug, name) values
  ('55000000-0000-4000-8000-000000000001', 'factory-scope-primary', 'Factory scope primary'),
  ('55000000-0000-4000-8000-000000000002', 'factory-scope-foreign', 'Factory scope foreign');
reset role;
insert into auth.users(id, email) values
  ('b1b2c3d4-0001-4000-8000-000000000001', 'scope-owner@example.test'),
  ('b1b2c3d4-0002-4000-8000-000000000002', 'scope-member@example.test'),
  ('b1b2c3d4-0003-4000-8000-000000000003', 'scope-single@example.test'),
  ('b1b2c3d4-0004-4000-8000-000000000004', 'scope-foreign@example.test'),
  ('b1b2c3d4-0005-4000-8000-000000000005', 'scope-reactivated@example.test');
set local role service_role;
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  ('c1b2c3d4-1000-4000-8000-000000000001', '55000000-0000-4000-8000-000000000001',
    'b1b2c3d4-0001-4000-8000-000000000001', 'human', 'owner'),
  ('c1b2c3d4-1000-4000-8000-000000000002', '55000000-0000-4000-8000-000000000001',
    'b1b2c3d4-0002-4000-8000-000000000002', 'human', 'member'),
  ('c1b2c3d4-1000-4000-8000-000000000003', '55000000-0000-4000-8000-000000000001',
    'b1b2c3d4-0003-4000-8000-000000000003', 'human', 'member'),
  ('c1b2c3d4-1000-4000-8000-000000000004', '55000000-0000-4000-8000-000000000002',
    'b1b2c3d4-0004-4000-8000-000000000004', 'human', 'owner');
insert into public.workspace_members(id, workspace_id, user_id, kind, role, is_active) values
  ('c1b2c3d4-1000-4000-8000-000000000005', '55000000-0000-4000-8000-000000000001',
    'b1b2c3d4-0005-4000-8000-000000000005', 'human', 'member', false);
set local role service_role;

select is(
  (select count(*) from public.factories factory
    join public.factory_members member
      on member.workspace_id = factory.workspace_id and member.factory_id = factory.id
    where factory.workspace_id = '55000000-0000-4000-8000-000000000001'
      and factory.is_default and member.revoked_at is null),
  3::bigint,
  'existing workspace members inherit the default factory'
);
select is(
  (select role from public.factory_members member
    where member.member_id = (
      select id from public.workspace_members
      where workspace_id = '55000000-0000-4000-8000-000000000001'
        and user_id = 'b1b2c3d4-0001-4000-8000-000000000001'
    )),
  'member',
  'default-factory inheritance creates only an ordinary grant for a workspace owner'
);
select is(
  (select role from public.read_factory_scope(
    '55000000-0000-4000-8000-000000000001', 'b1b2c3d4-0001-4000-8000-000000000001'
  ) where is_default),
  'manager',
  'the workspace owner receives effective factory manager authority from the workspace role'
);

select is(
  (select count(*) from public.factory_members
    where workspace_id = '55000000-0000-4000-8000-000000000001'
      and member_id = 'c1b2c3d4-1000-4000-8000-000000000005'),
  0::bigint,
  'an inactive member does not inherit the default factory'
);
update public.workspace_members set is_active = true
where id = 'c1b2c3d4-1000-4000-8000-000000000005';
select is(
  (select member.role from public.factory_members member
    join public.factories factory on factory.id = member.factory_id and factory.workspace_id = member.workspace_id
    where member.member_id = 'c1b2c3d4-1000-4000-8000-000000000005'
      and factory.is_default and member.revoked_at is null),
  'member',
  'reactivating a legacy workspace member repairs the inherited default grant'
);
select is(
  (select count(*) from public.factory_audit_events
    where workspace_id = '55000000-0000-4000-8000-000000000001'
      and subject_member_id = 'c1b2c3d4-1000-4000-8000-000000000005'
      and action = 'membership.granted'
      and detail ->> 'source' = 'default_factory_reactivation'),
  1::bigint,
  'the repaired inherited grant is audited'
);

-- Factory lifecycle is an audited operator action. The creator becomes manager.
select lives_ok($$select public.create_factory(
  '55000000-0000-4000-8000-000000000001',
  'b1b2c3d4-0001-4000-8000-000000000001',
  'Payments', 'payments')$$,
  'a workspace manager can create a second factory');
select is(
  (select count(*) from public.factory_audit_events event
    where event.workspace_id = '55000000-0000-4000-8000-000000000001'
      and event.action = 'factory.created'),
  1::bigint,
  'factory creation records an audit event'
);
select is(
  (select member.role from public.factory_members member
    join public.factories factory on factory.id = member.factory_id and factory.workspace_id = member.workspace_id
    where factory.workspace_id = '55000000-0000-4000-8000-000000000001'
      and factory.slug = 'payments'
      and member.member_id = (
        select id from public.workspace_members
        where workspace_id = '55000000-0000-4000-8000-000000000001'
          and user_id = 'b1b2c3d4-0001-4000-8000-000000000001'
      )),
  'manager',
  'the factory creator is recorded as a manager'
);

create temp table scope_fixtures as
select factory.slug, factory.id as factory_id, factory.workspace_id
from public.factories factory
where factory.workspace_id = '55000000-0000-4000-8000-000000000001';
grant select on scope_fixtures to authenticated;

-- A pinned session in the payments factory proves archive and membership
-- removal never rewrite historical work. Definition tables have no write grant
-- for service credentials, so the fixture inserts them as the database owner.
reset role;
insert into public.factory_definition_revisions(
  id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
)
select '55000000-1500-4000-8000-000000000001', factory.workspace_id, factory.factory_id, 1,
  '{"label":"pinned payments"}',
  encode(sha256(convert_to('{"label":"pinned payments"}', 'UTF8')), 'hex'),
  'b1b2c3d4-0001-4000-8000-000000000001'
from scope_fixtures factory where factory.slug = 'payments';
insert into public.factory_definition_activations(
  workspace_id, factory_id, revision_id, activation_number, created_by
)
select factory.workspace_id, factory.factory_id, '55000000-1500-4000-8000-000000000001', 1,
  'b1b2c3d4-0001-4000-8000-000000000001'
from scope_fixtures factory where factory.slug = 'payments';
set local role service_role;

insert into public.pipelines(id, workspace_id, factory_id, name)
select fixture.pipeline_id, fixture_scope.workspace_id, fixture_scope.factory_id, fixture.name
from (values
  ('55000000-1000-4000-8000-000000000001'::uuid, 'default', 'Default scope pipeline'),
  ('55000000-1000-4000-8000-000000000002', 'payments', 'Payments scope pipeline')
) fixture(pipeline_id, slug, name)
join scope_fixtures fixture_scope on fixture_scope.slug = fixture.slug
where fixture.slug is not null;

insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name)
values
  ('55000000-1100-4000-8000-000000000001', '55000000-0000-4000-8000-000000000001',
    '55000000-1000-4000-8000-000000000001', 1, 'plan', 'Plan'),
  ('55000000-1100-4000-8000-000000000002', '55000000-0000-4000-8000-000000000001',
    '55000000-1000-4000-8000-000000000002', 1, 'plan', 'Plan'),
  ('55000000-1100-4000-8000-000000000003', '55000000-0000-4000-8000-000000000001',
    '55000000-1000-4000-8000-000000000002', 2, 'payments-review', 'Payments review');

insert into public.github_installations(
  id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions
) values
  ('55000000-1200-4000-8000-000000000001', '55000000-0000-4000-8000-000000000001',
    55000001, 'https://github.com/settings/installations/55000001', 55000, 'Organization',
    'scope-primary', '{"contents":"write"}'),
  ('55000000-1200-4000-8000-000000000002', '55000000-0000-4000-8000-000000000002',
    55000002, 'https://github.com/settings/installations/55000002', 55000, 'Organization',
    'scope-foreign', '{"contents":"write"}');

insert into public.github_repositories(
  id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name,
  private, html_url
)
select fixture.repository_id, fixture.workspace_id, built.factory_id, fixture.installation_id,
  fixture.repo_id, fixture.name, fixture.full_name, true, fixture.html_url
from (values
  ('55000000-1300-4000-8000-000000000001'::uuid, '55000000-0000-4000-8000-000000000001'::uuid,
    '55000000-1200-4000-8000-000000000001'::uuid, 550001, 'default', 'scope/default', 'https://github.com/scope/default'),
  ('55000000-1300-4000-8000-000000000002'::uuid, '55000000-0000-4000-8000-000000000001'::uuid,
    '55000000-1200-4000-8000-000000000001'::uuid, 550002, 'payments', 'scope/payments', 'https://github.com/scope/payments'),
  ('55000000-1300-4000-8000-000000000003'::uuid, '55000000-0000-4000-8000-000000000002'::uuid,
    '55000000-1200-4000-8000-000000000002'::uuid, 550003, 'foreign', 'scope/foreign', 'https://github.com/scope/foreign')
) fixture(repository_id, workspace_id, installation_id, repo_id, name, full_name, html_url)
join lateral (
  select factory.id as factory_id from public.factories factory
  where factory.workspace_id = fixture.workspace_id
    and factory.slug = case when fixture.name = 'payments' then 'payments' else 'default' end
) built on true;

-- The workspace primary repository belongs to the default factory. Session
-- detail must not fall back to it when a payments-only member inspects a
-- legacy payments session that has no repository of its own.
insert into public.workspace_repository_profiles(workspace_id, github_repository_id, is_primary)
values (
  '55000000-0000-4000-8000-000000000001',
  '55000000-1300-4000-8000-000000000001',
  true
);

select throws_ok($$insert into public.sessions(
  id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id,
  github_repository_id
) values (
  '55000000-1400-4000-8000-000000000010', '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'default'),
  10, 'Cross-factory repository', 'c1b2c3d4-1000-4000-8000-000000000001',
  '55000000-1000-4000-8000-000000000001', '55000000-1100-4000-8000-000000000001',
  '55000000-1300-4000-8000-000000000002'
)$$, '42501', null,
  'admission rejects a repository from a sibling factory');
select throws_ok($$insert into public.sessions(
  id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id
) values (
  '55000000-1400-4000-8000-000000000011', '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'default'),
  11, 'Cross-factory pipeline', 'c1b2c3d4-1000-4000-8000-000000000001',
  '55000000-1000-4000-8000-000000000002', '55000000-1100-4000-8000-000000000002'
)$$, '42501', null,
  'admission rejects a pipeline from a sibling factory');

insert into public.sessions(
  id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id,
  factory_definition_provenance, factory_definition_revision_id
)
select fixture.session_id, fixture.workspace_id, built.factory_id, fixture.number, fixture.title,
  fixture.creator_member_id, fixture.pipeline_id, fixture.current_stage_id,
  fixture.provenance, fixture.revision_id
from (values
  ('55000000-1400-4000-8000-000000000001'::uuid, '55000000-0000-4000-8000-000000000001'::uuid,
    '55000000-1000-4000-8000-000000000001'::uuid, '55000000-1100-4000-8000-000000000001'::uuid, 1,
    'Default factory session',
    'c1b2c3d4-1000-4000-8000-000000000001'::uuid, 'legacy', null::uuid),
  ('55000000-1400-4000-8000-000000000002'::uuid, '55000000-0000-4000-8000-000000000001'::uuid,
    '55000000-1000-4000-8000-000000000002'::uuid, '55000000-1100-4000-8000-000000000002'::uuid, 2,
    'Payments factory pinned session',
    'c1b2c3d4-1000-4000-8000-000000000001'::uuid, 'pinned',
    '55000000-1500-4000-8000-000000000001'::uuid),
  ('55000000-1400-4000-8000-000000000004'::uuid, '55000000-0000-4000-8000-000000000001'::uuid,
    '55000000-1000-4000-8000-000000000002'::uuid, '55000000-1100-4000-8000-000000000002'::uuid, 4,
    'Payments legacy session without a repository',
    'c1b2c3d4-1000-4000-8000-000000000001'::uuid, 'legacy', null::uuid)
) fixture(session_id, workspace_id, pipeline_id, current_stage_id, number, title, creator_member_id,
  provenance, revision_id)
join lateral (
  select factory.id as factory_id from public.factories factory
  where factory.workspace_id = fixture.workspace_id
    and factory.slug = case when fixture.number = 1 then 'default' else 'payments' end
) built on true
join public.workspace_members member
  on member.workspace_id = fixture.workspace_id
 and member.user_id = 'b1b2c3d4-0001-4000-8000-000000000001'
where member.id = fixture.creator_member_id;

insert into public.agent_runs(id, workspace_id, session_id, run_type, model_provider, model_name, status, created_at)
values
  ('55000000-1450-4000-8000-000000000001', '55000000-0000-4000-8000-000000000001',
    '55000000-1400-4000-8000-000000000001', 'project', 'codex', 'fixture', 'success', '2026-11-01 00:00Z'),
  ('55000000-1450-4000-8000-000000000002', '55000000-0000-4000-8000-000000000001',
    '55000000-1400-4000-8000-000000000002', 'project', 'codex', 'fixture', 'success', '2026-11-02 00:00Z');

insert into public.session_artifacts(session_id, workspace_id, stage_slug, version, artifact_json)
values
  ('55000000-1400-4000-8000-000000000001', '55000000-0000-4000-8000-000000000001', 'plan', 1,
    '{"markdown":"default"}'),
  ('55000000-1400-4000-8000-000000000002', '55000000-0000-4000-8000-000000000001', 'plan', 1,
    '{"markdown":"payments"}');

-- Immutable feedback snapshots carry review text and anchors outside the live
-- review tables. Seed one batch per factory and prove the read policy follows
-- the owning session's factory. Execution triggers are bypassed only for this
-- read-policy fixture; the batch/thread/job guards are covered elsewhere.
reset role;
set local session_replication_role = replica;
insert into public.artifact_feedback_batches(
  id, workspace_id, session_id, requested_by_member_id, actor_label, request_id,
  artifact_id, stage_id, artifact_version, review_revision, selected_thread_ids,
  whole_stage_feedback, rendered_feedback_text, job_id, run_id, rejection_count, job_created
)
select fixture.batch_id, '55000000-0000-4000-8000-000000000001', fixture.session_id,
  'c1b2c3d4-1000-4000-8000-000000000001', 'scope owner', fixture.request_id,
  artifact.id, fixture.stage_id, 1, 0, '{}'::uuid[],
  fixture.feedback, fixture.feedback, fixture.job_id, fixture.run_id, 1, true
from (values
  ('55000000-1600-4000-8000-000000000001'::uuid, '55000000-1400-4000-8000-000000000001'::uuid,
    '55000000-9999-4000-8000-000000000011'::uuid, '55000000-1100-4000-8000-000000000001'::uuid,
    '55000000-1700-4000-8000-000000000001'::uuid, '55000000-1800-4000-8000-000000000001'::uuid,
    'default feedback'),
  ('55000000-1600-4000-8000-000000000002'::uuid, '55000000-1400-4000-8000-000000000002'::uuid,
    '55000000-9999-4000-8000-000000000012'::uuid, '55000000-1100-4000-8000-000000000002'::uuid,
    '55000000-1700-4000-8000-000000000002'::uuid, '55000000-1800-4000-8000-000000000002'::uuid,
    'payments feedback')
) fixture(batch_id, session_id, request_id, stage_id, job_id, run_id, feedback)
join lateral (
  select id from public.session_artifacts
  where session_id = fixture.session_id
  order by version
  limit 1
) artifact on true;
insert into public.artifact_feedback_batch_threads(
  batch_id, workspace_id, session_id, artifact_id, thread_id, thread_revision, kind, anchor, comments
)
select batch.id, batch.workspace_id, batch.session_id, batch.artifact_id,
  '55000000-9998-4000-8000-000000000001', 1, 'discussion', '{}'::jsonb,
  '[{"body":"snapshot"}]'::jsonb
from public.artifact_feedback_batches batch
where batch.id in (
  '55000000-1600-4000-8000-000000000001',
  '55000000-1600-4000-8000-000000000002'
);
insert into public.artifact_feedback_batch_jobs(job_id, batch_id, workspace_id, session_id)
select fixture.job_id, fixture.batch_id, '55000000-0000-4000-8000-000000000001', fixture.session_id
from (values
  ('55000000-1700-4000-8000-000000000001'::uuid, '55000000-1600-4000-8000-000000000001'::uuid,
    '55000000-1400-4000-8000-000000000001'::uuid),
  ('55000000-1700-4000-8000-000000000002'::uuid, '55000000-1600-4000-8000-000000000002'::uuid,
    '55000000-1400-4000-8000-000000000002'::uuid)
) fixture(job_id, batch_id, session_id);
set local session_replication_role = origin;
set local role service_role;

select is(
  (select factory_id from public.sessions where id = '55000000-1400-4000-8000-000000000001'),
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'default'),
  'a legacy caller omitting factory scope lands in the default factory without changing its id'
);

-- Grant the ordinary member one factory only. A workspace manager remains an
-- operator over both factories.
select lives_ok($$select public.grant_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from public.workspace_members where workspace_id = '55000000-0000-4000-8000-000000000001'
    and user_id = 'b1b2c3d4-0002-4000-8000-000000000002'),
  'member')$$,
  'a factory manager can grant membership to another workspace member');
select ok(
  (select count(*) from public.factory_audit_events
    where workspace_id = '55000000-0000-4000-8000-000000000001'
      and action = 'membership.granted'
      and subject_member_id = 'c1b2c3d4-1000-4000-8000-000000000002') >= 2,
  'membership grants are audited, including the default-factory inheritance'
);

-- Scope the second member to payments only so the default-factory repository is
-- not authorized for them.
select lives_ok($$select public.revoke_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and is_default),
  'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from public.workspace_members where workspace_id = '55000000-0000-4000-8000-000000000001'
    and user_id = 'b1b2c3d4-0002-4000-8000-000000000002'))$$,
  'a member can be scoped to a single factory');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'b1b2c3d4-0002-4000-8000-000000000002';
select is(
  public.get_session_detail_page('factory-scope-primary', 4) -> 'session' ->> 'id',
  '55000000-1400-4000-8000-000000000004',
  'a payments-only member can inspect a legacy payments session'
);
select is(
  public.get_session_detail_page('factory-scope-primary', 4) -> 'activity' ->> 'repository',
  null::text,
  'the session detail RPC does not leak the default-factory repository through the primary fallback'
);
reset role;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'b1b2c3d4-0003-4000-8000-000000000003';
select results_eq($$
  select count(*) from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.sessions where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.pipelines where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.github_repositories where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.session_artifacts where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.factories where workspace_id = '55000000-0000-4000-8000-000000000002'
  $$, array[1, 1, 1, 1, 1, 0]::bigint[],
  'a single-factory member cannot enumerate sibling-factory or foreign-workspace resources');

select is(
  jsonb_array_length(public.get_session_list_page('factory-scope-primary') -> 'sessions'),
  1,
  'the session list RPC returns only the member factory'
);
select is(
  public.get_session_list_page('factory-scope-primary', status_filter => 'in_progress')#>>'{scopeFacets,all}',
  '1',
  'filtering display status does not include sibling-factory sessions in counts'
);
select is(
  public.get_session_list_page('factory-scope-primary', status_filter => 'in_progress',
    target_factory_id => (select factory_id from scope_fixtures where slug = 'payments'),
    stage_filter_slug => 'plan'
  )->'stageFacets',
  '[]'::jsonb,
  'the filtered ledger cannot discover a restricted factory stage'
);
select is(
  public.get_session_detail_page('factory-scope-primary', 2),
  null::jsonb,
  'the session detail RPC hides a sibling-factory session'
);
select is(
  (select count(*) from jsonb_array_elements(
    public.get_filtered_pipeline_dashboard_page('55000000-0000-4000-8000-000000000001') -> 'lanes'
  ) lane
  cross join lateral jsonb_array_elements(lane -> 'cards') card
  where card ->> 'id' = '55000000-1400-4000-8000-000000000001'),
  1::bigint,
  'the pipeline dashboard shows the member factory session'
);
select is(
  (select count(*) from jsonb_array_elements(
    public.get_filtered_pipeline_dashboard_page('55000000-0000-4000-8000-000000000001') -> 'lanes'
  ) lane
  cross join lateral jsonb_array_elements(lane -> 'cards') card
  where card ->> 'id' = '55000000-1400-4000-8000-000000000002'),
  0::bigint,
  'the pipeline dashboard hides sibling-factory sessions'
);
select is(
  public.get_session_list_page('factory-scope-primary',
    target_factory_id => (select factory_id from scope_fixtures where slug = 'payments')
  ) -> 'scopeFacets' -> 'all',
  '0'::jsonb,
  'an explicitly restricted factory has no session facet counts'
);
select is(
  public.get_filtered_pipeline_dashboard_page('55000000-0000-4000-8000-000000000001',
    target_factory_id => (select factory_id from scope_fixtures where slug = 'payments')
  ) -> 'lanes',
  '[]'::jsonb,
  'an explicitly restricted factory has no board lanes'
);
select is_empty($$select run_id from public.list_workspace_run_catalog(
  '55000000-0000-4000-8000-000000000001',
  p_factory_id => (select factory_id from scope_fixtures where slug = 'payments')
)$$, 'an explicitly restricted factory has no runs');
select is(
  (select count(*) from public.artifact_feedback_batches
    where id = '55000000-1600-4000-8000-000000000001'),
  1::bigint,
  'the member reads the feedback snapshot in their factory'
);
select is_empty($$select id from public.artifact_feedback_batches
  where id = '55000000-1600-4000-8000-000000000002'$$,
  'the member cannot read a sibling-factory feedback snapshot');
select is(
  (select count(*) from public.artifact_feedback_batch_threads
    where batch_id = '55000000-1600-4000-8000-000000000001'),
  1::bigint,
  'the member reads the feedback thread snapshot in their factory'
);
select is_empty($$select batch_id from public.artifact_feedback_batch_threads
  where batch_id = '55000000-1600-4000-8000-000000000002'$$,
  'the member cannot read a sibling-factory feedback thread snapshot');
select is(
  (select count(*) from public.artifact_feedback_batch_jobs
    where batch_id = '55000000-1600-4000-8000-000000000001'),
  1::bigint,
  'the member reads the feedback job provenance in their factory'
);
select is_empty($$select job_id from public.artifact_feedback_batch_jobs
  where batch_id = '55000000-1600-4000-8000-000000000002'$$,
  'the member cannot read sibling-factory feedback job provenance');
select throws_ok($$select public.create_artifact_review_thread(
  '55000000-0000-4000-8000-000000000001',
  '55000000-1400-4000-8000-000000000002',
  '55000000-1100-4000-8000-000000000002',
  '55000000-9999-4000-8000-000000000001', 1, '{}'::jsonb, 'comment', 'sibling write')$$,
  '42501', null,
  'review mutations reject a sibling-factory session');

select results_eq($$update public.sessions set title = 'Allowed rename'
  where id = '55000000-1400-4000-8000-000000000001'
  returning id$$,
  array['55000000-1400-4000-8000-000000000001']::uuid[],
  'a single-factory member can mutate a session in their own factory');
select is_empty($$update public.sessions set title = 'Restricted rename'
  where id = '55000000-1400-4000-8000-000000000002'
  returning id$$,
  'a single-factory member cannot mutate a sibling factory session');
select throws_ok($$insert into public.pipelines(workspace_id, factory_id, name)
  values ('55000000-0000-4000-8000-000000000001',
    (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
    'Denied pipeline')$$,
  '42501', null,
  'a single-factory member cannot create resources in a sibling factory');
select results_eq($$
  select count(*) from public.factory_members where workspace_id = '55000000-0000-4000-8000-000000000001'
  $$, array[4]::bigint[],
  'a member sees only membership rows in factories they can access');
reset role;

-- Workspace manager operator view across both factories in the workspace.
set local role authenticated;
set local request.jwt.claim.sub = 'b1b2c3d4-0001-4000-8000-000000000001';
select results_eq($$
  select count(*) from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.sessions where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.session_artifacts where workspace_id = '55000000-0000-4000-8000-000000000001'
  $$, array[2, 3, 2]::bigint[],
  'a workspace manager retains authorized access to both factories and all sessions');
select is(
  public.get_session_list_page('factory-scope-primary', page_limit => 1,
    target_factory_id => (select factory_id from scope_fixtures where slug = 'payments')
  ) -> 'scopeFacets' -> 'all',
  '2'::jsonb,
  'session facets count the selected factory before pagination'
);
select is(
  public.get_session_list_page('factory-scope-primary', search_query => '#999999',
    target_factory_id => (select factory_id from scope_fixtures where slug = 'payments'),
    stage_filter_slug => 'payments-review'
  )->'stageFacets',
  '[{"count":0,"name":"Payments review","position":2,"slug":"payments-review"}]'::jsonb,
  'an unused stage is named in the selected authorized factory'
);
select is(
  public.get_session_list_page('factory-scope-primary', search_query => '#999999',
    target_factory_id => (select factory_id from scope_fixtures where slug = 'default'),
    stage_filter_slug => 'payments-review'
  )->'stageFacets',
  '[]'::jsonb,
  'the zero-count facet does not use metadata from an authorized but unselected sibling factory'
);
select is(
  (select sum((lane ->> 'totalCount')::integer) from jsonb_array_elements(
    public.get_filtered_pipeline_dashboard_page('55000000-0000-4000-8000-000000000001',
      target_factory_id => (select factory_id from scope_fixtures where slug = 'payments')
    ) -> 'lanes'
  ) lane),
  2::bigint,
  'board counts include only the selected factory'
);
select results_eq($$select run_id from public.list_workspace_run_catalog(
  '55000000-0000-4000-8000-000000000001', p_limit => 1,
  p_factory_id => (select factory_id from scope_fixtures where slug = 'default')
)$$, array['55000000-1450-4000-8000-000000000001']::uuid[],
  'the runs catalog applies the factory filter before the page limit');
reset role;

set local role service_role;
select is(
  (select count(*) from public.read_factory_scope(
    '55000000-0000-4000-8000-000000000001', 'b1b2c3d4-0001-4000-8000-000000000001')),
  2::bigint,
  'the operator scope read returns both factories for a workspace manager');
select is(
  (select count(*) from public.read_factory_scope(
    '55000000-0000-4000-8000-000000000001', 'b1b2c3d4-0003-4000-8000-000000000003')),
  1::bigint,
  'the scope read returns one factory for an ordinary member');

-- Membership removal takes effect immediately, including against an existing
-- session and its artifact, while the factory history remains available.
select lives_ok($$select public.revoke_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'default'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from public.workspace_members where workspace_id = '55000000-0000-4000-8000-000000000001'
    and user_id = 'b1b2c3d4-0003-4000-8000-000000000003'),
  'moved teams')$$,
  'membership removal is recorded as an audited operator action');
reset role;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'b1b2c3d4-0003-4000-8000-000000000003';
select results_eq($$
  select count(*) from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.sessions where workspace_id = '55000000-0000-4000-8000-000000000001'
  union all select count(*) from public.session_artifacts where workspace_id = '55000000-0000-4000-8000-000000000001'
  $$, array[0, 0, 0]::bigint[],
  'a removed member immediately loses the migrated session and its evidence');
select is(
  public.get_session_detail_page('factory-scope-primary', 1),
  null::jsonb,
  'the session detail RPC also closes after membership revocation'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'b1b2c3d4-0001-4000-8000-000000000001';
select results_eq($$
  select count(*) from public.sessions where id = '55000000-1400-4000-8000-000000000001'
  union all select count(*) from public.session_artifacts
    where session_id = '55000000-1400-4000-8000-000000000001'
  $$, array[1, 1]::bigint[],
  'authorized managers still inspect the historical session after membership removal');
reset role;

-- Archive the pinned factory: new admission stops, historical inspection stays,
-- and an authorized operator can restore it. The last-manager guard is tested
-- on the payments factory before archiving.
set local role service_role;
select throws_ok($$select public.grant_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from public.workspace_members where workspace_id = '55000000-0000-4000-8000-000000000001'
    and user_id = 'b1b2c3d4-0001-4000-8000-000000000001'),
  'member')$$,
  '23514', null,
  'a factory cannot demote its last manager');

select throws_ok($$select public.revoke_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from public.workspace_members where workspace_id = '55000000-0000-4000-8000-000000000001'
    and user_id = 'b1b2c3d4-0001-4000-8000-000000000001'))$$,
  '23514', null,
  'a factory cannot lose its last manager');

-- Deactivating the sole manager promotes the longest-standing active member;
-- workspace removal itself must keep working.
select lives_ok($$select public.create_factory(
  '55000000-0000-4000-8000-000000000001',
  'b1b2c3d4-0001-4000-8000-000000000001', 'Dedicated', 'dedicated')$$,
  'a dedicated factory supports the deactivation test');
select lives_ok($$select public.grant_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'dedicated'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-1000-4000-8000-000000000005', 'manager')$$,
  'the reactivated member becomes a dedicated factory manager');
select lives_ok($$select public.grant_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'dedicated'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-1000-4000-8000-000000000003', 'member')$$,
  'an active member is available for promotion');
select lives_ok($$select public.grant_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'dedicated'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-1000-4000-8000-000000000001', 'member')$$,
  'the workspace owner can step down from factory management');
select lives_ok($$update public.workspace_members set is_active = false
  where id = 'c1b2c3d4-1000-4000-8000-000000000005'$$,
  'workspace deactivation does not block the sole factory manager');
select is(
  (select count(*) from public.factory_members manager
    join public.workspace_members manager_member on manager_member.id = manager.member_id
    where manager.factory_id = (select id from public.factories
        where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'dedicated')
      and manager.role = 'manager'
      and manager.revoked_at is null
      and manager_member.is_active
      and manager_member.kind = 'human'),
  1::bigint,
  'deactivation promotes an active member so the factory retains a manager');
select is(
  (select count(*) from public.factory_audit_events
    where workspace_id = '55000000-0000-4000-8000-000000000001'
      and action = 'membership.granted'
      and detail ->> 'source' = 'workspace_member_deactivation'),
  1::bigint,
  'the deactivation promotion is audited');

-- Writes to membership history have no service grant; the database owner
-- exercises the FK cleanup path triggered by account deletion.
reset role;
select lives_ok($$update public.factory_members set granted_by_member_id = null
  where workspace_id = '55000000-0000-4000-8000-000000000001'
    and factory_id = (select id from public.factories
      where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments')
    and member_id = 'c1b2c3d4-1000-4000-8000-000000000002'$$,
  'account deletion may clear grant attribution through ON DELETE SET NULL');
select throws_ok($$update public.factory_members
  set granted_by_member_id = 'c1b2c3d4-1000-4000-8000-000000000003'
  where workspace_id = '55000000-0000-4000-8000-000000000001'
    and factory_id = (select id from public.factories
      where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments')
    and member_id = 'c1b2c3d4-1000-4000-8000-000000000002'$$,
  '23514', null,
  'grant attribution stays immutable outside FK cleanup');
set local role service_role;

select ok(
  (select convalidated from pg_constraint
    where conrelid = 'public.factory_audit_events'::regclass
      and conname = 'factory_audit_events_action_check'),
  'the widened factory audit constraint is validated by a separate migration');
select throws_ok($$select public.archive_additional_factory(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and is_default),
  'b1b2c3d4-0001-4000-8000-000000000001',
  'Reserved default')$$,
  '23514', 'The workspace default factory cannot be archived.',
  'even a workspace owner cannot archive the reserved default from Settings');
select throws_ok($$select public.rename_factory(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0002-4000-8000-000000000002',
  'Payments', 'Unauthorized rename')$$,
  '42501', null, 'a non-manager cannot rename a factory');
select results_eq($$select name, slug, status, is_default from public.rename_factory(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  'Payments', ' Payments Ops ')$$,
  $$values ('Payments Ops'::text, 'payments'::text, 'active'::text, false)$$,
  'an owner can rename the factory without changing its address, state, or default designation');
select throws_ok($$select public.rename_factory(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  'Payments', 'Stale rename')$$,
  'PT409', 'The factory name changed.', 'a stale name cannot overwrite the newer name');
select is(
  (select count(*) from public.factory_audit_events
    where workspace_id = '55000000-0000-4000-8000-000000000001' and action = 'factory.renamed'
      and detail = '{"previousName":"Payments","name":"Payments Ops"}'::jsonb),
  1::bigint,
  'renaming records exactly one audit event naming the previous and current display name');

select lives_ok($$select public.archive_additional_factory(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  'Product sunset')$$,
  'an authorized manager can archive a factory');
select is(
  (select status from public.factories
    where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'archived',
  'the factory reports archived');
select is(
  (select count(*) from public.factory_audit_events
    where workspace_id = '55000000-0000-4000-8000-000000000001' and action = 'factory.archived'),
  1::bigint,
  'archiving records an audit event with the operator and reason');
select throws_ok($$select public.rename_factory(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  'Payments Ops', 'Archived rename')$$,
  'P0011', 'Factory is archived.', 'an archived factory cannot be renamed until it is restored');
select throws_ok($$insert into public.sessions(
  id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id
) values (
  '55000000-1400-4000-8000-000000000003', '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  3, 'Blocked admission', 'c1b2c3d4-1000-4000-8000-000000000001',
  '55000000-1000-4000-8000-000000000002', '55000000-1100-4000-8000-000000000002'
)$$, 'P0011', null, 'an archived factory rejects new session admission');
reset role;

-- The pinned historical session and its factory stay inspectable by an
-- authorized factory member while archived.
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'b1b2c3d4-0002-4000-8000-000000000002';
select results_eq($$
  select count(*) from public.factories
    where workspace_id = '55000000-0000-4000-8000-000000000001' and status = 'archived'
  union all select count(*) from public.sessions where id = '55000000-1400-4000-8000-000000000002'
  union all select count(*) from public.session_artifacts where session_id = '55000000-1400-4000-8000-000000000002'
  $$, array[1, 1, 1]::bigint[],
  'an authorized member retains historical inspection of the archived factory and pinned session');
reset role;

set local role service_role;
set local request.jwt.claim.sub = 'b1b2c3d4-0001-4000-8000-000000000001';
select lives_ok($$select public.restore_factory(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001')$$,
  'an authorized manager can restore an archived factory');
select lives_ok($$insert into public.sessions(
  id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id
) values (
  '55000000-1400-4000-8000-000000000003', '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  3, 'Restored admission', 'c1b2c3d4-1000-4000-8000-000000000001',
  '55000000-1000-4000-8000-000000000002', '55000000-1100-4000-8000-000000000002'
)$$, 'restored factories accept new admission again');
select is(
  (select count(*) from public.factory_audit_events
    where workspace_id = '55000000-0000-4000-8000-000000000001' and action = 'factory.restored'),
  1::bigint,
  'restoring records an audit event');

-- Workspace owners and admins keep operator admission even without an explicit
-- factory grant, matching internal.can_access_factory. Another manager takes
-- over payments first so the owner's grant can be removed legally.
select lives_ok($$select public.grant_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-1000-4000-8000-000000000002', 'manager')$$,
  'an active member can take over payments management');
select lives_ok($$select public.revoke_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from public.workspace_members where workspace_id = '55000000-0000-4000-8000-000000000001'
    and user_id = 'b1b2c3d4-0001-4000-8000-000000000001'))$$,
  'the owner can leave a factory while another manager remains');
select lives_ok($$insert into public.sessions(
  id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id
) values (
  '55000000-1400-4000-8000-000000000012', '55000000-0000-4000-8000-000000000001',
  (select id from public.factories where workspace_id = '55000000-0000-4000-8000-000000000001' and slug = 'payments'),
  12, 'Operator admission', 'c1b2c3d4-1000-4000-8000-000000000001',
  '55000000-1000-4000-8000-000000000002', '55000000-1100-4000-8000-000000000002'
)$$, 'workspace owners can start sessions without an explicit factory grant');

select public.create_service_principal(factory.workspace_id, factory.id,
  case when factory.workspace_id = '55000000-0000-4000-8000-000000000001'
    then 'b1b2c3d4-0001-4000-8000-000000000001'::uuid
    else 'b1b2c3d4-0004-4000-8000-000000000004'::uuid end,
  'Audit reader scope', 'audit-reader-scope')
from public.factories factory
where (factory.workspace_id = '55000000-0000-4000-8000-000000000001'
    and factory.slug in ('default', 'payments'))
  or (factory.workspace_id = '55000000-0000-4000-8000-000000000002' and factory.is_default);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'b1b2c3d4-0001-4000-8000-000000000001';
select results_eq($$
  select scope.slug from public.factory_audit_events event
  left join scope_fixtures scope on scope.factory_id = event.factory_id
  where event.action = 'service_principal.created' and event.detail->>'slug' = 'audit-reader-scope'
  order by scope.slug
$$, array['default', 'payments']::text[],
  'a workspace operator reads governance history in both owned factories only');

set local request.jwt.claim.sub = 'b1b2c3d4-0002-4000-8000-000000000002';
select results_eq($$
  select scope.slug from public.factory_audit_events event
  left join scope_fixtures scope on scope.factory_id = event.factory_id
  where event.action = 'service_principal.created' and event.detail->>'slug' = 'audit-reader-scope'
$$, array['payments']::text[],
  'an explicit manager reads only their exact factory governance history');

set local request.jwt.claim.sub = 'b1b2c3d4-0005-4000-8000-000000000005';
select is_empty($$
  select event.id from public.factory_audit_events event
  where event.action = 'service_principal.created' and event.detail->>'slug' = 'audit-reader-scope'
$$, 'an inactive member cannot read governance history');
reset role;
set local role service_role;

select public.grant_factory_membership(
  '55000000-0000-4000-8000-000000000001',
  (select factory_id from scope_fixtures where slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-1000-4000-8000-000000000003', 'member');
select public.archive_factory(
  '55000000-0000-4000-8000-000000000001',
  (select factory_id from scope_fixtures where slug = 'payments'),
  'b1b2c3d4-0001-4000-8000-000000000001', 'Audited history fixture');

set local role authenticated;
set local request.jwt.claim.sub = 'b1b2c3d4-0002-4000-8000-000000000002';
select is((select count(*) from public.factory_audit_events event
  where (event.workspace_id, event.factory_id) = ('55000000-0000-4000-8000-000000000001'::uuid,
    (select factory_id from scope_fixtures where slug = 'payments'))
    and event.action = 'service_principal.created' and event.detail->>'slug' = 'audit-reader-scope'),
  1::bigint, 'an exact manager retains governance history after factory archiving');

set local request.jwt.claim.sub = 'b1b2c3d4-0003-4000-8000-000000000003';
select is_empty($$
  select event.id from public.factory_audit_events event
  where event.factory_id = (select factory_id from scope_fixtures where slug = 'payments')
    and event.action = 'service_principal.created' and event.detail->>'slug' = 'audit-reader-scope'
$$, 'ordinary factory members cannot read governance history even with exact source scope');

select * from finish();
rollback;
