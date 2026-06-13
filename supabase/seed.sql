-- =============================================================================
-- Seed data for local development
-- Runs automatically on `supabase db reset`
--
-- `sessions` is the pipeline source of truth. Upstream tracker references
-- live on `sessions.linear_issue_id` / `sessions.linear_issue_url`.
--
-- We seed eighteen sessions across the four pipeline stages
-- (plan → build → review → land) with a mix of statuses so the pipeline
-- board looks realistic.
-- =============================================================================

-- Helper: insert one agent run plus a user/assistant message pair, with stage-
-- and outcome-appropriate copy. Keeps the generated run history in Section 10
-- compact and consistent. Dropped at the end of this script.
--   p_kind: 'completed' (approved prior stage) | 'awaiting' (current, awaiting
--           review) | 'rejected' (produced an artifact that was rejected) |
--           'queued' (the current attempt, still generating)
--
-- The 'queued' run is deliberately seeded with status 'queued' and a null
-- agent_job_id: the worker's stall detector skips queued runs that have no
-- running parent job (src/worker/stall-detector.ts), so an agent_generating
-- demo session keeps a coherent in-flight run instead of being swept into an
-- "Error: Stalled" state that contradicts its "Wallie is drafting" banner.
CREATE OR REPLACE FUNCTION internal.seed_agent_run(
  p_workspace_id uuid,
  p_session_id   uuid,
  p_member_id    uuid,
  p_title        text,
  p_stage_id     uuid,
  p_stage_slug   text,
  p_stage_name   text,
  p_kind         text,
  p_attempt      int,
  p_started_at   timestamptz,
  p_finished_at  timestamptz
) RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_run_id   uuid := gen_random_uuid();
  v_queued   boolean := (p_kind = 'queued');
  v_status   public.agent_run_status := CASE WHEN v_queued THEN 'queued' ELSE 'success' END;
  v_retry    text := CASE WHEN p_attempt > 1 THEN ' (attempt ' || p_attempt || ')' ELSE '' END;
  v_user_md  text;
  v_asst_md  text;
BEGIN
  -- A queued run has not started yet: no started_at / finished_at / activity.
  -- Every other run is terminal (success), finishing at p_finished_at.
  INSERT INTO public.agent_runs
    (id, workspace_id, session_id, agent_job_id, triggered_by_member_id,
     stage_id, stage_slug, stage_name, run_type, model_provider, model_name,
     status, last_activity_at, started_at, finished_at, created_at)
  VALUES
    (v_run_id, p_workspace_id, p_session_id, null, p_member_id,
     p_stage_id, p_stage_slug, p_stage_name, 'code', 'anthropic', 'claude-opus-4-7[1m]',
     v_status,
     CASE WHEN v_queued THEN null ELSE coalesce(p_finished_at, p_started_at) END,
     CASE WHEN v_queued THEN null ELSE p_started_at END,
     CASE WHEN v_queued THEN null ELSE p_finished_at END,
     p_started_at - interval '2 minutes');

  v_user_md := CASE p_stage_slug
    WHEN 'plan'   THEN 'Generate the plan for: ' || p_title || '.'
    WHEN 'build'  THEN 'Plan approved — implement: ' || p_title || '.'
    WHEN 'review' THEN 'Run the review-and-fix loop for: ' || p_title || '.'
    WHEN 'land'   THEN 'Approved — land: ' || p_title || '.'
    ELSE 'Run the ' || lower(p_stage_name) || ' stage for: ' || p_title || '.'
  END;
  -- Any attempt past the first was triggered by a reviewer rejection.
  IF p_attempt > 1 THEN
    v_user_md := 'Reviewer requested changes — re-run the ' || lower(p_stage_name)
      || v_retry || ' for: ' || p_title || '.';
  END IF;

  -- The enqueued request is always present.
  INSERT INTO public.agent_run_messages
    (id, workspace_id, agent_run_id, kind, message_md, created_at)
  VALUES
    (gen_random_uuid(), p_workspace_id, v_run_id, 'user', v_user_md,
     p_started_at + interval '5 seconds');

  -- A queued run has produced no assistant output yet; terminal runs close
  -- with the agent's completion message.
  IF NOT v_queued THEN
    v_asst_md := CASE p_stage_slug
      WHEN 'plan'   THEN 'Plan complete — captured the problem statement, user story, acceptance criteria, and technical approach.'
      WHEN 'build'  THEN 'Build complete — implemented the change and pushed it to the working branch for review.'
      WHEN 'review' THEN 'Review complete — verified against the plan, swept PR feedback, and confirmed CI is green. Recommending approval.'
      WHEN 'land'   THEN 'Land complete — squash-merged the PR and confirmed the deploy.'
      ELSE 'Finished the ' || lower(p_stage_name) || ' stage.'
    END;

    INSERT INTO public.agent_run_messages
      (id, workspace_id, agent_run_id, kind, message_md, created_at)
    VALUES
      (gen_random_uuid(), p_workspace_id, v_run_id, 'assistant', v_asst_md,
       coalesce(p_finished_at, p_started_at + interval '4 minutes'));
  END IF;
END;
$fn$;

-- Disable triggers during seeding (enforcement triggers check auth context
-- which isn't available when running seed.sql).
SET session_replication_role = replica;

DO $$
DECLARE
  -- Auth users
  user1_id  uuid := 'a1b2c3d4-0001-4000-8000-000000000001';
  user2_id  uuid := 'a1b2c3d4-0002-4000-8000-000000000002';

  -- Workspace
  ws_id     uuid := 'b1b2c3d4-0001-4000-8000-000000000001';

  -- Workspace members
  mem1_id   uuid := 'c1b2c3d4-0001-4000-8000-000000000001';
  mem2_id   uuid := 'c1b2c3d4-0002-4000-8000-000000000002';
  memw_id   uuid := 'c1b2c3d4-0003-4000-8000-000000000003';

  -- Pipeline (default 4-stage seed)
  default_pipeline_id uuid := 'd1b2c3d4-0001-4000-8000-000000000001';
  stage_plan_id   uuid;
  stage_build_id  uuid;
  stage_review_id uuid;
  stage_land_id   uuid;

  -- Sessions
  sess1_id  uuid := 'a2b2c3d4-0001-4000-8000-000000000001';
  sess2_id  uuid := 'a2b2c3d4-0002-4000-8000-000000000002';
  sess3_id  uuid := 'a2b2c3d4-0003-4000-8000-000000000003';
  sess4_id  uuid := 'a2b2c3d4-0004-4000-8000-000000000004';
  sess5_id  uuid := 'a2b2c3d4-0005-4000-8000-000000000005';
  sess6_id  uuid := 'a2b2c3d4-0006-4000-8000-000000000006';
  sess7_id  uuid := 'a2b2c3d4-0007-4000-8000-000000000007';
  sess8_id  uuid := 'a2b2c3d4-0008-4000-8000-000000000008';
  sess9_id  uuid := 'a2b2c3d4-0009-4000-8000-000000000009';
  sess10_id uuid := 'a2b2c3d4-0010-4000-8000-000000000010';
  sess11_id uuid := 'a2b2c3d4-0011-4000-8000-000000000011';
  sess12_id uuid := 'a2b2c3d4-0012-4000-8000-000000000012';
  sess13_id uuid := 'a2b2c3d4-0013-4000-8000-000000000013';
  sess14_id uuid := 'a2b2c3d4-0014-4000-8000-000000000014';
  sess15_id uuid := 'a2b2c3d4-0015-4000-8000-000000000015';
  sess16_id uuid := 'a2b2c3d4-0016-4000-8000-000000000016';
  sess17_id uuid := 'a2b2c3d4-0017-4000-8000-000000000017';
  sess18_id uuid := 'a2b2c3d4-0018-4000-8000-000000000018';

  -- GitHub integration
  gh_inst_id  uuid := '11b2c3d4-0001-4000-8000-000000000001';
  gh_repo1_id uuid := '12b2c3d4-0001-4000-8000-000000000001';
  gh_repo2_id uuid := '12b2c3d4-0002-4000-8000-000000000002';
  gh_br1_id   uuid := '13b2c3d4-0001-4000-8000-000000000001';
  gh_br2_id   uuid := '13b2c3d4-0002-4000-8000-000000000002';
  gh_br3_id   uuid := '13b2c3d4-0003-4000-8000-000000000003';
  repo_setup1_id uuid := '14b2c3d4-0001-4000-8000-000000000001';
  repo_setup2_id uuid := '14b2c3d4-0002-4000-8000-000000000002';
  repo_profile1_id uuid := '15b2c3d4-0001-4000-8000-000000000001';
  repo_profile2_id uuid := '15b2c3d4-0002-4000-8000-000000000002';
  routing_id uuid := '16b2c3d4-0001-4000-8000-000000000001';
  onboarding_id uuid := '17b2c3d4-0001-4000-8000-000000000001';
  sandbox_check_id uuid := '18b2c3d4-0001-4000-8000-000000000001';

  -- Loop cursors for the generated agent-run history (Section 10)
  sess_rec record;
  comp_rec record;

BEGIN

  -- -------------------------------------------------------------------------
  -- 1. Auth users (email / password123)
  -- -------------------------------------------------------------------------
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new,
    email_change_token_current, reauthentication_token, email_change,
    created_at, updated_at, is_sso_user, is_anonymous
  ) VALUES
    (
      '00000000-0000-0000-0000-000000000000',
      user1_id, 'authenticated', 'authenticated',
      'anant@example.com',
      crypt('password123', gen_salt('bf')),
      now(), '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object(
        'sub', user1_id::text,
        'email', 'anant@example.com',
        'full_name', 'Anant Jain',
        'email_verified', true,
        'phone_verified', false
      ),
      '', '', '', '', '', '',
      now() - interval '14 days', now(), false, false
    ),
    (
      '00000000-0000-0000-0000-000000000000',
      user2_id, 'authenticated', 'authenticated',
      'wallie@example.com',
      crypt('password123', gen_salt('bf')),
      now(), '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object(
        'sub', user2_id::text,
        'email', 'wallie@example.com',
        'full_name', 'Wallie',
        'email_verified', true,
        'phone_verified', false
      ),
      '', '', '', '', '', '',
      now() - interval '12 days', now(), false, false
    );

  -- Auth identities (required for email/password login)
  INSERT INTO auth.identities (
    id, provider_id, user_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) VALUES
    (
      gen_random_uuid(), user1_id::text, user1_id,
      jsonb_build_object('sub', user1_id::text, 'email', 'anant@example.com'),
      'email', now(), now() - interval '14 days', now()
    ),
    (
      gen_random_uuid(), user2_id::text, user2_id,
      jsonb_build_object('sub', user2_id::text, 'email', 'wallie@example.com'),
      'email', now(), now() - interval '12 days', now()
    );

  -- -------------------------------------------------------------------------
  -- 2. Profiles
  -- -------------------------------------------------------------------------
  INSERT INTO public.profiles (id, primary_email, full_name, avatar_url, created_at)
  VALUES
    (user1_id, 'anant@example.com', 'Anant Jain', null, now() - interval '14 days'),
    (user2_id, 'wallie@example.com',  'Wallie',   null, now() - interval '12 days');

  -- -------------------------------------------------------------------------
  -- 3. Workspace
  -- -------------------------------------------------------------------------
  INSERT INTO public.workspaces (id, slug, name, created_by, created_at)
  VALUES (ws_id, 'acme-corp', 'Acme Corp', user1_id, now() - interval '14 days');

  -- -------------------------------------------------------------------------
  -- 4. Workspace members
  -- -------------------------------------------------------------------------
  INSERT INTO public.workspace_members
    (id, workspace_id, user_id, kind, role, email, full_name, avatar_url, created_at)
  VALUES
    (mem1_id, ws_id, user1_id, 'human', 'owner',  'anant@example.com', 'Anant Jain', null, now() - interval '14 days'),
    (mem2_id, ws_id, user2_id, 'human', 'member', 'wallie@example.com',  'Wallie',   null, now() - interval '12 days');

  INSERT INTO public.workspace_members
    (id, workspace_id, kind, role, username, full_name, created_at)
  VALUES
    (memw_id, ws_id, 'system', 'agent', 'wallie', 'Wallie', now() - interval '14 days');

  -- -------------------------------------------------------------------------
  -- 5a. Default pipeline + seeded stages.
  --
  -- The shipped default is plan → build → land (see
  -- 20260606000000_pipeline_symphony_alignment.sql). This demo workspace
  -- customizes it with an explicit Review stage between Build and Land so the
  -- seeded board below can show review-stage sessions.
  -- -------------------------------------------------------------------------
  INSERT INTO public.pipelines (id, workspace_id, name, is_default)
  VALUES (default_pipeline_id, ws_id, 'Default', true);

  INSERT INTO public.pipeline_stages (
    pipeline_id, workspace_id, position, slug, name, description, prompt_template_md
  )
  SELECT default_pipeline_id, ws_id, s.stage_position, s.slug, s.name, s.description, s.prompt_template_md
  FROM internal.default_pipeline_stages() s;

  -- Make room at position 3 and insert the demo-only Review stage (plan=1,
  -- build=2, review=3, land=4).
  UPDATE public.pipeline_stages
    SET position = 4
    WHERE pipeline_id = default_pipeline_id AND slug = 'land';

  INSERT INTO public.pipeline_stages (
    pipeline_id, workspace_id, position, slug, name, description, prompt_template_md
  )
  VALUES (
    default_pipeline_id, ws_id, 3, 'review', 'Review',
    'Run a review-and-fix loop: verify the change, address PR feedback from bots and humans, and prepare it for human sign-off.',
    E'Review the implementation for: {{session.title}}\n\n## Instructions\n\nRun this as a review-and-fix loop for the existing implementation. Do not expand scope or introduce unrelated feature work. Code changes are allowed when they directly resolve review findings, PR feedback, failing checks, or plan gaps.\n\n- **Verify against the plan.** Confirm every acceptance-criteria and validation item is met; call out and fix any gap that is in scope.\n- **PR feedback sweep.** Gather every existing actionable item from bot and human feedback, including top-level PR comments, inline review comments or threads, review states such as changes requested, and failing check annotations. Resolve each with a code change or an explicit, justified response on the same thread or comment where appropriate.\n- **Loop until clear.** Rerun validation, push fixes, re-check CI and PR feedback, and repeat until no actionable feedback remains and no required checks are failing. Pending human-gated checks are fine; do not wait on them.\n- **Checks & evidence.** Confirm CI is green on the latest commit, user-facing changes include the required screenshots, and validation test data has been cleaned up.\n- **Findings.** Report risks, correctness concerns, what feedback was addressed, and a clear recommendation. The change should not advance until findings are resolved and a human approves.'
  );

  SELECT id INTO stage_plan_id   FROM public.pipeline_stages WHERE pipeline_id = default_pipeline_id AND slug = 'plan';
  SELECT id INTO stage_build_id  FROM public.pipeline_stages WHERE pipeline_id = default_pipeline_id AND slug = 'build';
  SELECT id INTO stage_review_id FROM public.pipeline_stages WHERE pipeline_id = default_pipeline_id AND slug = 'review';
  SELECT id INTO stage_land_id   FROM public.pipeline_stages WHERE pipeline_id = default_pipeline_id AND slug = 'land';

  -- -------------------------------------------------------------------------
  -- 5b. Session number counter
  -- -------------------------------------------------------------------------
  INSERT INTO internal.workspace_issue_counters (workspace_id, last_issue_number)
  VALUES (ws_id, 18);

  -- -------------------------------------------------------------------------
  -- 6. GitHub integration
  -- -------------------------------------------------------------------------
  INSERT INTO public.github_installations
    (id, workspace_id, installation_id, installation_url, app_id,
     target_type, target_name, permissions, suspended, created_at)
  VALUES
    (gh_inst_id, ws_id, 12345678,
     'https://github.com/settings/installations/12345678',
     98765, 'Organization', 'acme-corp',
     '{"contents":"write","pull_requests":"write","issues":"read","metadata":"read"}'::jsonb,
     false, now() - interval '13 days');

  INSERT INTO public.github_repositories
    (id, workspace_id, github_installation_id, repo_id, name, full_name,
     private, html_url, description, default_programming_language, default_branch,
     is_archived, created_at)
  VALUES
    (gh_repo1_id, ws_id, gh_inst_id, 100001, 'webapp', 'acme-corp/webapp',
     true, 'https://github.com/acme-corp/webapp',
     'Main web application — Next.js + Supabase',
     'TypeScript', 'main', false, now() - interval '13 days'),
    (gh_repo2_id, ws_id, gh_inst_id, 100002, 'api-service', 'acme-corp/api-service',
     true, 'https://github.com/acme-corp/api-service',
     'Background jobs and API microservice',
     'Go', 'main', false, now() - interval '13 days');

  -- -------------------------------------------------------------------------
  -- 7. Workspace setup state
  -- -------------------------------------------------------------------------
  INSERT INTO public.workspace_linear_routing
    (id, workspace_id, created_at)
  VALUES
    (routing_id, ws_id, now() - interval '13 days');

  INSERT INTO public.workspace_repository_profiles
    (id, workspace_id, github_repository_id, is_primary, package_manager,
     language_hints, framework_hints, install_command, build_command,
     test_command, env_key_suggestions, setup_notes, inference_confidence,
     inference_sources, created_at)
  VALUES
    (repo_profile1_id, ws_id, gh_repo1_id, true, 'pnpm',
     array['TypeScript'], array['Next.js', 'Supabase'],
     'pnpm install', 'pnpm build', 'pnpm test',
     array['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
     'Next.js App Router application with Supabase data access and a pnpm workspace.',
     'high',
     '[{"kind":"package_json","path":"package.json"},{"kind":"source_scan","path":"src/"}]'::jsonb,
     now() - interval '13 days'),
    (repo_profile2_id, ws_id, gh_repo2_id, false, 'go',
     array['Go'], array['HTTP API'],
     'go mod download', 'go build ./...', 'go test ./...',
     array['DATABASE_URL'],
     'Go service with conventional module commands.',
     'medium',
     '[{"kind":"go_mod","path":"go.mod"}]'::jsonb,
     now() - interval '13 days');

  INSERT INTO public.repository_onboarding_status
    (id, workspace_id, github_repository_id, status, setup_branch_name,
     setup_pr_number, setup_pr_url, installed_skill_version,
     installed_skill_hash, conflict_report, created_at)
  VALUES
    (repo_setup1_id, ws_id, gh_repo1_id, 'ready', 'wallie/setup',
     22, 'https://github.com/acme-corp/webapp/pull/22', 1,
     'seed-skill-hash-webapp', '[]'::jsonb, now() - interval '13 days'),
    (repo_setup2_id, ws_id, gh_repo2_id, 'not_set_up', null,
     null, null, null, null, '[]'::jsonb, now() - interval '13 days');

  INSERT INTO public.workspace_agent_config
    (workspace_id, key, value_json, created_at)
  VALUES
    (ws_id, 'agent_provider', to_jsonb('claude-code'::text), now() - interval '13 days'),
    (ws_id, 'agent_model', to_jsonb('claude-opus-4-7[1m]'::text), now() - interval '13 days'),
    (ws_id, 'concurrency_limit', to_jsonb(1), now() - interval '13 days'),
    (ws_id, 'max_retries', to_jsonb(3), now() - interval '13 days'),
    (ws_id, 'stall_timeout_ms', to_jsonb(900000), now() - interval '13 days');

  -- Capability payloads mirror the shape produced by probeSandboxCapabilities()
  -- (src/lib/sandbox-capabilities/probe.ts): one entry per probed capability,
  -- each a { ok, detail } object so the Settings tiles render green with real
  -- detail text. The workspace agent provider is claude-code, so the codex-only
  -- `codexExternalSandbox` probe is intentionally absent.
  INSERT INTO public.sandbox_capability_checks
    (id, workspace_id, github_repository_id, status, capabilities, checked_at, created_at)
  VALUES
    (sandbox_check_id, ws_id, gh_repo1_id, 'success',
     jsonb_build_object(
       'git',              jsonb_build_object('ok', true, 'detail', 'git version 2.43.0'),
       'node',             jsonb_build_object('ok', true, 'detail', 'v20.18.1'),
       'packageManager',   jsonb_build_object('ok', true, 'detail', 'pnpm 9.15.0'),
       'agentCli',         jsonb_build_object('ok', true, 'detail', E'/usr/local/bin/claude\nclaude 2.0.14 (Claude Code)'),
       'playwrightPackage', jsonb_build_object('ok', true, 'detail', '1.56.0'),
       'chromium',         jsonb_build_object('ok', true, 'detail', 'Chromium install completed successfully.'),
       'screenshotSmoke',  jsonb_build_object('ok', true, 'detail', 'Playwright screenshot smoke passed.')
     ),
     now() - interval '12 days 20 hours',
     now() - interval '12 days 20 hours');

  INSERT INTO public.workspace_onboarding
    (id, workspace_id, status, current_step, selected_github_repository_id,
     completed_steps, skipped_steps, completed_at, created_at)
  VALUES
    (onboarding_id, ws_id, 'completed', 'verify', gh_repo1_id,
     array['github', 'repository', 'pipeline', 'runtime', 'verify']::text[],
     array['linear']::text[],
     now() - interval '12 days',
     now() - interval '13 days');

  -- -------------------------------------------------------------------------
  -- 8. Sessions (a realistic tour across the plan → build → review → land board)
  -- -------------------------------------------------------------------------

  -- Session 1: plan / awaiting_review — agent just finished the plan
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess1_id, ws_id, 1,
     'Add SSO login via Google Workspace',
     E'We need SSO for the Business plan — Google Workspace first, Okta later. IT asked for this on the call Monday.',
     mem1_id,
     default_pipeline_id, stage_plan_id, 'awaiting_review', 1,
     now() - interval '2 hours', now() - interval '90 minutes');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess1_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# Add SSO login via Google Workspace\n\n## Problem Statement\n\nBusiness customers cannot enforce login policies or reclaim seats when employees leave because Wallie only supports email/password.\n\n## User Story\n\nAs an IT admin on the Business plan, I want to require Google Workspace SSO for my workspace so that only employees with active corporate accounts can log in.\n\n## Acceptance Criteria\n\n- Owners can enable Google SSO from the workspace settings page.\n- Members with matching email domains sign in via Google and are auto-added to the workspace.\n- Non-matching domains are rejected with a clear error.\n- Email/password login is disabled for the workspace once SSO is required.\n\n## Technical Approach\n\n- Use the Supabase Auth Google provider; never break existing email/password sessions mid-request.\n\n## Non-Goals\n\n- Okta, Microsoft Entra, or other IdPs (follow-up).\n\n## Open Questions\n\n- Should we require MFA enforcement client-side or trust Google?\n'::text),
     now() - interval '90 minutes');

  -- Session 2: build / agent_generating — plan approved, build agent running
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess2_id, ws_id, 2,
     'Self-serve workspace creation flow',
     E'Onboarding is dropping off at workspace creation. Let''s build a proper guided flow.',
     mem1_id,
     default_pipeline_id, stage_build_id, 'agent_generating', 0,
     now() - interval '1 day', now() - interval '30 minutes');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess2_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# Self-serve workspace creation flow\n\n## Problem Statement\n\nNew users land on an empty dashboard after signup with no indication of how to create a workspace.\n\n## User Story\n\nAs a newly-signed-up user, I want a guided flow that collects a name and slug so that I land inside a working workspace immediately.\n\n## Acceptance Criteria\n\n- Post-signup users are redirected to /new-workspace.\n- Slug is auto-derived from the name with a live preview.\n- Successful creation redirects to /w/{slug}.\n'::text),
     now() - interval '20 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess2_id, ws_id, stage_plan_id, 'plan', now() - interval '18 hours', mem1_id);

  -- Session 3: build / awaiting_review — plan approved, build ready for review
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess3_id, ws_id, 3,
     'Real-time session updates via Supabase Realtime',
     E'The board feels stale when two people are triaging at once. Can we wire up realtime?',
     mem2_id,
     default_pipeline_id, stage_build_id, 'awaiting_review', 1,
     now() - interval '3 days', now() - interval '5 hours');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess3_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# Real-time session updates via Supabase Realtime\n\n## Problem Statement\n\nBoard state goes stale during collaborative triage, causing duplicate edits and conflicting updates.\n\n## User Story\n\nAs a triager, I want session changes from my teammates to appear without refreshing so we do not step on each other.\n\n## Acceptance Criteria\n\n- Changes broadcast via Supabase Realtime within one second.\n- Local cache merges remote INSERT/UPDATE/DELETE events.\n- Connection status is visible in the UI.\n\n## Technical Approach\n\n- Use supabase.channel() with a workspace_id filter; last-write-wins conflict resolution for v1.\n'::text),
     now() - interval '2 days 18 hours'),
    (sess3_id, ws_id, stage_build_id, 'build', 1,
     to_jsonb(E'# Build\n\nImplemented useRealtimeSessions hook; connection indicator added to shell header.\n'::text),
     now() - interval '5 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess3_id, ws_id, stage_plan_id, 'plan', now() - interval '2 days 12 hours', mem2_id);

  -- Session 4: review / agent_generating — build approved, reviewing the PR
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess4_id, ws_id, 4,
     'Rich-text editor for session prompts',
     E'The plain textarea is rough. Let''s replace it with Tiptap and support image paste.',
     mem1_id,
     default_pipeline_id, stage_review_id, 'agent_generating', 0,
     now() - interval '6 days', now() - interval '4 hours');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess4_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# Rich-text editor for session prompts\n\n## Problem Statement\n\nThe plain textarea does not support formatting, code blocks, or image paste, which is a hard blocker for teams documenting bugs.\n\n## User Story\n\nAs a session author, I want a rich-text editor with code blocks and image paste so that I can communicate context clearly.\n\n## Acceptance Criteria\n\n- Bold, italic, strikethrough, code formatting via Cmd+B/I/shift+X/E.\n- Code blocks with syntax highlighting.\n- Image paste uploads to Supabase Storage.\n\n## Technical Approach\n\n- Tiptap chosen over CodeMirror for block-level editing; image uploads reuse the workspace-avatars bucket.\n'::text),
     now() - interval '5 days 20 hours'),
    (sess4_id, ws_id, stage_build_id, 'build', 1,
     to_jsonb(E'# Build\n\nMarkdownEditor component wired up; basic formatting, code blocks, and image paste implemented.\n'::text),
     now() - interval '1 day');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess4_id, ws_id, stage_plan_id, 'plan',   now() - interval '5 days 12 hours', mem1_id),
    (sess4_id, ws_id, stage_build_id, 'build', now() - interval '20 hours',        mem1_id);

  -- Session 5: land / awaiting_review — approved, ready to merge
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess5_id, ws_id, 5,
     'Keyboard shortcuts for session triage',
     E'Power users are asking for j/k navigation and hotkeys for status/priority.',
     mem2_id,
     default_pipeline_id, stage_land_id, 'awaiting_review', 1,
     now() - interval '8 days', now() - interval '3 hours');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess5_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# Keyboard shortcuts for session triage\n\n## Problem Statement\n\nTriaging large backlogs is mouse-heavy and slow for power users.\n\n## User Story\n\nAs a power user, I want j/k navigation and hotkeys for common actions so that I can triage sessions without leaving the keyboard.\n\n## Acceptance Criteria\n\n- j/k moves the focused session up/down.\n- s/p/a open status/priority/assignee menus.\n- Shortcuts are documented in a ? overlay.\n\n## Technical Approach\n\n- Use tinykeys for the global shortcut provider; show a ? overlay with all bindings.\n'::text),
     now() - interval '7 days'),
    (sess5_id, ws_id, stage_build_id, 'build', 1,
     to_jsonb(E'# Build\n\nAll shortcuts wired; overlay uses same Dialog primitive as command palette.\n'::text),
     now() - interval '3 days'),
    (sess5_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nPR #12 reviewed; two small nits fixed (focus-ring contrast, Escape closes menus).\n'::text),
     now() - interval '3 hours'),
    (sess5_id, ws_id, stage_land_id, 'land', 1,
     to_jsonb(E'# Land\n\nAwaiting land approval — PR is green and ready to merge.\n'::text),
     now() - interval '2 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess5_id, ws_id, stage_plan_id, 'plan',     now() - interval '6 days 20 hours', mem2_id),
    (sess5_id, ws_id, stage_build_id, 'build',   now() - interval '4 hours',         mem2_id),
    (sess5_id, ws_id, stage_review_id, 'review', now() - interval '3 hours',         mem1_id);

  -- Session 6: land / approved, archived — shipped
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     archived_at, created_at, updated_at)
  VALUES
    (sess6_id, ws_id, 6,
     'CI/CD pipeline with GitHub Actions',
     E'We need CI — tests + lint on PRs, staging deploy on merge, production gated.',
     mem1_id,
     default_pipeline_id, stage_land_id, 'approved', 1,
     now() - interval '10 days',
     now() - interval '13 days', now() - interval '10 days');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess6_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# CI/CD pipeline with GitHub Actions\n\n## Problem Statement\n\nTests and linters are only run locally, so broken commits land on main and bottleneck the deploy story.\n\n## User Story\n\nAs a developer, I want CI to catch broken commits and auto-deploy green merges to staging so that we can ship without manual toil.\n\n## Acceptance Criteria\n\n- PR checks run tests and lint.\n- Merge to main deploys to staging automatically.\n- Production deploy requires manual approval.\n\n## Technical Approach\n\n- Use GitHub Actions with environment protection rules for production approvals.\n'::text),
     now() - interval '12 days 20 hours'),
    (sess6_id, ws_id, stage_build_id, 'build', 1,
     to_jsonb(E'# Build\n\n.github/workflows/ci.yml contains test, lint, and deploy jobs.\n'::text),
     now() - interval '11 days 12 hours'),
    (sess6_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nPR #1 reviewed and approved.\n'::text),
     now() - interval '11 days'),
    (sess6_id, ws_id, stage_land_id, 'land', 1,
     to_jsonb(E'# Land\n\nMerged to main; staging deployed automatically.\n'::text),
     now() - interval '10 days 12 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess6_id, ws_id, stage_plan_id, 'plan',     now() - interval '12 days 12 hours', mem1_id),
    (sess6_id, ws_id, stage_build_id, 'build',   now() - interval '11 days 6 hours',  mem1_id),
    (sess6_id, ws_id, stage_review_id, 'review', now() - interval '10 days 18 hours', mem1_id),
    (sess6_id, ws_id, stage_land_id, 'land',     now() - interval '10 days 12 hours', mem1_id);

  -- -------------------------------------------------------------------------
  -- 8b. Additional sessions (multiple cards per pipeline column)
  -- -------------------------------------------------------------------------

  -- Session 7: plan / awaiting_review
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess7_id, ws_id, 7,
     'Dark mode and theme customization',
     E'Users keep asking for dark mode. Let''s add a theme toggle in settings with system preference detection.',
     mem2_id,
     default_pipeline_id, stage_plan_id, 'awaiting_review', 1,
     now() - interval '1 hour', now() - interval '45 minutes');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess7_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# Dark mode and theme customization\n\nAdd a theme toggle to settings. Detect system preference, allow manual override, persist per user.'::text),
     now() - interval '45 minutes');

  -- Session 8: plan / agent_generating (rejected once, re-generating)
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version, rejection_count,
     created_at, updated_at)
  VALUES
    (sess8_id, ws_id, 8,
     'Weekly email digest of pipeline activity',
     E'We need a weekly email summarizing pipeline activity — sessions that moved, stuck items, and PRs awaiting review.',
     mem1_id,
     default_pipeline_id, stage_plan_id, 'agent_generating', 0, 1,
     now() - interval '4 hours', now() - interval '20 minutes');

  -- Session 9: plan / awaiting_review
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess9_id, ws_id, 9,
     'Role-based access control for workspaces',
     E'We need granular permissions — viewer, editor, admin roles with controls over phase approvals and integrations.',
     mem1_id,
     default_pipeline_id, stage_plan_id, 'awaiting_review', 1,
     now() - interval '2 days', now() - interval '4 hours');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess9_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# RBAC for workspaces\n\nViewer, editor, admin roles. Control phase approvals, integration management, and member invites.\n\n## Technical Approach\n\nPermission matrix stored in workspace_members.role; RLS policies enforce at query time.'::text),
     now() - interval '1 day 18 hours');

  -- Session 10: build / rejected
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version, rejection_count,
     created_at, updated_at)
  VALUES
    (sess10_id, ws_id, 10,
     'Bulk session import from CSV and JSON',
     E'Teams migrating from Jira need bulk import. Accept CSV and JSON, validate, create sessions.',
     mem2_id,
     default_pipeline_id, stage_build_id, 'rejected', 1, 1,
     now() - interval '3 days', now() - interval '2 hours');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess10_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# Bulk session import\n\nAccept CSV/JSON upload, validate schema, create sessions with sequential numbering.\n\n## Technical Approach\n\nDrag-and-drop upload zone; server-side validation via Zod schema; preview table before confirming.'::text),
     now() - interval '2 days 18 hours'),
    (sess10_id, ws_id, stage_build_id, 'build', 1,
     to_jsonb(E'# Build\n\nDrag-and-drop CSV/JSON upload with a Zod validation layer and a preview table before confirming the import.'::text),
     now() - interval '6 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess10_id, ws_id, stage_plan_id, 'plan', now() - interval '2 days 12 hours', mem2_id);

  -- Session 11: build / agent_generating
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess11_id, ws_id, 11,
     'Webhook notifications for pipeline events',
     E'External systems need to react to phase transitions. Add webhook registration and signed POST delivery.',
     mem1_id,
     default_pipeline_id, stage_build_id, 'agent_generating', 0,
     now() - interval '4 days', now() - interval '1 hour');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess11_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# Webhook notifications\n\nFire signed POST requests on session phase transitions to registered endpoints.\n\n## Technical Approach\n\nWebhook registration UI in workspace settings; HMAC-SHA256 signing; retry with exponential backoff.'::text),
     now() - interval '3 days 18 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess11_id, ws_id, stage_plan_id, 'plan', now() - interval '3 days 12 hours', mem1_id);

  -- Session 12: review / awaiting_review
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess12_id, ws_id, 12,
     'Two-factor authentication via TOTP',
     E'Security teams want TOTP 2FA. QR code setup, backup codes, and admin enforcement toggle.',
     mem2_id,
     default_pipeline_id, stage_review_id, 'awaiting_review', 1,
     now() - interval '5 days', now() - interval '2 hours');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess12_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# Two-factor authentication via TOTP\n\nTOTP setup flow with QR code, backup codes, workspace-level enforcement.\n\n## Technical Approach\n\nUse otpauth URI for QR; store encrypted TOTP secret; enforce at login middleware.'::text),
     now() - interval '4 days 18 hours'),
    (sess12_id, ws_id, stage_build_id, 'build', 1,
     to_jsonb(E'# Build\n\nTOTP verification middleware, setup page, backup code generation implemented.'::text),
     now() - interval '2 days'),
    (sess12_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nPR reviewed — tests pass, backup code flow verified manually.'::text),
     now() - interval '2 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess12_id, ws_id, stage_plan_id, 'plan',   now() - interval '4 days 12 hours', mem2_id),
    (sess12_id, ws_id, stage_build_id, 'build', now() - interval '6 hours',         mem2_id);

  -- Session 13: review / rejected (2 rejections)
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version, rejection_count,
     created_at, updated_at)
  VALUES
    (sess13_id, ws_id, 13,
     'API rate limiting and usage dashboard',
     E'We need per-workspace rate limits and a usage dashboard showing request counts over time.',
     mem1_id,
     default_pipeline_id, stage_review_id, 'rejected', 1, 2,
     now() - interval '5 days', now() - interval '1 hour');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess13_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# API rate limiting\n\nPer-workspace rate limits with a dashboard showing request counts and quota usage.\n\n## Technical Approach\n\nToken-bucket algorithm; Redis for counters; dashboard uses Recharts line chart.'::text),
     now() - interval '4 days 18 hours'),
    (sess13_id, ws_id, stage_build_id, 'build', 1,
     to_jsonb(E'# Build\n\nRate-limit middleware and usage dashboard page implemented.'::text),
     now() - interval '2 days'),
    (sess13_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nReviewer flagged missing error handling on quota exceeded — needs fix.'::text),
     now() - interval '1 hour');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess13_id, ws_id, stage_plan_id, 'plan',   now() - interval '4 days 12 hours', mem1_id),
    (sess13_id, ws_id, stage_build_id, 'build', now() - interval '4 hours',         mem1_id);

  -- Session 14: land / agent_generating
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess14_id, ws_id, 14,
     'Email notification preferences',
     E'Users get too many emails. Add per-user preferences: immediate, daily digest, or off per event category.',
     mem2_id,
     default_pipeline_id, stage_land_id, 'agent_generating', 0,
     now() - interval '7 days', now() - interval '2 hours');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess14_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# Email notification preferences\n\nPer-user settings: immediate, daily digest, or off for each event category.\n\n## Technical Approach\n\nSettings page with toggle matrix; cron job for daily digest aggregation.'::text),
     now() - interval '6 days 18 hours'),
    (sess14_id, ws_id, stage_build_id, 'build', 1,
     to_jsonb(E'# Build\n\nPreference table, settings UI, and digest cron job implemented.'::text),
     now() - interval '4 days'),
    (sess14_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nPR approved — email templates and preference persistence verified.'::text),
     now() - interval '3 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess14_id, ws_id, stage_plan_id, 'plan',     now() - interval '6 days 12 hours', mem2_id),
    (sess14_id, ws_id, stage_build_id, 'build',   now() - interval '5 hours',         mem2_id),
    (sess14_id, ws_id, stage_review_id, 'review', now() - interval '3 hours',         mem1_id);

  -- Session 15: land / rejected (3 rejections)
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version, rejection_count,
     created_at, updated_at)
  VALUES
    (sess15_id, ws_id, 15,
     'Audit log for workspace admin actions',
     E'Compliance needs a tamper-evident log of admin actions — invites, role changes, integration connects.',
     mem1_id,
     default_pipeline_id, stage_land_id, 'rejected', 1, 3,
     now() - interval '9 days', now() - interval '1 day');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess15_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# Audit log\n\nTamper-evident log of admin actions for compliance. Append-only table with actor, action, and metadata.\n\n## Technical Approach\n\nAppend-only audit_events table; filterable log viewer in workspace settings.'::text),
     now() - interval '8 days 18 hours'),
    (sess15_id, ws_id, stage_build_id, 'build', 1,
     to_jsonb(E'# Build\n\nAudit event triggers on member/integration changes; log viewer with date range filter.'::text),
     now() - interval '6 days'),
    (sess15_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nPR reviewed; event schema and immutability constraints verified.'::text),
     now() - interval '4 days'),
    (sess15_id, ws_id, stage_land_id, 'land', 1,
     to_jsonb(E'# Land\n\nDeploy script failed three times due to migration conflict. Needs manual intervention.'::text),
     now() - interval '1 day');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess15_id, ws_id, stage_plan_id, 'plan',     now() - interval '8 days 12 hours', mem1_id),
    (sess15_id, ws_id, stage_build_id, 'build',   now() - interval '5 days',          mem1_id),
    (sess15_id, ws_id, stage_review_id, 'review', now() - interval '3 days',          mem2_id);

  -- Session 16: land / awaiting_review
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess16_id, ws_id, 16,
     'Search and filter across all sessions',
     E'With dozens of sessions it is hard to find things. Add full-text search and phase/status filters.',
     mem2_id,
     default_pipeline_id, stage_land_id, 'awaiting_review', 1,
     now() - interval '11 days', now() - interval '7 days');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess16_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# Search and filter\n\nFull-text search on titles and prompts, plus filters by phase, status, and creator.\n\n## Technical Approach\n\nPostgres tsvector index on sessions; faceted filter UI with URL-synced state.'::text),
     now() - interval '10 days 18 hours'),
    (sess16_id, ws_id, stage_build_id, 'build', 1,
     to_jsonb(E'# Build\n\nSearch index migration, API endpoint, and filter sidebar implemented.'::text),
     now() - interval '9 days'),
    (sess16_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nPR approved — search relevance and filter combinations tested.'::text),
     now() - interval '8 days 12 hours'),
    (sess16_id, ws_id, stage_land_id, 'land', 1,
     to_jsonb(E'# Land\n\nMerged and deployed to staging; search index backfill complete.'::text),
     now() - interval '8 days');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess16_id, ws_id, stage_plan_id, 'plan',     now() - interval '10 days 12 hours', mem2_id),
    (sess16_id, ws_id, stage_build_id, 'build',   now() - interval '8 days 18 hours',  mem1_id),
    (sess16_id, ws_id, stage_review_id, 'review', now() - interval '8 days 6 hours',   mem1_id);

  -- Session 17: land / agent_generating
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess17_id, ws_id, 17,
     'GitHub PR auto-link from branch naming convention',
     E'When a branch matches wallie-{number}, auto-associate the PR with the session and show it on the card.',
     mem1_id,
     default_pipeline_id, stage_land_id, 'agent_generating', 0,
     now() - interval '12 days', now() - interval '8 days');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess17_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# GitHub PR auto-link\n\nAuto-associate PRs with sessions based on branch naming convention wallie-{number}.\n\n## Technical Approach\n\nGitHub webhook listener parses branch name; creates session_pull_requests row on match.'::text),
     now() - interval '11 days 18 hours'),
    (sess17_id, ws_id, stage_build_id, 'build', 1,
     to_jsonb(E'# Build\n\nWebhook handler and branch parser implemented; PR card badge added to pipeline view.'::text),
     now() - interval '10 days'),
    (sess17_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nPR approved — tested with various branch name formats.'::text),
     now() - interval '9 days 12 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess17_id, ws_id, stage_plan_id, 'plan',     now() - interval '11 days 12 hours', mem1_id),
    (sess17_id, ws_id, stage_build_id, 'build',   now() - interval '9 days 18 hours',  mem1_id),
    (sess17_id, ws_id, stage_review_id, 'review', now() - interval '9 days 6 hours',   mem2_id);

  -- Session 18: land / awaiting_review (1 rejection)
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version, rejection_count,
     created_at, updated_at)
  VALUES
    (sess18_id, ws_id, 18,
     'Custom workspace branding and logo upload',
     E'Enterprise customers want their logo in the sidebar and on shared links. Upload to Storage, display in shell.',
     mem1_id,
     default_pipeline_id, stage_land_id, 'awaiting_review', 1, 1,
     now() - interval '12 days', now() - interval '6 days');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess18_id, ws_id, stage_plan_id, 'plan', 1,
     to_jsonb(E'# Custom workspace branding\n\nLogo upload to Supabase Storage; display in sidebar header and OG image meta tags.\n\n## Technical Approach\n\nImage upload with crop/resize; store in workspace-branding bucket; serve via CDN URL.'::text),
     now() - interval '11 days 18 hours'),
    (sess18_id, ws_id, stage_build_id, 'build', 1,
     to_jsonb(E'# Build\n\nUpload endpoint, image processing, and sidebar logo component implemented.'::text),
     now() - interval '9 days'),
    (sess18_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nPR approved — image validation and fallback tested.'::text),
     now() - interval '8 days'),
    (sess18_id, ws_id, stage_land_id, 'land', 1,
     to_jsonb(E'# Land\n\nMerged and deployed; storage bucket policies configured.'::text),
     now() - interval '7 days');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess18_id, ws_id, stage_plan_id, 'plan',     now() - interval '11 days 12 hours', mem1_id),
    (sess18_id, ws_id, stage_build_id, 'build',   now() - interval '8 days 12 hours',  mem1_id),
    (sess18_id, ws_id, stage_review_id, 'review', now() - interval '7 days 12 hours',  mem2_id);

  -- -------------------------------------------------------------------------
  -- 9. GitHub branches / PRs (linked to sessions)
  -- -------------------------------------------------------------------------
  INSERT INTO public.github_issue_branches
    (id, workspace_id, session_id, github_repository_id, branch_name,
     pull_request_number, pull_request_url, pull_request_state, is_draft, created_at)
  VALUES
    (gh_br1_id, ws_id, sess6_id, gh_repo1_id,
     'feat/ci-cd-pipeline', 1,
     'https://github.com/acme-corp/webapp/pull/1', 'merged', false,
     now() - interval '11 days'),
    (gh_br2_id, ws_id, sess4_id, gh_repo1_id,
     'feat/markdown-editor', 7,
     'https://github.com/acme-corp/webapp/pull/7', 'open', true,
     now() - interval '3 days'),
    (gh_br3_id, ws_id, sess5_id, gh_repo1_id,
     'feat/triage-shortcuts', 12,
     'https://github.com/acme-corp/webapp/pull/12', 'open', false,
     now() - interval '1 day');

  -- -------------------------------------------------------------------------
  -- 10. Agent runs + messages (one coherent run history per session)
  --
  -- Every artifact a session produced was generated by an agent run, so the
  -- Run Activity panel on the session detail page never shows "No runs recorded
  -- yet" for an in-flight session. Per session:
  --   * one success run per already-approved stage (from phase completions),
  --   * plus the current stage's run(s) derived from phase_status, where
  --     N = sessions.rejection_count (rejections of the current stage):
  --       agent_generating -> N rejected attempts + 1 queued run (the current
  --                           attempt; queued + null job survives the worker's
  --                           stall sweep, so it stays in-flight in the demo)
  --       awaiting_review  -> N rejected attempts + 1 success run (awaiting)
  --       rejected         -> N success runs that were each rejected
  --       approved         -> already covered by the completed-stage runs
  -- -------------------------------------------------------------------------
  FOR sess_rec IN
    SELECT s.id, s.title, s.creator_member_id, s.phase_status,
           s.current_stage_id, s.rejection_count, s.updated_at,
           cs.slug AS cur_slug, cs.name AS cur_name
    FROM public.sessions s
    JOIN public.pipeline_stages cs ON cs.id = s.current_stage_id
    WHERE s.workspace_id = ws_id
    ORDER BY s.number
  LOOP
    -- Approved prior stages: one success run each, finishing at approval time.
    FOR comp_rec IN
      SELECT pc.stage_id, pc.stage_slug, pc.completed_at,
             pc.completed_by_member_id, ps.name AS stage_name
      FROM public.session_phase_completions pc
      JOIN public.pipeline_stages ps ON ps.id = pc.stage_id
      WHERE pc.session_id = sess_rec.id
      ORDER BY ps.position
    LOOP
      PERFORM internal.seed_agent_run(
        ws_id, sess_rec.id,
        coalesce(comp_rec.completed_by_member_id, sess_rec.creator_member_id),
        sess_rec.title, comp_rec.stage_id, comp_rec.stage_slug, comp_rec.stage_name,
        'completed', 1,
        comp_rec.completed_at - interval '25 minutes', comp_rec.completed_at);
    END LOOP;

    -- Current stage runs (skipped when phase_status = 'approved': the final
    -- stage is already represented as a completed run above).
    IF sess_rec.phase_status <> 'approved' THEN
      DECLARE
        v_rej int := greatest(coalesce(sess_rec.rejection_count, 0), 0);
        i int;
        v_fin timestamptz;
      BEGIN
        IF sess_rec.phase_status = 'rejected' THEN
          -- N success runs, each rejected; most recent finished at updated_at.
          FOR i IN 1..greatest(v_rej, 1) LOOP
            v_fin := sess_rec.updated_at - (greatest(v_rej, 1) - i) * interval '3 hours';
            PERFORM internal.seed_agent_run(
              ws_id, sess_rec.id, sess_rec.creator_member_id, sess_rec.title,
              sess_rec.current_stage_id, sess_rec.cur_slug, sess_rec.cur_name,
              'rejected', i, v_fin - interval '25 minutes', v_fin);
          END LOOP;
        ELSE
          -- agent_generating / awaiting_review: N prior rejected attempts, then
          -- the current attempt (running, or a success awaiting review).
          FOR i IN 1..v_rej LOOP
            v_fin := sess_rec.updated_at - (v_rej - i + 1) * interval '3 hours';
            PERFORM internal.seed_agent_run(
              ws_id, sess_rec.id, sess_rec.creator_member_id, sess_rec.title,
              sess_rec.current_stage_id, sess_rec.cur_slug, sess_rec.cur_name,
              'rejected', i, v_fin - interval '25 minutes', v_fin);
          END LOOP;

          IF sess_rec.phase_status = 'agent_generating' THEN
            PERFORM internal.seed_agent_run(
              ws_id, sess_rec.id, sess_rec.creator_member_id, sess_rec.title,
              sess_rec.current_stage_id, sess_rec.cur_slug, sess_rec.cur_name,
              'queued', v_rej + 1, sess_rec.updated_at, null);
          ELSE  -- awaiting_review
            PERFORM internal.seed_agent_run(
              ws_id, sess_rec.id, sess_rec.creator_member_id, sess_rec.title,
              sess_rec.current_stage_id, sess_rec.cur_slug, sess_rec.cur_name,
              'awaiting', v_rej + 1,
              sess_rec.updated_at - interval '25 minutes', sess_rec.updated_at);
          END IF;
        END IF;
      END;
    END IF;
  END LOOP;

END;
$$;

-- Re-enable triggers.
SET session_replication_role = DEFAULT;

-- Drop the seeding helper so it doesn't linger in the database.
DROP FUNCTION IF EXISTS internal.seed_agent_run(
  uuid, uuid, uuid, text, uuid, text, text, text, int, timestamptz, timestamptz);
