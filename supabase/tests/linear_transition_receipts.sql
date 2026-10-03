begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

-- Seed contains fixed session numbers beyond the allocation counter. Keep
-- auto-numbered fixtures above every seeded or committed contention fixture.
insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0)
from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);
create temp table linear_pipeline as
with inserted as (insert into public.pipelines(workspace_id,name)
values ('b1b2c3d4-0001-4000-8000-000000000001','Linear receipt proof') returning id) select id from inserted;
insert into public.pipeline_stages(pipeline_id,workspace_id,position,slug,name,prompt_template_md)
select id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,position,slug,slug,slug
from linear_pipeline cross join (values(1,'plan'),(2,'build'),(3,'release')) stages(position,slug);
create temp table linear_session as select * from public.create_session_with_first_job(
'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
'Linear receipt proof','Test transitions','codex','gpt-5.5','TEST-123',null,null,(select id from linear_pipeline));
create function pg_temp.route(span integer, status text, model text default 'gpt-5.5')
returns table(outcome text,job_ids uuid[],run_ids uuid[],job_id uuid,run_id uuid) language sql as $$
 select * from public.apply_linear_session_transition(
 (select session_id from linear_session),'b1b2c3d4-0001-4000-8000-000000000001','TEST-123',
 (select updated_at from public.sessions where id=(select session_id from linear_session)),
 (select updated_at from public.workspace_linear_routing where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'),
 'span-'||span, now()+span*interval '1 second', 'state-'||status, now()+span*interval '1 second',status,'codex',model,'project');
$$;
select ok(has_function_privilege('service_role','public.apply_linear_session_transition(uuid,uuid,text,timestamptz,timestamptz,text,timestamptz,text,timestamptz,text,text,text,text)','EXECUTE'),'service role may route');
select ok(not has_function_privilege('authenticated','public.apply_linear_session_transition(uuid,uuid,text,timestamptz,timestamptz,text,timestamptz,text,timestamptz,text,text,text,text)','EXECUTE'),'members cannot invoke privileged routing');
select ok(not has_function_privilege('anon','public.apply_linear_session_transition(uuid,uuid,text,timestamptz,timestamptz,text,timestamptz,text,timestamptz,text,text,text,text)','EXECUTE'),'anonymous users cannot route');
select ok(not has_table_privilege('authenticated','internal.session_linear_transition_receipts','SELECT'),'private receipts are not client-readable');
select is((select count(*) from internal.session_linear_transition_receipts where session_id=(select session_id from linear_session)),1::bigint,'creation atomically seeds initial receipt');
select is((select outcome from pg_temp.route(-1,'Rework')),'observed','preexisting stage route adopts explicit session creation intent');
select is((select status::text from public.agent_jobs where id=(select job_id from linear_session)),'queued','initial observation preserves first job');
select is((select outcome from pg_temp.route(-1,'Rework')),'duplicate','repeated initial span is consumed');

insert into public.session_artifacts(session_id,workspace_id,stage_id,stage_slug,version,artifact_json)
select session_id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,stage.id,stage.slug,1,to_jsonb(stage.slug)
from linear_session cross join public.pipeline_stages stage where stage.pipeline_id=(select id from linear_pipeline);
insert into public.session_phase_completions(session_id,workspace_id,stage_id,stage_slug)
select session_id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,stage.id,stage.slug
from linear_session cross join public.pipeline_stages stage where stage.pipeline_id=(select id from linear_pipeline);
insert into public.session_artifact_feedback(session_id,workspace_id,stage_id,stage_slug,target_version,feedback_text)
select session_id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,stage.id,stage.slug,1,'old feedback'
from linear_session cross join public.pipeline_stages stage where stage.pipeline_id=(select id from linear_pipeline);
update public.sessions set current_stage_id=(select id from public.pipeline_stages where pipeline_id=(select id from linear_pipeline) and slug='build'),phase_status='awaiting_review',current_artifact_version=1
where id=(select session_id from linear_session);
update public.sessions session set current_artifact_id=artifact.id from public.session_artifacts artifact
where session.id=(select session_id from linear_session) and artifact.session_id=session.id
  and artifact.stage_id=session.current_stage_id and artifact.version=session.current_artifact_version;
create temp table first_route as select * from pg_temp.route(1,'Rework');
select is((select current_artifact_id from public.sessions where id=(select session_id from linear_session)),null::uuid,
  'same-stage Linear reroute clears the exact review identity');
select is((select outcome from first_route),'routed','new Rework span atomically routes');
select is((select job_ids from first_route),array[(select job_id from linear_session)],'receipt identifies exact retired job');
select is((select run_ids from first_route),array[(select run_id from linear_session)],'receipt identifies exact retired run');
select is((select count(*) from public.session_artifacts where session_id=(select session_id from linear_session)),3::bigint,'published artifact history survives reset');
select is((select array_agg(stage_slug) from public.session_phase_completions where session_id=(select session_id from linear_session)),array['plan'],'only upstream completion remains valid');
select is((select array_agg(stage_slug) from public.session_artifact_feedback where session_id=(select session_id from linear_session)),array['plan'],'only upstream feedback remains');
select is((select current_artifact_version from public.sessions where id=(select session_id from linear_session)),1,'rerun starts after highest historical target version');
select ok(exists(select 1 from public.agent_runs run join first_route route on run.id=route.run_id and run.agent_job_id=route.job_id where run.status='queued' and run.stage_slug='build'),'replacement pair is committed with correct stage');
update public.sessions set phase_status='awaiting_review' where id=(select session_id from linear_session);
select is((select outcome from pg_temp.route(1,'Rework')),'duplicate','repeat Rework poll does not reset review');
select is((select phase_status::text from public.sessions where id=(select session_id from linear_session)),'awaiting_review','review remains intact');
select is((select outcome from pg_temp.route(2,'In Review')),'observed','pause transition is durably observed');
create temp table returned_route as select * from pg_temp.route(3,'Rework');
select is((select outcome from returned_route),'routed','observed leave and return re-arms same route');
select isnt((select job_id from returned_route),(select job_id from first_route),'return creates a new job identity');
select is((select outcome from pg_temp.route(2,'In Review')),'stale','late older observation cannot roll back receipt');
select is((select outcome from pg_temp.route(4,'Rework')),'routed','missed leave and return still has new span identity');
create temp table before_failure as select id,status from public.agent_jobs where session_id=(select session_id from linear_session) and status='queued';
select throws_ok($q$select * from pg_temp.route(5,'Rework','')$q$,'23514',null,'replacement enqueue failure rejects entire transition');
select is((select status::text from public.agent_jobs where id=(select id from before_failure)),'queued','enqueue failure rolls back cancellation');
select is((select source_span_id from internal.session_linear_transition_receipts where session_id=(select session_id from linear_session)),'span-4','enqueue failure does not consume source span');
select is((select outcome from pg_temp.route(5,'Rework')),'routed','same transition may retry after transaction rollback');

-- A semantically identical config save is not another intent; changing target is.
update public.workspace_linear_routing set updated_at=now() where workspace_id='b1b2c3d4-0001-4000-8000-000000000001';
select is((select outcome from pg_temp.route(5,'Rework')),'duplicate','config touch alone does not replay work');
update public.workspace_linear_routing set rework_stage_slug='release' where workspace_id='b1b2c3d4-0001-4000-8000-000000000001';
update public.sessions session set current_artifact_id=artifact.id from public.session_artifacts artifact
where session.id=(select session_id from linear_session) and artifact.session_id=session.id
  and artifact.stage_id=session.current_stage_id and artifact.version=session.current_artifact_version;
select is((select outcome from pg_temp.route(5,'Rework')),'routed','changed routing meaning re-arms current span once');
select is((select current_artifact_id from public.sessions where id=(select session_id from linear_session)),null::uuid,
  'different-stage Linear reroute clears the prior review identity');
select is((select current_stage_id from public.sessions where id=(select session_id from linear_session)),(select id from public.pipeline_stages where pipeline_id=(select id from linear_pipeline) and slug='release'),'new configured selected target is used');
select is((select current_artifact_version from public.sessions where id=(select session_id from linear_session)),1,'target retains historical version counter');
update public.sessions set current_stage_id=(select id from public.pipeline_stages where pipeline_id=(select id from linear_pipeline) and slug='build'),current_artifact_version=0 where id=(select session_id from linear_session);
select is((select current_artifact_version from public.sessions where id=(select session_id from linear_session)),1,'legacy zero-on-advance behavior normalizes to preserved history');
update public.sessions set current_stage_id=(select id from public.pipeline_stages where pipeline_id=(select id from linear_pipeline) and slug='release'),current_artifact_version=7 where id=(select session_id from linear_session);
select is((select current_artifact_version from public.sessions where id=(select session_id from linear_session)),7,'normalization never lowers explicitly newer pointer');

-- Unrelated mapping edits are not another intent for the current state.
update public.workspace_linear_routing set status_mappings=jsonb_set(status_mappings,'{backlog}','["Backlog","Icebox"]')
where workspace_id='b1b2c3d4-0001-4000-8000-000000000001';
select is((select outcome from pg_temp.route(5,'Rework')),'duplicate','unrelated mapping edits preserve receipt');
-- A source state rename can change its route without changing span identity.
select is((select outcome from public.apply_linear_session_transition(
(select session_id from linear_session),'b1b2c3d4-0001-4000-8000-000000000001','TEST-123',
(select updated_at from public.sessions where id=(select session_id from linear_session)),
(select updated_at from public.workspace_linear_routing where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'),
'span-5',now()+interval '5 second','state-Rework',now()+interval '5 second','In Review')),'observed','renamed state is reclassified even with unchanged span');
select is((select outcome from pg_temp.route(5,'Rework')),'routed','renaming back to routed meaning re-arms once');

-- Exact session/config snapshots and tenancy protect against stale callers.
select is((select outcome from public.apply_linear_session_transition(
(select session_id from linear_session),'b1b2c3d4-0001-4000-8000-000000000001','TEST-123',now()-interval '1 day',
(select updated_at from public.workspace_linear_routing where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'),
'span-6',now()+interval '6 second','state-Rework',now()+interval '6 second','Rework','codex','gpt-5.5','project')),'stale','stale session snapshot cannot reroute');
select is((select outcome from public.apply_linear_session_transition(
(select session_id from linear_session),'b1b2c3d4-0001-4000-8000-000000000001','TEST-123',
(select updated_at from public.sessions where id=(select session_id from linear_session)),now()-interval '1 day',
'span-6',now()+interval '6 second','state-Rework',now()+interval '6 second','Rework','codex','gpt-5.5','project')),'stale','stale configuration snapshot cannot reroute');
select is((select outcome from public.apply_linear_session_transition(
(select session_id from linear_session),'b1b2c3d4-0001-4000-8000-000000000099','TEST-123',now(),now(),
'span-6',now()+interval '6 second','state-Rework',now()+interval '6 second','Rework','codex','gpt-5.5','project')),'stale','wrong workspace cannot mutate session');
update public.workspace_linear_routing set rework_stage_slug='not-selected' where workspace_id='b1b2c3d4-0001-4000-8000-000000000001';
select is((select outcome from pg_temp.route(6,'Rework')),'missing_stage','unknown target is not routed');
select is((select source_span_id from internal.session_linear_transition_receipts where session_id=(select session_id from linear_session)),'span-5','missing target does not consume retryable transition');
select is((select outcome from pg_temp.route(7,'Unmapped state')),'observed','unmapped state is recorded');
select is((select outcome from pg_temp.route(8,'Backlog')),'observed','ignore state is recorded');
-- Publication may finish while the owning job still delivers its PR. Routing
-- must retain that successful run in cleanup without rewriting its history.
create temp table publisher as select run.id as run_id, job.id as job_id from public.agent_jobs job
join public.agent_runs run on run.agent_job_id=job.id where job.session_id=(select session_id from linear_session) and job.status='queued';
update public.agent_jobs set status='running',attempt_count=1 where id=(select job_id from publisher);
update public.agent_runs set status='success',attempt_count=1,sandbox_id='linear-publisher' where id=(select run_id from publisher);
create temp table canceled_disposition as select * from pg_temp.route(9,'Canceled');
select is((select outcome from canceled_disposition),'archived','terminal cancellation commits through guarded archive');
select ok((select run_ids @> array[(select run_id from publisher)] from canceled_disposition),'published current-attempt sandbox is included in exact cleanup receipt');
select is((select status::text from public.agent_runs where id=(select run_id from publisher)),'success','routing retains published successful run history');
select is((select count(*) from public.session_artifacts where session_id=(select session_id from linear_session)),3::bigint,'terminal routing also preserves published artifacts');
select ok((select archived_at is not null from public.sessions where id=(select session_id from linear_session)),'canceled session is archived');

-- Existing terminal states are not suppressed by bootstrap adoption.
update public.sessions set linear_issue_id=null where id=(select session_id from linear_session);
truncate linear_session;
insert into linear_session select * from public.create_session_with_first_job(
'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
'Existing canceled','Test transitions','codex','gpt-5.5','TEST-123',null,null,(select id from linear_pipeline));
select is((select outcome from pg_temp.route(-1,'Canceled')),'archived','initial preexisting canceled status is enforced');
update public.sessions set linear_issue_id=null where id=(select session_id from linear_session);
truncate linear_session;
insert into linear_session select * from public.create_session_with_first_job(
'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
'Existing done','Test transitions','codex','gpt-5.5','TEST-123',null,null,(select id from linear_pipeline));
select is((select outcome from pg_temp.route(-1,'Done')),'completed','initial manual Done is enforced');
select is((select phase_status::text from public.sessions where id=(select session_id from linear_session)),'approved','Done retains atomic completion semantics');
-- Done observed from an active snapshot still completes a concurrently archived session.
update public.sessions set linear_issue_id=null where id=(select session_id from linear_session);
truncate linear_session;
insert into linear_session select * from public.create_session_with_first_job(
'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
'Done archive race','Test transitions','codex','gpt-5.5','TEST-123',null,null,(select id from linear_pipeline));
create temp table old_snapshot as select updated_at - interval '1 second' as updated_at from public.sessions where id=(select session_id from linear_session);
select * from public.archive_session_job_attempts((select session_id from linear_session),'b1b2c3d4-0001-4000-8000-000000000001','Manual archive',false);
create temp table archived_snapshot as select archived_at from public.sessions where id=(select session_id from linear_session);
select is((select outcome from public.apply_linear_session_transition(
(select session_id from linear_session),'b1b2c3d4-0001-4000-8000-000000000001','TEST-123',
(select updated_at from old_snapshot),
(select updated_at from public.workspace_linear_routing where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'),
'done-race',now()+interval '1 second','done',now()+interval '1 second','Done')),'completed','Done dominates concurrent manual archive');
select is((select phase_status::text from public.sessions where id=(select session_id from linear_session)),'approved','Done upgrades archived phase');
select is((select archived_at from public.sessions where id=(select session_id from linear_session)),(select archived_at from archived_snapshot),'Done preserves original archive timestamp');
-- A revisited stage keeps its version sequence through slug changes. Historical
-- rows retain their original names; another stage's old use of the new slug is
-- not evidence for this stage's counter.
update public.sessions set linear_issue_id=null where id=(select session_id from linear_session);
truncate linear_session;
insert into linear_session select * from public.create_session_with_first_job(
'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
'Renamed stage history','Test stable history','codex','gpt-5.5','TEST-123',null,null,(select id from linear_pipeline));
create temp table renamed_stage as select id from public.pipeline_stages
where pipeline_id=(select id from linear_pipeline) and slug='build';
insert into public.session_artifacts(session_id,workspace_id,stage_id,stage_slug,version,artifact_json)
select session_id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,(select id from renamed_stage),'build',4,'"published build v4"'::jsonb from linear_session;
insert into public.session_artifacts(session_id,workspace_id,stage_id,stage_slug,version,artifact_json)
select session_id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,stage.id,'implement',20,'"other stage history"'::jsonb
from linear_session cross join public.pipeline_stages stage where stage.pipeline_id=(select id from linear_pipeline) and stage.slug='plan';
update public.pipeline_stages set slug='implement' where id=(select id from renamed_stage);
update public.workspace_linear_routing set rework_stage_slug='implement' where workspace_id='b1b2c3d4-0001-4000-8000-000000000001';
create temp table renamed_route as select * from pg_temp.route(1,'Rework');
select is((select outcome from renamed_route),'routed','renamed stage is still a valid selected routing target');
select is((select current_artifact_version from public.sessions where id=(select session_id from linear_session)),4,'reroute counts stable stage history, not matching slug history of another stage');
select is((select stage_slug from public.agent_runs where id=(select run_id from renamed_route)),'implement','replacement run captures current stage name');
select is((select stage_slug from public.session_artifacts where session_id=(select session_id from linear_session) and stage_id=(select id from renamed_stage) and version=4),'build','reroute preserves historical artifact slug');
update public.sessions set current_stage_id=(select id from public.pipeline_stages where pipeline_id=(select id from linear_pipeline) and slug='release'),current_artifact_version=0
where id=(select session_id from linear_session);
update public.sessions set current_stage_id=(select id from renamed_stage),current_artifact_version=0 where id=(select session_id from linear_session);
select is((select current_artifact_version from public.sessions where id=(select session_id from linear_session)),4,'legacy approval-style zero counter normalizes across stage rename');
insert into public.session_artifacts(session_id,workspace_id,stage_id,stage_slug,version,artifact_json)
select session_id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,(select id from renamed_stage),'implement',5,'"published implement v5"'::jsonb from linear_session;
update public.sessions set current_stage_id=(select id from public.pipeline_stages where pipeline_id=(select id from linear_pipeline) and slug='release'),current_artifact_version=0
where id=(select session_id from linear_session);
update public.sessions set current_stage_id=(select id from renamed_stage),current_artifact_version=0 where id=(select session_id from linear_session);
select is((select current_artifact_version from public.sessions where id=(select session_id from linear_session)),5,'later publication continues one version sequence across historical stage names');
select is((select array_agg(version order by version) from public.session_artifacts where session_id=(select session_id from linear_session) and stage_id=(select id from renamed_stage)),array[4,5],'both artifact versions remain associated with their durable stage');
-- The physical uniqueness key still includes the captured slug. Another
-- stage's retained old-name output can occupy the immediate next slot.
insert into public.session_artifacts(session_id,workspace_id,stage_id,stage_slug,version,artifact_json)
select session_id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,stage.id,'implement',6,'"occupied legacy label v6"'::jsonb
from linear_session cross join public.pipeline_stages stage where stage.pipeline_id=(select id from linear_pipeline) and stage.slug='plan';
update public.agent_jobs set status='running',attempt_count=1 where id=(select job_id from renamed_route);
create temp table publishing_run as select public.start_session_job_attempt(
(select job_id from renamed_route),1,(select id from renamed_stage),5,'codex','gpt-5.5','project') as id;
select is((select id from publishing_run),(select run_id from renamed_route),'publication regression owns the exact queued replacement run');
-- Renaming during execution must not change the run's captured artifact label.
update public.pipeline_stages set slug='implementation' where id=(select id from renamed_stage);
select ok(not public.publish_session_job_attempt((select job_id from renamed_route),1,(select id from publishing_run),4,'stale output'),'stale expected base still refuses before version allocation');
select is((select status::text from public.agent_runs where id=(select id from publishing_run)),'running','refused publication preserves owned running state');
select ok(public.publish_session_job_attempt((select job_id from renamed_route),1,(select id from publishing_run),5,'new renamed output'),'publication skips occupied legacy label slots');
select is((select current_artifact_version from public.sessions where id=(select session_id from linear_session)),21,'review pointer records allocation above all captured-label history');
select ok(exists(select 1 from public.session_artifacts where session_id=(select session_id from linear_session)
  and stage_id=(select id from renamed_stage) and stage_slug='implement' and version=21 and artifact_json='"new renamed output"'::jsonb),'allocated artifact retains exact stable stage ID and publishing job label');
select is((select artifact_json #>> '{}' from public.session_artifacts where session_id=(select session_id from linear_session)
  and stage_slug='implement' and version=6),'occupied legacy label v6','another stage occupied next slot remains unchanged');
select is((select artifact_json #>> '{}' from public.session_artifacts where session_id=(select session_id from linear_session)
  and stage_slug='implement' and version=20),'other stage history','highest legacy label artifact remains unchanged');
select is((select status::text from public.agent_runs where id=(select id from publishing_run)),'success','allocation atomically completes the owned run');
select ok(not public.publish_session_job_attempt((select job_id from renamed_route),1,(select id from publishing_run),5,'duplicate output'),'same owner cannot republish an already committed artifact');
select * from finish();
rollback;
