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
create function pg_temp.verified_refresh_fixture(fixture_number integer)
returns uuid language plpgsql as $$
declare fixture_session_id uuid; operation public.session_pr_operations; receipt uuid; claim jsonb;
  github public.session_pr_verification_observations; ready public.session_pr_verification_observations;
begin
  fixture_session_id:=pg_temp.pr_fixture('Bounded GitHub fanout '||fixture_number::text);
  perform public.claim_session_pr_sync(fixture_session_id);
  select o.* into strict operation from public.session_pr_operations o where o.session_id=fixture_session_id and o.status='claimed';
  receipt:=public.begin_session_pr_sync_observation(operation.id,operation.claim_id,60000+fixture_number,
    'https://github.com/'||(select repository_full_name from public.session_pr_epochs where id=operation.epoch_id)||'/pull/'||(60000+fixture_number)::text);
  if not public.finish_session_pr_sync(operation.id,operation.claim_id,operation.desired_sha,operation.desired_fence_sha,
    60000+fixture_number,'https://github.com/'||(select repository_full_name from public.session_pr_epochs where id=operation.epoch_id)||'/pull/'||(60000+fixture_number)::text,
    'open',false,operation.desired_sha,clock_timestamp(),receipt) then raise exception 'Fixture PR synchronization failed'; end if;
  perform public.enqueue_session_pr_refresh('b1b2c3d4-0001-4000-8000-000000000001',fixture_session_id);
  claim:=public.claim_github_pr_refresh('b1b2c3d4-0001-4000-8000-000000000001');
  if claim->>'session_id' is distinct from fixture_session_id::text then raise exception 'Unexpected fixture claim'; end if;
  if not public.finish_github_pr_refresh(fixture_session_id,(claim->>'claim_token')::uuid,repeat('b',40),repeat('a',40),'{"githubAccess":"available"}') then
    raise exception 'Fixture collection failed'; end if;
  select o.* into strict github from public.session_pr_verification_observations o
    join public.session_pr_refresh_queue q on q.last_observation_id=o.id where q.session_id=fixture_session_id;
  ready:=public.record_pr_verification_observation(github.workspace_id,fixture_session_id,github.policy_revision_id,
    github.repository_id,github.repository_full_name,github.pr_epoch_id,github.pr_number,github.head_sha,github.base_sha,
    github.checkpoint_run_id,github.artifact_review_revision,'readiness',
    '{"githubAccess":"available","checks":"passed","reviews":"passed","evidence":"passed","threads":"passed"}',clock_timestamp());
  perform public.record_pr_verification_result(ready.id,'ready','[]');
  return fixture_session_id;
end;
$$;
-- Every row reaches accepted checkpoints and canonical PR synchronization using
-- the public protocol. IDs are sorted only after creation to make the archive
-- starvation regression deterministic, without fabricating lineage rows.
create temp table fanout_fixtures as select pg_temp.verified_refresh_fixture(n) as session_id from generate_series(1,202) n;
create temp table archived_fanout as select session_id from fanout_fixtures order by session_id limit 100;
update public.sessions set archived_at=clock_timestamp() where id in(select session_id from archived_fanout);
create temp table live_fanout as select session_id from fanout_fixtures where session_id not in(select session_id from archived_fanout);
select is((select count(*) from public.session_pr_verification_currentness where session_id in(select session_id from live_fanout) and is_current),102::bigint,
  'all live fixtures start with current exact verification');
-- Include one unqueued session outside the first hundred. Its canonical epoch
-- and immutable verification history remain intact and must be rediscovered.
delete from public.session_pr_refresh_queue where session_id=(select max(session_id::text)::uuid from live_fanout);
create temp table fanout_event_scope as select i.installation_id,r.repo_id from public.github_repositories r
 join public.github_installations i on i.id=r.github_installation_id where r.id='12b2c3d4-0001-4000-8000-000000000001';
select is(public.enqueue_github_pr_refresh_event((select installation_id from fanout_event_scope),(select repo_id from fanout_event_scope),'overflow-base-event',null,null,'main'),100,
  'one signed event queues a bounded hundred eligible live sessions despite a hundred earlier archived sessions');
select is((select count(*) from public.session_pr_refresh_queue where status='pending' and session_id in(select session_id from archived_fanout)),0::bigint,
  'archived sessions consume no event enqueue slots');
select is((select revision from public.github_pr_refresh_watermarks),1::bigint,'overflow persists one durable repository continuation revision');
select is((select count(*) from public.session_pr_verification_currentness where session_id in(select session_id from live_fanout) and is_current),0::bigint,
  'overflow immediately invalidates every live readiness result including the unprocessed remainder');
select is((select count(*) from public.session_pr_refresh_queue where status='current' and session_id in(select session_id from live_fanout)),1::bigint,
  'one previously current session remains outside the first event batch');
select is(public.enqueue_github_pr_refresh_event((select installation_id from fanout_event_scope),(select repo_id from fanout_event_scope),'overflow-base-event',null,null,'main'),0,
  'redelivery does not repeat the batch or advance the continuation revision');
select is((select revision from public.github_pr_refresh_watermarks),1::bigint,'duplicate event cannot continually fence unrelated collection');
select is(public.enqueue_due_github_pr_refreshes(20),2,'bounded periodic reconciliation recovers current and missing queue remainder without another event');
select is((select count(*) from public.session_pr_refresh_queue where status='pending' and session_id in(select session_id from live_fanout)),102::bigint,
  'every eligible session eventually has durable refresh work');
select is(public.enqueue_due_github_pr_refreshes(20),0,'continuation converges without re-enqueueing already pending sessions');
update public.session_pr_refresh_queue set next_attempt_at=clock_timestamp()+interval '1 hour'
 where session_id in(select session_id from live_fanout) and session_id<>(select max(session_id::text)::uuid from live_fanout);
create temp table overflow_claim as select public.claim_github_pr_refresh() as value;
select is((select (value->>'github_event_revision')::bigint from overflow_claim),1::bigint,'next collection pins the current continuation revision');
select is((select (value->>'session_id')::uuid from overflow_claim),(select max(session_id::text)::uuid from live_fanout),'regression claims a remainder session outside the next direct batch');
-- A later overflow event arriving during network I/O must fence its receipt.
select is(public.enqueue_github_pr_refresh_event((select installation_id from fanout_event_scope),(select repo_id from fanout_event_scope),'overflow-next-event',null,null,'main'),100,
  'next large event remains bounded');
select is((select requested_generation from public.session_pr_refresh_queue where session_id=(select (value->>'session_id')::uuid from overflow_claim)),1::bigint,
  'overflow remainder was not dirtied through an ordinary row-generation enqueue');
select ok(not public.finish_github_pr_refresh((select (value->>'session_id')::uuid from overflow_claim),
  (select (value->>'claim_token')::uuid from overflow_claim),repeat('b',40),repeat('a',40),'{"githubAccess":"available"}'),
  'watermark drift fences an in-flight receipt even beyond ordinary row generations');
set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';
select is((select count(*) from public.github_pr_refresh_watermarks),1::bigint,'workspace members can inspect their repository watermark through RLS');
select is(pg_temp.pr_failure_state($$update public.github_pr_refresh_watermarks set revision=999$$),'42501','browser cannot manufacture continuation revisions');
set local request.jwt.claim.sub='50600000-0000-4000-8000-000000009999';
select is((select count(*) from public.github_pr_refresh_watermarks),0::bigint,'nonmembers cannot read another workspace repository continuation');
reset role;
set local role service_role;
select is(pg_temp.pr_failure_state($$update public.github_pr_refresh_watermarks set revision=999$$),'42501','privileged clients advance watermarks only through scoped event RPC');
reset role;
select * from finish();
rollback;
