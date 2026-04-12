-- =============================================================================
-- Seed data for local development
-- Runs automatically on `supabase db reset`
--
-- Shape after PR 4 cleanup:
--   - `issues` is a thin anchor row (title, description_md, repo link). The
--     legacy classical-tracker columns (status, priority, plan_md, design_md,
--     assignee_member_id, ...) have been dropped.
--   - `sessions` is the pipeline source of truth. Every pipeline row has an
--     anchor issue via `sessions.issue_id`.
--   - `issue_comments` and `issue_links` tables no longer exist — discussion
--     lives in Slack threads and links are tracked through Linear.
--
-- We seed six sessions, one per pipeline phase, so the session list + detail
-- views have realistic data to render for every state.
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

  -- Issues (anchor rows, one per session)
  iss1_id   uuid := 'd1b2c3d4-0001-4000-8000-000000000001';
  iss2_id   uuid := 'd1b2c3d4-0002-4000-8000-000000000002';
  iss3_id   uuid := 'd1b2c3d4-0003-4000-8000-000000000003';
  iss4_id   uuid := 'd1b2c3d4-0004-4000-8000-000000000004';
  iss5_id   uuid := 'd1b2c3d4-0005-4000-8000-000000000005';
  iss6_id   uuid := 'd1b2c3d4-0006-4000-8000-000000000006';

  -- Sessions
  sess1_id  uuid := 'a2b2c3d4-0001-4000-8000-000000000001';
  sess2_id  uuid := 'a2b2c3d4-0002-4000-8000-000000000002';
  sess3_id  uuid := 'a2b2c3d4-0003-4000-8000-000000000003';
  sess4_id  uuid := 'a2b2c3d4-0004-4000-8000-000000000004';
  sess5_id  uuid := 'a2b2c3d4-0005-4000-8000-000000000005';
  sess6_id  uuid := 'a2b2c3d4-0006-4000-8000-000000000006';

  -- GitHub integration
  gh_inst_id  uuid := '11b2c3d4-0001-4000-8000-000000000001';
  gh_repo1_id uuid := '12b2c3d4-0001-4000-8000-000000000001';
  gh_repo2_id uuid := '12b2c3d4-0002-4000-8000-000000000002';
  gh_br1_id   uuid := '13b2c3d4-0001-4000-8000-000000000001';
  gh_br2_id   uuid := '13b2c3d4-0002-4000-8000-000000000002';
  gh_br3_id   uuid := '13b2c3d4-0003-4000-8000-000000000003';

  -- Slack installation (fake bot token — no real decryption happens in dev)
  slack_inst_id uuid := '14b2c3d4-0001-4000-8000-000000000001';

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

  -- Reusable product-spec JSON builder. Keeps each session's artifact under
  -- the ProductSpec shape the product-agent emits.
  product_spec_template jsonb;

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
      'wallie@gmail.com',
      crypt('password123', gen_salt('bf')),
      now(), '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object(
        'sub', user1_id::text,
        'email', 'wallie@gmail.com',
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
      'bob@example.com',
      crypt('password123', gen_salt('bf')),
      now(), '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object(
        'sub', user2_id::text,
        'email', 'bob@example.com',
        'full_name', 'Bob Chen',
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
      jsonb_build_object('sub', user1_id::text, 'email', 'wallie@gmail.com'),
      'email', now(), now() - interval '14 days', now()
    ),
    (
      gen_random_uuid(), user2_id::text, user2_id,
      jsonb_build_object('sub', user2_id::text, 'email', 'bob@example.com'),
      'email', now(), now() - interval '12 days', now()
    );

  -- -------------------------------------------------------------------------
  -- 2. Profiles
  -- -------------------------------------------------------------------------
  INSERT INTO public.profiles (id, primary_email, full_name, avatar_url, created_at)
  VALUES
    (user1_id, 'wallie@gmail.com', 'Anant Jain', null, now() - interval '14 days'),
    (user2_id, 'bob@example.com',  'Bob Chen',   null, now() - interval '12 days');

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
    (mem1_id, ws_id, user1_id, 'human', 'owner',  'wallie@gmail.com', 'Anant Jain', null, now() - interval '14 days'),
    (mem2_id, ws_id, user2_id, 'human', 'member', 'bob@example.com',  'Bob Chen',   null, now() - interval '12 days');

  INSERT INTO public.workspace_members
    (id, workspace_id, kind, role, username, full_name, created_at)
  VALUES
    (memw_id, ws_id, 'system', 'agent', 'wallie', 'Wallie', now() - interval '14 days');

  -- -------------------------------------------------------------------------
  -- 5. Issue counter (Slack handler reuses this for session numbers)
  -- -------------------------------------------------------------------------
  INSERT INTO internal.workspace_issue_counters (workspace_id, last_issue_number)
  VALUES (ws_id, 6);

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
  -- 7. Slack installation (placeholder bot token; real Slack calls are gated
  --    by env/config and won't be made against dev seed data).
  -- -------------------------------------------------------------------------
  INSERT INTO public.slack_installations
    (id, workspace_id, team_id, team_name, bot_token_encrypted, installed_at)
  VALUES
    (slack_inst_id, ws_id, 'T0ACMECORP', 'Acme Corp',
     'seed-placeholder-not-a-real-token',
     now() - interval '13 days');

  -- -------------------------------------------------------------------------
  -- 8. Issues (anchor rows — pipeline state lives on `sessions`)
  -- -------------------------------------------------------------------------
  INSERT INTO public.issues
    (id, workspace_id, number, title, description_md,
     creator_member_id, github_repository_id, created_at, updated_at)
  VALUES
    (iss1_id, ws_id, 1,
     'Add SSO login via Google Workspace',
     E'Teams on the Business plan need SSO so IT can enforce login policies and reclaim seats when people leave. Google Workspace first, then Okta later.',
     mem1_id, gh_repo1_id,
     now() - interval '2 hours', now() - interval '2 hours'),

    (iss2_id, ws_id, 2,
     'Self-serve workspace creation flow',
     E'New users need a guided flow to create their first workspace after signing up. Name input with slug preview, auto-redirect to the new workspace on success.',
     mem1_id, gh_repo1_id,
     now() - interval '1 day', now() - interval '6 hours'),

    (iss3_id, ws_id, 3,
     'Real-time issue updates via Supabase Realtime',
     E'When a teammate changes an issue, everyone viewing the board should see it update instantly. Subscribe to `issues` changes filtered by `workspace_id` and merge into local cache.',
     mem2_id, gh_repo1_id,
     now() - interval '3 days', now() - interval '12 hours'),

    (iss4_id, ws_id, 4,
     'Rich-text editor for issue descriptions',
     E'Replace the plain textarea with Tiptap. Live preview, syntax highlighting in code blocks, image paste, and Cmd+B/I keyboard shortcuts.',
     mem1_id, gh_repo1_id,
     now() - interval '6 days', now() - interval '4 hours'),

    (iss5_id, ws_id, 5,
     'Keyboard shortcuts for issue triage',
     E'Power users should be able to triage issues without touching the mouse. j/k navigation, s for status, p for priority, a to assign.',
     mem2_id, gh_repo1_id,
     now() - interval '8 days', now() - interval '1 day'),

    (iss6_id, ws_id, 6,
     'CI/CD pipeline with GitHub Actions',
     E'Automated tests, linting, and deploy-on-merge for `main`. PR checks run tests + lint; merge triggers staging deploy; production is manual approval.',
     mem1_id, gh_repo1_id,
     now() - interval '13 days', now() - interval '10 days');

  -- -------------------------------------------------------------------------
  -- 9. GitHub branches / PRs
  -- -------------------------------------------------------------------------
  INSERT INTO public.github_issue_branches
    (id, workspace_id, issue_id, github_repository_id, branch_name,
     pull_request_number, pull_request_url, pull_request_state, is_draft, created_at)
  VALUES
    (gh_br1_id, ws_id, iss6_id, gh_repo1_id,
     'feat/ci-cd-pipeline', 1,
     'https://github.com/acme-corp/webapp/pull/1', 'merged', false,
     now() - interval '11 days'),
    (gh_br2_id, ws_id, iss4_id, gh_repo1_id,
     'feat/markdown-editor', 7,
     'https://github.com/acme-corp/webapp/pull/7', 'open', true,
     now() - interval '3 days'),
    (gh_br3_id, ws_id, iss5_id, gh_repo1_id,
     'feat/triage-shortcuts', 12,
     'https://github.com/acme-corp/webapp/pull/12', 'open', false,
     now() - interval '1 day');

  -- -------------------------------------------------------------------------
  -- 10. Sessions (one per phase for a realistic tour of the pipeline)
  -- -------------------------------------------------------------------------

  product_spec_template := jsonb_build_object(
    'title', 'placeholder',
    'problem_statement', 'placeholder',
    'user_story', 'placeholder',
    'acceptance_criteria', jsonb_build_array('A', 'B'),
    'constraints', jsonb_build_array(),
    'non_goals', jsonb_build_array(),
    'open_questions', jsonb_build_array()
  );

  -- Session 1: product / awaiting_review — agent just finished the spec
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     slack_channel_id, slack_thread_ts,
     phase, phase_status, current_artifact_version,
     issue_id, created_at, updated_at)
  VALUES
    (sess1_id, ws_id, 1,
     'Add SSO login via Google Workspace',
     E'@wallie we need SSO for the Business plan — Google Workspace first, Okta later. IT asked for this on the call Monday.',
     mem1_id, 'C0ACME001', '1712822400.000100',
     'product', 'awaiting_review', 1,
     iss1_id, now() - interval '2 hours', now() - interval '90 minutes');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, phase, version, artifact_json, created_at)
  VALUES
    (sess1_id, ws_id, 'product', 1,
     product_spec_template
       || jsonb_build_object(
         'title', 'Add SSO login via Google Workspace',
         'problem_statement', 'Business customers cannot enforce login policies or reclaim seats when employees leave because Wallie only supports email/password.',
         'user_story', 'As an IT admin on the Business plan, I want to require Google Workspace SSO for my workspace so that only employees with active corporate accounts can log in.',
         'acceptance_criteria', jsonb_build_array(
           'Owners can enable Google SSO from the workspace settings page.',
           'Members with matching email domains sign in via Google and are auto-added to the workspace.',
           'Non-matching domains are rejected with a clear error.',
           'Email/password login is disabled for the workspace once SSO is required.'
         ),
         'constraints', jsonb_build_array(
           'Must use Supabase Auth Google provider.',
           'Must not break existing email/password sessions mid-request.'
         ),
         'non_goals', jsonb_build_array('Okta, Microsoft Entra, or other IdPs (follow-up).'),
         'open_questions', jsonb_build_array(
           'Should we require MFA enforcement client-side or trust Google?'
         )
       ),
     now() - interval '90 minutes');

  -- Session 2: design / agent_generating — product approved, design agent running
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     slack_channel_id, slack_thread_ts,
     phase, phase_status, current_artifact_version,
     issue_id, created_at, updated_at)
  VALUES
    (sess2_id, ws_id, 2,
     'Self-serve workspace creation flow',
     E'@wallie onboarding is dropping off at workspace creation. Let''s build a proper guided flow.',
     mem1_id, 'C0ACME001', '1712822400.000200',
     'design', 'agent_generating', 0,
     iss2_id, now() - interval '1 day', now() - interval '30 minutes');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, phase, version, artifact_json, created_at)
  VALUES
    (sess2_id, ws_id, 'product', 1,
     product_spec_template
       || jsonb_build_object(
         'title', 'Self-serve workspace creation flow',
         'problem_statement', 'New users land on an empty dashboard after signup with no indication of how to create a workspace.',
         'user_story', 'As a newly-signed-up user, I want a guided flow that collects a name and slug so that I land inside a working workspace immediately.',
         'acceptance_criteria', jsonb_build_array(
           'Post-signup users are redirected to /new-workspace.',
           'Slug is auto-derived from the name with a live preview.',
           'Successful creation redirects to /w/{slug}.'
         )
       ),
     now() - interval '20 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, phase, completed_at, completed_by_member_id)
  VALUES
    (sess2_id, ws_id, 'product', now() - interval '18 hours', mem1_id);

  -- Session 3: engineering / awaiting_review — product + design approved
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     slack_channel_id, slack_thread_ts,
     phase, phase_status, current_artifact_version,
     issue_id, created_at, updated_at)
  VALUES
    (sess3_id, ws_id, 3,
     'Real-time issue updates via Supabase Realtime',
     E'@wallie the board feels stale when two people are triaging at once. Can we wire up realtime?',
     mem2_id, 'C0ACME001', '1712822400.000300',
     'engineering', 'awaiting_review', 1,
     iss3_id, now() - interval '3 days', now() - interval '5 hours');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, phase, version, artifact_json, created_at)
  VALUES
    (sess3_id, ws_id, 'product', 1,
     product_spec_template
       || jsonb_build_object(
         'title', 'Real-time issue updates via Supabase Realtime',
         'problem_statement', 'Board state goes stale during collaborative triage, causing duplicate edits and conflicting updates.',
         'user_story', 'As a triager, I want issue changes from my teammates to appear without refreshing so we do not step on each other.',
         'acceptance_criteria', jsonb_build_array(
           'Changes broadcast via Supabase Realtime within one second.',
           'Local cache merges remote INSERT/UPDATE/DELETE events.',
           'Connection status is visible in the UI.'
         )
       ),
     now() - interval '2 days 18 hours'),
    (sess3_id, ws_id, 'design', 1,
     jsonb_build_object('manual', true, 'notes', 'Use supabase.channel() with workspace_id filter; last-write-wins conflict resolution for v1.'),
     now() - interval '2 days'),
    (sess3_id, ws_id, 'engineering', 1,
     jsonb_build_object('manual', true, 'notes', 'Implemented useRealtimeIssues hook; connection indicator added to shell header.'),
     now() - interval '5 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, phase, completed_at, completed_by_member_id)
  VALUES
    (sess3_id, ws_id, 'product', now() - interval '2 days 12 hours', mem2_id),
    (sess3_id, ws_id, 'design',  now() - interval '1 day',           mem2_id);

  -- Session 4: review / agent_generating — code written, reviewing PR
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     slack_channel_id, slack_thread_ts,
     phase, phase_status, current_artifact_version,
     issue_id, created_at, updated_at)
  VALUES
    (sess4_id, ws_id, 4,
     'Rich-text editor for issue descriptions',
     E'@wallie the plain textarea is rough. Let''s replace it with Tiptap and support image paste.',
     mem1_id, 'C0ACME001', '1712822400.000400',
     'review', 'agent_generating', 0,
     iss4_id, now() - interval '6 days', now() - interval '4 hours');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, phase, version, artifact_json, created_at)
  VALUES
    (sess4_id, ws_id, 'product', 1,
     product_spec_template
       || jsonb_build_object(
         'title', 'Rich-text editor for issue descriptions',
         'problem_statement', 'The plain textarea does not support formatting, code blocks, or image paste, which is a hard blocker for teams documenting bugs.',
         'user_story', 'As an issue author, I want a rich-text editor with code blocks and image paste so that I can communicate context clearly.',
         'acceptance_criteria', jsonb_build_array(
           'Bold, italic, strikethrough, code formatting via Cmd+B/I/shift+X/E.',
           'Code blocks with syntax highlighting.',
           'Image paste uploads to Supabase Storage.'
         )
       ),
     now() - interval '5 days 20 hours'),
    (sess4_id, ws_id, 'design', 1,
     jsonb_build_object('manual', true, 'notes', 'Tiptap chosen over CodeMirror for block-level editing; image uploads reuse workspace-avatars bucket.'),
     now() - interval '5 days'),
    (sess4_id, ws_id, 'engineering', 1,
     jsonb_build_object('manual', true, 'notes', 'MarkdownEditor component wired up; basic formatting, code blocks, and image paste implemented.'),
     now() - interval '1 day');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, phase, completed_at, completed_by_member_id)
  VALUES
    (sess4_id, ws_id, 'product',     now() - interval '5 days 12 hours', mem1_id),
    (sess4_id, ws_id, 'design',      now() - interval '4 days',          mem1_id),
    (sess4_id, ws_id, 'engineering', now() - interval '20 hours',        mem1_id);

  -- Session 5: land / awaiting_review — approved, ready to merge
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     slack_channel_id, slack_thread_ts,
     phase, phase_status, current_artifact_version,
     issue_id, created_at, updated_at)
  VALUES
    (sess5_id, ws_id, 5,
     'Keyboard shortcuts for issue triage',
     E'@wallie power users are asking for j/k navigation and hotkeys for status/priority.',
     mem2_id, 'C0ACME001', '1712822400.000500',
     'land', 'awaiting_review', 1,
     iss5_id, now() - interval '8 days', now() - interval '3 hours');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, phase, version, artifact_json, created_at)
  VALUES
    (sess5_id, ws_id, 'product', 1,
     product_spec_template
       || jsonb_build_object(
         'title', 'Keyboard shortcuts for issue triage',
         'problem_statement', 'Triaging large backlogs is mouse-heavy and slow for power users.',
         'user_story', 'As a power user, I want j/k navigation and hotkeys for common actions so that I can triage issues without leaving the keyboard.',
         'acceptance_criteria', jsonb_build_array(
           'j/k moves the focused issue up/down.',
           's/p/a open status/priority/assignee menus.',
           'Shortcuts are documented in a ? overlay.'
         )
       ),
     now() - interval '7 days'),
    (sess5_id, ws_id, 'design', 1,
     jsonb_build_object('manual', true, 'notes', 'Use tinykeys for global shortcut provider; show ? overlay with all bindings.'),
     now() - interval '6 days'),
    (sess5_id, ws_id, 'engineering', 1,
     jsonb_build_object('manual', true, 'notes', 'All shortcuts wired; overlay uses same Dialog primitive as command palette.'),
     now() - interval '3 days'),
    (sess5_id, ws_id, 'review', 1,
     jsonb_build_object('manual', true, 'notes', 'PR #12 reviewed; two small nits fixed (focus-ring contrast, Escape closes menus).'),
     now() - interval '3 hours'),
    (sess5_id, ws_id, 'land', 1,
     jsonb_build_object('manual', true, 'notes', 'Awaiting land approval — PR is green and ready to merge.'),
     now() - interval '2 hours');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, phase, completed_at, completed_by_member_id)
  VALUES
    (sess5_id, ws_id, 'product',     now() - interval '6 days 20 hours', mem2_id),
    (sess5_id, ws_id, 'design',      now() - interval '5 days',          mem2_id),
    (sess5_id, ws_id, 'engineering', now() - interval '4 hours',         mem2_id),
    (sess5_id, ws_id, 'review',      now() - interval '3 hours',         mem1_id);

  -- Session 6: monitor / approved, archived — shipped & watching metrics
  INSERT INTO public.sessions
    (id, workspace_id, number, title, prompt_md, creator_member_id,
     slack_channel_id, slack_thread_ts,
     phase, phase_status, current_artifact_version,
     archived_at, issue_id, created_at, updated_at)
  VALUES
    (sess6_id, ws_id, 6,
     'CI/CD pipeline with GitHub Actions',
     E'@wallie we need CI — tests + lint on PRs, staging deploy on merge, production gated.',
     mem1_id, 'C0ACME001', '1712822400.000600',
     'monitor', 'approved', 1,
     now() - interval '10 days',
     iss6_id, now() - interval '13 days', now() - interval '10 days');

  INSERT INTO public.session_artifacts
    (session_id, workspace_id, phase, version, artifact_json, created_at)
  VALUES
    (sess6_id, ws_id, 'product', 1,
     product_spec_template
       || jsonb_build_object(
         'title', 'CI/CD pipeline with GitHub Actions',
         'problem_statement', 'Tests and linters are only run locally, so broken commits land on main and bottleneck the deploy story.',
         'user_story', 'As a developer, I want CI to catch broken commits and auto-deploy green merges to staging so that we can ship without manual toil.',
         'acceptance_criteria', jsonb_build_array(
           'PR checks run tests and lint.',
           'Merge to main deploys to staging automatically.',
           'Production deploy requires manual approval.'
         )
       ),
     now() - interval '12 days 20 hours'),
    (sess6_id, ws_id, 'design', 1,
     jsonb_build_object('manual', true, 'notes', 'Use GitHub Actions with environment protection rules for production approvals.'),
     now() - interval '12 days'),
    (sess6_id, ws_id, 'engineering', 1,
     jsonb_build_object('manual', true, 'notes', '.github/workflows/ci.yml contains test, lint, and deploy jobs.'),
     now() - interval '11 days 12 hours'),
    (sess6_id, ws_id, 'review', 1,
     jsonb_build_object('manual', true, 'notes', 'PR #1 reviewed and approved.'),
     now() - interval '11 days'),
    (sess6_id, ws_id, 'land', 1,
     jsonb_build_object('manual', true, 'notes', 'Merged to main; staging deployed automatically.'),
     now() - interval '10 days 12 hours'),
    (sess6_id, ws_id, 'monitor', 1,
     jsonb_build_object('manual', true, 'notes', 'Pipeline has been green for a week; closing out.'),
     now() - interval '10 days');

  INSERT INTO public.session_phase_completions
    (session_id, workspace_id, phase, completed_at, completed_by_member_id)
  VALUES
    (sess6_id, ws_id, 'product',     now() - interval '12 days 12 hours', mem1_id),
    (sess6_id, ws_id, 'design',      now() - interval '11 days 18 hours', mem1_id),
    (sess6_id, ws_id, 'engineering', now() - interval '11 days 6 hours',  mem1_id),
    (sess6_id, ws_id, 'review',      now() - interval '10 days 18 hours', mem1_id),
    (sess6_id, ws_id, 'land',        now() - interval '10 days 12 hours', mem1_id),
    (sess6_id, ws_id, 'monitor',     now() - interval '10 days',          mem1_id);

  -- -------------------------------------------------------------------------
  -- 11. Agent jobs + runs (pipeline work on session #4's rich-text editor)
  -- -------------------------------------------------------------------------

  -- Job 1: successful run on session #4's anchor issue
  INSERT INTO public.agent_jobs
    (id, workspace_id, issue_id, requested_by_member_id, trigger_type, job_type,
     status, attempt_count, started_at, finished_at, created_at)
  VALUES
    (job1_id, ws_id, iss4_id, mem1_id, 'slack_mention', 'pipeline',
     'success', 1, now() - interval '6 days', now() - interval '5 days 23 hours',
     now() - interval '6 days');

  INSERT INTO public.agent_runs
    (id, workspace_id, issue_id, agent_job_id, triggered_by_member_id,
     run_type, model_provider, model_name, status,
     started_at, finished_at, created_at)
  VALUES
    (run1_id, ws_id, iss4_id, job1_id, mem1_id,
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
    (id, workspace_id, issue_id, requested_by_member_id, trigger_type, job_type,
     status, attempt_count, started_at, created_at)
  VALUES
    (job2_id, ws_id, iss2_id, mem1_id, 'slack_mention', 'pipeline',
     'running', 1, now() - interval '30 minutes',
     now() - interval '30 minutes');

  INSERT INTO public.agent_runs
    (id, workspace_id, issue_id, agent_job_id, triggered_by_member_id,
     run_type, model_provider, model_name, status,
     started_at, created_at)
  VALUES
    (run2_id, ws_id, iss2_id, job2_id, mem1_id,
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
