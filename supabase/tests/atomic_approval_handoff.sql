begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0)
from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);
create temp table review_pipeline as with inserted as (
  insert into public.pipelines(workspace_id,name) values('b1b2c3d4-0001-4000-8000-000000000001','Atomic review proof') returning id
) select id from inserted;
insert into public.pipeline_stages(pipeline_id,workspace_id,position,slug,name,prompt_template_md)
select id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,1,'review-plan','Plan','Plan' from review_pipeline
union all select id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,2,'review-build','Build','Build' from review_pipeline;

create function pg_temp.review_fixture(title text)
returns table(session_id uuid,job_id uuid,run_id uuid,stage_id uuid,artifact_id uuid)
language plpgsql as $$
declare fixture record; expected_stage uuid;
begin
  select * into fixture from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
    title,'Atomic review fixture','codex','gpt-5.5',null,null,null,(select id from review_pipeline));
  update public.agent_jobs set status='running',attempt_count=1 where id=fixture.job_id;
  select s.current_stage_id into expected_stage from public.sessions s where s.id=fixture.session_id;
  perform public.start_session_job_attempt(fixture.job_id,1,expected_stage,0,'codex','gpt-5.5','project');
  perform public.publish_session_job_attempt(fixture.job_id,1,fixture.run_id,0,'Reviewed markdown');
  return query select fixture.session_id,fixture.job_id,fixture.run_id,expected_stage,a.id
    from public.session_artifacts a where a.session_id=fixture.session_id and a.stage_id=expected_stage and a.version=1;
end;
$$;
create function pg_temp.approve_review(target uuid,stage uuid,artifact uuid,
  reviewer uuid default 'c1b2c3d4-0001-4000-8000-000000000001',version integer default 1,
  workspace uuid default 'b1b2c3d4-0001-4000-8000-000000000001')
returns table(id uuid,pipeline_id uuid,current_stage_id uuid,current_stage_slug text,
  phase_status public.pipeline_phase_status,workspace_id uuid,linear_issue_url text,archived_at timestamptz,
  current_artifact_version integer,rejection_count integer,job_id uuid,run_id uuid,job_created boolean)
language sql as $$
  select * from public.approve_session_stage(target,workspace,stage,artifact,version,reviewer,'codex','gpt-5.5','project');
$$;

select is(to_regprocedure('public.approve_session_stage(uuid,uuid,integer,uuid)'),null::regprocedure,'old approval without immutable identity is removed');
select is(to_regprocedure('public.reject_session_stage(uuid,uuid,integer,text,text,text,text,uuid)'),null::regprocedure,'old rejection without immutable identity is not public');
select ok(has_function_privilege('service_role',signature,'EXECUTE'),'service role can execute '||signature)
from (values ('public.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text)'),
 ('public.reject_session_stage(uuid,uuid,integer,text,text,text,uuid,uuid,text,uuid)')) api(signature);
select ok(not has_function_privilege(role_name,signature,'EXECUTE'),role_name||' cannot execute '||signature)
from (values('anon'),('authenticated')) roles(role_name)
cross join (values ('public.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text)'),
 ('public.reject_session_stage(uuid,uuid,integer,text,text,text,uuid,uuid,text,uuid)')) api(signature);
select ok(not has_function_privilege('service_role','internal.reject_session_stage(uuid,uuid,integer,text,text,text,text,uuid)','EXECUTE'),'unbound rejection implementation is private');

create temp table reviewed as select * from pg_temp.review_fixture('Published owner occupancy');
update public.agent_runs set sandbox_id='still-delivering-pr' where id=(select run_id from reviewed);
select is((select count(*) from pg_temp.approve_review((select session_id from reviewed),(select stage_id from reviewed),gen_random_uuid())),0::bigint,'wrong artifact identity cannot approve');
select is((select count(*) from pg_temp.approve_review((select session_id from reviewed),gen_random_uuid(),(select artifact_id from reviewed))),0::bigint,'wrong stage identity cannot approve');
select is((select count(*) from pg_temp.approve_review((select session_id from reviewed),(select stage_id from reviewed),(select artifact_id from reviewed),null)),0::bigint,'missing actor cannot approve');
select is((select count(*) from pg_temp.approve_review((select session_id from reviewed),(select stage_id from reviewed),(select artifact_id from reviewed),'c1b2c3d4-0001-4000-8000-000000000001',2)),0::bigint,'wrong version cannot approve');
select is((select count(*) from pg_temp.approve_review((select session_id from reviewed),(select stage_id from reviewed),(select artifact_id from reviewed),'c1b2c3d4-0001-4000-8000-000000000001',1,gen_random_uuid())),0::bigint,'wrong workspace cannot approve');
update public.workspace_members set is_active=false where id='c1b2c3d4-0001-4000-8000-000000000001';
select is((select count(*) from pg_temp.approve_review((select session_id from reviewed),(select stage_id from reviewed),(select artifact_id from reviewed))),0::bigint,'inactive reviewer cannot approve');
update public.workspace_members set is_active=true where id='c1b2c3d4-0001-4000-8000-000000000001';
update public.pipeline_stages set anyone_can_approve=false,approver_member_ids=array['c1b2c3d4-0002-4000-8000-000000000002'::uuid] where id=(select stage_id from reviewed);
select is((select count(*) from pg_temp.approve_review((select session_id from reviewed),(select stage_id from reviewed),(select artifact_id from reviewed))),0::bigint,'explicit approver list also constrains owners');
update public.pipeline_stages set approver_member_ids='{}' where id=(select stage_id from reviewed);
select is((select count(*) from pg_temp.approve_review((select session_id from reviewed),(select stage_id from reviewed),(select artifact_id from reviewed),'c1b2c3d4-0003-4000-8000-000000000003')),0::bigint,'bot membership cannot approve');
insert into public.workspaces(id,slug,name) values('2e434b8e-1570-4c9c-9e01-19a8a9ad0001','approval-other-workspace','Other review workspace');
insert into public.workspace_members(id,workspace_id,user_id,kind,role,is_active)
select '2e434b8e-1570-4c9c-9e01-19a8a9ad0002','2e434b8e-1570-4c9c-9e01-19a8a9ad0001',user_id,'human','owner',true
from public.workspace_members where id='c1b2c3d4-0001-4000-8000-000000000001';
select is((select count(*) from pg_temp.approve_review((select session_id from reviewed),(select stage_id from reviewed),(select artifact_id from reviewed),'2e434b8e-1570-4c9c-9e01-19a8a9ad0002')),0::bigint,'another workspace owner cannot approve');

select is((select status::text from public.agent_jobs where id=(select job_id from reviewed)),'running','rejected decisions leave the published owner active');
select is((select count(*) from public.session_phase_completions where session_id=(select session_id from reviewed)),0::bigint,'rejected decisions record no approval');
create temp table approved as select receipt.* from reviewed fixture cross join lateral pg_temp.approve_review(fixture.session_id,fixture.stage_id,fixture.artifact_id) receipt;
select is((select current_stage_slug from approved),'review-build','approval advances to the next selected stage');
select is((select status::text from public.agent_jobs where id=(select job_id from reviewed)),'success','approval retires the exact published predecessor');
select is((select status::text from public.agent_runs where id=(select run_id from reviewed)),'success','approval preserves successful predecessor run');
select is((select sandbox_id from public.agent_runs where id=(select run_id from reviewed)),'still-delivering-pr','approval retains the predecessor sandbox for worker cleanup');
select is((select status::text from public.agent_jobs where id=(select job_id from approved)),'queued','approval durably queues its returned next job');
select is((select status::text from public.agent_runs where id=(select run_id from approved)),'queued','approval durably queues its returned next run');
select is((select stage_id from public.agent_runs where id=(select run_id from approved)),(select current_stage_id from approved),'queued execution belongs to the returned stage');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from reviewed) and status in('queued','started','running')),1::bigint,'handoff leaves one active job');
select is((select completed_by_member_id from public.session_phase_completions where session_id=(select session_id from reviewed)),'c1b2c3d4-0001-4000-8000-000000000001'::uuid,'approval records the reviewer in the same transaction');
select is((select count(*) from reviewed fixture cross join lateral pg_temp.approve_review(fixture.session_id,fixture.stage_id,fixture.artifact_id) receipt),0::bigint,'duplicate approval cannot advance again');

create temp table rollback_fixture as select * from pg_temp.review_fixture('Rollback next-run failure');
create function pg_temp.fail_next_run() returns trigger language plpgsql as $$ begin
  if new.session_id=(select session_id from rollback_fixture) and new.status='queued' then raise exception 'Injected next-run failure'; end if;
  return new;
end; $$;
create trigger review_run_failure before insert on public.agent_runs for each row execute function pg_temp.fail_next_run();
select throws_ok($$select * from rollback_fixture f cross join lateral pg_temp.approve_review(f.session_id,f.stage_id,f.artifact_id) a$$,'P0001','Injected next-run failure','next-run failure aborts the whole decision');
drop trigger review_run_failure on public.agent_runs;
select is((select phase_status::text from public.sessions where id=(select session_id from rollback_fixture)),'awaiting_review','queue failure restores review phase');
select is((select current_stage_id from public.sessions where id=(select session_id from rollback_fixture)),(select stage_id from rollback_fixture),'queue failure restores stage pointer');
select is((select current_artifact_version from public.sessions where id=(select session_id from rollback_fixture)),1,'queue failure restores artifact version');
select is((select status::text from public.agent_jobs where id=(select job_id from rollback_fixture)),'running','queue failure rolls back predecessor retirement');
select is((select count(*) from public.session_phase_completions where session_id=(select session_id from rollback_fixture)),0::bigint,'queue failure rolls back approval history');
select is((select count(*) from public.agent_jobs where session_id=(select session_id from rollback_fixture)),1::bigint,'queue failure leaves no successor job');
select is((select count(*) from public.agent_runs where session_id=(select session_id from rollback_fixture)),1::bigint,'queue failure leaves no successor run');
select ok(exists(select 1 from public.session_artifacts where id=(select artifact_id from rollback_fixture)),'queue failure retains the reviewed artifact');

create temp table history_fixture as select * from pg_temp.review_fixture('Retained next-stage history');
insert into public.session_artifacts(workspace_id,session_id,stage_id,stage_slug,version,artifact_json)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,f.session_id,s.id,s.slug,4,to_jsonb('Prior build'::text)
from history_fixture f cross join public.pipeline_stages s where s.pipeline_id=(select id from review_pipeline) and s.slug='review-build';
create temp table history_approval as select a.* from history_fixture f cross join lateral pg_temp.approve_review(f.session_id,f.stage_id,f.artifact_id) a;
select is((select current_artifact_version from history_approval),4,'handoff returns the retained next-stage history pointer');
update public.agent_jobs set status='running',attempt_count=1 where id=(select job_id from history_approval);
select is(public.start_session_job_attempt((select job_id from history_approval),1,(select current_stage_id from history_approval),4,'codex','gpt-5.5','project'),(select run_id from history_approval),'next execution starts above the retained history');
select ok(public.publish_session_job_attempt((select job_id from history_approval),1,(select run_id from history_approval),4,'New build'),'next publication does not collide with old versions');
select is((select current_artifact_version from public.sessions where id=(select session_id from history_fixture)),5,'publication advances retained history monotonically');

-- Reusing a stage and version must not make an old review token valid again.
create temp table token_fixture as select * from pg_temp.review_fixture('Reused stage version');
delete from public.session_artifacts where id=(select artifact_id from token_fixture);
insert into public.session_artifacts(workspace_id,session_id,stage_id,stage_slug,version,artifact_json)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,f.session_id,f.stage_id,'review-plan',1,to_jsonb('Different markdown'::text) from token_fixture f;
select is((select count(*) from token_fixture f cross join lateral pg_temp.approve_review(f.session_id,f.stage_id,f.artifact_id) a),0::bigint,'old artifact identity cannot approve replacement markdown at the same stage and version');
select throws_ok($$select * from token_fixture f cross join lateral public.reject_session_stage(f.session_id,'b1b2c3d4-0001-4000-8000-000000000001',1,'Old feedback','codex','gpt-5.5',f.stage_id,f.artifact_id,'project','c1b2c3d4-0001-4000-8000-000000000001') r$$,'55000','Review artifact changed. Refresh and try again.','old artifact identity cannot reject replacement markdown');
select is((select rejection_count from public.sessions where id=(select session_id from token_fixture)),0,'stale rejection does not bump rejection count');
select is((select status::text from public.agent_jobs where id=(select job_id from token_fixture)),'running','stale rejection does not retire current published work');
select is((select feedback_text from public.session_artifact_feedback where session_id=(select session_id from token_fixture)),null::text,'stale rejection does not attach feedback to unseen markdown');

create temp table competing as select * from pg_temp.review_fixture('Unpublished active work');
update public.agent_runs set status='running' where id=(select run_id from competing);
select throws_ok($$select * from competing f cross join lateral pg_temp.approve_review(f.session_id,f.stage_id,f.artifact_id) a$$,'55000','Session has active work that has not published the reviewed artifact.','approval never retires unproven active work');
select is((select status::text from public.agent_runs where id=(select run_id from competing)),'running','competing execution is preserved');
select is((select phase_status::text from public.sessions where id=(select session_id from competing)),'awaiting_review','competing work refusal leaves review decision untouched');

-- A legacy direct producer can insert a bare queued successor while the stage
-- update runs; the approval transaction repairs its placeholder before commit.
create temp table bare_fixture as select * from pg_temp.review_fixture('Bare legacy successor');
create function pg_temp.enqueue_bare_successor() returns trigger language plpgsql as $$ begin
  if new.id=(select session_id from bare_fixture) and new.current_stage_id is distinct from old.current_stage_id then
    insert into public.agent_jobs(workspace_id,session_id,trigger_type,status,dedupe_key)
    values(new.workspace_id,new.id,'assignment','queued','pipeline:bare-successor');
  end if;
  return new;
end; $$;
create trigger bare_successor after update of current_stage_id on public.sessions for each row execute function pg_temp.enqueue_bare_successor();
create temp table bare_approval as select a.* from bare_fixture f cross join lateral pg_temp.approve_review(f.session_id,f.stage_id,f.artifact_id) a;
drop trigger bare_successor on public.sessions;
select ok((select run_id is not null and not job_created from bare_approval),'approval returns a durable run when adopting a bare queued successor');
select is((select count(*) from public.agent_runs where agent_job_id=(select job_id from bare_approval)),1::bigint,'bare successor receives exactly one queued placeholder');


-- A malformed legacy key on another session cannot be adopted as this review's successor.
create temp table collision_fixture as select * from pg_temp.review_fixture('Foreign canonical key collision');
create temp table foreign_fixture as select * from pg_temp.review_fixture('Foreign active key');
update public.agent_jobs set dedupe_key='foreign:old-publisher' where id=(select job_id from collision_fixture);
update public.agent_jobs set dedupe_key='session:'||(select session_id::text from collision_fixture)||':active'
where id=(select job_id from foreign_fixture);
select throws_ok($$select * from collision_fixture f cross join lateral pg_temp.approve_review(f.session_id,f.stage_id,f.artifact_id) a$$,
  '23505',null,'foreign canonical key collision aborts instead of adopting another session');
select is((select phase_status::text from public.sessions where id=(select session_id from collision_fixture)),'awaiting_review','foreign-key collision restores the review phase');
select is((select status::text from public.agent_jobs where id=(select job_id from collision_fixture)),'running','foreign-key collision restores the predecessor job');
select is((select count(*) from public.session_phase_completions where session_id=(select session_id from collision_fixture)),0::bigint,'foreign-key collision records no completion');
select is((select status::text from public.agent_jobs where id=(select job_id from foreign_fixture)),'running','foreign job remains untouched');

select * from finish();
rollback;
