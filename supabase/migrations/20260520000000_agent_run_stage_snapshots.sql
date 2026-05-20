alter table public.agent_jobs
  add column stage_id uuid references public.pipeline_stages(id) on delete set null,
  add column stage_slug text,
  add column stage_name text;

alter table public.agent_runs
  add column stage_id uuid references public.pipeline_stages(id) on delete set null,
  add column stage_slug text,
  add column stage_name text;

update public.agent_jobs jobs
set
  stage_id = stages.id,
  stage_slug = stages.slug,
  stage_name = stages.name
from public.sessions sessions
join public.pipeline_stages stages
  on stages.id = sessions.current_stage_id
where jobs.session_id = sessions.id
  and jobs.stage_id is null;

with run_stage_backfill as (
  select
    runs.id as run_id,
    coalesce(jobs.stage_id, stages.id) as stage_id,
    coalesce(jobs.stage_slug, stages.slug) as stage_slug,
    coalesce(jobs.stage_name, stages.name) as stage_name
  from public.agent_runs runs
  join public.sessions sessions
    on sessions.id = runs.session_id
  join public.pipeline_stages stages
    on stages.id = sessions.current_stage_id
  left join public.agent_jobs jobs
    on jobs.id = runs.agent_job_id
  where runs.stage_id is null
)
update public.agent_runs runs
set
  stage_id = run_stage_backfill.stage_id,
  stage_slug = run_stage_backfill.stage_slug,
  stage_name = run_stage_backfill.stage_name
from run_stage_backfill
where runs.id = run_stage_backfill.run_id;

create or replace function internal.enforce_agent_job_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(
    new.workspace_id, 'public.sessions', new.session_id, 'session_id'
  );

  perform internal.assert_workspace_match(
    new.workspace_id, 'public.workspace_members',
    new.requested_by_member_id, 'requested_by_member_id'
  );

  perform internal.assert_workspace_match(
    new.workspace_id, 'public.pipeline_stages',
    new.stage_id, 'stage_id'
  );

  return new;
end;
$$;

create or replace function internal.enforce_agent_run_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.sessions', new.session_id, 'session_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.agent_jobs', new.agent_job_id, 'agent_job_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.workspace_members', new.triggered_by_member_id, 'triggered_by_member_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.pipeline_stages', new.stage_id, 'stage_id');
  return new;
end;
$$;
