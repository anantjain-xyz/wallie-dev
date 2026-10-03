begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

-- Fixtures are committed so independent sessions can contend on actual locks.
-- Keep this namespace separate from all other committed concurrency fixtures.
insert into public.sessions(id,workspace_id,number,title,prompt_md,creator_member_id,
  pipeline_id,current_stage_id,linear_issue_id,phase_status,current_artifact_version)
select ('a9000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  stage.workspace_id,99006030+n,'Linear contention '||n,'Linear observation lock proof',
  'c1b2c3d4-0001-4000-8000-000000000001',stage.pipeline_id,stage.id,
  'LINEAR-CONCURRENCY-'||n,'awaiting_review',1
from public.pipeline_stages stage join public.pipelines pipeline on pipeline.id=stage.pipeline_id
cross join generate_series(1,4) n
where stage.workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and pipeline.is_default and stage.slug='plan';
insert into public.session_selected_stages(session_id,workspace_id,stage_id)
select session.id,session.workspace_id,stage.id from public.sessions session
join public.pipeline_stages stage on stage.pipeline_id=session.pipeline_id
where session.id in (select ('a9000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,4) n)
on conflict do nothing;
-- Fixture four has no selected Land execution, so Done is a terminal decision.
delete from public.session_selected_stages selection using public.pipeline_stages stage
where selection.session_id='a9000000-0000-4000-8000-000000000004'
  and selection.stage_id=stage.id and stage.slug='land';
insert into public.agent_jobs(id,workspace_id,session_id,stage_id,stage_slug,stage_name,trigger_type,status,dedupe_key)
select ('a9000000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
  session.workspace_id,session.id,stage.id,stage.slug,stage.name,'assignment','queued','session:'||session.id::text||':active'
from generate_series(1,4) n join public.sessions session on session.id=('a9000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
join public.pipeline_stages stage on stage.id=session.current_stage_id;
insert into public.agent_runs(id,workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,model_provider,model_name,run_type)
select ('a9000000-0000-4000-8000-'||lpad((200+n)::text,12,'0'))::uuid,
  job.workspace_id,job.session_id,job.id,job.stage_id,job.stage_slug,job.stage_name,'codex','gpt-5.5','project'
from generate_series(1,4) n join public.agent_jobs job on job.id=('a9000000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid;
insert into public.session_artifacts(id,workspace_id,session_id,stage_id,stage_slug,version,artifact_json)
select ('a9000000-0000-4000-8000-'||lpad((300+n)::text,12,'0'))::uuid,
  job.workspace_id,job.session_id,job.stage_id,job.stage_slug,1,to_jsonb('Retained review markdown'::text)
from generate_series(1,4) n join public.agent_jobs job on job.id=('a9000000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid;

create function public.test_linear_transition(fixture integer,span integer,status_name text)
returns table(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid)
language plpgsql set search_path='' as $$
declare snapshot public.sessions%rowtype; config_updated_at timestamptz; source_started_at timestamptz;
begin
  -- Capture the poll's snapshots before trying to take the transition lock.
  select * into snapshot from public.sessions where id=('a9000000-0000-4000-8000-'||lpad(fixture::text,12,'0'))::uuid;
  select updated_at into config_updated_at from public.workspace_linear_routing where workspace_id=snapshot.workspace_id;
  -- Fixture-relative immutable times are later than the creation baseline and
  -- remain identical across retries, regardless of how long the race takes.
  source_started_at:=snapshot.created_at+make_interval(secs=>span);
  return query select * from public.apply_linear_session_transition(
    snapshot.id,snapshot.workspace_id,snapshot.linear_issue_id,snapshot.updated_at,config_updated_at,
    'contention-'||fixture||'-'||span,source_started_at,'state-'||status_name,source_started_at,
    status_name,'codex','gpt-5.5','project');
end; $$;
create function public.test_linear_manual_archive()
returns table(job_ids uuid[],run_ids uuid[],archived_at timestamptz)
language sql set search_path='' as $$
  with archived as materialized (
    select * from public.archive_session_job_attempts('a9000000-0000-4000-8000-000000000004',
      'b1b2c3d4-0001-4000-8000-000000000001','Concurrent manual archive',false)
  ) select archived.job_ids,archived.run_ids,now() from archived;
$$;
create function public.test_linear_transition_gate() returns trigger
language plpgsql set search_path='' as $$ begin
  if tg_table_name='session_linear_transition_receipts' then
    if new.session_id='a9000000-0000-4000-8000-000000000001'::uuid and new.source_span_id='contention-1-10' then
      perform pg_catalog.pg_advisory_xact_lock(99006031);
    elsif new.session_id='a9000000-0000-4000-8000-000000000002'::uuid and new.source_span_id='contention-2-20' then
      perform pg_catalog.pg_advisory_xact_lock(99006032);
    elsif new.session_id='a9000000-0000-4000-8000-000000000003'::uuid and new.source_span_id='contention-3-10' then
      perform pg_catalog.pg_advisory_xact_lock(99006033);
    end if;
  elsif tg_table_name='sessions' and new.id='a9000000-0000-4000-8000-000000000004'::uuid
      and old.archived_at is null and new.archived_at is not null then
    perform pg_catalog.pg_advisory_xact_lock(99006034);
  end if;
  return new;
end; $$;
create trigger linear_receipt_contention_gate before update on internal.session_linear_transition_receipts
for each row execute function public.test_linear_transition_gate();
create trigger linear_archive_contention_gate before update of archived_at on public.sessions
for each row execute function public.test_linear_transition_gate();
commit;
begin;

create function pg_temp.wait_linear_lock(target_application text,target_event text default null) returns void
language plpgsql as $$ declare deadline timestamptz:=clock_timestamp()+interval '5 seconds'; begin
  while not exists(select 1 from pg_catalog.pg_stat_activity where application_name=target_application
    and wait_event_type='Lock' and (target_event is null or wait_event=target_event)) loop
    if clock_timestamp()>deadline then raise exception 'Expected Linear lock boundary not reached by %',target_application; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end; $$;
select extensions.dblink_connect('linear_gate',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('linear_owner',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('linear_contender',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('linear_owner','set application_name=''linear_owner''; set statement_timeout=''15s''; set "request.jwt.claim.role"=''service_role''');
select extensions.dblink_exec('linear_contender','set application_name=''linear_contender''; set statement_timeout=''15s''; set "request.jwt.claim.role"=''service_role''');

-- Duplicate Rework deliveries overlap after the winner has canceled/queued but
-- before its receipt commits. The loser must never cancel the new replacement.
select extensions.dblink_exec('linear_gate','do $$ begin perform pg_advisory_lock(99006031); end $$');
select extensions.dblink_send_query('linear_owner','select * from public.test_linear_transition(1,10,''Rework'')');
select pg_temp.wait_linear_lock('linear_owner','advisory');
select extensions.dblink_send_query('linear_contender','select * from public.test_linear_transition(1,10,''Rework'')');
select pg_temp.wait_linear_lock('linear_contender');
select is((select count(*) from public.agent_jobs where session_id='a9000000-0000-4000-8000-000000000001'),1::bigint,'uncommitted route does not expose a replacement without its receipt');
select is((select source_span_id from internal.session_linear_transition_receipts where session_id='a9000000-0000-4000-8000-000000000001'),null::text,'uncommitted route does not expose a receipt without its replacement');
select extensions.dblink_exec('linear_gate','do $$ begin perform pg_advisory_unlock(99006031); end $$');
create temp table first_rework as select * from extensions.dblink_get_result('linear_owner') as result(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid);
create temp table duplicate_rework as select * from extensions.dblink_get_result('linear_contender') as result(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid);
select is((select outcome from first_rework),'routed','first overlapping Rework commits');
select is((select outcome from duplicate_rework),'stale','duplicate poll with old session snapshot fails closed');
select is((select job_ids from first_rework),array['a9000000-0000-4000-8000-000000000101'::uuid],'winner returns only the predecessor job for cleanup');
select is((select run_ids from first_rework),array['a9000000-0000-4000-8000-000000000201'::uuid],'winner returns only the predecessor run for cleanup');
select is((select job_ids from duplicate_rework),'{}'::uuid[],'losing poll returns no job for cleanup');
select is((select run_ids from duplicate_rework),'{}'::uuid[],'losing poll returns no run for cleanup');
select is((select count(*) from public.agent_jobs where session_id='a9000000-0000-4000-8000-000000000001'),2::bigint,'duplicate delivery creates exactly one replacement job');
select is((select count(*) from public.agent_runs where session_id='a9000000-0000-4000-8000-000000000001'),2::bigint,'duplicate delivery creates exactly one replacement run');
select is((select status::text from public.agent_jobs where id=(select job_id from first_rework)),'queued','loser preserves winner replacement');
select is((select outcome from public.test_linear_transition(1,10,'Rework')),'duplicate','fresh replay consumes the existing receipt without rerouting');
select count(*) from extensions.dblink_get_result('linear_owner') as result(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid);
select count(*) from extensions.dblink_get_result('linear_contender') as result(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid);

-- Pause observations change only the receipt, not session.updated_at. This race
-- therefore proves source ordering itself rather than only the snapshot CAS.
select extensions.dblink_exec('linear_gate','do $$ begin perform pg_advisory_lock(99006032); end $$');
select extensions.dblink_send_query('linear_owner','select * from public.test_linear_transition(2,20,''In Review'')');
select pg_temp.wait_linear_lock('linear_owner','advisory');
select extensions.dblink_send_query('linear_contender','select * from public.test_linear_transition(2,10,''Rework'')');
select pg_temp.wait_linear_lock('linear_contender');
select extensions.dblink_exec('linear_gate','do $$ begin perform pg_advisory_unlock(99006032); end $$');
create temp table newer_observation as select * from extensions.dblink_get_result('linear_owner') as result(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid);
create temp table older_observation as select * from extensions.dblink_get_result('linear_contender') as result(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid);
select is((select outcome from newer_observation),'observed','newer pause span wins the session lock');
select is((select outcome from older_observation),'stale','older source span cannot reroute after waiting for a newer receipt');
select is((select source_span_id from internal.session_linear_transition_receipts where session_id='a9000000-0000-4000-8000-000000000002'),'contention-2-20','older source cannot move receipt backward');
select is((select count(*) from public.agent_jobs where session_id='a9000000-0000-4000-8000-000000000002'),1::bigint,'stale source creates no replacement');
select is((select status::text from public.agent_jobs where id='a9000000-0000-4000-8000-000000000102'),'queued','stale source cannot cancel existing work');
select is((select phase_status::text from public.sessions where id='a9000000-0000-4000-8000-000000000002'),'awaiting_review','pause and stale route preserve review');
select count(*) from extensions.dblink_get_result('linear_owner') as result(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid);
select count(*) from extensions.dblink_get_result('linear_contender') as result(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid);

-- Reverse source arrival: the older pause commits first, then a newer Rework
-- must still be accepted, producing one replacement and the latest receipt.
select extensions.dblink_exec('linear_gate','do $$ begin perform pg_advisory_lock(99006033); end $$');
select extensions.dblink_send_query('linear_owner','select * from public.test_linear_transition(3,10,''In Review'')');
select pg_temp.wait_linear_lock('linear_owner','advisory');
select extensions.dblink_send_query('linear_contender','select * from public.test_linear_transition(3,20,''Rework'')');
select pg_temp.wait_linear_lock('linear_contender');
select extensions.dblink_exec('linear_gate','do $$ begin perform pg_advisory_unlock(99006033); end $$');
create temp table older_first as select * from extensions.dblink_get_result('linear_owner') as result(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid);
create temp table newer_second as select * from extensions.dblink_get_result('linear_contender') as result(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid);
select is((select outcome from older_first),'observed','older pause may commit first');
select is((select outcome from newer_second),'routed','newer source remains applicable after waiting');
select is((select source_span_id from internal.session_linear_transition_receipts where session_id='a9000000-0000-4000-8000-000000000003'),'contention-3-20','both lock orders preserve the latest source receipt');
select is((select count(*) from public.agent_jobs where session_id='a9000000-0000-4000-8000-000000000003' and status in('queued','started','running')),1::bigint,'reverse source order leaves exactly one active replacement');
select is((select stage_slug from public.agent_runs where id=(select run_id from newer_second)),'build','accepted replacement has the configured Rework stage');
select count(*) from extensions.dblink_get_result('linear_owner') as result(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid);
select count(*) from extensions.dblink_get_result('linear_contender') as result(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid);

-- The poll captured an active session before a manual archive wins its lock.
-- Done still records completion without reopening work or changing the marker.
select extensions.dblink_exec('linear_gate','do $$ begin perform pg_advisory_lock(99006034); end $$');
select extensions.dblink_send_query('linear_owner','select * from public.test_linear_manual_archive()');
select pg_temp.wait_linear_lock('linear_owner','advisory');
select extensions.dblink_send_query('linear_contender','select * from public.test_linear_transition(4,10,''Done'')');
select pg_temp.wait_linear_lock('linear_contender');
select extensions.dblink_exec('linear_gate','do $$ begin perform pg_advisory_unlock(99006034); end $$');
create temp table archive_first as select * from extensions.dblink_get_result('linear_owner') as result(job_ids uuid[],run_ids uuid[],archived_at timestamptz);
create temp table done_second as select * from extensions.dblink_get_result('linear_contender') as result(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid);
select is((select outcome from done_second),'completed','Done completes a session archived while the poll waited');
select is((select phase_status::text from public.sessions where id='a9000000-0000-4000-8000-000000000004'),'approved','Done promotes archived review to approved');
select is((select archived_at from public.sessions where id='a9000000-0000-4000-8000-000000000004'),(select archived_at from archive_first),'Done preserves the first archive timestamp');
select is((select job_ids from archive_first),array['a9000000-0000-4000-8000-000000000104'::uuid],'manual archive returns its exact canceled job');
select is((select run_ids from archive_first),array['a9000000-0000-4000-8000-000000000204'::uuid],'manual archive returns its exact canceled run');
select is((select job_id from done_second),null::uuid,'Done does not enqueue archived work');
select is((select count(*) from public.agent_jobs where session_id='a9000000-0000-4000-8000-000000000004' and status in('queued','started','running')),0::bigint,'archive race leaves no active work');
select is((select source_span_id from internal.session_linear_transition_receipts where session_id='a9000000-0000-4000-8000-000000000004'),'contention-4-10','completion and Done receipt commit together');
select is((select count(*) from public.session_artifacts where id in (select ('a9000000-0000-4000-8000-'||lpad((300+n)::text,12,'0'))::uuid from generate_series(1,4) n)),4::bigint,'all concurrent transitions preserve immutable artifacts');

select extensions.dblink_disconnect('linear_gate');
select extensions.dblink_disconnect('linear_owner');
select extensions.dblink_disconnect('linear_contender');
select * from finish();
commit;
begin;
drop trigger linear_receipt_contention_gate on internal.session_linear_transition_receipts;
drop trigger linear_archive_contention_gate on public.sessions;
drop function public.test_linear_transition_gate();
drop function public.test_linear_transition(integer,integer,text);
drop function public.test_linear_manual_archive();
delete from public.sessions where id in (select ('a9000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,4) n);
commit;
