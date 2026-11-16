begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '54450000-0000-4000-8000-000000000001';

select public.set_git_continuity_release(true,revision,'Pinned stage transition fixture')
from public.get_git_continuity_release_state() where not enabled;

insert into auth.users(id,email) values
  ('54450000-0000-4000-8000-000000000001','pinned-transitions-owner@example.com'),
  ('54450000-0000-4000-8000-000000000002','pinned-transitions-reviewer@example.com');
insert into public.workspaces(id,slug,name) values
  ('54450000-0001-4000-8000-000000000001','pinned-transitions-test','Pinned transitions');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  ('54450000-0002-4000-8000-000000000001','54450000-0001-4000-8000-000000000001',
   '54450000-0000-4000-8000-000000000001','human','owner'),
  ('54450000-0002-4000-8000-000000000002','54450000-0001-4000-8000-000000000001',
   '54450000-0000-4000-8000-000000000002','human','member');
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential) values
  ('54450000-0000-4000-8000-000000000001','platform_api_key','pinned-transitions-test-ciphertext');
insert into public.pipelines(id,workspace_id,name,is_default) values
  ('54450000-0003-4000-8000-000000000001','54450000-0001-4000-8000-000000000001','Pinned pipeline',true);
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name) values
  ('54450000-0004-4000-8000-000000000001','54450000-0003-4000-8000-000000000001',
   '54450000-0001-4000-8000-000000000001',1,'sealed-plan','Plan'),
  ('54450000-0004-4000-8000-000000000002','54450000-0003-4000-8000-000000000001',
   '54450000-0001-4000-8000-000000000001',2,'sealed-build','Build'),
  ('54450000-0004-4000-8000-000000000003','54450000-0003-4000-8000-000000000001',
   '54450000-0001-4000-8000-000000000001',3,'sealed-land','Land');
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions) values
  ('54450000-0005-4000-8000-000000000001','54450000-0001-4000-8000-000000000001',
   54450001,'https://github.com/installations/54450001',5445,'Organization','Fixture',
   '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id,workspace_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch) values
  ('54450000-0006-4000-8000-000000000001','54450000-0001-4000-8000-000000000001',
   '54450000-0005-4000-8000-000000000001',54450011,'pinned-transitions','fixture/pinned-transitions',true,
   'https://github.com/fixture/pinned-transitions','main');
update public.workspace_linear_routing set rework_stage_slug='sealed-build', land_stage_slug='sealed-land'
where workspace_id='54450000-0001-4000-8000-000000000001';

create function pg_temp.new_delivery_policy(mode text, expected_revision bigint) returns uuid language sql as $$
  select (public.save_delivery_policy('54450000-0001-4000-8000-000000000001',
    '54450000-0003-4000-8000-000000000001','54450000-0000-4000-8000-000000000001',expected_revision,
    jsonb_build_object('version',1,'deliveryMode',mode,'requiredChecks','[]'::jsonb,
      'requiredEvidence','[]'::jsonb,'minimumApprovals',0,'requireCodeOwnerReview',false,
      'requireResolvedThreads',false,'freshnessSeconds',600,'requireArtifactApprovalForDelivery',mode='code'))).id;
$$;
create temp table original_policy as select pg_temp.new_delivery_policy('code',0) as id;
create temp table active_definition as
select jsonb_build_object(
  'schemaVersion',1,'kind','serial','pipelineId','54450000-0003-4000-8000-000000000001',
  'repositoryId','54450000-0006-4000-8000-000000000001','sandboxProvider','e2b',
  'agent',jsonb_build_object('provider','codex','model','gpt-5.5','effort','high',
    'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
  'executionPolicyRevisionId',null,'deliveryPolicyRevisionId',(select id from original_policy),
  'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,'operatingRulesMd','','operatingRuleStageIds','[]'::jsonb,
  'stages',jsonb_agg(jsonb_build_object('id',stage.id,'slug',stage.slug,'name',stage.name,
    'description','','promptTemplateMd','Use the admitted template.',
    'anyoneCanApprove',stage.position<>1,'previousStageIds','[]'::jsonb,'approverMemberIds',
    case when stage.position=1 then '["54450000-0002-4000-8000-000000000002"]'::jsonb else '[]'::jsonb end)
    order by stage.position)
) as body
from public.pipeline_stages stage where stage.pipeline_id='54450000-0003-4000-8000-000000000001';

create function pg_temp.activate_fixture(p_activation bigint,p_definition jsonb)
returns void language sql as $$
  with revision as (
    insert into public.factory_definition_revisions(workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
    select f.workspace_id,f.id,1,p_definition::text,encode(sha256(convert_to(p_definition::text,'UTF8')),'hex'),
      '54450000-0002-4000-8000-000000000001'
    from public.factories f where f.workspace_id='54450000-0001-4000-8000-000000000001' and f.is_default
    returning id,workspace_id,factory_id,created_by
  )
  insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
  select workspace_id,factory_id,id,p_activation,created_by from revision;
$$;
select pg_temp.activate_fixture(1,(select body from active_definition));
create temp table admitted as select * from public.create_session_with_first_job(
  '54450000-0001-4000-8000-000000000001','54450000-0002-4000-8000-000000000001',
  'Pinned review lifecycle','Keep this execution stable','cursor','live-model',
  'PINNED-544','https://linear.app/test/issue/PINNED-544');

-- Reverse live order, archive the second stage, widen the live review policy,
-- and remove the live delivery gate. The already-admitted session still uses
-- the original order, labels, and policy checks.
update public.pipeline_stages
set position=4-position, slug='edited-'||slug, name='Edited '||name, anyone_can_approve=true,
    archived_at=case when slug='sealed-build' then clock_timestamp() else archived_at end
where pipeline_id='54450000-0003-4000-8000-000000000001';

select pg_temp.new_delivery_policy('analysis',1);
select throws_ok($$select internal.assert_delivery_readiness_gate(session_id,'54450000-0001-4000-8000-000000000001')
  from admitted$$, 'PT428', 'PR readiness is not Ready. Resolve the reported delivery blockers before approving.',
  'a live analysis policy cannot bypass the pinned code policy gate');

create function pg_temp.publish_fixture(p_job_id uuid,p_text text) returns uuid language plpgsql as $$
declare s public.sessions; started uuid;
begin
  select owner.* into strict s from public.sessions owner join public.agent_jobs job on job.session_id=owner.id where job.id=p_job_id;
  update public.agent_jobs set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()),
    status='running',attempt_count=1 where id=p_job_id;
  started := public.start_session_job_attempt(p_job_id,1,s.current_stage_id,s.current_artifact_version,
    'codex','gpt-5.5','project','wallie/pinned-stage-test-'||p_job_id::text);
  if not coalesce(public.publish_session_job_attempt(p_job_id,1,started,s.current_artifact_version,p_text),false) then
    raise exception 'Fixture did not publish';
  end if;
  return (select current_artifact_id from public.sessions where id=s.id);
end;
$$;
create function pg_temp.approve_fixture(p_session_id uuid,p_member_id uuid,p_artifact_id uuid)
returns table(id uuid,pipeline_id uuid,current_stage_id uuid,current_stage_slug text,phase_status public.pipeline_phase_status,
  workspace_id uuid,linear_issue_url text,archived_at timestamptz,current_artifact_version integer,rejection_count integer,
  job_id uuid,run_id uuid,job_created boolean)
language sql as $$
  select approved.* from public.sessions s cross join lateral public.approve_session_stage(
    s.id,s.workspace_id,s.current_stage_id,p_artifact_id,s.current_artifact_version,p_member_id,
    'cursor','live-model','project',s.artifact_review_revision) approved where s.id=p_session_id;
$$;

create temp table plan_artifact as select pg_temp.publish_fixture(job_id,'The exact approved plan') as id from admitted;
select is((select (job.stage_slug,job.stage_name,run.stage_slug,run.stage_name,artifact.stage_slug)::text
  from admitted a join public.agent_jobs job on job.id=a.job_id join public.agent_runs run on run.id=a.run_id
  cross join plan_artifact plan join public.session_artifacts artifact on artifact.id=plan.id),
  '(sealed-plan,Plan,sealed-plan,Plan,sealed-plan)',
  'starting and publishing after a live rename retains admitted job, run, and artifact labels');
create temp table blocking_thread as
with review_input as materialized (
  select s.workspace_id,s.id as session_id,s.current_stage_id,s.current_artifact_id,s.current_artifact_version
  from admitted a join public.sessions s on s.id=a.session_id
)
select thread.id,thread.revision,thread.workspace_id from review_input s
cross join lateral public.create_artifact_review_thread_once(gen_random_uuid(),s.workspace_id,s.session_id,
  s.current_stage_id,s.current_artifact_id,s.current_artifact_version,
  '{"coordinateSystem":"unicode_code_points","start":0,"end":23,"quote":"The exact approved plan","prefix":"","suffix":""}',
  'blocking','Confirm the pinned review policy') thread;
select throws_ok($$select public.transition_artifact_review_thread_once(gen_random_uuid(),workspace_id,id,revision,
    'resolved','Owner attempted resolution') from blocking_thread$$,
  '42501','Authorized human reviewer required.','blocking review uses admitted approvers despite live permission changes');
set local request.jwt.claim.sub = '54450000-0000-4000-8000-000000000002';
select is((public.transition_artifact_review_thread_once(gen_random_uuid(),workspace_id,id,revision,
    'resolved','Authorized pinned reviewer resolved')).status,'resolved','admitted reviewer can resolve an exact blocking request')
from blocking_thread;
set local request.jwt.claim.sub = '54450000-0000-4000-8000-000000000001';
select is((select count(*) from admitted a cross join plan_artifact plan
  cross join lateral pg_temp.approve_fixture(a.session_id,'54450000-0002-4000-8000-000000000001',plan.id)),0::bigint,
  'live anyone-can-approve setting does not override an admitted approver list');
update public.workspace_members set is_active=false where id='54450000-0002-4000-8000-000000000002';
select is((select count(*) from admitted a cross join plan_artifact plan
  cross join lateral pg_temp.approve_fixture(a.session_id,'54450000-0002-4000-8000-000000000002',plan.id)),0::bigint,
  'an admitted approver still needs active human membership');
update public.workspace_members set is_active=true where id='54450000-0002-4000-8000-000000000002';
create temp table build_queue as select approved.*
from admitted a cross join plan_artifact plan
cross join lateral pg_temp.approve_fixture(a.session_id,'54450000-0002-4000-8000-000000000002',plan.id) approved;
select is((select current_stage_slug from build_queue),'sealed-build','approval advances into the admitted next stage despite live reorder and archive');
select is((select (run.stage_slug,run.model_provider,run.model_name)::text from public.agent_runs run
  join build_queue q on q.run_id=run.id),'(sealed-build,codex,gpt-5.5)','approval queues the pinned stage label and model');
select is((select (loaded.current_stage_slug,loaded.artifact_text)::text from admitted
  cross join lateral public.load_attempt_predecessor_approvals(session_id) loaded),
  '(sealed-plan,"The exact approved plan")','downstream prompt input keeps the exact approval and compiled predecessor label');
select is((select public.get_session_detail_page(workspace_slug,session_number) #>> '{session,pipeline,stages,1,slug}' from admitted),
  'sealed-build','the review timeline keeps the admitted stage labels and order');

create temp table build_artifact as select pg_temp.publish_fixture(job_id,'First build') as id from build_queue;
create temp table rejected as select result.* from admitted a join public.sessions s on s.id=a.session_id
  cross join build_artifact artifact cross join lateral public.reject_session_stage(
    s.id,s.workspace_id,s.current_artifact_version,'Make a targeted change','cursor','live-model',
    s.current_stage_id,artifact.id,'project','54450000-0002-4000-8000-000000000001') result;
select is((select (run.stage_slug,run.model_provider,run.model_name)::text from public.agent_runs run
  join rejected r on r.run_id=run.id),'(sealed-build,codex,gpt-5.5)','a review rejection queues the same pinned stage and model');
create temp table replacement_artifact as select pg_temp.publish_fixture(job_id,'Targeted replacement') as id from rejected;
create temp table land_queue as select approved.* from admitted a cross join replacement_artifact artifact
  cross join lateral pg_temp.approve_fixture(a.session_id,'54450000-0002-4000-8000-000000000001',artifact.id) approved;
select is((select current_stage_slug from land_queue),'sealed-land','second approval follows the original final stage');

create function pg_temp.apply_route_fixture(span integer, status text, target_session_id uuid default null)
returns table(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid) language sql as $$
  with route_input as materialized (
    select s.id,s.workspace_id,s.linear_issue_id,s.updated_at,routing.updated_at as routing_updated_at
    from public.sessions s join public.workspace_linear_routing routing using(workspace_id)
    where s.id=coalesce(target_session_id,(select session_id from admitted))
  )
  select result.* from route_input s cross join lateral public.apply_linear_session_transition(
    s.id,s.workspace_id,s.linear_issue_id,s.updated_at,s.routing_updated_at,'fixture-span-'||span,
    now()+span*interval '1 second','linear-state-'||status,now()+span*interval '1 second',
    status,'cursor','live-model','project') result;
$$;
create temp table reroute as select * from pg_temp.apply_route_fixture(1,'Rework');
select is((select outcome from reroute),'routed','Linear uses the admitted slug when no live stage has that label');
select is((select (run.stage_slug,run.model_provider,run.model_name)::text from public.agent_runs run
  join reroute r on r.run_id=run.id),'(sealed-build,codex,gpt-5.5)','Linear rework queues the admitted target and model');
select is((select array_agg(completion.stage_slug) from public.session_phase_completions completion join admitted a using(session_id)),
  array['sealed-plan'],'reroute invalidates only completions at or beyond the admitted target position');
select is((select count(*) from public.session_stage_approval_receipts receipt join admitted a using(session_id)),
  2::bigint,'reroute preserves exact historical approval evidence');

update public.workspace_linear_routing
set rework_stage_slug='edited-sealed-build',land_stage_slug='edited-sealed-land'
where workspace_id='54450000-0001-4000-8000-000000000001';
create temp table done_route as select * from pg_temp.apply_route_fixture(2,'Done');
select is((select outcome from done_route),'routed','rewritten live land label still routes an admitted session on Done');
select is((select run.stage_slug from public.agent_runs run join done_route r on r.run_id=run.id),
  'sealed-land','rewritten live land label resolves to the admitted stage');
create temp table renamed_rework as select * from pg_temp.apply_route_fixture(3,'Rework');
select is((select run.stage_slug from public.agent_runs run join renamed_rework r on r.run_id=run.id),
  'sealed-build','rewritten live rework label resolves to the admitted stage');

insert into public.pipeline_stages(pipeline_id,workspace_id,position,slug,name) values
  ('54450000-0003-4000-8000-000000000001','54450000-0001-4000-8000-000000000001',4,'sealed-build','Different live stage');
update public.workspace_linear_routing set rework_stage_slug='sealed-build'
where workspace_id='54450000-0001-4000-8000-000000000001';
select is((select outcome from pg_temp.apply_route_fixture(4,'Rework')),'missing_stage',
  'a configured live anchor outside the definition cannot fall through to an unrelated admitted label');

-- Publish new labels without altering the stage identities already admitted.
-- Remove Plan and add a stage that the earlier session does not have.
create temp table routing_settings_draft as
select draft.* from public.factories f cross join active_definition original
cross join lateral (select jsonb_set(original.body,'{stages}',jsonb_build_array(
  jsonb_set(original.body #> '{stages,1}','{slug}','"ship-rework"'),
  jsonb_set(original.body #> '{stages,2}','{slug}','"ship-land"'),
  jsonb_set(original.body #> '{stages,2}','{slug}','"recently-added"') ||
    '{"id":"54450000-0004-4000-8000-000000000004","name":"Recently added"}'::jsonb))::text as body) source
cross join lateral public.save_settings_factory_definition_draft(f.workspace_id,f.id,
  '54450000-0000-4000-8000-000000000001',1,source.body,encode(sha256(convert_to(source.body,'UTF8')),'hex'),
  '{"newStageIds":["54450000-0004-4000-8000-000000000004"]}') draft
where f.workspace_id='54450000-0001-4000-8000-000000000001' and f.is_default;
insert into public.workspace_e2b_sandbox_connections(workspace_id,encrypted_api_key)
values ('54450000-0001-4000-8000-000000000001','pinned-route-test-ciphertext');
insert into public.sandbox_capability_checks(workspace_id,github_repository_id,status,capabilities,
  sandbox_provider,agent_provider,agent_model,sandbox_connection_revision,factory_definition_digest,checked_at)
select d.workspace_id,'54450000-0006-4000-8000-000000000001','success','{"git":{"ok":true,"detail":null}}',
  'e2b','codex','gpt-5.5',c.connection_revision,d.canonical_digest,clock_timestamp()
from routing_settings_draft d join public.workspace_e2b_sandbox_connections c using(workspace_id);
create temp table routing_settings_activation as
select activation.* from routing_settings_draft d
cross join lateral public.publish_settings_factory_definition_draft(d.workspace_id,d.factory_id,
  '54450000-0000-4000-8000-000000000001',1,d.id,array['e2b'],array['git']) activation;

create function pg_temp.save_published_routes(rework_slug text, land_slug text)
returns public.workspace_linear_routing language sql as $$
  select public.save_linear_routing_config(a.workspace_id,'54450000-0000-4000-8000-000000000001',
    rework_slug,r.status_mappings,p_land_slug => land_slug,p_check_revision => true,
    p_expected_revision_id => a.revision_id)
  from routing_settings_activation a join public.workspace_linear_routing r using(workspace_id);
$$;
select throws_ok($$select pg_temp.save_published_routes('sealed-plan','ship-land')$$,
  'PT422',null,'routing settings reject a stage removed from the published definition');
select ok((select r.rework_stage_id='54450000-0004-4000-8000-000000000002'::uuid
  and r.land_stage_id='54450000-0004-4000-8000-000000000003'::uuid
  from pg_temp.save_published_routes('ship-rework','ship-land') r),
  'routing settings capture the stable identities behind the published labels');
select is((select outcome from pg_temp.apply_route_fixture(3,'Rework')),'duplicate',
  'the same Rework span remains consumed when its target gets a published label and stable ID');
select is((select job.status::text from renamed_rework route join public.agent_jobs job on job.id=route.job_id),
  'queued','binding the same target preserves the queued job from the original span');
create temp table published_rework as select * from pg_temp.apply_route_fixture(5,'Rework');
select is((select run.stage_slug from published_rework a join public.agent_runs run on run.id=a.run_id),
  'sealed-build','a renamed published Rework target reaches an older admitted stage');
create temp table published_done as select * from pg_temp.apply_route_fixture(6,'Done');
select is((select run.stage_slug from published_done a join public.agent_runs run on run.id=a.run_id),
  'sealed-land','a renamed published Done target reaches an older admitted land stage');
select pg_temp.save_published_routes('ship-rework','recently-added');
select is((select outcome from pg_temp.apply_route_fixture(6,'Done')),
  'missing_stage','an older session refuses a Done target present only in the newer published definition');
select ok((select s.archived_at is null and s.current_stage_id='54450000-0004-4000-8000-000000000003'::uuid
  from admitted a join public.sessions s on s.id=a.session_id),
  'the missing target does not archive the session or change its admitted stage');
create temp table admitted_with_added_stage as select * from public.create_session_with_first_job(
  '54450000-0001-4000-8000-000000000001','54450000-0002-4000-8000-000000000001',
  'Admitted after stage addition','Use the newly published route','codex','gpt-5.5',
  'PINNED-NEW','https://linear.app/test/issue/PINNED-NEW');
select is((select outcome from admitted_with_added_stage a
  cross join lateral pg_temp.apply_route_fixture(8,'Done',a.session_id)),
  'routed','an admitted session whose definition includes the new target can route to it');

select pg_temp.new_delivery_policy('code',2);
select pg_temp.activate_fixture(3,(select jsonb_set(body,'{deliveryPolicyRevisionId}','null') from active_definition));
create temp table unconfigured as select * from public.create_session_with_first_job(
  '54450000-0001-4000-8000-000000000001','54450000-0002-4000-8000-000000000001',
  'Explicit absence of a delivery gate','Keep the exact delivery configuration','cursor','live-model');
select lives_ok($$select internal.assert_delivery_readiness_gate(session_id,'54450000-0001-4000-8000-000000000001')
  from unconfigured$$,'an explicitly unconfigured pinned definition never inherits the new live delivery policy');

insert into public.github_repositories(id,workspace_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch) values
  ('54450000-0006-4000-8000-000000000002','54450000-0001-4000-8000-000000000001',
   '54450000-0005-4000-8000-000000000001',54450012,'workspace-default','fixture/workspace-default',true,
   'https://github.com/fixture/workspace-default','main');
insert into public.workspace_repository_profiles(workspace_id,github_repository_id,is_primary) values
  ('54450000-0001-4000-8000-000000000001','54450000-0006-4000-8000-000000000002',true);
delete from public.github_repositories where id='54450000-0006-4000-8000-000000000001';
select is((select public.get_session_detail_page(workspace_slug,session_number) #>> '{activity,sessionGithubRepositoryId}' from admitted),
  '54450000-0006-4000-8000-000000000001','a disconnected repo keeps the exact admitted repository identity in session detail');
select is((select public.get_session_detail_page(workspace_slug,session_number) #> '{activity,repository}' from admitted),
  'null'::jsonb,'a disconnected admitted repository does not display the unrelated workspace default');

select * from finish();
rollback;
