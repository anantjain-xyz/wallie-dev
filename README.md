# Wallie

AI-powered product development automation. Wallie turns Linear issues into structured product specs, coordinates multi-phase development pipelines, and integrates with Slack and GitHub to keep your team in the loop.

## How It Works

Wallie organizes work into **sessions**. Each session is pinned at create time to a **pipeline** -- an ordered, user-configurable list of **stages** owned by the workspace. A worker drains the job queue, runs the session's current stage, and posts the result to Slack for review.

Stages are not hardcoded. A workspace can edit, add, remove, or reorder them from settings. Every new workspace is seeded with a default `product → design → engineering → review → land → monitor` pipeline so the UX works out of the box, but each stage is just a row in `pipeline_stages` with a slug, position, name, prompt template, and approver list -- nothing in code distinguishes one stage from another.

A single generic stage runner (`runStage()` in `src/lib/pipeline/processor.ts`) handles every stage:

1. Render the stage's prompt template against the session context (title, description, prior stage artifacts, last reviewer feedback).
2. Spin up a sandbox cloned from the workspace's connected GitHub repo on a per-stage branch.
3. Run the workspace's configured agent (Codex or Claude Code) inside the sandbox.
4. Capture the agent's text output as a markdown artifact, version it as `(session_id, stage_slug, version)`, and flip the session to `awaiting_review`.
5. Post the artifact to the session's Slack thread with Approve / Request Changes buttons.

Humans approve or reject artifacts via Slack (or the in-app dashboard). Approval advances to the next stage by `position` via the `approve_session_stage` RPC. Rejection writes the feedback onto the artifact and enqueues a new job that re-runs the same stage with `{{attempt.feedback}}` injected into the prompt. Three rejections escalate the session to the engineering manager via Slack DM.

### Entry Points

- **Slack**: mention the bot with a Linear issue URL (`@wallie https://linear.app/team/issue/TEAM-123`) to create a session and kick off its first stage automatically.
- **In-app**: click "New Session" from the sessions list to create one manually.

### Pipeline Flow

```
Slack mention
  -> session created, pinned to workspace's default pipeline
     (current_stage_id = first stage, phase_status = agent_generating)
  -> agent job enqueued automatically
  -> worker claims job (atomic CAS on phase_status)
  -> runStage() renders prompt, runs agent in sandbox,
     writes markdown artifact, status=awaiting_review
  -> artifact posted to Slack thread with [Approve] / [Request Changes]
  -> approve  -> approve_session_stage RPC advances to next stage by position,
                 enqueues the next job
  -> reject   -> feedback saved on artifact; new job re-runs the same stage
  -> repeat until the terminal stage is approved -> session archived
  -> 3 rejections at any stage -> escalation DM to the engineering manager

In-app create
  -> session created with chosen pipeline
  -> agent job must be triggered separately (not auto-enqueued)
```

## Codebase Walkthrough

A 10-minute tour of the repository, file by file.

### Top-Level Map

```
wallie-cc/
|-- src/
|   |-- app/           -> Next.js routes (pages + API)
|   |-- components/    -> Shared React UI
|   |-- features/      -> Domain modules (sessions, github, slack...)
|   |-- lib/           -> Core libraries (pipeline, auth, supabase...)
|   |-- worker/        -> Background daemon (polls jobs)
|   `-- middleware.ts  -> Auth gate
|-- supabase/
|   `-- migrations/20260422000000_init.sql  -> Entire schema (one file)
`-- AGENTS.md          -> Arch rules (no ElectricSQL, no PGlite...)
```

### Domain Model

```
Workspace (tenant)
  |-- Members (humans + "wallie" system agent)
  |-- Secrets (encrypted: ANTHROPIC_API_KEY, LINEAR_API_KEY,
  |            EM_SLACK_USER_ID, ...)
  |-- Pipelines (1..N; one flagged is_default)
  |    `-- Stages (position, slug, name, prompt_template_md,
  |                approver_member_ids[])
  `-- Sessions <- the unit of work
       |-- pipeline_id (pinned at create time -- edits to the pipeline
       |   don't reshape historical sessions)
       |-- current_stage_id, current_artifact_version, rejection_count
       |-- phase_status: agent_generating | awaiting_review
       |                 | approved | rejected | escalated
       |-- Artifacts (markdown, versioned on
       |              (session_id, stage_slug, version))
       |-- Phase Completions (one row per approved stage; preserves
       |                      stage_slug snapshot for history)
       |-- Jobs (work queue entries; dedupe per active stage)
       `-- Runs (one agent execution; provider, tokens, messages)
```

**Pipeline** = ordered list of stages owned by a workspace. **Stage** = a row with a prompt template and approver list; one row per stage in `pipeline_stages`. **Session** = one end-to-end workflow pinned to a pipeline. **Artifact** = versioned markdown per `(session, stage_slug, version)`. **Run** = one agent execution; a rejection produces a new Run on the same stage.

### Critical Flow (Slack mention -> shipped)

```
Slack @wallie + Linear URL
      |
      v
[POST /api/slack/events]  -- verify HMAC, ack fast
      | (after() -- async)
      v
Create Session (pinned to default pipeline) + Enqueue Job
      | (dedup: pipeline:<linear_issue_id>:active)
      v
Worker polls --> [POST /api/agent-jobs/process]
      |             |- CAS claim (atomic phase_status update)
      |             |- Generic runStage():
      |             |    * load current stage + prior artifacts
      |             |    * render prompt_template_md against session
      |             |    * mint GitHub installation token, spin up sandbox
      |             |    * run agent runner (Codex or Claude Code)
      |             |    * stream events into agent_run_messages
      |             |- Save markdown artifact, status=awaiting_review
      |             `- Post to Slack thread [Approve][Request Changes]
      v
[POST /api/slack/interactions]
      |- Approve -> approve_session_stage RPC: records completion,
      |             advances to next stage by position, enqueues next job
      `- Reject  -> modal -> feedback saved on artifact; new job re-runs
                    the same stage (3 rejects -> escalation DM to EM)
```

### Five Hub Files

If you read only five files to understand Wallie, read these:

| #   | File                                                                   | Role                                                                                                                          |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | [src/lib/pipeline/processor.ts](src/lib/pipeline/processor.ts)         | Generic stage runner. CAS claim, render prompt, run agent in sandbox, write artifact, post to Slack. Approve/reject handlers. |
| 2   | [src/lib/pipeline/stages.ts](src/lib/pipeline/stages.ts)               | Pipeline + stage loaders. Maps `pipeline_stages` rows into the runtime stage shape and gathers prior artifacts.               |
| 3   | [src/app/api/slack/events/route.ts](src/app/api/slack/events/route.ts) | Slack mention entry. HMAC verify, extract Linear URL, create session, enqueue first stage.                                    |
| 4   | [src/lib/wallie/service.ts](src/lib/wallie/service.ts)                 | Job enqueue + run tracking. Dedup keys, secret loading, agent_runs lifecycle.                                                 |
| 5   | [src/worker/index.ts](src/worker/index.ts)                             | Background daemon. Heartbeat, poll loop, stall detector, Linear reconciler.                                                   |

### Walkthrough by Domain

#### Database -- one file tells the whole story

- [supabase/migrations/20260422000000_init.sql](supabase/migrations/20260422000000_init.sql) -- 1664 lines. Every table, RLS policy, trigger, and RPC (`approve_session_phase` is the star). Tables: `workspaces`, `workspace_members`, `sessions`, `session_artifacts`, `agent_jobs`, `agent_runs`, `agent_run_messages`, `workspace_secrets`, `github_installations`, `slack_installations`, `issues`, `session_pull_requests`.
- [src/lib/supabase/database.types.ts](src/lib/supabase/database.types.ts) -- auto-generated types.

#### Pipeline (`src/lib/pipeline/`) -- the brain

The whole module is stage-agnostic. There are no per-phase files; one generic runner drives every user-defined stage by reading rows from `pipeline_stages`.

- [processor.ts](src/lib/pipeline/processor.ts) -- generic stage runner. `runStage()` renders the stage prompt, spins a sandbox, runs the agent, writes the markdown artifact, and posts the review to Slack. Also exports `handleApproval` / `handleRejection`.
- [stages.ts](src/lib/pipeline/stages.ts) -- loaders for `pipelines` / `pipeline_stages` and the prior-stage artifact map used by the prompt template.
- [state-machine.ts](src/lib/pipeline/state-machine.ts) -- status checks (`canApprove`, `canReject`, `isTerminal`) and the 3-rejection escalation threshold. Stage ordering itself lives on `pipeline_stages.position` and is enumerated by the `approve_session_stage` RPC.
- [prompt-safety.ts](src/lib/pipeline/prompt-safety.ts) -- sanitizes untrusted Linear text (prompt injection defense).
- [slack-format.ts](src/lib/pipeline/slack-format.ts) -- artifact and escalation messages as Slack Block Kit.
- [types.ts](src/lib/pipeline/types.ts) -- pipeline job type, model, escalation threshold, dedupe key helper.

The default `product → design → engineering → review → land → monitor` seed lives in the `internal.default_pipeline_stages()` SQL function in the migration -- workspaces can edit, add, remove, or reorder stages from settings, and `renderStagePrompt` (in `src/lib/prompt-templates/`) handles the `{{session.title}}` / `{{session.prompt}}` / `{{artifact.previousStages.<slug>}}` / `{{attempt.feedback}}` placeholders.

#### Worker (`src/worker/`) -- the daemon

- [index.ts](src/worker/index.ts) -- main entry (`pnpm worker`).
- [loop.ts](src/worker/loop.ts) -- one poll iteration (claim + execute).
- [heartbeat.ts](src/worker/heartbeat.ts) -- worker registration.
- [stall-detector.ts](src/worker/stall-detector.ts) -- resets runs stuck past timeout.
- [reconciler.ts](src/worker/reconciler.ts) -- cancels jobs if Linear issue closed.
- [concurrency.ts](src/worker/concurrency.ts), [config.ts](src/worker/config.ts).

#### API Routes (`src/app/api/`)

```
agent-jobs/process/route.ts          <- worker calls this
sessions/[sessionId]/phase-action/   <- in-app approve/reject
slack/events/                        <- mentions in
slack/interactions/                  <- button clicks
slack/install/ + callback/           <- OAuth
github/webhooks/                     <- PR/install events
github/install/ + callback/          <- OAuth
linear/test-connection/              <- verify API key
secrets/                             <- encrypted workspace creds
workspaces/[id]/avatar/              <- storage upload
agent-runs/[runId]/retry/            <- rerun a failed run
```

#### Features (`src/features/`) -- domain-grouped

- **sessions/** -- `server.ts` (RLS queries), `client.ts`, `model.ts`, `detail/` (with Realtime subscription in `session-detail-page-client.tsx`), `list/`, `create-session-dialog.tsx`.
- **github/** -- `service.ts`, `webhooks.ts`, `contracts.ts`.
- **slack/** -- `service.ts` (OAuth), `state.ts`, `config.ts`.
- **issues/**, **pipeline/**, **settings/**, **workers/**, **wallie/** (legacy orchestration).

#### Libraries (`src/lib/`)

- **supabase/** -- `admin.ts` (service role), `server.ts` (RLS), `browser.ts` (anon), `middleware.ts`.
- **secrets/** -- [crypto.ts](src/lib/secrets/crypto.ts) AES-256 encrypt/decrypt.
- **slack/** -- [verify.ts](src/lib/slack/verify.ts) HMAC-SHA256.
- **linear/** -- [client.ts](src/lib/linear/client.ts) GraphQL.
- **agent-runner/** -- [claude-code.ts](src/lib/agent-runner/claude-code.ts) spawns Claude Code CLI subprocess.
- **workspaces.ts**, **storage/**, **routes.ts**, **env/**.

#### UI

```
app/
|-- layout.tsx, page.tsx         (root)
|-- login/, signup/, auth/       (public)
|-- onboarding/workspace/        (first-run)
`-- w/[workspaceSlug]/           (protected -- all real UI)
    |-- sessions/                   list + /[sessionNumber] detail
    |-- issues/                     GitHub issue tracker
    |-- pipeline/                   phase dashboard
    |-- settings/                   integrations + secrets
    `-- workers/                    daemon health

components/
|-- app-shell/   (shell, header, sidebar)
|-- auth/        (auth-entry-panel)
|-- onboarding/  (workspace form)
`-- shared/      (icons, dropdown, status-chip)
```

### Mental Model

The codebase is four layers:

1. Supabase schema defines nouns.
2. `src/lib/pipeline/` is the verb engine.
3. `src/app/api/` is the edge (ingest + ack).
4. `src/worker/` drains the queue.

Everything else is UI glue or integration plumbing.

## Tech Stack

| Layer           | Technology                                          |
| --------------- | --------------------------------------------------- |
| Framework       | Next.js 16 (App Router) on Vercel                   |
| Language        | TypeScript (strict mode)                            |
| UI              | React 19, Tailwind CSS 4                            |
| Database        | Supabase PostgreSQL 17 with Row-Level Security      |
| Auth            | Supabase Auth (email + OAuth)                       |
| Realtime        | Supabase Realtime (live session updates)            |
| Storage         | Supabase Storage (workspace avatars)                |
| AI              | Claude Sonnet 4 via Anthropic SDK                   |
| Integrations    | Slack Bot API, GitHub App (Octokit), Linear GraphQL |
| Testing         | Vitest, ESLint, Prettier                            |
| Package manager | pnpm 10                                             |
| Node            | >= 22.13                                            |

## Project Structure

```
src/
  app/                        # Next.js App Router
    api/                      # Route handlers (webhooks, jobs, auth, secrets)
      agent-jobs/             # Pipeline job processor endpoint
      github/                 # GitHub App install, webhooks, repo sync
      slack/                  # Slack events, interactions, OAuth
      linear/                 # Linear API key verification
      secrets/                # Encrypted credential CRUD
      workspaces/             # Workspace creation, avatar upload
    auth/                     # Auth flows (callback, email, signout, confirm)
    login/, signup/           # Public auth pages
    onboarding/               # First-time workspace setup
    w/[workspaceSlug]/        # Workspace routes
      sessions/               # Session list and detail pages
      settings/               # Workspace + integration settings
  components/                 # Shared UI (app shell, sidebar, dropdowns)
  env/                        # Zod-validated environment variable schemas
  features/                   # Feature modules
    sessions/                 # Session CRUD, list, detail, Slack helpers
    github/                   # GitHub installation, repo sync, webhook handlers
    settings/                 # Workspace settings page
    slack/                    # Slack integration helpers
    wallie/                   # Legacy agent orchestration (being replaced)
  lib/                        # Core logic
    pipeline/                 # Generic stage runner, stage loaders, state machine
    supabase/                 # DB clients, auth, middleware, generated types
    secrets/                  # AES-256 encryption for stored credentials
    linear/                   # Linear GraphQL client
    wallie/                   # Job service, executor, HTTP client
    workspaces/               # Access control (role-based)
  worker/                     # Background daemon (heartbeat, poll loop, stall detector)
supabase/
  migrations/                 # SQL migrations (schema, RLS, triggers, RPCs)
  seed.sql                    # Development seed data
  config.toml                 # Supabase CLI config (local dev)
```

## Local Setup (End-to-End)

This section walks from a clean clone to a working Slack-mention-to-spec round trip on your laptop.

### Prerequisites

- Node.js >= 22.13
- pnpm >= 10
- Docker (for local Supabase)
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
- A tunnel tool that exposes `localhost:3000` to the public internet. [ngrok](https://ngrok.com/) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) both work. You only need this if you want to exercise Slack or GitHub; Supabase + Linear + the dev UI work without a tunnel.
- Accounts/access:
  - An Anthropic API key (for Claude Sonnet 4)
  - A Linear workspace + personal API key (for product-spec source context)
  - A Slack workspace where you can install a custom app (for Slack integration)
  - A GitHub user or org where you can create a GitHub App (for GitHub integration)

### 1. Clone and install

```bash
git clone <this-repo>
cd wallie-cc
pnpm install
```

### 2. Start a public tunnel (optional but recommended)

Slack and GitHub webhooks need a public HTTPS URL. Start the tunnel first so you have a stable origin to paste into app configs.

```bash
# ngrok
ngrok http 3000

# cloudflared (quick tunnel)
cloudflared tunnel --url http://localhost:3000
```

Note the HTTPS URL the tunnel prints (e.g. `https://wallie-dev.ngrok.app`). It replaces `http://localhost:3000` in `NEXT_PUBLIC_APP_URL` and in every third-party app config below. If you restart the tunnel and get a new URL, update `.env.local` and the Slack / GitHub app settings to match.

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

Fill in the required values. Integration variables can be left blank until you complete the Slack / GitHub app setup below.

| Variable                               | Required | Description                                                                           |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`                  | Yes      | Public app origin (e.g. `https://wallie-dev.ngrok.app`, or `http://localhost:3000`)   |
| `NEXT_PUBLIC_SUPABASE_URL`             | Yes      | From `supabase start` output                                                          |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes      | Supabase anon / publishable key                                                       |
| `SUPABASE_SECRET_KEY`                  | Yes      | Supabase service role key                                                             |
| `WALLIE_ENCRYPTION_KEY`                | Yes      | Hex (64+ chars) or base64 (43+ chars) secret used for AES-256 at-rest encryption      |
| `WALLIE_PROCESS_TOKEN`                 | No       | Bearer token required on `POST /api/agent-jobs/process` when present; worker uses it  |
| `WALLIE_DEFAULT_ANTHROPIC_MODEL`       | No       | Emergency override for the Anthropic runner default                                   |
| `SLACK_CLIENT_ID`                      | Slack    | Slack app "Basic Information" -> "App Credentials"                                    |
| `SLACK_CLIENT_SECRET`                  | Slack    | Same panel                                                                            |
| `SLACK_SIGNING_SECRET`                 | Slack    | Same panel; used to verify `/api/slack/events` + `/api/slack/interactions` signatures |
| `GITHUB_APP_ID`                        | GitHub   | GitHub App "General" -> "App ID"                                                      |
| `GITHUB_APP_PRIVATE_KEY`               | GitHub   | PEM contents from "Generate a private key" (escape newlines as `\n` if quoted)        |
| `GITHUB_WEBHOOK_SECRET`                | GitHub   | The webhook secret you set when creating the GitHub App                               |

Generate `WALLIE_ENCRYPTION_KEY` with e.g. `openssl rand -hex 32`.

Workspace-scoped secrets (`ANTHROPIC_API_KEY`, `LINEAR_API_KEY`) are **not** environment variables -- they are entered through the app's Settings UI and stored encrypted in `workspace_secrets`.

### Configure agent provider

Workspaces choose the agent provider and model in **Settings -> Integrations**. The Codex runner defaults to `gpt-5-codex`. The Anthropic API runner defaults to `claude-sonnet-4-6`; set `WALLIE_DEFAULT_ANTHROPIC_MODEL` only when you need to override that default before a code change can ship.

### 5. Create a Slack app

Go to <https://api.slack.com/apps> -> **Create New App** -> **From scratch**, name it (e.g. "Wallie Dev"), pick your Slack workspace.

Then configure the following. `$PUBLIC_URL` = your tunnel origin from step 2.

- **Basic Information** -> **App Credentials**: copy `Client ID`, `Client Secret`, `Signing Secret` into `.env.local`.
- **OAuth & Permissions**
  - Redirect URL: `$PUBLIC_URL/api/slack/callback`
  - Bot Token Scopes: `app_mentions:read`, `chat:write`, `chat:write.public`
- **Event Subscriptions**
  - Enable events.
  - Request URL: `$PUBLIC_URL/api/slack/events` (Slack will verify with a `url_verification` ping -- the dev server must be running and the tunnel live)
  - Subscribe to bot event: `app_mention`
- **Interactivity & Shortcuts**
  - Enable interactivity.
  - Request URL: `$PUBLIC_URL/api/slack/interactions` (powers the Approve / Request Changes buttons and the rejection-feedback modal)
- **Install App** -> install to your workspace. Wallie's own OAuth flow at `$PUBLIC_URL/api/slack/install` will create the `slack_installations` row once you trigger it from the Settings -> Integrations page.
- Invite the bot to the channel you plan to test in: `/invite @Wallie`.

### 6. Create a GitHub App

Go to <https://github.com/settings/apps> -> **New GitHub App** (or your org's equivalent under Settings -> Developer settings).

- **Homepage URL**: `$PUBLIC_URL`
- **Callback URL**: `$PUBLIC_URL/api/github/callback` (keep "Request user authorization (OAuth) during installation" **off** -- Wallie uses the app-install flow)
- **Setup URL** (optional, post-install redirect): `$PUBLIC_URL/api/github/callback`
- **Webhook**
  - Active: yes
  - URL: `$PUBLIC_URL/api/github/webhooks`
  - Secret: any strong random string -- put the same value in `GITHUB_WEBHOOK_SECRET`
- **Permissions -> Repository**
  - Pull requests: **Read-only** (tracks PR state/merge)
  - (Everything else can stay "No access" until a later phase needs it.)
- **Subscribe to events**: `Pull request`. The `installation` and `installation_repositories` events are delivered automatically by GitHub and are handled at `/api/github/webhooks`.
- **Where can this GitHub App be installed?** Only on this account (for local dev).

After creation:

1. Copy **App ID** -> `GITHUB_APP_ID`.
2. Click **Generate a private key**, download the `.pem`, and put its contents in `GITHUB_APP_PRIVATE_KEY`. If you inline it into `.env.local`, replace real newlines with `\n` and quote the value.
3. Click **Install App** and install it onto the repo(s) you want Wallie to see. Wallie's in-app flow (`GET /api/github/install` -> GitHub -> `GET /api/github/callback`) stores the installation against your workspace.

### 7. Linear API key

Linear is pull-only -- no webhook, no OAuth.

1. Generate a personal API key at <https://linear.app/settings/api>.
2. After you create a workspace in Wallie (step 9), paste the key into **Settings -> Integrations -> Linear**. The Verify button calls `POST /api/linear/test-connection`.

### 8. Start the dev server

```bash
pnpm dev
```

The app runs at `http://localhost:3000` and is reachable at your tunnel origin. Keep it running.

### 9. Start the worker

In a second terminal:

```bash
pnpm worker
```

The worker heartbeats into `workers`, polls `agent_jobs`, does an atomic CAS claim, runs the phase handler (calls Claude for the product phase), and posts results to Slack. Without it, jobs stay queued and nothing progresses past `agent_generating`.

### 10. First run

1. Open `http://localhost:3000`, sign up / log in via Supabase Auth.
2. Complete onboarding (pick a workspace slug).
3. **Settings -> Integrations**:
   - **Anthropic**: paste your `ANTHROPIC_API_KEY` (stored encrypted in `workspace_secrets`).
   - **Linear**: paste your Linear API key, verify.
   - **Slack**: click Connect -> OAuth out and back -> `slack_installations` row created.
   - **GitHub**: click Install -> GitHub App install -> back -> `github_installations` row created. Pick the repo(s) to track.
4. In Slack, in a channel where the bot is invited:
   ```
   @Wallie https://linear.app/<team>/issue/TEAM-123
   ```
5. Expect, within ~30s: a session row appears in `/w/<slug>/sessions`, the worker log shows a job claim + Claude call, the Slack thread receives the spec with Approve / Request Changes buttons.

### Tunnel: what must be publicly reachable

| Integration | Endpoint                                                 | Why                                   |
| ----------- | -------------------------------------------------------- | ------------------------------------- |
| Slack       | `POST /api/slack/events`, `POST /api/slack/interactions` | Slack posts events and button clicks  |
| Slack OAuth | `GET  /api/slack/callback`                               | Browser redirect from slack.com       |
| GitHub      | `POST /api/github/webhooks`                              | App install and PR event deliveries   |
| GitHub App  | `GET  /api/github/callback`                              | Browser redirect from github.com      |
| Linear      | -- (pull only)                                           | Wallie calls Linear, never vice versa |
| Supabase    | -- (local Docker)                                        | App and worker connect to localhost   |

### Troubleshooting

- **Slack "Your URL didn't respond with the value of the challenge parameter"** -- the dev server isn't running, the tunnel is down, or `NEXT_PUBLIC_APP_URL` doesn't match the tunnel URL. Restart, re-verify.
- **`invalid signature` on Slack events** -- `SLACK_SIGNING_SECRET` doesn't match the app's current signing secret. Rotate and update.
- **GitHub webhook 401** -- `GITHUB_WEBHOOK_SECRET` in `.env.local` doesn't match the value in the GitHub App. GitHub's Advanced -> Recent Deliveries panel shows the exact error.
- **Session stays in `agent_generating` forever** -- worker isn't running, Anthropic key is missing or invalid on the workspace, or the worker can't reach `http://localhost:3000`. Check `pnpm worker` logs.
- **RLS errors during local dev** -- confirm `SUPABASE_SECRET_KEY` is the service role key (not the anon key) and that `supabase start` finished applying migrations.

## Scripts

| Command             | Description                                    |
| ------------------- | ---------------------------------------------- |
| `pnpm dev`          | Start Next.js dev server                       |
| `pnpm build`        | Production build                               |
| `pnpm start`        | Start production server                        |
| `pnpm worker`       | Start the background worker daemon             |
| `pnpm test`         | Run tests (Vitest)                             |
| `pnpm test:watch`   | Run tests in watch mode                        |
| `pnpm lint`         | Lint with ESLint (zero warnings)               |
| `pnpm lint:fix`     | Auto-fix lint issues                           |
| `pnpm format`       | Format with Prettier                           |
| `pnpm format:check` | Check formatting                               |
| `pnpm typecheck`    | TypeScript type check                          |
| `pnpm check`        | Run all checks (format, lint, typecheck, test) |

## Architecture Notes

### Multi-tenancy

Every data row is scoped to a `workspace_id`. Supabase RLS policies enforce isolation. A database trigger (`enforce_session_refs`) validates FK consistency across workspace boundaries.

### Concurrency

Phase approvals use compare-and-swap semantics: the `approve_session_phase` RPC only succeeds if the session is in `awaiting_review` status at the expected artifact version. This prevents double-approval from stale Slack buttons.

### Deduplication

Sessions are deduplicated on `(workspace_id, linear_issue_id)` -- one session per Linear issue. Agent jobs use a `dedupe_key` to prevent duplicate processing.

### Security

- LLM inputs are sanitized via `sanitizeUntrusted()` to prevent prompt injection
- User content is wrapped in XML tags with explicit data boundary markers
- Integration credentials are encrypted at rest with AES-256
- Slack and GitHub webhooks are signature-verified

### Realtime

The session list and detail pages subscribe to Supabase Realtime channels on the `sessions` table, so phase transitions and status changes appear instantly in the UI.

## Integrations

### Slack

The Slack bot listens for `app_mention` events. When mentioned with a Linear issue URL, it creates a session, generates a product spec, and posts it to the thread with approve/reject buttons. Rejection opens a feedback modal; the spec is regenerated incorporating the feedback.

Webhook endpoints:

- Events: `/api/slack/events`
- Interactions: `/api/slack/interactions`

### GitHub

A GitHub App syncs repository metadata and tracks pull request state for sessions. Installations and repositories are stored per workspace.

Webhook endpoint: `/api/github/webhooks`

### Linear

Linear issues provide the source context for product spec generation. The API key is stored as an encrypted workspace secret and verified via `/api/linear/test-connection`.

## License

Private.
