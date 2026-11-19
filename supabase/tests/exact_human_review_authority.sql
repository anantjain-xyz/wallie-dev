begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.approval_id(slot integer) returns uuid language sql immutable as $$
  select ('57200000-0000-4000-8000-' || lpad(slot::text,12,'0'))::uuid
$$;
insert into auth.users(id,email) values
  (pg_temp.approval_id(1),'exact-approval-manager@example.test'),
  (pg_temp.approval_id(2),'exact-approval-reviewer@example.test');
insert into public.workspaces(id,slug,name) values
  (pg_temp.approval_id(3),'exact-human-review-fixture','Exact human review');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  (pg_temp.approval_id(4),pg_temp.approval_id(3),pg_temp.approval_id(1),'human','owner'),
  (pg_temp.approval_id(5),pg_temp.approval_id(3),pg_temp.approval_id(2),'human','member');
create temp table restricted_factory as select * from public.create_factory(
  pg_temp.approval_id(3),pg_temp.approval_id(1),'Restricted review','restricted-review');
select public.grant_factory_membership(pg_temp.approval_id(3),id,pg_temp.approval_id(1),
  pg_temp.approval_id(5),'member') from restricted_factory;

insert into public.pipelines(id,workspace_id,factory_id,name,is_default)
select pg_temp.approval_id(10),workspace_id,id,'Generic review pipeline',false from restricted_factory;
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,prompt_template_md,anyone_can_approve)
values (pg_temp.approval_id(11),pg_temp.approval_id(10),pg_temp.approval_id(3),1,'draft','Draft','Write a reviewable artifact',true);

create temp table review_release as select * from internal.git_continuity_release_control;
select public.set_git_continuity_release(true,revision,'Exact human approval fixture') from review_release where not enabled;
insert into public.sessions(id,workspace_id,factory_id,number,title,prompt_md,creator_member_id,pipeline_id,current_stage_id)
select pg_temp.approval_id(20+n),factory.workspace_id,factory.id,n,'Generic session ' || n,'Review the generic stage.',
  pg_temp.approval_id(4),pg_temp.approval_id(10),pg_temp.approval_id(11)
from restricted_factory factory cross join generate_series(1,2) n;
insert into public.session_selected_stages(session_id,workspace_id,stage_id)
select session.id,session.workspace_id,session.current_stage_id from public.sessions session
where session.workspace_id=pg_temp.approval_id(3) on conflict do nothing;
insert into public.agent_jobs(id,workspace_id,session_id,stage_id,stage_slug,stage_name,trigger_type,status,attempt_count,git_continuity_release_revision)
select pg_temp.approval_id(30+session.number),session.workspace_id,session.id,session.current_stage_id,'draft','Draft',
  'assignment','running',1,(select revision from public.get_git_continuity_release_state())
from public.sessions session where session.workspace_id=pg_temp.approval_id(3);
insert into public.agent_runs(id,workspace_id,session_id,agent_job_id,stage_id,stage_slug,stage_name,model_provider,model_name,run_type)
select pg_temp.approval_id(40+session.number),job.workspace_id,job.session_id,job.id,job.stage_id,'draft','Draft','codex','gpt-5.5','project'
from public.agent_jobs job join public.sessions session on session.id=job.session_id where job.workspace_id=pg_temp.approval_id(3);

do $$
declare job public.agent_jobs; owned_run uuid;
begin
  for job in select * from public.agent_jobs where workspace_id=pg_temp.approval_id(3) loop
    owned_run := public.start_session_job_attempt(job.id,1,job.stage_id,0,'codex','gpt-5.5','project');
    if not public.publish_session_job_attempt(job.id,1,owned_run,0,'Review this exact artifact') then
      raise exception 'Could not publish approval fixture';
    end if;
  end loop;
end;
$$;
create temp table approval_targets as
  select session.id,session.workspace_id,session.number,session.current_stage_id,
    session.current_artifact_id,session.current_artifact_version,session.artifact_review_revision
  from public.sessions session where session.workspace_id=pg_temp.approval_id(3);
select is((select count(*) from approval_targets where current_artifact_id is not null and current_artifact_version=1),2::bigint,
  'both generic sessions have an exact published artifact');

create function pg_temp.approval_query(target_number integer) returns text language sql as $$
  select format($query$
    select id from public.approve_session_stage(%L,%L,%L,%L,%L,%L,'codex','gpt-5.5','project',%L)
  $query$,target.id,target.workspace_id,target.current_stage_id,target.current_artifact_id,target.current_artifact_version,
    pg_temp.approval_id(5),target.artifact_review_revision)
  from approval_targets target where target.number=target_number
$$;
create function pg_temp.wait_on_review_fence(target_application text, blocker integer) returns boolean language plpgsql as $$
declare deadline timestamptz := clock_timestamp()+interval '5 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists (
      select 1 from pg_stat_activity activity
      where activity.application_name=target_application and blocker=any(pg_blocking_pids(activity.pid))
    ) then return true; end if;
    if clock_timestamp() >= deadline then return false; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;

-- Test-only publication temporarily used release enablement. Keep the
-- release and its audit unchanged when making fixtures visible to dblink.
delete from internal.git_continuity_release_audit where revision > (select revision from review_release);
update internal.git_continuity_release_control control
set enabled=saved.enabled, revision=saved.revision, reason=saved.reason, updated_at=saved.updated_at
from review_release saved where control.singleton=saved.singleton;
commit;

begin;
select extensions.dblink_connect('op572_revoker',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('op572_approver',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('op572_revoker',
  'set application_name=''op572_revoker''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');
select extensions.dblink_exec('op572_approver',
  'set application_name=''op572_approver''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');
create temp table revoker_backend as select * from extensions.dblink('op572_revoker','select pg_backend_pid()') backend(pid integer);
create temp table approver_backend as select * from extensions.dblink('op572_approver','select pg_backend_pid()') backend(pid integer);
create temp table revoke_review_access as select format('select id from public.revoke_factory_membership(%L,%L,%L,%L)',
  workspace_id,id,pg_temp.approval_id(1),pg_temp.approval_id(5)) command from restricted_factory;

-- The eligibility lookup succeeded before revocation, as it would in the UI.
select ok(exists(select 1 from public.factory_members member join restricted_factory factory on factory.id=member.factory_id
  where member.member_id=pg_temp.approval_id(5) and member.revoked_at is null),
  'the reviewer initially has delegated access to the restricted factory');
select extensions.dblink_exec('op572_revoker','begin');
select revoked.id from revoke_review_access query
cross join lateral extensions.dblink('op572_revoker',query.command) revoked(id uuid);
select extensions.dblink_send_query('op572_approver',pg_temp.approval_query(1));
select ok(pg_temp.wait_on_review_fence('op572_approver',(select pid from revoker_backend)),
  'the approval waits on the revoking factory transaction');
select lives_ok(format('select id from public.sessions where id=%L for no key update nowait',pg_temp.approval_id(21)),
  'the waiting approval has not acquired the mutable session review lock');
select extensions.dblink_exec('op572_revoker','commit');
select is((select count(*) from extensions.dblink_get_result('op572_approver',false) result(id uuid)),0::bigint,
  'the waiting approval cannot proceed after delegated membership is revoked');
select ok(extensions.dblink_error_message('op572_approver') like '%no longer has factory access%',
  'the approval rechecks committed factory access even for a generic stage');
select count(*) from extensions.dblink_get_result('op572_approver',false) result(id uuid);
select ok((select session.phase_status='awaiting_review' and session.current_artifact_id=target.current_artifact_id
  from public.sessions session join approval_targets target on target.id=session.id where target.number=1)
  and not exists(select 1 from public.session_stage_approval_receipts receipt where receipt.session_id=pg_temp.approval_id(21)),
  'the denied approval leaves the exact review and approval history intact');
commit;

begin;
select public.grant_factory_membership(pg_temp.approval_id(3),id,pg_temp.approval_id(1),
  pg_temp.approval_id(5),'member') from restricted_factory;
commit;

begin;
select extensions.dblink_exec('op572_approver','begin');
select is((select id from extensions.dblink('op572_approver',pg_temp.approval_query(2)) approved(id uuid)),
  pg_temp.approval_id(22),'a currently authorized ordinary human can approve the exact generic artifact');
select extensions.dblink_send_query('op572_revoker',(select command from revoke_review_access));
select ok(pg_temp.wait_on_review_fence('op572_revoker',(select pid from approver_backend)),
  'revocation waits while the authorized approval holds the factory and review fences');
select extensions.dblink_exec('op572_approver','commit');
select is((select count(*) from extensions.dblink_get_result('op572_revoker') result(id uuid)),1::bigint,
  'revocation completes after the already-authorized approval commits');
select count(*) from extensions.dblink_get_result('op572_revoker') result(id uuid);
select ok((select session.phase_status='approved' from public.sessions session where session.id=pg_temp.approval_id(22))
  and exists(select 1 from public.session_stage_approval_receipts receipt join approval_targets target on target.id=receipt.session_id
    and target.current_artifact_id=receipt.artifact_id and target.current_artifact_version=receipt.artifact_version
    where target.number=2 and receipt.approved_by_member_id=pg_temp.approval_id(5)),
  'the winning approval records the human actor and immutable artifact before revocation');

select extensions.dblink_disconnect('op572_revoker');
select extensions.dblink_disconnect('op572_approver');
delete from public.workspaces where id=pg_temp.approval_id(3);
delete from auth.users where id in (pg_temp.approval_id(1),pg_temp.approval_id(2));
select * from finish();
commit;
