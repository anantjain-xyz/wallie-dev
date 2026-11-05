begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0)
from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);

create temp table lifecycle_pipeline as with inserted as (
  insert into public.pipelines(workspace_id,name)
  values('b1b2c3d4-0001-4000-8000-000000000001','Checkpoint lifecycle proof') returning id
) select id from inserted;
insert into public.pipeline_stages(pipeline_id,workspace_id,position,slug,name,prompt_template_md)
select p.id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,stage.position,stage.slug,stage.name,stage.name
from lifecycle_pipeline p cross join (values
  (1,'carry-plan','Plan'),(2,'carry-skipped','Skipped'),(3,'carry-build','Build'),(4,'carry-verify','Verify')
) stage(position,slug,name);

-- Rejecting an unexpected successful mutation must not contaminate later cases.
create function pg_temp.lifecycle_failure_state(statement text)
returns text language plpgsql as $$
begin
  begin
    execute statement;
    raise exception 'Mutation unexpectedly succeeded' using errcode='Z0001';
  exception when others then
    return case when sqlstate='Z0001' then '00000' else sqlstate end;
  end;
end;
$$;

create function pg_temp.lifecycle_start(target_job uuid,attempt integer default 1,observed_sha text default null,bind_input boolean default true)
returns uuid language plpgsql as $$
declare owner public.sessions; selected_input public.session_job_git_inputs; started uuid;
begin
  select s.* into strict owner from public.sessions s join public.agent_jobs j on j.session_id=s.id where j.id=target_job;
  update public.agent_jobs set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()), status='running',attempt_count=attempt where id=target_job;
  started:=public.start_session_job_attempt(target_job,attempt,owner.current_stage_id,owner.current_artifact_version,
    'codex','gpt-5.5','project','wallie/lifecycle-'||target_job::text||'-'||attempt::text);
  select * into selected_input from public.session_job_git_inputs where job_id=target_job;
  if bind_input then
    perform public.pin_session_job_git_input(target_job,attempt,started,
      '12b2c3d4-0001-4000-8000-000000000001',coalesce(selected_input.base_branch,'main'),
      coalesce(observed_sha,selected_input.input_sha,repeat('a',40)));
  end if;
  return started;
end;
$$;

create function pg_temp.lifecycle_publish(target_job uuid,target_run uuid,output_sha text,artifact_md text default 'Reviewed source')
returns uuid language plpgsql as $$
declare owner public.sessions; selected_input public.session_job_git_inputs; claim uuid; retained text;
begin
  select s.* into strict owner from public.sessions s join public.agent_jobs j on j.session_id=s.id where j.id=target_job;
  select * into strict selected_input from public.session_job_git_inputs where job_id=target_job;
  if not public.prepare_session_source_and_checkpoint_publication(target_run,selected_input.repository_id,
    selected_input.base_branch,selected_input.input_sha,output_sha,'Lifecycle checkpoint','PR body','',
    case when selected_input.input_sha<>output_sha then encode(extensions.digest('lifecycle source'::bytea,'sha256'),'hex') else '' end,
    case when selected_input.input_sha<>output_sha then encode('lifecycle source'::bytea,'base64') else '' end,
    owner.current_artifact_version,artifact_md) then raise exception 'Lifecycle source preparation failed'; end if;
  claim:=public.claim_session_checkpoint_publication(target_run);
  select retained_ref into retained from public.session_checkpoint_publications where run_id=target_run;
  if claim is null or not public.adopt_session_checkpoint_publication(target_run,claim,retained,
    case when retained is not null then output_sha end) then raise exception 'Lifecycle adoption failed'; end if;
  return (select current_artifact_id from public.sessions where id=owner.id);
end;
$$;

create function pg_temp.lifecycle_fixture(label text,output_sha text default repeat('b',40))
returns table(session_id uuid,job_id uuid,run_id uuid,stage_id uuid,artifact_id uuid)
language plpgsql as $$
declare fixture record; started uuid; accepted uuid;
begin
  select * into strict fixture from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
    label,'Carry reviewed code','codex','gpt-5.5',null,null,'12b2c3d4-0001-4000-8000-000000000001',
    (select id from lifecycle_pipeline),array(select id from public.pipeline_stages
      where pipeline_id=(select id from lifecycle_pipeline) and slug<>'carry-skipped' order by position));
  started:=pg_temp.lifecycle_start(fixture.job_id);
  accepted:=pg_temp.lifecycle_publish(fixture.job_id,started,output_sha);
  return query select fixture.session_id,fixture.job_id,started,s.current_stage_id,accepted
    from public.sessions s where s.id=fixture.session_id;
end;
$$;

create function pg_temp.lifecycle_approve(target_session uuid,target_stage uuid,target_artifact uuid,target_version integer default 1)
returns table(job_id uuid,run_id uuid,current_stage_id uuid,job_created boolean)
language sql as $$
  select result.job_id,result.run_id,result.current_stage_id,result.job_created
  from public.approve_session_stage(target_session,'b1b2c3d4-0001-4000-8000-000000000001',target_stage,target_artifact,
    target_version,'c1b2c3d4-0001-4000-8000-000000000001','codex','gpt-5.5','project',(select artifact_review_revision from public.sessions where id=target_session)) result;
$$;
create function pg_temp.lifecycle_reject(target_session uuid,target_stage uuid,target_artifact uuid,target_version integer default 1)
returns table(job_id uuid,run_id uuid,current_stage_id uuid,job_created boolean)
language sql as $$
  select result.job_id,result.run_id,result.current_stage_id,result.job_created
  from public.reject_session_stage(target_session,'b1b2c3d4-0001-4000-8000-000000000001',target_version,
    'Keep the reviewed code and revise it','codex','gpt-5.5',target_stage,target_artifact,'project',
    'c1b2c3d4-0001-4000-8000-000000000001') result;
$$;

select is((select count(*) from public.session_git_heads),0::bigint,
  'historical artifacts without accepted checkpoint provenance receive no fabricated session head');
create temp table carry_review as select * from pg_temp.lifecycle_fixture('Selected-stage checkpoint handoff');
select is((select h.checkpoint_run_id from public.session_git_heads h join carry_review f on f.session_id=h.session_id),
  (select run_id from carry_review),'accepted checkpoint advances the authoritative session cursor');
select is((select count(*) from carry_review f cross join lateral pg_temp.lifecycle_approve(f.session_id,f.stage_id,f.artifact_id,2) result),
  0::bigint,'stale approval version cannot create a successor');
select is(pg_temp.lifecycle_failure_state($$select * from carry_review f cross join lateral
  pg_temp.lifecycle_reject(f.session_id,f.stage_id,f.artifact_id,2) result$$),'55000',
  'stale rejection version cannot enqueue a revision');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from carry_review)),1::bigint,
  'invalid decisions leave only the completed producing job');

create temp table carry_next as select decision.* from carry_review f
cross join lateral pg_temp.lifecycle_approve(f.session_id,f.stage_id,f.artifact_id) decision;
select is((select stage.slug from carry_next n join public.pipeline_stages stage on stage.id=n.current_stage_id),'carry-build',
  'approval chooses the next selected stage and skips the unselected middle stage');
select ok((select j.status='queued' and r.status='queued' and r.attempt_count is null and r.stage_id=n.current_stage_id
  from carry_next n join public.agent_jobs j on j.id=n.job_id join public.agent_runs r on r.id=n.run_id),
  'stage handoff commits one queued job and a matching unclaimed execution');
select ok((select i.input_sha=repeat('b',40) and i.initial_base_sha=repeat('a',40)
  and i.source_checkpoint_run_id=f.run_id and i.input_ref=c.output_ref
  and i.repository_id=c.repository_id and i.repository_full_name=c.repository_full_name
  and i.base_branch='main' and i.pinned_run_id is null and i.pinned_attempt_count is null
  from carry_next n join public.session_job_git_inputs i on i.job_id=n.job_id
  cross join carry_review f join public.session_git_checkpoints c on c.run_id=f.run_id),
  'successor freezes reviewed output SHA, retained ref, repository and provenance before the first worker claim');
select is((select current_artifact_id from public.sessions where id=(select session_id from carry_review)),null::uuid,
  'clearing stage review identity does not erase the selected code input');
select is((select h.checkpoint_run_id from public.session_git_heads h join carry_review f on f.session_id=h.session_id),
  (select run_id from carry_review),'approval does not reset the accepted code cursor');
select is((select count(*) from carry_review f cross join lateral pg_temp.lifecycle_approve(f.session_id,f.stage_id,f.artifact_id) result),
  0::bigint,'duplicate old approval cannot enqueue another stage');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from carry_review)
  and status in ('queued','started','running')),1::bigint,'approval leaves one active successor');

select is(pg_temp.lifecycle_failure_state($$update public.session_job_git_inputs set input_sha=repeat('c',40)
  where job_id=(select job_id from carry_next)$$),'23514','queued preselection cannot be rewritten before binding');
select is(pg_temp.lifecycle_failure_state($$update public.session_job_git_inputs set input_ref='refs/heads/other'
  where job_id=(select job_id from carry_next)$$),'23514','queued preselection cannot switch its retained ref');
select is(pg_temp.lifecycle_failure_state($$update public.session_job_git_inputs set source_checkpoint_run_id=null
  where job_id=(select job_id from carry_next)$$),'23514','queued preselection cannot discard reviewed checkpoint provenance');

create temp table carry_started as select pg_temp.lifecycle_start((select job_id from carry_next),1,null,false) as run_id;
select is(pg_temp.lifecycle_failure_state($$select public.prepare_session_source_delivery((select run_id from carry_started),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('b',40),repeat('b',40),'Unbound output','Not accepted','','','')$$),
  '23514','a started worker cannot preserve output until its preselected input is bound to an owned execution');
select is((select count(*) from public.pin_session_job_git_input((select job_id from carry_next),1,
  (select run_id from carry_started),'12b2c3d4-0001-4000-8000-000000000001','main',repeat('b',40))),1::bigint,
  'first exact owned pin binds the queued selection');
select ok((select i.pinned_run_id=s.run_id and i.pinned_attempt_count=1 and r.attempt_count=1
  and r.branch_name='wallie/lifecycle-'||i.job_id::text||'-1'
  from carry_started s join public.agent_runs r on r.id=s.run_id
  join public.session_job_git_inputs i on i.job_id=r.agent_job_id),
  'first owned attempt binds the preselected input only after its run identity is established');
select is(pg_temp.lifecycle_failure_state($$select public.pin_session_job_git_input((select job_id from carry_next),1,
  (select run_id from carry_started),'12b2c3d4-0002-4000-8000-000000000002','main',repeat('b',40))$$),'23514',
  'selected checkpoint cannot move to another same-workspace repository at first execution');
select is(pg_temp.lifecycle_failure_state($$update public.session_job_git_inputs
  set pinned_run_id=null,pinned_attempt_count=null where job_id=(select job_id from carry_next)$$),'23514',
  'first binding cannot later be cleared or reassigned');

create temp table text_output as select pg_temp.lifecycle_publish((select job_id from carry_next),
  (select run_id from carry_started),repeat('b',40),'Text-only build notes preserve prior code') as artifact_id;
select ok((select c.output_kind='no-code' and c.input_sha=repeat('b',40) and c.output_sha=repeat('b',40)
  and c.output_ref is null and c.repository_id=first.repository_id and c.repository_full_name=first.repository_full_name
  from public.session_git_checkpoints c cross join carry_review f
  join public.session_git_checkpoints first on first.run_id=f.run_id
  where c.run_id=(select run_id from carry_started)),
  'text-only output preserves code and repository identity without inventing an output ref');
create temp table revised as select result.* from pg_temp.lifecycle_reject(
  (select session_id from carry_review),(select current_stage_id from carry_next),(select artifact_id from text_output)) result;
select ok((select r.current_stage_id=n.current_stage_id and r.job_id<>n.job_id and i.input_sha=repeat('b',40)
  and i.source_checkpoint_run_id=s.run_id and i.input_ref=original.output_ref
  and i.pinned_run_id is null and i.pinned_attempt_count is null
  from revised r cross join carry_next n cross join carry_started s
  join public.session_job_git_inputs i on i.job_id=r.job_id cross join carry_review f
  join public.session_git_checkpoints original on original.run_id=f.run_id),
  'same-stage request changes selects the exact reviewed no-code checkpoint and inherited retained code ref');
select is((select feedback_text from public.session_artifact_feedback where session_id=(select session_id from carry_review)
  and stage_id=(select current_stage_id from carry_next) and target_version=1),'Keep the reviewed code and revise it',
  'feedback and checkpoint-based revision are committed together');

create temp table revision_started as select pg_temp.lifecycle_start((select job_id from revised)) as run_id;
select is(public.prepare_session_source_delivery((select run_id from revision_started),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('b',40),repeat('c',40),'Partial failed code','Never reviewed','',
  encode(extensions.digest('partial failed source'::bytea,'sha256'),'hex'),encode('partial failed source'::bytea,'base64')),
  true,'failed attempt can retain a private candidate without accepting it');
select is(public.fail_session_job_attempt((select job_id from revised),1,'Agent failed before artifact publication',true,3,
  (select run_id from revision_started)),'queued','automatic retry keeps the same durable generation');
select is(pg_temp.lifecycle_failure_state($$select pg_temp.lifecycle_start((select job_id from revised),2,repeat('c',40))$$),
  '23514','retry refuses a sandbox observed at partial failed output instead of relabeling its fixed input');
create temp table retried as select pg_temp.lifecycle_start((select job_id from revised),2,repeat('b',40)) as run_id;
select ok((select i.input_sha=repeat('b',40) and i.input_ref=original.output_ref
  and i.source_checkpoint_run_id=reviewed_text.run_id and i.pinned_run_id=first_attempt.run_id and i.pinned_attempt_count=1
  from public.session_job_git_inputs i cross join carry_review f
  join public.session_git_checkpoints original on original.run_id=f.run_id
  cross join carry_started reviewed_text cross join revision_started first_attempt
  where i.job_id=(select job_id from revised)),
  'automatic retry retains its original reviewed input and binding instead of adopting partial failed output');
select is((select checkpoint_run_id from public.session_git_heads where session_id=(select session_id from carry_review)),
  (select run_id from carry_started),'private partial output does not advance the session code cursor');
select is((select count(*) from public.pin_session_job_git_input((select job_id from revised),1,
  (select run_id from revision_started),'12b2c3d4-0001-4000-8000-000000000001','main',repeat('c',40))),0::bigint,
  'stale first attempt cannot bind or republish the retry input');
select is((select count(*) from public.session_job_git_inputs where job_id=(select job_id from revised)),1::bigint,
  'claim retry creates no second input selection');
select is(public.prepare_session_source_delivery((select run_id from revision_started),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('b',40),repeat('c',40),'Late partial','Ignored','','',''),false,
  'late failed attempt cannot preserve or adopt code after replacement ownership');

create temp table revised_text as select pg_temp.lifecycle_publish((select job_id from revised),(select run_id from retried),
  repeat('b',40),'Reviewed revision remains text-only') as artifact_id;
create temp table verify_next as select result.* from pg_temp.lifecycle_approve((select session_id from carry_review),
  (select current_stage_id from revised),(select artifact_id from revised_text),2) result;
select ok((select stage.slug='carry-verify' and i.input_sha=repeat('b',40) and i.input_ref=original.output_ref
  and i.source_checkpoint_run_id=latest.run_id and i.repository_id=original.repository_id
  from verify_next n join public.pipeline_stages stage on stage.id=n.current_stage_id
  join public.session_job_git_inputs i on i.job_id=n.job_id cross join carry_review first
  join public.session_git_checkpoints original on original.run_id=first.run_id cross join retried latest),
  'a chain of text-only stages/revisions carries the same code and retained ref into the next selected stage');
select is((select cardinality(job_ids) from public.cancel_session_job_attempts((select session_id from carry_review),
  'b1b2c3d4-0001-4000-8000-000000000001','Cancel queued successor',(select run_id from verify_next))),1,
  'cancellation owns the exact queued successor');
select is((select count(*) from pg_temp.lifecycle_approve((select session_id from carry_review),
  (select current_stage_id from revised),(select artifact_id from revised_text),2)),0::bigint,
  'stale approval after successor cancellation cannot create another generation');
select is(pg_temp.lifecycle_failure_state($$select * from pg_temp.lifecycle_reject((select session_id from carry_review),
  (select current_stage_id from revised),(select artifact_id from revised_text),2)$$),'55000',
  'stale rejection after successor cancellation cannot enqueue');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from carry_review)
  and status in('queued','started','running')),0::bigint,'cancellation leaves no replacement work from stale decisions');

create temp table manual_review as select * from pg_temp.lifecycle_fixture('Queued manual revision adoption');
create temp table manual_queued as select result.* from manual_review f cross join lateral public.enqueue_session_job_with_run(
  f.session_id,'b1b2c3d4-0001-4000-8000-000000000001',f.stage_id,
  'c1b2c3d4-0001-4000-8000-000000000001','manual_retry','codex','gpt-5.5','project') result;
select ok((select i.source_checkpoint_run_id=f.run_id and i.input_sha=repeat('b',40) and i.input_ref=c.output_ref
  from manual_queued q join public.session_job_git_inputs i on i.job_id=q.job_id
  cross join manual_review f join public.session_git_checkpoints c on c.run_id=f.run_id),
  'generic manual enqueue freezes the currently reviewed code before worker claim');
create temp table manual_rejected as select result.* from manual_review f
cross join lateral pg_temp.lifecycle_reject(f.session_id,f.stage_id,f.artifact_id) result;
select ok((select r.job_id=q.job_id and r.run_id=q.run_id and not r.job_created
  from manual_rejected r cross join manual_queued q),'request changes adopts one compatible queued manual generation');
select is((select count(*) from public.session_job_git_inputs where job_id=(select job_id from manual_queued)),1::bigint,
  'adopting queued work does not replace or duplicate its input selection');

create temp table legacy_review as select * from pg_temp.lifecycle_fixture('Runless legacy checkpoint handoff');
create temp table legacy_job as with inserted as (
  insert into public.agent_jobs(workspace_id,session_id,trigger_type,status,dedupe_key)
  select 'b1b2c3d4-0001-4000-8000-000000000001',session_id,'manual_retry','queued','pipeline:checkpoint-legacy:active'
  from legacy_review returning id
) select id as job_id from inserted;
create temp table legacy_adopted as select queued.* from legacy_review f
cross join lateral public.enqueue_session_job_with_run(f.session_id,
  'b1b2c3d4-0001-4000-8000-000000000001',f.stage_id,'c1b2c3d4-0001-4000-8000-000000000001',
  'manual_retry','codex','gpt-5.5','project') queued;
select ok((select adopted.job_id=legacy.job_id and adopted.run_id is null and not adopted.created
  from legacy_adopted adopted cross join legacy_job legacy),
  'canonical enqueue adopts the existing bare legacy job and returns an explicit runless receipt');
select is((select count(*) from public.agent_runs where agent_job_id=(select job_id from legacy_job)),0::bigint,
  'checkpoint preselection does not synthesize a competing legacy execution');
select ok((select job.stage_id=f.stage_id and job.stage_slug=stage.slug and job.stage_name=stage.name
  and job.status='queued' and job.dedupe_key='pipeline:checkpoint-legacy:active'
  from legacy_job legacy join public.agent_jobs job on job.id=legacy.job_id
  cross join legacy_review f join public.pipeline_stages stage on stage.id=f.stage_id),
  'known-lineage bare job binds current scoped stage metadata while preserving its identity and queue key');
select ok((select input.input_sha=repeat('b',40) and input.input_ref=checkpoint.output_ref
  and input.source_checkpoint_run_id=f.run_id and input.pinned_run_id is null and input.pinned_attempt_count is null
  from legacy_job legacy join public.session_job_git_inputs input on input.job_id=legacy.job_id
  cross join legacy_review f join public.session_git_checkpoints checkpoint on checkpoint.run_id=f.run_id),
  'legacy runless adoption freezes the accepted checkpoint before any execution exists');
create temp table legacy_started as select pg_temp.lifecycle_start((select job_id from legacy_job)) as run_id;
select ok((select input.pinned_run_id=started.run_id and input.pinned_attempt_count=1
  and input.input_sha=repeat('b',40) and input.source_checkpoint_run_id=f.run_id
  and run.agent_job_id=legacy.job_id and run.stage_id=f.stage_id and run.status='running'
  from legacy_started started join public.agent_runs run on run.id=started.run_id
  cross join legacy_job legacy join public.session_job_git_inputs input on input.job_id=legacy.job_id
  cross join legacy_review f),
  'the worker can later start and bind the adopted legacy job to its exact selected checkpoint');
select is((select count(*) from public.agent_runs where agent_job_id=(select job_id from legacy_job)),1::bigint,
  'owned start creates only the one execution absent from the legacy enqueue receipt');

create temp table rollback_review as select * from pg_temp.lifecycle_fixture('Atomic checkpoint selection failure');
create function pg_temp.fail_lifecycle_selection() returns trigger language plpgsql as $$
begin
  if new.session_id=(select session_id from rollback_review) and new.source_checkpoint_run_id is not null then
    raise exception 'Injected checkpoint selection failure';
  end if;
  return new;
end;
$$;
create trigger lifecycle_selection_failure before insert on public.session_job_git_inputs
for each row execute function pg_temp.fail_lifecycle_selection();
select is(pg_temp.lifecycle_failure_state($$select * from rollback_review f cross join lateral
  pg_temp.lifecycle_approve(f.session_id,f.stage_id,f.artifact_id) result$$),'P0001',
  'selection failure aborts approval instead of publishing an unpinned successor');
drop trigger lifecycle_selection_failure on public.session_job_git_inputs;
select ok((select s.phase_status='awaiting_review' and s.current_stage_id=f.stage_id and s.current_artifact_id=f.artifact_id
  and h.checkpoint_run_id=f.run_id from rollback_review f join public.sessions s on s.id=f.session_id
  join public.session_git_heads h on h.session_id=s.id),
  'failed selection restores review state and retains the accepted checkpoint cursor');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from rollback_review)),1::bigint,
  'failed selection rolls back the successor job');
select is((select count(*) from public.agent_runs where session_id=(select session_id from rollback_review)),1::bigint,
  'failed selection rolls back the successor run');
select is((select count(*) from public.session_phase_completions where session_id=(select session_id from rollback_review)),0::bigint,
  'failed selection records no approval completion');

create temp table conflicting_review as select * from pg_temp.lifecycle_fixture('Conflicting legacy queued input');
-- A legacy queued execution can already carry the old generation's root input.
-- Request changes must reject that incompatible work rather than rewriting it.
update public.agent_jobs set status='queued',finished_at=null where id=(select job_id from conflicting_review);
insert into public.agent_runs(workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,model_provider,model_name,run_type,status)
select 'b1b2c3d4-0001-4000-8000-000000000001',f.session_id,f.job_id,stage.id,stage.slug,stage.name,'codex','gpt-5.5','project','queued'
from conflicting_review f join public.pipeline_stages stage on stage.id=f.stage_id;
select is(pg_temp.lifecycle_failure_state($$select * from conflicting_review f cross join lateral
  pg_temp.lifecycle_reject(f.session_id,f.stage_id,f.artifact_id) result$$),'23514',
  'rejection cannot adopt a queued generation whose immutable code input differs from the reviewed checkpoint');
select ok((select s.phase_status='awaiting_review' and s.current_artifact_id=f.artifact_id and s.rejection_count=0
  and i.input_sha=repeat('a',40) and i.source_checkpoint_run_id is null
  from conflicting_review f join public.sessions s on s.id=f.session_id
  join public.session_job_git_inputs i on i.job_id=f.job_id),
  'conflicting queued selection rolls back feedback/state and retains the old input unchanged');
select is((select count(*) from public.session_artifact_feedback where session_id=(select session_id from conflicting_review)),0::bigint,
  'input conflict records no feedback that could target the wrong execution');

create temp table root_text_review as select * from pg_temp.lifecycle_fixture('Initial text-only stage',repeat('a',40));
create temp table root_text_next as select decision.* from root_text_review f
cross join lateral pg_temp.lifecycle_approve(f.session_id,f.stage_id,f.artifact_id) decision;
select ok((select i.input_sha=repeat('a',40) and i.initial_base_sha=repeat('a',40) and i.input_ref is null
  and i.source_checkpoint_run_id=f.run_id and c.output_kind='no-code' and c.output_ref is null
  and i.repository_id=c.repository_id and i.repository_full_name=c.repository_full_name
  from root_text_next n join public.session_job_git_inputs i on i.job_id=n.job_id
  cross join root_text_review f join public.session_git_checkpoints c on c.run_id=f.run_id),
  'initial text-only output preserves exact initial root and repository without manufacturing a remote ref');

create temp table cursor_review as select * from pg_temp.lifecycle_fixture('Cursor identity proof');
create temp table cursor_revision as select decision.* from cursor_review f
cross join lateral pg_temp.lifecycle_reject(f.session_id,f.stage_id,f.artifact_id) decision;
create temp table cursor_started as select pg_temp.lifecycle_start((select job_id from cursor_revision)) as run_id;
select pg_temp.lifecycle_publish((select job_id from cursor_revision),(select run_id from cursor_started),repeat('c',40),'New accepted source');
-- A legacy route can leave an older, individually valid artifact in review.
-- Its identity must still agree with the authoritative accepted code cursor.
update public.sessions set current_artifact_id=(select artifact_id from cursor_review),current_artifact_version=1
where id=(select session_id from cursor_review);
select is(pg_temp.lifecycle_failure_state($$select * from cursor_review f cross join lateral
  pg_temp.lifecycle_approve(f.session_id,f.stage_id,f.artifact_id) decision$$),'55000',
  'approval cannot use an older valid artifact whose checkpoint is not the current session head');
select is(pg_temp.lifecycle_failure_state($$select * from cursor_review f cross join lateral
  pg_temp.lifecycle_reject(f.session_id,f.stage_id,f.artifact_id) decision$$),'55000',
  'rejection cannot rewind code by accepting a stale artifact identity after a newer checkpoint');
select is((select checkpoint_run_id from public.session_git_heads where session_id=(select session_id from cursor_review)),
  (select run_id from cursor_started),'rejected stale decisions preserve the newer accepted cursor');

create temp table foreign_source as select * from pg_temp.lifecycle_fixture('Foreign checkpoint source');
create temp table foreign_target as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Checkpoint injection target','Keep tenants separate','codex','gpt-5.5',null,null,
  '12b2c3d4-0001-4000-8000-000000000001',(select id from lifecycle_pipeline));
insert into public.workspaces(id,name,slug) values(
  '49710000-0000-4000-8000-000000000010','Foreign checkpoint metadata','foreign-checkpoint-metadata');
select is(pg_temp.lifecycle_failure_state($$insert into public.session_job_git_inputs(job_id,workspace_id,session_id,
  repository_id,repository_full_name,base_branch,initial_base_sha,input_sha,input_ref,source_checkpoint_run_id)
  select target.job_id,'49710000-0000-4000-8000-000000000010',target.session_id,c.repository_id,c.repository_full_name,
    'main',c.initial_base_sha,c.output_sha,c.output_ref,c.run_id
  from foreign_target target cross join foreign_source source join public.session_git_checkpoints c on c.run_id=source.run_id$$),
  '23514','privileged checkpoint selection cannot cross workspace boundaries');
select is(pg_temp.lifecycle_failure_state($$insert into public.session_job_git_inputs(job_id,workspace_id,session_id,
  repository_id,repository_full_name,base_branch,initial_base_sha,input_sha,input_ref,source_checkpoint_run_id)
  select target.job_id,'b1b2c3d4-0001-4000-8000-000000000001',target.session_id,c.repository_id,c.repository_full_name,
    'main',c.initial_base_sha,c.output_sha,c.output_ref,c.run_id
  from foreign_target target cross join foreign_source source join public.session_git_checkpoints c on c.run_id=source.run_id$$),
  '23514','privileged cross-session checkpoint injection cannot select another session output');
create temp table foreign_target_started as select pg_temp.lifecycle_start((select job_id from foreign_target)) as run_id;
select is((select count(*) from public.pin_session_job_git_input((select job_id from foreign_target),1,
  (select run_id from foreign_source),'12b2c3d4-0001-4000-8000-000000000001','main',repeat('b',40))),0::bigint,
  'foreign run identity cannot acquire a generation input');

create temp table unknown_review as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Unknown historical source','Do not infer a checkpoint','codex','gpt-5.5',null,null,
  '12b2c3d4-0001-4000-8000-000000000001',(select id from lifecycle_pipeline));
create temp table unknown_started as select pg_temp.lifecycle_start((select job_id from unknown_review)) as run_id;
select is(public.publish_session_job_attempt((select job_id from unknown_review),1,(select run_id from unknown_started),0,
  'Historical artifact without code proof'),true,'fixture preserves historical unknown provenance');
select is((select count(*) from public.session_git_heads where session_id=(select session_id from unknown_review)),0::bigint,
  'bare historical publication does not fabricate a code cursor');
select is(pg_temp.lifecycle_failure_state($$select * from public.sessions s cross join lateral
  pg_temp.lifecycle_approve(s.id,s.current_stage_id,s.current_artifact_id,s.current_artifact_version) result
  where s.id=(select session_id from unknown_review)$$),'55000',
  'known-root approval fails closed when the reviewed artifact has no checkpoint');
select is(pg_temp.lifecycle_failure_state($$select * from public.sessions s cross join lateral
  pg_temp.lifecycle_reject(s.id,s.current_stage_id,s.current_artifact_id,s.current_artifact_version) result
  where s.id=(select session_id from unknown_review)$$),'55000',
  'known-root rejection never substitutes initial root or an unrelated latest checkpoint for unknown reviewed code');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from unknown_review)),1::bigint,
  'unknown reviewed provenance enqueues no successor');

select ok(has_table_privilege('service_role','public.session_git_heads','SELECT')
  and not has_table_privilege('service_role','public.session_git_heads','INSERT')
  and not has_table_privilege('service_role','public.session_git_heads','UPDATE')
  and not has_table_privilege('service_role','public.session_git_heads','DELETE'),
  'service workers can inspect but cannot directly rewrite accepted checkpoint cursors');
select ok(not has_table_privilege('authenticated','public.session_git_heads','INSERT')
  and not has_table_privilege('authenticated','public.session_git_heads','UPDATE')
  and not has_table_privilege('authenticated','public.session_job_git_inputs','UPDATE'),
  'browser roles cannot alter cursor or generation inputs');
select ok(not has_table_privilege('service_role','public.session_job_git_inputs','UPDATE'),
  'service role cannot take an input-row lock before the ordered execution binding RPC');
select ok(has_function_privilege('service_role','public.pin_session_job_git_input(uuid,integer,uuid,uuid,text,text)','EXECUTE')
  and not has_function_privilege('authenticated','public.pin_session_job_git_input(uuid,integer,uuid,uuid,text,text)','EXECUTE'),
  'only service workers can call the ordered public pin API');
select ok(has_function_privilege('service_role','internal.pin_session_job_git_input(uuid,integer,uuid,uuid,text,text)','EXECUTE')
  and not has_function_privilege('authenticated','internal.pin_session_job_git_input(uuid,integer,uuid,uuid,text,text)','EXECUTE')
  and not has_function_privilege('anon','internal.pin_session_job_git_input(uuid,integer,uuid,uuid,text,text)','EXECUTE'),
  'private ordered binding helper is inaccessible to browser roles');
select ok(not (select prosecdef from pg_proc where oid='public.pin_session_job_git_input(uuid,integer,uuid,uuid,text,text)'::regprocedure)
  and (select prosecdef from pg_proc where oid='internal.pin_session_job_git_input(uuid,integer,uuid,uuid,text,text)'::regprocedure),
  'public pin remains an invoker boundary around the private definer implementation');
select set_config('request.jwt.claim.sub',(select user_id::text from public.workspace_members
  where id='c1b2c3d4-0001-4000-8000-000000000001'),true);
grant select on carry_review to authenticated;
set local request.jwt.claim.role='authenticated';
set local role authenticated;
select is((select count(*) from public.session_git_heads where session_id=(select session_id from carry_review)),1::bigint,
  'active workspace member can read its session checkpoint cursor');
reset role;
insert into auth.users(id,email) values('49710000-0000-4000-8000-000000000001','checkpoint-outsider@example.test');
select set_config('request.jwt.claim.sub','49710000-0000-4000-8000-000000000001',true);
set local role authenticated;
select is((select count(*) from public.session_git_heads),0::bigint,'foreign user cannot read another tenant checkpoint cursor');
select is((select count(*) from public.session_job_git_inputs),0::bigint,'foreign user cannot read another tenant generation inputs');
reset role;
set local request.jwt.claim.role='service_role';

select * from finish();
rollback;
