begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '67200000-0000-4000-8000-000000000001';

select public.set_git_continuity_release(true, revision, 'Linear discovery fixture')
from public.get_git_continuity_release_state() where not enabled;

create function pg_temp.creation_id(slot integer) returns uuid language sql immutable as $$
  select ('67200000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id,email) values (pg_temp.creation_id(1), 'linear-discovery-owner@example.test');
insert into public.workspaces(id,slug,name) values (pg_temp.creation_id(2), 'linear-discovery-fixture', 'Machine create');
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
values (pg_temp.creation_id(20),pg_temp.creation_id(2),67200001,'https://github.test/installations/67200001',571200,
  'Organization','linear-discovery-fixture','{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id,workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch)
select pg_temp.creation_id(slot),pg_temp.creation_id(2),pg_temp.creation_factory_id(),pg_temp.creation_id(20),67200000 + slot,
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

insert into public.workspace_secrets(id, workspace_id, key, encrypted_value)
values (pg_temp.creation_id(40), pg_temp.creation_id(2), 'LINEAR_API_KEY', 'fixture-linear-key');

create temp table discovery_installation as
select * from public.configure_connector_installation(pg_temp.creation_id(2),pg_temp.creation_factory_id(),
  pg_temp.creation_id(1),'linear',pg_temp.creation_id(41)::text,pg_temp.creation_id(41)::text,0,pg_temp.creation_id(40),1);
create temp table discovery_resources as
select input.kind, mapping.resource_id, mapping.revision
from discovery_installation installation
cross join (values ('team'::public.connector_resource_kind,42),('project'::public.connector_resource_kind,43)) input(kind,slot)
cross join lateral public.publish_connector_resource_mapping(pg_temp.creation_id(2),pg_temp.creation_factory_id(),
  pg_temp.creation_id(1),installation.installation_id,installation.generation,input.kind,pg_temp.creation_id(input.slot)::text,0,true) mapping;

create temp table discovery_links as
select input.kind, public.link_connector_actor(pg_temp.creation_id(2),pg_temp.creation_factory_id(),pg_temp.creation_id(1),
  installation.installation_id,installation.generation,'linear',pg_temp.creation_id(41)::text,
  pg_temp.creation_id(input.slot)::text,input.kind,input.principal) as link_id
from discovery_installation installation cross join creation_principal principal
cross join lateral (values ('human'::public.connector_actor_kind,44,null::uuid),
  ('service'::public.connector_actor_kind,45,principal.id)) input(kind,slot,principal);

create function pg_temp.configure_discovery(p_kind public.connector_resource_kind, p_revision bigint,
  p_enabled boolean default true, p_service_actor_id uuid default null) returns bigint language sql as $$
  select public.configure_linear_issue_discovery(pg_temp.creation_id(2),pg_temp.creation_factory_id(),
    pg_temp.creation_id(1),resource.resource_id,p_revision,resource.revision,
    array[pg_temp.creation_id(46)],p_enabled,pg_temp.creation_id(47),p_service_actor_id)
  from discovery_resources resource where resource.kind = p_kind
$$;

create function pg_temp.discovery_issue(p_slot integer, p_project integer default 43, p_state integer default 46,
  p_creator integer default 44, p_label integer default 47, p_identifier text default null) returns jsonb language sql as $$
  select jsonb_build_object(
    'id',pg_temp.creation_id(p_slot),'identifier',coalesce(p_identifier,'DISC-' || p_slot),'title','Discover issue ' || p_slot,
    'description','The issue body is the task context.',
    'url','https://linear.app/fixture/issue/' || coalesce(p_identifier,'DISC-' || p_slot) || '/test-issue',
    'team_id',pg_temp.creation_id(42),'project_id',pg_temp.creation_id(p_project),'state_id',pg_temp.creation_id(p_state),
    'creator_id',pg_temp.creation_id(p_creator),'label_ids',jsonb_build_array(pg_temp.creation_id(p_label))
  )
$$;

create function pg_temp.commit_discovery(p_kind public.connector_resource_kind, p_cursor_generation bigint,
  p_issues jsonb, p_config_revision bigint default 1, p_next text default null, p_tenant integer default 41,
  p_viewer integer default 44, p_installation_generation bigint default 1) returns integer language sql as $$
  select public.commit_linear_issue_discovery_page(pg_temp.creation_id(2),pg_temp.creation_factory_id(),resource.resource_id,
    p_config_revision,p_installation_generation,resource.revision,p_cursor_generation,
    pg_temp.creation_id(p_tenant),pg_temp.creation_id(p_viewer),p_issues,p_next)
  from discovery_resources resource where resource.kind = p_kind
$$;

select ok(not has_function_privilege('authenticated',
    'public.claim_linear_issue_discovery(uuid,uuid[])', 'execute')
  and has_function_privilege('service_role','public.claim_linear_issue_discovery(uuid,uuid[])','execute')
  and not has_table_privilege('authenticated','internal.linear_issue_discovery_receipts','select'),
  'the worker scan and raw receipts are inaccessible to authenticated browser users');

select is(pg_temp.configure_discovery('project',0), 1::bigint, 'a workspace owner enables an exact project filter');
select is(pg_temp.configure_discovery('team',0), 1::bigint, 'the team scope can independently discover work');
select throws_ok($$select pg_temp.configure_discovery('team',0)$$, 'PT409', null,
  'a stale configuration cannot replace the active revision');

create temp table discovery_tasks as
select public.claim_linear_issue_discovery(pg_temp.creation_id(2)) as task from generate_series(1,2);
select is((select count(distinct task->>'resourceId') from discovery_tasks), 2::bigint,
  'claiming due work rotates over configured scopes');
select is(public.claim_linear_issue_discovery(pg_temp.creation_id(2)), null::jsonb,
  'a second worker cannot immediately claim either leased polling interval');

select is(pg_temp.commit_discovery('project',0,'[]',p_next=>'page-two'),0,
  'an empty first page persists paging position without creating work');
select is((select cursor_state.position from internal.connector_subscription_cursors cursor_state
  join discovery_resources resource on resource.resource_id = cursor_state.resource_id where resource.kind = 'project'),
  'page-two','the position is durable before the next page');
select throws_ok($$select pg_temp.commit_discovery('project',0,'[]')$$, 'PT409', null,
  'a losing scanner cannot advance an old page');
select throws_ok($$select pg_temp.commit_discovery('project',1,'[]',p_tenant=>999)$$, '42501', null,
  'a mismatched provider tenant rejects the page and rolls its cursor back');

select is(pg_temp.commit_discovery('team',0,jsonb_build_array(pg_temp.discovery_issue(51))),0,
  'a team scan does not take work from an explicitly configured project');
select is(pg_temp.commit_discovery('project',1,jsonb_build_array(
  pg_temp.discovery_issue(51),pg_temp.discovery_issue(51),
  pg_temp.discovery_issue(52,p_project=>999),pg_temp.discovery_issue(53,p_state=>999),
  pg_temp.discovery_issue(54,p_creator=>999),pg_temp.discovery_issue(55,p_label=>999)
)),1,'the eligible issue on the next page creates one session; duplicates and ineligible issues skip');
select is((select count(*) from internal.linear_issue_discovery_receipts where workspace_id = pg_temp.creation_id(2)),
  1::bigint,'a canonical issue has one durable discovery receipt');
select is((select source_event from internal.linear_issue_discovery_receipts where issue_id = pg_temp.creation_id(51)),
  jsonb_build_object('kind','issue-state','stateId',pg_temp.creation_id(46),'teamId',pg_temp.creation_id(42),
    'projectId',pg_temp.creation_id(43)), 'the source receipt retains the normalized issue-state event');
select ok((select session.linear_issue_id = 'DISC-51' and session.linear_issue_url = source.source_url
    and source.external_thread_id = receipt.issue_id::text and source.source_namespace = receipt.resource_id::text
    and session.creator_member_id = pg_temp.creation_id(3) and session.creator_service_principal_id is null
  from internal.linear_issue_discovery_receipts receipt
  join public.sessions session on session.id = receipt.session_id
  join public.session_conversation_sources source on source.id = receipt.source_id
  where receipt.issue_id = pg_temp.creation_id(51)), 'the human session keeps both visible Linear origin and canonical source identity');
select is((select count(*) from internal.session_mutation_receipts receipt where receipt.request_id = pg_temp.creation_id(51)
  and receipt.operation = 'create'),1::bigint,'discovery uses the common session mutation receipt');

select is(pg_temp.commit_discovery('project',2,jsonb_build_array(pg_temp.discovery_issue(51,p_identifier=>'MOVED-51'))),0,
  'a later edit or identifier change cannot recreate the canonical session');
select is(pg_temp.commit_discovery('team',1,jsonb_build_array(pg_temp.discovery_issue(51,p_project=>null))),0,
  'moving out of the project does not create a duplicate through the team');
select is((select count(*) from public.agent_jobs job join internal.linear_issue_discovery_receipts receipt
  on receipt.session_id = job.session_id where receipt.issue_id = pg_temp.creation_id(51)),
  1::bigint,'rescans and a project move retain one queued job');

insert into public.sessions(id,workspace_id,factory_id,pipeline_id,current_stage_id,number,title,linear_issue_id,phase_status)
values (pg_temp.creation_id(75),pg_temp.creation_id(2),pg_temp.creation_factory_id(),pg_temp.creation_id(10),
  pg_temp.creation_id(11),999,'Older reviewed request','DISC-56','approved');
select is(pg_temp.commit_discovery('project',3,jsonb_build_array(pg_temp.discovery_issue(56))),0,
  'a reviewed session linked by the legacy path is left alone');
select is((select phase_status::text from public.sessions where id = pg_temp.creation_id(75)), 'approved',
  'discovery leaves the reviewed lifecycle phase untouched');

select is(pg_temp.configure_discovery('project',1,p_service_actor_id=>pg_temp.creation_id(45)),2::bigint,
  'an explicitly linked service identity can be selected');
select throws_ok($$select pg_temp.commit_discovery('project',4,'[]')$$, 'PT409', null,
  'a stale scan cannot commit through a configuration change');
select throws_ok($$select pg_temp.commit_discovery('project',5,'[]',p_config_revision=>2)$$,
  '42501', null,'the provider viewer must match the configured service identity');
select is(pg_temp.commit_discovery('project',5,jsonb_build_array(pg_temp.discovery_issue(57,p_creator=>null)),
  p_config_revision=>2,p_viewer=>45),1,'verified service admission works without a borrowed human author');
select ok((select session.creator_member_id is null and session.creator_service_principal_id = principal.id
    and admission.invoking_actor_service_principal_id = principal.id
    and admission.budget_payer_member_id = pg_temp.creation_id(3)
  from internal.linear_issue_discovery_receipts receipt
  join public.sessions session on session.id = receipt.session_id
  join public.session_factory_admission_inputs admission on admission.session_id = session.id
  cross join creation_principal principal where receipt.issue_id = pg_temp.creation_id(57)),
  'the service actor, service credential owner and human budget payer are attributed separately');
select is((select count(*) from internal.linear_issue_discovery_permits),0::bigint,
  'service authority is retired within the same transaction');

update public.workspace_secrets set encrypted_value = 'fixture-linear-key-rotate' where id = pg_temp.creation_id(40);
select throws_ok($$select pg_temp.commit_discovery('project',6,'[]',p_config_revision=>2,p_viewer=>45)$$,
  'P0002', null, 'credential rotation fences a page fetched with the old authority');
select is(pg_temp.configure_discovery('project',2,false),3::bigint,
  'a stale provider connection can be disabled by an authorized operator');
select is(public.claim_linear_issue_discovery(pg_temp.creation_id(2)),null::jsonb,'a rotated credential is no longer polled');

select * from finish();
rollback;
