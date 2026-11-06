begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0)
from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);

-- Each fixture reaches the canonical publisher through accepted checkpoint
-- adoption, never by manually inventing a synchronization row or operation.
create function pg_temp.pr_failure_state(statement text)
returns text language plpgsql as $$
begin
  begin
    execute statement;
    raise exception 'Operation unexpectedly succeeded' using errcode='Z0001';
  exception when others then
    return case when sqlstate='Z0001' then '00000' else sqlstate end;
  end;
end;
$$;
create function pg_temp.pr_start(target_job uuid)
returns uuid language plpgsql as $$
declare owner public.sessions; selected public.session_job_git_inputs; started uuid;
begin
  select s.* into strict owner from public.sessions s join public.agent_jobs j on j.session_id=s.id where j.id=target_job;
  update public.agent_jobs set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()), status='running',attempt_count=1 where id=target_job;
  started:=public.start_session_job_attempt(target_job,1,owner.current_stage_id,owner.current_artifact_version,
    'codex','gpt-5.5','project','wallie/canonical-source-'||target_job::text);
  select * into selected from public.session_job_git_inputs where job_id=target_job;
  perform public.pin_session_job_git_input(target_job,1,started,'12b2c3d4-0001-4000-8000-000000000001',
    coalesce(selected.base_branch,'main'),coalesce(selected.input_sha,repeat('a',40)));
  return started;
end;
$$;
create function pg_temp.pr_publish(target_job uuid,target_run uuid,output_sha text)
returns uuid language plpgsql as $$
declare owner public.sessions; selected public.session_job_git_inputs; claim uuid; retained text;
begin
  select s.* into strict owner from public.sessions s join public.agent_jobs j on j.session_id=s.id where j.id=target_job;
  select * into strict selected from public.session_job_git_inputs where job_id=target_job;
  if not public.prepare_session_source_and_checkpoint_publication(target_run,selected.repository_id,
    selected.base_branch,selected.input_sha,output_sha,'Canonical source checkpoint','PR body','',
    case when selected.input_sha<>output_sha then encode(extensions.digest('canonical source'::bytea,'sha256'),'hex') else '' end,
    case when selected.input_sha<>output_sha then encode('canonical source'::bytea,'base64') else '' end,
    owner.current_artifact_version,'Review this canonical checkpoint') then raise exception 'Canonical source preparation failed'; end if;
  claim:=public.claim_session_checkpoint_publication(target_run);
  select retained_ref into retained from public.session_checkpoint_publications where run_id=target_run;
  if claim is null or not public.adopt_session_checkpoint_publication(target_run,claim,retained,
    case when retained is not null then output_sha end) then raise exception 'Canonical source adoption failed'; end if;
  return target_run;
end;
$$;
create function pg_temp.pr_fixture(label text,output_sha text default repeat('b',40))
returns uuid language plpgsql as $$
declare fixture record; started uuid;
begin
  select * into strict fixture from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
    label,'Synchronize accepted code','codex','gpt-5.5',null,null,'12b2c3d4-0001-4000-8000-000000000001',null);
  started:=pg_temp.pr_start(fixture.job_id);
  perform pg_temp.pr_publish(fixture.job_id,started,output_sha);
  return fixture.session_id;
end;
$$;
create function pg_temp.delivery_requirements(mode text default 'code') returns jsonb language sql as $$
 select jsonb_build_object('version',1,'deliveryMode',mode,'requiredChecks',jsonb_build_array('CI'),
 'minimumApprovals',1,'requireCodeOwnerReview',false,'requireResolvedThreads',true,
 'requiredEvidence',jsonb_build_array('tests'),'freshnessSeconds',3600,'requireArtifactApprovalForDelivery',true);
$$;

select is((select count(*) from public.delivery_policy_revisions),0::bigint,'legacy pipelines receive no invented policy revision');
select is((select count(*) from public.session_pr_verification_results),0::bigint,'legacy sessions receive no invented verification history');
create temp table fixture_pipeline as select id from public.pipelines where workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and is_default;
create temp table first_policy as select * from public.save_delivery_policy(
 'b1b2c3d4-0001-4000-8000-000000000001',(select id from fixture_pipeline),
 'a1b2c3d4-0001-4000-8000-000000000001',0,pg_temp.delivery_requirements());
select is((select revision from first_policy),1::bigint,'first policy has explicit revision one');
select is(pg_temp.pr_failure_state($$select public.save_delivery_policy('b1b2c3d4-0001-4000-8000-000000000001',
 (select id from fixture_pipeline),'a1b2c3d4-0001-4000-8000-000000000001',0,pg_temp.delivery_requirements())$$),'PT409',
 'stale policy save cannot overwrite a newer revision');
select is(pg_temp.pr_failure_state($$select public.save_delivery_policy('b1b2c3d4-0001-4000-8000-000000000001',
 (select id from fixture_pipeline),gen_random_uuid(),1,pg_temp.delivery_requirements())$$),'42501',
 'service callers must name a real active workspace manager');
select is(pg_temp.pr_failure_state($$select public.save_delivery_policy('b1b2c3d4-0001-4000-8000-000000000001',
 (select id from fixture_pipeline),'a1b2c3d4-0002-4000-8000-000000000002',1,pg_temp.delivery_requirements())$$),'42501',
 'ordinary active members cannot edit delivery requirements through a privileged proxy');
select is(pg_temp.pr_failure_state($$select public.save_delivery_policy('b1b2c3d4-0001-4000-8000-000000000001',
 gen_random_uuid(),'a1b2c3d4-0001-4000-8000-000000000001',0,pg_temp.delivery_requirements())$$),'42501',
 'unknown or foreign pipeline cannot be configured');
select is(pg_temp.pr_failure_state($$select public.save_delivery_policy('b1b2c3d4-0001-4000-8000-000000000001',
 (select id from fixture_pipeline),'a1b2c3d4-0001-4000-8000-000000000001',1,pg_temp.delivery_requirements()-'requiredChecks')$$),'23514',
 'missing check requirements never default to successful verification');
select ok(not internal.valid_delivery_requirements(pg_temp.delivery_requirements()||'{"requiredChecks":["CI","CI"]}'),
 'duplicate check names cannot imply additional successful checks');
select ok(not internal.valid_delivery_requirements(pg_temp.delivery_requirements()||'{"freshnessSeconds":0}'),
 'freshness must be explicitly bounded');
select ok(not internal.valid_delivery_requirements(pg_temp.delivery_requirements()||'{"minimumApprovals":0.5}'),
 'fractional approval counts are invalid');
select is(pg_temp.pr_failure_state($$update public.delivery_policy_revisions set requirements=pg_temp.delivery_requirements('analysis')$$),'23514',
 'privileged callers cannot rewrite policy history');
select is(pg_temp.pr_failure_state($$delete from public.delivery_policy_revisions$$),'23514','policy history cannot be deleted directly');

create temp table code_fixture as select pg_temp.pr_fixture('Delivery verification policy') as session_id;
select is(pg_temp.pr_failure_state($$select public.record_pr_verification_observation(
 'b1b2c3d4-0001-4000-8000-000000000001',(select session_id from code_fixture),(select id from first_policy),
 null,null,null,null,null,null,null,0,'github','{}',now())$$),'23514',
 'code delivery cannot record successful-looking observations without a canonical PR');
select public.claim_session_pr_sync((select session_id from code_fixture));
create temp table verification_operation as
 select o.* from public.session_pr_operations o where o.session_id=(select session_id from code_fixture) and o.status='claimed';
create temp table verification_receipt as select public.begin_session_pr_sync_observation(id,claim_id,505,
 'https://github.com/'||(select repository_full_name from public.session_pr_epochs where id=epoch_id)||'/pull/505') as id from verification_operation;
select ok((select public.finish_session_pr_sync(id,claim_id,desired_sha,desired_fence_sha,505,
 'https://github.com/'||(select repository_full_name from public.session_pr_epochs where id=epoch_id)||'/pull/505',
 'open',false,desired_sha,now(),(select id from verification_receipt)) from verification_operation),'canonical fixture synchronizes accepted code');
create temp table code_observation as select observation.* from public.session_pr_epochs e
 cross join lateral public.record_pr_verification_observation(
 'b1b2c3d4-0001-4000-8000-000000000001',(select session_id from code_fixture),(select id from first_policy),
 '12b2c3d4-0001-4000-8000-000000000001',e.repository_full_name,e.id,e.pr_number,e.pr_head_sha,repeat('a',40),
 (select checkpoint_run_id from verification_operation),0,'readiness','{"githubAccess":"available","checks":"passed","reviews":"passed","evidence":"passed","threads":"passed"}',now()) observation
 where e.id=(select epoch_id from verification_operation);

select is(pg_temp.pr_failure_state($$select public.record_pr_verification_observation(
 'b1b2c3d4-0001-4000-8000-000000000001',(select session_id from code_fixture),(select id from first_policy),
 '12b2c3d4-0001-4000-8000-000000000001','wrong/repository',(select pr_epoch_id from code_observation),505,
 repeat('b',40),repeat('a',40),(select checkpoint_run_id from code_observation),0,'github','{}',now())$$),'23514',
 'canonical PR observations cannot mix repository identity from another source');
select is(pg_temp.pr_failure_state($$select public.record_pr_verification_observation(
 'b1b2c3d4-0001-4000-8000-000000000001',(select session_id from code_fixture),(select id from first_policy),
 '12b2c3d4-0001-4000-8000-000000000001',(select repository_full_name from code_observation),
 (select pr_epoch_id from code_observation),999,repeat('b',40),repeat('a',40),(select checkpoint_run_id from code_observation),0,
 'github','{}',now())$$),'23514','a different PR number cannot borrow canonical checkpoint evidence');

create function pg_temp.verification_attempt(payload jsonb,source text default 'readiness') returns text language plpgsql as $$
declare prior public.session_pr_verification_observations; inserted public.session_pr_verification_observations;
begin
  select * into prior from code_observation;
  inserted:=public.record_pr_verification_observation(prior.workspace_id,prior.session_id,prior.policy_revision_id,
    prior.repository_id,prior.repository_full_name,prior.pr_epoch_id,prior.pr_number,prior.head_sha,prior.base_sha,
    prior.checkpoint_run_id,prior.artifact_review_revision,source,payload,now());
  perform public.record_pr_verification_result(inserted.id,'ready','[]');
  return '00000';
exception when others then return sqlstate;
end;
$$;
select is(pg_temp.verification_attempt('{}'),'23514','empty verification requirements cannot imply Ready');
select is(pg_temp.verification_attempt((select payload from code_observation)-'githubAccess'),'23514','missing GitHub access cannot imply Ready');
select is(pg_temp.verification_attempt((select payload from code_observation)||'{"githubAccess":"unavailable"}'),'23514','unavailable GitHub access cannot imply Ready');
select is(pg_temp.verification_attempt((select payload from code_observation)||'{"checks":"unknown"}'),'23514','unknown required checks cannot imply Ready');
select is(pg_temp.verification_attempt((select payload from code_observation)||'{"reviews":"failed"}'),'23514','failed review requirements cannot imply Ready');
select is(pg_temp.verification_attempt((select payload from code_observation)-'evidence'),'23514','missing evidence requirements cannot imply Ready');
select is(pg_temp.verification_attempt((select payload from code_observation)||'{"threads":"unknown"}'),'23514','unknown blocking threads cannot imply Ready');
select is(pg_temp.verification_attempt((select payload from code_observation),'github'),'23514','raw GitHub observations cannot themselves attest a readiness decision');

create temp table code_result as select * from public.record_pr_verification_result((select id from code_observation),'ready','[]');
select ok((select is_current from public.session_pr_verification_currentness where id=(select id from code_result)),
 'current policy/checkpoint/PR/review identity and freshness are available separately from readiness state');
update public.github_repositories set is_archived=true where id='12b2c3d4-0001-4000-8000-000000000001';
select ok(not (select is_current from public.session_pr_verification_currentness where id=(select id from code_result)),
 'known repository archival immediately invalidates current verification');
update public.github_repositories set is_archived=false where id='12b2c3d4-0001-4000-8000-000000000001';
select ok((select is_current from public.session_pr_verification_currentness where id=(select id from code_result)),
 'restoring repository access makes the still-fresh matching identity current again');
update public.github_installations set suspended=true where id=(select github_installation_id from public.github_repositories where id='12b2c3d4-0001-4000-8000-000000000001');
select ok(not (select is_current from public.session_pr_verification_currentness where id=(select id from code_result)),
 'known GitHub installation suspension invalidates current verification before TTL expiry');
update public.github_installations set suspended=false where id=(select github_installation_id from public.github_repositories where id='12b2c3d4-0001-4000-8000-000000000001');
select ok((select is_current from public.session_pr_verification_currentness where id=(select id from code_result)),
 'restored installation retains immutable historical observations');

select is((select phase_status::text from public.sessions where id=(select session_id from code_fixture)),'awaiting_review',
 'recording PR readiness does not approve a stage or require generic artifact approval');
select is(pg_temp.pr_failure_state($$update public.session_pr_verification_observations set payload='{}'$$),'23514',
 'verification observations are immutable even to privileged SQL');
select is(pg_temp.pr_failure_state($$update public.session_pr_verification_results set state='merged'$$),'23514',
 'results cannot be rewritten into a different readiness state');
select is(pg_temp.pr_failure_state($$select public.record_pr_verification_result((select id from code_observation),'not_applicable','[]')$$),'23514',
 'code delivery cannot use analysis not-applicable state');
select is(pg_temp.pr_failure_state($$select public.record_pr_verification_result((select id from code_observation),'ready','["CI failed"]')$$),'23514',
 'ready results cannot carry known blockers');

create temp table second_policy as select * from public.save_delivery_policy(
 'b1b2c3d4-0001-4000-8000-000000000001',(select id from fixture_pipeline),
 'a1b2c3d4-0001-4000-8000-000000000001',1,pg_temp.delivery_requirements('analysis'));
select is((select revision from second_policy),2::bigint,'policy edits append a new revision');
select ok(not (select is_current from public.session_pr_verification_currentness where id=(select id from code_result)),
 'editing policy immediately invalidates previous decisions without rewriting history');
select is((select state::text from public.session_pr_verification_results where id=(select id from code_result)),'ready',
 'historical decision remains an immutable historical observation');
create temp table analysis_observation as select * from public.record_pr_verification_observation(
 'b1b2c3d4-0001-4000-8000-000000000001',(select session_id from code_fixture),(select id from second_policy),
 null,null,null,null,null,null,null,0,'readiness','{}',now());
create temp table analysis_result as select * from public.record_pr_verification_result((select id from analysis_observation),'not_applicable','[]');
select ok((select is_current from public.session_pr_verification_currentness where id=(select id from analysis_result)),
 'analysis-only policy can explicitly produce not-applicable without a repository or PR identity');
select is(pg_temp.pr_failure_state($$select public.record_pr_verification_result((select id from analysis_observation),'ready','[]')$$),'23514',
 'analysis-only not-applicable does not masquerade as a ready code PR');
create temp table stale_observation as select * from public.record_pr_verification_observation(
 'b1b2c3d4-0001-4000-8000-000000000001',(select session_id from code_fixture),(select id from second_policy),
 null,null,null,null,null,null,null,0,'readiness','{}',now()-interval '2 hours');
create temp table stale_result as select * from public.record_pr_verification_result((select id from stale_observation),'not_applicable','[]');
select ok(not (select is_current from public.session_pr_verification_currentness where id=(select id from stale_result)),
 'expired observations are not current even when their recorded state was successful');
update public.sessions set artifact_review_revision=artifact_review_revision+1 where id=(select session_id from code_fixture);
select ok(not (select is_current from public.session_pr_verification_currentness where id=(select id from analysis_result)),
 'review changes invalidate observations of an earlier review revision');
select is(pg_temp.pr_failure_state($$select public.record_pr_verification_observation(
 'b1b2c3d4-0001-4000-8000-000000000001',(select session_id from code_fixture),(select id from second_policy),
 null,null,null,null,null,null,null,0,'readiness','{}',now()+interval '1 hour')$$),'23514',
 'future timestamps cannot extend freshness');

grant select on fixture_pipeline,first_policy,code_fixture,code_observation to authenticated,service_role;
set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';
select is((select count(*) from public.delivery_policy_revisions where pipeline_id=(select id from fixture_pipeline)),2::bigint,
 'active workspace members can inspect versioned policy history');
select is((select count(*) from public.session_pr_verification_observations where session_id=(select session_id from code_fixture)),3::bigint,
 'active workspace members can inspect their verification evidence');
select is(pg_temp.pr_failure_state($$insert into public.session_pr_verification_results(workspace_id,session_id,observation_id,state,blockers)
 values('b1b2c3d4-0001-4000-8000-000000000001',(select session_id from code_fixture),(select id from code_observation),'ready','[]')$$),'42501',
 'members cannot publish their own successful verification result');
select is(pg_temp.pr_failure_state($$update public.delivery_policy_revisions set revision=99$$),'42501',
 'members cannot rewrite policy revisions');
select is(pg_temp.pr_failure_state($$delete from public.session_pr_verification_results$$),'42501',
 'members cannot erase verification results');
select is(pg_temp.pr_failure_state($$insert into public.session_pr_verification_observations(workspace_id,session_id,policy_revision_id,
 artifact_review_revision,source,payload,observed_at) values('b1b2c3d4-0001-4000-8000-000000000001',
 (select session_id from code_fixture),(select id from first_policy),0,'readiness','{}',now())$$),'42501',
 'members cannot invent observation payloads');
select is(pg_temp.pr_failure_state($$select public.record_pr_verification_result((select id from code_observation),'ready','[]')$$),'42501',
 'privileged verification RPC is unavailable to browser clients');
select is(pg_temp.pr_failure_state($$select public.save_delivery_policy('b1b2c3d4-0001-4000-8000-000000000001',
 (select id from fixture_pipeline),'a1b2c3d4-0001-4000-8000-000000000001',2,pg_temp.delivery_requirements())$$),'42501',
 'even workspace managers configure policies through the authorized server route');
reset role;
insert into auth.users(id,email) values('50500000-0000-4000-8000-000000000001','delivery-outsider@example.test');
insert into public.workspaces(id,name,slug) values('50500000-0000-4000-8000-000000000002','Other delivery workspace','delivery-policy-other');
insert into public.workspace_members(workspace_id,user_id,kind,role,is_active) values('50500000-0000-4000-8000-000000000002','50500000-0000-4000-8000-000000000001','human','owner',true);
set local role authenticated;
set local request.jwt.claim.sub='50500000-0000-4000-8000-000000000001';
select is((select count(*) from public.delivery_policy_revisions where pipeline_id=(select id from fixture_pipeline)),0::bigint,
 'foreign workspace member cannot read policy history');
select is((select count(*) from public.session_pr_verification_observations where session_id=(select session_id from code_fixture)),0::bigint,
 'foreign workspace member cannot read observations');
select is((select count(*) from public.session_pr_verification_results where session_id=(select session_id from code_fixture)),0::bigint,
 'foreign workspace member cannot read results');
select is((select count(*) from public.session_pr_verification_currentness where session_id=(select session_id from code_fixture)),0::bigint,
 'security-invoker currentness view preserves tenant isolation');
reset role;
set local role anon;
select is(pg_temp.pr_failure_state($$select * from public.delivery_policies$$),'42501','anonymous callers cannot read policies');
select is(pg_temp.pr_failure_state($$select * from public.session_pr_verification_observations$$),'42501','anonymous callers cannot read observations');
select is(pg_temp.pr_failure_state($$select * from public.session_pr_verification_currentness$$),'42501','anonymous callers cannot query result currentness');
reset role;
set local role service_role;
select is(pg_temp.pr_failure_state($$delete from public.session_pr_verification_observations$$),'42501',
 'service-role callers also use append-only verification RPCs instead of direct table writes');
reset role;
set local request.jwt.claim.role='service_role';
set local request.jwt.claim.sub='';
-- Append-only retention must still permit the established owning-entity purge.
insert into public.workspaces(id,name,slug) values('50500000-0000-4000-8000-000000000010','Purge delivery workspace','delivery-policy-purge');
insert into public.workspace_members(workspace_id,user_id,kind,role,is_active)
 values('50500000-0000-4000-8000-000000000010','a1b2c3d4-0001-4000-8000-000000000001','human','owner',true);
insert into public.pipelines(id,workspace_id,name)
 values('50500000-0000-4000-8000-000000000011','50500000-0000-4000-8000-000000000010','Analysis purge');
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name)
 values('50500000-0000-4000-8000-000000000012','50500000-0000-4000-8000-000000000011','50500000-0000-4000-8000-000000000010',1,'investigation','Investigation');
insert into public.sessions(id,workspace_id,number,title,pipeline_id,current_stage_id,phase_status)
 values('50500000-0000-4000-8000-000000000013','50500000-0000-4000-8000-000000000010',1,'Purge verification',
 '50500000-0000-4000-8000-000000000011','50500000-0000-4000-8000-000000000012','awaiting_review');
create temp table purge_policy as select * from public.save_delivery_policy('50500000-0000-4000-8000-000000000010',
 '50500000-0000-4000-8000-000000000011','a1b2c3d4-0001-4000-8000-000000000001',0,pg_temp.delivery_requirements('analysis'));
create temp table purge_observation as select * from public.record_pr_verification_observation(
 '50500000-0000-4000-8000-000000000010','50500000-0000-4000-8000-000000000013',(select id from purge_policy),
 null,null,null,null,null,null,null,0,'readiness','{}',now());
select public.record_pr_verification_result((select id from purge_observation),'not_applicable','[]');
select is(pg_temp.pr_failure_state($$delete from public.session_pr_verification_observations where id=(select id from purge_observation)$$),'23514',
 'explicit observation deletion is denied while the owning session exists');
select lives_ok($$delete from public.sessions where id='50500000-0000-4000-8000-000000000013'$$,
 'owning session purge cascades through immutable observations and results');
select is((select count(*) from public.session_pr_verification_results where workspace_id='50500000-0000-4000-8000-000000000010'),0::bigint,
 'session purge leaves no orphan verification results');
-- Repeat with live session history so workspace cascade ordering is exercised.
insert into public.sessions(id,workspace_id,number,title,pipeline_id,current_stage_id,phase_status)
 values('50500000-0000-4000-8000-000000000014','50500000-0000-4000-8000-000000000010',2,'Workspace purge verification',
 '50500000-0000-4000-8000-000000000011','50500000-0000-4000-8000-000000000012','awaiting_review');
create temp table workspace_purge_observation as select * from public.record_pr_verification_observation(
 '50500000-0000-4000-8000-000000000010','50500000-0000-4000-8000-000000000014',(select id from purge_policy),
 null,null,null,null,null,null,null,0,'readiness','{}',now());
select public.record_pr_verification_result((select id from workspace_purge_observation),'not_applicable','[]');
select lives_ok($$delete from public.workspaces where id='50500000-0000-4000-8000-000000000010'$$,
 'owning workspace purge removes immutable policy and verification history');
select is((select count(*) from public.delivery_policy_revisions where workspace_id='50500000-0000-4000-8000-000000000010'),0::bigint,
 'workspace purge leaves no orphan policy revisions');

select * from finish();
rollback;
