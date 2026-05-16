-- =============================================================================
-- Seed data for local development
-- Runs automatically on `supabase db reset`
--
-- `sessions` is the pipeline source of truth. Upstream tracker references
-- live on `sessions.linear_issue_id` / `sessions.linear_issue_url`.
--
-- We seed eighteen sessions across the six pipeline phases (2-3 per column)
-- with a mix of statuses so the pipeline board looks realistic.
-- =============================================================================

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

  -- Pipeline (default 6-stage seed)
  default_pipeline_id uuid := 'd1b2c3d4-0001-4000-8000-000000000001';
  stage_product_id     uuid;
  stage_design_id      uuid;
  stage_engineering_id uuid;
  stage_review_id      uuid;
  stage_land_id        uuid;
  stage_monitor_id     uuid;

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

  -- Agent jobs & runs (pipeline work on session #2)
  job1_id  uuid := '21b2c3d4-0001-4000-8000-000000000001';
  job2_id  uuid := '21b2c3d4-0002-4000-8000-000000000002';
  run1_id  uuid := '22b2c3d4-0001-4000-8000-000000000001';
  run2_id  uuid := '22b2c3d4-0002-4000-8000-000000000002';
  msg1_id  uuid := '23b2c3d4-0001-4000-8000-000000000001';
  msg2_id  uuid := '23b2c3d4-0002-4000-8000-000000000002';
  msg3_id  uuid := '23b2c3d4-0003-4000-8000-000000000003';
  msg4_id  uuid := '23b2c3d4-0004-4000-8000-000000000004';
  msg5_id  uuid := '23b2c3d4-0005-4000-8000-000000000005';

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
  -- 5a. Default pipeline + 6 seeded stages.
  --     Mirrors the legacy phase order so seed sessions slot into the same
  --     pipeline shape they used pre-refactor.
  -- -------------------------------------------------------------------------
  INSERT INTO public.pipelines (id, workspace_id, name, is_default)
  VALUES (default_pipeline_id, ws_id, 'Default', true);

  INSERT INTO public.pipeline_stages (
    pipeline_id, workspace_id, position, slug, name, description, prompt_template_md
  )
  SELECT default_pipeline_id, ws_id, s.stage_position, s.slug, s.name, s.description, s.prompt_template_md
  FROM internal.default_pipeline_stages() s;

  SELECT id INTO stage_product_id     FROM public.pipeline_stages WHERE pipeline_id = default_pipeline_id AND slug = 'product';
  SELECT id INTO stage_design_id      FROM public.pipeline_stages WHERE pipeline_id = default_pipeline_id AND slug = 'design';
  SELECT id INTO stage_engineering_id FROM public.pipeline_stages WHERE pipeline_id = default_pipeline_id AND slug = 'engineering';
  SELECT id INTO stage_review_id      FROM public.pipeline_stages WHERE pipeline_id = default_pipeline_id AND slug = 'review';
  SELECT id INTO stage_land_id        FROM public.pipeline_stages WHERE pipeline_id = default_pipeline_id AND slug = 'land';
  SELECT id INTO stage_monitor_id     FROM public.pipeline_stages WHERE pipeline_id = default_pipeline_id AND slug = 'monitor';

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
  -- 7. Sessions (one per phase for a realistic tour of the pipeline)
  -- -------------------------------------------------------------------------

  -- Session 1: product / awaiting_review — agent just finished the spec
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess1_id, ws_id, 1,
     'Add SSO login via Google Workspace',
     E'We need SSO for the Business plan — Google Workspace first, Okta later. IT asked for this on the call Monday.',
     mem1_id,
     default_pipeline_id, stage_product_id, 'awaiting_review', 1,
     now() - interval '2 hours', now() - interval '90 minutes');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess1_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# Add SSO login via Google Workspace\n\n## Problem Statement\n\nBusiness customers cannot enforce login policies or reclaim seats when employees leave because Wallie only supports email/password.\n\n## User Story\n\nAs an IT admin on the Business plan, I want to require Google Workspace SSO for my workspace so that only employees with active corporate accounts can log in.\n\n## Acceptance Criteria\n\n- Owners can enable Google SSO from the workspace settings page.\n- Members with matching email domains sign in via Google and are auto-added to the workspace.\n- Non-matching domains are rejected with a clear error.\n- Email/password login is disabled for the workspace once SSO is required.\n\n## Constraints\n\n- Must use Supabase Auth Google provider.\n- Must not break existing email/password sessions mid-request.\n\n## Non-Goals\n\n- Okta, Microsoft Entra, or other IdPs (follow-up).\n\n## Open Questions\n\n- Should we require MFA enforcement client-side or trust Google?\n'::text),
     now() - interval '90 minutes');

  -- Session 2: design / agent_generating — product approved, design agent running
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess2_id, ws_id, 2,
     'Self-serve workspace creation flow',
     E'Onboarding is dropping off at workspace creation. Let''s build a proper guided flow.',
     mem1_id,
     default_pipeline_id, stage_design_id, 'agent_generating', 0,
     now() - interval '1 day', now() - interval '30 minutes');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess2_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# Self-serve workspace creation flow\n\n## Problem Statement\n\nNew users land on an empty dashboard after signup with no indication of how to create a workspace.\n\n## User Story\n\nAs a newly-signed-up user, I want a guided flow that collects a name and slug so that I land inside a working workspace immediately.\n\n## Acceptance Criteria\n\n- Post-signup users are redirected to /new-workspace.\n- Slug is auto-derived from the name with a live preview.\n- Successful creation redirects to /w/{slug}.\n'::text),
     now() - interval '20 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess2_id, ws_id, stage_product_id, 'product', now() - interval '18 hours', mem1_id);

  -- Session 3: engineering / awaiting_review — product + design approved
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess3_id, ws_id, 3,
     'Real-time session updates via Supabase Realtime',
     E'The board feels stale when two people are triaging at once. Can we wire up realtime?',
     mem2_id,
     default_pipeline_id, stage_engineering_id, 'awaiting_review', 1,
     now() - interval '3 days', now() - interval '5 hours');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess3_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# Real-time session updates via Supabase Realtime\n\n## Problem Statement\n\nBoard state goes stale during collaborative triage, causing duplicate edits and conflicting updates.\n\n## User Story\n\nAs a triager, I want session changes from my teammates to appear without refreshing so we do not step on each other.\n\n## Acceptance Criteria\n\n- Changes broadcast via Supabase Realtime within one second.\n- Local cache merges remote INSERT/UPDATE/DELETE events.\n- Connection status is visible in the UI.\n'::text),
     now() - interval '2 days 18 hours'),
    (sess3_id, ws_id, stage_design_id, 'design', 1,
     to_jsonb(E'# Design\n\nUse supabase.channel() with workspace_id filter; last-write-wins conflict resolution for v1.\n'::text),
     now() - interval '2 days'),
    (sess3_id, ws_id, stage_engineering_id, 'engineering', 1,
     to_jsonb(E'# Engineering\n\nImplemented useRealtimeSessions hook; connection indicator added to shell header.\n'::text),
     now() - interval '5 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess3_id, ws_id, stage_product_id, 'product', now() - interval '2 days 12 hours', mem2_id),
    (sess3_id, ws_id, stage_design_id, 'design',  now() - interval '1 day',           mem2_id);

  -- Session 4: review / agent_generating — code written, reviewing PR
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
    (sess4_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# Rich-text editor for session prompts\n\n## Problem Statement\n\nThe plain textarea does not support formatting, code blocks, or image paste, which is a hard blocker for teams documenting bugs.\n\n## User Story\n\nAs a session author, I want a rich-text editor with code blocks and image paste so that I can communicate context clearly.\n\n## Acceptance Criteria\n\n- Bold, italic, strikethrough, code formatting via Cmd+B/I/shift+X/E.\n- Code blocks with syntax highlighting.\n- Image paste uploads to Supabase Storage.\n'::text),
     now() - interval '5 days 20 hours'),
    (sess4_id, ws_id, stage_design_id, 'design', 1,
     to_jsonb(E'# Design\n\nTiptap chosen over CodeMirror for block-level editing; image uploads reuse workspace-avatars bucket.\n'::text),
     now() - interval '5 days'),
    (sess4_id, ws_id, stage_engineering_id, 'engineering', 1,
     to_jsonb(E'# Engineering\n\nMarkdownEditor component wired up; basic formatting, code blocks, and image paste implemented.\n'::text),
     now() - interval '1 day');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess4_id, ws_id, stage_product_id, 'product',     now() - interval '5 days 12 hours', mem1_id),
    (sess4_id, ws_id, stage_design_id, 'design',      now() - interval '4 days',          mem1_id),
    (sess4_id, ws_id, stage_engineering_id, 'engineering', now() - interval '20 hours',        mem1_id);

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
    (sess5_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# Keyboard shortcuts for session triage\n\n## Problem Statement\n\nTriaging large backlogs is mouse-heavy and slow for power users.\n\n## User Story\n\nAs a power user, I want j/k navigation and hotkeys for common actions so that I can triage sessions without leaving the keyboard.\n\n## Acceptance Criteria\n\n- j/k moves the focused session up/down.\n- s/p/a open status/priority/assignee menus.\n- Shortcuts are documented in a ? overlay.\n'::text),
     now() - interval '7 days'),
    (sess5_id, ws_id, stage_design_id, 'design', 1,
     to_jsonb(E'# Design\n\nUse tinykeys for global shortcut provider; show ? overlay with all bindings.\n'::text),
     now() - interval '6 days'),
    (sess5_id, ws_id, stage_engineering_id, 'engineering', 1,
     to_jsonb(E'# Engineering\n\nAll shortcuts wired; overlay uses same Dialog primitive as command palette.\n'::text),
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
    (sess5_id, ws_id, stage_product_id, 'product',     now() - interval '6 days 20 hours', mem2_id),
    (sess5_id, ws_id, stage_design_id, 'design',      now() - interval '5 days',          mem2_id),
    (sess5_id, ws_id, stage_engineering_id, 'engineering', now() - interval '4 hours',         mem2_id),
    (sess5_id, ws_id, stage_review_id, 'review',      now() - interval '3 hours',         mem1_id);

  -- Session 6: monitor / approved, archived — shipped & watching metrics
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     archived_at, created_at, updated_at)
  VALUES
    (sess6_id, ws_id, 6,
     'CI/CD pipeline with GitHub Actions',
     E'We need CI — tests + lint on PRs, staging deploy on merge, production gated.',
     mem1_id,
     default_pipeline_id, stage_monitor_id, 'approved', 1,
     now() - interval '10 days',
     now() - interval '13 days', now() - interval '10 days');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess6_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# CI/CD pipeline with GitHub Actions\n\n## Problem Statement\n\nTests and linters are only run locally, so broken commits land on main and bottleneck the deploy story.\n\n## User Story\n\nAs a developer, I want CI to catch broken commits and auto-deploy green merges to staging so that we can ship without manual toil.\n\n## Acceptance Criteria\n\n- PR checks run tests and lint.\n- Merge to main deploys to staging automatically.\n- Production deploy requires manual approval.\n'::text),
     now() - interval '12 days 20 hours'),
    (sess6_id, ws_id, stage_design_id, 'design', 1,
     to_jsonb(E'# Design\n\nUse GitHub Actions with environment protection rules for production approvals.\n'::text),
     now() - interval '12 days'),
    (sess6_id, ws_id, stage_engineering_id, 'engineering', 1,
     to_jsonb(E'# Engineering\n\n.github/workflows/ci.yml contains test, lint, and deploy jobs.\n'::text),
     now() - interval '11 days 12 hours'),
    (sess6_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nPR #1 reviewed and approved.\n'::text),
     now() - interval '11 days'),
    (sess6_id, ws_id, stage_land_id, 'land', 1,
     to_jsonb(E'# Land\n\nMerged to main; staging deployed automatically.\n'::text),
     now() - interval '10 days 12 hours'),
    (sess6_id, ws_id, stage_monitor_id, 'monitor', 1,
     to_jsonb(E'# Monitor\n\nPipeline has been green for a week; closing out.\n'::text),
     now() - interval '10 days');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess6_id, ws_id, stage_product_id, 'product',     now() - interval '12 days 12 hours', mem1_id),
    (sess6_id, ws_id, stage_design_id, 'design',      now() - interval '11 days 18 hours', mem1_id),
    (sess6_id, ws_id, stage_engineering_id, 'engineering', now() - interval '11 days 6 hours',  mem1_id),
    (sess6_id, ws_id, stage_review_id, 'review',      now() - interval '10 days 18 hours', mem1_id),
    (sess6_id, ws_id, stage_land_id, 'land',        now() - interval '10 days 12 hours', mem1_id),
    (sess6_id, ws_id, stage_monitor_id, 'monitor',     now() - interval '10 days',          mem1_id);

  -- -------------------------------------------------------------------------
  -- 7b. Additional sessions (multiple cards per pipeline column)
  -- -------------------------------------------------------------------------

  -- Session 7: product / awaiting_review
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess7_id, ws_id, 7,
     'Dark mode and theme customization',
     E'Users keep asking for dark mode. Let''s add a theme toggle in settings with system preference detection.',
     mem2_id,
     default_pipeline_id, stage_product_id, 'awaiting_review', 1,
     now() - interval '1 hour', now() - interval '45 minutes');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess7_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# Dark mode and theme customization\n\nAdd a theme toggle to settings. Detect system preference, allow manual override, persist per user.'::text),
     now() - interval '45 minutes');

  -- Session 8: product / agent_generating (rejected once, re-generating)
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version, rejection_count,
     created_at, updated_at)
  VALUES
    (sess8_id, ws_id, 8,
     'Weekly email digest of pipeline activity',
     E'We need a weekly email summarizing pipeline activity — sessions that moved, stuck items, and PRs awaiting review.',
     mem1_id,
     default_pipeline_id, stage_product_id, 'agent_generating', 0, 1,
     now() - interval '4 hours', now() - interval '20 minutes');

  -- Session 9: design / awaiting_review
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess9_id, ws_id, 9,
     'Role-based access control for workspaces',
     E'We need granular permissions — viewer, editor, admin roles with controls over phase approvals and integrations.',
     mem1_id,
     default_pipeline_id, stage_design_id, 'awaiting_review', 1,
     now() - interval '2 days', now() - interval '4 hours');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess9_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# RBAC for workspaces\n\nViewer, editor, admin roles. Control phase approvals, integration management, and member invites.'::text),
     now() - interval '1 day 18 hours'),
    (sess9_id, ws_id, stage_design_id, 'design', 1,
     to_jsonb(E'# Design\n\nPermission matrix stored in workspace_members.role; RLS policies enforce at query time.'::text),
     now() - interval '4 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess9_id, ws_id, stage_product_id, 'product', now() - interval '1 day 12 hours', mem1_id);

  -- Session 10: design / rejected
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version, rejection_count,
     created_at, updated_at)
  VALUES
    (sess10_id, ws_id, 10,
     'Bulk session import from CSV and JSON',
     E'Teams migrating from Jira need bulk import. Accept CSV and JSON, validate, create sessions.',
     mem2_id,
     default_pipeline_id, stage_design_id, 'rejected', 1, 1,
     now() - interval '3 days', now() - interval '2 hours');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess10_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# Bulk session import\n\nAccept CSV/JSON upload, validate schema, create sessions with sequential numbering.'::text),
     now() - interval '2 days 18 hours'),
    (sess10_id, ws_id, stage_design_id, 'design', 1,
     to_jsonb(E'# Design\n\nDrag-and-drop upload zone; server-side validation via Zod schema; preview table before confirming.'::text),
     now() - interval '6 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess10_id, ws_id, stage_product_id, 'product', now() - interval '2 days 12 hours', mem2_id);

  -- Session 11: engineering / agent_generating
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess11_id, ws_id, 11,
     'Webhook notifications for pipeline events',
     E'External systems need to react to phase transitions. Add webhook registration and signed POST delivery.',
     mem1_id,
     default_pipeline_id, stage_engineering_id, 'agent_generating', 0,
     now() - interval '4 days', now() - interval '1 hour');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess11_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# Webhook notifications\n\nFire signed POST requests on session phase transitions to registered endpoints.'::text),
     now() - interval '3 days 18 hours'),
    (sess11_id, ws_id, stage_design_id, 'design', 1,
     to_jsonb(E'# Design\n\nWebhook registration UI in workspace settings; HMAC-SHA256 signing; retry with exponential backoff.'::text),
     now() - interval '3 days');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess11_id, ws_id, stage_product_id, 'product', now() - interval '3 days 12 hours', mem1_id),
    (sess11_id, ws_id, stage_design_id, 'design',  now() - interval '2 days',          mem2_id);

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
    (sess12_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# Two-factor authentication via TOTP\n\nTOTP setup flow with QR code, backup codes, workspace-level enforcement.'::text),
     now() - interval '4 days 18 hours'),
    (sess12_id, ws_id, stage_design_id, 'design', 1,
     to_jsonb(E'# Design\n\nUse otpauth URI for QR; store encrypted TOTP secret; enforce at login middleware.'::text),
     now() - interval '4 days'),
    (sess12_id, ws_id, stage_engineering_id, 'engineering', 1,
     to_jsonb(E'# Engineering\n\nTOTP verification middleware, setup page, backup code generation implemented.'::text),
     now() - interval '2 days'),
    (sess12_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nPR reviewed — tests pass, backup code flow verified manually.'::text),
     now() - interval '2 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess12_id, ws_id, stage_product_id, 'product',     now() - interval '4 days 12 hours', mem2_id),
    (sess12_id, ws_id, stage_design_id, 'design',      now() - interval '3 days 12 hours', mem1_id),
    (sess12_id, ws_id, stage_engineering_id, 'engineering', now() - interval '6 hours',         mem2_id);

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
    (sess13_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# API rate limiting\n\nPer-workspace rate limits with a dashboard showing request counts and quota usage.'::text),
     now() - interval '4 days 18 hours'),
    (sess13_id, ws_id, stage_design_id, 'design', 1,
     to_jsonb(E'# Design\n\nToken-bucket algorithm; Redis for counters; dashboard uses Recharts line chart.'::text),
     now() - interval '4 days'),
    (sess13_id, ws_id, stage_engineering_id, 'engineering', 1,
     to_jsonb(E'# Engineering\n\nRate-limit middleware and usage dashboard page implemented.'::text),
     now() - interval '2 days'),
    (sess13_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nReviewer flagged missing error handling on quota exceeded — needs fix.'::text),
     now() - interval '1 hour');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess13_id, ws_id, stage_product_id, 'product',     now() - interval '4 days 12 hours', mem1_id),
    (sess13_id, ws_id, stage_design_id, 'design',      now() - interval '3 days 12 hours', mem2_id),
    (sess13_id, ws_id, stage_engineering_id, 'engineering', now() - interval '4 hours',         mem1_id);

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
    (sess14_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# Email notification preferences\n\nPer-user settings: immediate, daily digest, or off for each event category.'::text),
     now() - interval '6 days 18 hours'),
    (sess14_id, ws_id, stage_design_id, 'design', 1,
     to_jsonb(E'# Design\n\nSettings page with toggle matrix; cron job for daily digest aggregation.'::text),
     now() - interval '6 days'),
    (sess14_id, ws_id, stage_engineering_id, 'engineering', 1,
     to_jsonb(E'# Engineering\n\nPreference table, settings UI, and digest cron job implemented.'::text),
     now() - interval '4 days'),
    (sess14_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nPR approved — email templates and preference persistence verified.'::text),
     now() - interval '3 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess14_id, ws_id, stage_product_id, 'product',     now() - interval '6 days 12 hours', mem2_id),
    (sess14_id, ws_id, stage_design_id, 'design',      now() - interval '5 days 12 hours', mem1_id),
    (sess14_id, ws_id, stage_engineering_id, 'engineering', now() - interval '5 hours',         mem2_id),
    (sess14_id, ws_id, stage_review_id, 'review',      now() - interval '3 hours',         mem1_id);

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
    (sess15_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# Audit log\n\nTamper-evident log of admin actions for compliance. Append-only table with actor, action, and metadata.'::text),
     now() - interval '8 days 18 hours'),
    (sess15_id, ws_id, stage_design_id, 'design', 1,
     to_jsonb(E'# Design\n\nAppend-only audit_events table; filterable log viewer in workspace settings.'::text),
     now() - interval '8 days'),
    (sess15_id, ws_id, stage_engineering_id, 'engineering', 1,
     to_jsonb(E'# Engineering\n\nAudit event triggers on member/integration changes; log viewer with date range filter.'::text),
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
    (sess15_id, ws_id, stage_product_id, 'product',     now() - interval '8 days 12 hours', mem1_id),
    (sess15_id, ws_id, stage_design_id, 'design',      now() - interval '7 days',          mem2_id),
    (sess15_id, ws_id, stage_engineering_id, 'engineering', now() - interval '5 days',          mem1_id),
    (sess15_id, ws_id, stage_review_id, 'review',      now() - interval '3 days',          mem2_id);

  -- Session 16: monitor / awaiting_review
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess16_id, ws_id, 16,
     'Search and filter across all sessions',
     E'With dozens of sessions it is hard to find things. Add full-text search and phase/status filters.',
     mem2_id,
     default_pipeline_id, stage_monitor_id, 'awaiting_review', 1,
     now() - interval '11 days', now() - interval '7 days');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess16_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# Search and filter\n\nFull-text search on titles and prompts, plus filters by phase, status, and creator.'::text),
     now() - interval '10 days 18 hours'),
    (sess16_id, ws_id, stage_design_id, 'design', 1,
     to_jsonb(E'# Design\n\nPostgres tsvector index on sessions; faceted filter UI with URL-synced state.'::text),
     now() - interval '10 days'),
    (sess16_id, ws_id, stage_engineering_id, 'engineering', 1,
     to_jsonb(E'# Engineering\n\nSearch index migration, API endpoint, and filter sidebar implemented.'::text),
     now() - interval '9 days'),
    (sess16_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nPR approved — search relevance and filter combinations tested.'::text),
     now() - interval '8 days 12 hours'),
    (sess16_id, ws_id, stage_land_id, 'land', 1,
     to_jsonb(E'# Land\n\nMerged and deployed to staging; search index backfill complete.'::text),
     now() - interval '8 days'),
    (sess16_id, ws_id, stage_monitor_id, 'monitor', 1,
     to_jsonb(E'# Monitor\n\nSearch latency p95 under 200ms; monitoring for index drift.'::text),
     now() - interval '7 days');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess16_id, ws_id, stage_product_id, 'product',     now() - interval '10 days 12 hours', mem2_id),
    (sess16_id, ws_id, stage_design_id, 'design',      now() - interval '9 days 18 hours',  mem1_id),
    (sess16_id, ws_id, stage_engineering_id, 'engineering', now() - interval '8 days 18 hours',  mem2_id),
    (sess16_id, ws_id, stage_review_id, 'review',      now() - interval '8 days 6 hours',   mem1_id),
    (sess16_id, ws_id, stage_land_id, 'land',        now() - interval '7 days 12 hours',  mem2_id);

  -- Session 17: monitor / agent_generating
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version,
     created_at, updated_at)
  VALUES
    (sess17_id, ws_id, 17,
     'GitHub PR auto-link from branch naming convention',
     E'When a branch matches wallie-{number}, auto-associate the PR with the session and show it on the card.',
     mem1_id,
     default_pipeline_id, stage_monitor_id, 'agent_generating', 0,
     now() - interval '12 days', now() - interval '8 days');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess17_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# GitHub PR auto-link\n\nAuto-associate PRs with sessions based on branch naming convention wallie-{number}.'::text),
     now() - interval '11 days 18 hours'),
    (sess17_id, ws_id, stage_design_id, 'design', 1,
     to_jsonb(E'# Design\n\nGitHub webhook listener parses branch name; creates session_pull_requests row on match.'::text),
     now() - interval '11 days'),
    (sess17_id, ws_id, stage_engineering_id, 'engineering', 1,
     to_jsonb(E'# Engineering\n\nWebhook handler and branch parser implemented; PR card badge added to pipeline view.'::text),
     now() - interval '10 days'),
    (sess17_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nPR approved — tested with various branch name formats.'::text),
     now() - interval '9 days 12 hours'),
    (sess17_id, ws_id, stage_land_id, 'land', 1,
     to_jsonb(E'# Land\n\nMerged; existing PRs backfilled via one-time script.'::text),
     now() - interval '9 days');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess17_id, ws_id, stage_product_id, 'product',     now() - interval '11 days 12 hours', mem1_id),
    (sess17_id, ws_id, stage_design_id, 'design',      now() - interval '10 days 18 hours', mem2_id),
    (sess17_id, ws_id, stage_engineering_id, 'engineering', now() - interval '9 days 18 hours',  mem1_id),
    (sess17_id, ws_id, stage_review_id, 'review',      now() - interval '9 days 6 hours',   mem2_id),
    (sess17_id, ws_id, stage_land_id, 'land',        now() - interval '8 days 12 hours',  mem1_id);

  -- Session 18: monitor / awaiting_review (1 rejection)
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     pipeline_id, current_stage_id, phase_status, current_artifact_version, rejection_count,
     created_at, updated_at)
  VALUES
    (sess18_id, ws_id, 18,
     'Custom workspace branding and logo upload',
     E'Enterprise customers want their logo in the sidebar and on shared links. Upload to Storage, display in shell.',
     mem1_id,
     default_pipeline_id, stage_monitor_id, 'awaiting_review', 1, 1,
     now() - interval '12 days', now() - interval '6 days');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at)
  VALUES
    (sess18_id, ws_id, stage_product_id, 'product', 1,
     to_jsonb(E'# Custom workspace branding\n\nLogo upload to Supabase Storage; display in sidebar header and OG image meta tags.'::text),
     now() - interval '11 days 18 hours'),
    (sess18_id, ws_id, stage_design_id, 'design', 1,
     to_jsonb(E'# Design\n\nImage upload with crop/resize; store in workspace-branding bucket; serve via CDN URL.'::text),
     now() - interval '11 days'),
    (sess18_id, ws_id, stage_engineering_id, 'engineering', 1,
     to_jsonb(E'# Engineering\n\nUpload endpoint, image processing, and sidebar logo component implemented.'::text),
     now() - interval '9 days'),
    (sess18_id, ws_id, stage_review_id, 'review', 1,
     to_jsonb(E'# Review\n\nPR approved — image validation and fallback tested.'::text),
     now() - interval '8 days'),
    (sess18_id, ws_id, stage_land_id, 'land', 1,
     to_jsonb(E'# Land\n\nMerged and deployed; storage bucket policies configured.'::text),
     now() - interval '7 days'),
    (sess18_id, ws_id, stage_monitor_id, 'monitor', 1,
     to_jsonb(E'# Monitor\n\nMonitoring image upload latency and CDN cache hit rate. One rejection for missing retina support — now fixed.'::text),
     now() - interval '6 days');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id)
  VALUES
    (sess18_id, ws_id, stage_product_id, 'product',     now() - interval '11 days 12 hours', mem1_id),
    (sess18_id, ws_id, stage_design_id, 'design',      now() - interval '10 days',          mem2_id),
    (sess18_id, ws_id, stage_engineering_id, 'engineering', now() - interval '8 days 12 hours',  mem1_id),
    (sess18_id, ws_id, stage_review_id, 'review',      now() - interval '7 days 12 hours',  mem2_id),
    (sess18_id, ws_id, stage_land_id, 'land',        now() - interval '6 days 12 hours',  mem1_id);

  -- -------------------------------------------------------------------------
  -- 8. GitHub branches / PRs (linked to sessions)
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
  -- 9. Agent jobs + runs (pipeline work on sessions #4 and #2)
  -- -------------------------------------------------------------------------

  -- Job 1: successful run on session #4
  INSERT INTO public.agent_jobs
    (id, workspace_id, session_id, requested_by_member_id, trigger_type, job_type,
     status, attempt_count, started_at, finished_at, created_at)
  VALUES
    (job1_id, ws_id, sess4_id, mem1_id, 'manual_run', 'session',
     'success', 1, now() - interval '6 days', now() - interval '5 days 23 hours',
     now() - interval '6 days');

  INSERT INTO public.agent_runs
    (id, workspace_id, session_id, agent_job_id, triggered_by_member_id,
     run_type, model_provider, model_name, status,
     started_at, finished_at, created_at)
  VALUES
    (run1_id, ws_id, sess4_id, job1_id, mem1_id,
     'code', 'anthropic', 'claude-sonnet-4-20250514', 'success',
     now() - interval '6 days', now() - interval '5 days 23 hours',
     now() - interval '6 days');

  INSERT INTO public.agent_run_messages
    (id, workspace_id, agent_run_id, kind, message_md, created_at)
  VALUES
    (msg1_id, ws_id, run1_id, 'user',
     E'Generate a product spec for the rich-text editor request. See the session prompt.',
     now() - interval '6 days'),
    (msg2_id, ws_id, run1_id, 'assistant',
     E'Analyzing the request. Going with Tiptap over CodeMirror 6 for block-level editing and image paste support.',
     now() - interval '5 days 23 hours 55 minutes'),
    (msg3_id, ws_id, run1_id, 'assistant',
     E'Done — product spec written to the session. Key points: Tiptap for formatting, Supabase Storage for image paste, Cmd+B/I/code shortcuts, code blocks with syntax highlighting.',
     now() - interval '5 days 23 hours');

  -- Job 2: currently running (session #2 design agent)
  INSERT INTO public.agent_jobs
    (id, workspace_id, session_id, requested_by_member_id, trigger_type, job_type,
     status, attempt_count, started_at, created_at)
  VALUES
    (job2_id, ws_id, sess2_id, mem1_id, 'manual_run', 'session',
     'running', 1, now() - interval '30 minutes',
     now() - interval '30 minutes');

  INSERT INTO public.agent_runs
    (id, workspace_id, session_id, agent_job_id, triggered_by_member_id,
     run_type, model_provider, model_name, status,
     started_at, created_at)
  VALUES
    (run2_id, ws_id, sess2_id, job2_id, mem1_id,
     'code', 'anthropic', 'claude-sonnet-4-20250514', 'running',
     now() - interval '30 minutes',
     now() - interval '30 minutes');

  INSERT INTO public.agent_run_messages
    (id, workspace_id, agent_run_id, kind, message_md, created_at)
  VALUES
    (msg4_id, ws_id, run2_id, 'user',
     E'Product spec is approved — generate the design artifact for the workspace creation flow.',
     now() - interval '30 minutes'),
    (msg5_id, ws_id, run2_id, 'assistant',
     E'Drafting the design. Slug derivation + live preview, post-signup redirect, and a success-state confetti (stretch) for the new workspace landing.',
     now() - interval '25 minutes');

END;
$$;

-- Re-enable triggers.
SET session_replication_role = DEFAULT;
