begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set request.jwt.claim.role='service_role';

create function pg_temp.outbox_id(slot integer) returns uuid language sql immutable as $$
  select ('57400000-0000-4000-8000-' || lpad(slot::text,12,'0'))::uuid
$$;
set request.jwt.claim.sub='57400000-0000-4000-8000-000000000001';
insert into auth.users(id,email) values
  (pg_temp.outbox_id(1),'event-subscriptions-owner@example.test'),
  (pg_temp.outbox_id(2),'event-subscriptions-member@example.test');
insert into auth.sessions(id,user_id,created_at,updated_at) values (pg_temp.outbox_id(8),pg_temp.outbox_id(2),now(),now());
insert into public.workspaces(id,slug,name) values (pg_temp.outbox_id(3),'factory-event-outbox-fixture','Factory event outbox');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  (pg_temp.outbox_id(4),pg_temp.outbox_id(3),pg_temp.outbox_id(1),'human','owner'),
  (pg_temp.outbox_id(5),pg_temp.outbox_id(3),pg_temp.outbox_id(2),'human','member');
create function pg_temp.outbox_factory() returns uuid language sql stable as $$
  select id from public.factories where workspace_id=pg_temp.outbox_id(3) and is_default
$$;

insert into public.pipelines(id,workspace_id,factory_id,name,is_default)
values (pg_temp.outbox_id(10),pg_temp.outbox_id(3),pg_temp.outbox_factory(),'Outbox pipeline',true);
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,prompt_template_md,anyone_can_approve)
values (pg_temp.outbox_id(11),pg_temp.outbox_id(10),pg_temp.outbox_id(3),1,'draft','Draft','Write an artifact',true);
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions)
values (pg_temp.outbox_id(20),pg_temp.outbox_id(3),57400001,'https://github.test/installations/57400001',574000,
  'Organization','event-fixture','{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id,workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch)
select pg_temp.outbox_id(slot),pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(20),57400000+slot,
  name,'fixture/'||name,true,'https://github.test/fixture/'||name,'main'
from (values (21,'writer'),(22,'alternate')) repo(slot,name);
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values (pg_temp.outbox_id(1),'platform_api_key','never-project-private-credential');
insert into public.workspace_sandbox_settings(workspace_id,active_provider) values (pg_temp.outbox_id(3),'e2b')
on conflict (workspace_id) do update set active_provider=excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id,encrypted_api_key)
values (pg_temp.outbox_id(3),'never-project-private-sandbox');
create temp table outbox_policy as select * from public.save_execution_policy(pg_temp.outbox_id(3),pg_temp.outbox_id(1),0,
  '{"version":1,"maxRepairAttempts":3,"maxExecutionMs":3600000,"maxTotalTokens":null,"maxCostUsd":null}');

with definition as (
  select jsonb_build_object('schemaVersion',1,'kind','serial','sandboxProvider','e2b',
    'pipelineId',pg_temp.outbox_id(10),'repositoryId',pg_temp.outbox_id(21),'executionPolicyRevisionId',policy.id,
    'deliveryPolicyRevisionId',null,'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,'operatingRulesMd','','operatingRuleStageIds','[]'::jsonb,
    'agent',jsonb_build_object('provider','codex','model','gpt-5.5','effort',null,
      'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
    'implementationAgent',jsonb_build_object('agentId',agent.id,'promptRevisionId',prompt.id,
      'promptMd',prompt.prompt_md,'promptSha256',prompt.prompt_sha256),
    'stages',jsonb_build_array(jsonb_build_object('id',pg_temp.outbox_id(11),'slug','draft','name','Draft',
      'description','','promptTemplateMd','Write an artifact','anyoneCanApprove',true,
      'previousStageIds','[]'::jsonb,'approverMemberIds','[]'::jsonb)))::text bytes
  from outbox_policy policy cross join public.factory_agents agent
  join public.factory_agent_prompt_revisions prompt on prompt.agent_id=agent.id
  where agent.factory_id=pg_temp.outbox_factory() and agent.is_default and prompt.revision_number=1
), revision as (
  insert into public.factory_definition_revisions(workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
  select pg_temp.outbox_id(3),pg_temp.outbox_factory(),1,bytes,encode(sha256(convert_to(bytes,'UTF8')),'hex'),pg_temp.outbox_id(1)
  from definition returning *
)
insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,id,1,pg_temp.outbox_id(1) from revision;

create temp table outbox_principal as select * from public.create_service_principal(
  pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1),'Outbox client','outbox-client');
create temp table outbox_grant as select approved.* from outbox_principal principal cross join outbox_policy policy
cross join lateral public.approve_factory_execution_grant(principal.workspace_id,principal.factory_id,pg_temp.outbox_id(1),principal.id,
  pg_temp.outbox_id(21),array[pg_temp.outbox_id(22)],'{}',policy.id,pg_temp.outbox_id(4),clock_timestamp()+interval '1 hour',0,null,
  '{sessions:read,sessions:cancel}'::public.factory_command_scope[]) approved;
select public.issue_factory_machine_token(workspace_id,factory_id,pg_temp.outbox_id(1),id,version,
  pg_temp.outbox_id(31),repeat('a',64),'Outbox token','{sessions:read}') from outbox_grant;
select public.issue_factory_machine_token(workspace_id,factory_id,pg_temp.outbox_id(1),id,version,
  pg_temp.outbox_id(30),repeat('e',64),'Under-scoped token','{sessions:cancel}') from outbox_grant;
create temp table outbox_oauth_client as select client.* from outbox_grant approved
cross join lateral public.register_factory_oauth_client(approved.workspace_id,pg_temp.outbox_id(1),'Outbox OAuth',
  array['http://127.0.0.1:8123/callback'],'{sessions:read,sessions:cancel}',jsonb_build_array(jsonb_build_object(
    'factory_id',approved.factory_id,'execution_grant_id',approved.id,'execution_grant_version',approved.version))) client;
create temp table outbox_oauth_pending as select pending.* from outbox_oauth_client client
cross join lateral public.begin_factory_oauth_authorization(client.id,pg_temp.outbox_id(2),pg_temp.outbox_id(8),
  'http://127.0.0.1:8123/callback',repeat('a',42)||'A','{sessions:read,sessions:cancel}') pending;
select public.decide_factory_oauth_authorization(authorization_id,pg_temp.outbox_id(2),pg_temp.outbox_id(8),true,
  array[pg_temp.outbox_factory()],pg_temp.outbox_id(36),repeat('c',64)) from outbox_oauth_pending;
select is((select issued.status from outbox_oauth_client client cross join lateral public.exchange_factory_oauth_code(client.id,
  'http://127.0.0.1:8123/callback',pg_temp.outbox_id(36),repeat('c',64),repeat('a',42)||'A',
  pg_temp.outbox_id(32),repeat('a',64),pg_temp.outbox_id(37),repeat('b',64)) issued),'issued','OAuth fixture authorizes a live consent family');
create temp table outbox_consent as select grant_row.id
from public.factory_oauth_grants grant_row join outbox_oauth_client client on client.id=grant_row.client_id;

create temp table machine_subscription as select public.create_factory_event_subscription(pg_temp.outbox_id(3),pg_temp.outbox_factory(),
  pg_temp.outbox_id(1),'Machine subscription','https://events.example.test/machine','machine_token',pg_temp.outbox_id(31),
  '{session.created}','synthetic-encrypted-machine-signer') id;
create temp table oauth_subscription as select public.create_factory_event_subscription(pg_temp.outbox_id(3),pg_temp.outbox_factory(),
  pg_temp.outbox_id(1),'OAuth subscription','https://events.example.test/oauth','oauth_grant',(select id from outbox_consent),
  enum_range(null::public.factory_outbound_event_type),'synthetic-encrypted-oauth-signer') id;

select throws_ok($q$select public.list_factory_event_subscriptions(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(2))$q$,
  '42501',null,'an ordinary member cannot inspect outbound subscriptions');
select is((select count(*) from public.list_factory_event_authorizations(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1))),
  2::bigint,'manager credential picker offers live read token and OAuth family only');
select throws_ok($q$select public.create_factory_event_subscription(pg_temp.outbox_id(3),pg_temp.outbox_factory(),
  pg_temp.outbox_id(1),'Invalid authority','https://events.example.test/denied','machine_token',pg_temp.outbox_id(30),
  '{session.created}','synthetic')$q$,'42501',null,'an under-scoped token cannot bind a subscription');

create function pg_temp.verify_outbox_subscription(subscription_id uuid) returns boolean language plpgsql as $$
begin
  perform public.begin_factory_event_subscription_verification(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1),
    subscription_id,repeat('c',64));
  return public.confirm_factory_event_subscription(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1),
    subscription_id,repeat('c',64));
end;
$$;
select ok(not public.confirm_factory_event_subscription(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1),
  (select id from machine_subscription),repeat('c',64)), 'a pending subscription cannot activate without a challenge receipt');
select is((select endpoint_url from machine_subscription subscription cross join lateral public.begin_factory_event_subscription_verification(
  pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1),subscription.id,repeat('c',64))),
  'https://events.example.test/machine','the privileged challenge verifies the exact registered endpoint');
select ok(not public.confirm_factory_event_subscription(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1),
  (select id from machine_subscription),repeat('d',64)), 'the wrong challenge digest cannot activate');
select throws_ok($q$select * from public.begin_factory_event_subscription_verification(pg_temp.outbox_id(3),pg_temp.outbox_factory(),
  pg_temp.outbox_id(1),(select id from machine_subscription),repeat('d',64))$q$,'PT409',null,'challenge requests are rate limited');
select ok(public.confirm_factory_event_subscription(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1),
  (select id from machine_subscription),repeat('c',64)), 'the verified challenge activates the subscription');
select ok(not public.confirm_factory_event_subscription(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1),
  (select id from machine_subscription),repeat('c',64)), 'a consumed verification challenge cannot be reused');

create function pg_temp.outbox_create_session(title text,draft boolean default false)
returns table(session_id uuid,session_number integer,workspace_slug text,job_id uuid,run_id uuid) language sql as $$
  select created.* from public.factory_definition_revisions revision
  cross join lateral public.create_session_command_once(pg_temp.outbox_id(3),pg_temp.outbox_id(4),gen_random_uuid(),repeat('a',64),
    revision.canonical_digest,title,'never-project-private-prompt','codex','gpt-5.5','{}',
    target_factory_id=>pg_temp.outbox_factory(),draft_specification=>draft) created
  where revision.factory_id=pg_temp.outbox_factory()
$$;
create temp table first_session as select * from pg_temp.outbox_create_session('First private title');
select is((select count(*) from internal.factory_outbound_deliveries where workspace_id=pg_temp.outbox_id(3)),1::bigint,
  'canonical session creation queues only the verified subscription');
select ok(not exists(
  select 1 from public.list_factory_event_subscriptions(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1)) listed
  where to_jsonb(listed) ?| array['signing_secret_encrypted','verification_digest']),
  'manager metadata excludes signing material and challenge bytes');
commit;

begin;
select extensions.dblink_connect('outbox_first',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('outbox_second',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('outbox_first','begin');
create temp table original_claim as select * from extensions.dblink('outbox_first','select * from public.claim_factory_event_delivery()')
  claimed(delivery_id uuid,lease_id uuid,endpoint_url text,subscription_revision bigint);
select is((select count(*) from original_claim),1::bigint,'the first worker obtains the exact due lease');
select is((select count(*) from extensions.dblink('outbox_second','select delivery_id from public.claim_factory_event_delivery()')
  duplicate(delivery_id uuid)),0::bigint,'an independent worker skips the held delivery without creating another claim');
select extensions.dblink_exec('outbox_first','commit');
select extensions.dblink_disconnect('outbox_first');
select extensions.dblink_disconnect('outbox_second');

select results_eq($q$select outcome,payload,signing_secret_encrypted from original_claim claim
  cross join lateral public.begin_factory_event_send(claim.delivery_id,gen_random_uuid(),claim.subscription_revision)$q$,
  $q$values ('stale'::text,null::jsonb,null::text)$q$,'an altered lease cannot release event content or signing material');
create temp table original_send as select send.* from original_claim claim
cross join lateral public.begin_factory_event_send(claim.delivery_id,claim.lease_id,claim.subscription_revision) send;
select ok((select outcome='authorized' and attempt_id is not null and event_type='session.created'
    and payload->>'eventId'=event_id::text and payload->>'version'='1'
    and payload->>'sessionId'=(select session_id::text from first_session)
    and payload->>'occurredAt' is not null and payload::text !~ '(private|credential|endpoint|sandbox)'
    and signing_secret_encrypted='synthetic-encrypted-machine-signer' from original_send),
  'authorized send receives stable versioned identifiers and only its encrypted signing material');
select results_eq($q$select outcome,payload,signing_secret_encrypted from original_claim claim
  cross join lateral public.begin_factory_event_send(claim.delivery_id,claim.lease_id,claim.subscription_revision)$q$,
  $q$values ('stale'::text,null::jsonb,null::text)$q$,'a duplicate begin cannot transmit the same leased attempt twice');
select ok((select not public.settle_factory_event_delivery(delivery_id,lease_id,'delivered',gen_random_uuid(),200)
  from original_claim),'a stale attempt cannot settle the authorized send');
select ok((select public.settle_factory_event_delivery(delivery_id,lease_id,'unknown',attempt_id)
  from original_claim cross join original_send),'an ambiguous post-send outcome can be durably recorded');
select ok((select status='unknown' and has_unknown_outcome and next_attempt_at>clock_timestamp() and not retryable
  from public.list_factory_event_deliveries(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1),(select id from machine_subscription))),
  'an ambiguous outcome remains explicit during bounded automatic retry');

update internal.factory_outbound_deliveries set next_attempt_at=clock_timestamp()-interval '1 second'
where id=(select delivery_id from original_claim);
create temp table second_claim as select * from public.claim_factory_event_delivery();
create temp table second_send as select send.* from second_claim claim
cross join lateral public.begin_factory_event_send(claim.delivery_id,claim.lease_id,claim.subscription_revision) send;
select ok((select new_claim.delivery_id=old_claim.delivery_id and new_claim.lease_id<>old_claim.lease_id
    and new_send.event_id=old_send.event_id and new_send.payload=old_send.payload
    and new_send.attempt_id<>old_send.attempt_id
  from second_claim new_claim cross join original_claim old_claim cross join second_send new_send cross join original_send old_send),
  'retry preserves delivery, event, and payload while advancing the exact attempt capability');
select ok((select not public.settle_factory_event_delivery(old_claim.delivery_id,old_claim.lease_id,'delivered',old_send.attempt_id,200)
  from original_claim old_claim cross join original_send old_send),'the old permit cannot overwrite the retry');
select ok((select public.settle_factory_event_delivery(delivery_id,lease_id,'permanent_failure',attempt_id,410)
  from second_claim cross join second_send),'the retry keeps its definite endpoint rejection separately');
select ok((select status='unknown' and has_unknown_outcome and last_outcome='permanent_failure'
    and last_http_status=410 and next_attempt_at is null and retryable
  from public.list_factory_event_deliveries(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1),(select id from machine_subscription))),
  'permanent failure cannot erase an earlier possible delivery and a manager can explicitly retry');
select ok(public.retry_factory_event_delivery(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1),
  (select delivery_id from original_claim)),'a manager can schedule one bounded manual retry');
create temp table third_claim as select * from public.claim_factory_event_delivery();
create temp table third_send as select send.* from third_claim claim
cross join lateral public.begin_factory_event_send(claim.delivery_id,claim.lease_id,claim.subscription_revision) send;
select throws_ok($q$select public.settle_factory_event_delivery(delivery_id,lease_id,'delivered',attempt_id,503)
  from third_claim cross join third_send$q$,'22023',null,'a non-2xx HTTP result cannot be recorded as success');
select ok((select public.settle_factory_event_delivery(delivery_id,lease_id,'delivered',attempt_id,204)
  from third_claim cross join third_send),'only the exact attempt and confirmed 2xx settle delivered');
select ok((select status='delivered' and attempt_count=3 and delivered_at is not null and not retryable
  from public.list_factory_event_deliveries(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1),(select id from machine_subscription))),
  'the confirmed retry resolves delivery while retaining count and audit history');

select ok(pg_temp.verify_outbox_subscription(id),'the exact OAuth family can activate a separate subscription') from oauth_subscription;
create temp table spec_session as select * from pg_temp.outbox_create_session('Specification private title',true);
select is((select count(*) from internal.factory_outbound_deliveries delivery join internal.factory_outbound_events event on event.id=delivery.event_id
  where event.session_id=(select session_id from spec_session) and event.event_type='session.created'),2::bigint,
  'the same event fans out exactly once to each authorized subscription');
select is((select count(distinct delivery.event_id) from internal.factory_outbound_deliveries delivery
  join internal.factory_outbound_events event on event.id=delivery.event_id
  where event.session_id=(select session_id from spec_session) and event.event_type='session.created'),1::bigint,
  'matching subscribers share the same event identity');

-- Exercise real worker publication and exact human clarification. Only
-- immutable IDs and sequence/status metadata are selected by these hooks.
create temp table original_release as select * from internal.git_continuity_release_control;
select public.set_git_continuity_release(true,revision,'Outbound lifecycle fixture') from original_release where not enabled;
create function pg_temp.publish_outbox_session(p_job uuid,p_markdown text) returns uuid language plpgsql as $$
declare started uuid; claim uuid;
begin
  update public.agent_jobs set status='running',attempt_count=1,
    git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()) where id=p_job;
  started:=public.start_session_job_attempt(p_job,1,pg_temp.outbox_id(11),0,'codex','gpt-5.5','code','wallie/event-outbox');
  if started is null or not exists(select 1 from public.pin_session_job_git_input(
    p_job,1,started,pg_temp.outbox_id(21),'main',repeat('a',40))) then
    raise exception 'Could not pin canonical outbox fixture source';
  end if;
  if not public.prepare_session_source_and_checkpoint_publication(started,pg_temp.outbox_id(21),'main',repeat('a',40),repeat('a',40),
    'Private draft','never-project-private-delivery-handle','','','',0,p_markdown) then raise exception 'Could not prepare fixture'; end if;
  claim:=public.claim_session_checkpoint_publication(started);
  if not public.adopt_session_checkpoint_publication(started,claim) then raise exception 'Could not publish fixture'; end if;
  return started;
end;
$$;
create temp table spec_run as select pg_temp.publish_outbox_session(job_id,
  E'<!-- wallie-clarification: {"question":"never-project-private-question"} -->\n\n# never-project-private-artifact') id
from spec_session;
create temp table outbox_question as select * from public.session_specification_clarifications
where session_id=(select session_id from spec_session);
select ok(exists(select 1 from outbox_question target cross join lateral public.answer_session_specification_clarification_once(
  target.workspace_id,target.factory_id,target.session_id,pg_temp.outbox_id(4),target.id,
  target.artifact_id,target.artifact_version,0,pg_temp.outbox_id(50),'never-project-private-answer','codex','gpt-5.5','code')),
  'the canonical human answer queues the exact revision and records its outbound metadata hooks');
select results_eq($q$select distinct event_type::text from internal.factory_outbound_events
  where session_id=(select session_id from spec_session) order by 1$q$,
  $q$select kind from unnest(array['conversation.message_added','review.changes_requested','review.clarification_answered',
    'review.clarification_requested','review.ready','run.completed','run.started','session.created']) kind order by 1$q$,
  'canonical conversation, execution and review writers emit their supported event kinds');
select is((select count(*) from internal.factory_outbound_events where session_id=(select session_id from spec_session)
  and event_type='review.ready'),1::bigint,'canonical checkpoint and conversation marker deduplicate the exact ready event');
select ok(not exists(select 1 from internal.factory_outbound_events where workspace_id=pg_temp.outbox_id(3)
  and payload::text ~ '(never-project|author|encrypted|branch|checkpoint_path|token|https)'),
  'no event body contains raw conversation, artifacts, actor details, URLs or credentials');

create temp table project_session as select * from pg_temp.outbox_create_session('Legacy project publication');
update public.agent_jobs set status='running',attempt_count=1,
  git_continuity_release_revision=(select revision from public.get_git_continuity_release_state())
where id=(select job_id from project_session);
create temp table project_run as select public.start_session_job_attempt(job_id,1,pg_temp.outbox_id(11),0,
  'codex','gpt-5.5','project') id from project_session;
select ok((select public.publish_session_job_attempt(project.job_id,1,run.id,0,'Project review body')
  from project_session project cross join project_run run),'canonical project publication can create the OP-565 ready marker');
select is((select count(*) from internal.factory_outbound_events where session_id=(select session_id from project_session)
  and event_type='review.ready'),1::bigint,'a scoped project review without a checkpoint still emits ready metadata');
select ok(exists(select 1 from public.sessions session
  cross join lateral public.approve_session_stage(session.id,session.workspace_id,session.current_stage_id,
    session.current_artifact_id,session.current_artifact_version,pg_temp.outbox_id(4),'codex','gpt-5.5','project',
    session.artifact_review_revision)
  where session.id=(select session_id from project_session)), 'an authorized human can record the exact project approval');
select is((select count(*) from internal.factory_outbound_events where session_id=(select session_id from project_session)
  and event_type='review.approved'),1::bigint,'the durable human approval emits one metadata-only event');

select public.cancel_session_command_once(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(4),
  session_id,pg_temp.outbox_id(51),repeat('e',64),run_id) from first_session;
select is((select count(*) from internal.factory_outbound_events where session_id=(select session_id from first_session)
  and event_type='session.canceled'),1::bigint,'keyed human cancellation emits the same versioned lifecycle kind');

insert into public.sessions(id,workspace_id,factory_id,number,title,prompt_md,pipeline_id,current_stage_id,creator_member_id,github_repository_id)
values (pg_temp.outbox_id(55),pg_temp.outbox_id(3),pg_temp.outbox_factory(),55,'Alternate writer','Private prompt',
  pg_temp.outbox_id(10),pg_temp.outbox_id(11),pg_temp.outbox_id(4),pg_temp.outbox_id(22));
insert into public.session_git_roots(session_id,workspace_id,repository_id,repository_full_name,base_branch,initial_base_sha)
values (pg_temp.outbox_id(55),pg_temp.outbox_id(3),pg_temp.outbox_id(22),'fixture/alternate','main',repeat('a',40));
select public.append_session_conversation_message_once(pg_temp.outbox_id(3),pg_temp.outbox_factory(),
  pg_temp.outbox_id(55),pg_temp.outbox_id(4),pg_temp.outbox_id(56),'Never queue an alternate repository');
select is((select count(*) from internal.factory_outbound_events where session_id=pg_temp.outbox_id(55)),0::bigint,
  'an approved read-context repository does not authorize subscriptions to its sessions');

-- An abandoned send-start receipt must become unknown even when its worker
-- crashes before writing a network outcome.
create temp table crash_due as select delivery.id from internal.factory_outbound_deliveries delivery
join internal.factory_outbound_events event on event.id=delivery.event_id
where delivery.subscription_id=(select id from oauth_subscription) and delivery.status='queued'
  and event.session_id=(select session_id from spec_session) and event.event_type='review.ready';
update internal.factory_outbound_deliveries delivery set next_attempt_at=case
  when id=(select id from crash_due) then clock_timestamp()-interval '1 second' else clock_timestamp()+interval '10 minutes' end
where delivery.workspace_id=pg_temp.outbox_id(3) and delivery.status='queued';
create temp table crash_claim as select * from public.claim_factory_event_delivery();
create temp table crash_send as select send.* from crash_claim claim
cross join lateral public.begin_factory_event_send(claim.delivery_id,claim.lease_id,claim.subscription_revision) send;
select is((select outcome from crash_send),'authorized','a worker can start an exact OAuth-bound send before a crash');
update internal.factory_outbound_deliveries set lease_expires_at=clock_timestamp()-interval '1 second'
where id=(select delivery_id from crash_claim);
select is((select count(*) from public.claim_factory_event_delivery()),0::bigint,
  'recovery records the expired attempt and waits for its bounded retry');
select ok((select status='unknown' and has_unknown_outcome and next_attempt_at>clock_timestamp()
  from internal.factory_outbound_deliveries where id=(select delivery_id from crash_claim)),
  'a crashed worker cannot turn a possibly-sent request into a definite outcome');

-- Revoke a credential after the worker has already claimed the destination.
update internal.factory_outbound_deliveries delivery set next_attempt_at=clock_timestamp()-interval '1 second'
where delivery.subscription_id=(select id from machine_subscription) and delivery.status='queued';
create temp table revocable_machine_claim as select * from public.claim_factory_event_delivery();
select public.revoke_factory_machine_token(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1),
  (select id from outbox_grant),pg_temp.outbox_id(31));
select results_eq($q$select outcome,payload,signing_secret_encrypted from revocable_machine_claim claim
  cross join lateral public.begin_factory_event_send(claim.delivery_id,claim.lease_id,claim.subscription_revision)$q$,
  $q$values ('revoked'::text,null::jsonb,null::text)$q$,'token revocation after claim stops dispatch before releasing queued content');
select ok((select not authorized from public.list_factory_event_subscriptions(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1))
  where id=(select id from machine_subscription)),'subscription inspection reflects backing revocation');

update internal.factory_outbound_deliveries delivery set next_attempt_at=clock_timestamp()-interval '1 second'
where delivery.subscription_id=(select id from oauth_subscription) and delivery.status='queued';
create temp table downscope_claim as select * from public.claim_factory_event_delivery();
select is((select result.status from outbox_oauth_client client cross join lateral public.rotate_factory_oauth_refresh_token(
  client.id,pg_temp.outbox_id(37),repeat('b',64),pg_temp.outbox_id(40),repeat('e',64),pg_temp.outbox_id(41),repeat('f',64),
  '{sessions:cancel}') result),'issued','the same OAuth family can rotate into a narrower active scope');
select results_eq($q$select outcome,payload,signing_secret_encrypted from downscope_claim claim
  cross join lateral public.begin_factory_event_send(claim.delivery_id,claim.lease_id,claim.subscription_revision)$q$,
  $q$values ('revoked'::text,null::jsonb,null::text)$q$,'begin-send rereads the currently rotated OAuth scope before releasing payload');
create temp table late_session as select * from pg_temp.outbox_create_session('No current authority');
select is((select count(*) from internal.factory_outbound_events where session_id=(select session_id from late_session)),0::bigint,
  'revoked machine and downscoped OAuth authorities enqueue no subsequent events');
select ok(not has_function_privilege('authenticated','public.claim_factory_event_delivery()','execute')
  and not has_table_privilege('service_role','internal.factory_outbound_events','select')
  and not has_table_privilege('service_role','internal.factory_event_subscriptions','select'),
  'database API exposes only narrowly privileged worker RPCs and safe management projections');

insert into internal.factory_event_subscriptions(workspace_id,factory_id,name,endpoint_url,event_types,credential_kind,
  credential_id,service_principal_id,execution_grant_id,execution_grant_version,writer_repository_id,status,
  signing_secret_encrypted,created_at,created_by_member_id,revoked_at,revoked_by_member_id)
select subscription.workspace_id,subscription.factory_id,'Revoked fixture '||number,subscription.endpoint_url,
  subscription.event_types,subscription.credential_kind,subscription.credential_id,subscription.service_principal_id,
  subscription.execution_grant_id,subscription.execution_grant_version,subscription.writer_repository_id,'revoked',
  'synthetic-retained',clock_timestamp(),pg_temp.outbox_id(4),clock_timestamp(),pg_temp.outbox_id(4)
from internal.factory_event_subscriptions subscription cross join generate_series(1,101) number
where subscription.id=(select id from machine_subscription);
select is((select count(*) from public.list_factory_event_subscriptions(pg_temp.outbox_id(3),pg_temp.outbox_factory(),pg_temp.outbox_id(1))
  where status='active'),2::bigint,'retained revocations cannot hide older live subscription records');

update internal.factory_outbound_deliveries set created_at=clock_timestamp()-interval '8 days',
  deadline_at=clock_timestamp()-interval '7 days' where id=(select delivery_id from original_claim);
update internal.factory_outbound_events set occurred_at=clock_timestamp()-interval '8 days'
where id=(select event_id from original_send);
select results_eq('select * from public.prune_factory_event_outbox(1)','values (1,1,0)',
  'bounded old history cleanup removes only the expired delivery and its unreferenced event');

delete from internal.git_continuity_release_audit where revision > (select revision from original_release);
update internal.git_continuity_release_control control
set enabled=saved.enabled,revision=saved.revision,reason=saved.reason,updated_at=saved.updated_at
from original_release saved where control.singleton=saved.singleton;
delete from public.workspaces where id=pg_temp.outbox_id(3);
select ok(not exists(select 1 from internal.factory_outbound_events where workspace_id=pg_temp.outbox_id(3))
  and not exists(select 1 from internal.factory_outbound_deliveries where workspace_id=pg_temp.outbox_id(3))
  and not exists(select 1 from internal.factory_event_subscriptions where workspace_id=pg_temp.outbox_id(3)),
  'workspace teardown cascades its event history, queued deliveries and private endpoint references');
delete from auth.users where id in (pg_temp.outbox_id(1),pg_temp.outbox_id(2));
select * from finish();
commit;
