begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';

-- Every fixture and mutation in this file is rolled back. The accepted source
-- uses the same public publication boundary as a real producing attempt.
insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0)
from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);
create temp table batch_pipeline as with inserted as (
  insert into public.pipelines(workspace_id,name)
  values('b1b2c3d4-0001-4000-8000-000000000001','Immutable feedback batch proof') returning id
) select id from inserted;
insert into public.pipeline_stages(pipeline_id,workspace_id,position,slug,name,prompt_template_md,anyone_can_approve)
select id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,1,'batch-plan','Plan','Plan',true from batch_pipeline
union all
select id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,2,'batch-build','Build','Build',true from batch_pipeline;
create temp table batch_targets(label text primary key,session_id uuid,job_id uuid,run_id uuid,stage_id uuid,artifact_id uuid);

create function pg_temp.batch_fixture(target_label text) returns uuid language plpgsql as $$
declare fixture record; started uuid; claim uuid; retained text; accepted uuid;
begin
  select * into strict fixture from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
    target_label,'Retain reviewed source','codex','gpt-5.5',null,null,'12b2c3d4-0001-4000-8000-000000000001',
    (select id from batch_pipeline));
  update public.agent_jobs set status='running',attempt_count=1,
    git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()) where id=fixture.job_id;
  started:=public.start_session_job_attempt(fixture.job_id,1,
    (select current_stage_id from public.sessions where id=fixture.session_id),0,'codex','gpt-5.5','project',
    'wallie/feedback-fixture-'||fixture.session_id::text);
  perform public.pin_session_job_git_input(fixture.job_id,1,started,
    '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40));
  if not public.prepare_session_source_and_checkpoint_publication(started,
    '12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40),repeat('b',40),'Feedback checkpoint','Body','',
    encode(extensions.digest('feedback source'::bytea,'sha256'),'hex'),encode('feedback source'::bytea,'base64'),
    0,'Reviewed source') then raise exception 'Feedback fixture preparation failed'; end if;
  claim:=public.claim_session_checkpoint_publication(started);
  select retained_ref into retained from public.session_checkpoint_publications where run_id=started;
  if claim is null or not public.adopt_session_checkpoint_publication(started,claim,retained,repeat('b',40)) then
    raise exception 'Feedback fixture adoption failed'; end if;
  select current_artifact_id into accepted from public.sessions where id=fixture.session_id;
  insert into batch_targets select target_label,fixture.session_id,fixture.job_id,started,s.current_stage_id,accepted
    from public.sessions s where s.id=fixture.session_id;
  return fixture.session_id;
end;
$$;
create function pg_temp.batch_thread(target_label text,body text default 'Original inline request',kind text default 'discussion',
  target_artifact uuid default null,target_version integer default 1)
returns public.artifact_review_threads language plpgsql as $$
declare target record;
begin
  select * into strict target from batch_targets where label=target_label;
  return public.create_artifact_review_thread_once(gen_random_uuid(),
    'b1b2c3d4-0001-4000-8000-000000000001',target.session_id,target.stage_id,
    coalesce(target_artifact,target.artifact_id),target_version,
    '{"coordinateSystem":"unicode_code_points","start":0,"end":8,"quote":"Reviewed","prefix":"","suffix":" source"}',kind,body);
end;
$$;
create function pg_temp.batch_send(target_label text,request_id uuid,selected uuid[],note text default '',review_token bigint default null,
  actor uuid default 'c1b2c3d4-0001-4000-8000-000000000001',model_name text default 'gpt-5.5')
returns jsonb language sql as $$
  select to_jsonb(receipt) from batch_targets target cross join lateral public.submit_artifact_feedback_batch(
    p_session_id=>target.session_id,p_workspace_id=>'b1b2c3d4-0001-4000-8000-000000000001',p_artifact_version=>1,
    p_expected_stage_id=>target.stage_id,p_expected_artifact_id=>target.artifact_id,
    p_expected_review_revision=>coalesce(review_token,(select artifact_review_revision from public.sessions where id=target.session_id)),
    p_request_id=>request_id,p_selected_thread_ids=>selected,p_feedback_text=>note,
    p_agent_model_provider=>'codex',p_agent_model_name=>model_name,p_run_type=>'project',p_requested_by_member_id=>actor
  ) receipt where target.label=target_label;
$$;
create function pg_temp.batch_failure(statement text) returns jsonb language plpgsql as $$
declare message text;
begin
  begin
    execute statement;
    raise exception 'Unexpected successful feedback mutation' using errcode='Z0001';
  exception when others then
    get stacked diagnostics message=message_text;
    return jsonb_build_object('code',case when sqlstate='Z0001' then '00000' else sqlstate end,'message',message);
  end;
end;
$$;

select ok((select relrowsecurity from pg_class where oid='public.artifact_feedback_batches'::regclass)
  and (select relrowsecurity from pg_class where oid='public.artifact_feedback_batch_threads'::regclass),
  'feedback batches and snapshots both enforce tenant RLS');
select ok(has_table_privilege('authenticated','public.artifact_feedback_batches','SELECT')
  and has_table_privilege('service_role','public.artifact_feedback_batch_threads','SELECT'),
  'members and the worker can read authorized immutable feedback');
select ok(not has_table_privilege('authenticated','public.artifact_feedback_batches','INSERT')
  and not has_table_privilege('service_role','public.artifact_feedback_batches','UPDATE')
  and not has_table_privilege('authenticated','public.artifact_feedback_batch_threads','DELETE')
  and not has_table_privilege('service_role','public.artifact_feedback_batch_threads','INSERT'),
  'browser and service callers cannot fabricate or rewrite snapshot rows');
select ok(has_function_privilege('service_role',
  'public.submit_artifact_feedback_batch(uuid,uuid,integer,uuid,uuid,bigint,uuid,uuid[],text,text,text,text,uuid)','EXECUTE')
  and not has_function_privilege('authenticated',
  'public.submit_artifact_feedback_batch(uuid,uuid,integer,uuid,uuid,bigint,uuid,uuid[],text,text,text,text,uuid)','EXECUTE')
  and not has_function_privilege('anon',
  'public.submit_artifact_feedback_batch(uuid,uuid,integer,uuid,uuid,bigint,uuid,uuid[],text,text,text,text,uuid)','EXECUTE'),
  'feedback submission remains a closed privileged transition');

select pg_temp.batch_fixture('main');
create temp table batch_first_thread as select * from pg_temp.batch_thread('main','Original inline request','blocking');
create temp table batch_second_thread as select * from pg_temp.batch_thread('main','Second selected request');
create temp table batch_original_reply as select * from public.write_artifact_review_comment_once(gen_random_uuid(),
  'b1b2c3d4-0001-4000-8000-000000000001',(select id from batch_first_thread),'Original reply');
create temp table batch_review_token as select artifact_review_revision as token from public.sessions
  where id=(select session_id from batch_targets where label='main');
create temp table batch_receipt as select pg_temp.batch_send('main','50200000-0000-4000-8000-000000000001',
  array[(select id from batch_second_thread),(select id from batch_first_thread)],'  Whole-stage request  ',
  (select token from batch_review_token)) as value;
select ok((select value->>'feedback_batch_id' is not null and value->>'job_id' is not null and value->>'run_id' is not null
  and value->>'phase_status'='rejected' and (value->>'rejection_count')::integer=1 from batch_receipt),
  'one submission returns its durable batch and exact revision generation');
select is(pg_temp.batch_send('main','50200000-0000-4000-8000-000000000001',
  array[(select id from batch_first_thread),(select id from batch_second_thread)],'Whole-stage request',
  (select token from batch_review_token),'c1b2c3d4-0001-4000-8000-000000000001','newly configured model'),
  (select value from batch_receipt),'a double submit returns the exact original batch/job/run despite derived model changes');
select is((select to_jsonb(receipt) from batch_targets target cross join lateral public.submit_artifact_feedback_batch(
  target.session_id,'b1b2c3d4-0001-4000-8000-000000000001',1,target.stage_id,target.artifact_id,
  (select token from batch_review_token),'50200000-0000-4000-8000-000000000001',
  array[(select id from batch_first_thread),(select id from batch_second_thread)],'Whole-stage request',
  null,null,null,'c1b2c3d4-0001-4000-8000-000000000001') receipt where target.label='main'),
  (select value from batch_receipt),'replay does not require re-resolving unavailable derived execution configuration');
select is((select count(*) from public.artifact_feedback_batches where session_id=(select session_id from batch_targets where label='main')),
  1::bigint,'network retries persist one batch');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from batch_targets where label='main')
  and status in('queued','started','running')),1::bigint,'network retries enqueue one active revision');
select is((select count(*) from public.agent_runs where agent_job_id=(select (value->>'job_id')::uuid from batch_receipt)),
  1::bigint,'one submission creates one queued execution');
select ok((select i.input_sha=repeat('b',40) and i.initial_base_sha=repeat('a',40)
  and i.source_checkpoint_run_id=target.run_id and i.input_ref=checkpoint.output_ref
  and i.pinned_run_id is null and i.pinned_attempt_count is null
  from batch_receipt receipt join public.session_job_git_inputs i on i.job_id=(receipt.value->>'job_id')::uuid
  cross join batch_targets target join public.session_git_checkpoints checkpoint on checkpoint.run_id=target.run_id
  where target.label='main'),'the new generation pins reviewed output and retained ref rather than the original repository base');
select ok((select batch.checkpoint_run_id=target.run_id and batch.artifact_id=target.artifact_id
  and batch.artifact_version=1 and batch.review_revision=token.token and batch.whole_stage_feedback='Whole-stage request'
  from public.artifact_feedback_batches batch cross join batch_targets target cross join batch_review_token token
  where batch.id=(select (value->>'feedback_batch_id')::uuid from batch_receipt) and target.label='main'),
  'the immutable batch records the exact inspected artifact, review token, and accepted source');
select is((select count(*) from public.artifact_feedback_batch_threads where batch_id=(select (value->>'feedback_batch_id')::uuid from batch_receipt)),
  2::bigint,'only selected threads are snapshotted');
select ok((select saved.thread_revision=current.revision and saved.anchor=current.anchor and saved.kind=current.kind
  and jsonb_array_length(saved.comments)=2
  from public.artifact_feedback_batch_threads saved join public.artifact_review_threads current on current.id=saved.thread_id
  where saved.batch_id=(select (value->>'feedback_batch_id')::uuid from batch_receipt)
    and saved.thread_id=(select id from batch_first_thread)),
  'a selected thread snapshots its current revision, anchor, kind, and complete bounded comment history');
create temp table original_batch_snapshot as select to_jsonb(batch) as value from public.artifact_feedback_batches batch
  where id=(select (value->>'feedback_batch_id')::uuid from batch_receipt);
create temp table original_thread_snapshots as select jsonb_agg(to_jsonb(saved) order by thread_id) as value
  from public.artifact_feedback_batch_threads saved where batch_id=(select (value->>'feedback_batch_id')::uuid from batch_receipt);
select public.write_artifact_review_comment_once(gen_random_uuid(),'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from batch_first_thread),'Edited after submission',(select id from batch_original_reply),1);
select public.write_artifact_review_comment_once(gen_random_uuid(),'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from batch_first_thread),'Later unsent reply');
create temp table unsent_thread as select * from pg_temp.batch_thread('main','Later unsent thread');
select is((select to_jsonb(batch) from public.artifact_feedback_batches batch
  where id=(select (value->>'feedback_batch_id')::uuid from batch_receipt)),(select value from original_batch_snapshot),
  'later comment edits leave the submitted batch byte-for-byte unchanged');
select is((select jsonb_agg(to_jsonb(saved) order by thread_id) from public.artifact_feedback_batch_threads saved
  where batch_id=(select (value->>'feedback_batch_id')::uuid from batch_receipt)),(select value from original_thread_snapshots),
  'later edits and replies leave all submitted comment revisions and bodies unchanged');
select ok((select current.revision>saved.thread_revision from public.artifact_review_threads current
  join public.artifact_feedback_batch_threads saved on saved.thread_id=current.id
  where current.id=(select id from batch_first_thread)),
  'a later edit/reply is distinguishable as an unsent thread revision');
select is((select count(*) from public.artifact_feedback_batch_threads where thread_id=(select id from unsent_thread)),0::bigint,
  'a later comment thread remains explicitly outside every submitted batch');
select is(pg_temp.batch_send('main','50200000-0000-4000-8000-000000000001',
  array[(select id from batch_first_thread),(select id from batch_second_thread)],'Whole-stage request',
  (select token from batch_review_token)),(select value from batch_receipt),
  'an uncertain response can be retried after comment and session revisions change');
select is(pg_temp.batch_failure($q$select pg_temp.batch_send('main','50200000-0000-4000-8000-000000000001',
  array[(select id from batch_first_thread),(select id from batch_second_thread)],'Changed retry body',
  (select token from batch_review_token))$q$)->>'code','23505','a request UUID cannot silently accept changed semantic content');
select pg_temp.batch_fixture('other-session');
select is(pg_temp.batch_failure($q$select pg_temp.batch_send('other-session','50200000-0000-4000-8000-000000000001','{}','Other session')$q$)->>'code',
  '23505','one actor request UUID cannot silently retarget another session');
create temp table other_actor_batch as select pg_temp.batch_send('other-session','50200000-0000-4000-8000-000000000001',
  '{}','Other actor request',null,'c1b2c3d4-0002-4000-8000-000000000002') as value;
select ok((select value->>'feedback_batch_id' is not null and value->>'feedback_batch_id'<>(select value->>'feedback_batch_id' from batch_receipt)
  from other_actor_batch),'another active human has an independent request UUID namespace');
select is(pg_temp.batch_failure($q$update public.artifact_feedback_batches set rendered_feedback_text=rendered_feedback_text
  where id=(select (value->>'feedback_batch_id')::uuid from batch_receipt)$q$)->>'code','23514',
  'accepted batch content is immutable even to an administrative owner');
select is(pg_temp.batch_failure($q$delete from public.artifact_feedback_batch_threads
  where batch_id=(select (value->>'feedback_batch_id')::uuid from batch_receipt)$q$)->>'code','23514',
  'accepted per-thread snapshots cannot be removed while their batch exists');

-- Invalid requests must leave this still-reviewable fixture and its queue unchanged.
select pg_temp.batch_fixture('invalid');
create temp table invalid_thread as select * from pg_temp.batch_thread('invalid');
create temp table invalid_queue_before as select count(*) as count from public.agent_jobs
  where session_id=(select session_id from batch_targets where label='invalid');
select is(pg_temp.batch_failure($q$select pg_temp.batch_send('invalid',gen_random_uuid(),'{}',' ')$q$)->>'code','22023',
  'empty inline selection and empty whole-stage feedback are rejected');
select is(pg_temp.batch_failure($q$select pg_temp.batch_send('invalid',null,'{}','Whole note')$q$)->>'code','22023',
  'a submission requires a request UUID');
select is(pg_temp.batch_failure($q$select pg_temp.batch_send('invalid',gen_random_uuid(),array[(select id from invalid_thread)],'',0)$q$)->>'code',
  '40001','a stale review token conflicts before enqueueing');
select is(pg_temp.batch_failure($q$select pg_temp.batch_send('invalid',gen_random_uuid(),array[(select id from invalid_thread),(select id from invalid_thread)],'')$q$)->>'code',
  '22023','duplicate selected thread IDs are rejected rather than silently deduplicated');
select is(pg_temp.batch_failure($q$select pg_temp.batch_send('invalid',gen_random_uuid(),array[(select id from batch_first_thread)],'')$q$)->>'code',
  '22023','a thread from another session is rejected even within the same workspace');
select is(pg_temp.batch_failure($q$select pg_temp.batch_send('invalid',gen_random_uuid(),array['malformed-thread-id']::uuid[],'')$q$)->>'code',
  '22P02','malformed thread IDs never reach the enqueue transaction');
select is(pg_temp.batch_failure($q$select pg_temp.batch_send('invalid',gen_random_uuid(),array[gen_random_uuid()],'')$q$)->>'code',
  '22023','unknown thread IDs are rejected');
select is(pg_temp.batch_failure($q$select pg_temp.batch_send('invalid',gen_random_uuid(),'{}','Valid note',null,
  'c1b2c3d4-0003-4000-8000-000000000003')$q$)->>'code','42501','a system agent cannot impersonate a human reviewer');
create temp table closed_thread as select * from pg_temp.batch_thread('invalid','Closed request');
select public.transition_artifact_review_thread_once(gen_random_uuid(),'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from closed_thread),1,'resolved','No longer requested');
select is(pg_temp.batch_failure($q$select pg_temp.batch_send('invalid',gen_random_uuid(),array[(select id from closed_thread)],'')$q$)->>'code',
  '22023','resolved threads cannot be silently resubmitted');
create temp table old_artifact as with inserted as (
  insert into public.session_artifacts(workspace_id,session_id,stage_id,stage_slug,version,artifact_json)
  select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,session_id,stage_id,'batch-old',1,to_jsonb('Reviewed source'::text)
    from batch_targets where label='invalid' returning id
) select id from inserted;
create temp table old_thread as select * from pg_temp.batch_thread('invalid','Historical request','discussion',(select id from old_artifact));
select is(pg_temp.batch_failure($q$select pg_temp.batch_send('invalid',gen_random_uuid(),array[(select id from old_thread)],'')$q$)->>'code',
  '22023','a historical same-version thread cannot substitute for the inspected artifact identity');
select is(pg_temp.batch_failure($q$select public.submit_artifact_feedback_batch(target.session_id,
  'b1b2c3d4-0001-4000-8000-000000000001',2,target.stage_id,target.artifact_id,
  (select artifact_review_revision from public.sessions where id=target.session_id),gen_random_uuid(),'{}','Version stale',
  'codex','gpt-5.5','project','c1b2c3d4-0001-4000-8000-000000000001') from batch_targets target where label='invalid'$q$)->>'code',
  '40001','a stale artifact version conflicts without creating a generation');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from batch_targets where label='invalid')),
  (select count from invalid_queue_before),'all invalid submissions leave the generation count unchanged');
select is((select count(*) from public.artifact_feedback_batches where session_id=(select session_id from batch_targets where label='invalid')),
  0::bigint,'all invalid submissions leave no batch receipt');

-- Limits refuse the entire selection and include actionable numerical bounds.
create temp table whole_limit as select pg_temp.batch_failure($q$select pg_temp.batch_send('invalid',gen_random_uuid(),'{}',repeat('😀',4001))$q$) as value;
select is((select value->>'code' from whole_limit),'22001','whole-stage limit counts Unicode code points');
select matches((select value->>'message' from whole_limit),'4000','whole-stage limit explains the actionable bound');
select pg_temp.batch_fixture('thread-limit');
create temp table excess_threads as select n,(pg_temp.batch_thread('thread-limit','Bounded selection '||n)).id as id
  from generate_series(1,21) n;
create temp table thread_limit as select pg_temp.batch_failure($q$select pg_temp.batch_send('thread-limit',gen_random_uuid(),
  (select array_agg(id order by n) from excess_threads),'')$q$) as value;
select is((select value->>'code' from thread_limit),'22001','twenty-one selected threads are refused atomically');
select matches((select value->>'message' from thread_limit),'20','thread limit names the maximum selection');
select is((select count(*) from public.artifact_feedback_batches where session_id=(select session_id from batch_targets where label='thread-limit')),
  0::bigint,'an excessive selection creates no partial batch');
create temp table thread_boundary as select pg_temp.batch_send('thread-limit',gen_random_uuid(),
  (select array_agg(id order by n) from excess_threads where n<=20),'') as value;
select is((select count(*) from public.artifact_feedback_batch_threads
  where batch_id=(select (value->>'feedback_batch_id')::uuid from thread_boundary)),20::bigint,
  'twenty selected threads are preserved completely at the supported boundary');
select pg_temp.batch_fixture('comment-limit');
create temp table excess_comment_thread as select * from pg_temp.batch_thread('comment-limit');
select public.write_artifact_review_comment_once(gen_random_uuid(),'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from excess_comment_thread),'Reply '||n) from generate_series(1,100) n;
create temp table comment_limit as select pg_temp.batch_failure($q$select pg_temp.batch_send('comment-limit',gen_random_uuid(),
  array[(select id from excess_comment_thread)],'')$q$) as value;
select is((select value->>'code' from comment_limit),'22001','one hundred and one selected comments are refused');
select matches((select value->>'message' from comment_limit),'100','comment limit is actionable rather than silently truncated');
select pg_temp.batch_fixture('comment-boundary');
create temp table boundary_comment_thread as select * from pg_temp.batch_thread('comment-boundary');
select public.write_artifact_review_comment_once(gen_random_uuid(),'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from boundary_comment_thread),'Reply '||n) from generate_series(1,99) n;
create temp table comment_boundary as select pg_temp.batch_send('comment-boundary',gen_random_uuid(),
  array[(select id from boundary_comment_thread)],'') as value;
select is((select jsonb_array_length(comments) from public.artifact_feedback_batch_threads
  where batch_id=(select (value->>'feedback_batch_id')::uuid from comment_boundary)),100,
  'the maximum supported comment count is stored without truncation');
select pg_temp.batch_fixture('rendered-limit');
create temp table rendered_limit_thread as select * from pg_temp.batch_thread('rendered-limit',repeat('x',10000));
select public.write_artifact_review_comment_once(gen_random_uuid(),'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from rendered_limit_thread),repeat('y',10000)) from generate_series(1,4);
create temp table rendered_limit as select pg_temp.batch_failure($q$select pg_temp.batch_send('rendered-limit',gen_random_uuid(),
  array[(select id from rendered_limit_thread)],'')$q$) as value;
select is((select value->>'code' from rendered_limit),'22001','rendered feedback total is bounded before persistence');
select matches((select value->>'message' from rendered_limit),'40000','rendered feedback error explains its bound');
select pg_temp.batch_fixture('whole-only');
create temp table whole_only as select pg_temp.batch_send('whole-only',gen_random_uuid(),'{}',repeat('😀',4000)) as value;
select ok((select char_length(batch.whole_stage_feedback)=4000 and batch.selected_thread_ids='{}'::uuid[]
  from public.artifact_feedback_batches batch where batch.id=(select (value->>'feedback_batch_id')::uuid from whole_only)),
  'a maximum-sized Unicode whole-stage note remains supported without inline selections');

select pg_temp.batch_fixture('execution');
create temp table execution_batch as select pg_temp.batch_send('execution',gen_random_uuid(),'{}','Revise reviewed code') as value;
update public.agent_jobs set status='running',attempt_count=1,
  git_continuity_release_revision=(select revision from public.get_git_continuity_release_state())
  where id=(select (value->>'job_id')::uuid from execution_batch);
create temp table revision_execution as select public.start_session_job_attempt(
  (select (value->>'job_id')::uuid from execution_batch),1,(select stage_id from batch_targets where label='execution'),1,
  'codex','gpt-5.5','project','wallie/feedback-preserved-source') as run_id;
select is((select input_sha from public.pin_session_job_git_input(
  (select (value->>'job_id')::uuid from execution_batch),1,(select run_id from revision_execution),
  '12b2c3d4-0001-4000-8000-000000000001','main',repeat('b',40))),repeat('b',40),
  'the actual revision start restores the inspected output commit, not the initial base');
select ok((select input.pinned_run_id=execution.run_id and input.pinned_attempt_count=1
  and input.source_checkpoint_run_id=target.run_id and input.input_ref=checkpoint.output_ref
  and input.initial_base_sha=repeat('a',40) and input.input_sha=repeat('b',40)
  from execution_batch batch join public.session_job_git_inputs input on input.job_id=(batch.value->>'job_id')::uuid
  cross join revision_execution execution cross join batch_targets target
  join public.session_git_checkpoints checkpoint on checkpoint.run_id=target.run_id where target.label='execution'),
  'binding the new attempt preserves reviewed checkpoint lineage and retained reachability');

-- Preserve the established manual-enqueue race: rejection can adopt an exact
-- queued generation whose initiator differs from the submitting reviewer.
select pg_temp.batch_fixture('adopt-queued');
create temp table manual_queued as select queued.* from batch_targets target
  cross join lateral public.enqueue_session_job_with_run(target.session_id,
    'b1b2c3d4-0001-4000-8000-000000000001',target.stage_id,
    'c1b2c3d4-0002-4000-8000-000000000002','manual_retry','codex','gpt-5.5','project') queued
  where target.label='adopt-queued';
create temp table adopted_batch as select pg_temp.batch_send('adopt-queued',gen_random_uuid(),'{}','Review queued manual work') as value;
select ok((select receipt.value->>'job_id'=queued.job_id::text and receipt.value->>'run_id'=queued.run_id::text
  and not (receipt.value->>'job_created')::boolean from adopted_batch receipt cross join manual_queued queued),
  'feedback adopts the already queued manual generation instead of creating competing work');
select ok((select job.requested_by_member_id='c1b2c3d4-0002-4000-8000-000000000002'::uuid
  and batch.requested_by_member_id='c1b2c3d4-0001-4000-8000-000000000001'::uuid
  and not batch.job_created and input.input_sha=repeat('b',40) and input.source_checkpoint_run_id=target.run_id
  from adopted_batch receipt join public.artifact_feedback_batches batch on batch.id=(receipt.value->>'feedback_batch_id')::uuid
  join public.agent_jobs job on job.id=batch.job_id join public.session_job_git_inputs input on input.job_id=job.id
  cross join batch_targets target where target.label='adopt-queued'),
  'adoption preserves the original initiator, validated submitting human, and reviewed checkpoint separately');
select is((select count(*) from public.artifact_feedback_batches where session_id=(select session_id from batch_targets where label='adopt-queued')),
  1::bigint,'adopting existing work still creates one immutable batch');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from batch_targets where label='adopt-queued')
  and status in('queued','started','running')),1::bigint,'queued-job adoption preserves one active generation');

-- A failure after the rejection mutates lifecycle rows must roll back both the
-- generation and immutable batch, including its idempotency identity.
select pg_temp.batch_fixture('rollback');
create function pg_temp.reject_feedback_batch_insert() returns trigger language plpgsql as $$
begin
  if new.session_id=(select session_id from batch_targets where label='rollback') then
    raise exception 'Injected batch persistence failure' using errcode='P0001';
  end if;
  return new;
end;
$$;
create trigger feedback_batch_rollback before insert on public.artifact_feedback_batches
  for each row execute function pg_temp.reject_feedback_batch_insert();
select is(pg_temp.batch_failure($q$select pg_temp.batch_send('rollback','50200000-0000-4000-8000-000000000099','{}','Retained draft')$q$)->>'code',
  'P0001','an injected batch persistence failure aborts the whole rejection');
select ok((select phase_status='awaiting_review' and rejection_count=0 from public.sessions
  where id=(select session_id from batch_targets where label='rollback')),
  'a failed atomic submission leaves the original artifact reviewable');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from batch_targets where label='rollback')),
  1::bigint,'a failed batch leaves only its completed producing generation');
select is((select count(*) from public.session_artifact_feedback where session_id=(select session_id from batch_targets where label='rollback')),
  0::bigint,'a failed batch leaves no partial whole-stage feedback');
drop trigger feedback_batch_rollback on public.artifact_feedback_batches;
select ok(pg_temp.batch_send('rollback','50200000-0000-4000-8000-000000000099','{}','Retained draft')->>'feedback_batch_id' is not null,
  'a rolled-back request UUID can be retried without a poisoned receipt');

-- A receipt survives later archival, while a genuinely new request cannot
-- mutate an archived session. RLS still limits receipt reads to active members.
select public.archive_session_job_attempts((select session_id from batch_targets where label='main'),
  'b1b2c3d4-0001-4000-8000-000000000001','Archive after accepted feedback');
select is(pg_temp.batch_send('main','50200000-0000-4000-8000-000000000001',
  array[(select id from batch_first_thread),(select id from batch_second_thread)],'Whole-stage request',
  (select token from batch_review_token)),(select value from batch_receipt),
  'an exact replay returns the original generation after archival without reviving it');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from batch_targets where label='main')
  and status in('queued','started','running')),0::bigint,'receipt replay does not resurrect archived revision work');
insert into auth.users(id,email) values('50200000-0000-4000-8000-000000000401','batch-outsider@example.test');
insert into public.workspaces(id,slug,name) values('50200000-0000-4000-8000-000000000402','batch-outsider','Batch outsider');
insert into public.workspace_members(id,workspace_id,user_id,kind,role,is_active) values
 ('50200000-0000-4000-8000-000000000403','50200000-0000-4000-8000-000000000402',
 '50200000-0000-4000-8000-000000000401','human','owner',true);
set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='50200000-0000-4000-8000-000000000401';
select is((select count(*) from public.artifact_feedback_batches where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'),
  0::bigint,'a foreign workspace member cannot read batch receipts');
select is((select count(*) from public.artifact_feedback_batch_threads where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'),
  0::bigint,'a foreign workspace member cannot read snapshotted comment bodies');
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';
select ok((select count(*) from public.artifact_feedback_batches where workspace_id='b1b2c3d4-0001-4000-8000-000000000001')>0,
  'active members can read their workspace batch history');
reset role;
set local request.jwt.claim.role='service_role';
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';
select is(pg_temp.batch_failure($q$select pg_temp.batch_send('invalid',gen_random_uuid(),'{}','Forged actor',null,
  '50200000-0000-4000-8000-000000000403')$q$)->>'code','42501',
  'an active human in another workspace cannot authorize this transition');
select pg_temp.batch_fixture('legacy-whole');
select ok((select rejection.job_id is not null from batch_targets target cross join lateral public.reject_session_stage(
  target.session_id,'b1b2c3d4-0001-4000-8000-000000000001',1,'Existing whole-stage request changes',
  'codex','gpt-5.5',target.stage_id,target.artifact_id,'project','c1b2c3d4-0001-4000-8000-000000000001') rejection
  where target.label='legacy-whole'),'the existing whole-stage rejection RPC remains supported');
select is((select count(*) from public.artifact_feedback_batches where session_id=(select session_id from batch_targets where label='legacy-whole')),
  0::bigint,'the legacy path does not fabricate an inline submission receipt');


-- OP-503: failures and replacement output cannot resolve a source request.
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
select pg_temp.batch_fixture('carry-forward');
create temp table carried_thread as select * from pg_temp.batch_thread('carry-forward','Blocking request from version one','blocking');
create temp table carried_batch as select pg_temp.batch_send('carry-forward',gen_random_uuid(),array[(select id from carried_thread)],'') as value;
create temp table carried_before as select rendered_feedback_text from public.artifact_feedback_batches where id=(select (value->>'feedback_batch_id')::uuid from carried_batch);
create temp table carried_first as select pg_temp.lifecycle_start((select (value->>'job_id')::uuid from carried_batch)) as run_id;
select is(public.fail_session_job_attempt((select (value->>'job_id')::uuid from carried_batch),1,'Injected revision failure',true,3,(select run_id from carried_first)),
  'queued','failed revision remains retryable in the same feedback generation');
select is((select status from public.artifact_review_threads where id=(select id from carried_thread)),'open','failed revision does not resolve the blocking request');
select is((select rendered_feedback_text from public.artifact_feedback_batches where id=(select (value->>'feedback_batch_id')::uuid from carried_batch)),
  (select rendered_feedback_text from carried_before),'failure retains the exact immutable submitted agent input');
create temp table carried_retry as select pg_temp.lifecycle_start((select (value->>'job_id')::uuid from carried_batch),2,repeat('b',40)) as run_id;
create temp table carried_output as select pg_temp.lifecycle_publish((select (value->>'job_id')::uuid from carried_batch),(select run_id from carried_retry),repeat('c',40),'Changed paragraph without the original selected text.') as artifact_id;
select is((select version from public.session_artifacts where id=(select artifact_id from carried_output)),2,'successful retry publishes version two');
select is((select status from public.artifact_review_threads where id=(select id from carried_thread)),'open','successful replacement output never resolves a blocking request');
select ok((select artifact_id=(select artifact_id from batch_targets where label='carry-forward') and artifact_version=1 and anchor=(select anchor from carried_thread)
  from public.artifact_review_threads where id=(select id from carried_thread)),'original author, selection and version remain bound to the original artifact');
create function pg_temp.carry_send(selected uuid[], expected_review bigint default null) returns jsonb language sql as $$
  select to_jsonb(receipt) from public.sessions s cross join lateral public.submit_artifact_feedback_batch(
    s.id,s.workspace_id,s.current_artifact_version,s.current_stage_id,s.current_artifact_id,
    coalesce(expected_review,s.artifact_review_revision),gen_random_uuid(),selected,'Please address the unresolved original request.',
    'codex','gpt-5.5','project','c1b2c3d4-0001-4000-8000-000000000001') receipt
  where s.id=(select session_id from batch_targets where label='carry-forward');
$$;
select is(pg_temp.batch_failure($q$select pg_temp.carry_send(array[(select id from invalid_thread)])$q$)->>'code','22023',
  'carried feedback cannot cross session or stage boundaries');
create temp table carry_token as select artifact_review_revision as revision from public.sessions where id=(select session_id from batch_targets where label='carry-forward');
select public.write_artifact_review_comment_once(gen_random_uuid(),'b1b2c3d4-0001-4000-8000-000000000001',(select id from carried_thread),'Explicitly added after version two');
select is(pg_temp.batch_failure($q$select pg_temp.carry_send(array[(select id from carried_thread)],(select revision from carry_token))$q$)->>'code','40001',
  'concurrent edits to a carried thread invalidate the current review token');
create temp table resubmitted as select pg_temp.carry_send(array[(select id from carried_thread)]) as value;
select ok((select batch.artifact_id=output.artifact_id and batch.artifact_version=2 and snapshot.artifact_id=original.artifact_id
  and snapshot.anchor=thread.anchor and snapshot.thread_revision=(select revision from public.artifact_review_threads where id=thread.id)
  and jsonb_array_length(snapshot.comments)=2 and batch.checkpoint_run_id=retry.run_id
  from public.artifact_feedback_batches batch join public.artifact_feedback_batch_threads snapshot on snapshot.batch_id=batch.id
  cross join carried_output output cross join carried_thread thread cross join carried_retry retry cross join batch_targets original
  where batch.id=(select (value->>'feedback_batch_id')::uuid from resubmitted) and original.label='carry-forward'),
  'explicit resubmission pins version two while snapshotting exact original version-one feedback and later replies');
select is((select rendered_feedback_text from public.artifact_feedback_batches where id=(select (value->>'feedback_batch_id')::uuid from carried_batch)),
  (select rendered_feedback_text from carried_before),'resubmitting never modifies the earlier batch');
select is((select status from public.artifact_review_threads where id=(select id from carried_thread)),'open','resubmission leaves status decisions to the human reviewer');


-- Manual retry is a new job, but it must consume and expose the same immutable
-- feedback generation after terminal failure or cancellation.
create function pg_temp.enqueue_feedback_retry(target_label text) returns uuid language plpgsql as $$
declare owner public.sessions; receipt record;
begin
  select s.* into strict owner from public.sessions s join batch_targets t on t.session_id=s.id where t.label=target_label;
  select * into strict receipt from public.enqueue_session_job_with_run(owner.id,owner.workspace_id,owner.current_stage_id,
    'c1b2c3d4-0001-4000-8000-000000000001','manual_retry','codex','gpt-5.5','project');
  return receipt.job_id;
end;
$$;
select ok(not has_table_privilege('authenticated','public.artifact_feedback_batch_jobs','INSERT')
  and not has_table_privilege('service_role','public.artifact_feedback_batch_jobs','UPDATE'),
  'clients and worker roles cannot fabricate or rewrite consumed feedback provenance');
select ok((select relrowsecurity from pg_class where oid='public.artifact_feedback_batch_jobs'::regclass),
  'feedback job associations enforce tenant RLS');
select ok((select reloptions @> array['security_invoker=true'] from pg_class where oid='public.artifact_feedback_outputs'::regclass),
  'accepted feedback outputs preserve underlying tenant RLS');
select pg_temp.batch_fixture('manual-feedback');
create temp table manual_thread as select * from pg_temp.batch_thread('manual-feedback','Original manual retry feedback','blocking');
create temp table manual_batch as select pg_temp.batch_send('manual-feedback',gen_random_uuid(),array[(select id from manual_thread)]) as value;
create temp table manual_batch_before as select to_jsonb(batch) as value from public.artifact_feedback_batches batch
  where id=(select (value->>'feedback_batch_id')::uuid from manual_batch);
create temp table terminal_attempt as select pg_temp.lifecycle_start((select (value->>'job_id')::uuid from manual_batch)) as run_id;
select is(public.fail_session_job_attempt((select (value->>'job_id')::uuid from manual_batch),1,'Exhausted revision',false,1,
  (select run_id from terminal_attempt)),'error','revision can exhaust automatic retries');
select public.write_artifact_review_comment_once(gen_random_uuid(),'b1b2c3d4-0001-4000-8000-000000000001',
  (select id from manual_thread),'This later reply must not enter the manually retried input');
create temp table manual_retry_job as select pg_temp.enqueue_feedback_retry('manual-feedback') as job_id;
select isnt((select job_id from manual_retry_job),(select (value->>'job_id')::uuid from manual_batch),'manual retry creates a distinct job');
select is((select count(*) from public.artifact_feedback_batch_jobs where job_id=(select job_id from manual_retry_job)),0::bigint,
  'queued manual work does not claim to have consumed feedback before owned start');
create temp table manual_retry_run as select pg_temp.lifecycle_start((select job_id from manual_retry_job),1,repeat('b',40)) as run_id;
select is((select batch_id from public.artifact_feedback_batch_jobs where job_id=(select job_id from manual_retry_job)),
  (select (value->>'feedback_batch_id')::uuid from manual_batch),'owned manual start binds the original feedback generation');
select is((select b.rendered_feedback_text from public.artifact_feedback_batch_jobs i join public.artifact_feedback_batches b on b.id=i.batch_id
  where i.job_id=(select job_id from manual_retry_job)),(select value->>'rendered_feedback_text' from manual_batch_before),
  'manual retry input remains exact despite later mutable replies');
create temp table manual_retry_output as select pg_temp.lifecycle_publish((select job_id from manual_retry_job),(select run_id from manual_retry_run),
  repeat('c',40),'Manual retry output') as artifact_id;
select ok((select o.batch_id=(select (value->>'feedback_batch_id')::uuid from manual_batch) and o.run_id=(select run_id from manual_retry_run)
  and o.artifact_version=2 from public.artifact_feedback_outputs o where o.artifact_id=(select artifact_id from manual_retry_output)),
  'manual retry output reverse-links its exact received feedback and producing run');
create temp table second_manual_job as select pg_temp.enqueue_feedback_retry('manual-feedback') as job_id;
create temp table second_manual_run as select pg_temp.lifecycle_start((select job_id from second_manual_job),1,repeat('c',40)) as run_id;
create temp table second_manual_output as select pg_temp.lifecycle_publish((select job_id from second_manual_job),(select run_id from second_manual_run),
  repeat('c',40),'Second output of the same feedback generation') as artifact_id;
select is((select count(*) from public.artifact_feedback_outputs where batch_id=(select (value->>'feedback_batch_id')::uuid from manual_batch)),
  2::bigint,'a feedback generation can expose multiple accepted outputs without choosing an arbitrary one');
select is(pg_temp.batch_failure($q$update public.artifact_feedback_batch_jobs set batch_id=batch_id where job_id=(select job_id from manual_retry_job)$q$)->>'code',
  '23514','consumed retry provenance cannot be rebound after execution');
-- A queued manual job may be adopted by a newer explicit review. Since it has
-- not consumed old feedback, the new batch remains the only authoritative link.
create temp table queued_for_adoption as select pg_temp.enqueue_feedback_retry('manual-feedback') as job_id;
create temp table adopted_new_feedback as select to_jsonb(receipt) as value from public.sessions s cross join lateral public.submit_artifact_feedback_batch(
  s.id,s.workspace_id,s.current_artifact_version,s.current_stage_id,s.current_artifact_id,s.artifact_review_revision,
  gen_random_uuid(),array[(select id from manual_thread)],'A new explicit review generation','codex','gpt-5.5','project',
  'c1b2c3d4-0001-4000-8000-000000000001') receipt where s.id=(select session_id from batch_targets where label='manual-feedback');
select ok((select (value->>'job_id')::uuid=(select job_id from queued_for_adoption) and not (value->>'job_created')::boolean from adopted_new_feedback),
  'new explicit feedback can still adopt queued manual work');
select is((select batch_id from public.artifact_feedback_batch_jobs where job_id=(select job_id from queued_for_adoption)),
  (select (value->>'feedback_batch_id')::uuid from adopted_new_feedback),'queued adoption binds the new explicit batch rather than stale feedback');
select is((select to_jsonb(b) from public.artifact_feedback_batches b where id=(select (value->>'feedback_batch_id')::uuid from manual_batch)),
  (select value from manual_batch_before),'manual retries and later reviews never mutate the earlier batch');
select pg_temp.batch_fixture('canceled-feedback');
create temp table canceled_thread as select * from pg_temp.batch_thread('canceled-feedback','Canceled revision input','blocking');
create temp table canceled_batch as select pg_temp.batch_send('canceled-feedback',gen_random_uuid(),array[(select id from canceled_thread)]) as value;
create temp table canceled_execution as select pg_temp.lifecycle_start((select (value->>'job_id')::uuid from canceled_batch)) as run_id;
select public.cancel_session_job_attempts((select session_id from batch_targets where label='canceled-feedback'),
  'b1b2c3d4-0001-4000-8000-000000000001','Cancel revision',(select run_id from canceled_execution));
create temp table canceled_retry as select pg_temp.enqueue_feedback_retry('canceled-feedback') as job_id;
create temp table canceled_retry_execution as select pg_temp.lifecycle_start((select job_id from canceled_retry),1,repeat('b',40)) as run_id;
select is((select batch_id from public.artifact_feedback_batch_jobs where job_id=(select job_id from canceled_retry)),
  (select (value->>'feedback_batch_id')::uuid from canceled_batch),'manual retry after cancellation preserves the exact feedback generation');
select is((select status from public.artifact_review_threads where id=(select id from canceled_thread)),'open',
  'cancellation and manual retry leave human blocking decisions open');
set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='50200000-0000-4000-8000-000000000401';
select is((select count(*) from public.artifact_feedback_batch_jobs),0::bigint,'foreign workspace cannot read retry provenance');
select is((select count(*) from public.artifact_feedback_outputs),0::bigint,'security-invoker output history cannot leak foreign accepted artifacts');
reset role;
set local request.jwt.claim.role='service_role';
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';

select * from finish();
rollback;
