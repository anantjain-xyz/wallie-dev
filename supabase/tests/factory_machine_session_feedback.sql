begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
select public.set_git_continuity_release(true, revision, 'Machine feedback fixture')
from public.get_git_continuity_release_state() where not enabled;

create function pg_temp.spec_id(slot integer) returns uuid language sql immutable as $$
  select ('57110000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
set local request.jwt.claim.sub = '57110000-0000-4000-8000-000000000001';
insert into auth.users(id, email) values (pg_temp.spec_id(1), 'machine-feedback-owner@example.test');
insert into public.workspaces(id, slug, name) values (pg_temp.spec_id(2), 'machine-feedback-fixture', 'Specification fixture');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.spec_id(3), pg_temp.spec_id(2), pg_temp.spec_id(1), 'human', 'owner');
insert into public.pipelines(id, workspace_id, name, is_default) values (pg_temp.spec_id(10), pg_temp.spec_id(2), 'Custom delivery', true);
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name, prompt_template_md, anyone_can_approve) values
  (pg_temp.spec_id(11), pg_temp.spec_id(10), pg_temp.spec_id(2), 1, 'investigate', 'Investigate', 'Investigate', true),
  (pg_temp.spec_id(12), pg_temp.spec_id(10), pg_temp.spec_id(2), 2, 'ship', 'Ship', 'Ship', true);
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.spec_id(20), pg_temp.spec_id(2), 57110001, 'https://github.test/installations/57110001', 56600,
  'Organization', 'spec-fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, github_installation_id, repo_id, name, full_name, private, html_url, default_branch)
values (pg_temp.spec_id(21), pg_temp.spec_id(2), pg_temp.spec_id(20), 571101,
  'specification', 'fixture/specification', true, 'https://github.test/fixture/specification', 'main');
insert into public.workspace_sandbox_settings(workspace_id,active_provider) values (pg_temp.spec_id(2),'e2b')
on conflict (workspace_id) do update set active_provider=excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id,encrypted_api_key)
values (pg_temp.spec_id(2),'specification-fixture-ciphertext');
insert into public.execution_policy_revisions(id, workspace_id, revision, requirements, created_by) values
  (pg_temp.spec_id(30), pg_temp.spec_id(2), 10,
    '{"version":1,"maxRepairAttempts":5,"maxExecutionMs":3600000,"maxTotalTokens":null,"maxCostUsd":null}', pg_temp.spec_id(1));
create function pg_temp.spec_factory() returns uuid language sql stable as $$
  select id from public.factories where workspace_id = pg_temp.spec_id(2) and is_default
$$;
create temp table feedback_principal as
select principal.* from public.create_service_principal(
  pg_temp.spec_id(2), pg_temp.spec_factory(), pg_temp.spec_id(1), 'Fixture feedback client', 'fixture-client') principal;
create temp table feedback_grant as
select approved.* from feedback_principal principal cross join lateral public.approve_factory_execution_grant(
  principal.workspace_id, principal.factory_id, pg_temp.spec_id(1), principal.id,
  pg_temp.spec_id(21), '{}', '{}', pg_temp.spec_id(30), pg_temp.spec_id(3),
  clock_timestamp()+interval '1 hour', 0, null,
  '{sessions:follow-up,sessions:clarify}'::public.factory_command_scope[]) approved;
insert into public.workspace_secrets(id, workspace_id, key, encrypted_value, value_preview)
values (pg_temp.spec_id(40), pg_temp.spec_id(2), 'FEEDBACK_FIXTURE_KEY','synthetic-feedback-credential','...fixture');
create temp table feedback_binding as
select binding.* from feedback_grant approved join public.factory_agents agent
  on (agent.workspace_id, agent.factory_id)=(approved.workspace_id, approved.factory_id) and agent.is_default
cross join lateral public.create_factory_secret_binding(
  approved.workspace_id, approved.factory_id, pg_temp.spec_id(1), approved.id, approved.version,
  agent.id, 'codex', pg_temp.spec_id(40)) binding;
select public.issue_factory_machine_token(approved.workspace_id, approved.factory_id, pg_temp.spec_id(1),
  approved.id, approved.version, pg_temp.spec_id(41), repeat('a',64),
  'Machine feedback','{sessions:follow-up,sessions:clarify}')
from feedback_grant approved;

create function pg_temp.spec_activate()
returns void language sql as $$
  with snapshot as (
    select jsonb_build_object('agentId',agent.id,'promptRevisionId',prompt.id,'promptMd',prompt.prompt_md,'promptSha256',prompt.prompt_sha256) contents
    from public.factory_agents agent join public.factory_agent_prompt_revisions prompt on prompt.agent_id=agent.id
    where agent.factory_id=pg_temp.spec_factory() and agent.is_default and prompt.revision_number=1
  ), definition as (
    select (jsonb_build_object('schemaVersion',1,'kind','serial','sandboxProvider','e2b',
      'pipelineId',pg_temp.spec_id(10),'repositoryId',pg_temp.spec_id(21),'executionPolicyRevisionId',pg_temp.spec_id(30),
      'deliveryPolicyRevisionId',null,'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,
      'executionGrant',(select jsonb_build_object('id', approved.id, 'version', approved.version) from feedback_grant approved),
      'credentialBindingId',(select binding.id from feedback_binding binding),
      'operatingRulesMd','','operatingRuleStageIds','[]'::jsonb,
      'agent',jsonb_build_object('provider','codex','model','gpt-5.5','effort',null,
        'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
      'stages',(select jsonb_agg(jsonb_build_object('id',stage.id,'slug',stage.slug,'name',stage.name,'description','',
        'promptTemplateMd',stage.prompt_template_md,'anyoneCanApprove',true,'previousStageIds','[]'::jsonb,
        'approverMemberIds','[]'::jsonb) order by stage.position) from public.pipeline_stages stage
        where stage.pipeline_id=pg_temp.spec_id(10)),
      'implementationAgent',snapshot.contents))::text bytes
    from snapshot
  ), revision as (
    insert into public.factory_definition_revisions(workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
    select pg_temp.spec_id(2),pg_temp.spec_factory(),1,bytes,encode(sha256(convert_to(bytes,'UTF8')),'hex'),pg_temp.spec_id(1)
      from definition returning *
  )
  insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
  select workspace_id,factory_id,id,1,created_by from revision;
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
select pg_temp.spec_activate();
create temp table spec_targets(label text primary key, session_id uuid not null);
insert into spec_targets select 'review', session_id from pg_temp.spec_create(100,false);
insert into spec_targets select 'clarification', session_id from pg_temp.spec_create(101);
insert into spec_targets select 'exhausted', session_id from pg_temp.spec_create(102);
insert into spec_targets select 'machine-answered', session_id from pg_temp.spec_create(111);

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

select ok(pg_temp.spec_publish(pg_temp.spec_start('review'), '# Exact artifact'),
  'the regular review target has an accepted checkpoint');
select ok(pg_temp.spec_publish(pg_temp.spec_start('clarification'), pg_temp.spec_marker('Which deadline?')),
  'the specification target has an exact pending question');
select ok(pg_temp.spec_publish(pg_temp.spec_start('exhausted'), pg_temp.spec_marker('Which environment?')),
  'a second specification target has its own pending question');
select ok(pg_temp.spec_publish(pg_temp.spec_start('machine-answered'), pg_temp.spec_marker('What region?')),
  'a valid machine answer starts from one immutable pending question');
update public.sessions set execution_repair_attempts = 5
where id=(select session_id from spec_targets where label='exhausted');

create function pg_temp.feedback_target(p_label text) returns public.sessions language sql stable as $$
  select session from public.sessions session join spec_targets target on target.session_id=session.id
  where target.label=p_label;
$$;
create function pg_temp.follow_up_intent(p_label text, feedback text default 'Please revise.', review bigint default null)
returns jsonb language sql stable as $$
  select jsonb_build_object('sessionId', session.id, 'stageId', session.current_stage_id,
    'artifactId', session.current_artifact_id, 'artifactVersion', session.current_artifact_version,
    'reviewRevision', coalesce(review, session.artifact_review_revision), 'feedback', feedback)
  from pg_temp.feedback_target(p_label) session;
$$;
create function pg_temp.answer_intent(p_label text, answer text default 'Friday.', review bigint default null)
returns jsonb language sql stable as $$
  select jsonb_build_object('sessionId', session.id, 'clarificationId', question.id,
    'artifactId', question.artifact_id, 'artifactVersion', question.artifact_version,
    'reviewRevision', coalesce(review, session.artifact_review_revision), 'answer', answer)
  from pg_temp.feedback_target(p_label) session
  join public.session_specification_clarifications question on question.session_id=session.id;
$$;

create function pg_temp.machine_feedback(
  p_operation public.factory_session_mutation_operation, p_key integer, p_payload jsonb,
  p_scope public.factory_command_scope default null
) returns jsonb language plpgsql as $$
declare admitted record; request_id uuid := gen_random_uuid(); result jsonb;
begin
  select * into strict admitted from public.admit_factory_command(pg_temp.spec_id(2), pg_temp.spec_factory(),
    'machine_token', pg_temp.spec_id(41), repeat('a',64),
    coalesce(p_scope, internal.session_mutation_scope(p_operation)), request_id, repeat('b',64), 'api');
  if admitted.status <> 'admitted' then raise exception 'Unexpected test admission %', admitted.status; end if;
  result := public.execute_factory_session_mutation(pg_temp.spec_id(2), pg_temp.spec_factory(), 'machine_token',
    pg_temp.spec_id(41), repeat('a',64), request_id, repeat('b',64), 'api',
    admitted.admission_id, admitted.lease_id, p_operation, pg_temp.spec_id(p_key), p_payload);
  perform public.release_factory_command_admission(admitted.admission_id, admitted.lease_id);
  return result;
end;
$$;

grant select on spec_targets to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
create temp table review_blocker as
select (public.create_artifact_review_thread_once(pg_temp.spec_id(103), session.workspace_id, session.id,
  session.current_stage_id, session.current_artifact_id, session.current_artifact_version,
  '{"coordinateSystem":"unicode_code_points","start":0,"end":1,"quote":"#","prefix":"","suffix":" Exact artifact"}',
  'blocking', 'Keep this human request open.')).id
from pg_temp.feedback_target('review') session;
reset role;
set local request.jwt.claim.role = 'service_role';

select throws_ok(
  $q$select pg_temp.machine_feedback('follow_up',104,pg_temp.follow_up_intent('review',review=>0))$q$,
  '40001','Artifact or inline review changed. Refresh the review before submitting feedback.',
  'a machine follow-up cannot cross a changed human thread revision');
select throws_ok(
  $q$select pg_temp.machine_feedback('follow_up',105,pg_temp.follow_up_intent('clarification'))$q$,
  'PT423','Answer the open specification clarification before requesting changes.',
  'a follow-up leaves a pending clarification active');
select throws_ok(
  $q$select pg_temp.machine_feedback('answer_clarification',106,pg_temp.answer_intent('clarification'),'sessions:follow-up')$q$,
  'PT409','Command admission is unavailable.',
  'a follow-up permit cannot authorize a clarification answer');
select throws_ok(
  $q$select pg_temp.machine_feedback('answer_clarification',106,pg_temp.answer_intent('clarification',review=>1))$q$,
  'P0003','The specification review changed. Refresh before answering.',
  'a stale machine clarification cannot queue a successor');
select throws_ok(
  $q$select pg_temp.machine_feedback('follow_up',106,pg_temp.follow_up_intent('review') ||
    '{"selectedThreadIds":["57110000-0000-4000-8000-000000000001"]}')$q$,
  '22023','Invalid session mutation intent.','machine commands cannot select human threads');

create temp table review_intent as select pg_temp.follow_up_intent('review') value;
create temp table review_receipt as select pg_temp.machine_feedback('follow_up',107,value) value from review_intent;
select ok((select (value->>'replayed')::boolean is false and (value->>'executionExhausted')::boolean is false
  and value->>'jobId' is not null and value->>'runId' is not null from review_receipt),
  'machine feedback commits one exact successor');
select is((select pg_temp.machine_feedback('follow_up',107, intent.value) - 'replayed' from review_intent intent),
  (select value - 'replayed' from review_receipt), 'machine retries recover the same durable receipt');
select throws_ok(
  $q$select pg_temp.machine_feedback('follow_up',107,pg_temp.follow_up_intent('review','Different note.'))$q$,
  'P0005','The session request identity was already used for different input.',
  'changing feedback under the same idempotency key conflicts');
select is((select submitted.feedback_batch_id from review_intent intent
  cross join lateral public.submit_session_follow_up_once(
    (intent.value->>'sessionId')::uuid, pg_temp.spec_id(2), pg_temp.spec_factory(),
    (intent.value->>'artifactVersion')::integer, (intent.value->>'stageId')::uuid,
    (intent.value->>'artifactId')::uuid, intent.value->>'feedback', (intent.value->>'reviewRevision')::bigint,
    pg_temp.spec_id(107), '{}'::uuid[], p_requested_by_member_id=>pg_temp.spec_id(3)) submitted),
  (select (value->>'feedbackBatchId')::uuid from review_receipt),
  'equivalent authenticated browser request replays a machine-originated batch');
select ok(exists(select 1 from review_receipt receipt join public.artifact_feedback_batches batch
  on batch.id=(receipt.value->>'feedbackBatchId')::uuid
  join public.artifact_feedback_batch_jobs link on (link.batch_id,link.job_id)=(batch.id,batch.job_id)
  join public.session_conversation_messages message on message.feedback_batch_id=batch.id
  where batch.requested_by_member_id is null and batch.requested_by_service_principal_id=(select id from feedback_principal)
    and cardinality(batch.selected_thread_ids)=0 and batch.whole_stage_feedback='Please revise.'
    and message.author_kind='service' and message.originating_member_id is null
    and message.originating_service_principal_id=batch.requested_by_service_principal_id),
  'machine feedback and conversation preserve service attribution and one immutable worker input');
select ok((select thread.status='open' and thread.revision=1 from review_blocker blocker
  join public.artifact_review_threads thread on thread.id=blocker.id),
  'machine feedback never changes human blocking thread disposition');

create temp table human_answer_intent as select pg_temp.answer_intent('clarification') value;
create temp table human_answer_receipt as
select answer.* from human_answer_intent intent cross join lateral public.answer_session_specification_clarification_once(
  pg_temp.spec_id(2), pg_temp.spec_factory(), (intent.value->>'sessionId')::uuid, pg_temp.spec_id(3),
  (intent.value->>'clarificationId')::uuid, (intent.value->>'artifactId')::uuid,
  (intent.value->>'artifactVersion')::integer, (intent.value->>'reviewRevision')::bigint,
  pg_temp.spec_id(108), intent.value->>'answer', 'codex', 'gpt-5.5', 'code') answer;
select ok((select (replay.value->>'replayed')::boolean and replay.value->>'feedbackBatchId'=answer.feedback_batch_id::text
  and replay.value->>'jobId'=answer.job_id::text and replay.value->>'runId'=answer.run_id::text
  from human_answer_receipt answer cross join human_answer_intent intent
  cross join lateral (select pg_temp.machine_feedback('answer_clarification',108,intent.value) value) replay),
  'an equivalent machine command replays the authenticated human answer');
select ok((select question.answered_by_member_id=pg_temp.spec_id(3) and question.answered_by_service_principal_id is null
  from public.session_specification_clarifications question join human_answer_receipt answer on answer.clarification_id=question.id),
  'machine replay preserves the original human answer attribution');
select throws_ok(
  $q$select pg_temp.machine_feedback('answer_clarification',109,pg_temp.answer_intent('clarification'))$q$,
  'P0003','The specification review changed. Refresh before answering.',
  'a second key cannot overwrite an answered question or queue a second successor');

create temp table exhausted_answer_intent as select pg_temp.answer_intent('exhausted','Staging.') value;
create temp table exhausted_receipt as
select pg_temp.machine_feedback('answer_clarification',110,value) value from exhausted_answer_intent;
select ok((select (value->>'executionExhausted')::boolean and value->>'jobId' is null
  and value->>'runId' is null and value->>'feedbackBatchId' is not null from exhausted_receipt),
  'a budget-exhausted machine answer commits a receipt without fabricating a successor');
select ok(exists(select 1 from public.session_specification_clarifications question
  join exhausted_receipt receipt on question.id=(receipt.value->>'clarificationId')::uuid
  join public.artifact_feedback_batches batch on batch.id=question.feedback_batch_id
  where question.status='answered' and question.answered_by_member_id is null
    and question.answered_by_service_principal_id=(select id from feedback_principal)
    and batch.requested_by_service_principal_id=question.answered_by_service_principal_id
    and batch.whole_stage_feedback=E'Clarification question: Which environment?\n\nClarification answer: Staging.'),
  'an exhausted answer retains exact question and service feedback without impersonation');
select ok((select (pg_temp.machine_feedback('answer_clarification',110,intent.value)->>'replayed')::boolean
  from exhausted_answer_intent intent), 'the exhausted result is independently retryable');

create temp table machine_answer_receipt as
select pg_temp.machine_feedback('answer_clarification',112,pg_temp.answer_intent('machine-answered','West.')) value;
select ok(exists(select 1 from public.session_specification_clarifications question
  join machine_answer_receipt receipt on question.id=(receipt.value->>'clarificationId')::uuid
  join public.artifact_feedback_batches batch on batch.id=question.feedback_batch_id
  join public.artifact_feedback_batch_jobs link on (link.batch_id,link.job_id)=(batch.id,question.successor_job_id)
  where question.status='answered' and not question.execution_exhausted
    and question.answered_by_member_id is null and question.answered_by_service_principal_id=(select id from feedback_principal)
    and question.successor_run_id=batch.run_id and batch.artifact_id=question.artifact_id
    and batch.rendered_feedback_text=E'Whole-stage feedback:\nClarification question: What region?\n\nClarification answer: West.'),
  'a valid machine answer queues one exact successor with its immutable question and answer');

select * from finish();
rollback;
