begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

-- Committed namespaced fixtures are visible to both real connections. Save
-- the complete global control state and restore it exactly after the races.
create temp table saved_release_control as select * from internal.git_continuity_release_control;
select * from public.set_git_continuity_release(true,
  (select revision from public.get_git_continuity_release_state()),'Release concurrency fixture');
insert into public.workspaces(id,name,slug)
values('499c0000-0000-4000-8000-000000000001','Release admission races','release-admission-races');
insert into public.workspace_members(id,workspace_id,user_id,kind,role)
values('499c0000-0000-4000-8000-000000000002','499c0000-0000-4000-8000-000000000001',
  'a1b2c3d4-0001-4000-8000-000000000001','human','owner');
insert into public.pipelines(id,workspace_id,name)
values('499c0000-0000-4000-8000-000000000003','499c0000-0000-4000-8000-000000000001','Release race pipeline');
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,prompt_template_md)
values('499c0000-0000-4000-8000-000000000004','499c0000-0000-4000-8000-000000000003',
  '499c0000-0000-4000-8000-000000000001',1,'plan','Plan','Respect release admission');
create temp table release_race_context as select created.session_id,created.job_id,created.run_id
  from public.create_session_with_first_job('499c0000-0000-4000-8000-000000000001',
    '499c0000-0000-4000-8000-000000000002','Release race session','Bounded release admission',
    'codex','gpt-5.5',null,null,null,'499c0000-0000-4000-8000-000000000003',
    array['499c0000-0000-4000-8000-000000000004'::uuid]) created;
-- This one fixture wins queue order without mutating unrelated seeded work.
update public.agent_jobs set created_at='1900-01-01T00:00:00Z' where id=(select job_id from release_race_context);
commit;
begin;

create function pg_temp.wait_release_lock(application text) returns void language plpgsql as $$
declare deadline timestamptz:=clock_timestamp()+interval '5 seconds';
begin
  while not exists(select 1 from pg_catalog.pg_stat_activity where application_name=application and wait_event_type='Lock') loop
    if clock_timestamp()>deadline then raise exception 'Expected release lock was not reached by %',application; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;
select extensions.dblink_connect('release_owner',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('release_contender',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('release_owner','set application_name=''release_owner''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');
select extensions.dblink_exec('release_contender','set application_name=''release_contender''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');

-- Pause wins the control row before admission. The blocked claimant must read
-- the committed pause, not a flag cached before acquiring its SHARE lock.
select extensions.dblink_exec('release_owner','begin');
select revision from extensions.dblink('release_owner',$q$
  select revision from public.set_git_continuity_release(false,
    (select revision from public.get_git_continuity_release_state()),'Pause wins queue admission')
$q$) as result(revision bigint);
select extensions.dblink_send_query('release_contender','select id,attempt_count,git_continuity_release_revision from public.claim_next_agent_job(1000)');
select pg_temp.wait_release_lock('release_contender');
select ok(exists(select 1 from pg_stat_activity where application_name='release_contender' and wait_event_type='Lock'),
  'queue admission actually waits behind the uncommitted release decision');
select extensions.dblink_exec('release_owner','commit');
select is((select count(*) from extensions.dblink_get_result('release_contender')
  as result(id uuid,attempt_count integer,revision bigint)),0::bigint,
  'a claimant waiting behind pause admits no pipeline attempt');
select count(*) from extensions.dblink_get_result('release_contender') as result(id uuid,attempt_count integer,revision bigint);
select ok((select status='queued' and attempt_count=0 and git_continuity_release_revision is null
  from public.agent_jobs where id=(select job_id from release_race_context)),
  'losing admission leaves the exact queued generation untouched');

-- Admission wins first and holds SHARE until its claim commits. Pause waits,
-- then the claim -> start gap is fenced and safely deferrable.
select revision from extensions.dblink('release_owner',$q$
  select revision from public.set_git_continuity_release(true,
    (select revision from public.get_git_continuity_release_state()),'Resume race admission')
$q$) as result(revision bigint);
select extensions.dblink_exec('release_owner','begin');
create temp table winning_claim as select * from extensions.dblink('release_owner',
  'select id,attempt_count,git_continuity_release_revision from public.claim_next_agent_job(1000)')
  as result(job_id uuid,attempt_count integer,revision bigint);
select is((select job_id from winning_claim),(select job_id from release_race_context),
  'the isolated race fixture owns the actual queue claim');
select extensions.dblink_send_query('release_contender',$q$
  select revision from public.set_git_continuity_release(false,
    (select revision from public.get_git_continuity_release_state()),'Pause waits for committed claim')
$q$);
select pg_temp.wait_release_lock('release_contender');
select ok(exists(select 1 from pg_stat_activity where application_name='release_contender' and wait_event_type='Lock'),
  'pause actually waits for the admitted claim transaction');
select extensions.dblink_exec('release_owner','commit');
select ok((select result.revision>captured.revision from extensions.dblink_get_result('release_contender') as result(revision bigint)
  cross join winning_claim captured),'the committed pause advances beyond the captured claim revision');
select count(*) from extensions.dblink_get_result('release_contender') as result(revision bigint);
select extensions.dblink_send_query('release_contender',format($q$
  select public.start_session_job_attempt(%L::uuid,1,'499c0000-0000-4000-8000-000000000004',0,
    'codex','gpt-5.5','project','wallie/release-race')
$q$,(select job_id from release_race_context)));
select count(*) from extensions.dblink_get_result('release_contender',false) as result(run_id uuid);
select ok(extensions.dblink_error_message('release_contender') like '%Git continuity admission is paused%',
  'the committed pause rejects a previously admitted but unstarted claim');
select count(*) from extensions.dblink_get_result('release_contender',false) as result(run_id uuid);
select is((select deferred from extensions.dblink('release_owner',format(
  'select public.defer_session_job_for_continuity_release(%L::uuid,1)',(select job_id from release_race_context)))
  as result(deferred boolean)),true,'the losing unstarted claim can return to its original queue');
select ok((select j.status='queued' and j.attempt_count=1 and j.last_error is null
  and r.id=fixture.run_id and r.status='queued' and r.attempt_count is null
  from release_race_context fixture join public.agent_jobs j on j.id=fixture.job_id
  join public.agent_runs r on r.agent_job_id=j.id),
  'concurrent pause deferral retains the queued placeholder and consumes no failure');

-- Start wins admission before pause. Its complete transaction holds SHARE;
-- the later pause must not retroactively cancel/defer the active attempt.
select revision from extensions.dblink('release_owner',$q$
  select revision from public.set_git_continuity_release(true,
    (select revision from public.get_git_continuity_release_state()),'Resume start race')
$q$) as result(revision bigint);
select id from extensions.dblink('release_owner','select id from public.claim_next_agent_job(1000)') as result(id uuid);
select extensions.dblink_exec('release_owner','begin');
create temp table admitted_start as select * from extensions.dblink('release_owner',format($q$
  select public.start_session_job_attempt(%L::uuid,2,'499c0000-0000-4000-8000-000000000004',0,
    'codex','gpt-5.5','project','wallie/release-race')
$q$,(select job_id from release_race_context))) as result(run_id uuid);
select ok((select run_id is not null from admitted_start),'start creates its owned attempt under an enabled release revision');
select extensions.dblink_send_query('release_contender',$q$
  select revision from public.set_git_continuity_release(false,
    (select revision from public.get_git_continuity_release_state()),'Pause waits for active start')
$q$);
select pg_temp.wait_release_lock('release_contender');
select ok(exists(select 1 from pg_stat_activity where application_name='release_contender' and wait_event_type='Lock'),
  'pause actually waits for the active start transaction to commit');
select extensions.dblink_exec('release_owner','commit');
select revision from extensions.dblink_get_result('release_contender') as result(revision bigint);
select count(*) from extensions.dblink_get_result('release_contender') as result(revision bigint);
select is((select deferred from extensions.dblink('release_owner',format(
  'select public.defer_session_job_for_continuity_release(%L::uuid,1)',(select job_id from release_race_context)))
  as result(deferred boolean)),false,'a stale former attempt cannot defer the newly started claim');
select is((select deferred from extensions.dblink('release_owner',format(
  'select public.defer_session_job_for_continuity_release(%L::uuid,2)',(select job_id from release_race_context)))
  as result(deferred boolean)),false,'the current attempt cannot be deferred after its active run was committed');
select ok((select j.status='running' and j.attempt_count=2 and r.status in('started','running') and r.attempt_count=2
  from release_race_context fixture join public.agent_jobs j on j.id=fixture.job_id
  join public.agent_runs r on r.id=(select run_id from admitted_start)),
  'pause preserves the newer owned execution without cancellation or retry');

select extensions.dblink_disconnect('release_owner');
select extensions.dblink_disconnect('release_contender');
delete from public.sessions where workspace_id='499c0000-0000-4000-8000-000000000001';
delete from public.workspaces where id='499c0000-0000-4000-8000-000000000001';
delete from internal.git_continuity_release_audit where revision>(select revision from saved_release_control);
update internal.git_continuity_release_control current_state set enabled=saved.enabled,revision=saved.revision,
  reason=saved.reason,updated_at=saved.updated_at from saved_release_control saved where current_state.singleton=saved.singleton;
select is((select to_jsonb(c) from internal.git_continuity_release_control c),
  (select to_jsonb(c) from saved_release_control c),'the concurrency fixture restores global release state byte for byte');
select * from finish();
commit;
