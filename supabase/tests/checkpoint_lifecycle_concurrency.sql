begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

-- These identities are committed so independent worker connections can race.
-- They are namespaced and removed at the end (and before a failed-test retry).
delete from public.sessions where id::text like 'aef49700-0000-4000-8000-%';
delete from public.pipelines where id='aef49700-0000-4000-8000-000000000990';
insert into public.pipelines(id,workspace_id,name)
values('aef49700-0000-4000-8000-000000000990','b1b2c3d4-0001-4000-8000-000000000001','Concurrent checkpoint handoff');
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,prompt_template_md)
select ('aef49700-0000-4000-8000-'||lpad((990+stage.position)::text,12,'0'))::uuid,
  'aef49700-0000-4000-8000-000000000990','b1b2c3d4-0001-4000-8000-000000000001',
  stage.position,stage.slug,stage.name,stage.name
from (values (1,'race-plan','Plan'),(2,'race-skip','Skipped'),(3,'race-build','Build')) stage(position,slug,name);
insert into public.sessions(id,workspace_id,number,title,prompt_md,creator_member_id,pipeline_id,current_stage_id,github_repository_id,phase_status)
select ('aef49700-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'b1b2c3d4-0001-4000-8000-000000000001',99004970+n,'Checkpoint handoff race '||n,'Preserve reviewed code',
  'c1b2c3d4-0001-4000-8000-000000000001','aef49700-0000-4000-8000-000000000990',
  'aef49700-0000-4000-8000-000000000991','12b2c3d4-0001-4000-8000-000000000001','in_progress'
from generate_series(1,7) n;
insert into public.session_selected_stages(session_id,workspace_id,stage_id)
select session.id,session.workspace_id,stage.id from public.sessions session
join public.pipeline_stages stage on stage.pipeline_id=session.pipeline_id and stage.slug<>'race-skip'
where session.id::text like 'aef49700-0000-4000-8000-%' on conflict do nothing;
insert into public.agent_jobs(id,workspace_id,session_id,stage_id,stage_slug,stage_name,trigger_type,status,attempt_count,git_continuity_release_revision)
select ('aef49700-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
  session.workspace_id,session.id,stage.id,stage.slug,stage.name,'assignment','running',1,
  (select revision from public.get_git_continuity_release_state())
from generate_series(1,7) n
join public.sessions session on session.id=('aef49700-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
join public.pipeline_stages stage on stage.id=session.current_stage_id;
insert into public.agent_runs(id,workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,model_provider,model_name,run_type)
select ('aef49700-0000-4000-8000-'||lpad((200+n)::text,12,'0'))::uuid,
  job.workspace_id,job.session_id,job.id,job.stage_id,job.stage_slug,job.stage_name,'codex','gpt-5.5','project'
from generate_series(1,7) n
join public.agent_jobs job on job.id=('aef49700-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid;

do $$
declare execution public.agent_runs; claim uuid; retained text;
begin
  for execution in select * from public.agent_runs where id::text like 'aef49700-0000-4000-8000-%' order by id loop
    perform public.start_session_job_attempt(execution.agent_job_id,1,execution.stage_id,0,'codex','gpt-5.5','project',
      'wallie/lifecycle-race-'||execution.id::text);
    perform public.pin_session_job_git_input(execution.agent_job_id,1,execution.id,
      '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40));
    if not public.prepare_session_source_and_checkpoint_publication(execution.id,
      '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40),repeat('b',40),'Race checkpoint','PR body','',
      encode(extensions.digest('race checkpoint'::bytea,'sha256'),'hex'),encode('race checkpoint'::bytea,'base64'),
      0,'Reviewed concurrent code') then raise exception 'Concurrent fixture preparation failed'; end if;
    claim:=public.claim_session_checkpoint_publication(execution.id);
    select retained_ref into retained from public.session_checkpoint_publications where run_id=execution.id;
    if claim is null or not public.adopt_session_checkpoint_publication(execution.id,claim,retained,repeat('b',40)) then
      raise exception 'Concurrent fixture adoption failed';
    end if;
  end loop;
end;
$$;
create temp table lifecycle_race_targets as
select n,session.id as session_id,job.id as job_id,checkpoint.run_id,checkpoint.run_id as source_run_id,
  checkpoint.artifact_id,job.stage_id
from generate_series(1,7) n
join public.sessions session on session.id=('aef49700-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
join public.session_git_checkpoints checkpoint on checkpoint.artifact_id=session.current_artifact_id
join public.agent_jobs job on job.id=checkpoint.job_id;

-- Two cancellation/retry fixtures begin with a selected same-stage revision.
do $$
declare target record; successor record; started uuid;
begin
  for target in select * from lifecycle_race_targets where n in(5,6) loop
    select * into strict successor from public.reject_session_stage(target.session_id,
      'b1b2c3d4-0001-4000-8000-000000000001',1,'Revise this reviewed checkpoint','codex','gpt-5.5',
      target.stage_id,target.artifact_id,'project','c1b2c3d4-0001-4000-8000-000000000001');
    update public.agent_jobs set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()), status='running',attempt_count=1 where id=successor.job_id;
    started:=public.start_session_job_attempt(successor.job_id,1,target.stage_id,1,'codex','gpt-5.5','project',
      'wallie/lifecycle-revision-'||target.n::text);
    if target.n=6 then
      perform public.pin_session_job_git_input(successor.job_id,1,started,
        '12b2c3d4-0001-4000-8000-000000000001','main',repeat('b',40));
    end if;
    update lifecycle_race_targets set job_id=successor.job_id,run_id=started where n=target.n;
  end loop;
end;
$$;
commit;
begin;

create function pg_temp.wait_lifecycle_lock(target_application text)
returns void language plpgsql as $$
declare deadline timestamptz:=clock_timestamp()+interval '5 seconds';
begin
  while not exists(select 1 from pg_catalog.pg_stat_activity
    where application_name=target_application and wait_event_type='Lock') loop
    if clock_timestamp()>deadline then raise exception 'Lifecycle contender did not reach the expected lock'; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;
create function pg_temp.lifecycle_approve_sql(fixture integer)
returns text language sql as $$
  select format('select * from public.approve_session_stage(%L,%L,%L,%L,1,%L,%L,%L,%L)',
    target.session_id,'b1b2c3d4-0001-4000-8000-000000000001',target.stage_id,target.artifact_id,
    'c1b2c3d4-0001-4000-8000-000000000001','codex','gpt-5.5','project')
  from lifecycle_race_targets target where target.n=fixture;
$$;
create function pg_temp.lifecycle_reject_sql(fixture integer)
returns text language sql as $$
  select format('select * from public.reject_session_stage(%L,%L,1,%L,%L,%L,%L,%L,%L,%L)',
    target.session_id,'b1b2c3d4-0001-4000-8000-000000000001','Concurrent feedback','codex','gpt-5.5',
    target.stage_id,target.artifact_id,'project','c1b2c3d4-0001-4000-8000-000000000001')
  from lifecycle_race_targets target where target.n=fixture;
$$;
create function pg_temp.lifecycle_enqueue_sql(fixture integer)
returns text language sql as $$
  select format('select * from public.enqueue_session_job_with_run(%L,%L,%L,%L,%L,%L,%L,%L)',
    target.session_id,'b1b2c3d4-0001-4000-8000-000000000001',target.stage_id,
    'c1b2c3d4-0001-4000-8000-000000000001','manual_retry','codex','gpt-5.5','project')
  from lifecycle_race_targets target where target.n=fixture;
$$;
select extensions.dblink_connect('lifecycle_owner',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('lifecycle_contender',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('lifecycle_owner','set application_name=''lifecycle_owner''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');
select extensions.dblink_exec('lifecycle_contender','set application_name=''lifecycle_contender''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');

-- First approval owns the lifecycle lock; the same stale approval must wait.
select extensions.dblink_exec('lifecycle_owner','begin');
create temp table first_successor as select * from extensions.dblink('lifecycle_owner',
  'select job_id,run_id from ('||pg_temp.lifecycle_approve_sql(1)||') decision') as successor(job_id uuid,run_id uuid);
select extensions.dblink_send_query('lifecycle_contender','select count(*) from ('||pg_temp.lifecycle_approve_sql(1)||') decision');
select pg_temp.wait_lifecycle_lock('lifecycle_contender');
select ok(exists(select 1 from pg_catalog.pg_stat_activity where application_name='lifecycle_contender' and wait_event_type='Lock'),
  'duplicate approval actually waits for the first decision transaction');
select extensions.dblink_exec('lifecycle_owner','commit');
select is((select accepted from extensions.dblink_get_result('lifecycle_contender') as result(accepted bigint)),0::bigint,
  'duplicate approval rechecks the changed stage after waiting and cannot enqueue again');
select count(*) from extensions.dblink_get_result('lifecycle_contender') as result(accepted bigint);
select ok((select stage.slug='race-build' and j.status='queued' and r.status='queued'
  and i.input_sha=repeat('b',40) and i.source_checkpoint_run_id=target.source_run_id and i.input_ref=checkpoint.output_ref
  and i.pinned_run_id is null and i.pinned_attempt_count is null
  from lifecycle_race_targets target join public.sessions session on session.id=target.session_id
  join public.pipeline_stages stage on stage.id=session.current_stage_id cross join first_successor successor
  join public.agent_jobs j on j.id=successor.job_id join public.agent_runs r on r.id=successor.run_id
  join public.session_job_git_inputs i on i.job_id=j.id join public.session_git_checkpoints checkpoint on checkpoint.run_id=target.source_run_id
  where target.n=1),'winning approval skips the unselected stage and commits one exact preselected checkpoint');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from lifecycle_race_targets where n=1)
  and status in('queued','started','running')),1::bigint,'double approval leaves one active successor');

-- Rejection first: an old approval cannot skip the feedback revision.
select extensions.dblink_exec('lifecycle_owner','begin');
create temp table rejected_successor as select * from extensions.dblink('lifecycle_owner',
  'select job_id,run_id from ('||pg_temp.lifecycle_reject_sql(2)||') decision') as successor(job_id uuid,run_id uuid);
select extensions.dblink_send_query('lifecycle_contender','select count(*) from ('||pg_temp.lifecycle_approve_sql(2)||') decision');
select pg_temp.wait_lifecycle_lock('lifecycle_contender');
select extensions.dblink_exec('lifecycle_owner','commit');
select is((select accepted from extensions.dblink_get_result('lifecycle_contender') as result(accepted bigint)),0::bigint,
  'approval waiting behind rejection cannot create a competing next-stage generation');
select count(*) from extensions.dblink_get_result('lifecycle_contender') as result(accepted bigint);
select ok((select session.phase_status='rejected' and session.current_stage_id=target.stage_id
  and j.status='queued' and j.stage_id=target.stage_id and i.source_checkpoint_run_id=target.source_run_id
  and i.input_sha=repeat('b',40) and i.input_ref=checkpoint.output_ref
  from lifecycle_race_targets target join public.sessions session on session.id=target.session_id
  cross join rejected_successor successor join public.agent_jobs j on j.id=successor.job_id
  join public.session_job_git_inputs i on i.job_id=j.id join public.session_git_checkpoints checkpoint on checkpoint.run_id=target.source_run_id
  where target.n=2),'rejection-winning race keeps one same-stage revision from the exact reviewed code');
select is((select count(*) from public.session_phase_completions where session_id=(select session_id from lifecycle_race_targets where n=2)),
  0::bigint,'losing approval records no completion alongside a feedback revision');

-- Inverse ordering: approval first, rejected stale feedback must roll back.
select extensions.dblink_exec('lifecycle_owner','begin');
select is((select accepted from extensions.dblink('lifecycle_owner','select count(*) from ('||pg_temp.lifecycle_approve_sql(3)||') decision')
  as result(accepted bigint)),1::bigint,'first approval owns the inverse race');
select extensions.dblink_send_query('lifecycle_contender','select count(*) from ('||pg_temp.lifecycle_reject_sql(3)||') decision');
select pg_temp.wait_lifecycle_lock('lifecycle_contender');
select extensions.dblink_exec('lifecycle_owner','commit');
select is((select count(*) from extensions.dblink_get_result('lifecycle_contender',false) as result(accepted bigint)),0::bigint,
  'rejection waiting behind approval returns no accepted revision');
select ok(extensions.dblink_error_message('lifecycle_contender') like '%Session is not awaiting review%',
  'losing rejection observes the committed lifecycle conflict');
select count(*) from extensions.dblink_get_result('lifecycle_contender',false) as result(accepted bigint);
select is((select count(*) from public.session_artifact_feedback where session_id=(select session_id from lifecycle_race_targets where n=3)),
  0::bigint,'losing rejection saves no feedback for a nonexistent revision');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from lifecycle_race_targets where n=3)
  and status in('queued','started','running')),1::bigint,'approval-winning race retains exactly one active next-stage generation');

-- Cancellation after approval must fence the newly queued successor, while its
-- reviewed input remains available as historical metadata rather than requeued.
select extensions.dblink_exec('lifecycle_owner','begin');
create temp table canceled_successor as select * from extensions.dblink('lifecycle_owner',
  'select job_id,run_id from ('||pg_temp.lifecycle_approve_sql(4)||') decision') as successor(job_id uuid,run_id uuid);
select extensions.dblink_send_query('lifecycle_contender',format(
  'select * from public.cancel_session_job_attempts(%L,%L,%L,null,true)',
  (select session_id from lifecycle_race_targets where n=4),'b1b2c3d4-0001-4000-8000-000000000001','Cancel after approval'));
select pg_temp.wait_lifecycle_lock('lifecycle_contender');
select extensions.dblink_exec('lifecycle_owner','commit');
create temp table cancellation_receipt as select * from extensions.dblink_get_result('lifecycle_contender')
  as result(job_ids uuid[],run_ids uuid[]);
select count(*) from extensions.dblink_get_result('lifecycle_contender') as result(job_ids uuid[],run_ids uuid[]);
select ok((select successor.job_id=any(receipt.job_ids) and successor.run_id=any(receipt.run_ids)
  from canceled_successor successor cross join cancellation_receipt receipt),
  'waiting session cancellation retires the exact successor committed by approval');
select ok((select session.phase_status='rejected' and j.status='canceled' and r.status='canceled'
  and i.input_sha=repeat('b',40) and i.source_checkpoint_run_id=target.source_run_id
  and head.checkpoint_run_id=target.source_run_id
  from lifecycle_race_targets target join public.sessions session on session.id=target.session_id
  cross join canceled_successor successor join public.agent_jobs j on j.id=successor.job_id
  join public.agent_runs r on r.id=successor.run_id join public.session_job_git_inputs i on i.job_id=j.id
  join public.session_git_heads head on head.session_id=session.id where target.n=4),
  'canceling queued successor preserves its selected input and the last accepted session checkpoint');
select is((select accepted from extensions.dblink('lifecycle_owner','select count(*) from ('||pg_temp.lifecycle_approve_sql(4)||') decision')
  as result(accepted bigint)),0::bigint,'stale approval cannot resurrect canceled successor work');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from lifecycle_race_targets where n=4)
  and status in('queued','started','running')),0::bigint,'cancellation-winning handoff leaves no additional active generation');

-- Cancellation owns a new revision before its first input binding. The queued
-- selection is durable, but a late worker may not turn it into execution proof.
select extensions.dblink_exec('lifecycle_owner','begin');
select is((select cardinality(run_ids) from extensions.dblink('lifecycle_owner',format(
  'select * from public.cancel_session_job_attempts(%L,%L,%L,%L)',target.session_id,
  'b1b2c3d4-0001-4000-8000-000000000001','Cancel before input binding',target.run_id))
  as result(job_ids uuid[],run_ids uuid[])),1,'cancellation owns the unbound running revision')
from lifecycle_race_targets target where n=5;
select extensions.dblink_send_query('lifecycle_contender',format(
  'select count(*) from public.pin_session_job_git_input(%L,1,%L,%L,%L,%L)',target.job_id,target.run_id,
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('b',40))) from lifecycle_race_targets target where n=5;
select pg_temp.wait_lifecycle_lock('lifecycle_contender');
select extensions.dblink_exec('lifecycle_owner','commit');
select is((select bound from extensions.dblink_get_result('lifecycle_contender') as result(bound bigint)),0::bigint,
  'first pin rechecks cancellation after its session lock wait');
select count(*) from extensions.dblink_get_result('lifecycle_contender') as result(bound bigint);
select ok((select i.pinned_run_id is null and i.pinned_attempt_count is null and i.input_sha=repeat('b',40)
  and i.source_checkpoint_run_id=target.source_run_id and r.status='canceled' and j.status='canceled'
  from lifecycle_race_targets target join public.session_job_git_inputs i on i.job_id=target.job_id
  join public.agent_runs r on r.id=target.run_id join public.agent_jobs j on j.id=target.job_id where target.n=5),
  'canceled first binding leaves immutable reviewed selection unbound and cannot adopt abandoned code');
select is((select accepted from extensions.dblink('lifecycle_owner','select count(*) from ('||pg_temp.lifecycle_approve_sql(5)||') decision')
  as result(accepted bigint)),0::bigint,'late review of the prior artifact cannot enqueue after active revision cancellation');

-- A replacement claim wins while an old attempt is waiting to re-pin. The
-- generation input and original first binding survive the automatic retry.
select extensions.dblink_exec('lifecycle_owner','begin');
select is((select outcome from extensions.dblink('lifecycle_owner',format(
  'select public.fail_session_job_attempt(%L,1,%L,true,3,%L)',target.job_id,'Retry after failure',target.run_id))
  as result(outcome text)),'queued','automatic retry retains the durable job while holding lifecycle ownership')
from lifecycle_race_targets target where n=6;
select extensions.dblink_exec('lifecycle_owner',format('update public.agent_jobs set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()), status=''running'',attempt_count=2 where id=%L',job_id))
from lifecycle_race_targets where n=6;
create temp table replacement_run as select started.* from lifecycle_race_targets target
cross join lateral extensions.dblink('lifecycle_owner',format(
  'select public.start_session_job_attempt(%L,2,%L,1,%L,%L,%L,%L)',target.job_id,target.stage_id,
  'codex','gpt-5.5','project','wallie/lifecycle-retry-2')) as started(run_id uuid)
where target.n=6;
select extensions.dblink_send_query('lifecycle_contender',format(
  'select count(*) from public.pin_session_job_git_input(%L,1,%L,%L,%L,%L)',target.job_id,target.run_id,
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('b',40))) from lifecycle_race_targets target where n=6;
select pg_temp.wait_lifecycle_lock('lifecycle_contender');
select extensions.dblink_exec('lifecycle_owner','commit');
select is((select bound from extensions.dblink_get_result('lifecycle_contender') as result(bound bigint)),0::bigint,
  'old attempt cannot bind after the replacement claim commits');
select count(*) from extensions.dblink_get_result('lifecycle_contender') as result(bound bigint);
select is((select input_sha from extensions.dblink('lifecycle_owner',format(
  'select input_sha from public.pin_session_job_git_input(%L,2,%L,%L,%L,%L)',target.job_id,replacement.run_id,
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('b',40))) as selected(input_sha text)),repeat('b',40),
  'current replacement uses the generation original reviewed SHA')
from lifecycle_race_targets target cross join replacement_run replacement where target.n=6;
select ok((select i.pinned_run_id=target.run_id and i.pinned_attempt_count=1
  and i.source_checkpoint_run_id=target.source_run_id and i.input_sha=repeat('b',40)
  and i.input_ref=checkpoint.output_ref and head.checkpoint_run_id=target.source_run_id
  from lifecycle_race_targets target join public.session_job_git_inputs i on i.job_id=target.job_id
  join public.session_git_checkpoints checkpoint on checkpoint.run_id=target.source_run_id
  join public.session_git_heads head on head.session_id=target.session_id where target.n=6),
  'retry race changes neither original binding nor accepted source SHA/ref/cursor');

-- Independent enqueue producers serialize before either can invent a second
-- input obligation, including a worker which has not yet bound its run.
select extensions.dblink_exec('lifecycle_owner','begin');
create temp table manual_successor as select * from extensions.dblink('lifecycle_owner',
  'select job_id,run_id from ('||pg_temp.lifecycle_enqueue_sql(7)||') queued') as queued(job_id uuid,run_id uuid);
select extensions.dblink_send_query('lifecycle_contender',
  'select job_id,run_id,created from ('||pg_temp.lifecycle_enqueue_sql(7)||') queued');
select pg_temp.wait_lifecycle_lock('lifecycle_contender');
select extensions.dblink_exec('lifecycle_owner','commit');
create temp table manual_duplicate as select * from extensions.dblink_get_result('lifecycle_contender')
  as queued(job_id uuid,run_id uuid,created boolean);
select count(*) from extensions.dblink_get_result('lifecycle_contender') as queued(job_id uuid,run_id uuid,created boolean);
select ok((select duplicate.job_id=first.job_id and duplicate.run_id=first.run_id and not duplicate.created
  from manual_duplicate duplicate cross join manual_successor first),
  'second enqueue returns the original queued generation instead of duplicating work');
select ok((select i.input_sha=repeat('b',40) and i.input_ref=checkpoint.output_ref
  and i.source_checkpoint_run_id=target.source_run_id and i.pinned_run_id is null and i.pinned_attempt_count is null
  from lifecycle_race_targets target cross join manual_successor successor
  join public.session_job_git_inputs i on i.job_id=successor.job_id
  join public.session_git_checkpoints checkpoint on checkpoint.run_id=target.source_run_id where target.n=7),
  'concurrent enqueue producers agree on one preselected source checkpoint before execution');

select extensions.dblink_disconnect('lifecycle_owner');
select extensions.dblink_disconnect('lifecycle_contender');
select * from finish();
delete from public.sessions where id::text like 'aef49700-0000-4000-8000-%';
delete from public.pipelines where id='aef49700-0000-4000-8000-000000000990';
commit;
