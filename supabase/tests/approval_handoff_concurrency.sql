begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

-- Commit isolated fixtures so independent connections can exercise row locks.
insert into public.sessions(id,workspace_id,number,title,prompt_md,creator_member_id,pipeline_id,current_stage_id)
select ('af000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  stage.workspace_id,99003030+n,'Review contention '||n,'Review decision lock proof',
  'c1b2c3d4-0001-4000-8000-000000000001',stage.pipeline_id,stage.id
from public.pipeline_stages stage join public.pipelines pipeline on pipeline.id=stage.pipeline_id
cross join generate_series(1,3) n
where stage.workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and pipeline.is_default and stage.slug='plan';
insert into public.session_selected_stages(session_id,workspace_id,stage_id)
select session.id,session.workspace_id,stage.id from public.sessions session
join public.pipeline_stages stage on stage.pipeline_id=session.pipeline_id
where session.id in ('af000000-0000-4000-8000-000000000001','af000000-0000-4000-8000-000000000002','af000000-0000-4000-8000-000000000003')
on conflict do nothing;
insert into public.agent_jobs(id,workspace_id,session_id,stage_id,stage_slug,stage_name,trigger_type,status,attempt_count)
select ('af000000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
  session.workspace_id,session.id,stage.id,stage.slug,stage.name,'assignment','running',1
from generate_series(1,3) n join public.sessions session on session.id=('af000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
join public.pipeline_stages stage on stage.id=session.current_stage_id;
insert into public.agent_runs(id,workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,model_provider,model_name,run_type)
select ('af000000-0000-4000-8000-'||lpad((200+n)::text,12,'0'))::uuid,
  job.workspace_id,job.session_id,job.id,job.stage_id,job.stage_slug,job.stage_name,'codex','gpt-5.5','project'
from generate_series(1,3) n join public.agent_jobs job on job.id=('af000000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid;
do $$ declare fixture record; begin
  for fixture in select job.* from public.agent_jobs job
    where job.session_id in ('af000000-0000-4000-8000-000000000001','af000000-0000-4000-8000-000000000002','af000000-0000-4000-8000-000000000003') loop
    perform public.start_session_job_attempt(fixture.id,1,fixture.stage_id,0,'codex','gpt-5.5','project');
    perform public.publish_session_job_attempt(fixture.id,1,(select id from public.agent_runs where agent_job_id=fixture.id),0,'Review this exact markdown');
  end loop;
end; $$;
update public.agent_runs set sandbox_id='review-delivery-still-running'
where session_id in ('af000000-0000-4000-8000-000000000001','af000000-0000-4000-8000-000000000002','af000000-0000-4000-8000-000000000003');

create function public.test_review_decision(fixture integer,decision text) returns text
language plpgsql set search_path='' as $$
declare original_job public.agent_jobs%rowtype; artifact_id uuid; receipt record;
begin
  select * into original_job from public.agent_jobs
    where id=('af000000-0000-4000-8000-'||lpad((100+fixture)::text,12,'0'))::uuid;
  select artifact.id into artifact_id from public.session_artifacts artifact
    where artifact.session_id=original_job.session_id and artifact.stage_id=original_job.stage_id and artifact.version=1;
  if decision='approve' then
    select * into receipt from public.approve_session_stage(original_job.session_id,original_job.workspace_id,
      original_job.stage_id,artifact_id,1,'c1b2c3d4-0001-4000-8000-000000000001','codex','gpt-5.5','project');
    if not found then return 'stale'; end if;
    return 'approved';
  end if;
  select * into receipt from public.reject_session_stage(original_job.session_id,original_job.workspace_id,1,
    'Revise this markdown','codex','gpt-5.5',original_job.stage_id,artifact_id,'project','c1b2c3d4-0001-4000-8000-000000000001');
  return 'rejected';
exception when sqlstate '55000' then return 'stale';
end; $$;
create function public.test_review_decision_gate() returns trigger
language plpgsql set search_path='' as $$ begin
  if tg_table_name='session_phase_completions' then
    if new.session_id='af000000-0000-4000-8000-000000000001'::uuid then
      perform pg_catalog.pg_advisory_xact_lock(99003031);
    elsif new.session_id='af000000-0000-4000-8000-000000000002'::uuid then
      perform pg_catalog.pg_advisory_xact_lock(99003032);
    end if;
  elsif tg_table_name='agent_jobs' and new.session_id='af000000-0000-4000-8000-000000000003'::uuid and new.status='queued' then
    perform pg_catalog.pg_advisory_xact_lock(99003033);
  end if;
  return new;
end; $$;
create trigger review_approval_gate before insert on public.session_phase_completions
for each row execute function public.test_review_decision_gate();
create trigger review_rejection_gate before insert on public.agent_jobs
for each row execute function public.test_review_decision_gate();
commit;
begin;
create function pg_temp.wait_review_lock(target_application text,target_event text default null) returns void
language plpgsql as $$ declare deadline timestamptz:=clock_timestamp()+interval '5 seconds'; begin
  while not exists(select 1 from pg_catalog.pg_stat_activity where application_name=target_application
    and wait_event_type='Lock' and (target_event is null or wait_event=target_event)) loop
    if clock_timestamp()>deadline then raise exception 'Expected review lock boundary not reached by %',target_application; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end; $$;
select extensions.dblink_connect('review_gate',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('review_owner',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('review_contender',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('review_owner','set application_name=''review_owner''; set statement_timeout=''15s''');
select extensions.dblink_exec('review_contender','set application_name=''review_contender''; set statement_timeout=''15s''');

-- Duplicate decisions overlap while the first owns the session row.
select extensions.dblink_exec('review_gate','do $$ begin perform pg_advisory_lock(99003031); end $$');
select extensions.dblink_send_query('review_owner','select public.test_review_decision(1,''approve'')');
select pg_temp.wait_review_lock('review_owner','advisory');
select extensions.dblink_send_query('review_contender','select public.test_review_decision(1,''approve'')');
select pg_temp.wait_review_lock('review_contender');
select extensions.dblink_exec('review_gate','do $$ begin perform pg_advisory_unlock(99003031); end $$');
create temp table approval_first as select * from extensions.dblink_get_result('review_owner') as result(outcome text);
create temp table approval_duplicate as select * from extensions.dblink_get_result('review_contender') as result(outcome text);
select is((select outcome from approval_first),'approved','first overlapping approval commits');
select is((select outcome from approval_duplicate),'stale','duplicate overlapping approval cannot advance again');
select is((select count(*) from public.session_phase_completions where session_id='af000000-0000-4000-8000-000000000001'),1::bigint,'duplicate review records one completion');
select is((select count(*) from public.agent_jobs where session_id='af000000-0000-4000-8000-000000000001' and status in ('queued','started','running')),1::bigint,'duplicate review queues one successor');
select is((select count(*) from public.agent_runs where session_id='af000000-0000-4000-8000-000000000001' and status='queued'),1::bigint,'duplicate review queues one execution');
select is((select status::text from public.agent_jobs where id='af000000-0000-4000-8000-000000000101'),'success','handoff completes the exact publishing job');
select is((select status::text from public.agent_runs where id='af000000-0000-4000-8000-000000000201'),'success','handoff preserves successful run history');
select is((select sandbox_id from public.agent_runs where id='af000000-0000-4000-8000-000000000201'),'review-delivery-still-running','handoff retains sandbox for publisher cleanup');
select count(*) from extensions.dblink_get_result('review_owner') as result(outcome text);
select count(*) from extensions.dblink_get_result('review_contender') as result(outcome text);

-- Rejection arriving during approval must observe the committed successor.
select extensions.dblink_exec('review_gate','do $$ begin perform pg_advisory_lock(99003032); end $$');
select extensions.dblink_send_query('review_owner','select public.test_review_decision(2,''approve'')');
select pg_temp.wait_review_lock('review_owner','advisory');
select extensions.dblink_send_query('review_contender','select public.test_review_decision(2,''reject'')');
select pg_temp.wait_review_lock('review_contender');
select extensions.dblink_exec('review_gate','do $$ begin perform pg_advisory_unlock(99003032); end $$');
create temp table approval_winner as select * from extensions.dblink_get_result('review_owner') as result(outcome text);
create temp table rejection_loser as select * from extensions.dblink_get_result('review_contender') as result(outcome text);
select is((select outcome from approval_winner),'approved','approval wins the decision lock');
select is((select outcome from rejection_loser),'stale','delayed rejection fails closed');
select is((select rejection_count from public.sessions where id='af000000-0000-4000-8000-000000000002'),0,'losing rejection does not change retry count');
select is((select count(*) from public.session_artifact_feedback where session_id='af000000-0000-4000-8000-000000000002'),0::bigint,'losing rejection stores no feedback');
select is((select stage_slug from public.agent_jobs where session_id='af000000-0000-4000-8000-000000000002' and status='queued'),'build','approval queues the selected successor only');
select count(*) from extensions.dblink_get_result('review_owner') as result(outcome text);
select count(*) from extensions.dblink_get_result('review_contender') as result(outcome text);

-- Reverse the lock order: a rejection must prevent the delayed approval.
select extensions.dblink_exec('review_gate','do $$ begin perform pg_advisory_lock(99003033); end $$');
select extensions.dblink_send_query('review_owner','select public.test_review_decision(3,''reject'')');
select pg_temp.wait_review_lock('review_owner','advisory');
select extensions.dblink_send_query('review_contender','select public.test_review_decision(3,''approve'')');
select pg_temp.wait_review_lock('review_contender');
select extensions.dblink_exec('review_gate','do $$ begin perform pg_advisory_unlock(99003033); end $$');
create temp table rejection_winner as select * from extensions.dblink_get_result('review_owner') as result(outcome text);
create temp table approval_loser as select * from extensions.dblink_get_result('review_contender') as result(outcome text);
select is((select outcome from rejection_winner),'rejected','rejection wins the decision lock');
select is((select outcome from approval_loser),'stale','delayed approval cannot advance rejected content');
select is((select rejection_count from public.sessions where id='af000000-0000-4000-8000-000000000003'),1,'overlapping rejection increments once');
select is((select count(*) from public.session_artifact_feedback where session_id='af000000-0000-4000-8000-000000000003'),1::bigint,'winning rejection stores feedback once');
select is((select count(*) from public.session_phase_completions where session_id='af000000-0000-4000-8000-000000000003'),0::bigint,'losing approval records no completion');
select is((select stage_slug from public.agent_jobs where session_id='af000000-0000-4000-8000-000000000003' and status='queued'),'plan','winning rejection queues a same-stage retry');
select is((select count(*) from public.agent_runs where session_id='af000000-0000-4000-8000-000000000003' and status='queued'),1::bigint,'winning rejection creates one retry run');
select is((select count(*) from public.session_artifacts where session_id in ('af000000-0000-4000-8000-000000000001','af000000-0000-4000-8000-000000000002','af000000-0000-4000-8000-000000000003')),3::bigint,'overlapping decisions retain every reviewed artifact');
select extensions.dblink_disconnect('review_gate');
select extensions.dblink_disconnect('review_owner');
select extensions.dblink_disconnect('review_contender');
select * from finish();
commit;
begin;
drop trigger review_approval_gate on public.session_phase_completions;
drop trigger review_rejection_gate on public.agent_jobs;
drop function public.test_review_decision_gate();
drop function public.test_review_decision(integer,text);
delete from public.sessions where id in ('af000000-0000-4000-8000-000000000001','af000000-0000-4000-8000-000000000002','af000000-0000-4000-8000-000000000003');
commit;
