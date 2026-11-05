begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role"='service_role';

insert into auth.users(id,email) values
 ('50100000-0000-4000-8000-000000000001','review-retry-owner@example.test'),
 ('50100000-0000-4000-8000-000000000002','review-retry-other@example.test');
insert into public.workspaces(id,slug,name) values
 ('50100000-0000-4000-8000-000000000010','review-idempotency','Review idempotency'),
 ('50100000-0000-4000-8000-000000000011','review-idempotency-other','Other workspace');
insert into public.workspace_members(id,workspace_id,user_id,kind,role,full_name) values
 ('50100000-0000-4000-8000-000000000101','50100000-0000-4000-8000-000000000010','50100000-0000-4000-8000-000000000001','human','owner','Reviewer'),
 ('50100000-0000-4000-8000-000000000102','50100000-0000-4000-8000-000000000011','50100000-0000-4000-8000-000000000002','human','owner','Other reviewer');
insert into public.pipelines(id,workspace_id,name) values
 ('50100000-0000-4000-8000-000000000020','50100000-0000-4000-8000-000000000010','Review');
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,anyone_can_approve) values
 ('50100000-0000-4000-8000-000000000030','50100000-0000-4000-8000-000000000020','50100000-0000-4000-8000-000000000010',1,'review','Review',false);
insert into public.sessions(id,workspace_id,number,title,pipeline_id,current_stage_id,phase_status) values
 ('50100000-0000-4000-8000-000000000040','50100000-0000-4000-8000-000000000010',1,'Review retry','50100000-0000-4000-8000-000000000020','50100000-0000-4000-8000-000000000030','awaiting_review'),
 ('50100000-0000-4000-8000-000000000041','50100000-0000-4000-8000-000000000010',2,'Other review retry','50100000-0000-4000-8000-000000000020','50100000-0000-4000-8000-000000000030','awaiting_review');
insert into public.session_artifacts(id,workspace_id,session_id,stage_id,stage_slug,version,artifact_json) values
 ('50100000-0000-4000-8000-000000000050','50100000-0000-4000-8000-000000000010','50100000-0000-4000-8000-000000000040','50100000-0000-4000-8000-000000000030','review',1,to_jsonb('Review this exact source.'::text)),
 ('50100000-0000-4000-8000-000000000051','50100000-0000-4000-8000-000000000010','50100000-0000-4000-8000-000000000041','50100000-0000-4000-8000-000000000030','review',1,to_jsonb('Review this exact source.'::text));
create function pg_temp.retry_create(request_id uuid,body text default 'Request a change',other_session boolean default false)
returns public.artifact_review_threads language sql as $$
 select public.create_artifact_review_thread_once(request_id,'50100000-0000-4000-8000-000000000010',
  case when other_session then '50100000-0000-4000-8000-000000000041'::uuid else '50100000-0000-4000-8000-000000000040'::uuid end,
  '50100000-0000-4000-8000-000000000030',
  case when other_session then '50100000-0000-4000-8000-000000000051'::uuid else '50100000-0000-4000-8000-000000000050'::uuid end,1,
  '{"coordinateSystem":"unicode_code_points","start":0,"end":6,"quote":"Review","prefix":"","suffix":" this exact source."}',
  'blocking',body)
$$;

select ok(exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
 and schemaname='public' and tablename='artifact_review_threads'),'threads publish changes for one bounded realtime subscription');
select ok(not has_table_privilege('authenticated','internal.artifact_review_requests','SELECT'),'members cannot inspect private retry receipts');
select ok(not has_table_privilege('service_role','internal.artifact_review_requests','INSERT'),'service callers cannot forge retry receipts');
select ok(not has_function_privilege('authenticated','public.create_artifact_review_thread(uuid,uuid,uuid,uuid,integer,jsonb,text,text)','EXECUTE'),
 'old non-idempotent creation path is no longer callable');
select ok(not has_function_privilege('authenticated','public.write_artifact_review_comment(uuid,uuid,text,uuid,integer)','EXECUTE'),
 'old non-idempotent comment path is no longer callable');
select ok(not has_function_privilege('authenticated','public.transition_artifact_review_thread(uuid,uuid,integer,text,text)','EXECUTE'),
 'old non-idempotent lifecycle path is no longer callable');
select ok(not has_function_privilege('service_role','public.create_artifact_review_thread_once(uuid,uuid,uuid,uuid,uuid,integer,jsonb,text,text)','EXECUTE'),
 'service identity cannot create human feedback through retry RPCs');
set local role authenticated;
set local "request.jwt.claim.role"='authenticated';
set local "request.jwt.claim.sub"='50100000-0000-4000-8000-000000000001';
create temp table retry_thread as select * from pg_temp.retry_create('50100000-0000-4000-8000-000000000201');
select is(to_jsonb(pg_temp.retry_create('50100000-0000-4000-8000-000000000201')),
 (select to_jsonb(t) from retry_thread t),'creation retry returns the exact durable original response');
select is((select count(*) from public.artifact_review_threads where session_id='50100000-0000-4000-8000-000000000040'),1::bigint,
 'creation retry does not duplicate a thread');
select is((select count(*) from public.artifact_review_comments where thread_id=(select id from retry_thread)),1::bigint,
 'creation retry does not duplicate its initial comment');
select is((select count(*) from public.artifact_review_events where thread_id=(select id from retry_thread)),1::bigint,
 'creation retry does not append duplicate history');
select is((select artifact_review_revision from public.sessions where id='50100000-0000-4000-8000-000000000040'),1::bigint,
 'creation retry does not increment review revision');
select throws_ok($$select pg_temp.retry_create('50100000-0000-4000-8000-000000000201','Changed content')$$,
 '23505','Review request id was already used with different content.','a retry key cannot silently accept different content');
select throws_ok($$select pg_temp.retry_create('50100000-0000-4000-8000-000000000201','Request a change',true)$$,
 '23505','Review request id was already used with different content.','one actor request id cannot cross session boundaries');
select throws_ok($$select public.write_artifact_review_comment_once('50100000-0000-4000-8000-000000000201',
 '50100000-0000-4000-8000-000000000010',(select id from retry_thread),'Reply')$$,
 '23505','Review request id was already used with different content.','one retry key cannot be reused for another operation');
select throws_ok($$select pg_temp.retry_create(null)$$,'22023','Review request id is required.','missing retry IDs fail before mutation');

create temp table retry_comment as select * from public.write_artifact_review_comment_once(
 '50100000-0000-4000-8000-000000000202','50100000-0000-4000-8000-000000000010',(select id from retry_thread),'Reply');
select is(to_jsonb(public.write_artifact_review_comment_once('50100000-0000-4000-8000-000000000202',
 '50100000-0000-4000-8000-000000000010',(select id from retry_thread),'Reply')),
 (select to_jsonb(c) from retry_comment c),'reply retry returns its original comment');
select is((select count(*) from public.artifact_review_comments where thread_id=(select id from retry_thread)),2::bigint,
 'reply retries cannot create duplicate comments');
create temp table retry_edit as select * from public.write_artifact_review_comment_once(
 '50100000-0000-4000-8000-000000000203','50100000-0000-4000-8000-000000000010',(select id from retry_thread),
 'Edited reply',(select id from retry_comment),1);
select is((select revision from retry_edit),2,'first edit advances its optimistic revision');
select is(to_jsonb(public.write_artifact_review_comment_once('50100000-0000-4000-8000-000000000203',
 '50100000-0000-4000-8000-000000000010',(select id from retry_thread),'Edited reply',(select id from retry_comment),1)),
 (select to_jsonb(c) from retry_edit c),'lost edit response recovers even though its expected revision is now stale');
select is((public.write_artifact_review_comment_once('50100000-0000-4000-8000-000000000204',
 '50100000-0000-4000-8000-000000000010',(select id from retry_thread),'Third revision',(select id from retry_comment),2)).revision,3,
 'a later edit can advance the same comment');
select is((public.write_artifact_review_comment_once('50100000-0000-4000-8000-000000000203',
 '50100000-0000-4000-8000-000000000010',(select id from retry_thread),'Edited reply',(select id from retry_comment),1)).body,
 'Edited reply','old retry result is immutable after a later comment edit');
select is((select revision from public.artifact_review_comments where id=(select id from retry_comment)),3,
 'recovering an older response never rewinds current comment content');
select is((pg_temp.retry_create('50100000-0000-4000-8000-000000000201')).revision,1,
 'a retried creation retains the original thread response despite later replies');
select throws_ok($$select public.write_artifact_review_comment_once('50100000-0000-4000-8000-000000000205',
 '50100000-0000-4000-8000-000000000010',(select id from retry_thread),'Stale edit',(select id from retry_comment),1)$$,
 '40001','Review comment revision is stale.','fresh retry keys do not bypass optimistic concurrency');
select is((public.write_artifact_review_comment_once('50100000-0000-4000-8000-000000000205',
 '50100000-0000-4000-8000-000000000010',(select id from retry_thread),'Accepted after conflict',(select id from retry_comment),3)).revision,4,
 'a failed mutation does not leave a reserved receipt or duplicate side effects');

create temp table retry_transition_input as select revision from public.artifact_review_threads where id=(select id from retry_thread);
create temp table retry_transition as select * from public.transition_artifact_review_thread_once(
 '50100000-0000-4000-8000-000000000206','50100000-0000-4000-8000-000000000010',(select id from retry_thread),
 (select revision from retry_transition_input),'resolved','Verified by a human');
select is(to_jsonb(public.transition_artifact_review_thread_once('50100000-0000-4000-8000-000000000206',
 '50100000-0000-4000-8000-000000000010',(select id from retry_thread),(select revision from retry_transition_input),'resolved','Verified by a human')),
 (select to_jsonb(t) from retry_transition t),'lifecycle retries recover the accepted response without a stale CAS error');
select is((public.transition_artifact_review_thread_once('50100000-0000-4000-8000-000000000207',
 '50100000-0000-4000-8000-000000000010',(select id from retry_thread),(select revision from retry_transition),'open','Reopened by a human')).status,
 'open','later explicit lifecycle change remains possible');
select is((public.transition_artifact_review_thread_once('50100000-0000-4000-8000-000000000206',
 '50100000-0000-4000-8000-000000000010',(select id from retry_thread),(select revision from retry_transition_input),'resolved','Verified by a human')).status,
 'resolved','lifecycle response receipt remains original after later reopening');
select is((select status from public.artifact_review_threads where id=(select id from retry_thread)),'open',
 'recovering a lifecycle receipt does not apply that transition again');
reset role;
update public.pipeline_stages set approver_member_ids='{}',anyone_can_approve=false where id='50100000-0000-4000-8000-000000000030';
update public.workspace_members set role='member' where id='50100000-0000-4000-8000-000000000101';
set local role authenticated;
select throws_ok($$select public.transition_artifact_review_thread_once('50100000-0000-4000-8000-000000000206',
 '50100000-0000-4000-8000-000000000010',(select id from retry_thread),(select revision from retry_transition_input),'resolved','Verified by a human')$$,
 '42501','Authorized human reviewer required.','receipt recovery cannot revive revoked lifecycle authority');
reset role;
update public.workspace_members set role='owner',is_active=false where id='50100000-0000-4000-8000-000000000101';
set local role authenticated;
select throws_ok($$select pg_temp.retry_create('50100000-0000-4000-8000-000000000201')$$,
 '42501','Active human membership required.','inactive members cannot replay earlier successful requests');
reset role;
update public.workspace_members set is_active=true where id='50100000-0000-4000-8000-000000000101';
update public.sessions set archived_at=now() where id='50100000-0000-4000-8000-000000000040';
set local role authenticated;
select throws_ok($$select public.write_artifact_review_comment_once('50100000-0000-4000-8000-000000000202',
 '50100000-0000-4000-8000-000000000010',(select id from retry_thread),'Reply')$$,
 '42501','Review session is unavailable.','archived sessions are read-only even for a retry receipt');
reset role;
update public.sessions set archived_at=null where id='50100000-0000-4000-8000-000000000040';
set local role authenticated;
set local "request.jwt.claim.sub"='50100000-0000-4000-8000-000000000002';
select throws_ok($$select pg_temp.retry_create('50100000-0000-4000-8000-000000000201')$$,
 '42501','Active human membership required.','foreign members cannot recover another workspace response');
reset role;
select is((select count(*) from public.agent_jobs where session_id='50100000-0000-4000-8000-000000000040'),0::bigint,
 'commenting and retrying never enqueue execution');
select is((select count(*) from public.agent_runs where session_id='50100000-0000-4000-8000-000000000040'),0::bigint,
 'commenting and retrying never create runs');
select is((select count(*) from internal.artifact_review_requests where workspace_id='50100000-0000-4000-8000-000000000010'),7::bigint,
 'exactly one private receipt exists per accepted mutation');
select is((select count(*) from internal.artifact_review_requests where response is null),0::bigint,
 'completed transactions never retain incomplete response receipts');
select * from finish();
rollback;
