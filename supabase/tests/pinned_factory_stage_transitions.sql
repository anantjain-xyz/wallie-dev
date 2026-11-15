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

create temp table reroute as
select result.* from admitted a join public.sessions s on s.id=a.session_id
  join public.workspace_linear_routing routing on routing.workspace_id=s.workspace_id
  cross join lateral public.apply_linear_session_transition(
    s.id,s.workspace_id,s.linear_issue_id,s.updated_at,routing.updated_at,'test-rework',
    clock_timestamp()+interval '1 second','linear-rework',clock_timestamp()+interval '2 seconds',
    'Rework','cursor','live-model','project') result;
select is((select outcome from reroute),'routed','Linear still finds the admitted slug after the live anchor is renamed');
select is((select (run.stage_slug,run.model_provider,run.model_name)::text from public.agent_runs run
  join reroute r on r.run_id=run.id),'(sealed-build,codex,gpt-5.5)','Linear rework queues the admitted target and model');
select is((select array_agg(completion.stage_slug) from public.session_phase_completions completion join admitted a using(session_id)),
  array['sealed-plan'],'reroute invalidates only completions at or beyond the admitted target position');
select is((select count(*) from public.session_stage_approval_receipts receipt join admitted a using(session_id)),
  2::bigint,'reroute preserves exact historical approval evidence');

select pg_temp.new_delivery_policy('code',2);
select pg_temp.activate_fixture(2,(select jsonb_set(body,'{deliveryPolicyRevisionId}','null') from active_definition));
create temp table unconfigured as select * from public.create_session_with_first_job(
  '54450000-0001-4000-8000-000000000001','54450000-0002-4000-8000-000000000001',
  'Explicit absence of a delivery gate','Keep the exact delivery configuration','cursor','live-model');
select lives_ok($$select internal.assert_delivery_readiness_gate(session_id,'54450000-0001-4000-8000-000000000001')
  from unconfigured$$,'an explicitly unconfigured pinned definition never inherits the new live delivery policy');

select * from finish();
rollback;
