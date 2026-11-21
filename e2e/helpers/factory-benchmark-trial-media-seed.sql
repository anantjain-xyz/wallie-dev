begin;
set local request.jwt.claim.role = 'service_role';

\if :expire_asset
insert into public.session_browser_asset_withholdings (asset_id, state)
select id, 'expired' from public.session_browser_verification_assets
where (workspace_id, run_id, id) = (:'workspace_id'::uuid, :'run_id'::uuid, :'asset_id'::uuid);
select jsonb_build_object('expired', exists(
  select 1 from public.session_browser_asset_withholdings where asset_id = :'asset_id'::uuid
));
\else
-- The Playwright fixture uploaded real PNG bytes rendered from the exact
-- synthetic output's Git tree. Seed the retained plan/receipt together.
create temporary table browser_trial_media as
select result.workspace_id, trial.session_id, trial.run_id, trial.job_id, trial.attempt_count,
  input.repository_id, result.output_commit_sha, result.output_tree_sha
from public.factory_benchmark_trial_results result
join public.factory_benchmark_trials trial on (trial.workspace_id, trial.factory_id, trial.id, trial.run_id) =
  (result.workspace_id, result.factory_id, result.trial_id, result.run_id)
join public.factory_benchmark_task_inputs input on (input.workspace_id, input.factory_id, input.task_id) =
  (trial.workspace_id, trial.factory_id, trial.task_id)
where (result.workspace_id, result.trial_id, result.run_id, result.output_commit_sha, result.output_tree_sha) =
  (:'workspace_id'::uuid, :'trial_id'::uuid, :'run_id'::uuid, :'commit_sha', :'tree_sha');

insert into public.session_validation_plans (
  run_id, workspace_id, session_id, job_id, attempt_count, repository_id, commit_sha, validation_tree_sha, plan
)
select run_id, workspace_id, session_id, job_id, attempt_count, repository_id, output_commit_sha, output_tree_sha,
  '{"version":2,"commands":[],"browser":[{"key":"invoice-preview","path":"/fixture","timeoutSeconds":5,
    "interactions":[{"action":"expectVisible","testId":"invoice"}],"regionTestId":"invoice",
    "excludedTestIds":[],"evidence":[{"kind":"screenshot","required":true}]}]}'
from browser_trial_media;

insert into public.session_browser_verification_receipts (run_id, session_id, workspace_id, records)
select run_id, session_id, workspace_id, jsonb_build_array(jsonb_build_object(
  'key','invoice-preview','kind','screenshot','path','/fixture','policy','isolated-fixture-v1','status','captured',
  'browserSessionId', :'browser_session_id', 'manifest', jsonb_build_object(
    'assetId', :'asset_id', 'sizeBytes', :'size_bytes'::int, 'contentType','image/png', 'sha256', :'sha256')
))
from browser_trial_media;

insert into public.session_browser_verification_assets (
  id,run_id,workspace_id,session_id,evidence_key,browser_session_id,approval_scope_id,required,
  storage_path,sha256,content_type,size_bytes
)
select :'asset_id'::uuid, run_id, workspace_id, session_id, 'browser:screenshot:invoice-preview',
  :'browser_session_id'::uuid, :'approval_scope_id', true, :'asset_path', :'sha256', 'image/png', :'size_bytes'::int
from browser_trial_media;
select jsonb_build_object('assets', count(*)) from browser_trial_media;
\endif

commit;
