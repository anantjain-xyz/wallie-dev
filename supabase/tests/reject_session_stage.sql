begin;

create extension if not exists pgtap with schema extensions;

select plan(23);
set local "request.jwt.claim.role" = 'service_role';

select has_function(
  'public',
  'reject_session_stage',
  array['uuid', 'uuid', 'integer', 'text', 'text', 'text', 'text', 'uuid'],
  'transactional reject RPC exists'
);
select function_privs_are(
  'public',
  'reject_session_stage',
  array['uuid', 'uuid', 'integer', 'text', 'text', 'text', 'text', 'uuid'],
  'service_role',
  array['EXECUTE'],
  'service_role can execute the reject RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.reject_session_stage(uuid,uuid,integer,text,text,text,text,uuid)',
    'EXECUTE'
  ),
  'anon cannot execute the reject RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.reject_session_stage(uuid,uuid,integer,text,text,text,text,uuid)',
    'EXECUTE'
  ),
  'authenticated cannot execute the reject RPC'
);
select is(
  (
    select config
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    cross join lateral unnest(procedure.proconfig) config
    where namespace.nspname = 'public'
      and procedure.proname = 'reject_session_stage'
      and config like 'search_path=%'
  ),
  'search_path=""',
  'security definer RPC has an empty search_path'
);

create temp table test_baseline as
select last_issue_number
from internal.workspace_issue_counters
where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001';

create temp table phase_session as
select *
from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'Reject phase guard',
  'Must stay in_progress until review.',
  'codex',
  'gpt-5.5',
  null,
  null,
  '12b2c3d4-0001-4000-8000-000000000001',
  null
);

select throws_ok(
  $$
    select *
    from public.reject_session_stage(
      (select session_id from phase_session),
      'b1b2c3d4-0001-4000-8000-000000000001',
      1,
      'too early',
      'codex',
      'gpt-5.5',
      'project',
      'c1b2c3d4-0001-4000-8000-000000000001'
    )
  $$,
  '55000',
  'Session is not awaiting review.',
  'in_progress session cannot be rejected'
);

update public.sessions session
set phase_status = 'awaiting_review', current_artifact_version = 1
from phase_session result
where session.id = result.session_id;

select throws_ok(
  $$
    select *
    from public.reject_session_stage(
      (select session_id from phase_session),
      'b1b2c3d4-0001-4000-8000-000000000001',
      0,
      'stale version',
      'codex',
      'gpt-5.5',
      'project',
      'c1b2c3d4-0001-4000-8000-000000000001'
    )
  $$,
  '55000',
  'Version mismatch: a newer version exists.',
  'stale artifact version cannot be rejected'
);

update public.sessions session
set archived_at = now()
from phase_session result
where session.id = result.session_id;

select throws_ok(
  $$
    select *
    from public.reject_session_stage(
      (select session_id from phase_session),
      'b1b2c3d4-0001-4000-8000-000000000001',
      1,
      'archived',
      'codex',
      'gpt-5.5',
      'project',
      'c1b2c3d4-0001-4000-8000-000000000001'
    )
  $$,
  '55000',
  'Session is archived.',
  'archived session cannot be rejected'
);

create temp table happy_session as
select *
from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'Reject happy path',
  'Review then reject atomically.',
  'codex',
  'gpt-5.5',
  null,
  null,
  '12b2c3d4-0001-4000-8000-000000000001',
  null
);

update public.agent_jobs job
set status = 'success'
from happy_session result
where job.id = result.job_id;

update public.agent_runs run
set status = 'success'
from happy_session result
where run.id = result.run_id;

insert into public.session_artifacts (
  workspace_id,
  session_id,
  stage_id,
  stage_slug,
  version,
  artifact_json
)
select
  'b1b2c3d4-0001-4000-8000-000000000001',
  result.session_id,
  session.current_stage_id,
  stage.slug,
  1,
  to_jsonb('# Plan'::text)
from happy_session result
join public.sessions session on session.id = result.session_id
join public.pipeline_stages stage on stage.id = session.current_stage_id;

update public.sessions session
set phase_status = 'awaiting_review', current_artifact_version = 1
from happy_session result
where session.id = result.session_id;

select throws_ok(
  $$
    select *
    from public.reject_session_stage(
      (select session_id from happy_session),
      'b1b2c3d4-0001-4000-8000-000000000001',
      1,
      '   ',
      'codex',
      'gpt-5.5',
      'project',
      'c1b2c3d4-0001-4000-8000-000000000001'
    )
  $$,
  '23514',
  'Feedback is required',
  'blank feedback aborts before mutating the session'
);

create temp table happy_reject as
select *
from public.reject_session_stage(
  (select session_id from happy_session),
  'b1b2c3d4-0001-4000-8000-000000000001',
  1,
  'tighten the spec',
  'codex',
  'gpt-5.5',
  'project',
  'c1b2c3d4-0001-4000-8000-000000000001'
);

select is((select count(*)::integer from happy_reject), 1, 'RPC returns one navigation row');
select is((select phase_status::text from happy_reject), 'rejected', 'session moves to rejected');
select is((select rejection_count from happy_reject), 1, 'rejection_count increments once');
select ok((select job_created from happy_reject), 'a new rerun job is created');
select ok(
  exists (
    select 1
    from public.session_artifact_feedback feedback
    join happy_reject result on result.session_id = feedback.session_id
    where feedback.target_version = 1
      and feedback.feedback_text = 'tighten the spec'
  ),
  'reviewer feedback is stored on the rejected version'
);
select ok(
  exists (
    select 1
    from public.agent_jobs job
    join happy_reject result on result.job_id = job.id
    where job.session_id = result.session_id
      and job.dedupe_key = 'session:' || result.session_id::text || ':active'
      and job.trigger_type = 'comment_retry'
      and job.status = 'queued'
  ),
  'rerun job uses the active-session dedupe key and comment_retry trigger'
);
select ok(
  exists (
    select 1
    from public.agent_runs run
    join happy_reject result on result.run_id = run.id
    where run.agent_job_id = result.job_id
      and run.session_id = result.session_id
      and run.run_type = 'project'
      and run.model_provider = 'codex'
      and run.model_name = 'gpt-5.5'
      and run.status = 'queued'
  ),
  'rerun is linked to the new job with the requested model'
);

create temp table adopt_session as
select *
from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'Reject adopts active job',
  'First job is still queued.',
  'codex',
  'gpt-5.5',
  null,
  null,
  '12b2c3d4-0001-4000-8000-000000000001',
  null
);

insert into public.session_artifacts (
  workspace_id,
  session_id,
  stage_id,
  stage_slug,
  version,
  artifact_json
)
select
  'b1b2c3d4-0001-4000-8000-000000000001',
  result.session_id,
  session.current_stage_id,
  stage.slug,
  1,
  to_jsonb('# Plan'::text)
from adopt_session result
join public.sessions session on session.id = result.session_id
join public.pipeline_stages stage on stage.id = session.current_stage_id;

update public.sessions session
set phase_status = 'awaiting_review', current_artifact_version = 1
from adopt_session result
where session.id = result.session_id;

create temp table adopt_reject as
select *
from public.reject_session_stage(
  (select session_id from adopt_session),
  'b1b2c3d4-0001-4000-8000-000000000001',
  1,
  'retry with the already-queued job',
  'codex',
  'gpt-5.5',
  'project',
  'c1b2c3d4-0001-4000-8000-000000000001'
);

select is((select job_id from adopt_reject), (select job_id from adopt_session), 'active job is adopted');
select ok(not (select job_created from adopt_reject), 'adoption does not insert a second active job');
select is((select phase_status::text from adopt_reject), 'rejected', 'adopted rejection still parks the session');

create temp table zombie_session as
select *
from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'Reject closes runless active job',
  'Published run, job still running.',
  'codex',
  'gpt-5.5',
  null,
  null,
  '12b2c3d4-0001-4000-8000-000000000001',
  null
);

insert into public.session_artifacts (
  workspace_id,
  session_id,
  stage_id,
  stage_slug,
  version,
  artifact_json
)
select
  'b1b2c3d4-0001-4000-8000-000000000001',
  result.session_id,
  session.current_stage_id,
  stage.slug,
  1,
  to_jsonb('# Plan'::text)
from zombie_session result
join public.sessions session on session.id = result.session_id
join public.pipeline_stages stage on stage.id = session.current_stage_id;

update public.sessions session
set phase_status = 'awaiting_review', current_artifact_version = 1
from zombie_session result
where session.id = result.session_id;

update public.agent_runs run
set status = 'success', finished_at = now()
from zombie_session result
where run.id = result.run_id;

update public.agent_jobs job
set status = 'running', started_at = now()
from zombie_session result
where job.id = result.job_id;

create temp table zombie_reject as
select *
from public.reject_session_stage(
  (select session_id from zombie_session),
  'b1b2c3d4-0001-4000-8000-000000000001',
  1,
  'retry after the published job stalled',
  'codex',
  'gpt-5.5',
  'project',
  'c1b2c3d4-0001-4000-8000-000000000001'
);

select is(
  (select status::text from public.agent_jobs where id = (select job_id from zombie_session)),
  'success',
  'runless running job is closed as success so the dedupe index releases'
);
select ok((select job_created from zombie_reject), 'a new rerun job is created instead of adopting the zombie');
select ok(
  (select job_id from zombie_reject) is distinct from (select job_id from zombie_session),
  'the queued rerun is not the stalled published job'
);
select ok(
  exists (
    select 1
    from public.agent_runs run
    join zombie_reject result on result.run_id = run.id
    where run.agent_job_id = result.job_id
      and run.status = 'queued'
  ),
  'the new rerun job has a queued run'
);

delete from public.sessions
where id in (select session_id from phase_session)
   or id in (select session_id from happy_session)
   or id in (select session_id from adopt_session)
   or id in (select session_id from zombie_session);

update internal.workspace_issue_counters
set last_issue_number = (select last_issue_number from test_baseline),
    updated_at = now()
where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001';

select * from finish();

commit;
