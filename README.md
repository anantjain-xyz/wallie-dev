# Wallie

AI-powered product development automation. Wallie turns Linear issues into structured product specs, coordinates multi-phase development pipelines, and integrates with Slack and GitHub to keep your team in the loop.

## How It Works

Wallie organizes work into **sessions** that progress through a six-phase pipeline:

1. **Product** -- Claude AI generates a structured product spec from a Linear issue
2. **Design** -- design artifact generation (manual stub, agent planned)
3. **Engineering** -- implementation (manual stub, agent planned)
4. **Review** -- code review (manual stub, agent planned)
5. **Land** -- merge and deploy (manual stub, agent planned)
6. **Monitor** -- post-deploy health check (manual stub, agent planned)

Each phase produces a versioned artifact. Humans approve or reject artifacts via Slack buttons; rejected specs can be regenerated with feedback. After three rejections, the session escalates to an engineering manager.

### Entry Points

- **Slack**: mention the bot with a Linear issue URL (`@wallie https://linear.app/team/issue/TEAM-123`) to create a session and kick off the product phase automatically.
- **In-app**: click "New Session" from the sessions list to create one manually.

### Pipeline Flow

```
Slack mention
  -> session created (phase: product, status: agent_generating)
  -> agent job enqueued automatically
  -> POST /api/agent-jobs/process picks up the job
  -> Claude generates product spec (with pre-screen quality gate)
  -> spec posted to Slack with [Approve] / [Reject] buttons
  -> approval advances to next phase; rejection re-generates with feedback
  -> repeat until monitor phase completes -> session archived

In-app create
  -> session created (phase: product)
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
  |-- Secrets (encrypted ANTHROPIC_API_KEY, LINEAR_API_KEY)
  `-- Sessions <- the unit of work
      |-- phase: product -> design -> engineering
      |          -> review -> land -> monitor
      |-- phase_status: agent_generating | awaiting_review
      |                 | approved | rejected | escalated
      |-- Artifacts (versioned JSON per phase)
      |-- Jobs (work queue entries)
      `-- Runs (one agent execution; tokens, cost, msgs)
```

**Session** = one end-to-end workflow. **Artifact** = versioned JSON per phase. **Run** = one agent execution. A rejection produces a new Run.

### Critical Flow (Slack mention -> shipped)

```
Slack @wallie + Linear URL
      |
      v
[POST /api/slack/events]  -- verify HMAC, ack fast
      | (after() -- async)
      v
Create Session + Enqueue Job  (dedup on workspace+linear_issue)
      |
      v
Worker polls --> [POST /api/agent-jobs/process]
      |             |- CAS claim (atomic phase_status update)
      |             |- Route by phase -> runProductPhase()
      |             |- Load secrets, sanitize Linear text
      |             |- Call Claude -> ProductSpec JSON
      |             |- Pre-screen (>=3 acceptance criteria)
      |             |- Save artifact, status=awaiting_review
      |             `- Post to Slack thread [Approve][Reject]
      v
[POST /api/slack/interactions]
      |- Approve -> RPC advances phase, enqueues next job
      `- Reject  -> modal -> feedback -> new run
                    (3 rejects -> escalate to EM)
```

### Five Hub Files

If you read only five files to understand Wallie, read these:

| #   | File                                                                   | Role                                                                                 |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | [src/lib/pipeline/processor.ts](src/lib/pipeline/processor.ts)         | Phase router. Atomic CAS claim, dispatches to six phase handlers, posts Slack.       |
| 2   | [src/lib/pipeline/product-agent.ts](src/lib/pipeline/product-agent.ts) | Calls Claude Sonnet 4. Sanitizes Linear text, builds prompt, parses structured JSON. |
| 3   | [src/app/api/slack/events/route.ts](src/app/api/slack/events/route.ts) | Slack mention entry. HMAC verify, extract Linear URL, create session.                |
| 4   | [src/lib/wallie/service.ts](src/lib/wallie/service.ts)                 | Job enqueue + run tracking. Dedup keys, token/cost logging.                          |
| 5   | [src/worker/index.ts](src/worker/index.ts)                             | Background daemon. Heartbeat, poll loop, stall detector, Linear reconciler.          |

### Walkthrough by Domain

#### Database -- one file tells the whole story

- [supabase/migrations/20260422000000_init.sql](supabase/migrations/20260422000000_init.sql) -- 1664 lines. Every table, RLS policy, trigger, and RPC (`approve_session_phase` is the star). Tables: `workspaces`, `workspace_members`, `sessions`, `session_artifacts`, `agent_jobs`, `agent_runs`, `agent_run_messages`, `workspace_secrets`, `github_installations`, `slack_installations`, `issues`, `session_pull_requests`.
- [src/lib/supabase/database.types.ts](src/lib/supabase/database.types.ts) -- auto-generated types.

#### Pipeline (`src/lib/pipeline/`) -- the brain

- [processor.ts](src/lib/pipeline/processor.ts) -- phase router hub.
- [product-agent.ts](src/lib/pipeline/product-agent.ts) -- Claude call for product spec.
- [state-machine.ts](src/lib/pipeline/state-machine.ts) -- phase transitions + escalation (3-rejection threshold).
- [pre-screen.ts](src/lib/pipeline/pre-screen.ts) -- quality gate before human review.
- [prompt-safety.ts](src/lib/pipeline/prompt-safety.ts) -- sanitizes untrusted Linear text (prompt injection defense).
- [slack-format.ts](src/lib/pipeline/slack-format.ts) -- artifact to Slack Block Kit.
- `design-phase.ts`, `engineering-phase.ts`, `review-phase.ts`, `land-phase.ts`, `monitor-phase.ts` -- phases 1-5 (mostly stubs; product phase is the only complete one).
- [types.ts](src/lib/pipeline/types.ts) -- `ProductSpec` interface.

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
    pipeline/                 # Phase router, product agent, pre-screen, state machine
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

## Setup

### Prerequisites

- Node.js >= 22.13
- pnpm >= 10
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
- Docker (for local Supabase)

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Fill in the required values:

| Variable                               | Required | Description                                            |
| -------------------------------------- | -------- | ------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`             | Yes      | Supabase project URL                                   |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes      | Supabase anon/publishable key                          |
| `NEXT_PUBLIC_APP_URL`                  | Yes      | App origin (`http://localhost:3000` for local dev)     |
| `SUPABASE_SECRET_KEY`                  | Yes      | Supabase service role key                              |
| `WALLIE_ENCRYPTION_KEY`                | Yes      | 32+ character secret for AES-256 credential encryption |
| `WALLIE_PROCESS_TOKEN`                 | No       | Bearer token for external job processor calls          |
| `GITHUB_APP_ID`                        | No       | GitHub App ID (for GitHub integration)                 |
| `GITHUB_APP_PRIVATE_KEY`               | No       | GitHub App private key                                 |
| `GITHUB_WEBHOOK_SECRET`                | No       | GitHub webhook signature secret                        |
| `SLACK_CLIENT_ID`                      | No       | Slack app client ID                                    |
| `SLACK_CLIENT_SECRET`                  | No       | Slack app client secret                                |
| `SLACK_SIGNING_SECRET`                 | No       | Slack request signing secret                           |

Integration-specific variables (GitHub, Slack) are optional until those integrations are enabled. Workspace-level secrets like `ANTHROPIC_API_KEY` and `LINEAR_API_KEY` are stored encrypted in the database via the settings UI.

### 3. Start local Supabase

```bash
supabase start
```

This starts a local Postgres, Auth, Realtime, and Storage stack. Migrations are applied automatically.

### 4. Start the dev server

```bash
pnpm dev
```

The app runs at `http://localhost:3000`.

### 5. Start the worker (separate terminal)

```bash
pnpm worker
```

The worker polls for queued jobs, claims them atomically, and executes phase handlers.

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
