begin;

create extension if not exists pgtap with schema extensions;
select no_plan();

select is(internal.decode_factory_workflow_triage_scope(
  '<!-- wallie-accepted-scope: ' || rtrim(translate(encode(convert_to(
    '{"version":1,"scope":"Scope","acceptanceCriteria":["Criterion"],"evidenceReferences":["required:session/prompt"]}',
    'UTF8'), 'base64'), E'+/\n', '-_'), '=') || E' -->\n## Scope\nScope\n\n## Acceptance criteria\n- Criterion\n\n## Evidence\n- `required:session/prompt`',
  '{"required":[{"key":"session/prompt"}]}'), null::jsonb,
  'an artifact with noncanonical metadata cannot produce an unusable accepted-scope receipt');
set local request.jwt.claim.role = 'service_role';

create function pg_temp.spec_id(slot integer) returns uuid language sql immutable as $$
  select ('56600000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
set local request.jwt.claim.sub = '56600000-0000-4000-8000-000000000001';
insert into auth.users(id, email) values (pg_temp.spec_id(1), 'spec-owner@example.test');
insert into public.workspaces(id, slug, name) values (pg_temp.spec_id(2), 'specification-fixture', 'Specification fixture');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.spec_id(3), pg_temp.spec_id(2), pg_temp.spec_id(1), 'human', 'owner');
insert into public.pipelines(id, workspace_id, name, is_default) values (pg_temp.spec_id(10), pg_temp.spec_id(2), 'Custom delivery', true);
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name, prompt_template_md, anyone_can_approve) values
  (pg_temp.spec_id(11), pg_temp.spec_id(10), pg_temp.spec_id(2), 1, 'investigate', 'Investigate', 'Investigate', true),
  (pg_temp.spec_id(12), pg_temp.spec_id(10), pg_temp.spec_id(2), 2, 'ship', 'Ship', 'Ship', true);
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.spec_id(20), pg_temp.spec_id(2), 56600001, 'https://github.test/installations/56600001', 56600,
  'Organization', 'spec-fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, github_installation_id, repo_id, name, full_name, private, html_url, default_branch)
values (pg_temp.spec_id(21), pg_temp.spec_id(2), pg_temp.spec_id(20), 566001,
  'specification', 'fixture/specification', true, 'https://github.test/fixture/specification', 'main');
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values (pg_temp.spec_id(1),'platform_api_key','specification-fixture-ciphertext');
insert into public.workspace_sandbox_settings(workspace_id,active_provider) values (pg_temp.spec_id(2),'e2b')
on conflict (workspace_id) do update set active_provider=excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id,encrypted_api_key)
values (pg_temp.spec_id(2),'specification-fixture-ciphertext');
insert into public.execution_policy_revisions(id, workspace_id, revision, requirements, created_by) values
  (pg_temp.spec_id(30), pg_temp.spec_id(2), 10,
    '{"version":1,"maxRepairAttempts":5,"maxExecutionMs":3600000,"maxTotalTokens":null,"maxCostUsd":null}', pg_temp.spec_id(1)),
  (pg_temp.spec_id(31), pg_temp.spec_id(2), 11,
    '{"version":1,"maxRepairAttempts":0,"maxExecutionMs":3600000,"maxTotalTokens":null,"maxCostUsd":null}', pg_temp.spec_id(1));
create temp table pr_gate as select * from public.save_delivery_policy(
  pg_temp.spec_id(2), pg_temp.spec_id(10), pg_temp.spec_id(1), 0,
  '{"version":1,"deliveryMode":"code","requireCodeOwnerReview":false,"requireResolvedThreads":false,
    "requireArtifactApprovalForDelivery":true,"minimumApprovals":0,"freshnessSeconds":600,"requiredChecks":[],"requiredEvidence":[]}');
create function pg_temp.spec_factory() returns uuid language sql stable as $$
  select id from public.factories where workspace_id = pg_temp.spec_id(2) and is_default
$$;
create function pg_temp.spec_activate(activation bigint, named boolean, budget uuid, delivery uuid default null, single_stage boolean default false)
returns void language sql as $$
  with snapshot as (
    select jsonb_build_object('agentId',agent.id,'promptRevisionId',prompt.id,'promptMd',prompt.prompt_md,'promptSha256',prompt.prompt_sha256) contents
    from public.factory_agents agent join public.factory_agent_prompt_revisions prompt on prompt.agent_id=agent.id
    where agent.factory_id=pg_temp.spec_factory() and agent.is_default and prompt.revision_number=1
  ), definition as (
    select (jsonb_build_object('schemaVersion',1,'kind','serial','sandboxProvider','e2b',
      'pipelineId',pg_temp.spec_id(10),'repositoryId',pg_temp.spec_id(21),'executionPolicyRevisionId',budget,
      'deliveryPolicyRevisionId',delivery,'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,
      'operatingRulesMd','','operatingRuleStageIds','[]'::jsonb,
      'agent',jsonb_build_object('provider','codex','model','gpt-5.5','effort',null,
        'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
      'stages',(select jsonb_agg(jsonb_build_object('id',stage.id,'slug',stage.slug,'name',stage.name,'description','',
        'promptTemplateMd',stage.prompt_template_md,'anyoneCanApprove',true,'previousStageIds','[]'::jsonb,
        'approverMemberIds','[]'::jsonb) order by stage.position) from public.pipeline_stages stage
        where stage.pipeline_id=pg_temp.spec_id(10) and (not single_stage or stage.position=1)))
      || case when named then jsonb_build_object('implementationAgent',snapshot.contents) else '{}'::jsonb end)::text bytes
    from snapshot
  ), revision as (
    insert into public.factory_definition_revisions(workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
    select pg_temp.spec_id(2),pg_temp.spec_factory(),1,bytes,encode(sha256(convert_to(bytes,'UTF8')),'hex'),pg_temp.spec_id(1)
      from definition returning *
  )
  insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
  select workspace_id,factory_id,id,activation,created_by from revision;
$$;
create function pg_temp.spec_create(key_slot integer, drafting boolean default true,
  stages uuid[] default array[pg_temp.spec_id(11),pg_temp.spec_id(12)])
returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid) language sql as $$
  select created.* from (select definition.canonical_digest from public.factory_definition_activations activation
    join public.factory_definition_revisions definition on definition.id=activation.revision_id
    where activation.factory_id=pg_temp.spec_factory() order by activation.activation_number desc limit 1) active
  cross join lateral public.create_session_command_once(pg_temp.spec_id(2),pg_temp.spec_id(3),pg_temp.spec_id(key_slot),repeat('a',64),
    active.canonical_digest,'Collaborative fixture','Build the direct request.','codex','gpt-5.5','{}',
    selected_stage_ids=>stages,target_factory_id=>pg_temp.spec_factory(),draft_specification=>drafting) created;
$$;
select public.set_git_continuity_release(true, revision, 'OP649 accepted scope fixture')
from public.get_git_continuity_release_state() where not enabled;
select pg_temp.spec_activate(1, false, pg_temp.spec_id(30));
select throws_ok('select * from pg_temp.spec_create(100)', 'PT422',
  'Specification drafting requires a pinned definition with a named implementation agent.', 'admission requires an exact named agent');
select pg_temp.spec_activate(2, true, pg_temp.spec_id(30), (select id from pr_gate), true);
select throws_ok($q$select * from pg_temp.spec_create(100, true, array[pg_temp.spec_id(11)])$q$, 'PT422',
  'Select a later stage for delivery after the specification.', 'final PR policy requires a later admitted delivery stage');
select pg_temp.spec_activate(3, true, pg_temp.spec_id(30), (select id from pr_gate));
create temp table delivery_spec as select * from pg_temp.spec_create(100);
select is((select specification_stage_id from public.sessions where id=(select session_id from delivery_spec)), pg_temp.spec_id(11),
  'the first admitted stage is pinned for a delivery-capable definition');
select pg_temp.spec_activate(4, true, pg_temp.spec_id(30), single_stage=>true);
create function pg_temp.configure_op649_graph(p_edge_id text, p_expected_version bigint)
returns table(graph_revision_id uuid, workflow_digest text, configuration_version bigint, created boolean) language sql as $$
  with active as (
    select pin.workspace_id, pin.factory_id, revision.id, revision.canonical_digest,
      revision.definition_json::jsonb#>>'{implementationAgent,promptRevisionId}' as prompt_revision_id
    from public.factory_definition_activations pin join public.factory_definition_revisions revision on revision.id = pin.revision_id
    where (pin.workspace_id, pin.factory_id) = (pg_temp.spec_id(2), pg_temp.spec_factory())
    order by pin.activation_number desc limit 1
  ), graph as (
    select active.*, jsonb_build_object(
      'schemaVersion',1,'kind','graph','entryNodeId','scope.approved',
      'nodes',jsonb_build_array(
        jsonb_build_object('id','scope.approved','kind','human-gate','anyoneCanApprove',true,'approverMemberIds','[]'::jsonb),
        jsonb_build_object('id','route.choose','kind','route','agentPromptRevisionId',active.prompt_revision_id),
        jsonb_build_object('id','policy.check','kind','deterministic','operation','policy')),
      'edges',jsonb_build_array(
        jsonb_build_object('id',p_edge_id,'kind','next','from','scope.approved','to','route.choose'),
        jsonb_build_object('id','route.policy','kind','route','from','route.choose','to','policy.check')),
      'grants','[]'::jsonb,
      'routePolicy','{"maxNodeVisits":12,"maxLoopTraversals":0,"nodes":{"route.choose":{
        "minimumConfidence":0.8,"allowedDestinationIds":["policy.check"],"fallback":{"kind":"clarification"}}}}'::jsonb
    )::text as body from active
  )
  select registered.graph_revision_id, bytes.digest, configured.*
  from graph cross join lateral (select encode(sha256(convert_to(graph.body,'UTF8')),'hex')) bytes(digest)
  cross join lateral public.register_factory_workflow_graph_revision(graph.workspace_id,graph.factory_id,
    graph.id,graph.canonical_digest,graph.body,bytes.digest) registered
  cross join lateral public.configure_factory_workflow_triage(graph.workspace_id,graph.factory_id,pg_temp.spec_id(1),
    graph.id,registered.graph_revision_id,bytes.digest,pg_temp.spec_id(11),p_expected_version) configured;
$$;

create temp table op649_configured_first as select * from pg_temp.configure_op649_graph('scope.continue', 0);
select ok((select created and configuration_version = 1 from op649_configured_first),
  'the manager configures an immutable named-stage and graph pair');
select ok((select not created and configuration_version = 1 from pg_temp.configure_op649_graph('scope.continue', 0)),
  'exact configuration replay returns the same version');

create temp table main_spec as select * from pg_temp.spec_create(101, true, array[pg_temp.spec_id(11)]);
select results_eq($q$select * from pg_temp.spec_create(101, true, array[pg_temp.spec_id(11)])$q$,
  'select * from main_spec', 'spec-only without a delivery requirement admits once and replays');
select throws_ok('select * from pg_temp.spec_create(101, false)', 'P0005',
  'This creation request was already used for different session input', 'changing the drafting intent conflicts even with the same digest');
create temp table ordinary_spec as select * from pg_temp.spec_create(102, false, array[pg_temp.spec_id(11)]);
select is((select specification_stage_id from public.sessions where id=(select session_id from ordinary_spec)), null::uuid,
  'ordinary creation keeps every stage generic');

create temp table spec_targets(label text primary key, session_id uuid not null);
insert into spec_targets select 'main', session_id from main_spec;
insert into spec_targets select 'ordinary', session_id from ordinary_spec;
create function pg_temp.spec_start(p_target text) returns uuid language plpgsql as $$
declare owner public.sessions; job public.agent_jobs; started uuid;
begin
  select session.* into strict owner from public.sessions session join spec_targets target on target.session_id=session.id
    where target.label=p_target;
  select * into strict job from public.agent_jobs where session_id=owner.id and status='queued';
  update public.agent_jobs set status='running',attempt_count=1,
    git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()) where id=job.id;
  started:=public.start_session_job_attempt(job.id,1,owner.current_stage_id,owner.current_artifact_version,
    'codex','gpt-5.5','code','wallie/specification-' || job.id::text);
  if started is null or not exists(select 1 from public.pin_session_job_git_input(
    job.id,1,started,pg_temp.spec_id(21),'main',repeat('a',40))) then
    raise exception 'Specification fixture start did not pin exact source';
  end if;
  return started;
end;
$$;
create function pg_temp.spec_prepare(p_run uuid, p_markdown text, p_head text default repeat('a',40)) returns boolean language sql as $$
  select public.prepare_session_source_and_checkpoint_publication(run.id,pg_temp.spec_id(21),'main',repeat('a',40),p_head,
    'Specification','Fixture source','',case when p_head<>repeat('a',40) then encode(sha256('fixture'::bytea),'hex') else '' end,
    case when p_head<>repeat('a',40) then encode('fixture'::bytea,'base64') else '' end,session.current_artifact_version,p_markdown)
  from public.agent_runs run join public.sessions session on session.id=run.session_id where run.id=p_run;
$$;
create function pg_temp.spec_publish(p_run uuid, p_markdown text) returns boolean language plpgsql as $$
declare claim uuid;
begin
  if not pg_temp.spec_prepare(p_run,p_markdown) then return false; end if;
  claim:=public.claim_session_checkpoint_publication(p_run);
  return public.adopt_session_checkpoint_publication(p_run,claim);
end;
$$;
create function pg_temp.spec_marker(question text) returns text language sql immutable as $$
  select '<!-- wallie-clarification: ' || jsonb_build_object('question',question)::text || ' -->' || E'\n\n# Draft specification';
$$;
create function pg_temp.freeze_op649_context(p_run_id uuid) returns text language sql as $$
  select frozen.manifest_sha256 from public.agent_runs run
  cross join lateral (select 'Build the direct request.' as request) intent
  cross join lateral (select jsonb_build_object(
    'version', 1,
    'required', jsonb_build_array(jsonb_build_object('key','session/prompt',
      'utf8Bytes',octet_length(intent.request),'sha256',encode(sha256(convert_to(intent.request,'UTF8')),'hex'))),
    'documents', '[]'::jsonb,
    'conversation', '{"throughSequence":0,"olderOmitted":0,"messages":[]}'::jsonb,
    'budget', jsonb_build_object('maxUtf8Bytes',1024,'maxEstimatedTokens',1024,
      'usedUtf8Bytes',octet_length(intent.request),'estimatedTokens',octet_length(intent.request))
  )) payload(body)
  cross join lateral public.pin_factory_run_context(run.workspace_id, run.agent_job_id, run.id, run.attempt_count, payload.body) frozen
  where run.id = p_run_id;
$$;

create temp table first_spec_run as select pg_temp.spec_start('main') id;
select throws_ok($q$select pg_temp.spec_prepare((select id from first_spec_run),'Code should never be delivered',repeat('b',40))$q$,
  '23514', 'Specification publication requires unchanged source from the exact execution attempt.', 'specification refuses changed source before staging remote work');
select throws_ok($q$select pg_temp.spec_prepare((select id from first_spec_run),pg_temp.spec_marker(repeat('x',801)))$q$,
  '23514', 'Specification clarification must be one question of at most 800 characters.', 'an overlong directive never becomes a durable publication');
select throws_ok($q$select pg_temp.spec_prepare((select id from first_spec_run),'<!-- wallie-clarification: ["invalid"] -->')$q$,
  '23514', 'Specification clarification must be one question of at most 800 characters.', 'a malformed explicit directive never becomes an empty artifact');
select ok(pg_temp.spec_publish((select id from first_spec_run),pg_temp.spec_marker('What deadline applies?')),
  'the exact owned attempt publishes a reviewable draft and one question');
create temp table first_question as select * from public.session_specification_clarifications where session_id=(select session_id from main_spec);
select ok((select status='pending' and ordinal=1 and run_id=(select id from first_spec_run) and attempt_count=1
  and question='What deadline applies?' from first_question), 'the pending clarification has exact artifact and producing attempt provenance');

select ok((select binding.graph_revision_id = configured.graph_revision_id
    and binding.workflow_digest = configured.workflow_digest
    and binding.stage_id = question.stage_id and question.status = 'pending'
  from op649_configured_first configured cross join first_question question
  cross join lateral public.read_factory_workflow_triage_binding(question.session_id, question.workspace_id, question.factory_id) binding),
  'human intake pins the configured workflow before the linked clarification opens');
select is((select count(*) from internal.factory_workflow_accepted_scopes scope join main_spec main using (session_id)),
  0::bigint, 'a linked pending clarification creates no accepted graph handoff');
select is((select count(*) from internal.factory_workflow_executions execution join main_spec main on main.session_id = execution.root_session_id),
  0::bigint, 'a linked pending clarification creates no graph execution');
select is((select count(*) from ordinary_spec ordinary
  cross join lateral public.read_factory_workflow_triage_binding(ordinary.session_id,pg_temp.spec_id(2),pg_temp.spec_factory())),
  0::bigint, 'ordinary serial intake does not gain a triage binding');
select throws_ok($q$select * from pg_temp.configure_op649_graph('scope.redirect', 0)$q$,
  'PT409', null, 'a stale configuration write cannot replace the active graph');
create temp table op649_configured_second as select * from pg_temp.configure_op649_graph('scope.redirect', 1);
select ok((select created and configuration_version = 2 from op649_configured_second),
  'a manager can choose another immutable graph for later intake');
select results_eq($q$select * from pg_temp.spec_create(101, true, array[pg_temp.spec_id(11)])$q$,
  'select * from main_spec', 'exact creation replay keeps the pre-clarification session and graph');

set local request.jwt.claim.role='authenticated';
create temp table clarification_inbox as select public.get_factory_inbox(pg_temp.spec_id(2),pg_temp.spec_factory()) snapshot;
select is((select snapshot->'counts' from clarification_inbox),'{"review":0,"clarification":1}'::jsonb,
  'a pending clarification replaces the duplicate approval item in the Inbox');
select ok((select inbox.snapshot->'items'->0 @> jsonb_build_object(
  'kind','clarification','clarificationId',question.id,'artifactId',question.artifact_id,
  'artifactVersion',question.artifact_version,'sourceLabel',message.author_label)
  from clarification_inbox inbox cross join first_question question
  join public.session_conversation_messages message on message.artifact_id=question.artifact_id and message.kind='review_ready'),
  'the Inbox uses the exact question and source without carrying the clarification answer or body');
set local request.jwt.claim.role='service_role';

select throws_ok($q$select * from first_question question cross join lateral public.approve_session_stage(
  question.session_id,question.workspace_id,question.stage_id,question.artifact_id,question.artifact_version,
  pg_temp.spec_id(3),'codex','gpt-5.5','code',0)$q$, 'PT423',
  'Answer the open specification clarification before approving.', 'exact approval cannot skip the pending human question');
select throws_ok($q$select * from first_question question cross join lateral public.approve_session_stage(
  question.session_id,question.workspace_id,question.stage_id,question.artifact_id,question.artifact_version,
  pg_temp.spec_id(3),'codex','gpt-5.5','code',1)$q$, 'PT412',
  'Review changed. Refresh the review before approving.', 'a stale review revision cannot act on the same pending question');
insert into auth.users(id,email) values (pg_temp.spec_id(4),'spec-reviewer@example.test');
insert into public.workspace_members(id,workspace_id,user_id,kind,role)
values (pg_temp.spec_id(5),pg_temp.spec_id(2),pg_temp.spec_id(4),'human','member');
select public.revoke_factory_membership(pg_temp.spec_id(2),pg_temp.spec_factory(),pg_temp.spec_id(1),pg_temp.spec_id(5));
select throws_ok($q$select * from first_question question cross join lateral public.approve_session_stage(
  question.session_id,question.workspace_id,question.stage_id,question.artifact_id,question.artifact_version,
  pg_temp.spec_id(5),'codex','gpt-5.5','code',0)$q$, '42501',
  'The service execution invoker no longer has factory access.', 'approval rechecks revoked factory access inside the exact specification transaction');
select ok(exists(select 1 from public.session_conversation_messages where artifact_id=(select artifact_id from first_question)
  and body_md='Clarification needed: What deadline applies?' and author_kind='agent'), 'the conversation carries the agent’s next human action');

create function pg_temp.spec_answer(p_question uuid, p_key integer, p_answer text default 'Friday.', p_review bigint default 0)
returns table(clarification_id uuid,feedback_batch_id uuid,job_id uuid,run_id uuid,execution_exhausted boolean,replayed boolean)
language sql as $$
  select accepted.* from public.session_specification_clarifications question
  cross join lateral public.answer_session_specification_clarification_once(question.workspace_id,question.factory_id,
    question.session_id,pg_temp.spec_id(3),question.id,question.artifact_id,question.artifact_version,p_review,
    pg_temp.spec_id(p_key),p_answer,'codex','gpt-5.5','code') accepted where question.id=p_question;
$$;
select throws_ok($q$select * from pg_temp.spec_answer((select id from first_question),201,p_review=>1)$q$,
  'P0003','The specification review changed. Refresh before answering.','a stale review revision cannot start work');
select throws_ok($q$select * from first_question question cross join lateral public.submit_session_follow_up_once(
  question.session_id,question.workspace_id,question.factory_id,question.artifact_version,question.stage_id,question.artifact_id,
  'An unbound response',p_requested_by_member_id=>pg_temp.spec_id(3))$q$,
  '22023','Specification feedback requires an exact review receipt.','specification follow-up cannot bypass exact feedback');
create temp table first_answer as select * from pg_temp.spec_answer((select id from first_question),201);

set local request.jwt.claim.role='authenticated';
select is(public.get_factory_inbox(pg_temp.spec_id(2),pg_temp.spec_factory())->'counts',
  '{"review":0,"clarification":0}'::jsonb,'answering the exact question removes it as soon as the revision is queued');
set local request.jwt.claim.role='service_role';

select ok((select not replayed and not execution_exhausted and feedback_batch_id is not null and job_id is not null and run_id is not null from first_answer),
  'a clarification answer queues one exact canonical revision and returns its receipt');
select ok(exists(select 1 from public.artifact_feedback_batches batch join first_answer answer on answer.feedback_batch_id=batch.id
  where batch.job_id=answer.job_id and batch.run_id=answer.run_id
    and batch.whole_stage_feedback=E'Clarification question: What deadline applies?\n\nClarification answer: Friday.'),
  'the exact successor retains the question and answer in its own immutable feedback batch');
select results_eq($q$select * from pg_temp.spec_answer((select id from first_question),201,' Friday. ')$q$,
  'select clarification_id,feedback_batch_id,job_id,run_id,execution_exhausted,true from first_answer',
  'equivalent answer retries replay the same work');
select throws_ok($q$select * from pg_temp.spec_answer((select id from first_question),201,'Changed answer')$q$,
  'P0005','This clarification request was already used for different input.','reusing the receipt with changed text conflicts');
select throws_ok($q$select * from pg_temp.spec_answer((select id from first_question),222)$q$,
  'P0003','The specification review changed. Refresh before answering.','another request for the answered generation cannot compete');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from main_spec)
  and status in('queued','started','running')),1::bigint,'only one successor remains eligible');

create temp table second_spec_run as select pg_temp.spec_start('main') id;
select throws_ok($q$select * from first_question question cross join lateral public.cancel_session_command_once(
  question.workspace_id,question.factory_id,pg_temp.spec_id(3),question.session_id,pg_temp.spec_id(210),repeat('b',64),question.run_id)$q$,
  'P0003','Session generation changed.','a late cancel targeting the prior publication does not retire the clarification successor');
select ok(pg_temp.spec_publish((select id from second_spec_run),pg_temp.spec_marker('Who receives the report?')),
  'the answer’s successor publishes another exact specification version');
select ok(exists(select 1 from pg_temp.spec_answer((select id from public.session_specification_clarifications
  where session_id=(select session_id from main_spec) and ordinal=2),202,'The project coordinator.') where job_id is not null),
  'the next exact question can be answered independently');
select ok(pg_temp.spec_publish(pg_temp.spec_start('main'),pg_temp.spec_marker('Which repository should later stages use?')),
  'the third question still produces a versioned specification');
select ok(exists(select 1 from pg_temp.spec_answer((select id from public.session_specification_clarifications
  where session_id=(select session_id from main_spec) and ordinal=3),203,'Use the original repository.') where job_id is not null),
  'the third answer can still queue a final specification');
create temp table final_spec_run as select pg_temp.spec_start('main') id;
select throws_ok($q$select pg_temp.spec_prepare((select id from final_spec_run),pg_temp.spec_marker('A fourth question'))$q$,
  '23514','Specification clarification limit reached. Publish a final specification.',
  'the cap rejects a fourth durable question before creating an immutable intent');
select pg_temp.freeze_op649_context((select id from final_spec_run));
select ok(pg_temp.spec_publish((select id from final_spec_run),$artifact$<!-- wallie-accepted-scope: eyJhY2NlcHRhbmNlQ3JpdGVyaWEiOlsiVXNlIFVUQyBkYXRlcy4iLCJJbmNsdWRlIG5hbWUgW29yaWdpbmFsXS4iXSwiZXZpZGVuY2VSZWZlcmVuY2VzIjpbInJlcXVpcmVkOnNlc3Npb24vcHJvbXB0Il0sInNjb3BlIjoiRXhwb3J0IHRoZSByZXBvcnQgZXZlcnkgRnJpZGF5LiIsInZlcnNpb24iOjF9 -->
## Scope
Export the report every Friday.

## Acceptance criteria
- Use UTC dates.
- Include name \[original\].

## Evidence
- `required:session/prompt`$artifact$),
  'the same generation can publish readable final Markdown at the cap');
select ok(exists(select 1 from public.sessions session cross join lateral public.approve_session_stage(
  session.id,session.workspace_id,session.current_stage_id,session.current_artifact_id,session.current_artifact_version,
  pg_temp.spec_id(3),'codex','gpt-5.5','code',session.artifact_review_revision) approved
  where session.id=(select session_id from main_spec) and approved.phase_status='approved'),
  'final specification approval uses the existing generic approval receipt path');
select ok(pg_temp.spec_publish(pg_temp.spec_start('ordinary'),pg_temp.spec_marker('A generic artifact may include an HTML comment.')),
  'generic stage publication preserves its ordinary behavior');
select is((select count(*) from public.session_specification_clarifications where session_id=(select session_id from ordinary_spec)),
  0::bigint,'an ordinary stage cannot create a specification clarification');

select ok((select owner.phase_status = 'approved' and owner.archived_at is not null
    and receipt.artifact_version = 4 and receipt.run_id = producing.id
    and receipt.scope->'acceptanceCriteria' = '["Use UTC dates.", "Include name [original]."]'::jsonb
    and (receipt.graph_revision_id, receipt.workflow_digest, execution.graph_input_run_id) =
      (configured.graph_revision_id, configured.workflow_digest, producing.id)
    and result.evidence_ref = 'human-gate:' || receipt.approval_id::text
    and next.edge_id = 'scope.continue' and route.node_id = 'route.choose'
  from main_spec main join public.sessions owner on owner.id = main.session_id
  join internal.factory_workflow_accepted_scopes receipt on receipt.session_id = owner.id
  join public.agent_runs producing on producing.id = receipt.run_id
  join internal.factory_workflow_executions execution on execution.root_session_id = owner.id
  join internal.factory_workflow_node_results result on result.root_session_id = owner.id
  join internal.factory_workflow_transition_receipts next on (next.root_session_id,next.source_result_id) =
    (owner.id,result.result_id)
  join internal.factory_workflow_node_occurrences route on (route.root_session_id,route.occurrence_id) =
    (owner.id,next.target_occurrence_id)
  cross join op649_configured_first configured),
  'shared final approval atomically pins accepted criteria and advances the original configured route');
select ok((select count(*) = 1 from public.session_stage_approval_receipts approval join main_spec main using (session_id)),
  'the post-approval handoff does not duplicate human approval');
select is((select count(*) from public.agent_jobs job join main_spec main on main.session_id = job.session_id
  where job.status in ('queued','started','running')), 0::bigint,
  'a graph handoff does not also schedule legacy serial continuation');
select ok((select not retry.created and retry.ownership_token is null from main_spec main
  cross join final_spec_run producing cross join op649_configured_first configured
  cross join lateral public.start_factory_workflow_graph_execution(main.session_id,pg_temp.spec_id(2),pg_temp.spec_factory(),
    configured.graph_revision_id,producing.id) retry), 'replay returns the committed graph without issuing ownership again');

create temp table op649_unsupported as select * from pg_temp.spec_create(701,true,array[pg_temp.spec_id(11)]);
insert into spec_targets select 'unsupported-scope',session_id from op649_unsupported;
create temp table op649_unsupported_run as select pg_temp.spec_start('unsupported-scope') as id;
select pg_temp.freeze_op649_context(id) from op649_unsupported_run;
select ok(pg_temp.spec_publish(id,$artifact$<!-- wallie-accepted-scope: eyJhY2NlcHRhbmNlQ3JpdGVyaWEiOlsiSW5jbHVkZSBhIFVUQyBkYXRlIGNvbHVtbi4iXSwiZXZpZGVuY2VSZWZlcmVuY2VzIjpbInJlcXVpcmVkOmFub3RoZXItdGVuYW50Il0sInNjb3BlIjoiUHJvZHVjZSB0aGUgQ1NWLiIsInZlcnNpb24iOjF9 -->
## Scope
Produce the CSV.

## Acceptance criteria
- Include a UTC date column.

## Evidence
- `required:another-tenant`$artifact$),
  'the shared publisher can retain the ineligible draft for human review') from op649_unsupported_run;
select throws_ok($q$select approved.id from op649_unsupported direct join public.sessions owner on owner.id = direct.session_id
  cross join lateral public.approve_session_stage(owner.id,owner.workspace_id,owner.current_stage_id,
    owner.current_artifact_id,owner.current_artifact_version,
    pg_temp.spec_id(3),'codex','gpt-5.5','code',owner.artifact_review_revision) approved$q$,
  'PT422', 'Triage scope requires reviewed criteria and exact retained evidence.',
  'a purported final scope with unavailable evidence cannot commit acceptance');
select ok((select phase_status = 'awaiting_review' and archived_at is null from public.sessions owner
  join op649_unsupported direct on direct.session_id = owner.id),
  'invalid final scope remains available for the normal review revision flow');
select is((select count(*) from internal.factory_workflow_accepted_scopes scope join op649_unsupported direct using (session_id)),
  0::bigint, 'an ineligible final scope leaves no partial workflow receipt');
create temp table op649_principal as select * from public.create_service_principal(
  pg_temp.spec_id(2), pg_temp.spec_factory(), pg_temp.spec_id(1), 'Configured triage intake', 'configured-triage-intake');
create temp table op649_machine_grant as
select approved.* from op649_principal principal cross join lateral public.approve_factory_execution_grant(
  pg_temp.spec_id(2),pg_temp.spec_factory(),pg_temp.spec_id(1),principal.id,pg_temp.spec_id(21),
  '{}','{}',pg_temp.spec_id(30),pg_temp.spec_id(3),clock_timestamp() + interval '1 hour',0,null,
  '{sessions:create}'::public.factory_command_scope[]) approved;
insert into public.workspace_secrets(id,workspace_id,key,encrypted_value)
values (pg_temp.spec_id(811),pg_temp.spec_id(2),'OP649_SERVICE_KEY','proof-ciphertext');
create temp table op649_machine_binding as
select binding.* from op649_machine_grant grant_row
join public.factory_agents agent on agent.factory_id = grant_row.factory_id and agent.is_default
cross join lateral public.create_factory_secret_binding(grant_row.workspace_id,grant_row.factory_id,pg_temp.spec_id(1),
  grant_row.id,grant_row.version,agent.id,'codex',pg_temp.spec_id(811)) binding;
with base as (
  select definition.* from public.factory_definition_activations active
  join public.factory_definition_revisions definition on definition.id = active.revision_id
  where active.factory_id = pg_temp.spec_factory() order by active.activation_number desc limit 1
), bound as (
  select base.workspace_id, base.factory_id, (base.definition_json::jsonb ||
    jsonb_build_object('executionGrant',jsonb_build_object('id',grant_row.id,'version',grant_row.version),
      'credentialBindingId',binding.id))::text as body
  from base cross join op649_machine_grant grant_row cross join op649_machine_binding binding
), inserted as (
  insert into public.factory_definition_revisions(workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
  select workspace_id,factory_id,1,body,encode(sha256(convert_to(body,'UTF8')),'hex'),pg_temp.spec_id(1) from bound
  returning *
)
insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,id,5,pg_temp.spec_id(1) from inserted;
create temp table op649_configured_machine as
with active as (
  select pin.workspace_id, pin.factory_id, revision.id, revision.canonical_digest,
    revision.definition_json::jsonb#>>'{implementationAgent,promptRevisionId}' as prompt_revision_id
  from public.factory_definition_activations pin join public.factory_definition_revisions revision on revision.id = pin.revision_id
  where (pin.workspace_id, pin.factory_id) = (pg_temp.spec_id(2), pg_temp.spec_factory())
  order by pin.activation_number desc limit 1
), definition as (
  select active.*, jsonb_build_object(
    'schemaVersion',1,'kind','graph','entryNodeId','scope.approved',
    'nodes',jsonb_build_array(
      jsonb_build_object('id','scope.approved','kind','human-gate','anyoneCanApprove',true,'approverMemberIds','[]'::jsonb),
      jsonb_build_object('id','route.choose','kind','route','agentPromptRevisionId',active.prompt_revision_id,'grantId',approved.id),
      jsonb_build_object('id','agent.child','kind','agent','agentPromptRevisionId',active.prompt_revision_id,'grantId',approved.id)),
    'edges',jsonb_build_array(
      jsonb_build_object('id','scope.machine','kind','next','from','scope.approved','to','route.choose'),
      jsonb_build_object('id','route.child','kind','route','from','route.choose','to','agent.child')),
    'grants',jsonb_build_array(jsonb_build_object('id',approved.id,'version',approved.version)),
    'routePolicy',jsonb_build_object('maxNodeVisits',12,'maxLoopTraversals',0,'nodes',jsonb_build_object(
      'route.choose',jsonb_build_object('minimumConfidence',0.8,'allowedDestinationIds','["agent.child"]'::jsonb,
        'fallback','{"kind":"clarification"}'::jsonb,'foremanProfile',jsonb_build_object(
          'definitionRevisionId',active.id,'definitionDigest',active.canonical_digest)))),
    'delegationPolicy',jsonb_build_object('maxChildren',1,'maxConcurrentChildren',1,'maxAttempts',5,'maxTotalTokens',400,
      'maxTokensPerAttempt',60,'maxCostUsd',3,'maxCostUsdPerAttempt',0.4,'targets',
      jsonb_build_object('agent.child',jsonb_build_object('definitionRevisionId',active.id,'definitionDigest',active.canonical_digest)))
  )::text body from active cross join op649_machine_grant approved
)
select registered.graph_revision_id, bytes.digest as workflow_digest, configured.*
from definition cross join lateral (select encode(sha256(convert_to(definition.body,'UTF8')),'hex')) bytes(digest)
cross join lateral public.register_factory_workflow_graph_revision(definition.workspace_id,definition.factory_id,
  definition.id,definition.canonical_digest,definition.body,bytes.digest) registered
cross join lateral public.configure_factory_workflow_triage(definition.workspace_id,definition.factory_id,pg_temp.spec_id(1),
  definition.id,registered.graph_revision_id,bytes.digest,pg_temp.spec_id(11),0) configured;

select public.issue_factory_machine_token(workspace_id,factory_id,pg_temp.spec_id(1),id,version,
  pg_temp.spec_id(812),repeat('b',64),'Triage proof machine','{sessions:create}') from op649_machine_grant;

create function pg_temp.op649_machine_create()
returns jsonb language plpgsql as $$
declare
  admission record;
  request uuid := gen_random_uuid();
  receipt jsonb;
  agent_id uuid;
begin
  select id into strict agent_id from public.factory_agents agent where agent.factory_id = pg_temp.spec_factory() and agent.is_default;
  select * into strict admission from public.admit_factory_command(pg_temp.spec_id(2),pg_temp.spec_factory(),'machine_token',
    pg_temp.spec_id(812),repeat('b',64),'sessions:create',request,repeat('a',64),'api');
  if admission.status <> 'admitted' then raise exception 'Machine triage fixture admission failed.'; end if;
  receipt := public.execute_factory_session_mutation(pg_temp.spec_id(2),pg_temp.spec_factory(),'machine_token',
    pg_temp.spec_id(812),repeat('b',64),request,repeat('a',64),'api',admission.admission_id,admission.lease_id,'create',
    pg_temp.spec_id(813),jsonb_build_object('title','Machine triage','prompt','Build the direct request.',
      'agentId',agent_id,'repositoryId',pg_temp.spec_id(21),'draftSpecification',true));
  perform public.release_factory_command_admission(admission.admission_id,admission.lease_id);
  return receipt;
end;
$$;
create temp table op649_machine_root as
select (receipt->>'sessionId')::uuid as session_id,receipt
from (select pg_temp.op649_machine_create()) created(receipt);
insert into spec_targets select 'machine-scope',session_id from op649_machine_root;
select ok((select binding.graph_revision_id = configured.graph_revision_id
    and binding.workflow_digest = configured.workflow_digest
  from op649_machine_root machine cross join op649_configured_machine configured
  cross join lateral public.read_factory_workflow_triage_binding(machine.session_id,pg_temp.spec_id(2),pg_temp.spec_factory()) binding),
  'machine intake pins its scoped workflow through the same M04 stage admission');
select ok((select replay.receipt->>'sessionId' = machine.receipt->>'sessionId'
    and replay.receipt->>'jobId' = machine.receipt->>'jobId' and replay.receipt->>'runId' = machine.receipt->>'runId'
  from op649_machine_root machine cross join lateral (select pg_temp.op649_machine_create()) replay(receipt)),
  'source-neutral machine replay preserves the original session, job, run and graph');
create temp table op649_machine_run as select pg_temp.spec_start('machine-scope') as id;
select pg_temp.freeze_op649_context(id) from op649_machine_run;
select ok(pg_temp.spec_publish(id,$artifact$<!-- wallie-accepted-scope: eyJhY2NlcHRhbmNlQ3JpdGVyaWEiOlsiSW5jbHVkZSBhIFVUQyBkYXRlIGNvbHVtbi4iXSwiZXZpZGVuY2VSZWZlcmVuY2VzIjpbInJlcXVpcmVkOnNlc3Npb24vcHJvbXB0Il0sInNjb3BlIjoiUHJvZHVjZSB0aGUgQ1NWLiIsInZlcnNpb24iOjF9 -->
## Scope
Produce the CSV.

## Acceptance criteria
- Include a UTC date column.

## Evidence
- `required:session/prompt`$artifact$),
  'the well-scoped machine intake can publish criteria in its first retained source') from op649_machine_run;
select ok(exists(select 1 from op649_machine_root machine join public.sessions owner on owner.id = machine.session_id
  cross join lateral public.approve_session_stage(owner.id,owner.workspace_id,owner.current_stage_id,owner.current_artifact_id,
    owner.current_artifact_version,pg_temp.spec_id(3),'codex','gpt-5.5','code',owner.artifact_review_revision) approved
    where approved.phase_status = 'approved'), 'the same authorized review accepts the machine-originated scope');
select ok((select receipt.artifact_version = 1 and receipt.scope->'acceptanceCriteria' = '["Include a UTC date column."]'::jsonb
    and receipt.graph_revision_id = configured.graph_revision_id and next.edge_id = 'scope.machine'
  from op649_machine_root machine join internal.factory_workflow_accepted_scopes receipt using (session_id)
  join internal.factory_workflow_transition_receipts next on next.root_session_id = machine.session_id
  cross join op649_configured_machine configured),
  'the accepted first version follows its configured graph without using a stage name');

select is((select count(*) from internal.factory_workflow_triage_route_dispatches),1::bigint,
  'approval enqueues exactly the configured foreman route alongside its accepted scope');
create temp table op649_lease as select * from public.claim_factory_workflow_accepted_triage_route(pg_temp.spec_id(901));
select ok((select claimed.root_session_id = machine.session_id and claimed.node_id = 'route.choose'
    and claimed.ownership_token = pg_temp.spec_id(901) and claimed.execution_generation = 2
    and queued.scope_receipt_id = scope.receipt_id and queued.occurrence_id = claimed.occurrence_id
  from op649_lease claimed join op649_machine_root machine on machine.session_id = claimed.root_session_id
  join internal.factory_workflow_triage_route_dispatches queued using (root_session_id)
  join internal.factory_workflow_accepted_scopes scope on scope.session_id = claimed.root_session_id),
  'maintenance claims the exact waiting route and rotates graph ownership once');
select results_eq($q$select * from public.claim_factory_workflow_accepted_triage_route(pg_temp.spec_id(901))$q$,
  'select * from op649_lease', 'ambiguous claim replay returns the same live lease');
select is((select count(*) from public.claim_factory_workflow_accepted_triage_route(pg_temp.spec_id(902))),0::bigint,
  'another worker cannot rotate a live triage dispatch lease');

-- Simulate an interrupted worker before inference begins.
update internal.factory_workflow_triage_route_dispatches set lease_expires_at = clock_timestamp() - interval '1 second';
create temp table op649_recovered_lease as select * from public.claim_factory_workflow_accepted_triage_route(pg_temp.spec_id(902));
select ok((select current.occurrence_id = prior.occurrence_id and current.execution_generation = prior.execution_generation + 1
  and current.ownership_token <> prior.ownership_token from op649_recovered_lease current cross join op649_lease prior),
  'an abandoned dispatch lease recovers the same occurrence with fresh ownership');
select ok(not public.finish_factory_workflow_accepted_triage_route(root_session_id,workspace_id,factory_id,occurrence_id,
  execution_generation,ownership_token,true), 'the stale worker cannot mark the replacement lease complete') from op649_lease;

create temp table op649_ticket as
select lease.*,public.begin_factory_workflow_foreman_inference(root_session_id,workspace_id,factory_id,
  execution_generation,ownership_token,occurrence_id) as issued from op649_recovered_lease lease;
select ok((select issued->>'status' = 'issued' and issued->>'sourceCheckpointRunId' = scope.run_id::text    and issued->>'taskPromptMd' like '%- Include a UTC date column.%'
  from op649_ticket ticket join internal.factory_workflow_accepted_scopes scope on scope.session_id = ticket.root_session_id),
  'the established foreman runtime issues one inference at the accepted source');
select ok((select public.begin_factory_workflow_foreman_inference(root_session_id,workspace_id,factory_id,
  execution_generation,ownership_token,occurrence_id)->>'status' = 'existing' from op649_ticket),
  'replaying the claimed occurrence does not obtain another inference permit');

create temp table op649_plan as
select jsonb_build_object('status','accepted','planJson',body,'planDigest',encode(sha256(convert_to(body,'UTF8')),'hex'),
  'usage','{"inputTokens":12,"outputTokens":3,"costUsd":0.05}'::jsonb,'providerReceiptId','accepted-triage-proof') as outcome
from (values ('{"version":1,"commands":[{"kind":"route","decision":{"kind":"choose","destinationNodeId":"agent.child","confidence":0.9,"reason":"Proceed."}},{"kind":"delegate","targetNodeId":"agent.child","title":"Child","promptMd":"Implement it."}]}')) plan(body);
select is(public.settle_factory_workflow_foreman_inference(root_session_id,workspace_id,factory_id,
  execution_generation,ownership_token,occurrence_id,(issued->>'issueId')::uuid,outcome)->>'status','accepted',
  'the exact issue settles a bounded route and assignment plan')
from op649_ticket cross join op649_plan;
select is(public.dispatch_factory_workflow_foreman_command(root_session_id,workspace_id,factory_id,
  execution_generation,ownership_token,occurrence_id,(issued->>'foremanRunId')::uuid,1)->>'status','accepted',
  'the retained route command makes its declared agent reachable') from op649_ticket;

select ok(public.finish_factory_workflow_accepted_triage_route(root_session_id,workspace_id,factory_id,occurrence_id,
  execution_generation,ownership_token,true), 'maintenance yields the exact lease after an interrupted route dispatch') from op649_ticket;
select ok((select finished_at is null and lease_token is null from internal.factory_workflow_triage_route_dispatches),
  'an unresolved persisted child command prevents premature completion');
update internal.factory_workflow_triage_route_dispatches set due_at = clock_timestamp() - interval '1 second';
create temp table op649_assignment_lease as
select resumed.*,ticket.issued from public.claim_factory_workflow_accepted_triage_route(pg_temp.spec_id(904)) resumed
join op649_ticket ticket using (root_session_id,occurrence_id);
select ok((select resumed.execution_generation = ticket.execution_generation + 1
    and resumed.issued->>'foremanRunId' = ticket.issued->>'foremanRunId'
  from op649_assignment_lease resumed join op649_ticket ticket using (root_session_id,occurrence_id)),
  'another maintenance pass resumes the persisted plan without issuing a new inference');

create temp table op649_assigned as
select dispatch.result, (dispatch.result->>'jobId')::uuid as job_id, (dispatch.result->>'childSessionId')::uuid as child_session_id
from op649_assignment_lease ticket cross join lateral (select public.dispatch_factory_workflow_foreman_command(
  ticket.root_session_id,ticket.workspace_id,ticket.factory_id,ticket.execution_generation,ticket.ownership_token,
  ticket.occurrence_id,(ticket.issued->>'foremanRunId')::uuid,2)) dispatch(result);
select ok((select assigned.result->>'status' = 'accepted' and marker.accepted_scope_receipt_id = scope.receipt_id
  and marker.source_checkpoint_run_id = scope.run_id
  from op649_assigned assigned join internal.factory_workflow_delegations marker using (child_session_id)
  join internal.factory_workflow_accepted_scopes scope on scope.session_id = marker.root_session_id),
  'the native assignment freezes the approved scope separately from its short task prompt');
select ok(public.finish_factory_workflow_accepted_triage_route(root_session_id,workspace_id,factory_id,occurrence_id,
  execution_generation,ownership_token,true), 'the exact current maintenance lease settles after assignment') from op649_assignment_lease;
select is((select count(*) from public.claim_factory_workflow_accepted_triage_route(pg_temp.spec_id(903))),0::bigint,
  'the next maintenance pass does not replay a completed dispatch');

update public.agent_jobs job set created_at = '1900-01-01T00:00:00Z', scheduled_at = null
from op649_assigned assigned where job.id = assigned.job_id;
select is((select claimed.id from public.claim_next_agent_job(false,1,'node') claimed where claimed.attempt_count = 1),
  (select job_id from op649_assigned),'the normal worker queue claims the admitted child');
create temp table op649_started_child as
select child.*,public.start_session_job_attempt(job_id,1,pg_temp.spec_id(11),0,'codex','gpt-5.5',
  'code','wallie/op649-child-' || job_id::text) as run_id
from op649_assigned child;
create temp table op649_approved_input as
select child.*,public.read_factory_workflow_delegated_scope(pg_temp.spec_id(2),job_id,run_id,1) as context
from op649_started_child child;
select ok((select input.context->>'status' = 'required' and input.context->>'receiptId' = scope.receipt_id::text
    and input.context#>>'{pin,artifactDigest}' = scope.artifact_digest
    and input.context#>>'{pin,workflowDigest}' = scope.workflow_digest
    and input.context->>'artifactMarkdown' like '%- Include a UTC date column.%'
  from op649_approved_input input join internal.factory_workflow_delegations marker using (child_session_id)
  join internal.factory_workflow_accepted_scopes scope on scope.session_id = marker.root_session_id),
  'the exact started attempt receives approved criteria and their source identity');
select throws_ok($q$select public.read_factory_workflow_delegated_scope(pg_temp.spec_id(2),job_id,run_id,2) from op649_started_child$q$,
  '42501', null, 'another attempt cannot read the current child scope');

-- The native freeze guard checks the exact body fingerprint independently of the prompt adapter.
select throws_ok($q$select pg_temp.freeze_op649_context(run_id) from op649_started_child$q$,
  'PT422', 'The exact approved scope is required in delegated run context.',
  'the child cannot freeze its task prompt without the approved scope input');
create temp table op649_child_manifest as
select child.job_id, child.run_id, jsonb_build_object(
  'version',1,'required',jsonb_build_array(jsonb_build_object('key',key.ref,
    'sha256',encode(sha256(convert_to(body.text,'UTF8')),'hex'),'utf8Bytes',octet_length(body.text))),
  'documents','[]'::jsonb,'conversation','{"throughSequence":0,"olderOmitted":0,"messages":[]}'::jsonb,
  'budget',jsonb_build_object('maxUtf8Bytes',1024,'maxEstimatedTokens',1024,
    'usedUtf8Bytes',octet_length(body.text),'estimatedTokens',octet_length(body.text))
) manifest
from op649_approved_input child
cross join lateral (select child.context->>'artifactMarkdown') artifact(md)
cross join lateral (select substring(artifact.md from strpos(artifact.md,E'\n') + 1)) body(text)
cross join lateral (select concat_ws('/','approved-scope',child.context#>>'{pin,approvalId}',
  child.context#>>'{pin,artifactId}',child.context#>>'{pin,artifactVersion}',child.context#>>'{pin,artifactDigest}')) key(ref);
select throws_ok($q$select public.pin_factory_run_context(pg_temp.spec_id(2),job_id,run_id,1,
  jsonb_set(manifest,'{required,0,sha256}',to_jsonb(repeat('0',64)))) from op649_child_manifest$q$,
  'PT422', null, 'an identity-only or edited child scope cannot pass the native context guard');
select is(pinned.manifest,inputs.manifest,'the exact accepted scope fingerprint is frozen in the child attempt')
from op649_child_manifest inputs cross join lateral public.pin_factory_run_context(
  pg_temp.spec_id(2),inputs.job_id,inputs.run_id,1,inputs.manifest) pinned;
select is(public.fail_session_job_attempt(job_id,1,'Retry a delegated run',true,3,run_id),
  'queued','the ordinary worker retry preserves the delegated allocation') from op649_started_child;
update public.agent_jobs job set scheduled_at = null
from op649_started_child child where job.id = child.job_id;
create temp table op649_retried_child as
select input.*,claimed.attempt_count,
  public.start_session_job_attempt(claimed.id,claimed.attempt_count,pg_temp.spec_id(11),0,'codex','gpt-5.5',
    'code','wallie/op649-child-retry-' || claimed.id::text) retry_run_id
from op649_child_manifest input join public.claim_next_agent_job(false,1,'node') claimed on claimed.id = input.job_id;
select ok((select attempt_count = 2 and retry_run_id <> run_id from op649_retried_child),
  'the retried child has a fresh exact run identity');
select is(public.read_factory_workflow_delegated_scope(pg_temp.spec_id(2),retry.job_id,retry.retry_run_id,2),
  original.context,'the replacement attempt observes the same immutable approved scope')
from op649_retried_child retry join op649_approved_input original using (job_id);
select is(pinned.origin_run_id,retry.run_id,'freezing the replacement context replays the prior exact scope fingerprint')
from op649_retried_child retry cross join lateral public.pin_factory_run_context(
  pg_temp.spec_id(2),retry.job_id,retry.retry_run_id,2,retry.manifest,retry.run_id) pinned;
select is((select root.context->>'status' from main_spec main
  cross join lateral (select public.read_factory_workflow_delegated_scope(pg_temp.spec_id(2), main.job_id, main.run_id, 1)) root(context)),
  'ordinary','a nondelegated session receives no child scope');
select ok(not has_function_privilege(role.name,'public.read_factory_workflow_delegated_scope(uuid,uuid,uuid,integer)','execute')
  and not has_function_privilege(role.name,'public.claim_factory_workflow_accepted_triage_route(uuid)','execute'),
  role.name || ' cannot read scope or claim a triage route')
from (values ('anon'), ('authenticated')) role(name);
select * from finish();
rollback;
