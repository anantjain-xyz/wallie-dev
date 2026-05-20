-- Repair rows written while Codex runner completion summaries were still treated
-- as reviewable session output.

update public.agent_runs as run
set
  triggered_by_member_id = coalesce(run.triggered_by_member_id, job.requested_by_member_id),
  stage_id = coalesce(run.stage_id, job.stage_id),
  stage_slug = coalesce(run.stage_slug, job.stage_slug),
  stage_name = coalesce(run.stage_name, job.stage_name)
from public.agent_jobs as job
where run.agent_job_id = job.id
  and (
    (run.triggered_by_member_id is null and job.requested_by_member_id is not null)
    or (run.stage_id is null and job.stage_id is not null)
    or (run.stage_slug is null and job.stage_slug is not null)
    or (run.stage_name is null and job.stage_name is not null)
  );

create temporary table completion_only_runs as
select
  run.id,
  run.agent_job_id,
  run.workspace_id,
  coalesce(nullif(run.stage_name, ''), nullif(job.stage_name, ''), 'Stage') as stage_name
from public.agent_runs as run
left join public.agent_jobs as job
  on job.id = run.agent_job_id
where run.status in ('success', 'error')
  and exists (
    select 1
    from public.agent_run_messages as message
    where message.agent_run_id = run.id
      and message.kind = 'completion'
      and lower(btrim(message.message_md)) = 'codex session completed'
  )
  and not exists (
    select 1
    from public.agent_run_messages as message
    where message.agent_run_id = run.id
      and not (
        message.kind = 'completion'
        and lower(btrim(message.message_md)) = 'codex session completed'
      )
  );

insert into public.agent_run_messages (agent_run_id, workspace_id, kind, message_md)
select
  run.id,
  run.workspace_id,
  'error',
  run.stage_name ||
    ' did not produce reviewable output. Wallie only received runner bookkeeping, so no artifact was created.'
from completion_only_runs as run
where not exists (
  select 1
  from public.agent_run_messages as message
  where message.agent_run_id = run.id
    and message.kind = 'error'
);

update public.agent_runs as run
set
  finished_at = coalesce(run.finished_at, now()),
  status = 'error'
from completion_only_runs as bad
where run.id = bad.id;

update public.agent_jobs as job
set
  finished_at = coalesce(job.finished_at, now()),
  last_error = bad.stage_name ||
    ' did not produce reviewable output. Wallie only received runner bookkeeping, so no artifact was created.',
  status = 'error'
from (
  select distinct agent_job_id, stage_name
  from completion_only_runs
  where agent_job_id is not null
) as bad
where job.id = bad.agent_job_id
  and job.status = 'success';

create temporary table completion_only_artifacts as
select
  artifact.session_id,
  artifact.stage_slug,
  artifact.version
from public.session_artifacts as artifact
where artifact.artifact_json = to_jsonb('Codex session completed'::text);

delete from public.session_artifacts as artifact
using completion_only_artifacts as bad
where artifact.session_id = bad.session_id
  and artifact.stage_slug = bad.stage_slug
  and artifact.version = bad.version;

with current_bad_artifacts as (
  select
    session.id as session_id,
    coalesce(max(artifact.version), 0) as replacement_version
  from public.sessions as session
  join completion_only_artifacts as bad
    on bad.session_id = session.id
    and bad.version = session.current_artifact_version
  left join public.session_artifacts as artifact
    on artifact.session_id = session.id
    and artifact.stage_slug = bad.stage_slug
  group by session.id
)
update public.sessions as session
set
  current_artifact_version = current_bad_artifacts.replacement_version,
  phase_status = case
    when current_bad_artifacts.replacement_version = 0
      and session.phase_status = 'awaiting_review'
      then 'rejected'::public.pipeline_phase_status
    else session.phase_status
  end
from current_bad_artifacts
where session.id = current_bad_artifacts.session_id;

delete from public.agent_run_messages
where kind = 'completion'
  and lower(btrim(message_md)) = 'codex session completed';
