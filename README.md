# Wallie

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Try it free at wallie.dev](https://img.shields.io/badge/Try%20it%20free-wallie.dev-6b46ff.svg)](https://wallie.dev)

AI-powered product development automation. Wallie turns a work prompt -- optionally linked to a Linear issue -- into reviewed, staged work. It runs Codex or Claude Code in a GitHub-backed sandbox, preserves a versioned artifact for every stage, and keeps the human approval loop in the dashboard.

> **Just want to use it?** [**wallie.dev**](https://wallie.dev) is a free, fully-hosted instance — sign up and start in minutes, no setup required. It's actively maintained, so you can use it for real work.
>
> **Want to run your own?** Wallie is open source (MIT). Follow the [Self-Hosting guide](docs/SELF_HOSTING.md) to deploy your own instance, or the [Local Setup](#local-setup-end-to-end) section below to hack on it.

## How It Works

Wallie organizes work into **sessions**. Each session is pinned at create time to a **pipeline** -- an ordered, user-configurable list of **stages** owned by the workspace. Session creation, the first queued job, and its queued run are written atomically. An always-on worker drains the job queue, runs the session's current stage, and flips it to `awaiting_review` for a human to approve or reject from the in-app dashboard.

Stages are not hardcoded. A workspace can edit, add, remove, or reorder them from settings. Every new workspace is seeded with a default `plan → build → land` pipeline so the UX works out of the box, but each stage is just a row in `pipeline_stages` with a slug, position, name, description, prompt template, and approver list. Pipelines also carry workspace-editable operating rules that are prepended to every stage prompt. Nothing in the runner distinguishes one stage from another.

A single generic stage runner (`processPipelineJob()` in `src/lib/pipeline/processor.ts`, which delegates to an internal `runStage()` helper) handles every stage:

1. Render the pipeline operating rules and stage prompt template against the session context (title, prompt, prior stage artifacts, attempt number, and last reviewer feedback).
2. Spin up a sandbox cloned from the workspace's connected GitHub repo on a per-stage branch.
3. Run the workspace's configured agent (Codex or Claude Code) inside the sandbox.
4. Capture the agent's text output as a markdown artifact, version it as `(session_id, stage_slug, version)`, and best-effort push commits/open or refresh a pull request when the stage changed code.
5. Flip the session to `awaiting_review` without making pull-request plumbing a prerequisite for artifact review.

Humans approve or reject artifacts from the in-app dashboard. Approval advances to the next stage by `position` via the `approve_session_stage` RPC. Rejection records feedback against the reviewed artifact version and enqueues a new job that re-runs the same stage with `{{attempt.feedback}}` injected into the prompt.

### Pipeline Flow

```
create_session_with_first_job RPC
  -> session created (pinned to workspace's default pipeline)
  (current_stage_id = first stage, phase_status = agent_generating)
  -> first agent job + queued run created in the same transaction
  -> worker atomically claims the job, then confirms the session stage is eligible
  -> runStage() renders prompt, runs agent in sandbox,
     streams run activity, writes the markdown artifact,
     best-effort syncs a stage PR, status=awaiting_review
  -> in the dashboard, the reviewer clicks Approve or Request Changes
  -> approve  -> approve_session_stage RPC advances to next stage by position,
                 enqueues the next job
  -> reject   -> feedback recorded for the artifact version;
                 new job re-runs the same stage
  -> repeat until the terminal stage is approved -> session archived
```

## Codebase Walkthrough

A 10-minute tour of the repository, file by file.

### Top-Level Map

```
wallie-dev/
|-- src/
|   |-- app/           -> Next.js routes (pages + API)
|   |-- components/    -> Shared React UI
|   |-- env/           -> Zod-validated env schemas (client/server/deploy)
|   |-- features/      -> Domain modules (sessions, github, settings...)
|   |-- lib/           -> Core libraries (pipeline, auth, supabase...)
|   `-- worker/        -> Background daemon (polls jobs)
|-- supabase/
|   `-- migrations/    -> Baseline schema + forward migrations
|-- docs/              -> Self-hosting, telemetry, accessibility, and UI guidance
|-- e2e/               -> Playwright flows and performance benchmarks
|-- middleware.ts      -> Auth gate (Supabase session refresh)
`-- AGENTS.md          -> Repository guidelines
```

### Domain Model

```
Workspace (tenant)
  |-- Members (humans + "wallie" system agent)
  |-- Secrets (encrypted: LINEAR_API_KEY, repository env keys, ...)
  |-- Pipelines (1..N; one flagged is_default; operating_rules_md)
  |    `-- Stages (position, slug, name, description, prompt_template_md,
  |                approver_member_ids[])
  `-- Sessions <- the unit of work
       |-- pipeline_id (pinned at create time -- edits to the pipeline
       |   don't reshape historical sessions)
       |-- current_stage_id, current_artifact_version, rejection_count
       |-- phase_status: agent_generating | awaiting_review
       |                 | approved | rejected
       |-- optional Linear issue + pinned GitHub repository
       |-- Artifacts (markdown, versioned on
       |              (session_id, stage_slug, version))
       |    `-- Feedback (targets a reviewed stage/version)
       |-- Phase Completions (one row per approved stage; preserves
       |                      stage_slug snapshot for history)
       |-- Pull Requests (one recorded branch/PR per stage branch)
       |-- Jobs (work queue entries; active dedupe keys vary by enqueue path)
       `-- Runs (one agent execution; provider, usage, messages, sandbox)
```

**Pipeline** = ordered list of stages owned by a workspace. **Stage** = a row with a prompt template and approver list; one row per stage in `pipeline_stages`. **Session** = one end-to-end workflow pinned to a pipeline. **Artifact** = versioned markdown per `(session, stage_slug, version)`. **Run** = one agent execution; a rejection produces a new Run on the same stage.

### Critical Flow (session enqueue -> shipped)

```
create_session_with_first_job RPC
      | atomically creates session + first job + first run
      | first-job dedupe key: session:<session_id>:active
      v
Worker scheduler polls agent_jobs --> claim_next_agent_job RPC
      |- atomic, concurrency-aware job claim
      `- processPipelineJob()
           |- guarded phase_status eligibility update
           |- Generic runStage():
           |    * load current stage + prior artifacts
           |    * render prompt_template_md against session
           |    * mint GitHub installation token, spin up sandbox
           |    * run agent runner (Codex or Claude Code)
           |    * stream events into agent_run_messages
           |    * best-effort push/open or refresh the stage PR
           `- Save markdown artifact, status=awaiting_review
      v
[POST /api/sessions/[sessionId]/phase-action]  (from the dashboard)
      |- Approve -> approve_session_stage RPC: records completion,
      |             advances to next stage by position, enqueues next job
      `- Reject  -> feedback recorded for the artifact version;
                    new job re-runs the same stage
```

### Five Hub Files

If you read only five files to understand Wallie, read these:

| #   | File                                                                                                             | Role                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | [src/lib/pipeline/processor.ts](src/lib/pipeline/processor.ts)                                                   | Generic stage runner. Guard session state, render prompt, run agent in sandbox, write artifact/PR. Review handlers. |
| 2   | [src/lib/pipeline/stages.ts](src/lib/pipeline/stages.ts)                                                         | Pipeline + stage loaders. Maps `pipeline_stages` rows into the runtime stage shape and gathers prior artifacts.     |
| 3   | [src/app/api/sessions/[sessionId]/phase-action/route.ts](src/app/api/sessions/[sessionId]/phase-action/route.ts) | In-app approve/reject handler. Workspace membership + RLS, calls handleApproval / handleRejection.                  |
| 4   | [src/lib/wallie/service.ts](src/lib/wallie/service.ts)                                                           | Transactional session creation plus job enqueue/run tracking, readiness checks, and deduplication.                  |
| 5   | [src/worker/index.ts](src/worker/index.ts)                                                                       | Background daemon. Bounded scheduler, heartbeat, stall detector, Linear reconciler, and sandbox reaper.             |

### Walkthrough by Domain

#### Database -- migrations

- [supabase/migrations/20260422000000_init.sql](supabase/migrations/20260422000000_init.sql) -- the consolidated baseline schema. Every baseline table, RLS policy, trigger, and RPC (`approve_session_stage` is the star) lives here.
- Forward migrations cover schema changes added after the baseline was already applied in production. Recent examples add the pipeline dashboard and narrow session-detail RPCs, transactional session creation, server-rendered session-list sorting/repository data, and workspace usage aggregation.
- [src/lib/supabase/database.types.ts](src/lib/supabase/database.types.ts) -- auto-generated types.

#### Pipeline (`src/lib/pipeline/`) -- the brain

The whole module is stage-agnostic. There are no per-phase files; one generic runner drives every user-defined stage by reading rows from `pipeline_stages`.

- [processor.ts](src/lib/pipeline/processor.ts) -- generic stage runner. The public entry is `processPipelineJob()`; its internal `runStage()` helper renders operating rules plus the stage prompt, spins a sandbox, runs the agent, writes the markdown artifact, and invokes best-effort PR synchronization. Also exports `handleApproval` / `handleRejection`.
- [stages.ts](src/lib/pipeline/stages.ts) -- loaders for `pipelines` / `pipeline_stages`, pipeline operating rules, and the prior-stage artifact map used by the prompt template.
- [state-machine.ts](src/lib/pipeline/state-machine.ts) -- status checks (`canApprove`, `canReject`, `isTerminal`). Stage ordering itself lives on `pipeline_stages.position` and is enumerated by the `approve_session_stage` RPC.
- [pull-request.ts](src/lib/pipeline/pull-request.ts), [archive.ts](src/lib/pipeline/archive.ts), and [cancel.ts](src/lib/pipeline/cancel.ts) -- remote PR synchronization and terminal session controls.
- [prompt-safety.ts](src/lib/pipeline/prompt-safety.ts) -- sanitizes untrusted Linear text (prompt injection defense).
- [types.ts](src/lib/pipeline/types.ts) -- shared pipeline status and job constants. Active-job dedupe keys live in [src/lib/wallie/constants.ts](src/lib/wallie/constants.ts).

The default `plan → build → land` seed lives in the `internal.default_pipeline_stages()` SQL function in the migration -- workspaces can edit, add, remove, or reorder stages from settings, and `renderStagePrompt` (in `src/lib/prompt-templates/`) handles the `{{session.title}}` / `{{session.prompt}}` / `{{artifact.previousStages.<slug>}}` / `{{attempt.feedback}}` placeholders.

#### Worker (`src/worker/`) -- the daemon

- [index.ts](src/worker/index.ts) -- main entry (`pnpm worker`).
- [scheduler.ts](src/worker/scheduler.ts) -- bounded-concurrency fill/wait loop and in-flight job tracking.
- [loop.ts](src/worker/loop.ts) -- atomic concurrency-aware job claim + execution.
- [heartbeat.ts](src/worker/heartbeat.ts) -- worker registration.
- [stall-detector.ts](src/worker/stall-detector.ts) -- resets runs stuck past timeout.
- [reconciler.ts](src/worker/reconciler.ts) -- cancels jobs if Linear issue closed.
- [sandbox-reaper.ts](src/worker/sandbox-reaper.ts) -- shuts down sandboxes whose owning run has ended.
- [concurrency.ts](src/worker/concurrency.ts), [config.ts](src/worker/config.ts) -- per-workspace and per-process limits.

#### API Routes (`src/app/api/`)

```
agent-runs/ + agent-runs/[runId]/{retry,cancel}/                <- enqueue, retry, or cancel runs
sessions/                                                       <- create a session + its first job/run atomically
sessions/[sessionId]/                                           <- title/state, archive/cancel, artifacts, runs
sessions/[sessionId]/phase-action/                              <- in-app approve / reject
sessions/[sessionId]/review-capabilities/                       <- current reviewer authorization/failure state
agent-config/                                                   <- workspace_agent_config CRUD (provider + model)
codex/connection/                                               <- Codex device-auth flow + token verify
claude-code/connection/                                         <- Anthropic API key verify
github/install/ + github/callback/                              <- GitHub App install redirect + signed state
github/webhooks/                                                <- PR + install events
github/refresh-repositories/                                    <- re-sync the installation's repo list
linear/test-connection/                                         <- verify Linear API key
secrets/ + secrets/[key]/                                       <- encrypted workspace creds
workspaces/[workspaceId]/avatar/                                <- storage upload
workspaces/[workspaceId]/members/ + invitations/ + leave/       <- workspace membership lifecycle
workspaces/[workspaceId]/pipeline-dashboard/                    <- bounded dashboard refresh payload
workspaces/[workspaceId]/pipeline/                              <- pipeline + stage editor
workspaces/[workspaceId]/repositories/[repositoryId]/inference/ <- run repo inference
workspaces/[workspaceId]/repositories/[repositoryId]/onboarding/<- per-repo onboarding state
workspaces/[workspaceId]/repository-profile/                    <- workspace_repository_profiles editor
workspaces/[workspaceId]/sandbox-capability-check/              <- probe Vercel Sandbox readiness
workspaces/[workspaceId]/vercel-sandbox-connection/             <- encrypted workspace Sandbox connection
workspaces/[workspaceId]/linear-routing/                        <- workspace_linear_routing rules
workspaces/[workspaceId]/onboarding/ + onboarding/complete/     <- per-workspace setup state
workspaces/[workspaceId]/maintenance/tick/                      <- privileged maintenance trigger
```

#### Features (`src/features/`) -- domain-grouped

- **sessions/** -- session CRUD plus the server-rendered Sessions ledger and artifact-first Review Workbench. `list/` owns the searchable/sortable ledger; `detail/` owns the narrow review payload, lazy artifact versions, streamed activity, and Realtime reconciliation.
- **pipeline/** -- the review-focused workspace dashboard plus shared pipeline editor primitives. The editor itself is surfaced from Settings and onboarding.
- **github/** -- GitHub App install + sync: `service.ts`, `webhooks.ts`, `contracts.ts`.
- **settings/** -- streamed, category-based workspace settings with isolated client islands for integrations, pipeline, advanced controls, and workspace administration.
- **onboarding/** -- snapshot-backed multi-step setup for GitHub, repository analysis, pipeline, optional Linear, agent/runtime, and final verification.
- **wallie/** -- bounded run history and live run/message activity for the session-detail workbench.
- **workspaces/** -- workspace layout + membership data helpers.
- **workspace-members/** -- member CRUD (model, server functions, types).
- **repositories/** + **repository-profile/** -- repo-setup controls and repo-profile editor UI.

#### Libraries (`src/lib/`)

- **supabase/** -- `admin.ts` (service role), `server.ts` (RLS), `browser.ts` (anon), `middleware.ts`, generated `database.types.ts`.
- **secrets/** -- [crypto.ts](src/lib/secrets/crypto.ts) AES-256-GCM encrypt/decrypt for stored credentials.
- **linear/** -- [client.ts](src/lib/linear/client.ts) GraphQL client.
- **linear-routing/** -- per-workspace rules mapping a Linear issue to a tracked repository.
- **agent-runner/** -- provider dispatch ([index.ts](src/lib/agent-runner/index.ts)) plus per-provider runners [codex.ts](src/lib/agent-runner/codex.ts) and [claude-code.ts](src/lib/agent-runner/claude-code.ts) that execute the agent CLI inside a Vercel Sandbox via `sandbox.exec()`.
- **agent-config/** -- contracts + parsing for `workspace_agent_config` (provider, model, recommended defaults).
- **agent-credentials/** -- resolves which user credential a session run should use.
- **codex/** and **claude-code/** -- provider-specific token validation, device-auth flow (Codex), and `auth.json` shaping.
- **sandbox/** -- Vercel Sandbox client wrapper plus an in-process `fake` implementation for tests.
- **sandbox-capabilities/** -- probes sandboxes for required tools/runtimes and persists the result.
- **repo-inference/** -- inspects a connected repo to infer language, frameworks, and install/test/dev commands.
- **repo-onboarding/** -- planner + server state for the per-repo onboarding flow.
- **onboarding/** -- shared contracts and migration helpers for the workspace onboarding pipeline.
- **prompt-templates/** -- renders stage prompts; resolves `{{session.*}}`, `{{artifact.previousStages.*}}`, `{{attempt.feedback}}` placeholders.
- **wallie/** -- job enqueue + run tracking ([service.ts](src/lib/wallie/service.ts)), HTTP helper, shared constants.
- **maintenance/** -- privileged workspace maintenance operations used by Settings and its API route.
- **performance/** and **telemetry/** -- route budgets, server timing, and privacy-safe interaction RUM.
- **vercel-sandbox/** -- encrypted per-workspace Vercel Sandbox connection handling and teardown.
- **workspace-invitations/** and **workspace-members/** -- membership lifecycle contracts and data access.
- **storage/** -- Supabase Storage helpers (e.g. workspace-avatar upload).
- **workspaces/**, **workspaces.ts** -- role-based access control.
- **rate-limit.ts**, **routes.ts**, **auth.ts**, **site-config.ts**, **utils.ts** -- loose utilities.

#### UI

```
app/
|-- layout.tsx, page.tsx              (root)
|-- login/, signup/, auth/            (public)
|-- onboarding/workspace/             (first-run: create a workspace)
`-- w/[workspaceSlug]/                (protected workspace shell)
    |-- onboarding/                   (GitHub, repositories, pipeline, Linear, runtime, verify)
    `-- (app)/                        (route group with the real product UI)
        |-- (pipeline)/               review-focused dashboard at the workspace root
        |-- sessions/                 list + /[sessionNumber] detail
        |-- pipeline/                 legacy redirect to the workspace root
        `-- settings/                 integrations, pipeline editor, advanced, workspace

components/
|-- app-shell/   (shell, header, sidebar)
|-- auth/        (auth-entry-panel)
|-- landing/     (public product page)
|-- onboarding/  (workspace onboarding form)
|-- shared/      (markdown, icons, status and time primitives)
|-- telemetry/   (production interaction instrumentation)
`-- ui/          (dialogs, menus, feedback, overlays, page primitives)
```

### Mental Model

The codebase is four layers:

1. Supabase schema defines nouns.
2. `src/lib/pipeline/` is the verb engine.
3. `src/app/api/` is the edge (ingest + ack).
4. `src/worker/` drains the queue.

Everything else is UI glue or integration plumbing.

## Tech Stack

| Layer           | Technology                                     |
| --------------- | ---------------------------------------------- |
| Framework       | Next.js 16 (App Router) on Vercel              |
| Language        | TypeScript (strict mode)                       |
| UI              | React 19, Tailwind CSS 4                       |
| Database        | Supabase PostgreSQL 17 with Row-Level Security |
| Auth            | Supabase Auth (email magic link + code)        |
| Realtime        | Supabase Realtime (live session updates)       |
| Storage         | Supabase Storage (workspace avatars)           |
| AI              | Codex CLI or Claude Code CLI                   |
| Integrations    | GitHub App (Octokit), Linear GraphQL           |
| Testing         | Vitest, Playwright, ESLint, Prettier           |
| Package manager | pnpm 10                                        |
| Node            | >= 22.13                                       |

## Project Structure

```
src/
  app/                          # Next.js App Router
    api/                        # Route handlers (webhooks, jobs, auth, secrets)
      agent-runs/               # Enqueue, retry, and cancel pipeline jobs
      sessions/                 # Atomic create + session review/activity routes
      agent-config/             # workspace_agent_config CRUD
      codex/, claude-code/      # Provider connection / token flows
      github/                   # GitHub App install, webhooks, repo refresh
      linear/                   # Linear API key verification
      secrets/                  # Encrypted credential CRUD
      workspaces/[workspaceId]/ # Pipeline, repositories, onboarding, sandbox check, ...
    auth/                       # Auth flows (callback, email, signout, confirm)
    login/, signup/             # Public auth pages
    onboarding/workspace/       # First-run: create a workspace
    w/[workspaceSlug]/          # Protected workspace shell
      onboarding/               # Post-workspace setup
      (app)/                    # Route group with dashboard / sessions / settings
  components/                   # Shared UI (app shell, sidebar, dropdowns, ui primitives)
  env/                          # Zod-validated environment variable schemas
  features/                     # Domain modules (sessions, pipeline, github, settings,
                                #   onboarding, wallie, workspaces, workspace-members,
                                #   repositories, repository-profile)
  lib/                          # Core logic
    pipeline/                   # Generic stage runner, stage loaders, state machine
    supabase/                   # DB clients, auth, middleware, generated types
    secrets/                    # AES-256-GCM encryption for stored credentials
    linear/, linear-routing/    # Linear GraphQL client + per-workspace routing rules
    agent-runner/               # Provider dispatch + Codex/Claude Code runners
    agent-config/               # Provider + model parsing for workspace_agent_config
    agent-credentials/          # Picks the user credential for a session run
    codex/, claude-code/        # Provider token validation + auth flows
    sandbox/                    # Vercel Sandbox wrapper (+ fake for tests)
    sandbox-capabilities/       # Probe sandboxes for required tools
    repo-inference/             # Infer language / framework / commands per repo
    repo-onboarding/            # Per-repo onboarding planner + state
    onboarding/                 # Workspace onboarding contracts + helpers
    prompt-templates/           # Stage prompt rendering
    wallie/                     # Job service, HTTP helper, constants
    workspaces/                 # Access control (role-based)
    storage/                    # Supabase Storage helpers
    maintenance/                # Workspace maintenance operations
    performance/, telemetry/    # Route budgets, timings, privacy-safe RUM
    vercel-sandbox/             # Per-workspace Sandbox connection handling
    workspace-invitations/      # Invitation lifecycle
  worker/                       # Background daemon (bounded scheduler, heartbeat,
                                #   stall detector, reconciler, sandbox-reaper)
middleware.ts                   # Next.js middleware: Supabase auth session refresh
supabase/
  migrations/                   # SQL migrations (schema, RLS, triggers, RPCs)
  seed.sql                      # Development seed data
  config.toml                   # Supabase CLI config (local dev)
```

## Local Setup (End-to-End)

> This section gets Wallie running **locally for development** (local Supabase + a tunnel). To deploy a real, internet-facing instance, see the [Self-Hosting guide](docs/SELF_HOSTING.md).

### Prerequisites

- Node.js >= 22.13
- pnpm >= 10
- Docker (for local Supabase)
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
- A tunnel tool that exposes `localhost:3000` to the public internet. [ngrok](https://ngrok.com/) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) both work. You only need this if you want to exercise GitHub webhooks; Supabase + Linear + the dev UI work without a tunnel.
- Accounts/access:
  - Codex or Claude Code access for agent runs
  - Optionally, a Linear workspace + personal API key (for linked issue context and reconciliation)
  - A GitHub user or org where you can create a GitHub App (for GitHub integration)

### 1. Clone and install

```bash
git clone https://github.com/anantjain-xyz/wallie-dev.git
cd wallie-dev
pnpm install
```

### 2. Start a public tunnel (optional but recommended)

GitHub webhooks need a public HTTPS URL. Start the tunnel first so you have a stable origin to paste into app configs.

```bash
# ngrok
ngrok http 3000

# cloudflared (quick tunnel)
cloudflared tunnel --url http://localhost:3000
```

Note the HTTPS URL the tunnel prints (e.g. `https://wallie-dev.ngrok.app`). It replaces `http://localhost:3000` in `NEXT_PUBLIC_APP_URL` and in every third-party app config below. If you restart the tunnel and get a new URL, update `.env.local` and the GitHub app settings to match.

### 3. Start local Supabase

```bash
supabase start
```

This boots a local Postgres 17, GoTrue (auth), Realtime, and Storage stack via Docker. Migrations in `supabase/migrations/` are applied automatically. The CLI prints values you need in the next step:

- `API URL` -> `NEXT_PUBLIC_SUPABASE_URL`
- `anon key` -> `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `service_role key` -> `SUPABASE_SECRET_KEY`

Re-run `supabase status` any time to recover these. Reset the local DB with `supabase db reset`.

### 4. Configure environment

```bash
cp .env.example .env.local
```

Fill in the required values. Integration variables can be left blank until you complete the GitHub app setup below.

| Variable                               | Required | Description                                                                                                                                                |
| -------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`                  | Yes      | Public app origin (e.g. `https://wallie-dev.ngrok.app`, or `http://localhost:3000`)                                                                        |
| `NEXT_PUBLIC_SUPABASE_URL`             | Yes      | From `supabase start` output                                                                                                                               |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes      | Supabase anon / publishable key                                                                                                                            |
| `SUPABASE_SECRET_KEY`                  | Yes      | Supabase service role key                                                                                                                                  |
| `WALLIE_ENCRYPTION_KEY`                | Yes      | Hex (64+ chars) or base64 (43+ chars) secret used for AES-256-GCM at-rest encryption                                                                       |
| `GITHUB_APP_ID`                        | GitHub   | GitHub App "General" -> "App ID"                                                                                                                           |
| `GITHUB_APP_PRIVATE_KEY`               | GitHub   | PEM contents from "Generate a private key" (escape newlines as `\n` if quoted)                                                                             |
| `GITHUB_WEBHOOK_SECRET`                | GitHub   | The webhook secret you set when creating the GitHub App                                                                                                    |
| `VERCEL_TOKEN`                         | Dev/Ops  | Optional operator token for non-session helper sandboxes or local testing. Wallie session sandboxes use the workspace Vercel connection saved in Settings. |
| `VERCEL_TEAM_ID`                       | Dev/Ops  | Optional Vercel team for the operator token. Workspace session sandboxes do not read this env var.                                                         |
| `VERCEL_PROJECT_ID`                    | Dev/Ops  | Optional Vercel project for the operator token. Workspace session sandboxes do not read this env var.                                                      |
| `WALLIE_SANDBOX_IMPL`                  | No       | Sandbox implementation: `vercel` (default) or `fake` (tests / local without Vercel creds).                                                                 |
| `WALLIE_SANDBOX_BOOTSTRAP_PLAYWRIGHT`  | No       | Set to `0` to skip Playwright bootstrap inside sandboxes.                                                                                                  |
| `WALLIE_TIMING_LOGS`                   | No       | Set to `1` in a canary to emit server-loader timing logs.                                                                                                  |
| `WORKER_MAX_CONCURRENT_JOBS`           | No       | Maximum jobs one worker process runs concurrently (default `10`); per-workspace limits still apply.                                                        |

Generate `WALLIE_ENCRYPTION_KEY` with e.g. `openssl rand -hex 32`.

Workspace-scoped secrets (`LINEAR_API_KEY`, repository env keys, etc.) and the workspace Vercel Sandbox connection are **not** environment variables -- they are entered through the app's Settings UI and stored encrypted in the database. Per-user agent credentials are also entered in Settings and stored encrypted separately.

### Configure agent provider

Workspaces choose the agent provider and model in **Settings -> Integrations**. Supported providers are Codex and Claude Code. Codex defaults to `gpt-5.6-sol`; Claude Code defaults to `claude-opus-4-8[1m]`. Codex users can connect a ChatGPT subscription with the Codex device-code flow, paste a Business/Enterprise Codex access token, or paste an OpenAI Platform API key; Claude Code users connect by pasting an Anthropic API key.

### 5. Create a GitHub App

Go to <https://github.com/settings/apps> -> **New GitHub App** (or your org's equivalent under Settings -> Developer settings).

- **Homepage URL**: `$PUBLIC_URL`
- **Callback URL**: `$PUBLIC_URL/api/github/callback` (keep "Request user authorization (OAuth) during installation" **off** -- Wallie uses the app-install flow)
- **Setup URL** (required post-install redirect): `$PUBLIC_URL/api/github/callback`
- **Webhook**
  - Active: yes
  - URL: `$PUBLIC_URL/api/github/webhooks`
  - Secret: any strong random string -- put the same value in `GITHUB_WEBHOOK_SECRET`
- **Permissions -> Repository**
  - Contents: **Read and write** (clone/push stage branches and repository-onboarding commits)
  - Pull requests: **Read and write** (open/update setup and session-stage PRs and track their state)
  - Metadata: **Read-only** (mandatory; GitHub enables it automatically)
- **Subscribe to events**: `Pull request`. The `installation` and `installation_repositories` events are delivered automatically by GitHub and are handled at `/api/github/webhooks`.
- **Where can this GitHub App be installed?** Only on this account (for local dev).

After creation:

1. Copy **App ID** -> `GITHUB_APP_ID`.
2. Click **Generate a private key**, download the `.pem`, and put its contents in `GITHUB_APP_PRIVATE_KEY`. If you inline it into `.env.local`, replace real newlines with `\n` and quote the value.
3. Click **Install App** and install it onto the repo(s) you want Wallie to see. Wallie's in-app flow (`GET /api/github/install` -> GitHub -> `GET /api/github/callback`) stores the installation against your workspace.

### 6. Linear API key (optional)

Linear is pull-only -- no webhook, no OAuth.

1. Generate a personal API key at <https://linear.app/settings/api>.
2. After you create a workspace in Wallie, paste the key into **Settings -> Integrations -> Linear**. Saving the key automatically calls `POST /api/linear/test-connection`.

### 7. Start the dev server

```bash
pnpm dev
```

The app runs at `http://localhost:3000` and is reachable at your tunnel origin. Keep it running.

### 8. Start the worker

In a second terminal:

```bash
pnpm worker
```

The worker heartbeats into `worker_heartbeats`, uses the concurrency-aware `claim_next_agent_job` RPC to fill its bounded scheduler, and runs the generic stage runner. Without it, jobs stay queued and nothing progresses past `agent_generating`.

### 9. First run

1. Open `http://localhost:3000`, sign up / log in via Supabase Auth.
2. Create a workspace, then complete its onboarding: connect GitHub, analyze/select a repository, review the pipeline, optionally connect Linear, connect the agent/runtime, and verify setup.
3. Use **Settings -> Integrations** later to change provider credentials, repository connections, Vercel Sandbox, or Linear routing. The pipeline editor lives under **Settings -> Pipeline**.
4. Create a session from the Sessions ledger, watch the worker claim its first job, then approve or request changes on the resulting artifact from the Review Workbench.

### Tunnel: what must be publicly reachable

| Integration | Endpoint                    | Why                                   |
| ----------- | --------------------------- | ------------------------------------- |
| GitHub      | `POST /api/github/webhooks` | App install and PR event deliveries   |
| GitHub App  | `GET  /api/github/callback` | Browser redirect from github.com      |
| Linear      | -- (pull only)              | Wallie calls Linear, never vice versa |
| Supabase    | -- (local Docker)           | App and worker connect to localhost   |

### Troubleshooting

- **GitHub webhook 401** -- `GITHUB_WEBHOOK_SECRET` in `.env.local` doesn't match the value in the GitHub App. GitHub's Advanced -> Recent Deliveries panel shows the exact error.
- **Session stays in `agent_generating` forever** -- worker isn't running, the worker cannot reach Supabase, or agent/Sandbox/GitHub credentials are missing or invalid. Check `pnpm worker` logs and the session activity panel.
- **RLS errors during local dev** -- confirm `SUPABASE_SECRET_KEY` is the service role key (not the anon key) and that `supabase start` finished applying migrations.

## Scripts

| Command                                  | Description                                                   |
| ---------------------------------------- | ------------------------------------------------------------- |
| `pnpm dev`                               | Start Next.js dev server                                      |
| `pnpm build`                             | Production build                                              |
| `pnpm start`                             | Start production server                                       |
| `pnpm worker`                            | Start the bounded-concurrency background worker               |
| `pnpm test`                              | Run unit/integration tests (Vitest)                           |
| `pnpm test:watch`                        | Run Vitest in watch mode                                      |
| `pnpm test:e2e:onboarding`               | Build and run onboarding mutation-request Playwright coverage |
| `pnpm test:e2e:responsive`               | Build and run responsive/touch Playwright coverage            |
| `pnpm test:e2e:session-prefetch`         | Build and verify session-detail prefetch behavior             |
| `pnpm test:benchmark:interaction`        | Build and run the interaction RUM benchmark                   |
| `pnpm test:benchmark:content-visibility` | Build and run the content-visibility benchmark                |
| `pnpm lint`                              | Lint with ESLint (zero warnings)                              |
| `pnpm lint:fix`                          | Auto-fix lint issues                                          |
| `pnpm format`                            | Format with Prettier                                          |
| `pnpm format:check`                      | Check formatting                                              |
| `pnpm typecheck`                         | TypeScript type check                                         |
| `pnpm db:types`                          | Regenerate local Supabase database types                      |
| `pnpm analyze:authenticated-bundle`      | Analyze authenticated-route client bundles                    |
| `pnpm check:route-budgets`               | Check built route bundles against committed byte budgets      |
| `pnpm check`                             | Run all checks (format:check, lint, typecheck, test)          |

## Architecture Notes

### Multi-tenancy

Tenant-owned data rows are scoped to a `workspace_id`, and Supabase RLS policies enforce isolation. A database trigger (`enforce_session_refs`) validates session FK consistency across workspace boundaries.

### Concurrency

Job claims are atomic and concurrency-aware through `claim_next_agent_job`. Phase approvals use compare-and-swap semantics: `approve_session_stage` only succeeds if the session is in `awaiting_review` at the expected artifact version. The processor's final `agent_generating` → `awaiting_review` update is scoped to an unarchived session that is still generating. Rejection CAS-claims the status, version, and rejection count before recording feedback, but its later enqueue and status update are a multi-step workflow rather than one atomic transaction.

### Deduplication

Linear-linked sessions are deduplicated on `(workspace_id, linear_issue_id)`; sessions without a Linear issue are not subject to that constraint. Interactive create/run/retry paths use `session:<session_id>:active`, while the Linear reconciler retains `pipeline:<linear_issue_id>:active` and `pipeline:session:<session_id>:active` keys. The partial unique index prevents two active jobs with the same `(workspace_id, dedupe_key)`; it does not enforce a universal one-active-job-per-session invariant across different keys.

### Security

- Integration credentials are encrypted at rest with AES-256-GCM
- GitHub webhooks are signature-verified
- A `sanitizeUntrusted()` helper lives in `src/lib/pipeline/prompt-safety.ts` for prompt-injection defense; note it is **not yet wired into the prompt path** (`processPipelineJob()` renders the session prompt as-is), so apply it yourself when extending prompts with untrusted input

### Realtime

The Review Workbench subscribes to Supabase Realtime changes on `sessions`, `session_artifacts`, `session_phase_completions`, and `session_pull_requests`. Its activity panel separately watches `agent_runs` and only the currently relevant `agent_run_messages`, keeping phase, artifact, PR, and bounded run activity live without shipping the full history in the initial page payload.

## Integrations

### GitHub

A GitHub App syncs repository metadata, creates repository-onboarding and session-stage branches/PRs, and tracks pull request state. Installations and repositories are stored per workspace.

Webhook endpoint: `/api/github/webhooks`

### Linear

Linear is optional. A linked issue keeps its identifier and URL attached to a session and lets the worker reconcile closed issues. The personal API key is stored as an encrypted workspace secret and verified via `/api/linear/test-connection`; Wallie does not require a Linear webhook or OAuth flow.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, the checks to run before opening a PR, and conventions. To report a security issue, follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Anant Jain and Wallie contributors.
