begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '57900000-0000-4000-8000-000000000001';

create function pg_temp.fixture_id(category integer, slot integer default 1) returns uuid
language sql immutable as $$
  select ('57900000-' || lpad(category::text, 4, '0') || '-4000-8000-' || lpad(slot::text, 12, '0'))::uuid;
$$;

select public.set_git_continuity_release(true, revision, 'Factory context retrieval fixture')
from public.get_git_continuity_release_state() where not enabled;
insert into auth.users(id, email) values
  (pg_temp.fixture_id(0, 1), 'context-retrieval-owner@example.test'),
  (pg_temp.fixture_id(0, 2), 'context-retrieval-other-owner@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.fixture_id(1, 1), 'context-retrieval-fixture', 'Context retrieval fixture'),
  (pg_temp.fixture_id(1, 2), 'context-retrieval-other', 'Another workspace');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.fixture_id(2, 1), pg_temp.fixture_id(1, 1), pg_temp.fixture_id(0, 1), 'human', 'owner'),
  (pg_temp.fixture_id(2, 2), pg_temp.fixture_id(1, 2), pg_temp.fixture_id(0, 2), 'human', 'owner');
insert into public.factories(id, workspace_id, name, slug, is_default) values
  (pg_temp.fixture_id(3, 2), pg_temp.fixture_id(1, 1), 'Sibling factory', 'context-sibling', false);

create temp table fixture_scopes as
select scope.slot, factory.workspace_id, factory.id as factory_id,
  pg_temp.fixture_id(0, scope.workspace_slot) as user_id,
  pg_temp.fixture_id(2, scope.workspace_slot) as member_id,
  pg_temp.fixture_id(4, scope.workspace_slot) as installation_row_id,
  pg_temp.fixture_id(5, scope.slot * 10 + 1) as writer_id,
  pg_temp.fixture_id(5, scope.slot * 10 + 2) as repository_id,
  (57900000 + scope.slot * 10 + 2)::bigint as upstream_repository_id
from (values (1, 1), (2, 1), (3, 2)) scope(slot, workspace_slot)
join public.factories factory on factory.workspace_id = pg_temp.fixture_id(1, scope.workspace_slot)
  and (case when scope.slot = 2 then factory.id = pg_temp.fixture_id(3, 2) else factory.is_default end);

insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id,
  target_type, target_name, permissions)
select pg_temp.fixture_id(4, slot), pg_temp.fixture_id(1, slot), 579000 + slot,
  'https://github.test/installations/' || (579000 + slot), 57900, 'Organization', 'fixture', '{"contents":"write"}'
from (values (1), (2)) installation(slot);
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
select repository.id, scope.workspace_id, scope.factory_id, scope.installation_row_id, repository.upstream_id,
  repository.name, 'fixture/' || repository.name, true, 'https://github.test/fixture/' || repository.name, 'main'
from fixture_scopes scope cross join lateral (values
  (scope.writer_id, scope.upstream_repository_id - 1, 'writer-' || scope.slot),
  (scope.repository_id, scope.upstream_repository_id, 'context-' || scope.slot)
) repository(id, upstream_id, name);
select public.save_execution_policy(workspace_id, user_id, 0,
  '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":30000,"maxTotalTokens":1000,"maxCostUsd":1}')
from fixture_scopes where slot in (1, 3);
create temp table fixture_principals as
select scope.slot, principal.id from fixture_scopes scope
cross join lateral public.create_service_principal(scope.workspace_id, scope.factory_id, scope.user_id,
  'Context reader', 'context-reader') principal;
create temp table fixture_grants as
select scope.slot, alternative.ordinal, execution_grant.*
from fixture_scopes scope
join public.execution_policies policy using (workspace_id)
join fixture_principals principal using (slot)
cross join (values (1), (2)) alternative(ordinal)
cross join lateral public.approve_factory_execution_grant(scope.workspace_id, scope.factory_id, scope.user_id,
  principal.id, scope.writer_id, array[scope.repository_id], '{}'::text[], policy.current_revision_id,
  scope.member_id, clock_timestamp() + (alternative.ordinal || ' hour')::interval, 0) execution_grant
where alternative.ordinal = 1 or scope.slot = 1;

create temp table fixture_sources as
select item.label, item.slot, source.id
from (values
  ('selected', 1, 1, 'docs/selected.md'), ('removed', 1, 1, 'docs/removed.md'),
  ('mismatch', 1, 1, 'docs/mismatch.md'), ('sibling', 2, 1, 'docs/sibling.md'),
  ('foreign', 3, 1, 'docs/foreign.md'), ('different-grant', 1, 2, 'docs/other-grant.md'),
  ('pending', 1, 1, 'docs/pending.md')
) item(label, slot, grant_ordinal, file_path)
join fixture_scopes scope on scope.slot = item.slot
join fixture_grants execution_grant on (execution_grant.slot, execution_grant.ordinal) = (item.slot, item.grant_ordinal)
cross join lateral public.register_factory_context_source(scope.workspace_id, scope.factory_id, scope.user_id,
  scope.repository_id, execution_grant.id, execution_grant.version, item.file_path) source;

create function pg_temp.sync_source(p_label text, p_body text, p_commit text)
returns uuid language sql as $$
  select synced.current_revision_id from fixture_sources source join fixture_scopes scope using (slot)
  cross join lateral public.claim_factory_context_source_sync(scope.workspace_id, scope.factory_id, scope.user_id,
    source.id) claim
  cross join lateral public.settle_factory_context_source_sync(scope.workspace_id, scope.factory_id, scope.user_id,
    source.id, claim.lease_id, 'synced', p_body, p_commit, '2026-01-01T01:00:00Z') synced
  where source.label = p_label;
$$;

create temp table requested_documents as
select label, id as source_id, case when label = 'pending' then pg_temp.fixture_id(8)
  else pg_temp.sync_source(label, '# Older ' || label || ' body', repeat('a', 40)) end as revision_id
from fixture_sources;
update requested_documents set revision_id = (select revision_id from requested_documents where label = 'selected')
where label = 'mismatch';
create temp table newer_revision as
select pg_temp.sync_source('selected', '# Newer selected body', repeat('b', 40)) as id;

insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
select pg_temp.fixture_id(6), workspace_id, factory_id, 'Context retrieval', true from fixture_scopes where slot = 1;
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name)
values (pg_temp.fixture_id(7), pg_temp.fixture_id(6), pg_temp.fixture_id(1), 1, 'context-build', 'Build');

create temp table fixture_definition as
select jsonb_build_object(
  'schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.fixture_id(6),
  'repositoryId', execution_grant.github_repository_id, 'toolIds', '[]'::jsonb,
  'executionPolicyRevisionId', execution_grant.execution_policy_revision_id,
  'executionGrant', jsonb_build_object('id', execution_grant.id, 'version', execution_grant.version),
  'sandboxProvider', 'e2b', 'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5'),
  'stages', jsonb_build_array(jsonb_build_object('id', pg_temp.fixture_id(7), 'slug', 'context-build', 'name', 'Build')),
  'contextDocuments', (select jsonb_agg(jsonb_build_object('sourceId', source_id, 'revisionId', revision_id) order by label)
    from requested_documents)
) as body
from fixture_grants execution_grant where slot = 1 and ordinal = 1;

create function pg_temp.activate_revision(p_activation integer, p_body jsonb) returns uuid language sql as $$
  with revision as (
    insert into public.factory_definition_revisions(workspace_id, factory_id, schema_version, definition_json,
      canonical_digest, created_by)
    select scope.workspace_id, scope.factory_id, 1, p_body::text, encode(sha256(convert_to(p_body::text, 'UTF8')), 'hex'),
      scope.user_id from fixture_scopes scope where scope.slot = 1
    returning workspace_id, factory_id, id, created_by
  )
  insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
  select workspace_id, factory_id, id, p_activation, created_by from revision returning revision_id;
$$;

select pg_temp.activate_revision(1, body) from fixture_definition;
create function pg_temp.start_context_attempt(p_title text) returns table (job_id uuid, run_id uuid)
language plpgsql as $$
declare
  queued record;
  active_run uuid;
begin
  select creation.* into strict queued from fixture_scopes scope
  cross join lateral public.create_session_with_first_job(scope.workspace_id, scope.member_id,
    p_title, 'Explicit context retrieval', 'codex', 'gpt-5.5', session_github_repository_id => scope.writer_id) creation
  where scope.slot = 1;

  update public.agent_jobs job set git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()),
    status = 'running', attempt_count = 1 where job.id = queued.job_id;
  select public.start_session_job_attempt(queued.job_id, 1, session.current_stage_id, session.current_artifact_version,
    'codex', 'gpt-5.5', 'code', 'wallie/context-fixture-' || queued.job_id::text) into active_run
  from public.sessions session where session.id = queued.session_id;
  return query select queued.job_id, active_run;
end;
$$;
create temp table fixture_attempt as select * from pg_temp.start_context_attempt('Context retrieval qualified run');
select ok((select run_id is not null from fixture_attempt), 'the public admission route starts the exact pinned attempt');

create function pg_temp.read_revision(
  p_label text, p_digest text default null, p_revision_id uuid default null, p_attempt_count integer default 1,
  p_workspace_id uuid default pg_temp.fixture_id(1), p_run_id uuid default null
) returns table (
  status text, file_path text, installation_id bigint, repository_id bigint, repository_full_name text,
  upstream_revision text, content_sha256 text, content_bytes integer, stale boolean, content text
) language sql as $$
  select outcome.* from requested_documents requested cross join fixture_attempt attempt
  cross join lateral public.read_factory_run_context_revision(p_workspace_id, attempt.job_id,
    coalesce(p_run_id, attempt.run_id), p_attempt_count, requested.source_id,
    coalesce(p_revision_id, requested.revision_id), p_digest) outcome
  where requested.label = p_label;
$$;

select ok(has_function_privilege('service_role',
    'public.read_factory_run_context_revision(uuid,uuid,uuid,integer,uuid,uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.read_factory_run_context_revision(uuid,uuid,uuid,integer,uuid,uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.read_factory_run_context_revision(uuid,uuid,uuid,integer,uuid,uuid,text)', 'EXECUTE'),
  'only the trusted worker can resolve exact context candidates or bodies');
select throws_ok($$select * from pg_temp.read_revision('selected', p_attempt_count => 2)$$,
  '42501', null, 'a different attempt number cannot retrieve even metadata');
select throws_ok($$select * from pg_temp.read_revision('selected', p_run_id => gen_random_uuid())$$,
  '42501', null, 'a different run cannot claim the active job');
select throws_ok($$select * from pg_temp.read_revision('selected', p_workspace_id => pg_temp.fixture_id(1, 2))$$,
  '42501', null, 'an attempt cannot be reused in another workspace');

create temp table candidate as select * from pg_temp.read_revision('selected');
select ok((select status = 'candidate' and file_path = 'docs/selected.md' and installation_id = 579001
  and repository_id = 57900012 and repository_full_name = 'fixture/context-1' and upstream_revision = repeat('a', 40)
  and content_sha256 = encode(extensions.digest('# Older selected body', 'sha256'), 'hex')
  and content_bytes = octet_length('# Older selected body') and stale and content is null from candidate),
  'metadata preflight proves the exact selected historical revision without releasing its body or requiring a full repo binding');
select ok((select status = 'selected' and content = '# Older selected body' and stale from pg_temp.read_revision(
  'selected', (select content_sha256 from candidate))), 'a verified matching digest returns the selected bytes, never current HEAD');
select ok((select status = 'revision_changed' and file_path is null and content is null
  from pg_temp.read_revision('selected', repeat('0', 64))), 'a mismatching digest exposes neither body nor provider metadata');
select ok((select status = 'not_selected' and content is null from pg_temp.read_revision(
  'selected', (select content_sha256 from candidate), (select id from newer_revision))),
  'an available but unselected current revision cannot replace the requested historical revision');
select ok((select status = 'missing_revision' and file_path is null and content is null from pg_temp.read_revision('mismatch')),
  'a configured revision from a different source cannot supply a body');
select ok((select status = 'missing_revision' and file_path is null and content is null from pg_temp.read_revision('sibling')),
  'even a configured exact pair cannot expose a sibling factory source');
select ok((select status = 'missing_revision' and file_path is null and content is null from pg_temp.read_revision('foreign')),
  'even a configured exact pair cannot expose another workspace source');
select ok((select status = 'access_revoked' and content is null from pg_temp.read_revision('different-grant')),
  'the same repository does not allow the run to borrow a source registered to another grant');
select ok((select status = 'source_unavailable' and content is null from pg_temp.read_revision('pending')),
  'a source without an active revision cannot supply historical bytes');

-- These invalid definitions bypass source parsing only to exercise the SQL
-- fence directly. A valid HTTP editor rejects both shapes before activation.
select pg_temp.activate_revision(2, jsonb_set(body, '{contextDocuments}', (body->'contextDocuments') ||
  jsonb_build_array(jsonb_build_object('sourceId', pg_temp.fixture_id(9, 1), 'revisionId', pg_temp.fixture_id(9, 2)),
    jsonb_build_object('sourceId', pg_temp.fixture_id(9, 3), 'revisionId', pg_temp.fixture_id(9, 4)))))
from fixture_definition;
create temp table oversized_attempt as select * from pg_temp.start_context_attempt('Oversized retrieval fixture');
select ok((select outcome.status = 'not_selected' and outcome.content is null from oversized_attempt attempt
  cross join requested_documents requested cross join lateral public.read_factory_run_context_revision(
    pg_temp.fixture_id(1), attempt.job_id, attempt.run_id, 1, requested.source_id, requested.revision_id) outcome
  where requested.label = 'selected'), 'SQL rejects the selection when the pinned definition exceeds eight documents');

select pg_temp.activate_revision(3, jsonb_set(body, '{contextDocuments}', (body->'contextDocuments') ||
  jsonb_build_array(jsonb_build_object('sourceId', requested.source_id, 'revisionId', newer.id))))
from fixture_definition cross join requested_documents requested cross join newer_revision newer where requested.label = 'selected';
create temp table duplicate_source_attempt as select * from pg_temp.start_context_attempt('Duplicate source retrieval fixture');
select ok((select outcome.status = 'not_selected' and outcome.content is null from duplicate_source_attempt attempt
  cross join requested_documents requested cross join lateral public.read_factory_run_context_revision(
    pg_temp.fixture_id(1), attempt.job_id, attempt.run_id, 1, requested.source_id, requested.revision_id) outcome
  where requested.label = 'selected'), 'SQL rejects two configured revisions of the same source');

update public.github_repositories set is_archived = true where id = (select repository_id from fixture_scopes where slot = 1);
select ok((select status = 'access_revoked' and file_path is null and content is null from pg_temp.read_revision(
  'selected', (select content_sha256 from candidate))),
  'losing the individual context repository after preflight prevents disclosure while the writer stays live');
update public.github_repositories set is_archived = false where id = (select repository_id from fixture_scopes where slot = 1);

create temp table active_before_removal as select * from pg_temp.read_revision('removed');
select is((select status from active_before_removal), 'candidate', 'an active source passes preflight before removal');
select public.delete_factory_context_source(scope.workspace_id, scope.factory_id, scope.user_id, source.id)
from fixture_scopes scope join fixture_sources source using (slot) where source.label = 'removed';
select ok((select status = 'source_unavailable' and file_path is null and content is null from pg_temp.read_revision(
  'removed', (select content_sha256 from active_before_removal))), 'operator removal between phases blocks the final read');

select public.revoke_factory_execution_grant(scope.workspace_id, scope.factory_id, scope.user_id,
  execution_grant.id, execution_grant.version, 'Revoke retrieval fixture')
from fixture_grants execution_grant join fixture_scopes scope using (slot) where execution_grant.slot = 1 and ordinal = 1;
select ok((select status = 'access_revoked' and file_path is null and content is null from pg_temp.read_revision(
  'selected', (select content_sha256 from candidate))), 'revoking the admitted grant after preflight prevents the final body read');
select ok((select status = 'access_revoked' and content_sha256 is null and content is null
  from pg_temp.read_revision('selected')), 'a previously visible cached document cannot preflight after revocation');

select * from finish();
rollback;
