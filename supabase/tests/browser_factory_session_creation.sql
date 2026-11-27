begin;
create extension if not exists pgtap with schema extensions;
select plan(11);
set local request.jwt.claim.role = 'service_role';

create temp table browser_factory_scope as
select workspace.id as workspace_id, workspace.slug, owner.id as owner_member_id,
  owner.user_id as owner_user_id, reader.id as other_member_id,
  default_factory.id as default_factory_id, installation.id as installation_id,
  gen_random_uuid() as pipeline_id, gen_random_uuid() as stage_id,
  gen_random_uuid() as repository_id, gen_random_uuid() as revision_id,
  gen_random_uuid() as attachment_id, gen_random_uuid() as request_id
from public.workspaces workspace
join public.workspace_members owner on owner.workspace_id = workspace.id and owner.role = 'owner'
join public.workspace_members reader on reader.workspace_id = workspace.id and reader.role = 'member'
join public.factories default_factory on default_factory.workspace_id = workspace.id and default_factory.is_default
join public.github_installations installation on installation.workspace_id = workspace.id
where workspace.slug = 'acme-corp';

alter table browser_factory_scope add column factory_id uuid, add column empty_factory_id uuid, add column digest text;
update browser_factory_scope scope
set factory_id = (public.create_factory(scope.workspace_id, scope.owner_user_id, 'Composer bench', 'composer-bench')).id,
  empty_factory_id = (public.create_factory(scope.workspace_id, scope.owner_user_id, 'Composer empty', 'composer-empty')).id;

insert into public.pipelines (id, workspace_id, factory_id, name)
select pipeline_id, workspace_id, factory_id, 'Composer bench' from browser_factory_scope;
insert into public.pipeline_stages (id, workspace_id, pipeline_id, slug, name, position, prompt_template_md)
select stage_id, workspace_id, pipeline_id, 'qualify', 'Qualify', 1, 'Review {{session.prompt}}.'
from browser_factory_scope;
insert into public.github_repositories (id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, html_url, default_branch, private)
select repository_id, workspace_id, factory_id, installation_id,
  (select coalesce(max(repo_id), 0) + 1 from public.github_repositories where github_installation_id = scope.installation_id),
  'composer-bench',
  'example/composer-bench', 'https://example.test/composer-bench', 'main', true
from browser_factory_scope scope;
insert into public.user_codex_credentials (user_id, credential_type, encrypted_credential)
select owner_user_id, 'platform_api_key', 'synthetic-local-ciphertext'
from browser_factory_scope on conflict (user_id) do nothing;

with bundle as (
  select scope.*, jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', pipeline_id, 'repositoryId', repository_id,
    'sandboxProvider', 'e2b', 'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5',
      'effort', null, 'concurrencyLimit', 1, 'maxRetries', 1, 'maxTurns', 10, 'stallTimeoutMs', 300000),
    'executionPolicyRevisionId', null, 'deliveryPolicyRevisionId', null, 'operatingRulesMd', '',
    'operatingRuleStageIds', '[]'::jsonb, 'skillIds', '[]'::jsonb, 'toolIds', '[]'::jsonb,
    'stages', jsonb_build_array(jsonb_build_object('id', stage_id, 'slug', 'qualify', 'name', 'Qualify',
      'description', 'Review the benchmark.', 'promptTemplateMd', 'Review {{session.prompt}}.',
      'anyoneCanApprove', false, 'approverMemberIds', '[]'::jsonb, 'previousStageIds', '[]'::jsonb))
  )::text as definition
  from browser_factory_scope scope
), stored as (
  insert into public.factory_definition_revisions
    (id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by)
  select revision_id, workspace_id, factory_id, 1, definition,
    encode(sha256(convert_to(definition, 'UTF8')), 'hex'), owner_user_id
  from bundle returning canonical_digest
)
update browser_factory_scope set digest = stored.canonical_digest from stored;

insert into public.factory_definition_activations
  (workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, revision_id, 1, owner_user_id from browser_factory_scope;

insert into public.session_attachments
  (id, workspace_id, uploaded_by_member_id, original_filename, content_type, size_bytes, storage_path, status, expires_at)
select attachment_id, workspace_id, owner_member_id, 'proof.png', 'image/png', 2048,
  workspace_id::text || '/composer-proof.png', 'ready', now() + interval '1 hour'
from browser_factory_scope;

create function pg_temp.create_scoped(
  expected_digest text,
  request_factory_id uuid,
  prospective_creator uuid default null,
  create_request_id uuid default null
) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language sql as $$
  select admitted.* from browser_factory_scope scope
  cross join lateral public.create_session_command_once(scope.workspace_id,
    coalesce(prospective_creator, scope.owner_member_id), coalesce(create_request_id, scope.request_id),
    repeat('c', 64), expected_digest, 'Scoped browser proof', 'Review a fixture with an image.',
    'codex', 'gpt-5.5', array[scope.attachment_id],
    session_github_repository_id => scope.repository_id, selected_stage_ids => array[scope.stage_id],
    target_factory_id => request_factory_id) admitted;
$$;

select throws_ok($$
  select * from browser_factory_scope scope
  cross join lateral pg_temp.create_scoped('', scope.empty_factory_id)
$$, 'PT422', 'Publish a factory definition before starting a session here.',
  'an unconfigured nondefault factory cannot fall back to the legacy pipeline');
select throws_ok($$
  select * from browser_factory_scope scope
  cross join lateral pg_temp.create_scoped(repeat('a', 64), scope.factory_id)
$$, 'P0003', 'The active factory definition changed.',
  'the exact target must still match the displayed definition');
select throws_ok($$
  select * from browser_factory_scope scope
  cross join lateral pg_temp.create_scoped(scope.digest, scope.factory_id, scope.other_member_id)
$$, '42501', 'The service execution invoker no longer has factory access.',
  'workspace membership alone does not authorize creation in another factory');
select ok(
  (select status = 'ready' and session_id is null from public.session_attachments
    where id = (select attachment_id from browser_factory_scope)),
  'rejected requests leave the pending image available'
);
select is((select count(*) from public.sessions where title = 'Scoped browser proof'), 0::bigint,
  'rejected requests create no session in either factory');

create temp table browser_factory_created as
select admitted.* from browser_factory_scope scope
cross join lateral pg_temp.create_scoped(scope.digest, scope.factory_id) admitted;

select ok(exists (
  select 1 from browser_factory_created created
  join public.sessions session on session.id = created.session_id
  join public.session_factory_admission_inputs pin on pin.session_id = session.id
  join public.agent_jobs job on (job.id, job.session_id) = (created.job_id, session.id)
  join public.agent_runs run on (run.id, run.agent_job_id) = (created.run_id, job.id)
  cross join browser_factory_scope scope
  where (session.factory_id, session.pipeline_id, session.github_repository_id, session.factory_definition_revision_id) =
    (scope.factory_id, scope.pipeline_id, scope.repository_id, scope.revision_id)
    and session.execute_pinned_definition and pin.definition_digest = scope.digest
    and pin.selected_stage_ids = array[scope.stage_id] and run.stage_id = scope.stage_id
    and job.status = 'queued' and run.status = 'queued'
), 'admission pins the exact nondefault factory definition and queues its first run atomically');
select ok(exists (
  select 1 from browser_factory_created created
  join public.session_attachments attachment on attachment.session_id = created.session_id
  join browser_factory_scope scope on scope.attachment_id = attachment.id
  where attachment.status = 'attached' and attachment.position = 1 and attachment.expires_at is null
), 'the original pending image is attached only to the admitted session');
select results_eq($$
  select admitted.* from browser_factory_scope scope
  cross join lateral pg_temp.create_scoped(repeat('a', 64), scope.factory_id) admitted
$$, 'select * from browser_factory_created', 'an exact retry returns the original job and run');
select throws_ok($$
  select * from browser_factory_scope scope
  cross join lateral pg_temp.create_scoped('', scope.default_factory_id)
$$, 'P0005', 'This creation request was already used for different session input',
  'a durable request cannot be replayed into a different factory');

select public.archive_factory(scope.workspace_id, scope.factory_id, scope.owner_user_id, null)
from browser_factory_scope scope;
select throws_ok($$
  select * from browser_factory_scope scope
  cross join lateral pg_temp.create_scoped(scope.digest, scope.factory_id, null, gen_random_uuid())
$$, 'P0011', 'Factory is archived.', 'a fresh request cannot create in an archived factory');
select is((select count(*) from public.sessions where title = 'Scoped browser proof'), 1::bigint,
  'only the accepted request created work');

select * from finish();
rollback;
