-- OP-508: server-owned PR readiness gates final delivery approval.
-- Evaluator truth table, stale-decision rejection, concurrency, and generic
-- pipeline compatibility. Fixtures reach the final stage through the real
-- approve → start → publish path, never by inventing review state.
--
-- The race block needs data visible to independent connections, so its
-- dedicated pipeline, policy, fixture, and cross-connection helper are
-- committed in their own phase. Every phase commits so pgTAP state survives,
-- and each phase deletes its fixtures before committing: the database ends
-- exactly as it began, and the start cleanup recovers a failed prior run.
begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

-- Clean committed leftovers from a failed prior run before seeding.
delete from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and title like 'Readiness%';
delete from public.pipelines where id in ('50500000-0000-4000-8000-000000000101','50500000-0000-4000-8000-000000000201',
  '50500000-0000-4000-8000-000000000301','50500000-0000-4000-8000-000000000401','50500000-0000-4000-8000-000000000501');
drop function if exists public.test_op508_refresh(uuid,text);

insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0)
from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);

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
create function pg_temp.pr_fixture(label text,pipeline_id uuid)
returns uuid language plpgsql as $$
declare fixture record; started uuid;
begin
  select * into strict fixture from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
    label,'Synchronize accepted code','codex','gpt-5.5',null,null,'12b2c3d4-0001-4000-8000-000000000001',pipeline_id);
  started:=pg_temp.pr_start(fixture.job_id);
  perform pg_temp.pr_publish(fixture.job_id,started,repeat('b',40));
  return fixture.session_id;
end;
$$;
-- Synchronize the current canonical PR epoch through the real claim→observe→finish path.
create function pg_temp.sync_canonical(target_session uuid,pr_number integer)
returns boolean language plpgsql as $$
declare op public.session_pr_operations; epoch public.session_pr_epochs; receipt uuid;
begin
  perform public.claim_session_pr_sync(target_session);
  select * into strict op from public.session_pr_operations
    where session_id=target_session and status='claimed' order by created_at desc limit 1;
  select * into strict epoch from public.session_pr_epochs where id=op.epoch_id;
  receipt:=public.begin_session_pr_sync_observation(op.id,op.claim_id,pr_number,
    'https://github.com/'||epoch.repository_full_name||'/pull/'||pr_number);
  if not public.finish_session_pr_sync(op.id,op.claim_id,op.desired_sha,op.desired_fence_sha,pr_number,
    'https://github.com/'||epoch.repository_full_name||'/pull/'||pr_number,'open',false,op.desired_sha,now(),receipt) then
    raise exception 'Canonical PR synchronization failed'; end if;
  return true;
end;
$$;
-- Complete one authoritative GitHub collection against the canonical PR.
create function pg_temp.refresh_github(target_session uuid,head_sha text)
returns boolean language plpgsql as $$
declare workspace uuid; claim jsonb; payload jsonb;
begin
  select workspace_id into strict workspace from public.sessions where id=target_session;
  if not public.enqueue_session_pr_refresh(workspace,target_session) then raise exception 'Refresh enqueue failed'; end if;
  claim:=public.claim_github_pr_refresh(workspace);
  if claim is null then raise exception 'Refresh claim unavailable'; end if;
  payload:=jsonb_build_object('version',1,'githubAccess','available','checks','passed','reviews','passed',
    'threads','passed','mergeability','passed','protection','verified','blockers','[]'::jsonb,
    'pr',jsonb_build_object('number',505,'state','open','draft',false,'headSha',head_sha,'baseSha',repeat('a',40),
      'updatedAt',now()));
  if not public.finish_github_pr_refresh(target_session,(claim->>'claim_token')::uuid,head_sha,repeat('a',40),payload) then
    raise exception 'GitHub refresh failed'; end if;
  return true;
end;
$$;
-- The trusted evaluator's persistence: bind a readiness decision to the
-- latest completed GitHub observation's exact canonical identity.
create function pg_temp.record_readiness(target_session uuid,p_state text,p_blockers jsonb default '[]')
returns uuid language plpgsql as $$
declare github public.session_pr_verification_observations; inserted public.session_pr_verification_observations;
  payload jsonb;
begin
  select o.* into strict github from public.session_pr_refresh_queue q
    join public.session_pr_verification_observations o on o.id=q.last_observation_id
    where q.session_id=target_session;
  payload:=case when p_state='ready' then jsonb_build_object('githubAccess','available','checks','passed',
      'reviews','passed','evidence','passed','threads','passed')
    else jsonb_build_object('githubAccess','available','checks','blocked','reviews','blocked',
      'evidence','blocked','threads','blocked') end;
  inserted:=public.record_pr_verification_observation(github.workspace_id,github.session_id,github.policy_revision_id,
    github.repository_id,github.repository_full_name,github.pr_epoch_id,github.pr_number,github.head_sha,github.base_sha,
    github.checkpoint_run_id,github.artifact_review_revision,'readiness',payload,now());
  perform public.record_pr_verification_result(inserted.id,p_state::public.pr_readiness_state,p_blockers);
  return inserted.id;
end;
$$;
-- Approve the current artifact through the real RPC, then run and publish the
-- next stage. Mid-pipeline approvals prove the delivery gate never fires
-- before the final selected stage.
create function pg_temp.advance(target_session uuid,new_output_sha text)
returns uuid language plpgsql as $$
declare owner public.sessions; next_job public.agent_jobs; started uuid;
begin
  select * into strict owner from public.sessions where id=target_session;
  perform public.approve_session_stage(target_session,owner.workspace_id,owner.current_stage_id,
    owner.current_artifact_id,owner.current_artifact_version,'c1b2c3d4-0001-4000-8000-000000000001',
    'codex','gpt-5.5','project',0);
  select * into strict next_job from public.agent_jobs
    where session_id=target_session and status='queued' order by created_at desc limit 1;
  started:=pg_temp.pr_start(next_job.id);
  perform pg_temp.pr_publish(next_job.id,started,new_output_sha);
  return started;
end;
$$;
-- A two-stage fixture resting at its final (land) stage with a synchronized
-- canonical PR and one completed authoritative GitHub refresh.
create function pg_temp.final_fixture(label text,pipeline_id uuid)
returns uuid language plpgsql as $$
declare session uuid;
begin
  session:=pg_temp.pr_fixture(label,pipeline_id);
  perform pg_temp.advance(session,repeat('c',40));
  perform pg_temp.sync_canonical(session,505);
  perform pg_temp.refresh_github(session,repeat('c',40));
  return session;
end;
$$;
create function pg_temp.approve_final(target_session uuid,expected_revision bigint default 0)
returns text language plpgsql as $$
declare owner public.sessions; receipt record;
begin
  select * into strict owner from public.sessions where id=target_session;
  select * into receipt from public.approve_session_stage(target_session,owner.workspace_id,owner.current_stage_id,
    owner.current_artifact_id,owner.current_artifact_version,'c1b2c3d4-0001-4000-8000-000000000001',
    'codex','gpt-5.5','project',expected_revision);
  return case when receipt.id is null then 'stale-artifact' else 'approved' end;
end;
$$;
-- One dedicated two-stage pipeline per delivery-policy shape so every
-- fixture is fully removable by deleting its owning pipeline.
create function pg_temp.pr_two_stage_pipeline(pipeline_id uuid,name text)
returns uuid language plpgsql as $$
declare stage_plan uuid := gen_random_uuid(); stage_land uuid := gen_random_uuid();
begin
  insert into public.pipelines(id,workspace_id,name)
    values(pipeline_id,'b1b2c3d4-0001-4000-8000-000000000001',name);
  insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name) values
    (stage_plan,pipeline_id,'b1b2c3d4-0001-4000-8000-000000000001',1,'plan','Plan'),
    (stage_land,pipeline_id,'b1b2c3d4-0001-4000-8000-000000000001',2,'land','Land');
  return pipeline_id;
end;
$$;

-- Phase 1: every non-race truth-table row, on dedicated pipelines.
select is(pg_temp.pr_two_stage_pipeline('50500000-0000-4000-8000-000000000401','Delivery readiness gate'),
  '50500000-0000-4000-8000-000000000401','gate pipeline created');
select is(pg_temp.pr_two_stage_pipeline('50500000-0000-4000-8000-000000000501','Delivery readiness ungated'),
  '50500000-0000-4000-8000-000000000501','ungated pipeline created');
select is(pg_temp.pr_two_stage_pipeline('50500000-0000-4000-8000-000000000101','Delivery readiness optional'),
  '50500000-0000-4000-8000-000000000101','optional-gate pipeline created');
select is(pg_temp.pr_two_stage_pipeline('50500000-0000-4000-8000-000000000201','Delivery readiness analysis'),
  '50500000-0000-4000-8000-000000000201','analysis pipeline created');

-- Generic pipeline compatibility: with no configured delivery policy, final
-- approval proceeds without any readiness decision.
create temp table ungated_fixture as select pg_temp.pr_fixture('Readiness ungated final stage',
  '50500000-0000-4000-8000-000000000501') as session_id;
select pg_temp.advance((select session_id from ungated_fixture),repeat('c',40));
select is(pg_temp.approve_final((select session_id from ungated_fixture)),'approved',
  'no policy: final approval succeeds without a PR readiness gate');
select is((select phase_status::text from public.sessions where id=(select session_id from ungated_fixture)),'approved',
  'ungated approval still records the real terminal phase');

-- Configure the gate pipeline for code delivery gated on artifact approval.
create temp table gate_policy as select * from public.save_delivery_policy(
  'b1b2c3d4-0001-4000-8000-000000000001','50500000-0000-4000-8000-000000000401',
  'a1b2c3d4-0001-4000-8000-000000000001',0,jsonb_build_object('version',1,'deliveryMode','code',
  'requiredChecks',jsonb_build_array('CI'),'minimumApprovals',1,'requireCodeOwnerReview',false,
  'requireResolvedThreads',true,'requiredEvidence',jsonb_build_array('tests'),'freshnessSeconds',3600,
  'requireArtifactApprovalForDelivery',true));

-- A configured final approval without any readiness decision is rejected.
create temp table blocked_fixture as select pg_temp.final_fixture('Readiness gate without decision',
  '50500000-0000-4000-8000-000000000401') as session_id;
select is(pg_temp.pr_failure_state($$select pg_temp.approve_final((select session_id from blocked_fixture))$$),'PT428',
  'final approval without a readiness decision is rejected');

-- Stale review tokens keep their own deterministic conflict.
select is(pg_temp.pr_failure_state($$select pg_temp.approve_final((select session_id from blocked_fixture),7)$$),'PT412',
  'a stale review token is rejected before the readiness gate');

-- A current Ready decision enables final approval; readiness never approves by itself.
select pg_temp.record_readiness((select session_id from blocked_fixture),'ready');
select is((select phase_status::text from public.sessions where id=(select session_id from blocked_fixture)),'awaiting_review',
  'recording a current Ready decision does not approve the stage');
select is(pg_temp.approve_final((select session_id from blocked_fixture)),'approved',
  'a current Ready decision passes the final delivery gate');
select is((select archived_at is not null from public.sessions where id=(select session_id from blocked_fixture)),true,
  'final approval archives a session without Linear routing');

-- A new PR head invalidates a previously current decision.
create temp table new_head_fixture as select pg_temp.final_fixture('Readiness new PR head',
  '50500000-0000-4000-8000-000000000401') as session_id;
select pg_temp.record_readiness((select session_id from new_head_fixture),'ready');
select pg_temp.refresh_github((select session_id from new_head_fixture),repeat('f',40));
select is(pg_temp.pr_failure_state($$select pg_temp.approve_final((select session_id from new_head_fixture))$$),'PT428',
  'a PR head differing from the accepted checkpoint cannot stay Ready');

-- A policy revision change invalidates a previously current decision.
create temp table policy_fixture as select pg_temp.final_fixture('Readiness policy revision',
  '50500000-0000-4000-8000-000000000401') as session_id;
select pg_temp.record_readiness((select session_id from policy_fixture),'ready');
create temp table edited_policy as select * from public.save_delivery_policy(
  'b1b2c3d4-0001-4000-8000-000000000001','50500000-0000-4000-8000-000000000401',
  'a1b2c3d4-0001-4000-8000-000000000001',(select revision from gate_policy),jsonb_build_object('version',1,
  'deliveryMode','code','requiredChecks',jsonb_build_array('CI'),'minimumApprovals',2,'requireCodeOwnerReview',false,
  'requireResolvedThreads',true,'requiredEvidence',jsonb_build_array('tests'),'freshnessSeconds',3600,
  'requireArtifactApprovalForDelivery',true));
select is(pg_temp.pr_failure_state($$select pg_temp.approve_final((select session_id from policy_fixture))$$),'PT428',
  'a changed policy revision invalidates a previous Ready decision');

-- A review revision change invalidates a previously current decision. The
-- reviewer's fresh token clears the review fence so the gate is what answers.
create temp table review_fixture as select pg_temp.final_fixture('Readiness review revision',
  '50500000-0000-4000-8000-000000000401') as session_id;
select pg_temp.record_readiness((select session_id from review_fixture),'ready');
update public.sessions set artifact_review_revision=artifact_review_revision+1
  where id=(select session_id from review_fixture);
select is(pg_temp.pr_failure_state($$select pg_temp.approve_final((select session_id from review_fixture),1)$$),'PT428',
  'a changed review revision invalidates a previous Ready decision');

-- Repository archival invalidates a previously current decision; restoring
-- access makes the still-fresh matching identity current again.
create temp table archive_fixture as select pg_temp.final_fixture('Readiness repository archive',
  '50500000-0000-4000-8000-000000000401') as session_id;
select pg_temp.record_readiness((select session_id from archive_fixture),'ready');
update public.github_repositories set is_archived=true where id='12b2c3d4-0001-4000-8000-000000000001';
select is(pg_temp.pr_failure_state($$select pg_temp.approve_final((select session_id from archive_fixture))$$),'PT428',
  'a known repository archive invalidates a previous Ready decision');
update public.github_repositories set is_archived=false where id='12b2c3d4-0001-4000-8000-000000000001';
select is(pg_temp.approve_final((select session_id from archive_fixture)),'approved',
  'restored repository access makes the still-fresh decision current again');

-- A blocked decision with named blockers is rejected by the same gate.
create temp table blocked_state_fixture as select pg_temp.final_fixture('Readiness blocked decision',
  '50500000-0000-4000-8000-000000000401') as session_id;
select pg_temp.record_readiness((select session_id from blocked_state_fixture),'blocked',
  '[{"code":"github_required_check_failed","requirement":"CI"}]');
select is(pg_temp.pr_failure_state($$select pg_temp.approve_final((select session_id from blocked_state_fixture))$$),'PT428',
  'a blocked readiness decision cannot pass the final delivery gate');

-- Authorization: members cannot manufacture readiness or call the gate.
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.role='authenticated';
select is(pg_temp.pr_failure_state($$select public.record_pr_verification_observation(
  'b1b2c3d4-0001-4000-8000-000000000001',(select session_id from blocked_state_fixture),
  (select policy_revision_id from public.session_pr_verification_observations
    where session_id=(select session_id from blocked_state_fixture) order by created_at desc limit 1),
  '12b2c3d4-0001-4000-8000-000000000001','acme/app',null,505,repeat('b',40),repeat('a',40),null,0,'readiness',
  '{"githubAccess":"available","checks":"passed","reviews":"passed","evidence":"passed","threads":"passed"}',now())$$),'42501',
  'members cannot record their own readiness observations');
select is(pg_temp.pr_failure_state($$select internal.assert_delivery_readiness_gate(
  (select session_id from blocked_state_fixture),'b1b2c3d4-0001-4000-8000-000000000001')$$),'42501',
  'the delivery gate helper is unavailable to browser clients');
reset role;

-- Compatibility: a code policy without the approval gate and an explicit
-- analysis policy continue without any PR readiness requirement.
create temp table optional_policy as select * from public.save_delivery_policy(
  'b1b2c3d4-0001-4000-8000-000000000001','50500000-0000-4000-8000-000000000101',
  'a1b2c3d4-0001-4000-8000-000000000001',0,jsonb_build_object('version',1,'deliveryMode','code',
  'requiredChecks','[]'::jsonb,'minimumApprovals',0,'requireCodeOwnerReview',false,'requireResolvedThreads',false,
  'requiredEvidence','[]'::jsonb,'freshnessSeconds',3600,'requireArtifactApprovalForDelivery',false));
create temp table optional_fixture as select pg_temp.final_fixture('Readiness optional gate',
  '50500000-0000-4000-8000-000000000101') as session_id;
select is(pg_temp.approve_final((select session_id from optional_fixture)),'approved',
  'a code policy without the approval gate delivers without readiness');

create temp table analysis_policy as select * from public.save_delivery_policy(
  'b1b2c3d4-0001-4000-8000-000000000001','50500000-0000-4000-8000-000000000201',
  'a1b2c3d4-0001-4000-8000-000000000001',0,jsonb_build_object('version',1,'deliveryMode','analysis',
  'requiredChecks','[]'::jsonb,'minimumApprovals',0,'requireCodeOwnerReview',false,'requireResolvedThreads',false,
  'requiredEvidence','[]'::jsonb,'freshnessSeconds',3600,'requireArtifactApprovalForDelivery',true));
create temp table analysis_fixture as select pg_temp.pr_fixture('Readiness analysis policy',
  '50500000-0000-4000-8000-000000000201') as session_id;
select pg_temp.advance((select session_id from analysis_fixture),repeat('c',40));
select is(pg_temp.approve_final((select session_id from analysis_fixture)),'approved',
  'an analysis policy never synthesizes a PR gate');

-- Recorded decisions stay immutable.
select is(pg_temp.pr_failure_state($$update public.session_pr_verification_results set state='ready'
  where session_id=(select session_id from blocked_fixture)$$),'23514',
  'recorded decisions cannot be rewritten even by privileged SQL');

-- Phase 1 cleanup: delete the fixtures and their pipelines before committing.
delete from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and title like 'Readiness%';
delete from public.pipelines where id in ('50500000-0000-4000-8000-000000000101','50500000-0000-4000-8000-000000000201',
  '50500000-0000-4000-8000-000000000401','50500000-0000-4000-8000-000000000501');
commit;

-- Phase 2: commit the race fixture so independent connections can lock it.
begin;
set local request.jwt.claim.role='service_role';
select is(pg_temp.pr_two_stage_pipeline('50500000-0000-4000-8000-000000000301','Delivery readiness race'),
  '50500000-0000-4000-8000-000000000301','race pipeline created');
select public.save_delivery_policy('b1b2c3d4-0001-4000-8000-000000000001','50500000-0000-4000-8000-000000000301',
  'a1b2c3d4-0001-4000-8000-000000000001',0,jsonb_build_object('version',1,'deliveryMode','code',
  'requiredChecks',jsonb_build_array('CI'),'minimumApprovals',1,'requireCodeOwnerReview',false,
  'requireResolvedThreads',true,'requiredEvidence',jsonb_build_array('tests'),'freshnessSeconds',3600,
  'requireArtifactApprovalForDelivery',true));
create temp table race_fixture as select pg_temp.final_fixture('Readiness approval race',
  '50500000-0000-4000-8000-000000000301') as session_id;
select pg_temp.record_readiness((select session_id from race_fixture),'ready');
-- This public helper exists because dblink sessions cannot see pg_temp.
create function public.test_op508_refresh(target_session uuid,head_sha text)
returns boolean language plpgsql set search_path='' as $$
declare workspace uuid; claim jsonb; payload jsonb;
begin
  select workspace_id into workspace from public.sessions where id=target_session;
  if workspace is null then return false; end if;
  if not public.enqueue_session_pr_refresh(workspace,target_session) then return false; end if;
  claim:=public.claim_github_pr_refresh(workspace);
  if claim is null then return false; end if;
  payload:=jsonb_build_object('version',1,'githubAccess','available','checks','passed','reviews','passed',
    'threads','passed','mergeability','passed','protection','verified','blockers','[]'::jsonb,
    'pr',jsonb_build_object('number',505,'state','open','draft',false,'headSha',head_sha,'baseSha',repeat('a',40),
      'updatedAt',now()));
  if not public.finish_github_pr_refresh(target_session,(claim->>'claim_token')::uuid,head_sha,repeat('a',40),payload) then
    return false; end if;
  return true;
end;
$$;
commit;

-- Phase 3: the race itself, then the same cleanup before committing.
begin;
set local request.jwt.claim.role='service_role';

-- Concurrency: the approval that wins the session lock stays approved, and a
-- racing authoritative refresh cannot reopen delivery or manufacture history.
select extensions.dblink_connect('op508_owner',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('op508_contender',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('op508_owner','set statement_timeout=''30s''; set request.jwt.claim.role=''service_role''');
select extensions.dblink_exec('op508_contender','set statement_timeout=''30s''; set request.jwt.claim.role=''service_role''');
select extensions.dblink_exec('op508_owner','begin');
select is((select value from extensions.dblink('op508_owner',format(
  $$select case when r.id is null then 'stale-artifact' else 'approved' end as value
    from public.approve_session_stage('%1$s','b1b2c3d4-0001-4000-8000-000000000001',
      (select current_stage_id from public.sessions where id='%1$s'),
      (select current_artifact_id from public.sessions where id='%1$s'),
      (select current_artifact_version from public.sessions where id='%1$s'),
      'c1b2c3d4-0001-4000-8000-000000000001','codex','gpt-5.5','project',0) r$$,
  (select session_id from race_fixture))) as r(value text)),'approved',
  'the approval holding the session lock passes the gate against the current decision');
select extensions.dblink_send_query('op508_contender',format(
  $$select public.test_op508_refresh('%s'::uuid,'%s'::text)$$,
  (select session_id from race_fixture),repeat('f',40)));
select pg_sleep(0.05);
select extensions.dblink_exec('op508_owner','commit');
select is((select refreshed from extensions.dblink_get_result('op508_contender') as r(refreshed boolean)),false,
  'a racing refresh cannot enqueue against the archived approved session');
select count(*) from extensions.dblink_get_result('op508_contender') as r(refreshed boolean);
select is((select phase_status::text from public.sessions where id=(select session_id from race_fixture)),'approved',
  'the approval that won the lock stays approved after the race');
select is((select count(*) from public.session_pr_verification_observations
  where session_id=(select session_id from race_fixture) and source='github'),1::bigint,
  'the losing refresh leaves the authoritative observation history unchanged');
select extensions.dblink_disconnect('op508_owner');
select extensions.dblink_disconnect('op508_contender');

-- Phase 3 cleanup: the database ends exactly as it began.
delete from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and title like 'Readiness%';
delete from public.pipelines where id='50500000-0000-4000-8000-000000000301';
drop function public.test_op508_refresh(uuid,text);
commit;

begin;
select * from finish();
rollback;