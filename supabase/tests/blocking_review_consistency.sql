begin;
set local request.jwt.claim.role='service_role';
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
delete from public.sessions where id::text like 'af504000%';

-- Commit isolated fixtures so independent connections can exercise row locks.
insert into public.sessions(id,workspace_id,number,title,prompt_md,creator_member_id,pipeline_id,current_stage_id)
select ('af504000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  stage.workspace_id,99005040+n,'Review contention '||n,'Review decision lock proof',
  'c1b2c3d4-0001-4000-8000-000000000001',stage.pipeline_id,stage.id
from public.pipeline_stages stage join public.pipelines pipeline on pipeline.id=stage.pipeline_id
cross join generate_series(1,8) n
where stage.workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and pipeline.is_default and stage.slug='plan';
insert into public.session_selected_stages(session_id,workspace_id,stage_id)
select session.id,session.workspace_id,stage.id from public.sessions session
join public.pipeline_stages stage on stage.pipeline_id=session.pipeline_id
where session.id in (select id from public.sessions where id::text like 'af504000%')
on conflict do nothing;
insert into public.agent_jobs(id,workspace_id,session_id,stage_id,stage_slug,stage_name,trigger_type,status,attempt_count,git_continuity_release_revision)
select ('af504000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
  session.workspace_id,session.id,stage.id,stage.slug,stage.name,'assignment','running',1,
  (select revision from public.get_git_continuity_release_state())
from generate_series(1,8) n join public.sessions session on session.id=('af504000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
join public.pipeline_stages stage on stage.id=session.current_stage_id;
insert into public.agent_runs(id,workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,model_provider,model_name,run_type)
select ('af504000-0000-4000-8000-'||lpad((200+n)::text,12,'0'))::uuid,
  job.workspace_id,job.session_id,job.id,job.stage_id,job.stage_slug,job.stage_name,'codex','gpt-5.5','project'
from generate_series(1,8) n join public.agent_jobs job on job.id=('af504000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid;
do $$ declare fixture record; begin
  for fixture in select job.* from public.agent_jobs job
    where job.session_id in (select id from public.sessions where id::text like 'af504000%') loop
    perform public.start_session_job_attempt(fixture.id,1,fixture.stage_id,0,'codex','gpt-5.5','project');
    perform public.publish_session_job_attempt(fixture.id,1,(select id from public.agent_runs where agent_job_id=fixture.id),0,'Review this exact markdown');
  end loop;
end; $$;
update public.agent_runs set sandbox_id='review-delivery-still-running'
where session_id in (select id from public.sessions where id::text like 'af504000%');

-- Helpers use real public entry points, including user identity and receipts.
drop function if exists public.test_op504_review(integer,text,bigint);
create function public.test_op504_review(fixture integer, action text, expected_token bigint default 0)
returns text language plpgsql set search_path='' as $$
declare target public.sessions; artifact public.session_artifacts; thread public.artifact_review_threads; receipt record;
begin
  select * into strict target from public.sessions where id=('af504000-0000-4000-8000-'||lpad(fixture::text,12,'0'))::uuid;
  select * into strict artifact from public.session_artifacts where session_id=target.id and stage_slug='plan' and version=1;
  if action='approve' then
    select * into receipt from public.approve_session_stage(target.id,target.workspace_id,artifact.stage_id,artifact.id,1,
      'c1b2c3d4-0001-4000-8000-000000000001','codex','gpt-5.5','project',expected_token);
    return case when found then 'approved' else 'stale-artifact' end;
  elsif action in ('blocking','discussion') then
    thread:=public.create_artifact_review_thread_once(gen_random_uuid(),target.workspace_id,target.id,artifact.stage_id,artifact.id,1,
      '{"coordinateSystem":"unicode_code_points","start":0,"end":6,"quote":"Review","prefix":"","suffix":" this exact markdown"}',action,'Reviewer request');
    return 'created';
  else
    select * into strict thread from public.artifact_review_threads where session_id=target.id and kind='blocking';
    thread:=public.transition_artifact_review_thread_once(gen_random_uuid(),target.workspace_id,thread.id,thread.revision,action,
      'Human inspected the preserved code and explicitly changed the request.');
    return thread.status;
  end if;
exception when others then return sqlstate;
end;
$$;
commit;
begin;
set local request.jwt.claim.role='service_role';
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';
create function pg_temp.wait_op504_lock() returns void language plpgsql as $$
declare deadline timestamptz:=clock_timestamp()+interval '5 seconds';
begin
  while not exists(select 1 from pg_catalog.pg_stat_activity where application_name='op504_contender' and wait_event_type='Lock') loop
    if clock_timestamp()>deadline then raise exception 'Review contender did not wait on the session'; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;
select extensions.dblink_connect('op504_owner',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('op504_contender',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('op504_owner','set application_name=''op504_owner''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''; set request.jwt.claim.sub=''a1b2c3d4-0001-4000-8000-000000000001''');
select extensions.dblink_exec('op504_contender','set application_name=''op504_contender''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''; set request.jwt.claim.sub=''a1b2c3d4-0001-4000-8000-000000000001''');

-- Accepted blocker first: approval waits, then rejects the stale review token.
select extensions.dblink_exec('op504_owner','begin');
select is((select value from extensions.dblink('op504_owner',$$select public.test_op504_review(1,'blocking')$$) as r(value text)),'created','first reviewer creates a blocking request');
select extensions.dblink_send_query('op504_contender',$$select public.test_op504_review(1,'approve',0)$$);
select pg_temp.wait_op504_lock();
select extensions.dblink_exec('op504_owner','commit');
select is((select value from extensions.dblink_get_result('op504_contender') as r(value text)),'PT412','approval cannot use a token from before the accepted request');
select count(*) from extensions.dblink_get_result('op504_contender') as r(value text);
select is(public.test_op504_review(1,'approve',1),'PT409','a fresh token cannot bypass the blocker');
select is((select count(*) from public.session_phase_completions where session_id='af504000-0000-4000-8000-000000000001'),0::bigint,'blocked approval leaves no completion');
select is((select count(*) from public.artifact_review_threads where session_id='af504000-0000-4000-8000-000000000001' and status='open'),1::bigint,'the accepted blocking request is retained');

-- Approval first: delayed blocking creation fails rather than accepting lost feedback.
select extensions.dblink_exec('op504_owner','begin');
select is((select value from extensions.dblink('op504_owner',$$select public.test_op504_review(2,'approve',0)$$) as r(value text)),'approved','approval owns its transition');
select extensions.dblink_send_query('op504_contender',$$select public.test_op504_review(2,'blocking')$$);
select pg_temp.wait_op504_lock();
select extensions.dblink_exec('op504_owner','commit');
select is((select value from extensions.dblink_get_result('op504_contender') as r(value text)),'PT409','a completed stage rejects the racing new blocker');
select count(*) from extensions.dblink_get_result('op504_contender') as r(value text);
select is((select count(*) from public.artifact_review_threads where session_id='af504000-0000-4000-8000-000000000002'),0::bigint,'no unacknowledged blocker or receipt commits');
select is(public.test_op504_review(2,'discussion'),'created','discussion may annotate a completed stage without reopening it');
select is((select count(*) from public.agent_jobs where session_id='af504000-0000-4000-8000-000000000002' and status='queued'),1::bigint,'post-approval discussion does not enqueue another job');

-- Reopening first uses the same lock and invalidates approval.
select is(public.test_op504_review(3,'blocking'),'created','prepare a blocker to reopen');
select is(public.test_op504_review(3,'resolved'),'resolved','explicit resolution succeeds');
-- Fixture preparation must be visible to the independent connections.
commit;
begin;
set local request.jwt.claim.role='service_role';
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';
select extensions.dblink_exec('op504_owner','begin');
select is((select value from extensions.dblink('op504_owner',$$select public.test_op504_review(3,'open')$$) as r(value text)),'open','authorized reviewer reopens the blocker');
select extensions.dblink_send_query('op504_contender',$$select public.test_op504_review(3,'approve',2)$$);
select pg_temp.wait_op504_lock();
select extensions.dblink_exec('op504_owner','commit');
select is((select value from extensions.dblink_get_result('op504_contender') as r(value text)),'PT412','approval loses to accepted reopening');
select count(*) from extensions.dblink_get_result('op504_contender') as r(value text);
select is(public.test_op504_review(3,'approve',3),'PT409','reopened blocker continues to prevent approval');
select is(public.test_op504_review(4,'blocking'),'created','prepare a second blocker');
select is(public.test_op504_review(4,'superseded'),'superseded','supersession is explicit');
commit;
begin;
set local request.jwt.claim.role='service_role';
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';
select extensions.dblink_exec('op504_owner','begin');
select is((select value from extensions.dblink('op504_owner',$$select public.test_op504_review(4,'approve',2)$$) as r(value text)),'approved','approval can follow explicit supersession');
select extensions.dblink_send_query('op504_contender',$$select public.test_op504_review(4,'open')$$);
select pg_temp.wait_op504_lock();
select extensions.dblink_exec('op504_owner','commit');
select is((select value from extensions.dblink_get_result('op504_contender') as r(value text)),'PT409','a racing reopen fails after approval advances the stage');
select count(*) from extensions.dblink_get_result('op504_contender') as r(value text);
select is((select status from public.artifact_review_threads where session_id='af504000-0000-4000-8000-000000000004'),'superseded','failed reopening does not alter disposition');
select ok(exists(select 1 from public.artifact_review_events e join public.artifact_review_threads t on t.id=e.thread_id
  where t.session_id='af504000-0000-4000-8000-000000000004' and e.event_type='superseded'
    and e.actor_member_id='c1b2c3d4-0001-4000-8000-000000000001' and e.detail->>'reason' like 'Human inspected%'),
  'supersession retains human actor, prior status and reason in the audit trail');

-- Discussion changes also invalidate old review tokens, but do not block fresh approval.
select is(public.test_op504_review(5,'discussion'),'created','discussion is recorded');
select is(public.test_op504_review(5,'approve',0),'PT412','discussion changes invalidate an older inspected revision');
select is(public.test_op504_review(5,'approve',null),'PT412','omitting the review token fails closed');
select is(public.test_op504_review(5,'approve',1),'approved','open discussion does not block a current approval');

-- Closed sessions never reopen execution or accept blocking writes.
update public.sessions set phase_status='rejected' where id='af504000-0000-4000-8000-000000000006';
select is(public.test_op504_review(6,'blocking'),'PT409','canceled session rejects new feedback');
select is(public.test_op504_review(6,'approve',0),'stale-artifact','canceled session cannot approve');
update public.sessions set archived_at=clock_timestamp() where id='af504000-0000-4000-8000-000000000007';
select is(public.test_op504_review(7,'blocking'),'42501','archived session rejects review writes');
select is(public.test_op504_review(7,'approve',0),'stale-artifact','archived session cannot approve');
update public.sessions set phase_status='approved' where id='af504000-0000-4000-8000-000000000008';
select is(public.test_op504_review(8,'discussion'),'PT409','completed session is read-only even without archival');
select is(public.test_op504_review(8,'blocking'),'PT409','completed session cannot reopen blocking review');
select is((select count(*) from public.agent_jobs where session_id in (
 'af504000-0000-4000-8000-000000000006','af504000-0000-4000-8000-000000000007','af504000-0000-4000-8000-000000000008') and status='queued'),0::bigint,
 'terminal review mutations enqueue no work');
select extensions.dblink_disconnect('op504_owner');
select extensions.dblink_disconnect('op504_contender');
select * from finish();
commit;
begin;
set local request.jwt.claim.role='service_role';
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';
drop function public.test_op504_review(integer,text,bigint);
delete from public.sessions where id::text like 'af504000%';
commit;
