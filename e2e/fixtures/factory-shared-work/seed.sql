begin;
set local request.jwt.claim.role = 'service_role';

create temp table fixture_workspace as select workspace.* from public.create_workspace(
  :'owner_id'::uuid, 'M04 shared work', :'workspace_slug', :'owner_email') workspace
where workspace.slug=:'workspace_slug' and workspace.slug ~ '^m04-qualification-[a-f0-9]{8}$';
do $$begin
  if (select count(*) from fixture_workspace)<>1 then raise exception 'Unexpected fixture workspace slug.'; end if;
end;$$;
create temp table fixture_factory as
select factory.id, factory.workspace_id, member.id owner_member_id, pipeline.id pipeline_id
from fixture_workspace workspace
join public.factories factory on factory.workspace_id=workspace.id and factory.is_default
join public.workspace_members member on member.workspace_id=workspace.id and member.user_id=:'owner_id'::uuid
join public.pipelines pipeline on (pipeline.workspace_id,pipeline.factory_id)=(workspace.id,factory.id) and pipeline.is_default;

update public.pipeline_stages stage set
  slug=case stage.position when 1 then 'specification' else 'result' end,
  name=case stage.position when 1 then 'Shape request' else 'Publish result' end,
  description=case stage.position when 1 then 'Draft the exact specification.' else 'Deliver the approved scope.' end,
  prompt_template_md='Address {{session.prompt}}.', anyone_can_approve=true
from fixture_factory factory where (stage.workspace_id,stage.pipeline_id)=(factory.workspace_id,factory.pipeline_id)
  and stage.position in (1,2);
create temp table fixture_stages as
select stage.* from public.pipeline_stages stage join fixture_factory factory on stage.pipeline_id=factory.pipeline_id
where stage.position in (1,2);

create temp table fixture_installation as with created as (
  insert into public.github_installations(workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions)
  select workspace.id, :'repo_numeric_id'::bigint, 'https://example.test/m04-installation', 1,'Organization',workspace.slug,
    '{"contents":"write","pull_requests":"write"}'
  from fixture_workspace workspace returning *
) select * from created;
create temp table fixture_repository as with created as (
  insert into public.github_repositories(workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch)
  select factory.workspace_id,factory.id,installation.id,installation.installation_id,'shared-work',installation.target_name||'/shared-work',
    true,'https://example.test/'||installation.target_name||'/shared-work','main'
  from fixture_factory factory join fixture_installation installation on installation.workspace_id=factory.workspace_id returning *
) select * from created;
update public.workspace_onboarding onboarding set status='completed',completed_at=clock_timestamp(),selected_github_repository_id=repo.id
from fixture_repository repo where onboarding.workspace_id=repo.workspace_id;

insert into public.workspace_sandbox_settings(workspace_id,active_provider)
select id,'e2b' from fixture_workspace on conflict (workspace_id) do update set active_provider=excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id,encrypted_api_key)
select id,'unused-m04-local-sandbox' from fixture_workspace;
create temp table fixture_secret as with created as (
  insert into public.workspace_secrets(workspace_id,key,encrypted_value)
  select id,'M04_SERVICE_AGENT','unused-m04-local-service-material' from fixture_workspace returning id,workspace_id
) select * from created;
create temp table fixture_policy as select policy.* from fixture_workspace workspace
cross join lateral public.save_execution_policy(workspace.id,:'owner_id'::uuid,0,
  '{"version":1,"maxRepairAttempts":4,"maxExecutionMs":600000,"maxTotalTokens":null,"maxCostUsd":null}') policy;
create temp table fixture_agent as select agent.* from fixture_factory factory
cross join lateral public.create_factory_agent(factory.workspace_id,factory.id,:'owner_id'::uuid,
  'Scope reviewer','scope-reviewer','Draft a precise and reviewable specification.') agent;
create temp table fixture_principals as
select kind.role,principal.* from fixture_factory factory
cross join (values ('writer','M04 writer'),('witness','M04 witness')) kind(role,name)
cross join lateral public.create_service_principal(factory.workspace_id,factory.id,:'owner_id'::uuid,kind.name,kind.role) principal;
create temp table fixture_grants as
select principal.role,grant_row.* from fixture_principals principal
join fixture_factory factory on principal.factory_id=factory.id
join fixture_repository repo on repo.factory_id=factory.id
cross join fixture_policy policy
cross join lateral public.approve_factory_execution_grant(factory.workspace_id,factory.id,:'owner_id'::uuid,principal.id,repo.id,
  '{}','{}',policy.id,factory.owner_member_id,clock_timestamp()+interval '1 hour',0,null,
  (case principal.role when 'writer' then '{sessions:create,sessions:read,sessions:cancel,sessions:follow-up,sessions:clarify}'
    else '{sessions:read}' end)::public.factory_command_scope[]) grant_row;
create temp table fixture_binding as select binding.* from fixture_grants grant_row
cross join fixture_agent agent cross join fixture_secret secret
cross join lateral public.create_factory_secret_binding(grant_row.workspace_id,grant_row.factory_id,:'owner_id'::uuid,
  grant_row.id,grant_row.version,agent.agent_id,'codex',secret.id) binding where grant_row.role='writer';

create temp table fixture_activation as with definition as (
  select factory.workspace_id,factory.id factory_id,(jsonb_build_object(
    'schemaVersion',1,'kind','serial','sandboxProvider','e2b','pipelineId',factory.pipeline_id,'repositoryId',repo.id,
    'executionPolicyRevisionId',policy.id,'deliveryPolicyRevisionId',null,
    'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,'operatingRulesMd','','operatingRuleStageIds','[]'::jsonb,
    'agent',jsonb_build_object('provider','codex','model','gpt-5.5','effort',null,
      'concurrencyLimit',1,'stallTimeoutMs',300000,'maxRetries',1,'maxTurns',10),
    'implementationAgent',jsonb_build_object('agentId',agent.agent_id,'promptRevisionId',agent.id,
      'promptMd',agent.prompt_md,'promptSha256',agent.prompt_sha256),
    'credentialBindingId',binding.id,'executionGrant',jsonb_build_object('id',grant_row.id,'version',grant_row.version),
    'stages',(select jsonb_agg(jsonb_build_object('id',stage.id,'slug',stage.slug,'name',stage.name,
      'description',stage.description,'promptTemplateMd',stage.prompt_template_md,'anyoneCanApprove',true,
      'previousStageIds',case stage.position when 1 then '[]'::jsonb
        else jsonb_build_array((select prior.id from fixture_stages prior where prior.position=1)) end,
      'approverMemberIds','[]'::jsonb) order by stage.position) from fixture_stages stage)))::text bytes
  from fixture_factory factory cross join fixture_repository repo cross join fixture_policy policy
  cross join fixture_agent agent cross join fixture_binding binding cross join fixture_grants grant_row where grant_row.role='writer'
), revision as (
  insert into public.factory_definition_revisions(workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
  select workspace_id,factory_id,1,bytes,encode(sha256(convert_to(bytes,'UTF8')),'hex'),:'owner_id'::uuid
  from definition returning *
), activated as (
  insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
  select workspace_id,factory_id,id,1,:'owner_id'::uuid from revision returning revision_id
) select revision.canonical_digest from revision join activated on activated.revision_id=revision.id;

create temp table fixture_tokens as select grant_row.role,minted.id from fixture_grants grant_row
cross join lateral public.issue_factory_machine_token(grant_row.workspace_id,grant_row.factory_id,:'owner_id'::uuid,
  grant_row.id,grant_row.version,(case grant_row.role when 'writer' then :'writer_id' else :'witness_id' end)::uuid,
  case grant_row.role when 'writer' then :'writer_digest' else :'witness_digest' end,
  'M04 '||grant_row.role,grant_row.command_scopes) minted;

select jsonb_build_object('workspaceId',workspace.id,'workspaceSlug',workspace.slug,'factoryId',factory.id,
  'ownerId',:'owner_id'::uuid,'ownerMemberId',factory.owner_member_id,
  'agentId',agent.agent_id,'repositoryId',repo.id,'definitionDigest',activated.canonical_digest,
  'writer',(select jsonb_build_object('grantId',grant_row.id,'grantVersion',grant_row.version,
    'principalId',grant_row.service_principal_id,'tokenId',token.id)
    from fixture_grants grant_row join fixture_tokens token using (role) where role='writer'),
  'witness',(select jsonb_build_object('grantId',grant_row.id,'grantVersion',grant_row.version,
    'principalId',grant_row.service_principal_id,'tokenId',token.id)
    from fixture_grants grant_row join fixture_tokens token using (role) where role='witness'),
  'specStage',(select jsonb_build_object('id',stage.id,'slug',stage.slug,'name',stage.name)
    from fixture_stages stage where stage.position=1),
  'resultStage',(select jsonb_build_object('id',stage.id,'slug',stage.slug,'name',stage.name)
    from fixture_stages stage where stage.position=2))
from fixture_workspace workspace cross join fixture_factory factory cross join fixture_agent agent
cross join fixture_repository repo cross join fixture_activation activated;
commit;
