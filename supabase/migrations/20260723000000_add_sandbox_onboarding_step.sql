-- Add sandbox step to workspace_onboarding constraints
-- Order: github, repository, pipeline, linear, sandbox, runtime, verify

alter table public.workspace_onboarding
  drop constraint if exists workspace_onboarding_known_current_step,
  drop constraint if exists workspace_onboarding_known_completed_steps,
  drop constraint if exists workspace_onboarding_known_skipped_steps;

alter table public.workspace_onboarding
  add constraint workspace_onboarding_known_current_step check (
    current_step in ('github', 'repository', 'pipeline', 'linear', 'sandbox', 'runtime', 'verify')
  ),
  add constraint workspace_onboarding_known_completed_steps check (
    completed_steps <@ array['github', 'repository', 'pipeline', 'linear', 'sandbox', 'runtime', 'verify']::text[]
  ),
  add constraint workspace_onboarding_known_skipped_steps check (
    skipped_steps <@ array['github', 'repository', 'pipeline', 'linear', 'sandbox', 'runtime', 'verify']::text[]
  );
