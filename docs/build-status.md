# Build Status

## Current State

- Project: `wallie.cc` rebuild
- Implementation repo: `/Users/anant/src/wallie-cc`
- Reference repo: `/Users/anant/src/wallie`
- Status: Gate F control plane verified
- Baseline verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passing on March 30, 2026
- Schema verification: `supabase db start`, `supabase db reset --local --yes`, `supabase db lint --local --fail-on error`, and `supabase gen types typescript --local --schema public` all passing on March 30, 2026
- Gate C verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passing on March 30, 2026 after auth, onboarding, and workspace route gating landed
- Gate D verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passing on March 30, 2026 after issue list, detail editing, comments, and issue links landed
- Gate E verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passing on March 30, 2026 after GitHub install/sync routes, issue repo linkage + PR display, Stripe portal/webhooks, encrypted secrets CRUD, and workspace avatar uploads landed
- Gate F verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passing on March 31, 2026 after Wallie enqueue/retry routes, the resumable processor entrypoint, persisted run messages, and the issue-detail Wallie timeline landed
- UI verification: `pnpm lint`, `pnpm typecheck`, and `pnpm build` all passing on April 1, 2026 after the shared visual system, workspace shell, auth entry, issue list/detail, settings, and Wallie panel shifted to a denser Linear-inspired interface language
- Web guideline verification: `pnpm lint`, `pnpm typecheck`, and `pnpm build` all passing on April 1, 2026 after a page-by-page audit against the Vercel Web Interface Guidelines added skip navigation, page-level headings, focus-visible treatments, labeled form controls, live-region feedback, locale-safe date formatting, and URL-backed issue-list UI state
- Tooling verification: `pnpm format:check` and `pnpm lint` passing on April 4, 2026 after Prettier setup, ESLint/Prettier compatibility, and a GitHub Actions style workflow landed

## Active Agents

- Platform (Codex): repo bootstrap, shared shell scaffold, schema/RLS baseline, Supabase app plumbing

## Branches

- `main`: active default branch

## Stage Gates

- Gate A, Bootstrap Complete: complete
- Gate B, Schema Freeze v1: complete
- Gate C, Auth + Workspace Entry: complete
- Gate D, Core Issue Workflow: complete
- Gate E, Integrations: complete
- Gate F, Wallie Control Plane: complete
- Gate G, Production Candidate: pending

## Decisions

- New repo name is `wallie-cc`.
- Old repo is reference-only.
- Use `docs/reference/cloud-rebuild-handoff.md` as the product/spec contract.
- Use `docs/reference/cloud-rebuild-execution-graph.md` as the execution runbook.
- Bootstrap baseline uses Next.js App Router, TypeScript, Tailwind CSS 4, ESLint, and Vitest.
- Added initial Supabase project scaffolding under `supabase/` with the first schema + RLS migration.
- Shared shell scaffolding is workspace-prefixed and centered on `/w/[workspaceSlug]/*`.
- Initial placeholder routes exist for `/`, `/login`, `/signup`, `/onboarding/workspace`, `/w/[workspaceSlug]/issues`, `/w/[workspaceSlug]/issues/[issueNumber]`, and `/w/[workspaceSlug]/settings`.
- Environment schema currently requires app URL, Supabase URL, Supabase publishable key, Supabase secret key, and a Wallie encryption key; `WALLIE_PROCESS_TOKEN`, GitHub, and Stripe envs are optional placeholders.
- Blank optional GitHub, Stripe, and `WALLIE_PROCESS_TOKEN` process env values now normalize to "missing" instead of failing validation, matching the scaffolded empty placeholders in `.env.example` and local `.env.local`.
- No ElectricSQL, PGlite, proxy/write servers, offline cache, or client-exposed storage credentials were introduced in bootstrap.
- Schema v1 uses `auth.uid()` plus `workspace_members` for tenancy and RLS; it does not reuse the old email-claim workspace lookup model.
- An internal `workspace_issue_counters` table backs the `next_issue_number(workspace_id uuid)` RPC so issue numbers are allocated atomically across separate client transactions.
- Client-writable SQL surface is limited to `issues`, `issue_comments`, `issue_links`, `profiles`, and `workspace_members.preferences`; `workspace_secrets` and `agent_jobs` remain service-only.
- Generated public DB types now live in `src/lib/supabase/database.types.ts` and should be refreshed from local Supabase whenever schema migrations change.
- Gate C auth entrypoints now live at `/login`, `/signup`, `/auth/oauth`, `/auth/email`, `/auth/callback`, `/auth/confirm`, and `/auth/signout`.
- Gate C email confirmation accepts both Supabase email-link callback shapes on `/auth/confirm`: PKCE `code` exchanges from `@supabase/ssr` server-client flows and explicit `token_hash` + `type` OTP verification payloads.
- Workspace bootstrap now lands through `POST /api/workspaces`, which delegates transactional owner membership and system `wallie` member creation to the `public.create_workspace(workspace_name text, requested_slug text default null)` RPC.
- Workspace shell routes under `/w/[workspaceSlug]/*` now require a Supabase session plus RLS-backed workspace membership before the shell renders.
- Supabase session refresh now runs through `middleware.ts` plus `src/lib/supabase/middleware.ts` so auth cookies stay current for server-rendered routes.
- `src/lib/supabase/server.ts` now treats cookie writes as best-effort in Server Components: route handlers and server actions can still persist refreshed Supabase cookies, but server-rendered loaders must rely on middleware for session refresh because `cookies()` is read-only there.
- Invalid Supabase refresh/session cookies now normalize to signed-out state through `src/lib/supabase/auth.ts`, and middleware clears stale `sb-*-auth-token*` cookies when refresh validation fails so bad sessions do not keep looping through `auth.getUser()`.
- Gate D list and detail entrypoints now live on real server loaders at `/w/[workspaceSlug]/issues` and `/w/[workspaceSlug]/issues/[issueNumber]`, with client-side CRUD shells layered on top of the initial server render.
- Gate D issue list query params are now `query`, `status`, `priority`, `estimate`, `sort`, and `direction`; the parser still accepts legacy `orderBy` and `orderDirection` aliases from the old app.
- Gate D stores list sort preference in `workspace_members.preferences.issues.sort` and `.direction`, with the URL remaining the shareable source of truth when explicit query params are present.
- Gate D models `blocked_by` rows directionally: `source_issue_id = current issue, target_issue_id = other issue` renders as "Blocked by", and the inverse row renders as "Blocks".
- Gate D models `sub_issue` rows directionally: `source_issue_id` is the child issue and `target_issue_id` is the parent issue; outgoing rows from the current issue surface parent links and incoming rows surface sub-issues.
- Gate D preserves PR and Wallie timeline sections on the detail route as placeholder shells so later gates can fill them without changing the route contract.
- Gate E keeps a single `/w/[workspaceSlug]/settings` page for now; GitHub and billing sections render on that page, and nested `/settings/github` plus `/settings/billing` routes stay deferred until the settings surface needs deeper drill-down flows.
- Gate E surfaces missing GitHub and Stripe configuration inline on the settings page and from route handlers as typed `missing_config` responses with the exact env var names that are absent; the UI treats those as actionable setup states instead of generic failures.
- Gate E scope for PR visibility is repository assignment on the issue detail route plus persisted branch / PR metadata (`branch_name`, PR number, URL, state, draft flag, timestamps); richer PR review activity stays for later gates.
- Gate E upload scope is limited to workspace avatar uploads through `POST /api/workspaces/[workspaceId]/avatar`; editor image uploads stay out of scope until the editor surface needs them.
- Gate E treats the existing billing schema as the stable contract: Stripe webhooks map subscription state into `workspaces.tier`, `workspaces.stripe_customer_id`, `workspaces.current_billing_cycle_start_at`, and `workspaces.successful_agent_runs_this_cycle` rather than introducing a second billing-status column family mid-rebuild.
- Gate E persists repository language metadata from GitHub sync as `github_repositories.default_programming_language` and displays it in settings; manual overrides are deferred so `github_repositories` remains server-owned in this gate.
- Gate E settings now render real workspace identity, billing, GitHub integration, and encrypted secret management data instead of placeholder panels.
- Gate E issue detail now reads workspace repositories plus `github_issue_branches`, allows direct `issues.github_repository_id` assignment under RLS, and applies narrow realtime subscriptions only for the open issue row plus that issue’s PR rows.
- Gate E avatar uploads use a public Supabase Storage bucket named `workspace-avatars`, but uploads still remain server-mediated so the browser never receives storage credentials.
- Gate F infers Wallie run mode from the current issue repository link: issues without `github_repository_id` run in `project` mode, linked issues run in `code` mode, and retries preserve the prior run’s explicit `run_type`.
- Gate F treats `ANTHROPIC_API_KEY` as the minimum required workspace secret contract for enqueue validation; the issue detail route only exposes missing-key names, never secret values or previews.
- Gate F enqueues a fresh `agent_jobs` + `agent_runs` pair for every new run or retry attempt, while the `agent_jobs` active dedupe key prevents more than one queued/running Wallie job per issue at a time.
- Gate F retries are immutable: `POST /api/agent-runs/[runId]/retry` creates a new queued job/run pair instead of mutating the historical run being retried.
- Gate F schedules immediate background processing with Next.js `after()` from the enqueue/retry routes and also exposes `POST /api/agent-jobs/process` as a resumable one-job processor entrypoint for cron/manual recovery.
- Gate F’s processor is resumable at the job level: a targeted `jobId` can resume a `queued` or already-`running` job idempotently, while success finalization only increments `workspaces.successful_agent_runs_this_cycle` on the first transition to `agent_runs.status = 'success'`.
- Gate F uses a deterministic stub executor for now: project-mode runs overwrite `issues.design_md` + `issues.plan_md`, and code-mode runs ensure a stable `github_issue_branches` row exists with placeholder branch metadata instead of attempting real GitHub mutations.
- Gate F lazily rolls the free-tier Wallie cycle forward when the stored `current_billing_cycle_start_at` is more than one month old, so free workspaces do not require a separate cron just to recover quota.
- Gate F issue detail realtime expands to the current issue’s `agent_runs` plus per-run `agent_run_messages` subscriptions, keeping run/message updates narrow instead of subscribing to workspace-wide tables.
- Local `.env.local` now targets the Supabase CLI stack (`http://127.0.0.1:54321` plus the local publishable/secret keys from `supabase status -o env`); Vercel environments should keep the hosted Supabase project values, with `NEXT_PUBLIC_APP_URL` set per environment to the deployed origin.
- The workspace-facing UI now uses a Linear-inspired visual contract: Inter-based typography, neutral layered surfaces, compact radii, low-contrast borders, dense controls, and minimal marketing copy in authenticated routes. This is a presentation-only change; route, schema, and API contracts remain unchanged.
- The April 1, 2026 issue-list screenshot pass matches a specific Linear reference more closely in the workspace shell and `/w/[workspaceSlug]/issues` layout, while still rendering Wallie’s existing issue fields instead of introducing Linear-only label/cycle schema.
- Routed pages now follow a shared accessibility contract: each rendered page surface exposes a page-level heading, the app exposes a root skip link to `#main-content`, and interactive controls use focus-visible treatments rather than focus-only styling.
- The issue list now deep-links two page-level UI states through query params: `controls=1` opens the filter/search tray and `create=1` opens the create-issue dialog, which also makes the sidebar search/create affordances land on the exact UI state they advertise.
- The workspace shell now exposes only shipped navigation surfaces in the left rail: the top-left workspace dropdown links to `/w/[workspaceSlug]/settings`, and the persistent team nav keeps only Issues until additional workspace routes are implemented.
- Repository formatting now runs through Prettier with `printWidth = 100` and `proseWrap = preserve`; reference docs, generated DB types, local tool metadata, and the lockfile stay outside the formatter surface to avoid noisy churn.
- GitHub Actions now runs `pnpm format:check` and `pnpm lint` on pushes to `main` and pull requests targeting `main`.

## Planned Gate E Routes And Interfaces

- `GET /api/github/install?workspaceId=<uuid>` returns a signed GitHub App install URL for a workspace manager.
- `GET /api/github/callback` verifies signed install state, upserts the workspace installation row, syncs repositories, and redirects back to the workspace settings route with a status query param.
- `POST /api/github/refresh-repositories` accepts `{ workspaceId }` and resyncs the current installation repositories through the server-owned GitHub App integration.
- `POST /api/github/webhooks` verifies the GitHub signature, handles installation / installation_repositories / pull_request events, updates `github_installations`, `github_repositories`, `github_issue_branches`, and applies issue status transitions idempotently from persisted branch rows.
- `POST /api/stripe/portal` accepts `{ workspaceId }`, ensures a Stripe customer exists for the workspace, and returns a customer portal URL.
- `POST /api/stripe/webhooks` verifies the Stripe signature and maps subscription lifecycle events onto workspace billing fields.
- `GET /api/secrets?workspaceId=<uuid>` returns preview-only workspace secrets after membership + management checks.
- `POST /api/secrets` accepts `{ workspaceId, key, value }`, encrypts the value with `WALLIE_ENCRYPTION_KEY`, stores only the preview in client responses, and records `created_by_member_id` from `workspace_members.id`.
- `DELETE /api/secrets/[key]?workspaceId=<uuid>` deletes a workspace secret through a manager-only route handler.
- `POST /api/workspaces/[workspaceId]/avatar` accepts multipart form data, uploads a workspace avatar through Supabase Storage, replaces the stored `avatar_path`, and never exposes storage credentials to the browser.

## Gate E Landed Routes

- `/api/github/install`
- `/api/github/callback`
- `/api/github/refresh-repositories`
- `/api/github/webhooks`
- `/api/stripe/portal`
- `/api/stripe/webhooks`
- `/api/secrets`
- `/api/secrets/[key]`
- `/api/workspaces/[workspaceId]/avatar`

## Gate F Routes

- `POST /api/agent-runs` accepts `{ issueId, workspaceId }`, validates membership + prerequisites, creates a queued job/run pair when allowed, and schedules background processing with Next.js `after()`.
- `POST /api/agent-runs/[runId]/retry` accepts `{ workspaceId }`, validates that the referenced run is terminal, and enqueues a fresh retry run/job pair with `trigger_type = 'manual_retry'`.
- `POST /api/agent-jobs/process` accepts an optional `{ jobId, workspaceId }` scope, processes at most one queued/running Wallie job per invocation, and supports either a manager-scoped request or an optional bearer `WALLIE_PROCESS_TOKEN`.

## Pipeline Dashboard — Phase 1 Routes (v0.2.0)

- `POST /api/slack/events` handles Slack Events API webhooks. Verifies `x-slack-signature` + 5-minute timestamp window BEFORE any other work (including `url_verification` challenge). On `app_mention` with a Linear issue URL, creates a `pipeline_issues` row + anchor `issues` row + queued `agent_jobs` row (`job_type=pipeline`, `trigger_type=slack_mention`) and dispatches background processing via `after()`. 23505 dedupe on `(workspace_id, linear_issue_id)` is silent; on failure the orphan anchor row is deleted.
- `POST /api/slack/interactions` handles Slack Interactivity webhooks (Approve / Submit Feedback button clicks, feedback modal submit). Resolves the signed `team.id` to a workspace before any CAS so cross-workspace button replay is blocked at the DB level. `block_actions` are acked synchronously (<3s) and mutation work is deferred via `after()`.
- Pipeline state machine (`src/lib/pipeline/state-machine.ts`): `product → design → engineering → shipped` with per-phase statuses `agent_generating → awaiting_review → approved|rejected|escalated`. Escalation threshold: 3 rejections on a single phase triggers an EM DM.
- Processor (`src/lib/pipeline/processor.ts`) runs pre-screen → product agent → artifact persist → Slack post. Spec-save is guarded by a compensating artifact-delete if the version-pointer bump fails, so a mid-flight failure does not wedge the next retry on the unique `(pipeline_issue_id, phase, version)` constraint.
- LLM trust boundary (`src/lib/pipeline/prompt-safety.ts`) wraps all untrusted content (Linear title/description, previous spec, reviewer feedback) in XML tags, truncates to 8KB, and neutralizes attacker-planted close tags so a hostile Linear ticket cannot escape the data section of the prompt.
- `agent_jobs.job_type` column discriminates wallie vs pipeline jobs. `loadProcessTargetJob` in `src/lib/wallie/service.ts` refuses to redispatch a `job_type=pipeline` job that is already `running`.
- Realtime publication now includes `pipeline_issues`. `slack_installations` holds the encrypted bot token and is fully revoked from anon/authenticated (service-role only, matching `workspace_secrets`).

### Pipeline Dashboard — v0.2.1 hardening

- LLM prompt trust-boundary sanitization extracted to `src/lib/pipeline/prompt-safety.ts` and covered by `prompt-safety.test.ts`. Truncates untrusted content to 8KB and neutralizes attacker-planted close tags for `<linear_issue_title>`, `<linear_issue_description>`, `<previous_spec>`, `<reviewer_feedback>`. Used by both `pre-screen.ts` and `product-agent.ts`.
- Slack Web API helpers (`postSlackMessage`, `updateSlackMessage`, `openSlackDm`, `openSlackView` in `slack-format.ts`) now throw on `ok: false`. Previously callers silently advanced pipeline state even when `invalid_auth` / `channel_not_found` returned HTTP 200 with `ok: false`. Callers in `processor.ts` and `api/slack/interactions/route.ts` now handle the failure explicitly.
- New unit test coverage: `processor.test.ts` (15 cases — CAS races, cross-workspace guard, escalation, enqueue-before-flip ordering, compensating delete), `pre-screen.test.ts`, `product-agent.test.ts`, `prompt-safety.test.ts`. Total 151 tests.
- `CREATE INDEX CONCURRENTLY` split into its own migration `20260408210000_pipeline_dashboard_concurrent_index.sql` because `CONCURRENTLY` cannot run inside a transaction block.

## Blockers

- None yet

## Deviations From Handoff

- Root redirect currently selects the most recently updated accessible workspace when a user has multiple workspaces; the handoff’s explicit "last active workspace" preference will need a later server-backed preference contract.
- Gate D uses textarea-backed markdown fields for description, plan, and design instead of a richer editor so the data contract can land before the editor stack is introduced.
- Gate D list search/filter/sort currently run against the workspace issue set inside the typed server loader instead of pushing every combination into the DB query surface; revisit if workspace issue volume grows materially.
- Gate D does not enable issue realtime yet; list bulk mutations refresh through the route loader, while detail edits patch the currently open issue/comments/links locally after successful writes.
- Gate E will add narrow issue-detail realtime only for the current `issues` row and current issue `github_issue_branches` rows so webhook-driven PR/status updates can land live without subscribing to whole tables.
- Gate E does not implement GitHub installation removal or manual repository language overrides yet; settings exposes install, manage-on-GitHub, and refresh flows only.
- Gate E limits uploads to workspace avatars and does not add editor-image flows yet, even though the broader handoff mentions future editor-uploaded images.
- The Linear screenshot restyle intentionally keeps the existing issue list data contract; row pills reuse current Wallie fields such as priority, status, estimate, and assignee instead of adding a new team/label/cycle model just for UI parity.
- The settings route now centers its content inside a padded max-width canvas and uses one borderless elevated surface per top-level section; bordered subpanels remain for alerts, grouped controls, and preview rows.

## Notes

- Route helpers live in `src/lib/routes.ts` and should remain the shared source for workspace-prefixed navigation until a stronger contract is needed.
- The shared app shell in `src/components/app-shell` is intentionally data-agnostic so schema, auth, and feature agents can replace placeholder panels without reworking navigation chrome.
- Env validation is present but lazy; future integration agents should call the relevant parser at the server or client boundary they own.
- Supabase admin helpers now validate only the Supabase admin env contract (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`) so server-rendered issue/detail loads do not depend on unrelated GitHub, Stripe, or Wallie processor env setup.
- `src/env/client.ts` now resolves `NEXT_PUBLIC_*` values through direct property reads when no explicit env object is passed so Next.js can inline them into client bundles; browser Supabase helpers validate only the publishable key and Supabase URL, while `NEXT_PUBLIC_APP_URL` remains required for server-side redirect/callback flows.
- The app now requires `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` as the Supabase env contract.
- Wallie provider credentials such as `ANTHROPIC_API_KEY` remain workspace secrets stored in the database and are not part of the process env contract.
- Realtime publication is intentionally narrow in schema v1: issues, comments, links, GitHub issue branches, agent runs, and agent run messages.
- App-side Supabase helpers now live in `src/lib/supabase/*`; future agents should import those helpers instead of creating raw clients ad hoc.
- On this machine, local Supabase CLI startup hangs in `docker-credential-desktop get` unless commands are run with `DOCKER_CONFIG=/tmp/wallie-cc-docker` and `DOCKER_HOST=unix:///Users/anant/.docker/run/docker.sock`.
- Feature agents should update this file when they introduce routes, schema assumptions, or shared interfaces.
- Authenticated entry pages now upsert `profiles` from Supabase user metadata before redirecting into onboarding or workspace routes.
- The workspace layout returns `notFound()` for inaccessible workspace slugs once the signed-in user already has at least one accessible workspace; users with no accessible workspaces are redirected to `/onboarding/workspace`.
- Gate D surfaces only one parent issue as an editable target in the UI even though the current schema permits multiple `sub_issue` parent rows for a single child; if older or manual data creates multiple parents, the detail page shows them and requires manual cleanup.
