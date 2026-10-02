begin;

create extension if not exists pgtap with schema extensions;
select no_plan();

create temp table session_insert_baseline as
select
  counter.last_issue_number,
  (select count(*)::integer from public.sessions
   where workspace_id = counter.workspace_id) as session_count
from internal.workspace_issue_counters counter
where counter.workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001';
grant select on session_insert_baseline to authenticated;

select ok(
  not has_any_column_privilege('authenticated', 'public.sessions', 'INSERT'),
  'authenticated callers have no session INSERT privilege, including column grants'
);

-- Use an active member of the completed seed workspace, so membership and
-- onboarding cannot mask an accidentally restored direct-write permission.
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'a1b2c3d4-0001-4000-8000-000000000001';

select throws_ok($$
  insert into public.sessions (
    workspace_id, number, title, prompt_md, pipeline_id, current_stage_id, phase_status
  )
  select
    'b1b2c3d4-0001-4000-8000-000000000001', baseline.last_issue_number + 1,
    'Direct next-number reservation', 'Bypass the creation transaction.',
    stage.pipeline_id, stage.id, 'in_progress'
  from session_insert_baseline baseline
  cross join public.pipeline_stages stage
  where stage.pipeline_id = 'd1b2c3d4-0001-4000-8000-000000000001'
    and stage.slug = 'plan'
$$, '42501', 'permission denied for table sessions',
  'a workspace member cannot reserve the next session number with a direct INSERT');

select throws_ok($$
  insert into public.sessions (
    workspace_id, number, title, prompt_md, pipeline_id, current_stage_id, phase_status
  )
  select
    'b1b2c3d4-0001-4000-8000-000000000001', 2147483647,
    'Direct arbitrary-number reservation', 'Bypass the creation transaction.',
    stage.pipeline_id, stage.id, 'in_progress'
  from public.pipeline_stages stage
  where stage.pipeline_id = 'd1b2c3d4-0001-4000-8000-000000000001'
    and stage.slug = 'plan'
$$, '42501', 'permission denied for table sessions',
  'a workspace member cannot inject an arbitrary session number');

reset role;

select is(
  (select count(*)::integer from public.sessions
   where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'),
  (select session_count from session_insert_baseline),
  'rejected direct writes leave no incomplete sessions'
);
select is(
  (select last_issue_number from internal.workspace_issue_counters
   where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'),
  (select last_issue_number from session_insert_baseline),
  'rejected direct writes leave the workspace number counter unchanged'
);

-- Execute with the same database role and RPC used by the authorized route.
set local role service_role;
set local "request.jwt.claim.role" = 'service_role';

create temp table session_insert_authorized_result as
select * from public.create_session_once_with_first_job(
  target_workspace_id => 'b1b2c3d4-0001-4000-8000-000000000001',
  creator_member_id => 'c1b2c3d4-0001-4000-8000-000000000001',
  target_request_id => 'ba100000-0000-4000-8000-000000000001',
  target_request_hash => repeat('d', 64),
  session_title => 'Transactional insert boundary proof',
  session_prompt_md => 'Create a complete runnable session.',
  agent_model_provider => 'codex',
  agent_model_name => 'gpt-5.5',
  session_attachment_ids => '{}'::uuid[],
  selected_stage_ids => array(
    select id from public.pipeline_stages
    where pipeline_id = 'd1b2c3d4-0001-4000-8000-000000000001'
      and slug in ('build', 'land')
    order by position
  )
);

reset role;

select is(
  (select session_number from session_insert_authorized_result),
  (select last_issue_number + 1 from session_insert_baseline),
  'authorized creation can still allocate the next number after denied reservations'
);
select results_eq($$
  select stage.slug
  from public.session_selected_stages selection
  join session_insert_authorized_result result on result.session_id = selection.session_id
  join public.pipeline_stages stage on stage.id = selection.stage_id
  order by stage.position
$$, $$values ('build'::text), ('land'::text)$$,
  'authorized creation captures exactly the requested stage selection');
select results_eq($$
  select session.title, session.phase_status::text, stage.slug,
    job.trigger_type::text, job.status::text, job.stage_slug,
    run.status::text, run.model_provider, run.model_name
  from session_insert_authorized_result result
  join public.sessions session on session.id = result.session_id
  join public.pipeline_stages stage on stage.id = session.current_stage_id
  join public.agent_jobs job on job.id = result.job_id and job.session_id = session.id
  join public.agent_runs run on run.id = result.run_id
    and run.session_id = session.id and run.agent_job_id = job.id
  where session.creator_member_id = 'c1b2c3d4-0001-4000-8000-000000000001'
    and session.workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
    and job.workspace_id = session.workspace_id
    and run.workspace_id = session.workspace_id
$$, $$values (
  'Transactional insert boundary proof'::text, 'in_progress'::text, 'build'::text,
  'assignment'::text, 'queued'::text, 'build'::text,
  'queued'::text, 'codex'::text, 'gpt-5.5'::text
)$$, 'authorized creation produces a linked session, first job, and first run');
select is(
  (select last_issue_number from internal.workspace_issue_counters
   where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'),
  (select last_issue_number + 1 from session_insert_baseline),
  'authorized creation advances the number counter exactly once'
);

grant select on session_insert_authorized_result to authenticated;
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';

select is(
  (select session.title from public.sessions session
   join session_insert_authorized_result result on result.session_id = session.id),
  'Transactional insert boundary proof',
  'the creator can still read the completed session through membership RLS'
);

reset role;
select * from finish();
rollback;
