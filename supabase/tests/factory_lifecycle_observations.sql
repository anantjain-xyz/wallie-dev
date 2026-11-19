begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '59010000-0000-4000-8000-000000000001';

create function pg_temp.lifecycle_id(slot integer) returns uuid language sql immutable as $$
  select ('59010000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

select public.set_git_continuity_release(true, revision, 'Analytics lifecycle fixture')
from public.get_git_continuity_release_state() where not enabled;
-- Leave existing queued work outside both claims. All fixture changes roll back.
update public.agent_jobs set scheduled_at = now() + interval '1 day' where status = 'queued';

insert into auth.users(id, email)
values (pg_temp.lifecycle_id(1), 'analytics-lifecycle-owner@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.lifecycle_id(2), 'analytics-lifecycle-fixture', 'Analytics lifecycle');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.lifecycle_id(3), pg_temp.lifecycle_id(2), pg_temp.lifecycle_id(1), 'human', 'owner');
create temp table sibling_factory as select * from public.create_factory(
  pg_temp.lifecycle_id(2), pg_temp.lifecycle_id(1), 'Other analytics factory', 'other-analytics');

create function pg_temp.lifecycle_factory() returns uuid language sql stable as $$
  select id from public.factories where workspace_id = pg_temp.lifecycle_id(2) and is_default
$$;

insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
values (pg_temp.lifecycle_id(4), pg_temp.lifecycle_id(2), pg_temp.lifecycle_factory(), 'Analytics pipeline', true);
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name, prompt_template_md, anyone_can_approve)
values (pg_temp.lifecycle_id(5), pg_temp.lifecycle_id(4), pg_temp.lifecycle_id(2), 1,
  'review', 'Review', 'Write the private artifact.', true);
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.lifecycle_id(6), pg_temp.lifecycle_id(2), 59010001, 'https://github.test/installations/59010001', 590100,
  'Organization', 'analytics-fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name, private, html_url, default_branch)
values (pg_temp.lifecycle_id(7), pg_temp.lifecycle_id(2), pg_temp.lifecycle_factory(), pg_temp.lifecycle_id(6), 59010007,
  'analytics', 'fixture/analytics', true, 'https://github.test/fixture/analytics', 'main');
insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential)
values (pg_temp.lifecycle_id(1), 'platform_api_key', 'never-project-private-lifecycle-credential');
insert into public.workspace_sandbox_settings(workspace_id, active_provider)
values (pg_temp.lifecycle_id(2), 'e2b')
on conflict (workspace_id) do update set active_provider = excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id, encrypted_api_key)
values (pg_temp.lifecycle_id(2), 'never-project-private-lifecycle-sandbox');
create temp table lifecycle_policy as select * from public.save_execution_policy(
  pg_temp.lifecycle_id(2), pg_temp.lifecycle_id(1), 0,
  '{"version":1,"maxRepairAttempts":3,"maxExecutionMs":3600000,"maxTotalTokens":null,"maxCostUsd":null}');

with admitted as (
  select jsonb_build_object('schemaVersion', 1, 'kind', 'serial', 'sandboxProvider', 'e2b',
    'pipelineId', pg_temp.lifecycle_id(4), 'repositoryId', pg_temp.lifecycle_id(7),
    'executionPolicyRevisionId', policy.id, 'deliveryPolicyRevisionId', null,
    'skillIds', '[]'::jsonb, 'toolIds', '[]'::jsonb, 'operatingRulesMd', '', 'operatingRuleStageIds', '[]'::jsonb,
    'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5', 'effort', null,
      'concurrencyLimit', 1, 'stallTimeoutMs', 900000, 'maxRetries', 3, 'maxTurns', 5),
    'implementationAgent', jsonb_build_object('agentId', agent.id, 'promptRevisionId', prompt.id,
      'promptMd', prompt.prompt_md, 'promptSha256', prompt.prompt_sha256),
    'stages', jsonb_build_array(jsonb_build_object('id', pg_temp.lifecycle_id(5), 'slug', 'review', 'name', 'Review',
      'description', '', 'promptTemplateMd', 'Write the private artifact.', 'anyoneCanApprove', true,
      'previousStageIds', '[]'::jsonb, 'approverMemberIds', '[]'::jsonb)))::text body
  from lifecycle_policy policy cross join public.factory_agents agent
  join public.factory_agent_prompt_revisions prompt on prompt.agent_id = agent.id
  where agent.factory_id = pg_temp.lifecycle_factory() and agent.is_default and prompt.revision_number = 1
), revision as (
  insert into public.factory_definition_revisions(workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by)
  select pg_temp.lifecycle_id(2), pg_temp.lifecycle_factory(), 1, body,
    encode(sha256(convert_to(body, 'UTF8')), 'hex'), pg_temp.lifecycle_id(1)
  from admitted returning *
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 1, pg_temp.lifecycle_id(1) from revision;

create function pg_temp.create_lifecycle_session(slot integer)
returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language sql as $$
  select created.* from public.factory_definition_revisions revision
  cross join lateral public.create_session_command_once(
    pg_temp.lifecycle_id(2), pg_temp.lifecycle_id(3), pg_temp.lifecycle_id(slot), repeat('a', 64),
    revision.canonical_digest, 'Never-project-private-lifecycle-title', 'Never-project-private-lifecycle-prompt',
    'codex', 'gpt-5.5', '{}', target_factory_id => pg_temp.lifecycle_factory()) created
  where revision.factory_id = pg_temp.lifecycle_factory()
$$;

create temp table lifecycle_session as select * from pg_temp.create_lifecycle_session(101);
select results_eq(
  'select session_id, job_id, run_id from pg_temp.create_lifecycle_session(101)',
  'select session_id, job_id, run_id from lifecycle_session',
  'replaying the real creation command returns its original session and execution');
select is((select count(*) from internal.factory_outcome_observations
  where session_id = (select session_id from lifecycle_session) and event_type = 'session.created'),
  1::bigint, 'committed creation produces one observation without event subscribers');
select ok((select fact.workspace_id = s.workspace_id and fact.factory_id = s.factory_id
    and fact.definition_revision_id = s.factory_definition_revision_id
    and fact.repository_id = s.github_repository_id and fact.actor_member_id = s.creator_member_id
    and fact.actor_service_principal_id is null and fact.occurred_at = s.created_at
    and fact.observed_at >= fact.occurred_at and fact.source_kind = 'session'
    and fact.source_key = s.id::text and fact.capture_mode = 'live'
  from internal.factory_outcome_observations fact join public.sessions s on s.id = fact.session_id
  join lifecycle_session sample on sample.session_id = s.id
  where fact.event_type = 'session.created'), 'creation records the exact actor, factory, pinned definition and source time');

-- An abandoned session transaction discards both the source state and its observations.
savepoint abandoned_creation;
create temp table abandoned_lifecycle_session as select * from pg_temp.create_lifecycle_session(102);
rollback to savepoint abandoned_creation;
select is((select count(*) from public.sessions where workspace_id = pg_temp.lifecycle_id(2)), 1::bigint,
  'rolling back the command leaves only the accepted session');
select is((select count(*) from internal.factory_outcome_observations
  where workspace_id = pg_temp.lifecycle_id(2) and event_type in ('session.created', 'job.queued')),
  2::bigint, 'rolling back the command removes the session and queue observations together');

create temp table daemon_claim as select * from public.claim_next_agent_job();
select is((select id from daemon_claim), (select job_id from lifecycle_session), 'daemon claims the exact queued job');
create temp table daemon_run as select public.start_session_job_attempt(
  id, attempt_count, stage_id, 0, 'codex', 'gpt-5.5', 'project') id from daemon_claim;
select ok((select id is not null from daemon_run), 'daemon starts the exact admitted attempt');
select is((select public.fail_session_job_attempt(claim.id, claim.attempt_count, 'never-project-private-failure',
    true, 3, run.id) from daemon_claim claim cross join daemon_run run),
  'queued', 'a real failure settles attempt one and durably requeues the same job');
select is((select public.fail_session_job_attempt(claim.id, claim.attempt_count, 'never-project-private-replay',
    true, 3, run.id) from daemon_claim claim cross join daemon_run run),
  'stale', 'repeating a settled failure cannot create another timeline observation');
-- Make the queued repair due without changing its transition identity.
update public.agent_jobs set scheduled_at = null where id = (select job_id from lifecycle_session);

create temp table native_claim as select * from public.claim_next_worker_dispatch(100, 2, 1800000);
select ok((select job_id = (select job_id from lifecycle_session) and attempt_count = 2 from native_claim),
  'native dispatch claims the next attempt of the same job');
select ok((select public.begin_worker_dispatch(job_id, attempt_count, workflow_id) from native_claim),
  'native dispatch begins once');
select ok(not (select public.begin_worker_dispatch(job_id, attempt_count, workflow_id) from native_claim),
  'replaying the native dispatch cannot start another execution');
create temp table native_run as select public.start_session_job_attempt(
  job_id, attempt_count, pg_temp.lifecycle_id(5), 0, 'codex', 'gpt-5.5', 'project') id from native_claim;
select ok((select public.publish_session_job_attempt(claim.job_id, claim.attempt_count, run.id, 0,
    'Never-project-private-lifecycle-artifact') from native_claim claim cross join native_run run),
  'native attempt publishes through the same exact transition boundary');
select ok((select public.complete_session_job_attempt(claim.job_id, claim.attempt_count, run.id)
  from native_claim claim cross join native_run run), 'the worker settles the exact published native job');

select results_eq($q$
  select attempt_count, source_key from internal.factory_outcome_observations
  where session_id = (select session_id from lifecycle_session) and event_type = 'job.queued'
  order by attempt_count
$q$, $q$
  select attempt, job_id::text || ':' || attempt::text
  from lifecycle_session cross join (values (1), (2)) attempts(attempt) order by attempt
$q$, 'initial admission and retry record exactly two queue intervals for the same job');
select results_eq($q$
  select event_type::text, fact.run_id, fact.attempt_count, fact.status::text, fact.occurred_at
  from internal.factory_outcome_observations fact
  where session_id = (select session_id from lifecycle_session) and event_type in ('run.started', 'run.finished')
  order by fact.attempt_count, event_type::text
$q$, $q$
  select expected.event_type, run.id, run.attempt_count, expected.status, expected.occurred_at
  from public.agent_runs run
  cross join lateral (values ('run.started', 'running', run.started_at),
    ('run.finished', run.status::text, run.finished_at)) expected(event_type, status, occurred_at)
  where run.id in ((select id from daemon_run), (select id from native_run))
  order by run.attempt_count, expected.event_type
$q$, 'daemon and native use one exact observation contract for starts and finishes');
select ok((select fact.artifact_id = s.current_artifact_id and fact.run_id = (select id from native_run)
  and fact.attempt_count = 2 and fact.stage_id = s.current_stage_id
  from internal.factory_outcome_observations fact join public.sessions s on s.id = fact.session_id
  where fact.session_id = (select session_id from lifecycle_session) and fact.event_type = 'review.ready'),
  'review readiness points to the exact artifact and producing attempt once');
select ok((select fact.source_key = job.id::text || ':2' and fact.attempt_count = 2
    and fact.status = 'success' and fact.occurred_at = job.finished_at
  from internal.factory_outcome_observations fact join public.agent_jobs job on job.id = fact.job_id
  where fact.session_id = (select session_id from lifecycle_session) and fact.event_type = 'job.finished'),
  'the terminal job observation uses the exact job and attempt after publication');

select is((select count(*) from public.sessions s cross join lateral public.approve_session_stage(
    s.id, s.workspace_id, s.current_stage_id, s.current_artifact_id, s.current_artifact_version,
    pg_temp.lifecycle_id(3), 'codex', 'gpt-5.5', 'project', s.artifact_review_revision)
  where s.id = (select session_id from lifecycle_session)), 1::bigint, 'the normal human approval succeeds');
select is((select count(*) from internal.factory_outcome_observations
  where session_id = (select session_id from lifecycle_session) and event_type = 'review.approved'
    and actor_member_id = pg_temp.lifecycle_id(3) and actor_service_principal_id is null and status = 'approved'),
  1::bigint, 'the final approval records its exact human actor and resulting phase');

create temp table canceled_lifecycle_session as select * from pg_temp.create_lifecycle_session(103);
select public.cancel_session_command_once(pg_temp.lifecycle_id(2), pg_temp.lifecycle_factory(), pg_temp.lifecycle_id(3),
  session_id, pg_temp.lifecycle_id(104), repeat('b', 64), run_id) from canceled_lifecycle_session;
select public.cancel_session_command_once(pg_temp.lifecycle_id(2), pg_temp.lifecycle_factory(), pg_temp.lifecycle_id(3),
  session_id, pg_temp.lifecycle_id(104), repeat('b', 64), run_id) from canceled_lifecycle_session;
select is((select count(*) from internal.factory_outcome_observations
  where session_id = (select session_id from canceled_lifecycle_session) and event_type = 'session.canceled'
    and actor_member_id = pg_temp.lifecycle_id(3)),
  1::bigint, 'the cancellation receipt and request identify the same actor-attributed occurrence');

select ok(not exists(select 1 from internal.factory_outcome_observations
  where workspace_id = pg_temp.lifecycle_id(2) and factory_id is distinct from pg_temp.lifecycle_factory()),
  'all lifecycle families preserve the authoritative tenant tuple');
select throws_ok($q$
  insert into internal.factory_outcome_observations(
    workspace_id, factory_id, event_type, source_kind, source_key, occurred_at, capture_mode, session_id
  )
  select pg_temp.lifecycle_id(2), sibling.id, 'session.created', 'session',
    session.session_id::text, clock_timestamp(), 'live', session.session_id
  from lifecycle_session session cross join sibling_factory sibling
$q$, '23503', null, 'an observation cannot attach its session to another factory in the same workspace');
select throws_ok($q$
  update internal.factory_outcome_observations set occurred_at = clock_timestamp()
  where session_id = (select session_id from lifecycle_session)
$q$, '23514', 'Factory outcome observations are immutable.', 'even privileged ingestion cannot edit recorded source times');
select ok(not exists(select 1 from internal.factory_outcome_observations fact
  where workspace_id = pg_temp.lifecycle_id(2) and to_jsonb(fact)::text ~* 'never-project-private'),
  'raw user text, provider errors and credentials stay outside product analytics');
select ok((select relrowsecurity from pg_class where oid = 'internal.factory_outcome_observations'::regclass)
  and not has_table_privilege('anon', 'internal.factory_outcome_observations', 'select,insert')
  and not has_table_privilege('authenticated', 'internal.factory_outcome_observations', 'select,insert,update,delete')
  and not has_table_privilege('service_role', 'internal.factory_outcome_observations', 'select,insert,update,delete'),
  'raw analytics observations stay outside the browser and unbounded service-role table access');

create temp table captured_coverage as select live_from
from internal.factory_outcome_capture_coverage where source = 'lifecycle';
select ok((select live_from <= clock_timestamp() from captured_coverage), 'live coverage starts at the capture cutover');

-- Install one historical source row as it could exist before the hook deploys.
alter table public.sessions disable trigger capture_factory_outcome_session_created;
insert into public.sessions(id, workspace_id, factory_id, number, title, prompt_md, pipeline_id, current_stage_id,
  creator_member_id, github_repository_id, phase_status, execute_pinned_definition, created_at)
values (pg_temp.lifecycle_id(201), pg_temp.lifecycle_id(2), pg_temp.lifecycle_factory(), 201,
  'Never-project-private-historical-title', 'Never-project-private-historical-prompt',
  pg_temp.lifecycle_id(4), pg_temp.lifecycle_id(5), pg_temp.lifecycle_id(3), pg_temp.lifecycle_id(7),
  'in_progress', false, '2026-01-01T00:00:00Z'::timestamptz);
alter table public.sessions enable trigger capture_factory_outcome_session_created;

select is((select source_rows from internal.backfill_factory_outcome_observations(
  pg_temp.lifecycle_id(2), pg_temp.lifecycle_factory(), 'session.created', '2026-02-01T00:00:00Z'::timestamptz)),
  1, 'the historical repair finds the one independently evidenced creation');
select is((select source_rows from internal.backfill_factory_outcome_observations(
  pg_temp.lifecycle_id(2), pg_temp.lifecycle_factory(), 'session.created', '2026-02-01T00:00:00Z'::timestamptz)),
  1, 'replaying that backfill page sees the same original source');
select results_eq($q$
  select event_type, occurred_at, capture_mode, stage_id, definition_revision_id, actor_member_id
  from internal.factory_outcome_observations where session_id = pg_temp.lifecycle_id(201)
$q$, $q$
  values ('session.created'::text, '2026-01-01T00:00:00Z'::timestamptz, 'backfill'::text,
    null::uuid, null::uuid, pg_temp.lifecycle_id(3))
$q$, 'an exact historical creation does not infer a queue, stage interval or pinned configuration from current state');
select is((select live_from from internal.factory_outcome_capture_coverage where source = 'lifecycle'),
  (select live_from from captured_coverage), 'recovering a historical point never moves the coverage boundary');

select results_eq($q$
  select metric_key, definition ->> 'missingBounds'
  from internal.factory_outcome_metric_revisions where revision = 1
    and metric_key in ('request_to_deployment', 'request_to_merge', 'workflow_flow')
  order by metric_key
$q$, $q$values ('request_to_deployment', 'censored'), ('request_to_merge', 'censored'), ('workflow_flow', 'unknown')$q$,
  'published metrics distinguish unknown flow boundaries from censored delivery samples');
select throws_ok($q$
  update internal.factory_outcome_metric_revisions set definition = '{"unit":"days"}'
  where metric_key = 'request_to_merge' and revision = 1
$q$, '23514', 'Factory outcome metric revisions are immutable.', 'changing a metric requires a new revision');
select throws_ok($q$
  insert into internal.factory_outcome_projection_watermarks(
    workspace_id, factory_id, metric_key, metric_revision, last_attempt_at, status
  ) values (pg_temp.lifecycle_id(2), pg_temp.lifecycle_factory(), 'request_to_merge', 1, clock_timestamp(), 'ready')
$q$, '23514', null, 'a projection cannot claim readiness before a successful source snapshot');

-- Repeat admission through the scoped machine command to verify real service attribution.
create temp table lifecycle_principal as select * from public.create_service_principal(
  pg_temp.lifecycle_id(2), pg_temp.lifecycle_factory(), pg_temp.lifecycle_id(1),
  'Lifecycle client', 'lifecycle-client');
create temp table lifecycle_grant as select approved.* from lifecycle_principal principal
cross join lifecycle_policy policy cross join lateral public.approve_factory_execution_grant(
  principal.workspace_id, principal.factory_id, pg_temp.lifecycle_id(1), principal.id, pg_temp.lifecycle_id(7),
  '{}', '{}', policy.id, pg_temp.lifecycle_id(3), clock_timestamp() + interval '1 hour',
  0, null, '{sessions:create}'::public.factory_command_scope[]) approved;
insert into public.workspace_secrets(id, workspace_id, key, encrypted_value)
values (pg_temp.lifecycle_id(301), pg_temp.lifecycle_id(2), 'LIFECYCLE_AGENT_KEY', 'never-project-private-machine-key');
create temp table lifecycle_machine_agent as select id
from public.factory_agents where factory_id = pg_temp.lifecycle_factory() and is_default;
create temp table lifecycle_binding as select binding.* from lifecycle_grant approved cross join lifecycle_machine_agent agent
cross join lateral public.create_factory_secret_binding(
  approved.workspace_id, approved.factory_id, pg_temp.lifecycle_id(1), approved.id, approved.version,
  agent.id, 'codex', pg_temp.lifecycle_id(301)
) binding;
with machine_definition as (
  select human.workspace_id, human.factory_id, (human.definition_json::jsonb ||
    jsonb_build_object('credentialBindingId', binding.id,
      'executionGrant', jsonb_build_object('id', approved.id, 'version', approved.version)))::text body
  from public.factory_definition_revisions human cross join lifecycle_grant approved cross join lifecycle_binding binding
  where human.factory_id = pg_temp.lifecycle_factory()
), machine_revision as (
  insert into public.factory_definition_revisions(workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by)
  select workspace_id, factory_id, 1, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), pg_temp.lifecycle_id(1)
  from machine_definition returning *
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 2, pg_temp.lifecycle_id(1) from machine_revision;

select public.issue_factory_machine_token(workspace_id, factory_id, pg_temp.lifecycle_id(1), id, version,
  pg_temp.lifecycle_id(302), repeat('d', 64), 'Lifecycle command', '{sessions:create}') from lifecycle_grant;
create temp table lifecycle_machine_permit as select * from public.admit_factory_command(
  pg_temp.lifecycle_id(2), pg_temp.lifecycle_factory(), 'machine_token', pg_temp.lifecycle_id(302),
  repeat('d', 64), 'sessions:create', pg_temp.lifecycle_id(303), repeat('e', 64), 'api');
create temp table lifecycle_machine_session as
with command as (
  select public.execute_factory_session_mutation(permit.workspace_id, permit.factory_id,
    'machine_token', pg_temp.lifecycle_id(302), repeat('d', 64), pg_temp.lifecycle_id(303), repeat('e', 64),
    'api', permit.admission_id, permit.lease_id, 'create', pg_temp.lifecycle_id(304),
    jsonb_build_object('title', 'Never-project-private-machine-title', 'prompt', 'Never-project-private-machine-prompt',
      'agentId', agent.id, 'repositoryId', pg_temp.lifecycle_id(7), 'draftSpecification', true)
  ) receipt from lifecycle_machine_permit permit cross join lifecycle_machine_agent agent
)
select (receipt->>'sessionId')::uuid session_id, (receipt->>'jobId')::uuid job_id from command;
select public.release_factory_command_admission(admission_id, lease_id) from lifecycle_machine_permit;
set constraints capture_factory_outcome_machine_job_queued immediate;
create temp table lifecycle_machine_claim as select * from public.claim_next_agent_job();
select ok((select claim.id = command.job_id and public.start_session_job_attempt(
    claim.id, claim.attempt_count, claim.stage_id, 0, 'codex', 'gpt-5.5', 'project') is not null
  from lifecycle_machine_claim claim cross join lifecycle_machine_session command),
  'a job admitted through the machine command starts normally');
select results_eq($q$
  select event_type, actor_member_id, actor_service_principal_id
  from internal.factory_outcome_observations
  where session_id = (select session_id from lifecycle_machine_session)
    and event_type in ('job.queued', 'run.started', 'session.created')
  order by event_type
$q$, $q$
  select kind, null::uuid, principal.id
  from lifecycle_principal principal cross join (values ('job.queued'), ('run.started'), ('session.created')) expected(kind)
  order by kind
$q$, 'deferred and live facts retain the invoking service principal without borrowing its human budget payer');

select * from finish();
rollback;
