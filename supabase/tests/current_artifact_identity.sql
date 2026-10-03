begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';
select set_config('request.jwt.claim.sub',
  (select user_id::text from public.workspace_members where id='c1b2c3d4-0001-4000-8000-000000000001'),true);

insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0)
from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);
create temp table identity_pipeline as with inserted as (
  insert into public.pipelines(workspace_id,name)
  values('b1b2c3d4-0001-4000-8000-000000000001','Exact artifact identity proof') returning id
) select id from inserted;
insert into public.pipeline_stages(pipeline_id,workspace_id,position,slug,name,prompt_template_md)
select id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,1,'identity-plan','Plan','Plan' from identity_pipeline
union all select id,'b1b2c3d4-0001-4000-8000-000000000001'::uuid,2,'identity-build','Build','Build' from identity_pipeline;
create temp table identity_session as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Legacy duplicate review versions','Keep both original publications','codex','gpt-5.5',null,null,null,
  (select id from identity_pipeline));
update public.agent_jobs set status='success' where id=(select job_id from identity_session);
update public.agent_runs set status='success' where id=(select run_id from identity_session);
create temp table identity_legacy_artifacts as with inserted as (
  insert into public.session_artifacts(workspace_id,session_id,stage_id,stage_slug,version,artifact_json)
  select session.workspace_id,session.id,session.current_stage_id,history.slug,1,to_jsonb(history.markdown)
  from public.sessions session cross join (values
    ('identity-plan-original','First historical markdown'),
    ('identity-plan-renamed','Second historical markdown')) history(slug,markdown)
  where session.id=(select session_id from identity_session)
  returning id,stage_slug
) select * from inserted;
create temp table identity_legacy_snapshot as select artifact.id,to_jsonb(artifact) as original_row
from public.session_artifacts artifact where artifact.session_id=(select session_id from identity_session);
update public.sessions set phase_status='awaiting_review',current_artifact_version=1,
  current_artifact_id=(select id from identity_legacy_artifacts where stage_slug='identity-plan-original')
where id=(select session_id from identity_session);

create function pg_temp.identity_detail() returns jsonb language sql as $$
  select public.get_session_detail_page(workspace.slug,session.number)
  from public.sessions session join public.workspaces workspace on workspace.id=session.workspace_id
  where session.id=(select session_id from identity_session);
$$;
create function pg_temp.approve_identity(artifact_id uuid,version integer default 1)
returns table(id uuid,pipeline_id uuid,current_stage_id uuid,current_stage_slug text,
  phase_status public.pipeline_phase_status,workspace_id uuid,linear_issue_url text,archived_at timestamptz,
  current_artifact_version integer,rejection_count integer,job_id uuid,run_id uuid,job_created boolean)
language sql as $$
  select receipt.* from public.sessions session cross join lateral public.approve_session_stage(
    session.id,session.workspace_id,session.current_stage_id,artifact_id,version,
    'c1b2c3d4-0001-4000-8000-000000000001','codex','gpt-5.5','project') receipt
  where session.id=(select session_id from identity_session);
$$;
create function pg_temp.reject_identity(artifact_id uuid,version integer default 1)
returns table(session_id uuid,workspace_id uuid,current_stage_id uuid,current_artifact_version integer,
  phase_status public.pipeline_phase_status,rejection_count integer,archived_at timestamptz,job_id uuid,run_id uuid,job_created boolean)
language sql as $$
  select receipt.* from public.sessions session cross join lateral public.reject_session_stage(
    session.id,session.workspace_id,version,'Review this exact markdown','codex','gpt-5.5',session.current_stage_id,artifact_id,
    'project','c1b2c3d4-0001-4000-8000-000000000001') receipt
  where session.id=(select session_id from identity_session);
$$;

select is((select count(*) from public.session_artifacts where session_id=(select session_id from identity_session)),2::bigint,
  'legacy duplicate stage/version publications remain stored under their historical labels');
select is(jsonb_array_length(pg_temp.identity_detail() #> '{session,artifacts}'),1,
  'initial detail returns exactly the pinned artifact despite duplicate stage/version history');
select is(pg_temp.identity_detail() #>> '{session,currentArtifactId}',
  (select id::text from identity_legacy_artifacts where stage_slug='identity-plan-original'),
  'initial detail exposes the authoritative current artifact identity');
select is(pg_temp.identity_detail() #>> '{session,artifacts,0,id}',
  (select id::text from identity_legacy_artifacts where stage_slug='identity-plan-original'),
  'initial detail never substitutes the other equal-version artifact');
select is(pg_temp.identity_detail() #>> '{session,artifacts,0,payload}','First historical markdown',
  'initial detail renders the markdown belonging to the exact pointer');
select is((select count(*) from pg_temp.approve_identity((select id from identity_legacy_artifacts where stage_slug='identity-plan-renamed'))),0::bigint,
  'same stage and version cannot authorize approval of the unpinned artifact');
select throws_ok($q$select * from pg_temp.reject_identity((select id from identity_legacy_artifacts where stage_slug='identity-plan-renamed'))$q$,
  '55000','Review artifact changed. Refresh and try again.','same stage and version cannot authorize rejection of the unpinned artifact');
select is((select count(*) from public.session_phase_completions where session_id=(select session_id from identity_session)),0::bigint,
  'wrong identity records no completion');
select is((select count(*) from public.session_artifact_feedback where session_id=(select session_id from identity_session)),0::bigint,
  'wrong identity records no feedback');

-- Migration leaves genuinely ambiguous legacy reviews null, with their phase
-- and all publication history intact. No loader or decision may guess a winner.
update public.sessions set current_artifact_id=null where id=(select session_id from identity_session);
select is(jsonb_array_length(pg_temp.identity_detail() #> '{session,artifacts}'),0,
  'unresolved legacy identity does not expose arbitrary markdown as current review');
select is(pg_temp.identity_detail() #>> '{session,currentArtifactId}',null::text,
  'unresolved legacy review is explicit in the detail payload');
select throws_ok($q$select * from pg_temp.approve_identity((select id from identity_legacy_artifacts where stage_slug='identity-plan-original'))$q$,
  '55000','Review artifact identity is unavailable. Run this stage again before reviewing.',
  'ambiguous review cannot approve the first historical candidate');
select throws_ok($q$select * from pg_temp.approve_identity((select id from identity_legacy_artifacts where stage_slug='identity-plan-renamed'))$q$,
  '55000','Review artifact identity is unavailable. Run this stage again before reviewing.',
  'ambiguous review cannot approve the second historical candidate');
select throws_ok($q$select * from pg_temp.reject_identity((select id from identity_legacy_artifacts where stage_slug='identity-plan-original'))$q$,
  '55000','Review artifact identity is unavailable. Run this stage again before reviewing.',
  'ambiguous review cannot attach feedback to a guessed historical candidate');
select is((select phase_status::text from public.sessions where id=(select session_id from identity_session)),'awaiting_review',
  'blocked review leaves the legacy session phase unchanged');

-- An explicit new execution repairs provenance by publishing a new immutable
-- artifact above the retained history; it does not choose either legacy row.
create temp table identity_retry as select queued.* from public.sessions session
cross join lateral public.enqueue_session_job_with_run(session.id,session.workspace_id,session.current_stage_id,
  'c1b2c3d4-0001-4000-8000-000000000001','manual_retry','codex','gpt-5.5','project') queued
where session.id=(select session_id from identity_session);
update public.agent_jobs set status='running',attempt_count=1 where id=(select job_id from identity_retry);
select is(public.start_session_job_attempt((select job_id from identity_retry),1,
  (select current_stage_id from public.sessions where id=(select session_id from identity_session)),1,'codex','gpt-5.5','project'),
  (select run_id from identity_retry),'explicit rerun can start from the unresolved historical version');
create function pg_temp.reject_pointer_commit() returns trigger language plpgsql as $$ begin
  if new.id=(select session_id from identity_session) and new.phase_status='awaiting_review' then
    raise exception 'Injected pointer commit failure';
  end if;
  return new;
end; $$;
create trigger identity_pointer_commit_failure before update on public.sessions for each row execute function pg_temp.reject_pointer_commit();
select throws_ok($q$select public.publish_session_job_attempt((select job_id from identity_retry),1,
  (select run_id from identity_retry),1,'New unambiguous publication')$q$,'P0001','Injected pointer commit failure',
  'pointer transition failure aborts the complete publication');
drop trigger identity_pointer_commit_failure on public.sessions;
select is((select count(*) from public.session_artifacts where session_id=(select session_id from identity_session)),2::bigint,
  'failed pointer transition rolls back the new artifact insertion');
select is((select current_artifact_id from public.sessions where id=(select session_id from identity_session)),null::uuid,
  'failed publication does not expose a dangling review identity');
select is((select status::text from public.agent_runs where id=(select run_id from identity_retry)),'running',
  'failed pointer transition does not mark the owning run successful');
select ok(public.publish_session_job_attempt((select job_id from identity_retry),1,
  (select run_id from identity_retry),1,'New unambiguous publication'),'rerun atomically publishes a new exact review identity');
select is((select current_artifact_version from public.sessions where id=(select session_id from identity_session)),2,
  'repair publication advances above both duplicate legacy versions');
select ok(exists(select 1 from public.sessions session join public.session_artifacts artifact on artifact.id=session.current_artifact_id
  where session.id=(select session_id from identity_session) and artifact.session_id=session.id
    and artifact.workspace_id=session.workspace_id and artifact.stage_id=session.current_stage_id
    and artifact.version=2 and artifact.artifact_json=to_jsonb('New unambiguous publication'::text)),
  'new pointer resolves to the exact scoped publication committed by the owner');
select is(pg_temp.identity_detail() #>> '{session,artifacts,0,payload}','New unambiguous publication',
  'repaired detail renders the new authoritative markdown');
select is((select count(*) from pg_temp.approve_identity((select id from identity_legacy_artifacts where stage_slug='identity-plan-original'),2)),0::bigint,
  'submitting the current version cannot make an old artifact ID reviewable');
select results_eq($q$select to_jsonb(artifact) from public.session_artifacts artifact
  join identity_legacy_snapshot snapshot on snapshot.id=artifact.id order by artifact.id$q$,
  $q$select original_row from identity_legacy_snapshot order by id$q$,
  'repair preserves every field of both original historical publications');
create temp table identity_repaired_approval as select * from pg_temp.approve_identity(
  (select current_artifact_id from public.sessions where id=(select session_id from identity_session)),2);
select is((select current_stage_slug from identity_repaired_approval),'identity-build',
  'exact new publication is reviewable after legacy identity repair');
select is((select current_artifact_id from public.sessions where id=(select session_id from identity_session)),null::uuid,
  'approval clears the old exact identity when advancing to another stage');

-- A legacy direct stage transition also must not carry another stage's ID.
update public.sessions set current_artifact_id=(select id from identity_legacy_artifacts where stage_slug='identity-plan-original'),
  current_stage_id=(select id from public.pipeline_stages where pipeline_id=(select id from identity_pipeline) and slug='identity-plan')
where id=(select session_id from identity_session);
select is((select current_artifact_id from public.sessions where id=(select session_id from identity_session)),null::uuid,
  'stage-history trigger clears an explicitly stale pointer on stage change');

-- The FK keeps a removed legacy artifact from leaving a dangling pointer.
update public.sessions set current_artifact_id=(select id from identity_legacy_artifacts where stage_slug='identity-plan-original'),
  current_artifact_version=1 where id=(select session_id from identity_session);
delete from public.session_artifacts where id=(select id from identity_legacy_artifacts where stage_slug='identity-plan-original');
select is((select current_artifact_id from public.sessions where id=(select session_id from identity_session)),null::uuid,
  'artifact deletion clears its exact session pointer through the foreign key');
select ok(exists(select 1 from public.session_artifacts where id=(select id from identity_legacy_artifacts where stage_slug='identity-plan-renamed')),
  'foreign-key cleanup does not delete the other historical publication');

select * from finish();
rollback;
