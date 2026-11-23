begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65210000
\set op651_open_groups true
\set op651_parallel_only false
\set op652_join_evidence true
\ir fixtures/factory_workflow_branch.psql

-- Produce real private branch checkpoints using the merged OP651 intake.
create function pg_temp.retain_join_branch(p_scenario text,p_edge text,p_sha text)
returns uuid language plpgsql as $$
declare slot record; owner record; group_id uuid; retained uuid;
begin
  select * into strict slot from pg_temp.admit_slot(p_scenario,p_edge);
  update public.agent_jobs set status='running',attempt_count=1,
    git_continuity_release_revision=(select revision from public.get_git_continuity_release_state())
  where id=slot.job_id;
  perform pg_temp.adopt_branch_code(slot.child_session_id,slot.job_id,p_sha);
  perform pg_temp.approve_branch(slot.child_session_id);
  select * into strict owner from branch_owner root where root.scenario=p_scenario;
  select groups.group_id into strict group_id from branch_groups groups where groups.scenario=p_scenario;
  select outcome.outcome_id into strict retained from public.record_factory_workflow_branch_outcome(
    owner."sessionId",owner.workspace_id,owner.factory_id,owner.execution_generation,owner.ownership_token,
    group_id,p_edge,slot.job_id,1,slot.run_id) outcome;
  return retained;
end;
$$;

create temp table join_fixtures as
select scenario, pg_temp.retain_join_branch(scenario,'run.required',repeat('b',40)) as required,
  case when scenario<>'partial' then pg_temp.retain_join_branch(scenario,'run.optional',repeat('c',40)) end as optional
from (values ('parallel'),('canceled'),('partial'),('paused'),('bounded')) scenarios(scenario);

create function pg_temp.request_join(p_scenario text,p_request integer,p_actor uuid default pg_temp.op651_id(1))
returns jsonb language sql as $$
  select public.enqueue_factory_workflow_join_for_user(
    root."sessionId",root.workspace_id,root.factory_id,p_actor,root.execution_generation,
    pg_temp.op651_id(p_request),groups.group_id,root.checkpoint_run_id,
    array_remove(array[fixture.required,fixture.optional],null))
  from branch_owner root join branch_groups groups using(scenario)
  join join_fixtures fixture using(scenario) where root.scenario=p_scenario
$$;

create function pg_temp.claim_join(p_receipt jsonb) returns jsonb language plpgsql as $$
declare job public.agent_jobs;
begin
  select * into strict job from public.claim_next_agent_job(false,3,'node');
  if job.id is distinct from (p_receipt->>'jobId')::uuid then raise exception 'Claimed an unrelated job'; end if;
  return public.start_factory_workflow_join_attempt(job.id,job.workspace_id,job.session_id,job.attempt_count,
    clock_timestamp()+interval '10 minutes');
end;
$$;

create function pg_temp.candidate(p_claim jsonb,p_commit text,p_tree text)
returns boolean language sql as $$
  select public.record_active_factory_workflow_join_candidate(
    (p_claim->>'rootSessionId')::uuid,(p_claim->>'workspaceId')::uuid,(p_claim->>'factoryId')::uuid,
    (p_claim->>'generation')::bigint,(p_claim->>'ownershipToken')::uuid,(p_claim->>'joinId')::uuid,
    (p_claim->>'jobId')::uuid,(p_claim->>'runId')::uuid,(p_claim->>'attemptCount')::integer,p_commit,p_tree,
    encode(sha256(convert_to('Joined bundle fixture','UTF8')),'hex'))
$$;

create function pg_temp.record_join_validation(p_run uuid,p_commit text,p_tree text,p_pass boolean)
returns void language plpgsql as $$
begin
  perform public.pin_session_validation_plan(p_run,p_commit,p_tree,
    '{"version":1,"commands":[{"key":"tests","command":"pnpm test","timeoutSeconds":30,"reports":[]}]}');
  perform public.record_session_validation_evidence(p_run,p_commit,p_tree,
    jsonb_build_array(jsonb_build_object('key','tests','command','pnpm test','provenance','harness',
      'status',case when p_pass then 'passed' else 'failed' end,'exitCode',case when p_pass then 0 else 1 end,
      'startedAt',clock_timestamp(),'completedAt',clock_timestamp(),'commitSha',p_commit,'treeSha',p_tree,
      'finalCommitSha',p_commit,'finalTreeSha',p_tree,'reportKeys','[]'::jsonb,'missingRequiredReports','[]'::jsonb)));
end;
$$;

create function pg_temp.prepare_join(p_claim jsonb,p_commit text)
returns boolean language sql as $$
  select public.prepare_session_source_and_checkpoint_publication((p_claim->>'runId')::uuid,pg_temp.op651_id(34),'main',
    repeat('a',40),p_commit,'Integrated output','Parent integration','',
    encode(sha256(convert_to('Joined bundle fixture','UTF8')),'hex'),encode(convert_to('Joined bundle fixture','UTF8'),'base64'),
    (p_claim->>'artifactVersion')::integer,'Joined output with exact validation.',(p_claim->>'deadlineAt')::timestamptz)
$$;

create function pg_temp.settle_join(p_claim jsonb,p_outcome text,p_detail jsonb)
returns text language sql as $$
  select public.settle_factory_workflow_join_blocker(
    (p_claim->>'rootSessionId')::uuid,(p_claim->>'workspaceId')::uuid,(p_claim->>'factoryId')::uuid,
    (p_claim->>'generation')::bigint,(p_claim->>'ownershipToken')::uuid,(p_claim->>'joinId')::uuid,
    (p_claim->>'jobId')::uuid,(p_claim->>'runId')::uuid,(p_claim->>'attemptCount')::integer,p_outcome,p_detail)
$$;

select throws_ok($$select pg_temp.request_join('parallel',221,pg_temp.op651_id(98))$$,
  '42501','Active workspace member required.','only an authorized human factory manager can enqueue a join');
select ok(not has_function_privilege('authenticated',
  'public.enqueue_factory_workflow_join_for_user(uuid,uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid[])','execute'),
  'an authenticated caller cannot impersonate an actor through the trusted RPC');
select throws_ok($$select pg_temp.request_join('partial',222)$$,'PT409',
  'The join requires the terminal branch set and every required successful output.',
  'a still-pending optional slot cannot be silently omitted');

-- Admission can make an explicitly omitted terminal optional blockage durable
-- without inventing a job, run or branch result for the rejected slot.
insert into internal.factory_workflow_branch_slot_dispatches(root_session_id,slot_id,terminal_blocker)
select slot.root_session_id,slot.slot_id,'workflow_child_attempt_limit'
from branch_groups grp join internal.factory_workflow_branch_slots slot on slot.group_id=grp.group_id
where grp.scenario='partial' and not slot.required;
create temp table join_enqueued as select pg_temp.request_join('partial',222) as receipt;
select ok((select receipt ?& array['joinId','occurrenceId','jobId','runId','created']
  and not receipt ? 'ownershipToken' and receipt->>'created'='true'
  and receipt->>'runId'=pg_temp.request_join('partial',222)->>'runId' from join_enqueued),
  'the safe manager receipt replays the original queued run without ownership material');
select ok((select not input.selected and input.outcome_id is null and input.admission_blocker='workflow_child_attempt_limit'
  from join_enqueued pending join internal.factory_workflow_join_inputs input on input.join_id=(receipt->>'joinId')::uuid
  where input.branch_edge_id='run.optional'),'the manifest records exact optional admission failure without a synthetic outcome');

create temp table joined_attempt as select pg_temp.claim_join(receipt) as claim from join_enqueued;
select is((select claim->>'runId' from joined_attempt),(select receipt->>'runId' from join_enqueued),
  'the shared worker starts precisely the run returned to the manager');
select ok((select pg_temp.candidate(claim,repeat('d',40),repeat('e',40)) from joined_attempt),
  'the active typed attempt pins an exact candidate and tree');
select throws_ok($$select pg_temp.prepare_join(claim,repeat('d',40)) from joined_attempt$$,
  '23514','Checkpoint publication intent could not be prepared.',
  'the publication outbox cannot be opened before joined-source validation');
select pg_temp.record_join_validation((claim->>'runId')::uuid,repeat('d',40),repeat('e',40),true) from joined_attempt;
select ok((select pg_temp.prepare_join(claim,repeat('d',40)) from joined_attempt),
  'the validated candidate opens the normal durable publication outbox');
create temp table publication_claim as
select public.claim_session_checkpoint_publication((claim->>'runId')::uuid) as lease,(claim->>'runId')::uuid as run_id
from joined_attempt;
select ok((select public.adopt_session_checkpoint_publication(leased.run_id,leased.lease,pub.retained_ref,repeat('d',40))
  from publication_claim leased join public.session_checkpoint_publications pub using(run_id)),
  'the shared adopter commits the validated parent checkpoint and artifact');
select ok((select head.checkpoint_run_id=(claim->>'runId')::uuid and parent.phase_status='awaiting_review'
  and not exists(select 1 from public.session_stage_approval_receipts approval
    where approval.session_id=parent.id and approval.artifact_id=parent.current_artifact_id)
  from joined_attempt started join public.sessions parent on parent.id=(claim->>'parentSessionId')::uuid
  join public.session_git_heads head on head.session_id=parent.id),
  'the integrated head requires its own human approval after branch approvals');

-- A final approval can auto-archive a parent. Only its exact old approval and
-- artifact are reopened, and pausing the typed run restores that archived state.
select pg_temp.approve_branch(root."sessionId") from branch_owner root where root.scenario='paused';
create temp table original_archive as
select parent.archived_at from branch_owner root join public.sessions parent on parent.id=root."sessionId" where root.scenario='paused';
create temp table queued_pause as select pg_temp.request_join('paused',223) as receipt;
create temp table running_pause as select pg_temp.claim_join(receipt) as claim from queued_pause;
select ok((select original.archived_at is not null and parent.phase_status='in_progress' and parent.archived_at is null
  from running_pause started join public.sessions parent on parent.id=(claim->>'parentSessionId')::uuid cross join original_archive original),
  'explicit integration can reopen the exact auto-archived approved artifact');
select public.control_factory_workflow_lifecycle(root."sessionId",root.workspace_id,root.factory_id,
  root.execution_generation,pg_temp.op651_id(230),'pause') from branch_owner root where root.scenario='paused';
select ok((select parent.phase_status='approved' and parent.archived_at=original.archived_at and job.status='canceled'
  from running_pause started join public.sessions parent on parent.id=(claim->>'parentSessionId')::uuid
  join public.agent_jobs job on job.id=(claim->>'jobId')::uuid cross join original_archive original),
  'pause retires the exact typed worker and restores the parent approval and archive');

create temp table queued_failed as select pg_temp.request_join('canceled',224) as receipt;
create temp table running_failed as select pg_temp.claim_join(receipt) as claim from queued_failed;
select ok((select pg_temp.candidate(claim,repeat('d',40),repeat('e',40)) from running_failed),
  'the failing validation fixture records its deterministic candidate');
select pg_temp.record_join_validation((claim->>'runId')::uuid,repeat('d',40),repeat('e',40),false) from running_failed;
select is((select pg_temp.settle_join(claim,'validation_failed','{}') from running_failed),'blocked',
  'an exact joined-source validation failure records a durable blocker');
select ok((select not pg_temp.candidate(claim,repeat('d',40),repeat('e',40))
  and not exists(select 1 from public.session_checkpoint_publications pub where pub.run_id=(claim->>'runId')::uuid)
  from running_failed),'the terminal attempt cannot replay candidate or enter publication');

create temp table queued_conflict as select pg_temp.request_join('parallel',225) as receipt;
create temp table running_conflict as select pg_temp.claim_join(receipt) as claim from queued_conflict;
create temp table conflict_identity as
select claim,repeat('b',64) as digest,concat_ws('/',claim->>'workspaceId',claim->>'rootSessionId',
  claim->>'joinId',claim->>'runId',repeat('b',64)||'.json') as path,
  jsonb_build_object('reportSha256',repeat('b',64),'paths',jsonb_build_array('src/conflict.ts'),'pathsTruncated',false) as detail
from running_conflict;
select is((select pg_temp.settle_join(claim,'conflict',detail) from conflict_identity),'unproved',
  'native conflict settlement requires exact retained Storage');
create function pg_temp.reserve_join_report(p_claim jsonb,p_digest text) returns uuid language sql as $$
  select public.reserve_factory_workflow_join_conflict(
    (p_claim->>'rootSessionId')::uuid,(p_claim->>'workspaceId')::uuid,(p_claim->>'factoryId')::uuid,
    (p_claim->>'generation')::bigint,(p_claim->>'ownershipToken')::uuid,(p_claim->>'joinId')::uuid,
    (p_claim->>'jobId')::uuid,(p_claim->>'runId')::uuid,(p_claim->>'attemptCount')::integer,p_digest)
$$;
create temp table conflict_reservation as
select pg_temp.reserve_join_report(claim,digest) as id from conflict_identity;
insert into storage.objects(bucket_id,name,metadata)
select 'factory-workflow-join-conflicts',path,'{"mimetype":"application/json","size":39}'::jsonb
from conflict_identity;
select is((select pg_temp.settle_join(claim,'conflict',detail) from conflict_identity),'blocked',
  'an exact retained conflict atomically retires the parent attempt');
select ok((select id is not null and not exists(
  select 1 from public.workspace_resource_operations operation where operation.id=conflict_reservation.id)
  from conflict_reservation),'the terminal receipt owns the report after atomic upload reservation transfer');
select is((select pg_temp.settle_join(claim,'conflict',detail) from conflict_identity),'blocked',
  'an identical report remains readable after exact conflict replay without a new upload');

create function pg_temp.join_conflict_digest(p_run_id uuid) returns text language sql as $$
  select public.read_factory_workflow_join_conflict_digest((claim->>'workspaceId')::uuid,
    (claim->>'rootSessionId')::uuid,(claim->>'joinId')::uuid,p_run_id) from conflict_identity
$$;
set local request.jwt.claim.role = 'authenticated';
select is(pg_temp.join_conflict_digest((select (claim->>'runId')::uuid from conflict_identity)),
  repeat('b',64),'an authorized human can read the sealed report digest');
select is(pg_temp.join_conflict_digest(gen_random_uuid()),null,
  'another run cannot read the selected conflict');
select set_config('request.jwt.claim.sub',pg_temp.op651_id(98)::text,true);
select is(pg_temp.join_conflict_digest((select (claim->>'runId')::uuid from conflict_identity)),null,
  'a nonmember cannot read the report with the exact run and join scope');


set local request.jwt.claim.role = 'service_role';
select set_config('request.jwt.claim.sub',pg_temp.op651_id(1)::text,true);
create temp table queued_deadline as select pg_temp.request_join('bounded',226) as receipt;
-- The dispatch uses transaction time. Keep fixture setup from consuming the cutoff.
create temp table deadline_dispatch as
select * from public.claim_next_worker_dispatch(p_timeout_ms=>
  ceil(extract(epoch from clock_timestamp()-transaction_timestamp())*1000)::integer+3000);
select ok((select job_id=(receipt->>'jobId')::uuid
  and public.begin_worker_dispatch(job_id,attempt_count,workflow_id)
  from deadline_dispatch cross join queued_deadline),'Workerd owns the exact expiring integration claim');
select is((select public.start_factory_workflow_join_attempt(job.id,job.workspace_id,job.session_id,job.attempt_count,
  clock_timestamp()-interval '1 millisecond')->>'kind'
  from deadline_dispatch claim join public.agent_jobs job on job.id=claim.job_id),'retired',
  'an elapsed worker request cannot bind a new integration attempt');
create temp table running_deadline as
select public.start_factory_workflow_join_attempt(job.id,job.workspace_id,job.session_id,job.attempt_count,
  clock_timestamp()+interval '2 minutes') as claim
from deadline_dispatch dispatch join public.agent_jobs job on job.id=dispatch.job_id;
select ok((select claim->>'kind'='started' and (claim->>'deadlineAt')::timestamptz=dispatch.deadline_at
  from running_deadline typed join deadline_dispatch dispatch on dispatch.job_id=(claim->>'jobId')::uuid),
  'the immutable typed attempt is capped by the exact hosted dispatch deadline');
select ok((select pg_temp.reserve_join_report(claim,repeat('f',64)) is not null from running_deadline),
  'the active exact attempt can reserve a conflict object before cutoff');
select pg_sleep(greatest(0,(select extract(epoch from ((claim->>'deadlineAt')::timestamptz-clock_timestamp()))
  from running_deadline)) + 0.025);
select ok((select job.status in ('started','running') and run.status='running' from running_deadline
  join public.agent_jobs job on job.id=(claim->>'jobId')::uuid
  join public.agent_runs run on run.id=(claim->>'runId')::uuid),
  'the native deadline can pass before supervisor retirement');
select ok((select not pg_temp.candidate(claim,repeat('d',40),repeat('e',40)) from running_deadline),
  'the native deadline fences candidate recording before supervisor recovery');
select ok((select pg_temp.reserve_join_report(claim,repeat('e',64)) is null from running_deadline),
  'the native deadline fences a new conflict reservation');
select throws_ok($$insert into storage.objects(bucket_id,name,metadata)
  select 'factory-workflow-join-conflicts',internal.factory_workflow_join_conflict_path(
    (claim->>'workspaceId')::uuid,(claim->>'rootSessionId')::uuid,(claim->>'joinId')::uuid,(claim->>'runId')::uuid,
    repeat('f',64)), '{"mimetype":"application/json"}' from running_deadline$$,
  '23514','Join conflict upload reservation is not active.',
  'a pre-deadline reservation cannot attach Storage metadata after the exact cutoff');
select is((select pg_temp.settle_join(claim,'conflict',
  jsonb_build_object('reportSha256',repeat('f',64),'paths','[]'::jsonb,'pathsTruncated',true))
  from running_deadline),'stale','a late conflict cannot replace exact-attempt deadline recovery');

select * from finish();
rollback;
