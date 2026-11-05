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
create function pg_temp.pr_revision(target_session uuid,output_sha text)
returns uuid language plpgsql as $$
declare owner public.sessions; queued record; started uuid;
begin
  select * into strict owner from public.sessions where id=target_session;
  select * into strict queued from public.reject_session_stage(owner.id,owner.workspace_id,owner.current_artifact_version,
    'Revise the accepted code','codex','gpt-5.5',owner.current_stage_id,owner.current_artifact_id,'project',
    'c1b2c3d4-0001-4000-8000-000000000001');
  started:=pg_temp.pr_start(queued.job_id);
  return pg_temp.pr_publish(queued.job_id,started,output_sha);
end;
$$;
create function pg_temp.pr_claim(target_session uuid)
returns public.session_pr_operations language plpgsql as $$
declare claim uuid; packet public.session_pr_operations;
begin
  claim:=public.claim_session_pr_sync(target_session);
  if claim is null then raise exception 'Expected canonical synchronization claim'; end if;
  select * into strict packet from public.session_pr_operations where claim_id=claim;
  return packet;
end;
$$;
create function pg_temp.pr_url(target_epoch uuid,number integer)
returns text language sql as $$
  select 'https://github.com/'||repository_full_name||'/pull/'||number::text from public.session_pr_epochs where id=target_epoch;
$$;
create function pg_temp.pr_finish(target_operation uuid,captured_claim uuid,number integer,pr_state text default 'open')
returns boolean language plpgsql as $$
declare observation uuid; packet public.session_pr_operations;
begin
  select * into strict packet from public.session_pr_operations where id=target_operation;
  packet.claim_id:=captured_claim;
  observation:=packet.receipt_observation_id;
  if observation is null then
    observation:=public.begin_session_pr_sync_observation(packet.id,packet.claim_id,number,pg_temp.pr_url(packet.epoch_id,number));
  end if;
  return public.finish_session_pr_sync(packet.id,packet.claim_id,
    case when pr_state='open' then packet.desired_sha end,
    case when pr_state='open' then packet.desired_fence_sha end,
    number,pg_temp.pr_url(packet.epoch_id,number),pr_state,true,
    case when pr_state='open' then packet.desired_sha end,
    '2026-11-05T00:00:00Z'::timestamptz+make_interval(secs=>packet.target_generation::integer*10),observation);
end;
$$;
create function pg_temp.pr_packet(packet anyelement)
returns jsonb language sql immutable as $$
  select jsonb_build_object('id',to_jsonb(packet)->'id','epoch_id',to_jsonb(packet)->'epoch_id','checkpoint_run_id',to_jsonb(packet)->'checkpoint_run_id',
    'target_generation',to_jsonb(packet)->'target_generation','desired_sha',to_jsonb(packet)->'desired_sha','source_ref',to_jsonb(packet)->'source_ref',
    'expected_head_sha',to_jsonb(packet)->'expected_head_sha','expected_fence_sha',to_jsonb(packet)->'expected_fence_sha',
    'desired_fence_sha',to_jsonb(packet)->'desired_fence_sha','fence_commit_body',to_jsonb(packet)->'fence_commit_body');
$$;

create temp table no_code as select pg_temp.pr_fixture('No-code canonical stage',repeat('a',40)) as session_id;
select ok((select sync.status='not_needed' and sync.current_epoch_id is null
  and sync.desired_checkpoint_run_id=head.checkpoint_run_id
  from no_code fixture join public.session_pr_sync sync on sync.session_id=fixture.session_id
  join public.session_git_heads head on head.session_id=sync.session_id),
  'initial no-code adoption records desired provenance without creating a canonical PR epoch');
select is((select count(*) from public.session_pr_operations where session_id=(select session_id from no_code)),0::bigint,
  'text-only initial output schedules no empty PR operation');
select is(public.claim_session_pr_sync((select session_id from no_code)),null::uuid,
  'text-only initial output cannot be claimed for GitHub publication');

create temp table canonical as select pg_temp.pr_fixture('One canonical session PR') as session_id;
select ok((select sync.status='pending' and sync.current_epoch_id is null
  and sync.desired_checkpoint_run_id=head.checkpoint_run_id
  from canonical fixture join public.session_pr_sync sync on sync.session_id=fixture.session_id
  join public.session_git_heads head on head.session_id=sync.session_id),
  'accepted code atomically creates one durable canonical synchronization target');
select is(public.claim_session_source_delivery(),null::uuid,
  'legacy attempt-PR outbox cannot publish sessions owned by canonical synchronization');
create temp table first_operation as select claimed.* from pg_temp.pr_claim((select session_id from canonical)) claimed;
select ok((select epoch.epoch_number=1 and epoch.pr_number is null and not epoch.create_attempted
  from first_operation operation join public.session_pr_epochs epoch on epoch.id=operation.epoch_id),
  'first publisher allocates one canonical epoch before remote I/O');
select ok((select operation.desired_sha=repeat('b',40) and operation.source_ref=checkpoint.output_ref
  and operation.checkpoint_run_id=sync.desired_checkpoint_run_id and operation.target_generation=sync.target_generation
  and operation.expected_head_sha is null and operation.expected_fence_sha is null
  from first_operation operation join public.session_pr_sync sync on sync.session_id=operation.session_id
  join public.session_git_checkpoints checkpoint on checkpoint.run_id=operation.checkpoint_run_id),
  'first operation freezes exact accepted code plus absent expected canonical and fence refs');
select ok((select operation.fence_commit_body='tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904'||E'\n'
  ||'author Wallie <noreply@wallie.dev> 946684800 +0000'||E'\n'
  ||'committer Wallie <noreply@wallie.dev> 946684800 +0000'||E'\n\n'
  ||'Wallie canonical publication '||operation.id::text||E'\n'
  and operation.desired_fence_sha=encode(extensions.digest(
    convert_to('commit '||octet_length(operation.fence_commit_body)::text,'UTF8')||decode('00','hex')
    ||convert_to(operation.fence_commit_body,'UTF8'),'sha1'),'hex')
  from first_operation operation),
  'operation authorizes a deterministic Git fence commit bound to its immutable identity');
select is((select public.assert_session_pr_sync_claim(id,claim_id) from first_operation),true,
  'current operation lease can be checked before remote work');
select is((select public.assert_session_pr_sync_claim(id,gen_random_uuid()) from first_operation),false,
  'foreign claim token cannot authorize publication');
select is(pg_temp.pr_failure_state($$update public.session_pr_operations set desired_sha=repeat('c',40)
  where id=(select id from first_operation)$$),'23514','even privileged SQL cannot retarget an authorized operation');
select is(pg_temp.pr_failure_state($$update public.session_pr_operations set fence_commit_body=fence_commit_body||'extra'
  where id=(select id from first_operation)$$),'23514','operation Git fence body cannot change across retries');
select is((select public.arm_session_pr_creation(epoch_id,id,claim_id) from first_operation),true,
  'first current operation can durably arm one ambiguous PR creation request');
select is((select public.arm_session_pr_creation(epoch_id,id,claim_id) from first_operation),false,
  'repeated arming requires GET reconciliation instead of another POST');
create temp table first_snapshot as select public.begin_session_pr_sync_observation(id,claim_id,101,
  pg_temp.pr_url(epoch_id,101)) as id from first_operation;
select is(pg_temp.pr_failure_state($$select public.finish_session_pr_sync(id,claim_id,repeat('c',40),desired_fence_sha,
  101,pg_temp.pr_url(epoch_id,101),'open',true,desired_sha,'2026-11-05T00:00:10Z',(select id from first_snapshot)) from first_operation$$),'23514',
  'a receipt cannot acknowledge a different remote canonical head');
select is(pg_temp.pr_failure_state($$select public.finish_session_pr_sync(id,claim_id,desired_sha,repeat('e',40),
  101,pg_temp.pr_url(epoch_id,101),'open',true,desired_sha,'2026-11-05T00:00:10Z',(select id from first_snapshot)) from first_operation$$),'23514',
  'a receipt cannot acknowledge an unauthorized remote fence');
select is((select status from public.session_pr_sync where session_id=(select session_id from canonical)),'pending',
  'rejected proof never surfaces false synchronization');
select is((select pg_temp.pr_finish(operation.id,operation.claim_id,101) from first_operation operation),true,
  'exact dual-ref and open PR proof completes the initial operation');
select ok((select sync.status='synced' and sync.observed_head_sha=operation.desired_sha
  and sync.observed_fence_sha=operation.desired_fence_sha and sync.observed_pr_head_sha=operation.desired_sha
  and epoch.pr_number=101 and epoch.pr_state='open' and epoch.acknowledged_head_sha=operation.desired_sha
  and epoch.acknowledged_fence_sha=operation.desired_fence_sha
  from first_operation operation join public.session_pr_sync sync on sync.session_id=operation.session_id
  join public.session_pr_epochs epoch on epoch.id=operation.epoch_id),
  'synchronized metadata exposes matching intended code, observed refs and open PR head');
select is((select count(*) from public.session_pull_requests where session_id=(select session_id from canonical)),1::bigint,
  'first successful receipt records one canonical PR rather than an attempt PR');

create temp table second_target as select pg_temp.pr_revision((select session_id from canonical),repeat('c',40)) as run_id;
create temp table second_operation as select claimed.* from pg_temp.pr_claim((select session_id from canonical)) claimed;
select ok((select next.id<>prior.id and next.epoch_id=prior.epoch_id and next.desired_sha=repeat('c',40)
  and next.checkpoint_run_id=target.run_id and next.expected_head_sha=prior.desired_sha
  and next.expected_fence_sha=prior.desired_fence_sha
  and next.fence_commit_body like '%'||E'\nparent '||prior.desired_fence_sha||E'\n%'
  from second_operation next cross join first_operation prior cross join second_target target),
  'revision reuses the canonical epoch and compares both acknowledged refs');
select is((select public.arm_session_pr_creation(epoch_id,id,claim_id) from second_operation),false,
  'known canonical PR identity never permits a duplicate creation POST');
create temp table newest_target as select pg_temp.pr_revision((select session_id from canonical),repeat('d',40)) as run_id;
select is((select pg_temp.pr_packet(current) from public.session_pr_operations current where id=(select id from second_operation)),
  (select pg_temp.pr_packet(saved) from second_operation saved),
  'new accepted code cannot rewrite an in-flight operation packet');
select is(public.claim_session_pr_sync((select session_id from canonical)),null::uuid,
  'newest target cannot create a competing operation while the earlier lease is live');
select is((select pg_temp.pr_finish(operation.id,operation.claim_id,101) from second_operation operation),true,
  'an already authorized older operation can reconcile its exact successful remote result');
select ok((select sync.status='pending' and sync.desired_checkpoint_run_id=target.run_id
  and sync.observed_head_sha=repeat('c',40) and sync.observed_pr_head_sha=repeat('c',40)
  from public.session_pr_sync sync cross join newest_target target where sync.session_id=(select session_id from canonical)),
  'reconciled older receipt never marks a newer desired checkpoint synchronized');
create temp table newest_operation as select claimed.* from pg_temp.pr_claim((select session_id from canonical)) claimed;
select ok((select latest.desired_sha=repeat('d',40) and latest.expected_head_sha=prior.desired_sha
  and latest.expected_fence_sha=prior.desired_fence_sha
  from newest_operation latest cross join second_operation prior),
  'next promotion starts from the last proven owned head and fence rather than an external guess');
select is((select public.fail_session_pr_sync(id,claim_id,'pr_api_failed') from newest_operation),true,
  'PR API failure remains a durable retry after code/artifact adoption');
select is((select public.assert_session_pr_sync_claim(id,claim_id) from newest_operation),false,
  'released lease cannot publish or acknowledge a late response');
update public.session_pr_operations set next_attempt_at=clock_timestamp()-interval '1 second'
where id=(select id from newest_operation);
update public.session_pr_sync set next_attempt_at=clock_timestamp()-interval '1 second'
where session_id=(select session_id from canonical);
create temp table newest_retry as select claimed.* from pg_temp.pr_claim((select session_id from canonical)) claimed;
select ok((select retried.id=original.id and retried.claim_id<>original.claim_id
  and pg_temp.pr_packet(retried)=pg_temp.pr_packet(original)
  from newest_retry retried cross join newest_operation original),
  'retry replaces the lease while preserving the identical authorized operation');
select is((select pg_temp.pr_finish(operation.id,operation.claim_id,101) from newest_operation operation),false,
  'stale released claim cannot acknowledge even otherwise correct proof');
select is((select pg_temp.pr_finish(operation.id,operation.claim_id,101) from newest_retry operation),true,
  'new lease reconciles the same exact operation without duplicate PR creation');
select is((select pg_temp.pr_finish(operation.id,operation.claim_id,101) from first_operation operation),true,
  'lost successful response can be retried idempotently after newer publication');
select ok((select sync.status='synced' and sync.observed_head_sha=repeat('d',40)
  and sync.desired_checkpoint_run_id=target.run_id and epoch.pr_number=101
  and epoch.acknowledged_head_sha=repeat('d',40)
  from public.session_pr_sync sync join public.session_pr_epochs epoch on epoch.id=sync.current_epoch_id
  cross join newest_target target where sync.session_id=(select session_id from canonical)),
  'old idempotent receipt does not rewind the currently synchronized head or PR identity');

create temp table text_target as select pg_temp.pr_revision((select session_id from canonical),repeat('d',40)) as run_id;
create temp table text_operation as select claimed.* from pg_temp.pr_claim((select session_id from canonical)) claimed;
select ok((select operation.epoch_id=prior.epoch_id and operation.desired_sha=repeat('d',40)
  and operation.checkpoint_run_id=target.run_id and checkpoint.output_kind='no-code'
  and checkpoint.output_ref is null and operation.source_ref=input.input_ref
  from text_operation operation cross join first_operation prior cross join text_target target
  join public.session_git_checkpoints checkpoint on checkpoint.run_id=target.run_id
  join public.session_job_git_inputs input on input.job_id=checkpoint.job_id),
  'post-code text-only checkpoint keeps the canonical epoch and inherits its retained source ref');
select is((select pg_temp.pr_finish(operation.id,operation.claim_id,101) from text_operation operation),true,
  'text-only target can reconcile the existing open PR without an empty new PR');
select is((select count(*) from public.session_pull_requests where session_id=(select session_id from canonical)),1::bigint,
  'multiple code and text-only revisions keep exactly one canonical PR');

create temp table coalesced as select pg_temp.pr_fixture('Coalesce before first publisher') as session_id;
create temp table coalesced_target as select pg_temp.pr_revision((select session_id from coalesced),repeat('c',40)) as run_id;
create temp table coalesced_operation as select claimed.* from pg_temp.pr_claim((select session_id from coalesced)) claimed;
select ok((select operation.checkpoint_run_id=target.run_id and operation.desired_sha=repeat('c',40)
  and operation.expected_head_sha is null and operation.expected_fence_sha is null
  from coalesced_operation operation cross join coalesced_target target),
  'unclaimed desired checkpoints coalesce to the newest accepted code without a needless intermediate PR');
select is((select count(*) from public.session_pr_operations where session_id=(select session_id from coalesced)),1::bigint,
  'coalescing allocates only one authorized operation');

create temp table crash_session as select pg_temp.pr_fixture('Crash after remote publication') as session_id;
create temp table crash_original as select claimed.* from pg_temp.pr_claim((select session_id from crash_session)) claimed;
select is((select public.arm_session_pr_creation(epoch_id,id,claim_id) from crash_original),true,
  'crash fixture durably records possible PR POST before losing its worker');
update public.session_pr_operations set lease_expires_at=clock_timestamp()-interval '1 second'
where id=(select id from crash_original);
create temp table crash_recovery as select claimed.* from pg_temp.pr_claim((select session_id from crash_session)) claimed;
select ok((select recovered.id=original.id and recovered.claim_id<>original.claim_id
  and pg_temp.pr_packet(recovered)=pg_temp.pr_packet(original)
  from crash_recovery recovered cross join crash_original original),
  'lease recovery uses the exact remote packet that may already have committed');
select is((select public.arm_session_pr_creation(epoch_id,id,claim_id) from crash_recovery),false,
  'ambiguous prior PR creation can only be reconciled, never blindly posted twice');
select is((select pg_temp.pr_finish(operation.id,operation.claim_id,102) from crash_original operation),false,
  'expired worker cannot record a late receipt');
select is((select pg_temp.pr_finish(operation.id,operation.claim_id,102) from crash_recovery operation),true,
  'reconciled exact remote refs and discovered PR complete the recovered operation');

create temp table safe_post_session as select pg_temp.pr_fixture('Known rejected PR creation') as session_id;
create temp table safe_post_first as select claimed.* from pg_temp.pr_claim((select session_id from safe_post_session)) claimed;
select is((select public.arm_session_pr_creation(epoch_id,id,claim_id) from safe_post_first),true,'first POST can be armed');
select is((select public.fail_session_pr_sync(id,claim_id,'publication_failed',false,true) from safe_post_first),true,
  'a generic API failure can release the lease but cannot assert creation was rejected');
select ok((select create_attempted from public.session_pr_epochs where id=(select epoch_id from safe_post_first)),
  'unproven retry-safe flag does not clear the ambiguous creation marker');
update public.session_pr_operations set next_attempt_at=clock_timestamp()-interval '1 second' where id=(select id from safe_post_first);
update public.session_pr_sync set next_attempt_at=clock_timestamp()-interval '1 second' where session_id=(select session_id from safe_post_session);
create temp table safe_post_retry as select claimed.* from pg_temp.pr_claim((select session_id from safe_post_session)) claimed;
select is((select public.fail_session_pr_sync(id,claim_id,'pr_creation_rejected',false,true) from safe_post_retry),true,
  'explicit known POST rejection can permit a safe creation retry before any PR is pinned');
select ok(not (select create_attempted from public.session_pr_epochs where id=(select epoch_id from safe_post_first)),
  'known rejected POST clears only the unbound creation marker');

-- PR observations can invalidate synchronization; they cannot prove Git refs.
create temp table conflict_session as select pg_temp.pr_fixture('External canonical head conflict') as session_id;
create temp table conflict_operation as select claimed.* from pg_temp.pr_claim((select session_id from conflict_session)) claimed;
select pg_temp.pr_finish(operation.id,operation.claim_id,103) from conflict_operation operation;
create temp table conflict_observation as select public.begin_session_pr_observation(epoch.workspace_id,epoch.repository_id,
  epoch.branch_name,epoch.pr_number) as id from public.session_pr_epochs epoch where epoch.id=(select epoch_id from conflict_operation);
select is((select public.finish_session_pr_observation(id,pg_temp.pr_url((select epoch_id from conflict_operation),103),
  'open',true,repeat('e',40),'2026-11-05T01:00:00Z') from conflict_observation),true,
  'trusted observation records an unexpected external PR head');
select ok((select status<>'synced' and observed_pr_head_sha=repeat('e',40)
  from public.session_pr_sync where session_id=(select session_id from conflict_session)),
  'external PR head mismatch is exposed as unsynchronized rather than false readiness');
select is((select acknowledged_head_sha from public.session_pr_epochs where id=(select epoch_id from conflict_operation)),repeat('b',40),
  'external observation does not replace the last acknowledged owned Git head');

create temp table mismatch_session as select pg_temp.pr_fixture('Observed PR does not match published head') as session_id;
create temp table mismatch_operation as select claimed.* from pg_temp.pr_claim((select session_id from mismatch_session)) claimed;
create temp table mismatch_snapshot as select public.begin_session_pr_sync_observation(id,claim_id,105,
  pg_temp.pr_url(epoch_id,105)) as id from mismatch_operation;
select is((select public.finish_session_pr_sync(id,claim_id,desired_sha,desired_fence_sha,105,
  pg_temp.pr_url(epoch_id,105),'open',true,repeat('e',40),'2026-11-05T00:00:10Z',
  (select id from mismatch_snapshot)) from mismatch_operation),true,
  'valid Git receipt can retain a conflicting PR snapshot for diagnosis');
select ok((select sync.status='conflict' and sync.observed_head_sha=repeat('b',40) and sync.observed_pr_head_sha=repeat('e',40)
  from public.session_pr_sync sync where sync.session_id=(select session_id from mismatch_session)),
  'matching remote refs alone cannot label a mismatched open PR synchronized');

create temp table observed_session as select pg_temp.pr_fixture('Publisher and webhook causal ordering') as session_id;
create temp table observed_first as select claimed.* from pg_temp.pr_claim((select session_id from observed_session)) claimed;
select pg_temp.pr_finish(operation.id,operation.claim_id,106) from observed_first operation;
select pg_temp.pr_revision((select session_id from observed_session),repeat('c',40));
create temp table observed_operation as select claimed.* from pg_temp.pr_claim((select session_id from observed_session)) claimed;
create temp table publisher_snapshot as select public.begin_session_pr_sync_observation(id,claim_id,106,
  pg_temp.pr_url(epoch_id,106)) as id from observed_operation;
create temp table webhook_snapshot as select public.begin_session_pr_observation(epoch.workspace_id,epoch.repository_id,
  epoch.branch_name,epoch.pr_number) as id from public.session_pr_epochs epoch where epoch.id=(select epoch_id from observed_operation);
select is((select public.finish_session_pr_sync(operation.id,operation.claim_id,operation.desired_sha,operation.desired_fence_sha,
  106,pg_temp.pr_url(operation.epoch_id,106),'open',true,operation.desired_sha,'2026-11-05T00:00:10Z',snapshot.id)
  from observed_operation operation cross join publisher_snapshot snapshot),false,
  'publisher final GET cannot finish after a newer webhook read reserves the shared observation token');
select ok((select epoch.observation_id=snapshot.id and operation.receipted_at is null and operation.status='claimed'
  and epoch.acknowledged_head_sha=repeat('b',40)
  from public.session_pr_epochs epoch cross join webhook_snapshot snapshot
  join public.session_pr_operations operation on operation.id=(select id from observed_operation)
  where epoch.id=operation.epoch_id),
  'rejected publisher receipt preserves the pending observer and acknowledged owned head');
select is((select public.finish_session_pr_observation(id,pg_temp.pr_url((select epoch_id from observed_operation),106),
  'open',true,repeat('b',40),'2026-11-05T00:00:10Z') from webhook_snapshot),true,
  'newer webhook read can finish without being erased by the old publisher');
select is((select public.finish_session_pr_sync(operation.id,operation.claim_id,operation.desired_sha,operation.desired_fence_sha,
  106,pg_temp.pr_url(operation.epoch_id,106),'open',true,operation.desired_sha,'2026-11-05T00:00:10Z',snapshot.id)
  from observed_operation operation cross join publisher_snapshot snapshot),false,
  'clearing a newer completed token does not revive the stale publisher token');
create temp table publisher_fresh_snapshot as select public.begin_session_pr_sync_observation(id,claim_id,106,
  pg_temp.pr_url(epoch_id,106)) as id from observed_operation;
select is((select public.finish_session_pr_sync(operation.id,operation.claim_id,operation.desired_sha,operation.desired_fence_sha,
  106,pg_temp.pr_url(operation.epoch_id,106),'open',true,operation.desired_sha,'2026-11-05T00:00:10Z',snapshot.id)
  from observed_operation operation cross join publisher_fresh_snapshot snapshot),true,
  'fresh publisher token permits a legitimate same-second new PR head after causal re-observation');
select ok((select sync.status='synced' and sync.observed_head_sha=repeat('c',40) and sync.observed_pr_head_sha=repeat('c',40)
  from public.session_pr_sync sync where sync.session_id=(select session_id from observed_session)),
  'only the causally fresh final GET can synchronize the accepted target');

create temp table legacy_open as select pg_temp.pr_fixture('Legacy open PR cutover') as session_id;
insert into public.session_pull_requests(session_id,workspace_id,github_repository_id,branch_name,pull_request_number,
  pull_request_url,pull_request_state,is_draft)
select fixture.session_id,'b1b2c3d4-0001-4000-8000-000000000001','12b2c3d4-0001-4000-8000-000000000001',
  'wallie/legacy-open-'||fixture.session_id::text,201,'https://github.com/'||repository.full_name||'/pull/201','open',true
from legacy_open fixture cross join public.github_repositories repository
where repository.id='12b2c3d4-0001-4000-8000-000000000001';
select is(public.claim_session_pr_sync((select session_id from legacy_open)),null::uuid,
  'canonical publisher cannot silently create a duplicate beside an existing open legacy PR');
select ok((select sync.status='error' and sync.last_error_code='legacy_pr_cutover_required' and sync.current_epoch_id is null
  and sync.next_attempt_at>clock_timestamp()
  and link.pull_request_state='open' and link.pull_request_number=201
  from legacy_open fixture join public.session_pr_sync sync on sync.session_id=fixture.session_id
  join public.session_pull_requests link on link.session_id=fixture.session_id),
  'legacy open cutover remains explicit and preserves existing PR metadata');
select is((select count(*) from public.session_pr_operations where session_id=(select session_id from legacy_open)),0::bigint,
  'blocked legacy cutover authorizes no Git packet');
update public.session_pull_requests set pull_request_state='closed'
where session_id=(select session_id from legacy_open);
update public.session_pr_sync set next_attempt_at=clock_timestamp()-interval '1 second'
where session_id=(select session_id from legacy_open);
create temp table legacy_reconciled as select claimed.* from pg_temp.pr_claim((select session_id from legacy_open)) claimed;
select ok((select operation.id is not null and operation.status='claimed' and sync.current_epoch_id=operation.epoch_id
  and sync.status in ('pending','error') and public.assert_session_pr_sync_claim(operation.id,operation.claim_id)
  and link.pull_request_state='closed' and link.pull_request_number=201
  from legacy_reconciled operation join public.session_pr_sync sync on sync.session_id=operation.session_id
  join public.session_pull_requests link on link.session_id=operation.session_id),
  'backoff retry enrolls after the legacy open PR is explicitly reconciled closed');

create temp table legacy_uncertain as select pg_temp.pr_fixture('Ambiguous legacy delivery cutover') as session_id;
update public.session_source_deliveries set status='claimed',delivery_attempt_count=1,claim_id=gen_random_uuid(),
  lease_expires_at=clock_timestamp()+interval '1 minute'
where session_id=(select session_id from legacy_uncertain);
select is(public.claim_session_pr_sync((select session_id from legacy_uncertain)),null::uuid,
  'live legacy publication lease quiesces before canonical epoch creation');
update public.session_source_deliveries set lease_expires_at=clock_timestamp()-interval '1 second'
where session_id=(select session_id from legacy_uncertain);
select is(public.claim_session_pr_sync((select session_id from legacy_uncertain)),null::uuid,
  'expired but attempted legacy delivery is still ambiguous and cannot authorize a duplicate canonical PR');
select ok((select status='error' and last_error_code='legacy_pr_cutover_required' and current_epoch_id is null
  and next_attempt_at>clock_timestamp()
  from public.session_pr_sync where session_id=(select session_id from legacy_uncertain)),
  'uncertain legacy POST requires cutover reconciliation rather than a lease-only guess');

create temp table legacy_closed as select pg_temp.pr_fixture('Closed legacy history cutover') as session_id;
update public.session_source_deliveries set status='delivered',delivery_attempt_count=1,delivered_at=clock_timestamp()
where session_id=(select session_id from legacy_closed);
insert into public.session_pull_requests(session_id,workspace_id,github_repository_id,branch_name,pull_request_number,
  pull_request_url,pull_request_state,is_draft)
select fixture.session_id,'b1b2c3d4-0001-4000-8000-000000000001','12b2c3d4-0001-4000-8000-000000000001',
  'wallie/legacy-closed-'||fixture.session_id::text,202,'https://github.com/'||repository.full_name||'/pull/202','closed',true
from legacy_closed fixture cross join public.github_repositories repository
where repository.id='12b2c3d4-0001-4000-8000-000000000001';
create temp table legacy_closed_operation as select claimed.* from pg_temp.pr_claim((select session_id from legacy_closed)) claimed;
select ok((select operation.id is not null and epoch.pr_number is null and old.pull_request_state='closed'
  and epoch.branch_name<>old.branch_name
  from legacy_closed_operation operation join public.session_pr_epochs epoch on epoch.id=operation.epoch_id
  join public.session_pull_requests old on old.session_id=operation.session_id),
  'known closed delivered legacy history can enter canonical ownership without reopening the old PR');

create temp table stale_observation as select public.begin_session_pr_observation(epoch.workspace_id,epoch.repository_id,
  epoch.branch_name,epoch.pr_number) as id from public.session_pr_epochs epoch where epoch.id=(select epoch_id from first_operation);
create temp table terminal_observation as select public.begin_session_pr_observation(epoch.workspace_id,epoch.repository_id,
  epoch.branch_name,epoch.pr_number) as id from public.session_pr_epochs epoch where epoch.id=(select epoch_id from first_operation);
select is((select public.finish_session_pr_observation(id,pg_temp.pr_url((select epoch_id from first_operation),101),
  'closed',true,repeat('d',40),'2026-11-05T02:00:00Z') from terminal_observation),true,
  'closed canonical PR observation retires its publication epoch');
select is((select public.finish_session_pr_observation(id,pg_temp.pr_url((select epoch_id from first_operation),101),
  'open',true,repeat('d',40),'2026-11-05T01:00:00Z') from stale_observation),false,
  'delayed open observation cannot reopen a terminal canonical PR');
select is((select status from public.session_pr_sync where session_id=(select session_id from canonical)),'successor_required',
  'closed PR requires an explicit successor instead of silently reopening');
select is(public.claim_session_pr_sync((select session_id from canonical)),null::uuid,
  'terminal epoch cannot schedule another automatic promotion');
create temp table terminal_target as select pg_temp.pr_revision((select session_id from canonical),repeat('e',40)) as run_id;
select ok((select sync.status='successor_required' and sync.current_epoch_id=original.epoch_id
  and sync.desired_checkpoint_run_id=target.run_id and epoch.pr_state='closed'
  from public.session_pr_sync sync cross join first_operation original cross join terminal_target target
  join public.session_pr_epochs epoch on epoch.id=original.epoch_id where sync.session_id=(select session_id from canonical)),
  'new accepted code advances desired provenance while preserving terminal PR ownership');

create temp table successor_request as select gen_random_uuid() as id;
select is(public.authorize_session_pr_successor(
  (select user_id from public.workspace_members where id='c1b2c3d4-0001-4000-8000-000000000001'),
  (select session_id from canonical),gen_random_uuid(),(select id from successor_request)),null::uuid,
  'stale or foreign expected epoch cannot authorize a successor');
select is(pg_temp.pr_failure_state($$select public.authorize_session_pr_successor(gen_random_uuid(),
  (select session_id from canonical),(select epoch_id from first_operation),(select id from successor_request))$$),'42501',
  'foreign user cannot authorize a successor for another tenant');
select is(public.authorize_session_pr_successor(null,
  (select session_id from canonical),(select epoch_id from first_operation),(select id from successor_request)),null::uuid,
  'service identity alone cannot stand in for an active human successor decision');
create temp table successor_epoch as select public.authorize_session_pr_successor(
  (select user_id from public.workspace_members where id='c1b2c3d4-0001-4000-8000-000000000001'),
  (select session_id from canonical),(select epoch_id from first_operation),(select id from successor_request)) as id;
select is(public.authorize_session_pr_successor(
  (select user_id from public.workspace_members where id='c1b2c3d4-0001-4000-8000-000000000001'),
  (select session_id from canonical),(select epoch_id from first_operation),(select id from successor_request)),
  (select id from successor_epoch),'lost successor response returns the same human-authorized epoch');
select ok((select fresh.epoch_number=old.epoch_number+1 and fresh.id<>old.id
  and fresh.branch_name<>old.branch_name and fresh.fence_branch<>old.fence_branch
  and fresh.pr_number is null and not fresh.create_attempted and old.pr_number=101 and old.pr_state='closed'
  and sync.current_epoch_id=fresh.id and sync.status='pending'
  from successor_epoch receipt join public.session_pr_epochs fresh on fresh.id=receipt.id
  cross join first_operation original join public.session_pr_epochs old on old.id=original.epoch_id
  join public.session_pr_sync sync on sync.session_id=fresh.session_id),
  'explicit successor owns new refs and never overwrites or reopens the old closed PR');
create temp table successor_operation as select claimed.* from pg_temp.pr_claim((select session_id from canonical)) claimed;
select ok((select operation.epoch_id=receipt.id and operation.expected_head_sha is null and operation.expected_fence_sha is null
  and operation.desired_sha=repeat('e',40) and operation.checkpoint_run_id=target.run_id
  from successor_operation operation cross join successor_epoch receipt cross join terminal_target target),
  'successor packet targets current accepted code on newly owned absent refs');
select is((select public.arm_session_pr_creation(epoch_id,id,claim_id) from successor_operation),true,
  'explicit successor permits one new PR creation');
select is((select pg_temp.pr_finish(operation.id,operation.claim_id,104) from successor_operation operation),true,
  'new epoch can synchronize a distinct successor PR');
select is((select count(*) from public.session_pr_epochs where session_id=(select session_id from canonical) and pr_state='open'),1::bigint,
  'session has one open canonical epoch while preserving terminal history');
select is((select count(*) from public.session_pull_requests where session_id=(select session_id from canonical)),2::bigint,
  'successor adds one explicit PR and retains the old closed PR association');
select is(pg_temp.pr_failure_state($$select public.authorize_session_pr_successor(
  (select user_id from public.workspace_members where id='c1b2c3d4-0001-4000-8000-000000000001'),
  (select session_id from canonical),(select id from successor_epoch),gen_random_uuid())$$),'55000',
  'open successor epoch cannot be silently superseded');
update public.workspace_members set is_active=false where id='c1b2c3d4-0001-4000-8000-000000000001';
select is(pg_temp.pr_failure_state($$select public.authorize_session_pr_successor(
  (select user_id from public.workspace_members where id='c1b2c3d4-0001-4000-8000-000000000001'),
  (select session_id from canonical),(select epoch_id from first_operation),(select id from successor_request))$$),'42501',
  'retry receipt cannot revive successor authorization after human access is revoked');
update public.workspace_members set is_active=true where id='c1b2c3d4-0001-4000-8000-000000000001';

select ok(has_table_privilege('service_role','public.session_pr_sync','SELECT')
  and has_table_privilege('service_role','public.session_pr_epochs','SELECT')
  and has_table_privilege('service_role','public.session_pr_operations','SELECT')
  and not has_table_privilege('service_role','public.session_pr_operations','UPDATE')
  and not has_table_privilege('service_role','public.session_pr_sync','INSERT')
  and not has_table_privilege('service_role','public.session_pr_epochs','DELETE'),
  'workers read synchronization metadata but mutations remain fenced RPC-only');
select ok(has_table_privilege('authenticated','public.session_pr_sync','SELECT')
  and has_table_privilege('authenticated','public.session_pr_epochs','SELECT')
  and not has_table_privilege('authenticated','public.session_pr_operations','SELECT')
  and not has_table_privilege('authenticated','public.session_pr_sync','UPDATE')
  and not has_table_privilege('authenticated','internal.session_pr_successor_requests','SELECT'),
  'members can inspect readiness metadata without operation or authorization-receipt access');
select ok(not has_function_privilege('authenticated',signature,'EXECUTE'),'browser cannot call '||signature)
from (values
  ('public.claim_session_pr_sync(uuid)'),('public.assert_session_pr_sync_claim(uuid,uuid)'),
  ('public.arm_session_pr_creation(uuid,uuid,uuid)'),
  ('public.finish_session_pr_sync(uuid,uuid,text,text,integer,text,text,boolean,text,timestamptz,uuid)'),
  ('public.begin_session_pr_sync_observation(uuid,uuid,integer,text)'),
  ('public.fail_session_pr_sync(uuid,uuid,text,boolean,boolean)'),
  ('public.begin_session_pr_observation(uuid,uuid,text,integer)'),
  ('public.finish_session_pr_observation(uuid,text,text,boolean,text,timestamptz)'),
  ('public.authorize_session_pr_successor(uuid,uuid,uuid,uuid)')) api(signature);
select set_config('request.jwt.claim.sub',(select user_id::text from public.workspace_members
  where id='c1b2c3d4-0001-4000-8000-000000000001'),true);
set local request.jwt.claim.role='authenticated';
set local role authenticated;
select ok((select count(*) from public.session_pr_sync)>0 and (select count(*) from public.session_pr_epochs)>0,
  'active workspace member can read canonical readiness and epoch metadata');
reset role;
insert into auth.users(id,email) values('49810000-0000-4000-8000-000000000001','canonical-pr-outsider@example.test');
select set_config('request.jwt.claim.sub','49810000-0000-4000-8000-000000000001',true);
set local role authenticated;
select is((select count(*) from public.session_pr_sync),0::bigint,'foreign user cannot read synchronization metadata');
select is((select count(*) from public.session_pr_epochs),0::bigint,'foreign user cannot read session PR epochs');
reset role;
set local request.jwt.claim.role='service_role';

delete from public.workspaces where id='b1b2c3d4-0001-4000-8000-000000000001';
select is((select count(*) from public.session_pr_sync),0::bigint,'workspace deletion cascades synchronization intents');
select is((select count(*) from public.session_pr_epochs),0::bigint,'workspace deletion cascades canonical and terminal epochs');
select is((select count(*) from public.session_pr_operations),0::bigint,'workspace deletion cascades even unresolved operation packets');
select is((select count(*) from internal.session_pr_successor_requests),0::bigint,'workspace deletion removes human successor receipts');

select * from finish();
rollback;
