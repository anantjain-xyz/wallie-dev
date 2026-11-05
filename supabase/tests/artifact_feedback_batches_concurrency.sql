begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';

-- Independent connections require committed fixture rows. Only this namespace
-- is cleaned up, including after a prior interrupted local test invocation.
delete from public.sessions where id::text like 'aef50200-0000-4000-8000-%';
delete from public.pipelines where id='aef50200-0000-4000-8000-000000000990';
insert into public.pipelines(id,workspace_id,name)
values('aef50200-0000-4000-8000-000000000990','b1b2c3d4-0001-4000-8000-000000000001','Feedback transaction races');
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,prompt_template_md,anyone_can_approve)
select ('aef50200-0000-4000-8000-'||lpad((990+stage.position)::text,12,'0'))::uuid,
  'aef50200-0000-4000-8000-000000000990','b1b2c3d4-0001-4000-8000-000000000001',
  stage.position,stage.slug,stage.name,stage.name,true
from (values(1,'feedback-plan','Plan'),(2,'feedback-build','Build')) stage(position,slug,name);
insert into public.sessions(id,workspace_id,number,title,prompt_md,creator_member_id,pipeline_id,current_stage_id,github_repository_id,phase_status)
select ('aef50200-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'b1b2c3d4-0001-4000-8000-000000000001',99005020+n,'Feedback transaction race '||n,'Preserve inspected code',
  'c1b2c3d4-0001-4000-8000-000000000001','aef50200-0000-4000-8000-000000000990',
  'aef50200-0000-4000-8000-000000000991','12b2c3d4-0001-4000-8000-000000000001','in_progress'
from generate_series(1,8) n;
insert into public.session_selected_stages(session_id,workspace_id,stage_id)
select session.id,session.workspace_id,stage.id from public.sessions session
join public.pipeline_stages stage on stage.pipeline_id=session.pipeline_id
where session.id::text like 'aef50200-0000-4000-8000-%' on conflict do nothing;
insert into public.agent_jobs(id,workspace_id,session_id,stage_id,stage_slug,stage_name,trigger_type,status,attempt_count,git_continuity_release_revision)
select ('aef50200-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
  session.workspace_id,session.id,stage.id,stage.slug,stage.name,'assignment','running',1,
  (select revision from public.get_git_continuity_release_state())
from generate_series(1,8) n
join public.sessions session on session.id=('aef50200-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
join public.pipeline_stages stage on stage.id=session.current_stage_id;
insert into public.agent_runs(id,workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,model_provider,model_name,run_type)
select ('aef50200-0000-4000-8000-'||lpad((200+n)::text,12,'0'))::uuid,
  job.workspace_id,job.session_id,job.id,job.stage_id,job.stage_slug,job.stage_name,'codex','gpt-5.5','project'
from generate_series(1,8) n
join public.agent_jobs job on job.id=('aef50200-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid;
do $$
declare execution public.agent_runs; claim uuid; retained text; artifact uuid; fixture_number integer;
begin
  for execution in select * from public.agent_runs where id::text like 'aef50200-0000-4000-8000-%' order by id loop
    perform public.start_session_job_attempt(execution.agent_job_id,1,execution.stage_id,0,'codex','gpt-5.5','project',
      'wallie/feedback-race-'||execution.id::text);
    perform public.pin_session_job_git_input(execution.agent_job_id,1,execution.id,
      '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40));
    if not public.prepare_session_source_and_checkpoint_publication(execution.id,
      '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40),repeat('b',40),'Feedback race source','Body','',
      encode(extensions.digest('feedback race source'::bytea,'sha256'),'hex'),encode('feedback race source'::bytea,'base64'),
      0,'Reviewed concurrent code') then raise exception 'Feedback race source preparation failed'; end if;
    claim:=public.claim_session_checkpoint_publication(execution.id);
    select retained_ref into retained from public.session_checkpoint_publications where run_id=execution.id;
    if claim is null or not public.adopt_session_checkpoint_publication(execution.id,claim,retained,repeat('b',40)) then
      raise exception 'Feedback race source adoption failed'; end if;
    select current_artifact_id into artifact from public.sessions where id=execution.session_id;
    fixture_number:=right(execution.session_id::text,12)::integer;
    perform public.create_artifact_review_thread_once(gen_random_uuid(),execution.workspace_id,execution.session_id,
      execution.stage_id,artifact,1,
      '{"coordinateSystem":"unicode_code_points","start":0,"end":8,"quote":"Reviewed","prefix":"","suffix":" concurrent code"}',
      'discussion','Original race feedback '||fixture_number);
  end loop;
end;
$$;

create function public.test_feedback_batch_race_submit(fixture integer,changed boolean default false)
returns jsonb language plpgsql set search_path='' as $$
declare checkpoint public.session_git_checkpoints; result jsonb;
begin
  select * into strict checkpoint from public.session_git_checkpoints
    where run_id=('aef50200-0000-4000-8000-'||lpad((200+fixture)::text,12,'0'))::uuid;
  select to_jsonb(receipt) into strict result from public.submit_artifact_feedback_batch(
    checkpoint.session_id,checkpoint.workspace_id,1,'aef50200-0000-4000-8000-000000000991',checkpoint.artifact_id,1,
    ('aef50200-0000-4000-8000-'||lpad((500+fixture)::text,12,'0'))::uuid,
    array(select id from public.artifact_review_threads where artifact_id=checkpoint.artifact_id),
    case when changed then 'Different request payload' else 'Whole-stage race feedback' end,
    'codex','gpt-5.5','project','c1b2c3d4-0001-4000-8000-000000000001') receipt;
  return result;
exception when others then return jsonb_build_object('error',sqlstate,'message',sqlerrm);
end;
$$;
create function public.test_feedback_batch_race_approve(fixture integer)
returns bigint language sql set search_path='' as $$
  select count(*) from public.session_git_checkpoints checkpoint cross join lateral public.approve_session_stage(
    checkpoint.session_id,checkpoint.workspace_id,'aef50200-0000-4000-8000-000000000991',checkpoint.artifact_id,1,
    'c1b2c3d4-0001-4000-8000-000000000001','codex','gpt-5.5','project') receipt
  where checkpoint.run_id=('aef50200-0000-4000-8000-'||lpad((200+fixture)::text,12,'0'))::uuid;
$$;
create function public.test_feedback_batch_race_edit(fixture integer)
returns jsonb language plpgsql set search_path='' as $$
declare target_thread uuid; target_comment uuid;
begin
  select thread.id into strict target_thread from public.artifact_review_threads thread
    join public.session_git_checkpoints checkpoint on checkpoint.artifact_id=thread.artifact_id
    where checkpoint.run_id=('aef50200-0000-4000-8000-'||lpad((200+fixture)::text,12,'0'))::uuid;
  select id into strict target_comment from public.artifact_review_comments where thread_id=target_thread order by created_at,id limit 1;
  return to_jsonb(public.write_artifact_review_comment_once(gen_random_uuid(),
    'b1b2c3d4-0001-4000-8000-000000000001',target_thread,'Edited after serialized request',target_comment,1));
exception when others then return jsonb_build_object('error',sqlstate,'message',sqlerrm);
end;
$$;
commit;
begin;
create function pg_temp.wait_feedback_lock(target_application text) returns void language plpgsql as $$
declare deadline timestamptz:=clock_timestamp()+interval '5 seconds';
begin
  while not exists(select 1 from pg_catalog.pg_stat_activity where application_name=target_application and wait_event_type='Lock') loop
    if clock_timestamp()>deadline then raise exception 'Feedback contender never reached its lifecycle lock'; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;
select extensions.dblink_connect('feedback_owner',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('feedback_contender',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('feedback_owner',
  'set application_name=''feedback_owner''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''; set request.jwt.claim.sub=''a1b2c3d4-0001-4000-8000-000000000001''');
select extensions.dblink_exec('feedback_contender',
  'set application_name=''feedback_contender''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''; set request.jwt.claim.sub=''a1b2c3d4-0001-4000-8000-000000000001''');

-- The duplicate must wait on the actual session row, then read the first
-- transaction's durable response rather than enqueueing a second generation.
select extensions.dblink_exec('feedback_owner','begin');
create temp table first_feedback as select * from extensions.dblink('feedback_owner',
  'select public.test_feedback_batch_race_submit(1)') as receipt(value jsonb);
select extensions.dblink_send_query('feedback_contender','select public.test_feedback_batch_race_submit(1)');
select pg_temp.wait_feedback_lock('feedback_contender');
select ok(exists(select 1 from pg_catalog.pg_stat_activity where application_name='feedback_contender' and wait_event_type='Lock'),
  'the overlapping retry actually waits behind the first feedback transition');
select extensions.dblink_exec('feedback_owner','commit');
create temp table duplicate_feedback as select * from extensions.dblink_get_result('feedback_contender') as receipt(value jsonb);
select count(*) from extensions.dblink_get_result('feedback_contender') as receipt(value jsonb);
select is((select value from duplicate_feedback),(select value from first_feedback),
  'overlapping identical submissions return the exact same batch and generation');
select is((select count(*) from public.artifact_feedback_batches where session_id='aef50200-0000-4000-8000-000000000001'),1::bigint,
  'concurrent retries commit one immutable batch');
select is((select count(*) from public.agent_jobs where session_id='aef50200-0000-4000-8000-000000000001'
  and status in('queued','started','running')),1::bigint,'concurrent retries commit one active revision');
select ok((select input.input_sha=repeat('b',40) and input.initial_base_sha=repeat('a',40)
  and input.source_checkpoint_run_id='aef50200-0000-4000-8000-000000000201'::uuid
  and input.pinned_run_id is null and input.pinned_attempt_count is null
  from first_feedback receipt join public.session_job_git_inputs input on input.job_id=(receipt.value->>'job_id')::uuid),
  'the winning concurrent submission commits the reviewed checkpoint as its generation input');

-- Approval first: the stale feedback must roll back with no batch or feedback.
select extensions.dblink_exec('feedback_owner','begin');
select is((select accepted from extensions.dblink('feedback_owner','select public.test_feedback_batch_race_approve(2)')
  as result(accepted bigint)),1::bigint,'approval owns the first side of its feedback race');
select extensions.dblink_send_query('feedback_contender','select public.test_feedback_batch_race_submit(2)');
select pg_temp.wait_feedback_lock('feedback_contender');
select extensions.dblink_exec('feedback_owner','commit');
select is((select value->>'error' from extensions.dblink_get_result('feedback_contender') as result(value jsonb)),
  '40001','feedback waiting behind approval rechecks the changed review identity');
select count(*) from extensions.dblink_get_result('feedback_contender') as result(value jsonb);
select is((select count(*) from public.artifact_feedback_batches where session_id='aef50200-0000-4000-8000-000000000002'),
  0::bigint,'losing feedback records no batch after approval');
select is((select count(*) from public.session_artifact_feedback where session_id='aef50200-0000-4000-8000-000000000002'),
  0::bigint,'losing feedback records no partial legacy feedback either');
select ok((select session.current_stage_id='aef50200-0000-4000-8000-000000000992'::uuid
  and session.rejection_count=0 and count(job.id)=1
  from public.sessions session join public.agent_jobs job on job.session_id=session.id and job.status in('queued','started','running')
  where session.id='aef50200-0000-4000-8000-000000000002' group by session.id),
  'approval leaves one next-stage generation and no rejected generation');

-- Feedback first: an old approval cannot skip its accepted revision.
select extensions.dblink_exec('feedback_owner','begin');
create temp table feedback_before_approval as select * from extensions.dblink('feedback_owner',
  'select public.test_feedback_batch_race_submit(3)') as receipt(value jsonb);
select extensions.dblink_send_query('feedback_contender','select public.test_feedback_batch_race_approve(3)');
select pg_temp.wait_feedback_lock('feedback_contender');
select extensions.dblink_exec('feedback_owner','commit');
select is((select accepted from extensions.dblink_get_result('feedback_contender') as result(accepted bigint)),0::bigint,
  'approval waiting behind feedback cannot advance the prior artifact');
select count(*) from extensions.dblink_get_result('feedback_contender') as result(accepted bigint);
select ok((select session.phase_status='rejected' and session.rejection_count=1
  and session.current_stage_id='aef50200-0000-4000-8000-000000000991'::uuid
  and job.stage_id=session.current_stage_id and input.input_sha=repeat('b',40)
  from feedback_before_approval receipt join public.agent_jobs job on job.id=(receipt.value->>'job_id')::uuid
  join public.sessions session on session.id=job.session_id join public.session_job_git_inputs input on input.job_id=job.id),
  'feedback-winning race preserves one same-stage revision and reviewed source');
select is((select count(*) from public.session_phase_completions where session_id='aef50200-0000-4000-8000-000000000003'),
  0::bigint,'losing approval records no completion');

-- A cancellation waiting behind submission retires the exact queued run. Its
-- later request replay is still a receipt read, never new work.
select extensions.dblink_exec('feedback_owner','begin');
create temp table feedback_before_cancel as select * from extensions.dblink('feedback_owner',
  'select public.test_feedback_batch_race_submit(4)') as receipt(value jsonb);
select extensions.dblink_send_query('feedback_contender',format(
  'select * from public.cancel_session_job_attempts(%L,%L,%L,%L)',
  'aef50200-0000-4000-8000-000000000004','b1b2c3d4-0001-4000-8000-000000000001',
  'Cancel accepted feedback revision',(select value->>'run_id' from feedback_before_cancel)));
select pg_temp.wait_feedback_lock('feedback_contender');
select extensions.dblink_exec('feedback_owner','commit');
select is((select cardinality(job_ids) from extensions.dblink_get_result('feedback_contender') as result(job_ids uuid[],run_ids uuid[])),
  1,'waiting cancellation retires exactly the submitted generation');
select count(*) from extensions.dblink_get_result('feedback_contender') as result(job_ids uuid[],run_ids uuid[]);
select is(public.test_feedback_batch_race_submit(4),(select value from feedback_before_cancel),
  'a network retry after cancellation returns the accepted receipt');
select ok((select job.status='canceled' and execution.status='canceled'
  from feedback_before_cancel receipt join public.agent_jobs job on job.id=(receipt.value->>'job_id')::uuid
  join public.agent_runs execution on execution.id=(receipt.value->>'run_id')::uuid),
  'receipt replay cannot revive the canceled job or execution');
select is((select count(*) from public.agent_jobs where session_id='aef50200-0000-4000-8000-000000000004'
  and status in('queued','started','running')),0::bigint,'cancellation leaves no competing active generation');

-- Archival cancels/fences an entire session, including one still at review.
select extensions.dblink_exec('feedback_owner','begin');
select * from extensions.dblink('feedback_owner',
  'select * from public.archive_session_job_attempts(''aef50200-0000-4000-8000-000000000005'',
  ''b1b2c3d4-0001-4000-8000-000000000001'',''Archive before feedback'')') as result(job_ids uuid[],run_ids uuid[]);
select extensions.dblink_send_query('feedback_contender','select public.test_feedback_batch_race_submit(5)');
select pg_temp.wait_feedback_lock('feedback_contender');
select extensions.dblink_exec('feedback_owner','commit');
select is((select value->>'error' from extensions.dblink_get_result('feedback_contender') as result(value jsonb)),
  '40001','new feedback rechecks archival after waiting for session ownership');
select count(*) from extensions.dblink_get_result('feedback_contender') as result(value jsonb);
select is((select count(*) from public.artifact_feedback_batches where session_id='aef50200-0000-4000-8000-000000000005'),
  0::bigint,'archive-winning race creates no feedback batch');
select is((select count(*) from public.agent_jobs where session_id='aef50200-0000-4000-8000-000000000005'
  and status in('queued','started','running')),0::bigint,'archive-winning race cannot enqueue new work');

-- A comment edit owns the same serialization boundary. A stale selection is
-- refused, rather than capturing a body the submitter never inspected.
select extensions.dblink_exec('feedback_owner',
  'set role authenticated; set request.jwt.claim.role=''authenticated''; begin');
select is((select (value->>'revision')::integer from extensions.dblink('feedback_owner',
  'select public.test_feedback_batch_race_edit(6)') as result(value jsonb)),2,'comment edit owns the first side of submission');
select extensions.dblink_send_query('feedback_contender','select public.test_feedback_batch_race_submit(6)');
select pg_temp.wait_feedback_lock('feedback_contender');
select extensions.dblink_exec('feedback_owner','commit; reset role; set request.jwt.claim.role=''service_role''');
select is((select value->>'error' from extensions.dblink_get_result('feedback_contender') as result(value jsonb)),
  '40001','submission waiting behind a comment edit conflicts on the expected review revision');
select count(*) from extensions.dblink_get_result('feedback_contender') as result(value jsonb);
select is((select count(*) from public.artifact_feedback_batches where session_id='aef50200-0000-4000-8000-000000000006'),
  0::bigint,'a changed review cannot create a partial snapshot');

-- Inverse ordering: the original snapshot commits; the later edit is explicit
-- unsent work and cannot rewrite the accepted batch or execution input.
select extensions.dblink_exec('feedback_owner','begin');
create temp table feedback_before_edit as select * from extensions.dblink('feedback_owner',
  'select public.test_feedback_batch_race_submit(7)') as receipt(value jsonb);
select extensions.dblink_exec('feedback_contender','set role authenticated; set request.jwt.claim.role=''authenticated''');
select extensions.dblink_send_query('feedback_contender','select public.test_feedback_batch_race_edit(7)');
select pg_temp.wait_feedback_lock('feedback_contender');
select extensions.dblink_exec('feedback_owner','commit');
select is((select (value->>'revision')::integer from extensions.dblink_get_result('feedback_contender') as result(value jsonb)),
  2,'a later comment edit proceeds after the accepted batch commits');
select count(*) from extensions.dblink_get_result('feedback_contender') as result(value jsonb);
select extensions.dblink_exec('feedback_contender','reset role; set request.jwt.claim.role=''service_role''');
select ok((select saved.thread_revision=1 and current.revision=2
  and saved.comments->0->>'body'='Original race feedback 7'
  and current_comment.body='Edited after serialized request'
  from feedback_before_edit receipt join public.artifact_feedback_batch_threads saved
    on saved.batch_id=(receipt.value->>'feedback_batch_id')::uuid
  join public.artifact_review_threads current on current.id=saved.thread_id
  join public.artifact_review_comments current_comment on current_comment.id=(saved.comments->0->>'id')::uuid),
  'a serialized later edit stays unsent while the submitted comment revision and body remain immutable');
select is(public.test_feedback_batch_race_submit(7),(select value from feedback_before_edit),
  'an old submission retry returns its original receipt even after the later edit');

-- Reusing an in-flight UUID with changed prose is a conflict, not a second
-- batch or a silent change to the first submitter's accepted work.
select extensions.dblink_exec('feedback_owner','begin');
create temp table feedback_before_conflict as select * from extensions.dblink('feedback_owner',
  'select public.test_feedback_batch_race_submit(8)') as receipt(value jsonb);
select extensions.dblink_send_query('feedback_contender','select public.test_feedback_batch_race_submit(8,true)');
select pg_temp.wait_feedback_lock('feedback_contender');
select extensions.dblink_exec('feedback_owner','commit');
select is((select value->>'error' from extensions.dblink_get_result('feedback_contender') as result(value jsonb)),
  '23505','an overlapping changed payload cannot reuse the original request UUID');
select count(*) from extensions.dblink_get_result('feedback_contender') as result(value jsonb);
select is((select count(*) from public.artifact_feedback_batches where session_id='aef50200-0000-4000-8000-000000000008'),
  1::bigint,'conflicting UUID reuse leaves only the original accepted batch');
select is((select count(*) from public.agent_jobs where session_id='aef50200-0000-4000-8000-000000000008'
  and status in('queued','started','running')),1::bigint,'conflicting UUID reuse cannot enqueue another generation');

select extensions.dblink_disconnect('feedback_owner');
select extensions.dblink_disconnect('feedback_contender');
select * from finish();
drop function public.test_feedback_batch_race_submit(integer,boolean);
drop function public.test_feedback_batch_race_approve(integer);
drop function public.test_feedback_batch_race_edit(integer);
delete from public.sessions where id::text like 'aef50200-0000-4000-8000-%';
delete from public.pipelines where id='aef50200-0000-4000-8000-000000000990';
commit;
