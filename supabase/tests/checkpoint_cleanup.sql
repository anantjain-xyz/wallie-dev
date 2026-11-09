begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';
select * from public.set_git_continuity_release(false,
  (select revision from internal.git_continuity_release_control where singleton),'Checkpoint cleanup recovery proof');
select is((select enabled from internal.git_continuity_release_control where singleton),false,
  'cleanup is exercised while new execution and canonical promotion are paused');

insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0) from public.sessions
where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);

create function pg_temp.gc_failure_state(statement text) returns text language plpgsql as $$
begin
  begin
    execute statement;
    raise exception 'Mutation unexpectedly succeeded' using errcode='Z0001';
  exception when others then
    return case when sqlstate='Z0001' then '00000' else sqlstate end;
  end;
end;
$$;

-- These rows model work already running before release admission was paused.
-- Recovery uses the real pin/source/publication RPCs without enabling new work.
create function pg_temp.gc_execution(label text,base_sha text default repeat('a',40),base_branch text default 'main')
returns uuid language plpgsql as $$
declare fixture record;
begin
  select * into strict fixture from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
    label,'Retain checkpoint safety evidence','codex','gpt-5.5',null,null,
    '12b2c3d4-0001-4000-8000-000000000001',null);
  update public.sessions set phase_status='in_progress' where id=fixture.session_id;
  update public.agent_jobs set status='running',attempt_count=1 where id=fixture.job_id;
  update public.agent_runs set status='running',attempt_count=1,started_at=clock_timestamp(),
    branch_name='wallie/cleanup-fixture-'||fixture.run_id::text where id=fixture.run_id;
  if (select count(*) from public.pin_session_job_git_input(fixture.job_id,1,fixture.run_id,
    '12b2c3d4-0001-4000-8000-000000000001',base_branch,base_sha))<>1 then
    raise exception 'Cleanup input fixture could not bind';
  end if;
  return fixture.run_id;
end;
$$;
create function pg_temp.gc_prepare(label text,head_sha text default null,deadline_offset interval default interval '-8 days')
returns uuid language plpgsql as $$
declare execution uuid; output text:=coalesce(head_sha,encode(extensions.digest(label,'sha1'),'hex'));
begin
  execution:=pg_temp.gc_execution(label);
  if not public.prepare_session_source_and_checkpoint_publication(execution,
    '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40),output,label,'PR summary','',
    case when output<>repeat('a',40) then encode(extensions.digest('private cleanup source'::bytea,'sha256'),'hex') else '' end,
    case when output<>repeat('a',40) then encode('private cleanup source'::bytea,'base64') else '' end,
    0,'Private complete artifact '||repeat('retained source ',10000),clock_timestamp()+deadline_offset) then
    raise exception 'Cleanup publication fixture could not prepare';
  end if;
  return execution;
end;
$$;
create temp table gc_cases(label text primary key,run_id uuid,claim_id uuid);

select ok(not has_table_privilege('authenticated','public.session_checkpoint_cleanup','SELECT')
  and not has_table_privilege('anon','public.session_checkpoint_cleanup','SELECT'),
  'cleanup candidates and draft-source metadata are private to service workers');
select ok(has_table_privilege('service_role','public.session_checkpoint_cleanup','SELECT')
  and not has_table_privilege('service_role','public.session_checkpoint_cleanup','UPDATE')
  and not has_table_privilege('service_role','public.session_checkpoint_cleanup','INSERT')
  and not has_table_privilege('service_role','public.session_checkpoint_cleanup','DELETE'),
  'service workers mutate deletion capabilities only through ownership RPCs');
select ok(not has_function_privilege('authenticated','public.claim_session_checkpoint_cleanup(uuid)','EXECUTE')
  and not has_function_privilege('authenticated','public.finish_session_checkpoint_cleanup(uuid,uuid,boolean)','EXECUTE')
  and not has_function_privilege('anon','public.fail_session_checkpoint_cleanup(uuid,uuid,text)','EXECUTE'),
  'browser roles cannot claim or acknowledge remote deletion');

insert into gc_cases(label,run_id) values
  ('recoverable',pg_temp.gc_prepare('Cleanup live publication',null,interval '20 minutes')),
  ('retention',pg_temp.gc_prepare('Cleanup retention not elapsed',null,interval '-6 days')),
  ('no-code',pg_temp.gc_prepare('Cleanup no-code output',repeat('a',40))),
  ('absence',pg_temp.gc_prepare('Cleanup exact absence'));
select is(public.claim_session_checkpoint_cleanup((select run_id from gc_cases where label='recoverable')),null::uuid,
  'an original recoverable publication is never a cleanup candidate');
select ok((select p.status='pending' and r.status='running' from gc_cases f
  join public.session_checkpoint_publications p using(run_id) join public.agent_runs r on r.id=f.run_id where label='recoverable'),
  'cleanup does not retire an execution while its publication can still adopt');
select is(public.claim_session_checkpoint_cleanup((select run_id from gc_cases where label='retention')),null::uuid,
  'expiry alone does not waive the original-deadline-plus-seven-days retention window');
select is(public.claim_session_checkpoint_cleanup((select run_id from gc_cases where label='no-code')),null::uuid,
  'no-code output has no invented remote ref to delete');
select is((select count(*) from public.session_checkpoint_cleanup where run_id in
  (select run_id from gc_cases where label in('recoverable','retention','no-code'))),0::bigint,
  'ineligible publications never receive a deletion ledger');

update gc_cases set claim_id=public.claim_session_checkpoint_cleanup(run_id) where label='absence';
select ok((select claim_id is not null from gc_cases where label='absence'),
  'expired unadopted output can be claimed independently of new-execution release admission');
select ok((select c.retained_ref=p.retained_ref and c.expected_sha=d.head_sha
  and c.retained_ref='refs/wallie/checkpoints/'||c.run_id::text||'/'||c.expected_sha
  and c.repository_id=i.repository_id and c.github_repository_id=repository.repo_id
  and c.job_id=p.job_id and c.attempt_count=p.attempt_count
  and c.eligible_after=p.deadline_at+interval '7 days' and c.eligible_after<clock_timestamp()
  and c.cleanup_attempt_count=1 and c.status='claimed' and c.remote_absent_at is null
  from gc_cases f join public.session_checkpoint_cleanup c using(run_id)
  join public.session_checkpoint_publications p using(run_id) join public.session_source_deliveries d using(run_id)
  join public.session_job_git_inputs i on i.job_id=p.job_id join public.github_repositories repository on repository.id=i.repository_id
  where f.label='absence'),'cleanup freezes the original producer, exact ref/SHA, repository identity and original retention deadline');
select ok((select p.status='stale' and p.claim_id is null and p.artifact_id is null
  and r.status='error' and j.status='error'
  from gc_cases f join public.session_checkpoint_publications p using(run_id)
  join public.agent_runs r on r.id=f.run_id join public.agent_jobs j on j.id=r.agent_job_id where label='absence'),
  'GC irrevocably retires the expired publication and exact execution before issuing deletion authority');
select is((select public.assert_session_checkpoint_cleanup_claim(run_id,claim_id) from gc_cases where label='absence'),true,
  'the current unexpired cleanup capability can be checked before remote deletion');
select is((select public.finish_session_checkpoint_cleanup(run_id,claim_id,false) from gc_cases where label='absence'),false,
  'an existing or unverified remote ref cannot be acknowledged as absent');
select is((select public.finish_session_checkpoint_cleanup(run_id,gen_random_uuid(),true) from gc_cases where label='absence'),false,
  'a foreign claim cannot acknowledge deletion');
select is((select public.finish_session_checkpoint_cleanup(run_id,claim_id,true) from gc_cases where label='absence'),true,
  'verified remote absence records a cleanup receipt');
create temp table gc_absence_receipt as select c.remote_absent_at from public.session_checkpoint_cleanup c
  join gc_cases f using(run_id) where f.label='absence';
select is((select public.finish_session_checkpoint_cleanup(run_id,claim_id,true) from gc_cases where label='absence'),true,
  'the same claim can reconcile an ambiguous committed absence receipt idempotently');
select is((select c.remote_absent_at from public.session_checkpoint_cleanup c join gc_cases f using(run_id) where f.label='absence'),
  (select remote_absent_at from gc_absence_receipt),'idempotent reconciliation does not invent a later absence time');
select is(public.claim_session_checkpoint_cleanup((select run_id from gc_cases where label='absence')),null::uuid,
  'deleted candidates cannot receive a second cleanup capability');
select ok((select p.status='stale' and p.artifact_md='Private complete artifact '||repeat('retained source ',10000)
  and d.bundle_base64=encode('private cleanup source'::bytea,'base64') and d.status<>'delivered' and d.delivered_ref is null
  and not exists(select 1 from public.session_git_checkpoints checkpoint where checkpoint.run_id=f.run_id)
  from gc_cases f join public.session_checkpoint_publications p using(run_id)
  join public.session_source_deliveries d using(run_id) where label='absence'),
  'remote GC retains original private source and full artifact draft without faking delivery or accepted provenance');
select is(pg_temp.gc_failure_state($$update public.session_checkpoint_cleanup set remote_absent_at=clock_timestamp()+interval '1 day'
  where run_id=(select run_id from gc_cases where label='absence')$$),'23514','accepted cleanup absence time is immutable');
select is(pg_temp.gc_failure_state($$update public.session_checkpoint_cleanup set expected_sha=repeat('f',40)
  where run_id=(select run_id from gc_cases where label='absence')$$),'23514','cleanup retries cannot retarget the immutable source SHA');

insert into gc_cases(label,run_id) values('branch-candidate',pg_temp.gc_prepare('Cleanup historical branch candidate'));
alter table public.session_checkpoint_publications disable trigger guard_checkpoint_publication;
update public.session_checkpoint_publications p
set retained_ref='refs/heads/wallie/checkpoints/'||p.run_id::text||'/'||d.head_sha
from public.session_source_deliveries d
where d.run_id=p.run_id and p.run_id=(select run_id from gc_cases where label='branch-candidate');
alter table public.session_checkpoint_publications enable trigger guard_checkpoint_publication;
update gc_cases set claim_id=public.claim_session_checkpoint_cleanup(run_id) where label='branch-candidate';
select ok((select f.claim_id is not null and c.retained_ref='refs/heads/wallie/checkpoints/'||c.run_id::text||'/'||c.expected_sha
  from gc_cases f join public.session_checkpoint_cleanup c using(run_id) where label='branch-candidate'),
  'cleanup preserves the exact branch target of a pre-migration checkpoint intent');

insert into gc_cases(label,run_id) values('lease',pg_temp.gc_prepare('Cleanup stale lease'));
update gc_cases set claim_id=public.claim_session_checkpoint_cleanup(run_id) where label='lease';
create temp table gc_old_claim as select run_id,claim_id from gc_cases where label='lease';
update public.session_checkpoint_cleanup set lease_expires_at=clock_timestamp()-interval '1 second'
where run_id=(select run_id from gc_cases where label='lease');
select is((select public.assert_session_checkpoint_cleanup_claim(run_id,claim_id) from gc_old_claim),false,
  'expired cleanup ownership cannot authorize a late remote action');
select is((select public.finish_session_checkpoint_cleanup(run_id,claim_id,true) from gc_old_claim),false,
  'expired ownership cannot write an absence receipt');
update gc_cases set claim_id=public.claim_session_checkpoint_cleanup(run_id) where label='lease';
select ok((select f.claim_id is not null and f.claim_id<>old.claim_id and c.cleanup_attempt_count=2
  from gc_cases f join gc_old_claim old using(run_id) join public.session_checkpoint_cleanup c using(run_id) where label='lease'),
  'recovery advances the lease while retaining the same candidate and permanent capability counter');
select is((select public.fail_session_checkpoint_cleanup(run_id,claim_id,'network_error') from gc_old_claim),false,
  'late failure from an old claim cannot release its replacement');
select is((select public.fail_session_checkpoint_cleanup(run_id,claim_id,'network_error') from gc_cases where label='lease'),true,
  'a current transient failure schedules bounded retry instead of a false absence');
select ok((select c.status='pending' and c.claim_id is null and c.remote_absent_at is null
  and c.next_attempt_at>clock_timestamp() and c.next_attempt_at<=clock_timestamp()+interval '1 hour'
  and c.cleanup_attempt_count=2 from gc_cases f join public.session_checkpoint_cleanup c using(run_id) where label='lease'),
  'transient retry preserves permanent deletion history and finite backoff');
select is(pg_temp.gc_failure_state($$update public.session_checkpoint_cleanup set cleanup_attempt_count=0
  where run_id=(select run_id from gc_cases where label='lease')$$),'23514','issued deletion authority cannot be erased to admit a new consumer');
select is(pg_temp.gc_failure_state(format($q$select pg_temp.gc_execution('Unsafe raw consumer',%L)$q$,
  (select expected_sha from public.session_checkpoint_cleanup where run_id=(select run_id from gc_cases where label='lease')))),
  '23514','uncertain deletion remains a tombstone for new raw-SHA consumers during retry backoff');
update public.session_checkpoint_cleanup set next_attempt_at=clock_timestamp()-interval '1 second'
where run_id=(select run_id from gc_cases where label='lease');
update gc_cases set claim_id=public.claim_session_checkpoint_cleanup(run_id) where label='lease';
select is((select public.fail_session_checkpoint_cleanup(run_id,claim_id,'remote_ref_conflict') from gc_cases where label='lease'),true,
  'an externally changed remote ref is preserved as a blocked cleanup conflict');
select ok((select status='blocked' and remote_absent_at is null and cleanup_attempt_count=3
  from public.session_checkpoint_cleanup where run_id=(select run_id from gc_cases where label='lease')),
  'remote conflicts never fabricate deletion or reset previously issued capability');
select is(pg_temp.gc_failure_state(format($q$select pg_temp.gc_execution('Blocked raw consumer',%L)$q$,
  (select expected_sha from public.session_checkpoint_cleanup where run_id=(select run_id from gc_cases where label='lease')))),
  '23514','a blocked remote outcome still fences new raw consumers of the retired source');

-- Reference protection is checked independently of elapsed time: accepted
-- publication clocks are immutable and cannot be aged artificially in fixtures.
insert into gc_cases(label,run_id) values('accepted',pg_temp.gc_prepare('Cleanup accepted protection',null,interval '20 minutes'));
update gc_cases set claim_id=public.claim_session_checkpoint_publication(run_id) where label='accepted';
select is((select public.adopt_session_checkpoint_publication(f.run_id,f.claim_id,p.retained_ref,d.head_sha)
  from gc_cases f join public.session_checkpoint_publications p using(run_id)
  join public.session_source_deliveries d using(run_id) where label='accepted'),true,'reference matrix begins with real accepted artifact and checkpoint provenance');
select is(public.claim_session_checkpoint_cleanup((select run_id from gc_cases where label='accepted')),null::uuid,
  'adopted artifact/checkpoint output cannot enter the cleanup queue');
select ok((select internal.checkpoint_cleanup_ref_is_protected(i.repository_id,c.output_sha,c.output_ref,gen_random_uuid())
  and h.checkpoint_run_id=c.run_id and a.id=c.artifact_id from gc_cases f
  join public.session_git_checkpoints c using(run_id) join public.session_git_heads h on h.session_id=c.session_id
  join public.session_artifacts a on a.id=c.artifact_id join public.session_job_git_inputs i on i.job_id=c.job_id where label='accepted'),
  'accepted artifact, immutable checkpoint and current session head protect their exact retained ref');
create temp table gc_selected as select rejected.* from gc_cases f
join public.session_git_checkpoints c using(run_id) join public.sessions s on s.id=c.session_id
cross join lateral public.reject_session_stage(s.id,s.workspace_id,1,'Retain accepted input','codex','gpt-5.5',
  s.current_stage_id,c.artifact_id,'project','c1b2c3d4-0001-4000-8000-000000000001') rejected where f.label='accepted';
select ok((select j.status='queued' and i.pinned_run_id is null and i.input_ref is not null
  and internal.checkpoint_cleanup_ref_is_protected(i.repository_id,i.input_sha,i.input_ref,gen_random_uuid())
  from gc_selected f join public.agent_jobs j on j.id=f.job_id join public.session_job_git_inputs i on i.job_id=j.id),
  'queued unbound successor input keeps its selected retained checkpoint alive');
update public.session_source_deliveries set delivered_ref='refs/heads/legacy/actual-cleanup-ref',status='delivered',delivered_at=clock_timestamp()
where run_id=(select run_id from gc_cases where label='accepted');
select ok((select internal.checkpoint_cleanup_ref_is_protected(i.repository_id,d.head_sha,d.delivered_ref,gen_random_uuid())
  and d.delivered_ref<>c.output_ref from gc_cases f join public.session_source_deliveries d using(run_id)
  join public.session_git_checkpoints c using(run_id) join public.session_job_git_inputs i on i.job_id=c.job_id where label='accepted'),
  'historical actual delivered refs are retained even when different from the intended checkpoint ref');

insert into gc_cases(label,run_id) values('root',pg_temp.gc_prepare('Cleanup raw root protection'));
select pg_temp.gc_execution('Existing raw root consumer',(select head_sha from public.session_source_deliveries
  where run_id=(select run_id from gc_cases where label='root')));
select is(public.claim_session_checkpoint_cleanup((select run_id from gc_cases where label='root')),null::uuid,
  'an existing raw-SHA initial root/input protects the same repository object from GC');
select ok((select status='blocked' and cleanup_attempt_count=0 and last_error_code='referenced'
  from public.session_checkpoint_cleanup where run_id=(select run_id from gc_cases where label='root')),
  'reference protection blocks before issuing any deletion capability');
select lives_ok(format($q$select pg_temp.gc_execution('Another safe pre-capability consumer',%L)$q$,
  (select expected_sha from public.session_checkpoint_cleanup where run_id=(select run_id from gc_cases where label='root'))),
  'a candidate blocked before its first claim does not invent a permanent consumer tombstone');

insert into gc_cases(label,run_id) values('other-live',pg_temp.gc_prepare('Cleanup other recoverable publication'));
insert into gc_cases(label,run_id) select 'other-producer',pg_temp.gc_prepare('Another current publisher',d.head_sha,interval '20 minutes')
from public.session_source_deliveries d where d.run_id=(select run_id from gc_cases where label='other-live');
select is(public.claim_session_checkpoint_cleanup((select run_id from gc_cases where label='other-live')),null::uuid,
  'another recoverable publication of the same SHA keeps the old candidate reachable');
select is((select last_error_code from public.session_checkpoint_cleanup where run_id=(select run_id from gc_cases where label='other-live')),
  'referenced','other-live publication protection is explicit in the blocked ledger');

insert into gc_cases(label,run_id) values('live-lease',pg_temp.gc_prepare('Cleanup live prior lease'));
update public.session_checkpoint_publications set status='claimed',claim_id=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '1 minute'
where run_id=(select run_id from gc_cases where label='live-lease');
select is(public.claim_session_checkpoint_cleanup((select run_id from gc_cases where label='live-lease')),null::uuid,
  'a still-live prior remote capability is never displaced by GC');
select is((select last_error_code from public.session_checkpoint_cleanup where run_id=(select run_id from gc_cases where label='live-lease')),
  'live_publication_lease','live remote ownership is distinguished from reference protection');

insert into gc_cases(label,run_id) values('replacement',pg_temp.gc_prepare('Cleanup preserves replacement'));
update public.agent_runs set status='error',finished_at=clock_timestamp() where id=(select run_id from gc_cases where label='replacement');
update public.agent_jobs set attempt_count=2 where id=(select agent_job_id from public.agent_runs where id=(select run_id from gc_cases where label='replacement'));
create temp table gc_replacement as with inserted as (
  insert into public.agent_runs(workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,attempt_count,status,
    model_provider,model_name,run_type,branch_name,started_at)
  select workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,2,'running',model_provider,model_name,run_type,
    'wallie/replacement-cleanup-proof',clock_timestamp() from public.agent_runs where id=(select run_id from gc_cases where label='replacement')
  returning id,agent_job_id
) select * from inserted;
update gc_cases set claim_id=public.claim_session_checkpoint_cleanup(run_id) where label='replacement';
select ok((select f.claim_id is not null and c.attempt_count=1 and j.attempt_count=2 and j.status='running' and replacement.status='running'
  from gc_cases f join public.session_checkpoint_cleanup c using(run_id) join gc_replacement successor on true
  join public.agent_jobs j on j.id=successor.agent_job_id join public.agent_runs replacement on replacement.id=successor.id where label='replacement'),
  'cleanup targets the expired producer without retiring or replacing the newer running attempt');

-- An operation created before a release pause remains a protected consumer,
-- including after its immutable history is terminal. The retained pre-release
-- implementation seeds that historical state without changing the global gate.
create temp table gc_canonical_claim as select internal.claim_session_pr_sync_before_release(
  (select session_id from public.agent_runs where id=(select run_id from gc_cases where label='accepted'))) as claim_id;
create temp table gc_canonical_operation as select o.id from public.session_pr_operations o
  join gc_canonical_claim f on f.claim_id=o.claim_id;
select ok((select internal.checkpoint_cleanup_ref_is_protected(c.repository_id,c.output_sha,o.source_ref,gen_random_uuid())
  and o.source_ref=c.output_ref from gc_canonical_operation f join public.session_pr_operations o on o.id=f.id
  join public.session_git_checkpoints c on c.run_id=o.checkpoint_run_id),
  'canonical publication operations retain their exact accepted source refs while release admission is paused');
update public.session_pr_operations set status='terminal',claim_id=null,lease_expires_at=null
where id=(select id from gc_canonical_operation);
select ok((select o.status='terminal' and internal.checkpoint_cleanup_ref_is_protected(c.repository_id,c.output_sha,o.source_ref,gen_random_uuid())
  from gc_canonical_operation f join public.session_pr_operations o on o.id=f.id
  join public.session_git_checkpoints c on c.run_id=o.checkpoint_run_id),
  'terminal canonical operation history cannot make an accepted source collectible');

-- A different, independently verified immutable ref can safely carry the same
-- Git object. Permanent candidate tombstones must not become a global SHA ban.
insert into gc_cases(label,run_id) select 'safe-other',pg_temp.gc_prepare('Independent accepted retained ref',expected_sha,interval '20 minutes')
from public.session_checkpoint_cleanup where run_id=(select run_id from gc_cases where label='lease');
-- A historical retained branch can be the explicitly selected initial base.
alter table public.session_checkpoint_publications disable trigger guard_checkpoint_publication;
update public.session_checkpoint_publications p
set retained_ref='refs/heads/wallie/checkpoints/'||p.run_id::text||'/'||d.head_sha
from public.session_source_deliveries d
where d.run_id=p.run_id and p.run_id=(select run_id from gc_cases where label='safe-other');
alter table public.session_checkpoint_publications enable trigger guard_checkpoint_publication;
update gc_cases set claim_id=public.claim_session_checkpoint_publication(run_id) where label='safe-other';
select is((select public.adopt_session_checkpoint_publication(f.run_id,f.claim_id,p.retained_ref,d.head_sha)
  from gc_cases f join public.session_checkpoint_publications p using(run_id)
  join public.session_source_deliveries d using(run_id) where label='safe-other'),true,
  'same-SHA recovery accepts an independently published immutable ref without reviving the retired candidate');
select ok((select internal.checkpoint_cleanup_has_safe_ref(c.repository_id,c.output_sha,c.output_ref,old.retained_ref)
  and c.output_ref<>old.retained_ref from gc_cases f join public.session_git_checkpoints c using(run_id)
  join public.session_checkpoint_cleanup old on old.run_id=(select run_id from gc_cases where label='lease') where label='safe-other'),
  'the safe-ref exception requires another adopted OP-496 exact remote receipt');
create temp table gc_safe_selected as select rejected.* from gc_cases f
join public.session_git_checkpoints c using(run_id) join public.sessions s on s.id=c.session_id
cross join lateral public.reject_session_stage(s.id,s.workspace_id,1,'Use independent retained source','codex','gpt-5.5',
  s.current_stage_id,c.artifact_id,'project','c1b2c3d4-0001-4000-8000-000000000001') rejected where f.label='safe-other';
select ok((select i.input_ref=c.output_ref and i.source_checkpoint_run_id=c.run_id and i.pinned_run_id is null
  from gc_safe_selected selected join public.session_job_git_inputs i on i.job_id=selected.job_id
  join public.session_git_checkpoints c on c.run_id=(select run_id from gc_cases where label='safe-other')),
  'queued consumers may select the different verified retained ref despite an old same-SHA deletion capability');
select lives_ok(format($q$select pg_temp.gc_execution('Verified retained bootstrap',%L,%L)$q$,
  (select output_sha from public.session_git_checkpoints where run_id=(select run_id from gc_cases where label='safe-other')),
  (select substring(output_ref from 12) from public.session_git_checkpoints where run_id=(select run_id from gc_cases where label='safe-other'))),
  'a new initial root may bootstrap the SHA only through the independently verified retained branch');
update public.session_checkpoint_cleanup set next_attempt_at=clock_timestamp()-interval '1 second'
where run_id=(select run_id from gc_cases where label='lease');
update gc_cases set claim_id=public.claim_session_checkpoint_cleanup(run_id) where label='lease';
select ok((select claim_id is not null from gc_cases where label='lease'),
  'consumers of a different verified ref do not prevent exact deletion of the discarded candidate');
select is((select public.finish_session_checkpoint_cleanup(run_id,claim_id,true) from gc_cases where label='lease'),true,
  'candidate absence may complete while independent accepted code remains reachable');
select ok((select p.status='adopted' and p.remote_verified_ref=c.output_ref and p.remote_verified_sha=c.output_sha
  from gc_cases f join public.session_checkpoint_publications p using(run_id)
  join public.session_git_checkpoints c using(run_id) where label='safe-other'),
  'cleanup of the discarded duplicate leaves accepted checkpoint proof untouched');

select * from finish();
rollback;
