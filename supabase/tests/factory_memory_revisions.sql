begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.memory_fixture_id(slot integer) returns uuid language sql immutable as $$
  select ('58100000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
set local request.jwt.claim.sub = '58100000-0000-4000-8000-000000000001';
select public.set_git_continuity_release(true, revision, 'Factory memory fixture')
from internal.git_continuity_release_control;

insert into auth.users(id, email) values
  (pg_temp.memory_fixture_id(1), 'memory-fixture-owner@example.test'),
  (pg_temp.memory_fixture_id(2), 'memory-fixture-manager@example.test'),
  (pg_temp.memory_fixture_id(3), 'memory-fixture-member@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.memory_fixture_id(4), 'memory-fixture', 'Factory memory'),
  (pg_temp.memory_fixture_id(5), 'other-memory-fixture', 'Other workspace');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.memory_fixture_id(6), pg_temp.memory_fixture_id(4), pg_temp.memory_fixture_id(1), 'human', 'owner'),
  (pg_temp.memory_fixture_id(7), pg_temp.memory_fixture_id(4), pg_temp.memory_fixture_id(2), 'human', 'member'),
  (pg_temp.memory_fixture_id(8), pg_temp.memory_fixture_id(4), pg_temp.memory_fixture_id(3), 'human', 'member'),
  (pg_temp.memory_fixture_id(9), pg_temp.memory_fixture_id(5), pg_temp.memory_fixture_id(1), 'human', 'owner');

create function pg_temp.memory_factory() returns uuid language sql stable as $$
  select id from public.factories where workspace_id = pg_temp.memory_fixture_id(4) and is_default
$$;
create temp table sibling_memory_factory as
select * from public.create_factory(pg_temp.memory_fixture_id(4), pg_temp.memory_fixture_id(1), 'Other memory', 'other-memory');
select public.grant_factory_membership(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(), pg_temp.memory_fixture_id(1),
  pg_temp.memory_fixture_id(7), 'manager');

insert into public.pipelines(id, workspace_id, factory_id, name, is_default) values
  (pg_temp.memory_fixture_id(10), pg_temp.memory_fixture_id(4), pg_temp.memory_factory(), 'Memory', true);
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name, prompt_template_md, anyone_can_approve) values
  (pg_temp.memory_fixture_id(11), pg_temp.memory_fixture_id(10), pg_temp.memory_fixture_id(4), 1, 'draft', 'Draft', 'Draft knowledge', true);
insert into public.github_installations(id, workspace_id, installation_id, installation_url,
  app_id, target_type, target_name, permissions) values
  (pg_temp.memory_fixture_id(12), pg_temp.memory_fixture_id(4), 58100001, 'https://github.test/installations/58100001',
   58100, 'Organization', 'memory-fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id,
  repo_id, name, full_name, private, html_url, default_branch) values
  (pg_temp.memory_fixture_id(13), pg_temp.memory_fixture_id(4), pg_temp.memory_factory(), pg_temp.memory_fixture_id(12),
   581001, 'memory', 'fixture/memory', true, 'https://github.test/fixture/memory', 'main');
insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential)
values (pg_temp.memory_fixture_id(1), 'platform_api_key', 'test-only');
insert into public.workspace_sandbox_settings(workspace_id, active_provider)
values (pg_temp.memory_fixture_id(4), 'e2b') on conflict (workspace_id) do update set active_provider = excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id, encrypted_api_key)
values (pg_temp.memory_fixture_id(4), 'test-only');

with policy as (
  select * from public.save_execution_policy(pg_temp.memory_fixture_id(4), pg_temp.memory_fixture_id(1), 0,
    '{"version":1,"maxRepairAttempts":5,"maxExecutionMs":3600000,"maxTotalTokens":null,"maxCostUsd":null}')
), definition as (
  select jsonb_build_object('schemaVersion',1,'kind','serial','sandboxProvider','e2b',
    'pipelineId',pg_temp.memory_fixture_id(10),'repositoryId',pg_temp.memory_fixture_id(13),'executionPolicyRevisionId',policy.id,
    'deliveryPolicyRevisionId',null,'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,
    'operatingRulesMd','','operatingRuleStageIds','[]'::jsonb,
    'agent',jsonb_build_object('provider','codex','model','gpt-5.5','effort',null,
      'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
    'implementationAgent',jsonb_build_object('agentId',agent.id,'promptRevisionId',prompt.id,
      'promptMd',prompt.prompt_md,'promptSha256',prompt.prompt_sha256),
    'stages',jsonb_build_array(jsonb_build_object('id',pg_temp.memory_fixture_id(11),'slug','draft','name','Draft',
      'description','','promptTemplateMd','Draft knowledge','anyoneCanApprove',true,
      'previousStageIds','[]'::jsonb,'approverMemberIds','[]'::jsonb)))::text bytes
  from public.factory_agents agent join public.factory_agent_prompt_revisions prompt on prompt.agent_id = agent.id
  cross join policy
  where agent.factory_id = pg_temp.memory_factory() and agent.is_default and prompt.revision_number = 1
), revision as (
  insert into public.factory_definition_revisions(workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by)
  select pg_temp.memory_fixture_id(4), pg_temp.memory_factory(), 1, bytes, encode(sha256(convert_to(bytes,'UTF8')),'hex'),
    pg_temp.memory_fixture_id(1) from definition returning *
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 1, pg_temp.memory_fixture_id(1) from revision;

create temp table memory_stage_results(slot integer primary key, job_id uuid, run_id uuid, staged boolean);

create function pg_temp.publish_memory_source(p_slot integer, p_markdown text, p_body text,
  p_artifact_sha256 text default null, p_context_version integer default 2, p_publish boolean default true)
returns uuid language plpgsql as $$
declare target record;
declare started_run uuid;
declare claim uuid;
declare frozen jsonb;
declare staged boolean;
begin
  select created.* into strict target from public.factory_definition_revisions revision
  cross join lateral public.create_session_command_once(pg_temp.memory_fixture_id(4), pg_temp.memory_fixture_id(6),
    gen_random_uuid(), encode(sha256(convert_to(p_markdown,'UTF8')),'hex'),
    revision.canonical_digest, 'Produce fixture knowledge', 'Capture a proposal.', 'codex', 'gpt-5.5', '{}',
    target_factory_id => pg_temp.memory_factory(), draft_specification => true) created
  where revision.factory_id = pg_temp.memory_factory();
  update public.agent_jobs set status = 'running', attempt_count = 1,
    git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()) where id = target.job_id;
  started_run := public.start_session_job_attempt(target.job_id, 1, pg_temp.memory_fixture_id(11), 0,
    'codex', 'gpt-5.5', 'code', 'wallie/memory-fixture-' || target.job_id::text);
  if started_run is null or not exists(select 1 from public.pin_session_job_git_input(
    target.job_id, 1, started_run, pg_temp.memory_fixture_id(13), 'main', repeat('a',40))) then
    raise exception 'Memory fixture did not pin source';
  end if;
  if p_context_version is not null then
    frozen := jsonb_build_object('version', p_context_version, 'required', jsonb_build_array(), 'documents', jsonb_build_array(),
      'conversation', jsonb_build_object('throughSequence',0,'olderOmitted',0,'messages',jsonb_build_array()),
      'budget', jsonb_build_object('maxUtf8Bytes',131072,'maxEstimatedTokens',32768,'usedUtf8Bytes',0,'estimatedTokens',0));
    if p_context_version = 2 then frozen := frozen || jsonb_build_object('memories',jsonb_build_array()); end if;
    perform public.pin_factory_run_context(pg_temp.memory_fixture_id(4), target.job_id, started_run, 1, frozen);
  end if;
  if p_body is not null then
    staged := public.stage_factory_run_memory_proposal(pg_temp.memory_fixture_id(4), target.job_id, started_run, 1,
      coalesce(p_artifact_sha256, encode(sha256(convert_to(p_markdown, 'UTF8')), 'hex')), p_body);
  end if;
  insert into memory_stage_results values (p_slot, target.job_id, started_run, staged);
  if not p_publish then return started_run; end if;
  if not public.prepare_session_source_and_checkpoint_publication(started_run, pg_temp.memory_fixture_id(13), 'main',
    repeat('a',40), repeat('a',40), 'Fixture spec', 'Fixture source', '', '', '', 0, p_markdown) then
    raise exception 'Memory fixture did not prepare publication';
  end if;
  claim := public.claim_session_checkpoint_publication(started_run);
  if not public.adopt_session_checkpoint_publication(started_run, claim) then
    raise exception 'Memory fixture did not adopt publication';
  end if;
  return started_run;
end;
$$;

create temp table memory_sources as
select slot, markdown, pg_temp.publish_memory_source(slot, markdown, body, artifact_sha256, context_version, publish) run_id
from (values
  (1, 'Published release notes', 'Keep release notes current.', null, 2, true),
  (2, 'The candidate could not be bound to this exact published artifact.', 'Wrong artifact candidate.', repeat('d',64), 2, true),
  (3, 'A run with the previous context version', 'Candidate with v1 context.', null, 1, true),
  (4, '<!-- wallie-memory -->Published legacy markers are not a proposal.<!-- /wallie-memory -->', null, null, 2, true),
  (5, 'Published output with an expiring note', 'This short-lived knowledge expires.', null, 2, true),
  (6, 'Published output with an expiring proposed note', 'Pending approval expires too.', null, 2, true),
  (7, 'Published output with no proposal', null, null, 2, true),
  (8, 'Pending output', 'A still-running agent proposal.', null, 2, false),
  (9, 'Run with no manifest', 'A proposal with no manifest.', null, null, false)
) fixture(slot, markdown, body, artifact_sha256, context_version, publish);
create temp table memory_artifacts as
select source.slot, source.markdown, checkpoint.artifact_id, checkpoint.run_id, checkpoint.session_id
from memory_sources source join public.session_git_checkpoints checkpoint on checkpoint.run_id = source.run_id;
insert into public.session_artifacts (id, workspace_id, session_id, stage_id, stage_slug, version, artifact_json)
select pg_temp.memory_fixture_id(30), pg_temp.memory_fixture_id(4), session_id, pg_temp.memory_fixture_id(11), 'draft', 2,
  to_jsonb('<!-- wallie-memory -->Unverified fake proposal.<!-- /wallie-memory -->'::text)
from memory_artifacts where slot = 1;
insert into public.session_artifacts (id, workspace_id, session_id, stage_id, stage_slug, version, artifact_json)
select pg_temp.memory_fixture_id(31), pg_temp.memory_fixture_id(4), run.session_id, pg_temp.memory_fixture_id(11), 'draft', 1,
  to_jsonb(source.markdown)
from memory_sources source join public.agent_runs run on run.id = source.run_id where source.slot = 8;
grant select on memory_artifacts, sibling_memory_factory to authenticated;

select ok((select staged from memory_stage_results where slot = 1), 'the active v2 run can stage a bounded private proposal');
select ok((select staged is false from memory_stage_results where slot = 3), 'a previous-version frozen context cannot stage proposals');
select ok((select staged is false from memory_stage_results where slot = 9), 'a run with no frozen context cannot stage proposals');
select ok((select public.stage_factory_run_memory_proposal(pg_temp.memory_fixture_id(4), job_id, run_id, 1,
    encode(sha256(convert_to('Pending output','UTF8')), 'hex'), 'A still-running agent proposal.')
  from memory_stage_results where slot = 8), 'an exact live ownership retry is idempotent');
select ok((select not public.stage_factory_run_memory_proposal(pg_temp.memory_fixture_id(4), job_id, run_id, 1,
    repeat('e',64), 'A still-running agent proposal.') from memory_stage_results where slot = 8),
  'the worker cannot replace a previously staged artifact digest');
select ok((select not public.stage_factory_run_memory_proposal(pg_temp.memory_fixture_id(4), job_id, run_id, 1,
    encode(sha256(convert_to('Pending output','UTF8')), 'hex'), 'Changed candidate.')
  from memory_stage_results where slot = 8), 'the worker cannot replace the existing private body on the same run');
select throws_ok($$
  select public.stage_factory_run_memory_proposal(pg_temp.memory_fixture_id(4), job_id, run_id, 2, repeat('e',64), 'Wrong attempt.')
  from memory_stage_results where slot = 8
$$, '42501', null, 'a different attempt cannot stage or overwrite the note');
select throws_ok($$
  select public.stage_factory_run_memory_proposal(pg_temp.memory_fixture_id(4), job_id,
    (select run_id from memory_stage_results where slot = 9), 1, repeat('e',64), 'Wrong run.')
  from memory_stage_results where slot = 8
$$, '42501', null, 'a different run cannot stage or overwrite the note');
select throws_ok($$
  select public.stage_factory_run_memory_proposal(pg_temp.memory_fixture_id(5), job_id, run_id, 1, repeat('e',64), 'Wrong tenant.')
  from memory_stage_results where slot = 8
$$, '42501', null, 'a cross-tenant worker claim cannot stage or overwrite the note');
select throws_ok($$
  select public.stage_factory_run_memory_proposal(pg_temp.memory_fixture_id(4), job_id, run_id, 1, repeat('e',64), repeat('é',2049))
  from memory_stage_results where slot = 8
$$, '22023', null, 'the private body cap measures UTF-8 bytes');
select throws_ok($$
  select public.stage_factory_run_memory_proposal(pg_temp.memory_fixture_id(4), job_id, run_id, 1, 'invalid', 'Private note.')
  from memory_stage_results where slot = 8
$$, '22023', null, 'a proposed note requires a valid full artifact digest');
select throws_ok($$
  select public.stage_factory_run_memory_proposal(pg_temp.memory_fixture_id(4), job_id, run_id, 1, repeat('e',64), E' \n')
  from memory_stage_results where slot = 8
$$, '22023', null, 'a private proposal body must contain content');

create function pg_temp.propose_memory(p_slot integer, p_version integer default 1, p_expires_at timestamptz default null)
returns public.factory_memories language sql as $$
  select public.propose_factory_memory(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(), artifact_id, p_version,
    case when p_slot = 1 then 'Synthetic private title canary 70851' else 'Release practice' end,
    p_expires_at) from memory_artifacts where slot = p_slot
$$;

select ok(has_function_privilege('authenticated', 'public.propose_factory_memory(uuid,uuid,uuid,integer,text,timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.propose_factory_memory(uuid,uuid,uuid,integer,text,timestamptz)', 'execute')
  and not has_function_privilege('service_role', 'public.propose_factory_memory(uuid,uuid,uuid,integer,text,timestamptz)', 'execute')
  and not has_function_privilege('service_role', 'public.review_factory_memory(uuid,uuid,uuid,text,uuid,uuid)', 'execute')
  and not has_table_privilege('authenticated', 'public.factory_memory_revision_bodies', 'insert')
  and not has_table_privilege('service_role', 'public.factory_memory_revision_bodies', 'select'),
  'the human lifecycle is authenticated-only, the service cannot auto-approve, and raw writes are private');
select ok(has_function_privilege('service_role', 'public.stage_factory_run_memory_proposal(uuid,uuid,uuid,integer,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.stage_factory_run_memory_proposal(uuid,uuid,uuid,integer,text,text)', 'execute')
  and not has_table_privilege('service_role', 'internal.factory_run_memory_proposals', 'select')
  and not has_table_privilege('authenticated', 'internal.factory_run_memory_proposals', 'select'),
  'staged proposal text is private even when the worker and manager can use their scoped RPCs');
select ok(has_function_privilege('service_role', 'public.read_factory_memory_context(uuid,uuid,uuid[])', 'execute')
  and not has_function_privilege('authenticated', 'public.read_factory_memory_context(uuid,uuid,uuid[])', 'execute')
  and not has_function_privilege('anon', 'public.read_factory_memory_context(uuid,uuid,uuid[])', 'execute'),
  'prompt retrieval is service-only');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '58100000-0000-4000-8000-000000000003';
select throws_ok($$select pg_temp.propose_memory(1)$$, '42501', null, 'ordinary workspace members cannot import proposals');
select throws_ok($$
  select public.has_factory_run_memory_proposal(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(),
    (select artifact_id from memory_artifacts where slot = 1), 1)
$$, '42501', null, 'regular users cannot inspect unpublished proposal availability');
set local request.jwt.claim.sub = '58100000-0000-4000-8000-000000000002';
select throws_ok($$select pg_temp.propose_memory(1, 2)$$, 'P0002', null, 'a mismatched artifact version cannot be chosen');
select throws_ok($$
  select public.propose_factory_memory(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(),
    pg_temp.memory_fixture_id(30), 2, 'Unverified')
$$, 'P0002', null, 'a version with Markdown and no accepted producer checkpoint cannot propose memory');
select throws_ok($$
  select public.propose_factory_memory(pg_temp.memory_fixture_id(4), (select id from sibling_memory_factory),
    (select artifact_id from memory_artifacts where slot = 1), 1, 'Out of scope')
$$, '42501', null, 'delegated managers cannot import into a sibling factory');
set local request.jwt.claim.sub = '58100000-0000-4000-8000-000000000001';
select throws_ok($$
  select public.propose_factory_memory(pg_temp.memory_fixture_id(4), (select id from sibling_memory_factory),
    (select artifact_id from memory_artifacts where slot = 1), 1, 'Out of scope')
$$, 'P0002', null, 'management access to both factories cannot move an artifact across them');
select throws_ok($$
  select public.propose_factory_memory(pg_temp.memory_fixture_id(5),
    (select id from public.factories where workspace_id = pg_temp.memory_fixture_id(5) and is_default),
    (select artifact_id from memory_artifacts where slot = 1), 1, 'Out of scope')
$$, 'P0002', null, 'even an owner of both workspaces cannot import a cross-tenant artifact');
set local request.jwt.claim.sub = '58100000-0000-4000-8000-000000000002';
select throws_ok($$select pg_temp.propose_memory(2)$$, 'P0002', null, 'staged note cannot attach to a mismatched actual published digest');
select throws_ok($$select pg_temp.propose_memory(3)$$, 'P0002', null, 'a previous-version context cannot be imported');
select throws_ok($$select pg_temp.propose_memory(4)$$, 'P0002', null, 'published artifact markers cannot propose memory');
select throws_ok($$select pg_temp.propose_memory(7)$$, 'P0002', null, 'a successful artifact without a private note cannot propose memory');
select ok(not public.has_factory_run_memory_proposal(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(),
    pg_temp.memory_fixture_id(31), 1), 'a staged note is hidden until the run accepts its exact artifact');
select ok(public.has_factory_run_memory_proposal(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(),
    (select artifact_id from memory_artifacts where slot = 1), 1), 'a manager sees exact proposal availability after accepted publication');
select throws_ok($$select pg_temp.propose_memory(1, 1, clock_timestamp() - interval '1 minute')$$,
  '22023', null, 'a failed import does not consume the original staged proposal');
select ok(public.has_factory_run_memory_proposal(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(),
    (select artifact_id from memory_artifacts where slot = 1), 1), 'failed import preserves the private staging row');
create temp table initial_memory as select * from pg_temp.propose_memory(1);
select ok((select current_revision_id is null and current_approval_id is null and pending_revision_id is not null from initial_memory),
  'import leaves the exact proposal pending for a human decision');
select is((select title from initial_memory), 'Synthetic private title canary 70851',
  'a manager can identify the pending proposal by its supplied title');
select ok((select memory.source_run_id = artifact.run_id and memory.source_artifact_id = artifact.artifact_id
    and memory.source_session_id = artifact.session_id and memory.source_artifact_version = 1
    and memory.source_attempt_count = 1 and memory.source_commit_sha = repeat('a', 40)
    and memory.source_content_sha256 = encode(sha256(convert_to(artifact.markdown, 'UTF8')), 'hex')
  from initial_memory memory cross join memory_artifacts artifact where artifact.slot = 1),
  'source records the exact successful run, session, artifact version, commit, and complete original Markdown digest');
select is((select body_md from public.factory_memory_revision_bodies where revision_id = (select pending_revision_id from initial_memory)),
  'Keep release notes current.', 'import transfers the private note without unrelated published run output');
select ok(not public.has_factory_run_memory_proposal(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(),
    (select artifact_id from memory_artifacts where slot = 1), 1), 'consumed proposals disappear from the availability RPC');
select throws_ok($$select pg_temp.propose_memory(1)$$, 'PT409', null, 'an exact accepted artifact can propose only once');
reset role;
select is((select count(*) from internal.factory_run_memory_proposals where run_id = (select source_run_id from initial_memory)),
  0::bigint, 'successful import atomically removes the staged body copy');
select ok((select not ((artifact.artifact_json #>> '{}') like '%Keep release notes current.%')
  from public.session_artifacts artifact where id = (select source_artifact_id from initial_memory)),
  'the private proposal does not become retained artifact Markdown');
select is((select count(*) from public.read_factory_memory_context(pg_temp.memory_fixture_id(4), pg_temp.memory_factory())),
  0::bigint, 'agent proposals never enter prompts before a human approval');

set local role authenticated;
set local request.jwt.claim.sub = '58100000-0000-4000-8000-000000000003';
select is((select count(*) from public.factory_memories), 0::bigint, 'ordinary members cannot read the manager review queue');
select is((select count(*) from public.factory_memory_revision_bodies), 0::bigint, 'ordinary members cannot read raw memory text');
select throws_ok($$
  select public.review_factory_memory(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(),
    gen_random_uuid(), 'approve', null, gen_random_uuid())
$$, '42501', null, 'ordinary members cannot review any revision');
set local request.jwt.claim.sub = '58100000-0000-4000-8000-000000000001';
select throws_ok($$
  select public.review_factory_memory(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(),
    id, 'approve', null, gen_random_uuid()) from initial_memory
$$, 'PT409', null, 'approval is conditional on the exact pending revision');
create temp table first_approval as
select approved.* from initial_memory memory cross join lateral public.review_factory_memory(memory.workspace_id, memory.factory_id,
  memory.id, 'approve', null, memory.pending_revision_id) approved;
select ok((select first_approval.current_approval_id = event.id and event.action = 'approved'
    and event.actor_member_id = pg_temp.memory_fixture_id(6) and event.revision_id = first_approval.current_revision_id
  from first_approval join public.factory_memory_review_events event on event.id = first_approval.current_approval_id),
  'approval exposes the exact human decision ID and the actor who approved');
reset role;
select is((select body_md from public.read_factory_memory_context(pg_temp.memory_fixture_id(4), pg_temp.memory_factory())),
  'Keep release notes current.', 'fresh retrieval includes the current approved revision');
select ok((select eligible.revision_id = approval.current_revision_id and eligible.approval_id = approval.current_approval_id
    and eligible.content_sha256 = encode(sha256(convert_to(eligible.body_md, 'UTF8')), 'hex')
  from first_approval approval cross join lateral public.read_factory_memory_context(approval.workspace_id, approval.factory_id,
    array[approval.current_revision_id]) eligible),
  'exact retrieval preserves the approved revision, approval ID and body digest');
select is((select count(*) from public.read_factory_memory_context(pg_temp.memory_fixture_id(4), (select id from sibling_memory_factory),
    array[(select current_revision_id from first_approval)])), 0::bigint, 'retrieval never crosses factories');
select is((select count(*) from public.read_factory_memory_context(pg_temp.memory_fixture_id(5), pg_temp.memory_factory(),
    array[(select current_revision_id from first_approval)])), 0::bigint, 'retrieval never crosses tenants');
select is((select count(*) from public.read_factory_memory_context(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(),
    array[]::uuid[])), 0::bigint, 'an empty explicit replay set does not become fresh selection');
select throws_ok($$select * from public.read_factory_memory_context(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(),
    (select array_agg(gen_random_uuid()) from generate_series(1,9)))$$,
  '22023', null, 'exact retrieval limits the calling payload to eight revisions');
select throws_ok($$select * from public.read_factory_memory_context(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(),
    (select array[current_revision_id,current_revision_id] from first_approval))$$,
  '22023', null, 'exact retrieval rejects duplicate IDs');

set local role authenticated;
set local request.jwt.claim.sub = '58100000-0000-4000-8000-000000000002';
create temp table corrected_memory as
select corrected.* from first_approval memory cross join lateral public.correct_factory_memory(memory.workspace_id, memory.factory_id,
  memory.id, 'Keep signed release notes.', memory.current_revision_id, null) corrected;
select ok((select corrected.current_revision_id is null and corrected.pending_revision_id <> revision.supersedes_revision_id
    and revision.supersedes_revision_id = first_approval.current_revision_id and revision.revision_number = 2
  from corrected_memory corrected join public.factory_memory_revisions revision on revision.id = corrected.pending_revision_id
  cross join first_approval),
  'correction creates a new pending revision and explicitly supersedes the former approval');
select throws_ok($$
  select public.correct_factory_memory(workspace_id, factory_id, id, 'Stale correction', current_revision_id, null) from first_approval
$$, 'PT409', null, 'stale correction cannot restore or replace a newer pending revision');
select throws_ok($$
  select public.forget_factory_memory(workspace_id, factory_id, id, current_revision_id, null) from first_approval
$$, 'PT409', null, 'stale forget cannot erase a newer pending revision');
reset role;
select is((select count(*) from public.read_factory_memory_context(pg_temp.memory_fixture_id(4), pg_temp.memory_factory())),
  0::bigint, 'correction immediately stops fresh use of the superseded approval');
select is((select count(*) from public.read_factory_memory_context(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(),
    array[(select current_revision_id from first_approval)])), 0::bigint,
  'superseded revision replay never falls back to another body');

set local role authenticated;
set local request.jwt.claim.sub = '58100000-0000-4000-8000-000000000001';
create temp table rejected_memory as
select reviewed.* from corrected_memory memory cross join lateral public.review_factory_memory(memory.workspace_id, memory.factory_id,
  memory.id, 'reject', memory.current_revision_id, memory.pending_revision_id) reviewed;
select ok((select current_revision_id is null and pending_revision_id is null from rejected_memory),
  'rejecting a correction leaves no approved or pending body and cannot reinstate the old approval');
create temp table next_memory as
select corrected.* from rejected_memory memory cross join lateral public.correct_factory_memory(memory.workspace_id, memory.factory_id,
  memory.id, 'Apply signing to every release.', null, null) corrected;
create temp table next_approval as
select approved.* from next_memory memory cross join lateral public.review_factory_memory(memory.workspace_id, memory.factory_id,
  memory.id, 'approve', null, memory.pending_revision_id) approved;
reset role;
select is((select body_md from public.read_factory_memory_context(pg_temp.memory_fixture_id(4), pg_temp.memory_factory())),
  'Apply signing to every release.', 'the approved correction is retrieved after its own explicit decision');

set local request.jwt.claim.role = 'service_role';
select public.grant_factory_membership(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(), pg_temp.memory_fixture_id(1),
  pg_temp.memory_fixture_id(8), 'manager');
select public.revoke_factory_membership(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(), pg_temp.memory_fixture_id(1),
  pg_temp.memory_fixture_id(7));
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '58100000-0000-4000-8000-000000000002';
select throws_ok($$
  select public.forget_factory_memory(workspace_id, factory_id, id, current_revision_id, null) from next_approval
$$, '42501', null, 'a formerly delegated manager loses mutation access');
select is((select count(*) from public.factory_memory_review_events), 0::bigint,
  'revoked manager loses access to memory review history');
set local request.jwt.claim.sub = '58100000-0000-4000-8000-000000000001';
create temp table forgotten_memory as
select forgotten.* from next_approval memory cross join lateral public.forget_factory_memory(memory.workspace_id, memory.factory_id,
  memory.id, memory.current_revision_id, null) forgotten;
select ok((select forgotten_at is not null and current_revision_id is null and pending_revision_id is null
   and source_run_id = (select source_run_id from initial_memory)
   and source_content_sha256 = (select source_content_sha256 from initial_memory) from forgotten_memory),
  'forget tombstones the family without changing exact source provenance or digest');
select ok((select title is null and position('Synthetic private title canary 70851' in to_jsonb(forgotten_memory)::text) = 0
  from forgotten_memory), 'the forget response clears the former title');
select ok((select title is null and position('Synthetic private title canary 70851' in to_jsonb(memory)::text) = 0
  from public.factory_memories memory where memory.id = (select id from forgotten_memory)),
  'the factory manager listing retains no forgotten title');
select is((select count(*) from public.factory_memory_revision_bodies where memory_id = (select id from forgotten_memory)),
  0::bigint, 'forget physically removes every revision body in the family');
select is((select count(*) from public.factory_memory_revisions where memory_id = (select id from forgotten_memory)),
  3::bigint, 'forget retains the immutable digest and lineage of every revision');
select is((select array_agg(action order by created_at, id) from public.factory_memory_review_events where memory_id = (select id from forgotten_memory)
    and action in ('approved','forgotten')),
  array['approved','approved','forgotten']::text[], 'forget retains prior approvals and appends the human forget decision');
select is((select actor_member_id from public.factory_memory_review_events where memory_id = (select id from forgotten_memory)
   and action = 'forgotten'), pg_temp.memory_fixture_id(6), 'the forgotten record retains the human actor identity');
select throws_ok($$select pg_temp.propose_memory(1)$$, 'PT409', null, 'a forgotten source cannot be reimported');
reset role;
select is((select count(*) from internal.factory_run_memory_proposals where run_id = (select source_run_id from forgotten_memory)),
  0::bigint, 'forget leaves no private staging copy of the consumed proposal');
select is((select count(*) from public.read_factory_memory_context(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(),
    array[(select current_revision_id from next_approval)])), 0::bigint, 'a forgotten exact replay reference has no body');
select throws_ok($$
  update public.factory_memory_revisions set content_sha256 = repeat('f',64) where memory_id = (select id from forgotten_memory)
$$, '23514', null, 'revision provenance cannot be edited');
select throws_ok($$
  delete from public.factory_memory_review_events where memory_id = (select id from forgotten_memory)
$$, '23514', null, 'human review events cannot be rewritten or removed while the family remains');

set local role authenticated;
create temp table expiring_memory as select * from pg_temp.propose_memory(5, 1, clock_timestamp() + interval '12 seconds');
create temp table expiring_approval as
select approved.* from expiring_memory memory cross join lateral public.review_factory_memory(memory.workspace_id, memory.factory_id,
  memory.id, 'approve', null, memory.pending_revision_id) approved;
reset role;
select is((select body_md from public.read_factory_memory_context(pg_temp.memory_fixture_id(4), pg_temp.memory_factory())),
  'This short-lived knowledge expires.', 'an approved, unexpired revision is selected');
set local role authenticated;
create temp table expiring_proposal as select * from pg_temp.propose_memory(6, 1, clock_timestamp() + interval '12 seconds');
reset role;
select pg_sleep(greatest(0, extract(epoch from (select max(expiry.expires_at) - clock_timestamp()
  from public.factory_memory_revisions expiry where expiry.expires_at is not null))) + 0.01);
select is((select count(*) from public.read_factory_memory_context(pg_temp.memory_fixture_id(4), pg_temp.memory_factory())),
  0::bigint, 'expired approval no longer enters fresh prompts');
select is((select count(*) from public.read_factory_memory_context(pg_temp.memory_fixture_id(4), pg_temp.memory_factory(),
    array[(select current_revision_id from expiring_approval)])), 0::bigint, 'expired approval no longer enters exact replay');
set local role authenticated;
select throws_ok($$
  select public.review_factory_memory(workspace_id, factory_id, id, 'approve', null, pending_revision_id) from expiring_proposal
$$, 'PT409', null, 'expiration while waiting for review prevents approval');
reset role;

select * from finish();
rollback;
