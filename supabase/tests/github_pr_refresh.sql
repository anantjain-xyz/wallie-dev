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

create temp table fixture_pipeline as select id from public.pipelines where workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and is_default;
create temp table first_policy as select * from public.save_delivery_policy(
 'b1b2c3d4-0001-4000-8000-000000000001',(select id from fixture_pipeline),
 'a1b2c3d4-0001-4000-8000-000000000001',0,pg_temp.delivery_requirements());
select is((select revision from first_policy),1::bigint,'first policy has explicit revision one');
create temp table code_fixture as select pg_temp.pr_fixture('Delivery verification policy') as session_id;
select public.claim_session_pr_sync((select session_id from code_fixture));
create temp table verification_operation as
 select o.* from public.session_pr_operations o where o.session_id=(select session_id from code_fixture) and o.status='claimed';
create temp table verification_receipt as select public.begin_session_pr_sync_observation(id,claim_id,505,
 'https://github.com/'||(select repository_full_name from public.session_pr_epochs where id=epoch_id)||'/pull/505') as id from verification_operation;
select ok((select public.finish_session_pr_sync(id,claim_id,desired_sha,desired_fence_sha,505,
 'https://github.com/'||(select repository_full_name from public.session_pr_epochs where id=epoch_id)||'/pull/505',
 'open',false,desired_sha,now(),(select id from verification_receipt)) from verification_operation),'canonical fixture synchronizes accepted code');
create temp table event_scope as select i.installation_id,r.repo_id from public.github_repositories r
 join public.github_installations i on i.id=r.github_installation_id where r.id='12b2c3d4-0001-4000-8000-000000000001';
select is((select count(*) from public.session_pr_refresh_queue),0::bigint,'legacy verification has no invented GitHub history');
select ok(not public.enqueue_session_pr_refresh('b1b2c3d4-0001-4000-8000-000000000001',gen_random_uuid()),'unknown session cannot be queued');
select is(public.enqueue_github_pr_refresh_event(999999999,(select repo_id from event_scope),'unknown-installation',array[505]),0,'unknown installation cannot touch a repository');
select is(public.enqueue_github_pr_refresh_event((select installation_id from event_scope),999999999,'unknown-repo',array[505]),0,'repository IDs stay inside the installation');
select is(public.enqueue_github_pr_refresh_event((select installation_id from event_scope),(select repo_id from event_scope),'event-one',array[505]),1,'signed PR wakeup queues one canonical session');
select is(public.enqueue_github_pr_refresh_event((select installation_id from event_scope),(select repo_id from event_scope),'event-one',array[505]),0,'redelivered event is idempotent');
select is((select requested_generation from public.session_pr_refresh_queue),1::bigint,'duplicate event does not revoke a live claim');
create temp table first_claim as select public.claim_github_pr_refresh() as value;
select ok((select value->>'claim_token' is not null from first_claim),'worker obtains a durable claim');
select is((select value->>'repository_id' from first_claim),'12b2c3d4-0001-4000-8000-000000000001','claim pins the session repository identity');
select is((select value->>'pr_number' from first_claim),'505','claim pins canonical PR number');
select ok(public.claim_github_pr_refresh() is null,'only one worker can claim the same session');
select is(public.enqueue_github_pr_refresh_event((select installation_id from event_scope),(select repo_id from event_scope),'event-two',array[505]),1,'new event dirties a leased refresh');
select ok(not public.finish_github_pr_refresh((select session_id from code_fixture),(select (value->>'claim_token')::uuid from first_claim),repeat('b',40),repeat('a',40),'{}'),'a pre-event network response cannot publish over a newer event');
select is((select count(*) from public.session_pr_verification_observations),0::bigint,'rejected stale response creates no observation');
create temp table second_claim as select public.claim_github_pr_refresh() as value;
select ok(not public.finish_github_pr_refresh((select session_id from code_fixture),(select (value->>'claim_token')::uuid from first_claim),repeat('b',40),repeat('a',40),'{}'),'old claim token cannot finish the next attempt');
select ok(public.finish_github_pr_refresh((select session_id from code_fixture),(select (value->>'claim_token')::uuid from second_claim),repeat('b',40),repeat('a',40),'{"githubAccess":"available","checks":"passed","checkEvidence":{"selectedSha":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}}'),'current exact response publishes an immutable source observation');
select is((select status from public.session_pr_refresh_queue),'current','queue records authoritative completion');
select is((select source from public.session_pr_verification_observations),'github','collector cannot manufacture a readiness result');
select is((select count(*) from public.session_pr_verification_results),0::bigint,'collection is independent of readiness evaluation');
select ok((select next_attempt_at>clock_timestamp() and next_attempt_at<=clock_timestamp()+interval '301 seconds' from public.session_pr_refresh_queue),'periodic refresh is bounded to five minutes');
select is(public.enqueue_github_pr_refresh_event((select installation_id from event_scope),(select repo_id from event_scope),'test-merge-status',null,repeat('e',40)),1,'status on selected test-merge SHA dirties canonical verification');
create temp table merge_claim as select public.claim_github_pr_refresh() as value;
select ok(public.finish_github_pr_refresh((select session_id from code_fixture),(select (value->>'claim_token')::uuid from merge_claim),repeat('b',40),repeat('a',40),'{"githubAccess":"available","checks":"passed"}'),'test-merge event converges via authoritative current collection');
create temp table ready_observation as select observation.* from public.session_pr_epochs e
 cross join lateral public.record_pr_verification_observation(
 'b1b2c3d4-0001-4000-8000-000000000001',(select session_id from code_fixture),(select id from first_policy),
 '12b2c3d4-0001-4000-8000-000000000001',e.repository_full_name,e.id,e.pr_number,e.pr_head_sha,repeat('a',40),
 (select checkpoint_run_id from verification_operation),0,'readiness','{"githubAccess":"available","checks":"passed","reviews":"passed","evidence":"passed","threads":"passed"}',clock_timestamp()) observation
 where e.id=(select epoch_id from verification_operation);
create temp table ready_result as select * from public.record_pr_verification_result((select id from ready_observation),'ready','[]');
select ok((select is_current from public.session_pr_verification_currentness where id=(select id from ready_result)),'readiness evaluated after latest GitHub observation may be current');
select is(public.enqueue_github_pr_refresh_event((select installation_id from event_scope),(select repo_id from event_scope),'event-one',array[505]),0,'late duplicate does not dirty current state');
select ok((select is_current from public.session_pr_verification_currentness where id=(select id from ready_result)),'ignored duplicate preserves currentness');
select is(public.enqueue_github_pr_refresh_event((select installation_id from event_scope),(select repo_id from event_scope),'base-push',null,null,'main'),1,'base-branch push refreshes current canonical PR');
select ok(not (select is_current from public.session_pr_verification_currentness where id=(select id from ready_result)),'dirty refresh immediately invalidates old readiness');
create temp table error_claim as select public.claim_github_pr_refresh() as value;
select ok(public.finish_github_pr_refresh((select session_id from code_fixture),(select (value->>'claim_token')::uuid from error_claim),p_error_code=>'github_permission_denied'),'permission failure records an actionable noncurrent state');
select is((select status from public.session_pr_refresh_queue),'error','failed refresh is explicit');
select is((select last_error_code from public.session_pr_refresh_queue),'github_permission_denied','safe permission blocker persists');
select is((select count(*) from public.session_pr_verification_observations),3::bigint,'failure never invents head or base SHAs');
select ok(not (select is_current from public.session_pr_verification_currentness where id=(select id from ready_result)),'permission failure cannot preserve successful readiness');
select ok(public.claim_github_pr_refresh() is null,'failure retry respects backoff');
select ok(public.enqueue_session_pr_refresh('b1b2c3d4-0001-4000-8000-000000000001',(select session_id from code_fixture)),'manual refresh can recover a failure');
create temp table lease_claim as select public.claim_github_pr_refresh() as value;
update public.session_pr_refresh_queue set lease_expires_at=clock_timestamp()-interval '1 second';
create temp table recovered_claim as select public.claim_github_pr_refresh() as value;
select ok((select value->>'claim_token' from recovered_claim) is distinct from (select value->>'claim_token' from lease_claim),'expired worker lease is safely recovered');
select ok(not public.finish_github_pr_refresh((select session_id from code_fixture),(select (value->>'claim_token')::uuid from lease_claim),repeat('b',40),repeat('a',40),'{}'),'dead worker cannot finish after lease recovery');
update public.sessions set artifact_review_revision=artifact_review_revision+1 where id=(select session_id from code_fixture);
select ok(not public.finish_github_pr_refresh((select session_id from code_fixture),(select (value->>'claim_token')::uuid from recovered_claim),repeat('b',40),repeat('a',40),'{}'),'review revision racing the GET fences its receipt');
create temp table policy_claim as select public.claim_github_pr_refresh() as value;
select public.save_delivery_policy('b1b2c3d4-0001-4000-8000-000000000001',(select id from fixture_pipeline),'a1b2c3d4-0001-4000-8000-000000000001',1,pg_temp.delivery_requirements());
select ok(not public.finish_github_pr_refresh((select session_id from code_fixture),(select (value->>'claim_token')::uuid from policy_claim),repeat('b',40),repeat('a',40),'{}'),'policy revision racing collection fences the old receipt');
create temp table latest_claim as select public.claim_github_pr_refresh() as value;
select is((select (value->>'artifact_review_revision')::integer from latest_claim),1,'retry pins the newest review revision');
select ok(public.finish_github_pr_refresh((select session_id from code_fixture),(select (value->>'claim_token')::uuid from latest_claim),repeat('c',40),repeat('d',40),'{"githubAccess":"available","checks":"unknown"}'),'unknown or changed-head snapshots remain evidence without implying Ready');
select is((select count(*) from public.session_pr_verification_results),1::bigint,'new unknown snapshot does not synthesize a ready result');
select ok(not (select is_current from public.session_pr_verification_currentness where id=(select id from ready_result)),'old-head result cannot satisfy new-head observation');
update public.session_pr_refresh_queue set next_attempt_at=clock_timestamp()-interval '1 second';
select is(public.enqueue_due_github_pr_refreshes(1),1,'missed webhooks recover through bounded periodic sweep');
select is(public.enqueue_due_github_pr_refreshes(1),0,'periodic sweep does not repeatedly dirty pending work');
select is(pg_temp.pr_failure_state($$select public.enqueue_due_github_pr_refreshes(101)$$),'22023','periodic fanout is capped');
select is(pg_temp.pr_failure_state($$select public.enqueue_github_pr_refresh_event(1,2,'missing-signal')$$),'22023','unscoped events cannot refresh an entire installation');
-- Archived pending rows cannot monopolize the bounded candidate scan.
create temp table archived_refresh_sessions as select gen_random_uuid() as id,n from generate_series(1,100) n;
insert into public.sessions(id,workspace_id,number,title,pipeline_id,current_stage_id,phase_status,archived_at)
 select archived.id,'b1b2c3d4-0001-4000-8000-000000000001',100000+archived.n,'Archived refresh fixture',
 live.pipeline_id,live.current_stage_id,'awaiting_review',clock_timestamp()
 from archived_refresh_sessions archived cross join public.sessions live where live.id=(select session_id from code_fixture);
insert into public.session_pr_refresh_queue(session_id,workspace_id,next_attempt_at)
 select id,'b1b2c3d4-0001-4000-8000-000000000001',clock_timestamp()-interval '1 day' from archived_refresh_sessions;
create temp table nonstarved_claim as select public.claim_github_pr_refresh() as value;
select is((select value->>'session_id' from nonstarved_claim),(select session_id::text from code_fixture),'one hundred archived pending rows cannot starve a live session');
delete from public.sessions where id in (select id from archived_refresh_sessions);
select is((select count(*) from public.session_pr_refresh_queue),1::bigint,'session purge cascades through refresh queue without orphan claims');
update public.workspaces set deletion_requested_at=clock_timestamp() where id='b1b2c3d4-0001-4000-8000-000000000001';
select is(public.enqueue_due_github_pr_refreshes(),0,'deleting workspace cannot abort global scheduling');
select ok(public.claim_github_pr_refresh() is null,'new collection cannot start behind a workspace deletion fence');
select ok(not public.finish_github_pr_refresh((select session_id from code_fixture),(select (value->>'claim_token')::uuid from nonstarved_claim),p_error_code=>'github_refresh_failed'),'in-flight collection cannot publish behind deletion fence');
select is(public.enqueue_github_pr_refresh_event((select installation_id from event_scope),(select repo_id from event_scope),'deleting-event',array[505]),0,'deleting workspace ignores event work without breaking delivery handling');
update public.workspaces set deletion_requested_at=null where id='b1b2c3d4-0001-4000-8000-000000000001';
select public.finish_github_pr_refresh((select session_id from code_fixture),(select (value->>'claim_token')::uuid from nonstarved_claim),repeat('b',40),repeat('a',40),'{"githubAccess":"available"}');
create temp table expired_github_observation as select recorded.* from public.session_pr_verification_observations prior
 cross join lateral public.record_pr_verification_observation(prior.workspace_id,prior.session_id,prior.policy_revision_id,
 prior.repository_id,prior.repository_full_name,prior.pr_epoch_id,prior.pr_number,prior.head_sha,prior.base_sha,
 prior.checkpoint_run_id,prior.artifact_review_revision,'github','{"githubAccess":"available"}',clock_timestamp()-interval '2 hours') recorded
 where prior.id=(select last_observation_id from public.session_pr_refresh_queue);
update public.session_pr_refresh_queue set last_observation_id=(select id from expired_github_observation);
create temp table fresh_decision_observation as select recorded.* from expired_github_observation prior
 cross join lateral public.record_pr_verification_observation(prior.workspace_id,prior.session_id,prior.policy_revision_id,
 prior.repository_id,prior.repository_full_name,prior.pr_epoch_id,prior.pr_number,prior.head_sha,prior.base_sha,
 prior.checkpoint_run_id,prior.artifact_review_revision,'readiness','{"githubAccess":"available","checks":"passed","reviews":"passed","evidence":"passed","threads":"passed"}',clock_timestamp()) recorded;
create temp table fresh_decision as select * from public.record_pr_verification_result((select id from fresh_decision_observation),'ready','[]');
select ok(not (select is_current from public.session_pr_verification_currentness where id=(select id from fresh_decision)),'new decision cannot extend expired GitHub source evidence');
grant select on code_fixture to authenticated,service_role;
set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';
select is((select count(*) from public.session_pr_refresh_queue),1::bigint,'members can inspect their workspace refresh state');
select is(pg_temp.pr_failure_state($$select public.claim_github_pr_refresh()$$),'42501','browser clients cannot claim collection work');
select is(pg_temp.pr_failure_state($$select public.enqueue_session_pr_refresh('b1b2c3d4-0001-4000-8000-000000000001',(select session_id from code_fixture))$$),'42501','manual refresh requires an authorized server endpoint');
select is(pg_temp.pr_failure_state($$update public.session_pr_refresh_queue set status='current'$$),'42501','browser cannot forge successful collection');
reset role;
insert into auth.users(id,email) values('50600000-0000-4000-8000-000000000001','refresh-outsider@example.test');
insert into public.workspaces(id,name,slug) values('50600000-0000-4000-8000-000000000002','Other refresh workspace','pr-refresh-other');
insert into public.workspace_members(workspace_id,user_id,kind,role,is_active) values('50600000-0000-4000-8000-000000000002','50600000-0000-4000-8000-000000000001','human','owner',true);
set local role authenticated;
set local request.jwt.claim.sub='50600000-0000-4000-8000-000000000001';
select is((select count(*) from public.session_pr_refresh_queue),0::bigint,'foreign workspace member cannot read refresh state');
reset role;
set local role anon;
select is(pg_temp.pr_failure_state($$select * from public.session_pr_refresh_queue$$),'42501','anonymous clients cannot read queue state');
select is(pg_temp.pr_failure_state($$select public.enqueue_github_pr_refresh_event(1,2,'anon',array[505])$$),'42501','anonymous clients cannot enqueue signed events');
reset role;
set local role service_role;
select is(pg_temp.pr_failure_state($$update public.session_pr_refresh_queue set status='current'$$),'42501','service clients mutate queue only through fenced RPCs');
reset role;
select * from finish();
rollback;
