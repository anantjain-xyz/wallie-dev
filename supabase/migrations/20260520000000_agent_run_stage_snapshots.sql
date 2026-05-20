alter table public.agent_jobs
  add column stage_id uuid references public.pipeline_stages(id) on delete set null,
  add column stage_slug text,
  add column stage_name text;

alter table public.agent_runs
  add column stage_id uuid references public.pipeline_stages(id) on delete set null,
  add column stage_slug text,
  add column stage_name text;

-- Historical job/run stage snapshots cannot be safely reconstructed from the
-- session's current stage because sessions may have advanced since those rows
-- were written. Leave existing rows null and snapshot stage metadata only for
-- new jobs/runs.

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
