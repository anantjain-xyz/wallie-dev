begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
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
select ok(pg_temp.spec_publish((select id from final_spec_run),'# Final specification'),
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

select pg_temp.spec_activate(5, true, pg_temp.spec_id(31), single_stage=>true);
create temp table budget_spec as select * from pg_temp.spec_create(103, true, array[pg_temp.spec_id(11)]);
insert into spec_targets select 'budget', session_id from budget_spec;
select ok(pg_temp.spec_publish(pg_temp.spec_start('budget'),pg_temp.spec_marker('Is the budget available?')),
  'the initial draft can publish even with no budget for revisions');
create temp table budget_question as select id from public.session_specification_clarifications where session_id=(select session_id from budget_spec);
create temp table budget_answer as select * from pg_temp.spec_answer((select id from budget_question),204,'No.');
select ok((select execution_exhausted and not replayed and feedback_batch_id is not null and job_id is null and run_id is null from budget_answer),
  'an exhausted budget keeps the canonical feedback receipt without a fabricated job');
select results_eq($q$select * from pg_temp.spec_answer((select id from budget_question),204,'No.')$q$,
  'select clarification_id,feedback_batch_id,job_id,run_id,execution_exhausted,true from budget_answer',
  'an exhausted answer replays without trying to schedule a revision');
select ok(exists(select 1 from public.session_conversation_messages where session_id=(select session_id from budget_spec)
  and author_kind='user' and body_md like '%Clarification answer: No.'),
  'an exhausted but accepted answer remains in shared conversation history');

-- Two independently authenticated connections race an answer and a cancel.
-- The cancel carries the last generation seen before the answer committed.
select pg_temp.spec_activate(6, true, pg_temp.spec_id(30));
create temp table raced_spec as select * from pg_temp.spec_create(104);
insert into spec_targets select 'race', session_id from raced_spec;
select ok(pg_temp.spec_publish(pg_temp.spec_start('race'),pg_temp.spec_marker('What should survive cancellation?')),
  'the concurrency fixture starts from an exact pending clarification');
create temp table race_question as select * from public.session_specification_clarifications where session_id=(select session_id from raced_spec);
commit;
begin;

select extensions.dblink_connect('spec_answer',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('spec_cancel',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('spec_cancel','set application_name = ''specification_cancel_contender''; set statement_timeout = ''15s''');
select extensions.dblink_exec('spec_answer','begin');
create temp table raced_answer as select result.* from race_question question
cross join lateral extensions.dblink('spec_answer',format($q$
  select job_id, run_id from public.answer_session_specification_clarification_once(
    %L,%L,%L,%L,%L,%L,%L,0,%L,'The reviewed answer.','codex','gpt-5.5','code')
$q$,question.workspace_id,question.factory_id,question.session_id,pg_temp.spec_id(3),question.id,
  question.artifact_id,question.artifact_version,pg_temp.spec_id(205))) result(job_id uuid,run_id uuid);
select ok((select job_id is not null and run_id is not null from raced_answer),
  'the answer owns a successor before its transaction commits');
select extensions.dblink_send_query('spec_cancel',format($q$
  select replayed from public.cancel_session_command_once(%L,%L,%L,%L,%L,repeat('b',64),%L)
$q$,workspace_id,factory_id,pg_temp.spec_id(3),session_id,pg_temp.spec_id(211),run_id)) from race_question;
create function pg_temp.wait_specification_cancel() returns boolean language plpgsql as $$
declare deadline timestamptz := clock_timestamp()+interval '5 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists(select 1 from pg_stat_activity where application_name='specification_cancel_contender' and wait_event_type='Lock') then
      return true;
    end if;
    if clock_timestamp() >= deadline then return false; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;
select ok(pg_temp.wait_specification_cancel(),'cancellation waits behind the exact answer transaction');
select extensions.dblink_exec('spec_answer','commit');
select is((select count(*) from extensions.dblink_get_result('spec_cancel',false) result(replayed boolean)),
  0::bigint,'the stale cancel returns no receipt after the answer commits');
select is((select status::text from public.agent_jobs where id=(select job_id from raced_answer)),
  'queued','the answer’s successor survives the cancellation race');
select is((select status::text from public.agent_runs where id=(select run_id from raced_answer)),
  'queued','the successor run remains eligible after the stale cancel');
select extensions.dblink_disconnect('spec_cancel');
select extensions.dblink_disconnect('spec_answer');
delete from public.workspaces where id = pg_temp.spec_id(2);
delete from auth.users where id in (pg_temp.spec_id(1),pg_temp.spec_id(4));
select * from finish();
commit;
