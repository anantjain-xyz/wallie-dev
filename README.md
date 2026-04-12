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
Slack mention / in-app create
  -> session created (phase: product, status: agent_generating)
  -> agent job enqueued
  -> POST /api/agent-jobs/process picks up the job
  -> Claude generates product spec (with pre-screen quality gate)
  -> spec posted to Slack with [Approve] / [Reject] buttons
  -> approval advances to next phase; rejection re-generates with feedback
  -> repeat until monitor phase completes -> session archived
```

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

## Scripts

| Command             | Description                                    |
| ------------------- | ---------------------------------------------- |
| `pnpm dev`          | Start Next.js dev server                       |
| `pnpm build`        | Production build                               |
| `pnpm start`        | Start production server                        |
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
