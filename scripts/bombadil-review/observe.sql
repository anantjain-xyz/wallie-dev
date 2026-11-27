select json_build_object(
  'identity', json_build_object('id', session.id, 'stageId', seed.stage_id, 'artifactId', seed.id),
  'state', json_build_object(
  'stage', stage.name, 'phase', session.phase_status, 'version', session.current_artifact_version,
  'hasExactArtifact', current.id is not null, 'rejections', session.rejection_count,
  'runs', (select count(*) from public.agent_runs r
    where r.session_id = session.id and r.workspace_id = session.workspace_id),
  'planRuns', (select count(*) from public.agent_runs r
    where r.session_id = session.id and r.workspace_id = session.workspace_id and r.stage_slug = 'plan'),
  'buildRuns', (select count(*) from public.agent_runs r
    where r.session_id = session.id and r.workspace_id = session.workspace_id and r.stage_slug = 'build'),
  'jobs', (select count(*) from public.agent_jobs j
    where j.session_id = session.id and j.workspace_id = session.workspace_id and j.id <> checkpoint.job_id),
  'finishedJobs', (select count(*) from public.agent_jobs j
    where j.session_id = session.id and j.workspace_id = session.workspace_id
      and j.id <> checkpoint.job_id and j.status = 'success'),
  'approval', (select count(*) from public.session_stage_approval_receipts receipt
    where receipt.session_id = session.id and receipt.workspace_id = session.workspace_id
      and receipt.stage_id = seed.stage_id and receipt.artifact_id = seed.id and receipt.artifact_version = 1),
  'feedback', (select count(*) from public.artifact_feedback_batches batch
    where batch.session_id = session.id and batch.workspace_id = session.workspace_id
      and batch.stage_id = seed.stage_id and batch.artifact_id = seed.id and batch.artifact_version = 1
      and batch.whole_stage_feedback = :'feedback')
))
from public.sessions session
join public.pipeline_stages stage on stage.id = session.current_stage_id and stage.workspace_id = session.workspace_id
join public.session_artifacts seed on seed.session_id = session.id and seed.workspace_id = session.workspace_id
  and seed.stage_slug = 'plan' and seed.version = 1
join public.session_git_checkpoints checkpoint on checkpoint.session_id = session.id
  and checkpoint.workspace_id = session.workspace_id and checkpoint.artifact_id = seed.id
left join public.session_artifacts current on current.session_id = session.id and current.workspace_id = session.workspace_id
  and current.id = session.current_artifact_id and current.stage_id = stage.id
  and current.version = session.current_artifact_version
where session.number = :number and session.workspace_id = :'workspace_id'::uuid;
