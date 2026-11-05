begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local "request.jwt.claim.role"='service_role';
insert into public.sessions(id,workspace_id,number,title,prompt_md,creator_member_id,pipeline_id,current_stage_id)
select '50100000-0000-4000-8000-000000000301',stage.workspace_id,99005010,'Review retry race','Review retry race',
 'c1b2c3d4-0001-4000-8000-000000000001',stage.pipeline_id,stage.id
from public.pipeline_stages stage join public.pipelines pipeline on pipeline.id=stage.pipeline_id
where stage.workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and pipeline.is_default and stage.slug='plan';
insert into public.session_artifacts(id,workspace_id,session_id,stage_id,stage_slug,version,artifact_json)
select '50100000-0000-4000-8000-000000000302',session.workspace_id,session.id,stage.id,stage.slug,1,to_jsonb('Concurrent review'::text)
from public.sessions session join public.pipeline_stages stage on stage.id=session.current_stage_id
where session.id='50100000-0000-4000-8000-000000000301';
create function public.test_inline_review_retry() returns uuid language sql set search_path='' as $$
 select (public.create_artifact_review_thread_once('50100000-0000-4000-8000-000000000303',
 'b1b2c3d4-0001-4000-8000-000000000001','50100000-0000-4000-8000-000000000301',
 (select current_stage_id from public.sessions where id='50100000-0000-4000-8000-000000000301'),
 '50100000-0000-4000-8000-000000000302',1,
 '{"coordinateSystem":"unicode_code_points","start":0,"end":10,"quote":"Concurrent","prefix":"","suffix":" review"}',
 'discussion','One overlapping comment')).id
$$;
create function public.test_pause_inline_review_retry() returns trigger language plpgsql set search_path='' as $$
begin
 if new.session_id='50100000-0000-4000-8000-000000000301'::uuid then
  perform pg_catalog.pg_advisory_xact_lock(99005010);
 end if;
 return new;
end;
$$;
create trigger test_pause_inline_review_retry before insert on public.artifact_review_threads
for each row execute function public.test_pause_inline_review_retry();
commit;
begin;
create function pg_temp.wait_inline_review_retry(target_application text,target_event text default null) returns void
language plpgsql as $$ declare deadline timestamptz:=clock_timestamp()+interval '5 seconds'; begin
 while not exists(select 1 from pg_catalog.pg_stat_activity where application_name=target_application
  and wait_event_type='Lock' and (target_event is null or wait_event=target_event)) loop
  if clock_timestamp()>deadline then raise exception 'Review retry did not reach lock boundary: %',target_application; end if;
  perform pg_catalog.pg_sleep(0.01);
 end loop;
end; $$;
select extensions.dblink_connect('inline_retry_gate',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('inline_retry_first',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('inline_retry_duplicate',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('inline_retry_first',
 'set application_name=''inline_retry_first''; set statement_timeout=''15s''; set role authenticated; set "request.jwt.claim.role"=''authenticated''; set "request.jwt.claim.sub"=''a1b2c3d4-0001-4000-8000-000000000001''');
select extensions.dblink_exec('inline_retry_duplicate',
 'set application_name=''inline_retry_duplicate''; set statement_timeout=''15s''; set role authenticated; set "request.jwt.claim.role"=''authenticated''; set "request.jwt.claim.sub"=''a1b2c3d4-0001-4000-8000-000000000001''');
select extensions.dblink_exec('inline_retry_gate','do $$ begin perform pg_advisory_lock(99005010); end $$');
select extensions.dblink_send_query('inline_retry_first','select public.test_inline_review_retry()');
select pg_temp.wait_inline_review_retry('inline_retry_first','advisory');
select extensions.dblink_send_query('inline_retry_duplicate','select public.test_inline_review_retry()');
select pg_temp.wait_inline_review_retry('inline_retry_duplicate');
select extensions.dblink_exec('inline_retry_gate','do $$ begin perform pg_advisory_unlock(99005010); end $$');
create temp table inline_retry_first as select * from extensions.dblink_get_result('inline_retry_first') as result(id uuid);
create temp table inline_retry_duplicate as select * from extensions.dblink_get_result('inline_retry_duplicate') as result(id uuid);
select is((select id from inline_retry_first),(select id from inline_retry_duplicate),'overlapping identical requests return the same thread');
select is((select count(*) from public.artifact_review_threads where session_id='50100000-0000-4000-8000-000000000301'),1::bigint,
 'concurrent retries persist one thread');
select is((select count(*) from public.artifact_review_comments where thread_id=(select id from inline_retry_first)),1::bigint,
 'concurrent retries persist one comment');
select is((select count(*) from public.artifact_review_events where thread_id=(select id from inline_retry_first)),1::bigint,
 'concurrent retries append one event');
select is((select artifact_review_revision from public.sessions where id='50100000-0000-4000-8000-000000000301'),1::bigint,
 'concurrent retries advance the review token once');
select is((select count(*) from internal.artifact_review_requests where session_id='50100000-0000-4000-8000-000000000301'),1::bigint,
 'concurrent retries retain one atomic response receipt');
select is((select count(*) from public.agent_jobs where session_id='50100000-0000-4000-8000-000000000301'),0::bigint,
 'overlapping comments never start execution');
select extensions.dblink_disconnect('inline_retry_gate');
select extensions.dblink_disconnect('inline_retry_first');
select extensions.dblink_disconnect('inline_retry_duplicate');
select * from finish();
commit;
begin;
drop trigger test_pause_inline_review_retry on public.artifact_review_threads;
drop function public.test_pause_inline_review_retry();
drop function public.test_inline_review_retry();
delete from public.sessions where id='50100000-0000-4000-8000-000000000301';
commit;
