begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

-- The suite wrapper may enable its disposable database. The immutable first
-- audit receipt, rather than the current mutable flag, proves the safe default.
select ok(exists(select 1 from internal.git_continuity_release_audit
  where revision=1 and not enabled and reason='Initial release pause'),
  'the release begins paused with a durable initial audit receipt');
select ok(not has_table_privilege('service_role','internal.git_continuity_release_control','SELECT')
  and not has_table_privilege('authenticated','internal.git_continuity_release_control','SELECT'),
  'release control is private even to service callers');
select ok(has_function_privilege('service_role','public.set_git_continuity_release(boolean,bigint,text)','EXECUTE')
  and not has_function_privilege('authenticated','public.set_git_continuity_release(boolean,bigint,text)','EXECUTE')
  and not has_function_privilege('anon','public.get_git_continuity_release_state()','EXECUTE'),
  'global release control is available only through service RPCs');
select ok(has_table_privilege('service_role','public.session_git_continuity_enrollments','SELECT')
  and not has_table_privilege('service_role','public.session_git_continuity_enrollments','INSERT')
  and not has_table_privilege('service_role','public.session_git_continuity_enrollments','UPDATE')
  and not has_table_privilege('authenticated','public.session_git_continuity_enrollments','INSERT'),
  'enrollment is created by session admission rather than caller DML');
select ok((select relrowsecurity from pg_class where oid='public.session_git_continuity_enrollments'::regclass),
  'session enrollment enforces tenant RLS');
select ok(not has_function_privilege('service_role',
  'internal.start_session_job_attempt_before_release(uuid,integer,uuid,integer,text,text,text,text)','EXECUTE')
  and not has_function_privilege('service_role','internal.claim_session_pr_sync_before_release(uuid)','EXECUTE'),
  'service callers cannot bypass release admission through the preserved lifecycle implementations');

create function pg_temp.release_enabled(target boolean) returns bigint language plpgsql as $$
declare result bigint;
begin
  select revision into strict result from public.set_git_continuity_release(target,
    (select revision from public.get_git_continuity_release_state()),'SQL release regression fixture');
  return result;
end;
$$;
create function pg_temp.release_failure(statement text) returns text language plpgsql as $$
begin
  begin
    execute statement;
    raise exception 'Unexpected success' using errcode='Z0001';
  exception when others then
    return case when sqlstate='Z0001' then '00000' else sqlstate end;
  end;
end;
$$;
create temp table original_release as select * from public.get_git_continuity_release_state();
select is((select count(*) from public.set_git_continuity_release(true,
  (select revision+1000 from original_release),'Stale operator request')),0::bigint,
  'compare-and-set rejects an obsolete release revision');
select is((select to_jsonb(current_state) from public.get_git_continuity_release_state() current_state),
  (select to_jsonb(original_release) from original_release),'a stale control write changes no release metadata');
select is(pg_temp.release_failure('select * from public.set_git_continuity_release(NULL,1,''Invalid'')'),'22023',
  'null release decisions are rejected');
select is(pg_temp.release_failure('select * from public.set_git_continuity_release(true,0,''Invalid'')'),'22023',
  'nonpositive compare-and-set revisions are rejected');
select is(pg_temp.release_failure('select * from public.set_git_continuity_release(true,1,''   '')'),'22023',
  'release changes require an operator reason');
select pg_temp.release_enabled(true);
create temp table enabled_release as select * from public.get_git_continuity_release_state();
create temp table audit_before_noop as select count(*) as count from internal.git_continuity_release_audit;
select is((select revision from public.set_git_continuity_release(true,
  (select revision from enabled_release),'A repeated enable request')),(select revision from enabled_release),
  'a same-state CAS is idempotent');
select is((select count(*) from internal.git_continuity_release_audit),(select count from audit_before_noop),
  'an idempotent decision appends no misleading audit transition');
select is((select reason from public.get_git_continuity_release_state()),(select reason from enabled_release),
  'an idempotent decision preserves its original reason');

-- Isolate queue admission while keeping every fixture change transactional.
update public.agent_jobs set status='canceled' where status in ('queued','started','running');
update public.agent_runs set status='canceled' where status in ('queued','started','running');
insert into public.workspace_agent_config(workspace_id,key,value_json)
values('b1b2c3d4-0001-4000-8000-000000000001','concurrency_limit','10'::jsonb)
on conflict(workspace_id,key) do update set value_json=excluded.value_json;
insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0)
from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);

create function pg_temp.release_fixture(label text) returns uuid language plpgsql as $$
declare created record;
begin
  select * into strict created from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
    label,'Preserve exact Git input through pause','codex','gpt-5.5',null,null,
    '12b2c3d4-0001-4000-8000-000000000001',null);
  return created.session_id;
end;
$$;
create function pg_temp.release_start(target_job uuid) returns uuid language plpgsql as $$
declare owner public.sessions; started uuid; selected public.session_job_git_inputs; attempt integer;
begin
  select s.* into strict owner from public.sessions s join public.agent_jobs j on j.session_id=s.id where j.id=target_job;
  select attempt_count into strict attempt from public.agent_jobs where id=target_job;
  started:=public.start_session_job_attempt(target_job,attempt,owner.current_stage_id,owner.current_artifact_version,
    'codex','gpt-5.5','project','wallie/release-'||target_job::text);
  select * into selected from public.session_job_git_inputs where job_id=target_job;
  perform public.pin_session_job_git_input(target_job,attempt,started,'12b2c3d4-0001-4000-8000-000000000001',
    coalesce(selected.base_branch,'main'),coalesce(selected.input_sha,repeat('a',40)));
  return started;
end;
$$;
create function pg_temp.release_prepare(target_run uuid,head_sha text) returns boolean language plpgsql as $$
declare owner public.sessions; selected public.session_job_git_inputs;
begin
  select s.* into strict owner from public.sessions s join public.agent_runs r on r.session_id=s.id where r.id=target_run;
  select i.* into strict selected from public.session_job_git_inputs i join public.agent_runs r on r.agent_job_id=i.job_id where r.id=target_run;
  return public.prepare_session_source_and_checkpoint_publication(target_run,selected.repository_id,selected.base_branch,
    selected.input_sha,head_sha,'Release recovery checkpoint','Recovery body','',
    encode(extensions.digest('release recovery'::bytea,'sha256'),'hex'),encode('release recovery'::bytea,'base64'),
    owner.current_artifact_version,'Accepted while release admission is paused');
end;
$$;

-- Model the on-disk row which existed before the enrollment trigger was
-- installed; neither a legacy queued job nor an operator toggle may enroll it.
alter table public.sessions disable trigger enroll_fresh_git_continuity_session;
create temp table legacy as select pg_temp.release_fixture('Pre-release legacy session') as session_id;
alter table public.sessions enable trigger enroll_fresh_git_continuity_session;
select is((select count(*) from public.session_git_continuity_enrollments e join legacy using(session_id)),0::bigint,
  'pre-release sessions receive no invented enrollment or provenance');
select is((select state from public.get_session_git_continuity_state((select session_id from legacy))),
  'fresh_start_required','legacy session status explicitly requires a fresh start');
create temp table legacy_job as select to_jsonb(j) as packet from public.agent_jobs j join legacy l on l.session_id=j.session_id;
create temp table enrolled as select pg_temp.release_fixture('Release enrolled session') as session_id;
select ok(exists(select 1 from public.session_git_continuity_enrollments e join enrolled using(session_id)
  where e.workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and e.release_version=1),
  'new sessions atomically enroll in the current continuity contract');
select is(pg_temp.release_failure(format('update public.session_git_continuity_enrollments set release_version=1 where session_id=%L::uuid',
  (select session_id from enrolled))),'23514','accepted enrollment metadata is immutable even for a database owner');
create temp table first_job as select j.id as job_id,j.attempt_count from public.agent_jobs j join enrolled e on e.session_id=j.session_id;
create temp table paused_revision as select pg_temp.release_enabled(false) as revision;
select is((select revision from paused_revision),(select revision+1 from enabled_release),
  'an actual pause increments the release revision');
select is((select state from public.get_session_git_continuity_state((select session_id from enrolled))),
  'release_paused','enrolled session status explains a global pause');
select is((select state from public.get_session_git_continuity_state((select session_id from legacy))),
  'fresh_start_required','a global pause preserves the actionable legacy fresh-start reason');
select is((select count(*) from public.claim_next_agent_job(10)),0::bigint,
  'a paused pipeline job is skipped before queue admission');
select is((select public.start_session_job_attempt(j.id,j.attempt_count,s.current_stage_id,s.current_artifact_version,
  'codex','gpt-5.5','project','wallie/release-unclaimed')
  from first_job fixture join public.agent_jobs j on j.id=fixture.job_id join public.sessions s on s.id=j.session_id),null::uuid,
  'an unclaimed queued start returns its original NULL refusal even while release is paused');
select ok((select status='queued' and attempt_count=0 and git_continuity_release_revision is null
  from public.agent_jobs where id=(select job_id from first_job)),
  'a skipped job preserves its generation and consumes no execution attempt');

select pg_temp.release_enabled(true);
create temp table first_dispatch as select * from public.claim_next_worker_dispatch(10,10,1800000);
select is((select count(*) from first_dispatch),1::bigint,'enabled queue admission creates exactly one dispatch');
select is((select to_jsonb(j) from public.agent_jobs j join legacy l on l.session_id=j.session_id),
  (select packet from legacy_job),'enabling release skips legacy queued work without changing its attempt or generation');
select ok((select j.id=d.job_id and j.attempt_count=1 and j.git_continuity_release_revision=r.revision
  from public.agent_jobs j join first_dispatch d on d.job_id=j.id cross join public.get_git_continuity_release_state() r),
  'queue admission captures the current release revision with the claimed attempt');
create temp table placeholder_before as select to_jsonb(r) as packet from public.agent_runs r where agent_job_id=(select job_id from first_job);
select pg_temp.release_enabled(false);
select is(pg_temp.release_failure(format('select pg_temp.release_start(%L::uuid)',(select job_id from first_job))),
  'P499P','a pause between claim and start prevents creation of an active attempt');
select is(public.defer_session_job_for_continuity_release((select job_id from first_job),99),false,
  'deferral rejects a stale attempt identity');
select is(public.defer_session_job_for_continuity_release((select job_id from first_job),1),true,
  'the current unstarted claim safely returns to the queue');
select ok((select status='queued' and attempt_count=1 and last_error is null and git_continuity_release_revision is null
  from public.agent_jobs where id=(select job_id from first_job)),
  'release deferral neither fails nor cancels the job and preserves its attempt counter');
select is((select to_jsonb(r) from public.agent_runs r where agent_job_id=(select job_id from first_job)),
  (select packet from placeholder_before),'release deferral preserves the queued run placeholder byte for byte');
select is((select count(*) from public.worker_dispatches where job_id=(select job_id from first_job)),0::bigint,
  'release deferral removes the exact abandoned Cloudflare dispatch');
select is(public.defer_session_job_for_continuity_release((select job_id from first_job),1),false,
  'repeated deferral cannot alter an already queued claim');

select pg_temp.release_enabled(true);
create temp table second_claim as select * from public.claim_next_agent_job(10);
select is((select attempt_count from second_claim),2,'resumption claims the same job as its next normal attempt');
select pg_temp.release_enabled(false);
select pg_temp.release_enabled(true);
select is(pg_temp.release_failure(format('select pg_temp.release_start(%L::uuid)',(select job_id from first_job))),
  'P499P','disable and re-enable cannot revive a claim from a previous release revision');
select is(public.defer_session_job_for_continuity_release((select job_id from first_job),2),true,
  'a revision-fenced unstarted claim can be deferred without losing its job');
create temp table third_claim as select * from public.claim_next_agent_job(10);
create temp table running as select pg_temp.release_start((select job_id from first_job)) as run_id;
create temp table pinned_before as select to_jsonb(i) as packet from public.session_job_git_inputs i where job_id=(select job_id from first_job);
select pg_temp.release_enabled(false);
select is(public.defer_session_job_for_continuity_release((select job_id from first_job),2),false,
  'a past claim cannot defer the newer active attempt');
select is(public.defer_session_job_for_continuity_release((select job_id from first_job),3),false,
  'release deferral never interrupts an already started execution');
select is((select to_jsonb(i) from public.session_job_git_inputs i where job_id=(select job_id from first_job)),
  (select packet from pinned_before),'pause and stale deferral preserve immutable pinned execution input');
select is(pg_temp.release_prepare((select run_id from running),repeat('b',40)),true,
  'an execution already admitted can durably prepare checkpoint recovery while paused');
create temp table recovery as select public.claim_session_checkpoint_publication((select run_id from running)) as claim_id;
select ok((select claim_id is not null from recovery),'checkpoint recovery remains claimable while new execution is paused');
select is((select public.adopt_session_checkpoint_publication(p.run_id,r.claim_id,p.retained_ref,repeat('b',40))
  from public.session_checkpoint_publications p cross join recovery r where p.run_id=(select run_id from running)),true,
  'verified remote checkpoint recovery can adopt its artifact while paused');
select is(public.claim_session_pr_sync((select session_id from enrolled)),null::uuid,
  'canonical PR publication is paused independently of checkpoint recovery');

select pg_temp.release_enabled(true);
create temp table canonical_claim as select public.claim_session_pr_sync((select session_id from enrolled)) as claim_id;
create temp table canonical_operation as select o.id,o.claim_id,o.git_continuity_release_revision
  from public.session_pr_operations o join canonical_claim c using(claim_id);
select ok((select o.git_continuity_release_revision=r.revision and public.assert_session_pr_sync_claim(o.id,o.claim_id)
  from canonical_operation o cross join public.get_git_continuity_release_state() r),
  'canonical claims capture the same current release revision');
create temp table canonical_observation as select public.begin_session_pr_sync_observation(o.id,o.claim_id,4991,
  'https://github.com/'||e.repository_full_name||'/pull/4991') as observation_id
  from public.session_pr_operations o join canonical_operation captured on captured.id=o.id
  join public.session_pr_epochs e on e.id=o.epoch_id;
create function pg_temp.release_finish(target_operation uuid,captured_claim uuid,observation uuid)
returns boolean language sql as $$
  select public.finish_session_pr_sync(o.id,captured_claim,o.desired_sha,o.desired_fence_sha,4991,
    'https://github.com/'||e.repository_full_name||'/pull/4991','open',true,o.desired_sha,
    clock_timestamp(),observation)
  from public.session_pr_operations o join public.session_pr_epochs e on e.id=o.epoch_id where o.id=target_operation;
$$;
select pg_temp.release_enabled(false);
select is((select public.assert_session_pr_sync_claim(id,claim_id) from canonical_operation),false,
  'pause fences an already leased canonical publisher');
select is((select pg_temp.release_finish(id,claim_id,observation_id)
  from canonical_operation cross join canonical_observation),false,
  'a paused publisher cannot bypass preflight fencing by submitting an exact remote receipt directly');
select ok((select receipted_at is null and status='claimed' from public.session_pr_operations
  where id=(select id from canonical_operation)),'rejected paused completion accepts no receipt or synchronization acknowledgement');
select pg_temp.release_enabled(true);
select is((select public.assert_session_pr_sync_claim(id,claim_id) from canonical_operation),false,
  're-enable does not resurrect an older canonical lease');
select is((select pg_temp.release_finish(id,claim_id,observation_id)
  from canonical_operation cross join canonical_observation),false,
  'a previous revision cannot finish directly after disable and re-enable');
update public.session_pr_operations set lease_expires_at=clock_timestamp()-interval '1 second'
  where id=(select id from canonical_operation);
create temp table canonical_reclaim as select public.claim_session_pr_sync((select session_id from enrolled)) as claim_id;
select ok((select c.claim_id is not null and c.claim_id<>old.claim_id and o.id=old.id
  and o.git_continuity_release_revision=r.revision and public.assert_session_pr_sync_claim(o.id,c.claim_id)
  from canonical_reclaim c join public.session_pr_operations o using(claim_id) cross join canonical_operation old
  cross join public.get_git_continuity_release_state() r),
  'a new revision reclaims the same immutable canonical intent under a fresh lease');

-- A queued stage revision already has a selected immutable checkpoint. Pause
-- deferral must preserve that exact source and its still-unbound input pair.
create temp table selected_successor as select rejected.* from public.sessions s
  cross join lateral public.reject_session_stage(s.id,s.workspace_id,s.current_artifact_version,
    'Revise after release recovery','codex','gpt-5.5',s.current_stage_id,s.current_artifact_id,'project',
    'c1b2c3d4-0001-4000-8000-000000000001') rejected
  where s.id=(select session_id from enrolled);
create temp table selected_before as select to_jsonb(i) as packet from public.session_job_git_inputs i
  where job_id=(select job_id from selected_successor);
select ok((select i.input_sha=repeat('b',40) and i.input_ref is not null
  and i.pinned_run_id is null and i.pinned_attempt_count is null
  from public.session_job_git_inputs i where job_id=(select job_id from selected_successor)),
  'new stage revisions select the accepted exact source before admission');
create temp table selected_dispatch as select * from public.claim_next_worker_dispatch(10,10,1800000);
select pg_temp.release_enabled(false);
select is(public.fail_stalled_session_job_attempt((select job_id from selected_successor),1,
  'Uncertain admission reply',true,3,null),'stale',
  'stalled-claim recovery defers an unstarted release-fenced attempt instead of failing it');
select is((select to_jsonb(i) from public.session_job_git_inputs i where job_id=(select job_id from selected_successor)),
  (select packet from selected_before),'safe deferral retains the selected checkpoint, ref, repository and original binding');
select ok((select status='queued' and attempt_count=1 and last_error is null
  from public.agent_jobs where id=(select job_id from selected_successor)),
  'uncertain-start recovery preserves the same queued successor without a failure');
select pg_temp.release_enabled(true);

-- Visibility follows active human membership and exposes no global control row.
grant select on enrolled to authenticated;
select set_config('request.jwt.claim.sub',(select user_id::text from public.workspace_members
  where id='c1b2c3d4-0001-4000-8000-000000000001'),true);
set local request.jwt.claim.role='authenticated';
set local role authenticated;
select is((select count(*) from public.session_git_continuity_enrollments where session_id=(select session_id from enrolled)),1::bigint,
  'an active member can read enrollment in their workspace');
select is((select state from public.get_session_git_continuity_state((select session_id from enrolled))),
  'enabled','the scoped viewer reports the enrolled session release state');
reset role;
set local request.jwt.claim.role='service_role';
insert into auth.users(id,email) values('499a0000-0000-4000-8000-000000000001','release-outsider@example.invalid');
select set_config('request.jwt.claim.sub','499a0000-0000-4000-8000-000000000001',true);
set local request.jwt.claim.role='authenticated';
set local role authenticated;
select is((select count(*) from public.session_git_continuity_enrollments where session_id=(select session_id from enrolled)),0::bigint,
  'an unrelated user cannot read another workspace enrollment');
select is((select count(*) from public.get_session_git_continuity_state((select session_id from enrolled))),0::bigint,
  'the status RPC cannot reveal another tenant session');
reset role;
set local request.jwt.claim.role='service_role';

-- The release gate is specific to continuity work, preserving sign-in dispatch.
select pg_temp.release_enabled(false);
update public.cursor_auth_flows set status='canceled' where status in ('starting','processing','prompted');
insert into public.cursor_auth_flows(user_id,expires_at)
values('499a0000-0000-4000-8000-000000000001',clock_timestamp()+interval '10 minutes');
select is((select count(*) from public.claim_next_worker_auth_dispatch()),1::bigint,
  'unrelated authentication work remains dispatchable during the continuity pause');
select * from finish();
rollback;
