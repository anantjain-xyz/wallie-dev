begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '57120000-0000-4000-8000-000000000001';

select public.set_git_continuity_release(true, revision, 'Machine session creation fixture')
from public.get_git_continuity_release_state() where not enabled;

create function pg_temp.creation_id(slot integer) returns uuid language sql immutable as $$
  select ('57120000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id,email) values (pg_temp.creation_id(1), 'machine-create-owner@example.test');
insert into public.workspaces(id,slug,name) values (pg_temp.creation_id(2), 'machine-create-fixture', 'Machine create');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  (pg_temp.creation_id(3), pg_temp.creation_id(2), pg_temp.creation_id(1), 'human', 'owner');

create temp table creation_factory as
  select * from public.create_factory(pg_temp.creation_id(2),pg_temp.creation_id(1),'Explicit factory','explicit-factory');
create function pg_temp.creation_factory_id() returns uuid language sql stable as $$
  select id from creation_factory
$$;
insert into public.pipelines(id,workspace_id,factory_id,name,is_default)
values (pg_temp.creation_id(10),pg_temp.creation_id(2),pg_temp.creation_factory_id(),'Explicit factory pipeline',false);
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,prompt_template_md,anyone_can_approve)
values (pg_temp.creation_id(11),pg_temp.creation_id(10),pg_temp.creation_id(2),1,'design','Design','Draft the spec',true);

insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions)
values (pg_temp.creation_id(20),pg_temp.creation_id(2),57120001,'https://github.test/installations/57120001',571200,
  'Organization','machine-create-fixture','{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id,workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch)
select pg_temp.creation_id(slot),pg_temp.creation_id(2),pg_temp.creation_factory_id(),pg_temp.creation_id(20),57120000 + slot,
  name,'fixture/' || name,true,'https://github.test/fixture/' || name,'main'
from (values (21,'writer'),(22,'context')) repository(slot,name);

create temp table creation_policy as select * from public.save_execution_policy(pg_temp.creation_id(2),pg_temp.creation_id(1),0,
  '{"version":1,"maxRepairAttempts":5,"maxExecutionMs":3600000,"maxTotalTokens":null,"maxCostUsd":null}');
create temp table creation_principal as select * from public.create_service_principal(
  pg_temp.creation_id(2),pg_temp.creation_factory_id(),pg_temp.creation_id(1),'Named machine author','named-machine-author');
create temp table creation_grant as select approved.* from creation_principal principal cross join creation_policy policy
cross join lateral public.approve_factory_execution_grant(principal.workspace_id,principal.factory_id,pg_temp.creation_id(1),principal.id,
  pg_temp.creation_id(21),array[pg_temp.creation_id(22)],'{}',policy.id,pg_temp.creation_id(3),clock_timestamp()+interval '1 hour',0,null,
  '{sessions:create,sessions:read,sessions:cancel}'::public.factory_command_scope[]) approved;
insert into public.workspace_secrets(id,workspace_id,key,encrypted_value)
values (pg_temp.creation_id(30),pg_temp.creation_id(2),'FACTORY_AGENT_KEY','synthetic-worker-secret');
insert into public.workspace_sandbox_settings(workspace_id,active_provider) values (pg_temp.creation_id(2),'e2b')
on conflict (workspace_id) do update set active_provider=excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id,encrypted_api_key)
values (pg_temp.creation_id(2),'synthetic-sandbox-provider');

create temp table creation_agent as
select agent.id,prompt.id prompt_revision_id,prompt.prompt_md,prompt.prompt_sha256
from public.factory_agents agent join public.factory_agent_prompt_revisions prompt on prompt.agent_id=agent.id
where agent.factory_id=pg_temp.creation_factory_id() and agent.is_default and prompt.revision_number=1;
create temp table creation_binding as select binding.* from creation_grant approved cross join creation_agent agent
cross join lateral public.create_factory_secret_binding(approved.workspace_id,approved.factory_id,pg_temp.creation_id(1),
  approved.id,approved.version,agent.id,'codex',pg_temp.creation_id(30)) binding;

create function pg_temp.activate_creation(activation bigint, service_backed boolean) returns text language sql as $$
  with definition as (
    select (jsonb_build_object('schemaVersion',1,'kind','serial','sandboxProvider','e2b',
      'pipelineId',pg_temp.creation_id(10),'repositoryId',pg_temp.creation_id(21),
      'readContextRepositoryIds',jsonb_build_array(pg_temp.creation_id(22)),
      'executionPolicyRevisionId',policy.id,'deliveryPolicyRevisionId',null,'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,
      'operatingRulesMd','','operatingRuleStageIds','[]'::jsonb,
      'agent',jsonb_build_object('provider','codex','model','gpt-5.5','effort',null,
        'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
      'implementationAgent',jsonb_build_object('agentId',agent.id,'promptRevisionId',agent.prompt_revision_id,
        'promptMd',agent.prompt_md,'promptSha256',agent.prompt_sha256),
      'stages',jsonb_build_array(jsonb_build_object('id',pg_temp.creation_id(11),'slug','design','name','Design',
        'description','','promptTemplateMd','Draft the spec','anyoneCanApprove',true,
        'previousStageIds','[]'::jsonb,'approverMemberIds','[]'::jsonb)))
      || case when service_backed then jsonb_build_object('credentialBindingId',binding.id,
          'executionGrant',jsonb_build_object('id',approved.id,'version',approved.version)) else '{}'::jsonb end
      )::text bytes
    from creation_agent agent cross join creation_policy policy cross join creation_grant approved cross join creation_binding binding
  ), revision as (
    insert into public.factory_definition_revisions(workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
    select pg_temp.creation_id(2),pg_temp.creation_factory_id(),1,bytes,encode(sha256(convert_to(bytes,'UTF8')),'hex'),pg_temp.creation_id(1)
    from definition returning *
  ), activated as (
    insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
    select workspace_id,factory_id,id,activation,pg_temp.creation_id(1) from revision returning revision_id
  )
  select revision.canonical_digest from revision join activated on activated.revision_id=revision.id;
$$;
create temp table original_definition as select pg_temp.activate_creation(1,true) digest;

select public.issue_factory_machine_token(workspace_id,factory_id,pg_temp.creation_id(1),id,version,
  pg_temp.creation_id(31),repeat('a',64),'Creation transport','{sessions:create,sessions:read,sessions:cancel}') from creation_grant;

create function pg_temp.machine_mutation(
  p_operation public.factory_session_mutation_operation, p_key integer, p_payload jsonb,
  p_surface public.factory_command_surface default 'api'
) returns jsonb language plpgsql as $$
declare permit record; physical_request uuid := gen_random_uuid(); result jsonb;
begin
  select * into strict permit from public.admit_factory_command(pg_temp.creation_id(2),pg_temp.creation_factory_id(),'machine_token',
    pg_temp.creation_id(31),repeat('a',64),internal.session_mutation_scope(p_operation),physical_request,repeat('b',64),p_surface);
  if permit.status <> 'admitted' then raise exception 'Fixture admission failed: %', permit.status; end if;
  result := public.execute_factory_session_mutation(pg_temp.creation_id(2),pg_temp.creation_factory_id(),'machine_token',
    pg_temp.creation_id(31),repeat('a',64),physical_request,repeat('b',64),p_surface,permit.admission_id,permit.lease_id,
    p_operation,pg_temp.creation_id(p_key),p_payload);
  perform public.release_factory_command_admission(permit.admission_id,permit.lease_id);
  return result;
end;
$$;

create function pg_temp.machine_create(
  p_key integer, p_title text default 'Draft a proposal', p_repo uuid default pg_temp.creation_id(21),
  p_agent uuid default null, p_surface public.factory_command_surface default 'api'
) returns jsonb language sql as $$
  select pg_temp.machine_mutation('create',p_key,jsonb_build_object('title',p_title,'prompt','Read the request.',
    'agentId',coalesce(p_agent,(select id from creation_agent)),'repositoryId',p_repo,'draftSpecification',true),p_surface)
$$;

create function pg_temp.browser_create(
  p_key integer, p_title text default 'Draft a proposal', p_draft boolean default true
) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language sql as $$
  select * from public.create_session_command_once(pg_temp.creation_id(2),pg_temp.creation_id(3),pg_temp.creation_id(p_key),
    repeat('c',64),(select digest from original_definition),p_title,'Read the request.','codex','gpt-5.5','{}',
    session_github_repository_id=>pg_temp.creation_id(21),target_factory_id=>pg_temp.creation_factory_id(),draft_specification=>p_draft)
$$;

create temp table original_machine_create as select pg_temp.machine_create(101) receipt;
select ok((select receipt->>'replayed'='false' and receipt->>'receiptId' is not null from original_machine_create),
  'the machine caller gets a committed business receipt for its new session');
select ok((select (session.workspace_id, session.factory_id, session.github_repository_id, session.specification_stage_id) =
    (pg_temp.creation_id(2), pg_temp.creation_factory_id(), pg_temp.creation_id(21), pg_temp.creation_id(11))
  and session.creator_member_id is null and session.creator_service_principal_id=(select id from creation_principal)
  and job.requested_by_member_id is null and run.triggered_by_member_id is null
  and run.agent_id=(select id from creation_agent)
  from original_machine_create created
  join public.sessions session on session.id=(created.receipt->>'sessionId')::uuid
  join public.agent_jobs job on job.id=(created.receipt->>'jobId')::uuid
  join public.agent_runs run on run.id=(created.receipt->>'runId')::uuid),
  'an explicit non-default factory pins its writer, named agent and specification without fabricating a human actor');
select ok((select inputs.invoking_actor_member_id is null and inputs.credential_owner_member_id is null
  and (inputs.invoking_actor_service_principal_id, inputs.credential_owner_service_principal_id,
     inputs.execution_grant_id, inputs.execution_grant_version, inputs.budget_payer_member_id) =
    (approved.service_principal_id, approved.service_principal_id, approved.id, approved.version, approved.budget_payer_member_id)
  from public.session_factory_admission_inputs inputs cross join creation_grant approved
  where inputs.session_id=(select (receipt->>'sessionId')::uuid from original_machine_create)),
  'the durable worker receipt preserves independent service invoker, credential owner and human budget attribution');
select ok((select author_kind='service' and originating_member_id is null
    and originating_service_principal_id=(select id from creation_principal) and author_label='Named machine author'
    and body_md='Read the request.'
  from public.session_conversation_messages where session_id=(select (receipt->>'sessionId')::uuid from original_machine_create)),
  'the first conversation message names the service principal as author');

select results_eq($q$select session_id, job_id, run_id from pg_temp.browser_create(101)$q$,
  $q$select (receipt->>'sessionId')::uuid, (receipt->>'jobId')::uuid, (receipt->>'runId')::uuid from original_machine_create$q$,
  'equivalent browser command returns the original machine-created session and first execution');
select ok((select pg_temp.machine_create(101,'  Draft a proposal   ',p_surface=>'mcp') = receipt || '{"replayed":true}'::jsonb
  from original_machine_create), 'a new transport permit on a different surface recovers the same durable result');
select throws_ok($q$select pg_temp.machine_create(101,'Changed title')$q$, 'P0005', null,
  'the same business key rejects a changed intent');
select throws_ok($q$select pg_temp.browser_create(101,p_draft=>false)$q$, 'P0005', null,
  'changing the specification choice cannot replay the same cross-surface command');

create temp table original_browser_create as select * from pg_temp.browser_create(102);
create temp table replay_machine_create as select pg_temp.machine_create(102) receipt;
select ok((select (replayed.receipt->>'sessionId')::uuid=created.session_id and replayed.receipt->>'replayed'='true'
  from replay_machine_create replayed cross join original_browser_create created),
  'a machine caller can recover an equivalent browser-first receipt under the same exact grant');
select ok((select receipt.actor_member_id=pg_temp.creation_id(3) and receipt.actor_service_principal_id is null
    and message.author_kind='user'
  from internal.session_mutation_receipts receipt join public.session_conversation_messages message
    on (message.session_id, message.sequence)=(receipt.session_id,1)
  where receipt.request_id=pg_temp.creation_id(102)),
  'replay preserves original human provenance and prompt author');
select is((select count(*) from public.sessions where factory_id=pg_temp.creation_factory_id()),2::bigint,
  'two logical keys across transports create exactly two sessions');
select is((select count(*) from public.session_conversation_messages where factory_id=pg_temp.creation_factory_id()),2::bigint,
  'each canonical session has one initial prompt across replays');

select throws_ok($q$select pg_temp.machine_create(103,p_repo=>pg_temp.creation_id(22))$q$, '42501', null,
  'read context cannot replace the exact writable repository');
select throws_ok($q$select pg_temp.machine_create(103,p_agent=>pg_temp.creation_id(40))$q$, 'PT422', null,
  'a different agent cannot replace the factory’s pinned implementation agent');

create function pg_temp.start_cancel_generation(p_job_id uuid, p_attempt integer) returns uuid language plpgsql as $$
begin
  update public.agent_jobs set status='running',attempt_count=p_attempt,
    git_continuity_release_revision=(select revision from public.get_git_continuity_release_state())
  where id=p_job_id;
  return public.start_session_job_attempt(p_job_id,p_attempt,pg_temp.creation_id(11),0,
    'codex','gpt-5.5','code','wallie/cancel-fixture-' || p_attempt);
end;
$$;
create function pg_temp.machine_cancel(p_key integer, p_session_id uuid, p_run_id uuid) returns jsonb language sql as $$
  select pg_temp.machine_mutation('cancel',p_key,jsonb_build_object('sessionId',p_session_id,'expectedRunId',p_run_id))
$$;
create function pg_temp.browser_cancel(p_key integer, p_session_id uuid, p_run_id uuid)
returns table(job_ids uuid[], run_ids uuid[], replayed boolean) language sql as $$
  select * from public.cancel_session_command_once(pg_temp.creation_id(2),pg_temp.creation_factory_id(),pg_temp.creation_id(3),
    p_session_id,pg_temp.creation_id(p_key),repeat('c',64),p_run_id)
$$;

create temp table stale_cancel_target as
  select session_id,job_id,pg_temp.start_cancel_generation(job_id,1) run_id from original_browser_create;
create temp table exact_cancel_target as
  select session_id,job_id,pg_temp.start_cancel_generation(job_id,2) run_id from original_browser_create;
select throws_ok($q$select pg_temp.machine_cancel(110,session_id,run_id) from stale_cancel_target$q$,
  'P0003','Session generation changed.','a stale machine cancellation cannot touch a newer attempt of the same job');
select ok((select job.status='running' and job.attempt_count=2 and run.status='running' and session.phase_status='in_progress'
  from exact_cancel_target target join public.agent_jobs job on job.id=target.job_id
  join public.agent_runs run on run.id=target.run_id join public.sessions session on session.id=target.session_id),
  'the stale request leaves the exact current job, run and phase intact');
select ok(not exists(select 1 from internal.session_mutation_receipts where request_id=pg_temp.creation_id(110)),
  'a stale cancellation commits no receipt for its request key');

create temp table exact_machine_cancel as
  select pg_temp.machine_cancel(110,session_id,run_id) receipt from exact_cancel_target;
select ok((select receipt->'jobIds'=jsonb_build_array(target.job_id) and receipt->'runIds'=jsonb_build_array(target.run_id)
  and receipt->>'replayed'='false' and receipt->>'phaseStatus'='rejected'
  from exact_machine_cancel cross join exact_cancel_target target),
  'the exact machine request returns and parks only the active generation');
select results_eq($q$select canceled.* from exact_cancel_target target
    cross join lateral pg_temp.browser_cancel(110,target.session_id,target.run_id) canceled$q$,
  $q$select array[job_id],array[run_id],true from exact_cancel_target$q$,
  'browser retry recovers the exact machine cancellation even after the phase changes');
select throws_ok($q$select pg_temp.machine_cancel(110,session_id,run_id) from stale_cancel_target$q$,
  'P0005',null,'an accepted cancellation key conflicts with changed intent before checking lifecycle state');
select is((select count(*) from public.agent_run_messages message join exact_cancel_target target on target.run_id=message.agent_run_id
  where message.kind='worker_error' and message.message_md like '**Canceled:** %'),1::bigint,
  'machine first and browser replay record one cancellation diagnostic');
select ok((select receipt.actor_member_id is null and receipt.actor_service_principal_id=(select id from creation_principal)
  from internal.session_mutation_receipts receipt
  where receipt.operation='cancel' and receipt.request_id=pg_temp.creation_id(110)),
  'browser replay retains the original machine actor');

create temp table browser_first_cancel_target as select * from pg_temp.browser_create(104);
select results_eq($q$select canceled.* from browser_first_cancel_target target
    cross join lateral pg_temp.browser_cancel(111,target.session_id,target.run_id) canceled$q$,
  $q$select array[job_id],array[run_id],false from browser_first_cancel_target$q$,
  'browser can cancel first against a queued exact generation in the same approved factory');
select ok((select result->'jobIds'=jsonb_build_array(job_id) and result->'runIds'=jsonb_build_array(run_id) and result->>'replayed'='true'
  from browser_first_cancel_target cross join lateral pg_temp.machine_cancel(111,session_id,run_id) result),
  'machine replay recovers an exact browser-first cancellation');
select is((select count(*) from public.agent_run_messages message join browser_first_cancel_target target on target.run_id=message.agent_run_id
  where message.kind='worker_error' and message.message_md like '**Canceled:** %'),1::bigint,
  'browser first and machine replay also record one cancellation diagnostic');

select pg_temp.activate_creation(2,false);
select throws_ok($q$select pg_temp.machine_create(103)$q$, 'PT422', null,
  'new machine work never falls back to personal credentials when activation changes');
select results_eq($q$select * from pg_temp.browser_create(102)$q$, 'select * from original_browser_create',
  'exact original browser replay survives a later activation while its pinned grant stays live');
select ok((select pg_temp.machine_create(101) = receipt || '{"replayed":true}'::jsonb from original_machine_create),
  'exact machine replay also survives a later activation while its original grant stays live');

select public.revoke_factory_machine_token(pg_temp.creation_id(2),pg_temp.creation_factory_id(),pg_temp.creation_id(1),
  (select id from creation_grant),pg_temp.creation_id(31));
select is((select status::text from public.admit_factory_command(pg_temp.creation_id(2),pg_temp.creation_factory_id(),'machine_token',
  pg_temp.creation_id(31),repeat('a',64),'sessions:create',gen_random_uuid(),repeat('b',64),'api')),'unauthorized',
  'the old request credential cannot submit any further commands');

create function pg_temp.start_created_work() returns uuid language plpgsql as $$
declare receipt jsonb; job_id uuid; started uuid;
begin
  select created.receipt into strict receipt from original_machine_create created;
  job_id:= (receipt->>'jobId')::uuid;
  update public.agent_jobs set status='running',attempt_count=1,
    git_continuity_release_revision=(select revision from public.get_git_continuity_release_state())
  where id=job_id;
  started:= public.start_session_job_attempt(job_id,1,pg_temp.creation_id(11),0,
    'codex','gpt-5.5','code','wallie/machine-create-fixture');
  perform public.pin_session_job_git_input(job_id,1,started,pg_temp.creation_id(21),'main',repeat('a',40));
  update public.agent_runs set sandbox_provider='e2b',sandbox_connection_revision=pg_temp.creation_id(41) where id=started;
  if not public.pin_session_attempt_manifest(job_id,started,1,repeat('b',64),24,3,repeat('a',40),'[]','workerd',7,'high',null) then
    raise exception 'Fixture did not pin the original service-backed attempt.';
  end if;
  return started;
end;
$$;
create temp table owned_machine_run as select pg_temp.start_created_work() id;
select is((select resolved.encrypted_value from original_machine_create created cross join owned_machine_run run
  cross join lateral public.resolve_factory_run_credential(pg_temp.creation_id(2),(created.receipt->>'jobId')::uuid,run.id,1) resolved),
  'synthetic-worker-secret','the worker can resolve the original scoped service binding after transport token revocation');
select ok((select receipt.service_principal_id=(select id from creation_principal)
  and manifest.credential_owner_member_id is null
  from public.factory_run_credential_receipts receipt join public.session_attempt_manifests manifest using (run_id)
  where receipt.run_id=(select id from owned_machine_run)),
  'the exact attempt’s credential receipt remains attributable to the named service principal');

select public.revoke_factory_execution_grant(pg_temp.creation_id(2),pg_temp.creation_factory_id(),pg_temp.creation_id(1),
  (select id from creation_grant),(select version from creation_grant),'Test revocation');
select throws_ok($q$select resolved.encrypted_value from original_machine_create created cross join owned_machine_run run
  cross join lateral public.resolve_factory_run_credential(pg_temp.creation_id(2),(created.receipt->>'jobId')::uuid,run.id,1) resolved$q$,
  '42501',null,'current execution grant revocation still fences worker credential release');
select throws_ok($q$select * from pg_temp.browser_create(102)$q$, '42501', null,
  'a revoked execution grant cannot recover the original browser response through the shared receipt');

select * from finish();
rollback;
