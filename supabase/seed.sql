-- =============================================================================
-- Seed data for local development
-- Runs automatically on `supabase db reset`
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

  -- Issues
  iss1_id   uuid := 'd1b2c3d4-0001-4000-8000-000000000001';
  iss2_id   uuid := 'd1b2c3d4-0002-4000-8000-000000000002';
  iss3_id   uuid := 'd1b2c3d4-0003-4000-8000-000000000003';
  iss4_id   uuid := 'd1b2c3d4-0004-4000-8000-000000000004';
  iss5_id   uuid := 'd1b2c3d4-0005-4000-8000-000000000005';
  iss6_id   uuid := 'd1b2c3d4-0006-4000-8000-000000000006';
  iss7_id   uuid := 'd1b2c3d4-0007-4000-8000-000000000007';
  iss8_id   uuid := 'd1b2c3d4-0008-4000-8000-000000000008';
  iss9_id   uuid := 'd1b2c3d4-0009-4000-8000-000000000009';
  iss10_id  uuid := 'd1b2c3d4-0010-4000-8000-000000000010';

  -- Comments
  com1_id   uuid := 'e1b2c3d4-0001-4000-8000-000000000001';
  com2_id   uuid := 'e1b2c3d4-0002-4000-8000-000000000002';
  com3_id   uuid := 'e1b2c3d4-0003-4000-8000-000000000003';
  com4_id   uuid := 'e1b2c3d4-0004-4000-8000-000000000004';
  com5_id   uuid := 'e1b2c3d4-0005-4000-8000-000000000005';
  com6_id   uuid := 'e1b2c3d4-0006-4000-8000-000000000006';
  com7_id   uuid := 'e1b2c3d4-0007-4000-8000-000000000007';
  com8_id   uuid := 'e1b2c3d4-0008-4000-8000-000000000008';
  com9_id   uuid := 'e1b2c3d4-0009-4000-8000-000000000009';
  com10_id  uuid := 'e1b2c3d4-0010-4000-8000-000000000010';
  com11_id  uuid := 'e1b2c3d4-0011-4000-8000-000000000011';
  com12_id  uuid := 'e1b2c3d4-0012-4000-8000-000000000012';

  -- Issue links
  link1_id  uuid := 'f1b2c3d4-0001-4000-8000-000000000001';
  link2_id  uuid := 'f1b2c3d4-0002-4000-8000-000000000002';
  link3_id  uuid := 'f1b2c3d4-0003-4000-8000-000000000003';
  link4_id  uuid := 'f1b2c3d4-0004-4000-8000-000000000004';

  -- GitHub integration
  gh_inst_id  uuid := '11b2c3d4-0001-4000-8000-000000000001';
  gh_repo1_id uuid := '12b2c3d4-0001-4000-8000-000000000001';
  gh_repo2_id uuid := '12b2c3d4-0002-4000-8000-000000000002';
  gh_br1_id   uuid := '13b2c3d4-0001-4000-8000-000000000001';
  gh_br2_id   uuid := '13b2c3d4-0002-4000-8000-000000000002';
  gh_br3_id   uuid := '13b2c3d4-0003-4000-8000-000000000003';

  -- Agent jobs & runs
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
  INSERT INTO public.workspaces (id, slug, name, tier, created_by, created_at)
  VALUES (ws_id, 'acme-corp', 'Acme Corp', 'pro', user1_id, now() - interval '14 days');

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
  -- 5. Issue counter
  -- -------------------------------------------------------------------------
  INSERT INTO internal.workspace_issue_counters (workspace_id, last_issue_number)
  VALUES (ws_id, 10);

  -- -------------------------------------------------------------------------
  -- 6. Issues (10 realistic software-project issues)
  -- -------------------------------------------------------------------------
  INSERT INTO public.issues
    (id, workspace_id, number, title, description_md, plan_md, design_md,
     status, priority, estimate_points, creator_member_id, assignee_member_id,
     created_at, updated_at)
  VALUES
    -- #1 — Done
    (iss1_id, ws_id, 1,
     'Set up CI/CD pipeline with GitHub Actions',
     E'We need automated tests, linting, and deploy-on-merge for the `main` branch.\n\n### Acceptance criteria\n- PR checks run tests + lint\n- Merge to main triggers deploy to staging\n- Deploy to production is manual approval',
     E'## Plan\n1. Create `.github/workflows/ci.yml`\n2. Add test + lint jobs\n3. Add staging deploy job triggered on main push\n4. Add production deploy job with environment protection rules',
     null,
     'done', 'high', 5, mem1_id, mem2_id,
     now() - interval '13 days', now() - interval '8 days'),

    -- #2 — Done
    (iss2_id, ws_id, 2,
     'Implement workspace creation onboarding flow',
     E'New users need a guided flow to create their first workspace after signing up.\n\n- Name input with slug preview\n- Auto-redirect to the new workspace after creation\n- Confetti animation on success (stretch goal)',
     null, null,
     'done', 'high', 8, mem1_id, mem1_id,
     now() - interval '12 days', now() - interval '7 days'),

    -- #3 — In Review
    (iss3_id, ws_id, 3,
     'Add real-time issue status updates via Supabase Realtime',
     E'When a teammate changes an issue''s status, everyone viewing the board should see it update instantly without refreshing.\n\n### Technical notes\n- Subscribe to `issues` table changes filtered by `workspace_id`\n- Optimistic UI update on the client side\n- Handle reconnection gracefully',
     E'## Plan\n1. Create `useRealtimeIssues` hook\n2. Subscribe to postgres changes on `issues` table\n3. Merge remote changes into local React Query cache\n4. Add connection status indicator',
     E'## Design\n- Use `supabase.channel()` API\n- Filter: `workspace_id=eq.{id}`\n- Events: INSERT, UPDATE, DELETE\n- Reconnect with exponential backoff',
     'in_review', 'medium', 5, mem2_id, mem2_id,
     now() - interval '10 days', now() - interval '1 day'),

    -- #4 — In Progress (assigned to Wallie)
    (iss4_id, ws_id, 4,
     'Implement markdown editor for issue descriptions',
     E'Replace the plain textarea with a proper markdown editor that supports:\n\n- Live preview (split pane or toggle)\n- Syntax highlighting for code blocks\n- Image paste/upload\n- Keyboard shortcuts (Cmd+B for bold, etc.)\n\nConsider using CodeMirror 6 or Tiptap.',
     E'## Plan\n1. Evaluate CodeMirror 6 vs Tiptap — go with Tiptap for richer block editing\n2. Create `<MarkdownEditor>` component\n3. Wire up image upload to Supabase Storage\n4. Add toolbar with formatting buttons\n5. Write tests for serialization round-trip',
     null,
     'in_progress', 'high', 8, mem1_id, memw_id,
     now() - interval '8 days', now() - interval '4 hours'),

    -- #5 — In Progress
    (iss5_id, ws_id, 5,
     'Build workspace settings page',
     E'Settings page needs sections for:\n\n1. **General** — name, slug, avatar\n2. **Members** — invite, remove, change roles\n3. **Billing** — current plan, usage, upgrade CTA\n4. **Danger zone** — delete workspace\n\nEach section should be a tab or accordion.',
     null, null,
     'in_progress', 'medium', 5, mem1_id, mem1_id,
     now() - interval '6 days', now() - interval '2 days'),

    -- #6 — Todo
    (iss6_id, ws_id, 6,
     'Add keyboard shortcuts for issue triage',
     E'Power users should be able to triage issues without touching the mouse:\n\n| Key | Action |\n|-----|--------|\n| `j` / `k` | Navigate up/down |\n| `s` | Change status |\n| `p` | Change priority |\n| `a` | Assign |\n| `e` | Edit title inline |\n| `Enter` | Open issue detail |\n\nUse a global shortcut provider (something like `tinykeys`).',
     null, null,
     'todo', 'low', 3, mem2_id, null,
     now() - interval '5 days', now() - interval '5 days'),

    -- #7 — Todo
    (iss7_id, ws_id, 7,
     'Implement issue filtering and search',
     E'The issues list needs filtering capabilities:\n\n- Full-text search across title and description\n- Filter by status (multi-select)\n- Filter by priority\n- Filter by assignee\n- Combine filters with AND logic\n- Persist filter state in URL query params',
     null, null,
     'todo', 'medium', 5, mem1_id, mem2_id,
     now() - interval '4 days', now() - interval '4 days'),

    -- #8 — Backlog
    (iss8_id, ws_id, 8,
     'Add email notifications for issue assignments',
     E'When a user is assigned to an issue, send them an email notification.\n\n- Use Supabase Edge Functions + Resend\n- Include issue title, description preview, and deep link\n- Respect user notification preferences (to be built)\n- Rate limit to avoid spam on bulk assignment changes',
     null, null,
     'backlog', 'low', 3, mem2_id, null,
     now() - interval '3 days', now() - interval '3 days'),

    -- #9 — Backlog
    (iss9_id, ws_id, 9,
     'Dark mode support',
     E'Implement a system-aware dark mode with manual override.\n\n- Detect `prefers-color-scheme` media query\n- Toggle in user settings (system / light / dark)\n- Store preference in workspace_members.preferences JSONB\n- Ensure all components look good in both themes\n- Pay special attention to code blocks and markdown preview',
     null, null,
     'backlog', 'none', null, mem1_id, null,
     now() - interval '2 days', now() - interval '2 days'),

    -- #10 — Canceled
    (iss10_id, ws_id, 10,
     'Integrate Slack notifications',
     E'~~Send issue updates to a Slack channel.~~\n\nDecided to deprioritize this in favor of email notifications (#8) and in-app notifications. Slack integration can come later once we have a proper webhook system.',
     null, null,
     'canceled', 'none', null, mem2_id, null,
     now() - interval '11 days', now() - interval '3 days');

  -- -------------------------------------------------------------------------
  -- 7. Issue comments
  -- -------------------------------------------------------------------------
  INSERT INTO public.issue_comments
    (id, workspace_id, issue_id, author_member_id, body_md, created_at)
  VALUES
    -- Comments on #1 (CI/CD)
    (com1_id, ws_id, iss1_id, mem2_id,
     E'I''ve set up the basic workflow. Tests and lint pass on every PR now. Still need to wire up the staging deploy.',
     now() - interval '11 days'),
    (com2_id, ws_id, iss1_id, mem1_id,
     E'Nice! For the staging deploy, let''s use the `environment` protection rules so we get a confirmation step.',
     now() - interval '10 days 18 hours'),
    (com3_id, ws_id, iss1_id, mem2_id,
     E'Done — staging deploys on merge to main, production requires manual approval. Closing this out.',
     now() - interval '8 days'),

    -- Comments on #3 (Realtime)
    (com4_id, ws_id, iss3_id, mem2_id,
     E'The `useRealtimeIssues` hook is working. One thing I noticed: if two people edit the same issue simultaneously, we get a flash of stale data. Need to figure out conflict resolution.',
     now() - interval '3 days'),
    (com5_id, ws_id, iss3_id, mem1_id,
     E'For now, last-write-wins is fine. We can add optimistic locking with `updated_at` checks later. Let''s not block the PR on that.',
     now() - interval '2 days 12 hours'),

    -- Comments on #4 (Markdown editor — Wallie working on it)
    (com6_id, ws_id, iss4_id, mem1_id,
     E'@wallie Can you start on this? I''m thinking Tiptap would be the best fit since we want block-level editing, not just plain markdown.',
     now() - interval '7 days'),
    (com7_id, ws_id, iss4_id, memw_id,
     E'I''ve analyzed the options and agree that Tiptap is the better choice here. It has first-class support for collaborative editing which we might want later.\n\nI''ll start with a basic editor component and add features incrementally:\n1. Basic formatting (bold, italic, code)\n2. Code blocks with syntax highlighting\n3. Image upload integration\n4. Keyboard shortcuts',
     now() - interval '6 days 20 hours'),
    (com8_id, ws_id, iss4_id, memw_id,
     E'Progress update: basic formatting and code blocks are working. Starting on the image upload integration with Supabase Storage now.',
     now() - interval '4 hours'),

    -- Comments on #5 (Settings page)
    (com9_id, ws_id, iss5_id, mem1_id,
     E'Started on the General tab. Using the same form pattern as the onboarding flow. Avatar upload reuses the `workspace-avatars` storage bucket.',
     now() - interval '4 days'),

    -- Comments on #7 (Filtering)
    (com10_id, ws_id, iss7_id, mem2_id,
     E'I think we should use `nuqs` for URL query state management — it handles Next.js App Router search params really well.',
     now() - interval '3 days 12 hours'),
    (com11_id, ws_id, iss7_id, mem1_id,
     E'Good call. The full-text search can use the GIN index we already have on `issues`. Let''s make sure we debounce the search input.',
     now() - interval '3 days'),

    -- Comment on #10 (Canceled Slack integration)
    (com12_id, ws_id, iss10_id, mem1_id,
     E'Canceling this for now. Email notifications (#8) cover the most critical use case, and we can build a proper webhook system later that supports Slack, Discord, and other integrations.',
     now() - interval '3 days');

  -- -------------------------------------------------------------------------
  -- 8. Issue links
  -- -------------------------------------------------------------------------
  INSERT INTO public.issue_links
    (id, workspace_id, source_issue_id, target_issue_id, link_type, created_at)
  VALUES
    (link1_id, ws_id, iss4_id, iss2_id, 'blocked_by', now() - interval '8 days'),
    (link2_id, ws_id, iss6_id, iss7_id, 'sub_issue',  now() - interval '5 days'),
    (link3_id, ws_id, iss10_id, iss8_id, 'related',   now() - interval '3 days'),
    (link4_id, ws_id, iss3_id, iss5_id, 'related',    now() - interval '6 days');

  -- -------------------------------------------------------------------------
  -- 9. GitHub integration
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

  -- Link some issues to repos
  UPDATE public.issues SET github_repository_id = gh_repo1_id
  WHERE id IN (iss1_id, iss3_id, iss4_id, iss5_id, iss7_id);

  UPDATE public.issues SET github_repository_id = gh_repo2_id
  WHERE id = iss8_id;

  -- Branches & PRs
  INSERT INTO public.github_issue_branches
    (id, workspace_id, issue_id, github_repository_id, branch_name,
     pull_request_number, pull_request_url, pull_request_state, is_draft, created_at)
  VALUES
    (gh_br1_id, ws_id, iss1_id, gh_repo1_id,
     'feat/ci-cd-pipeline', 1,
     'https://github.com/acme-corp/webapp/pull/1', 'merged', false,
     now() - interval '11 days'),
    (gh_br2_id, ws_id, iss3_id, gh_repo1_id,
     'feat/realtime-issues', 5,
     'https://github.com/acme-corp/webapp/pull/5', 'open', false,
     now() - interval '5 days'),
    (gh_br3_id, ws_id, iss4_id, gh_repo1_id,
     'feat/markdown-editor', 7,
     'https://github.com/acme-corp/webapp/pull/7', 'open', true,
     now() - interval '3 days');

  -- -------------------------------------------------------------------------
  -- 10. Agent jobs & runs (Wallie working on #4)
  -- -------------------------------------------------------------------------

  -- Job 1: successful run on issue #4
  INSERT INTO public.agent_jobs
    (id, workspace_id, issue_id, requested_by_member_id, trigger_type,
     status, attempt_count, started_at, finished_at, created_at)
  VALUES
    (job1_id, ws_id, iss4_id, mem1_id, 'assignment',
     'success', 1, now() - interval '6 days 20 hours', now() - interval '6 days 19 hours',
     now() - interval '6 days 20 hours');

  INSERT INTO public.agent_runs
    (id, workspace_id, issue_id, agent_job_id, triggered_by_member_id,
     run_type, model_provider, model_name, status,
     started_at, finished_at, created_at)
  VALUES
    (run1_id, ws_id, iss4_id, job1_id, mem1_id,
     'code', 'anthropic', 'claude-sonnet-4-6', 'success',
     now() - interval '6 days 20 hours', now() - interval '6 days 19 hours',
     now() - interval '6 days 20 hours');

  INSERT INTO public.agent_run_messages
    (id, workspace_id, agent_run_id, kind, message_md, created_at)
  VALUES
    (msg1_id, ws_id, run1_id, 'user',
     E'Implement a markdown editor for issue descriptions using Tiptap. See the issue description for requirements.',
     now() - interval '6 days 20 hours'),
    (msg2_id, ws_id, run1_id, 'assistant',
     E'I''ll implement the markdown editor using Tiptap. Let me start by analyzing the codebase to understand the existing component patterns and then set up the editor.\n\n**Steps:**\n1. Install Tiptap dependencies\n2. Create the `MarkdownEditor` component\n3. Add basic formatting extensions\n4. Wire up code block syntax highlighting\n5. Write tests',
     now() - interval '6 days 19 hours 55 minutes'),
    (msg3_id, ws_id, run1_id, 'assistant',
     E'Done! I''ve created the `MarkdownEditor` component with the following features:\n- Bold, italic, strikethrough, and code formatting\n- Headings (H1-H3)\n- Bullet and ordered lists\n- Code blocks with language detection\n- Toolbar with keyboard shortcut hints\n\nThe component is at `src/components/markdown-editor.tsx`. Tests are passing.',
     now() - interval '6 days 19 hours');

  -- Job 2: currently running (image upload feature)
  INSERT INTO public.agent_jobs
    (id, workspace_id, issue_id, requested_by_member_id, trigger_type,
     status, attempt_count, started_at, created_at)
  VALUES
    (job2_id, ws_id, iss4_id, mem1_id, 'comment_retry',
     'running', 1, now() - interval '30 minutes',
     now() - interval '30 minutes');

  INSERT INTO public.agent_runs
    (id, workspace_id, issue_id, agent_job_id, triggered_by_member_id,
     run_type, model_provider, model_name, status,
     started_at, created_at)
  VALUES
    (run2_id, ws_id, iss4_id, job2_id, mem1_id,
     'code', 'anthropic', 'claude-sonnet-4-6', 'running',
     now() - interval '30 minutes',
     now() - interval '30 minutes');

  INSERT INTO public.agent_run_messages
    (id, workspace_id, agent_run_id, kind, message_md, created_at)
  VALUES
    (msg4_id, ws_id, run2_id, 'user',
     E'Add image paste and upload support to the markdown editor. Images should be uploaded to Supabase Storage.',
     now() - interval '30 minutes'),
    (msg5_id, ws_id, run2_id, 'assistant',
     E'I''m working on adding image upload support to the markdown editor. I''ll integrate it with Supabase Storage using the existing bucket configuration.\n\n**In progress:**\n- Adding paste handler for clipboard images\n- Creating upload utility that stores to `workspace-avatars` bucket\n- Adding drag-and-drop support',
     now() - interval '25 minutes');

END;
$$;

-- Re-enable triggers.
SET session_replication_role = DEFAULT;
