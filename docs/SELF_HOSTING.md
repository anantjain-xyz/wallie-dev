# Self-Hosting Wallie

This guide walks through deploying your **own production Wallie instance** on the internet. To use the hosted instance at [**wallie.dev**](https://wallie.dev), you do not need to deploy these services. You still connect a GitHub repository, a sandbox provider, and your agent credentials before running a task. Linear is optional.

If you only want to run Wallie **locally for development**, follow the [README → Local Setup](../README.md#local-setup-end-to-end) instead. This document assumes you want a real, always-on deployment.

## Architecture: what you need to host

Wallie has two long-lived processes plus managed backing services:

| Component                                | What it is                                                                            | Where it runs                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Web app**                              | Next.js App Router (UI + API route handlers)                                          | Any Next.js host. Vercel is the smoothest path. Stateless.                                                  |
| **Worker**                               | `pnpm worker` — a long-running daemon that drains the job queue and runs agent stages | A host that supports **always-on processes** (Railway, Fly, Render, a VM, etc.). **Not** Vercel serverless. |
| **Database / Auth / Realtime / Storage** | Supabase                                                                              | Supabase Cloud (or your own Supabase).                                                                      |
| **Sandboxes**                            | Ephemeral VMs that run the agent per stage                                            | Vercel Sandbox, E2B, or Daytona Cloud/approved self-hosted Daytona.                                         |
| **Integrations**                         | GitHub App, Linear, model provider (Codex / Claude Code / Cursor / OpenCode)          | External; configured per-workspace in the app UI.                                                           |

> **Why the worker can't be serverless:** it heartbeats, polls `agent_jobs`, claims work via an atomic compare-and-swap, runs stages that can take minutes, and reaps orphaned sandboxes. It must run continuously. Deploy the web app and the worker as **two separate services from the same repo**, sharing the same environment variables.

## Prerequisites

- A [Supabase](https://supabase.com) account and the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started).
- A host for the web app (e.g. [Vercel](https://vercel.com)).
- A host for the worker (e.g. [Railway](https://railway.com) — a `railway.json` is already included).
- A GitHub account/org where you can create a **GitHub App**.
- A Vercel, E2B, or Daytona account for Sandbox execution.
- Agent provider access (Codex, Claude Code, Cursor, and/or OpenCode) — entered per-workspace later, not at deploy time.
- A domain (recommended) for a stable origin.

## 1. Create the Supabase project

1. Create a new project in the Supabase dashboard. Note the **project ref**.
2. Link the CLI and push the schema from this repo:

   ```bash
   supabase link --project-ref <your-project-ref>
   supabase db push          # applies everything in supabase/migrations/
   ```

   `supabase db push` runs the baseline migration plus all forward migrations against your hosted database. Do **not** load `supabase/seed.sql` — that's local development demo data.

3. **Auth:** in **Authentication → URL Configuration**, set the **Site URL** to your production origin (e.g. `https://wallie.example.com`) and add the email/magic-link/invite callback to **Redirect URLs**. The app's email sign-in and workspace invites redirect to `/auth/confirm`, so allow-list the exact `https://wallie.example.com/auth/confirm` (or a wildcard like `https://wallie.example.com/**`) — Supabase ignores `redirectTo` URLs that aren't allow-listed, which would silently break login and invite acceptance. Enable email sign-in. If you want the branded emails, copy the templates from `supabase/templates/auth/` into **Authentication → Email Templates**.
4. From **Project Settings → API**, collect:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - Publishable / anon key → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - Secret / service-role key → `SUPABASE_SECRET_KEY` (server-side only — never expose to the browser)

## 2. Generate the encryption key

Wallie encrypts workspace secrets and per-user agent credentials at rest with AES-256-GCM. Generate the master key once and store it in your host's secret manager:

```bash
openssl rand -hex 32
```

Use the output as `WALLIE_ENCRYPTION_KEY`. **Rotating this later requires re-encrypting all existing encrypted values**, so treat it as durable. See [SECURITY.md](../SECURITY.md).

## 3. Deploy the web app (Vercel)

1. Import the repository into Vercel.
2. Set the environment variables (mirror `.env.example`):

   | Variable                                                             | Value                                                      |
   | -------------------------------------------------------------------- | ---------------------------------------------------------- |
   | `NEXT_PUBLIC_APP_URL`                                                | Your production origin, e.g. `https://wallie.example.com`  |
   | `NEXT_PUBLIC_SUPABASE_URL`                                           | From step 1                                                |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`                               | From step 1                                                |
   | `SUPABASE_SECRET_KEY`                                                | From step 1                                                |
   | `WALLIE_ENCRYPTION_KEY`                                              | From step 2                                                |
   | `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET` | From step 5                                                |
   | `WALLIE_ENABLED_SANDBOX_PROVIDERS`                                   | Start with `vercel`; add `e2b`, then `daytona` to roll out |
   | `WALLIE_DAYTONA_API_URL_ALLOWLIST`                                   | Optional exact HTTPS self-hosted Daytona API URLs          |

3. Deploy, then point your domain at the deployment so `NEXT_PUBLIC_APP_URL` matches the real origin.

> **Session sandbox credentials:** hosting the web app on Vercel does not replace the per-workspace sandbox connection. Connect and test the selected provider in Settings (step 6). The `VERCEL_*` environment credentials described in step 4 are for operator/helper sandboxes; they do not make a workspace ready to run sessions.

## 4. Deploy the worker

The worker runs `pnpm worker` continuously and needs the **same environment variables as the web app** (it talks to Supabase and reaches the web origin). A `railway.json` is included that sets `startCommand: pnpm worker` with an always-restart policy.

**Railway (uses the included config):**

1. Create a new Railway service from the same repo.
2. Add the same env vars as the web app.
3. If you want the worker to create non-session/operator sandboxes off Vercel, give it operator credentials:
   - `VERCEL_TOKEN` — a team-scoped token from <https://vercel.com/account/tokens>
   - `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`
4. Deploy. The worker registers a heartbeat and starts draining `agent_jobs`.

> **Session sandboxes need a per-workspace connection, not provider API keys in env.** At job start the worker loads the workspace's selected Vercel, E2B, or Daytona connection and fails closed if it is missing, invalid, or has a stale capability check. `VERCEL_*` only covers legacy operator/helper sandboxes. Each workspace connects and tests its provider in **Settings** before sessions can run.

**Any other always-on host (Fly, Render, a VM, Docker):** run the same repo with `pnpm install && pnpm worker` and the same environment. Keep it running (restart-on-exit). Without the worker, sessions get stuck at `in_progress` and never progress.

## 5. Create the production GitHub App

This mirrors the [README → Create a GitHub App](../README.md#5-create-a-github-app) steps, but with production URLs. At <https://github.com/settings/apps> → **New GitHub App**:

- **Homepage URL:** your origin (e.g. `https://wallie.example.com`)
- **Callback URL:** `https://wallie.example.com/api/github/callback` (keep OAuth-during-install **off**)
- **Setup URL (post installation):** `https://wallie.example.com/api/github/callback` — **required.** With OAuth-during-install off, GitHub sends the user here after install, with the `installation_id` and signed `state`, so Wallie can record the installation. Without it, an install can finish on GitHub and leave the workspace disconnected.
- **Webhook URL:** `https://wallie.example.com/api/github/webhooks`
- **Webhook secret:** a strong random string → also set as `GITHUB_WEBHOOK_SECRET`
- **Repository permissions:**
  - **Contents** → **Read and write** — repo onboarding creates branches, trees, and commits (`src/lib/repo-onboarding/server.ts`).
  - **Pull requests** → **Read and write** — onboarding opens a setup PR and session completion opens PRs (`src/lib/pipeline/pull-request.ts`); webhook ingestion also reads PR state.
  - **Metadata** → **Read-only** (mandatory, set automatically).
- **Subscribe to events:** `Pull request`
- **Where can this app be installed?** "Any account" if you want others to install it; "Only this account" for a private deployment.

After creating it: copy the **App ID** → `GITHUB_APP_ID`, generate a private key and put its PEM contents in `GITHUB_APP_PRIVATE_KEY` (escape newlines as `\n` if you inline it), and redeploy both services so the new env vars take effect.

## 6. Per-workspace setup (in the app, not env vars)

These are entered through the app's **Settings** UI and stored encrypted in your database — they are intentionally **not** environment variables:

- **Agent provider & model** — Codex, Claude Code, Cursor, or OpenCode, plus the provider credential (ChatGPT sign-in / Codex token / OpenAI key, an Anthropic API key, Cursor browser sign-in, or an OpenCode Zen / per-provider API key). Cursor sign-in is processed by the Wallie worker.
- **Linear API key (optional)** — add one if you want to attach Linear issue context. You can start a session with a prompt alone.
- **GitHub installation** — install the App onto the repos a workspace should see.
- **Sandbox provider** — connect Vercel, E2B, and/or Daytona, choose one active provider, then run its repository capability check. Connections are retained when switching.

See [README → Configure agent provider](../README.md#configure-agent-provider) and the integration sections for details.

## 7. Verify the first task through completion

Use a repository and a small task you are comfortable running through your
configured providers. This rehearsal uses sandbox and model access and can
create a branch and pull request in that repository.

1. Open your origin in a fresh browser session. Request a sign-in email and
   follow its link. Confirm it returns to your origin and the expected account.
2. Create a workspace and complete onboarding: connect GitHub, select and
   prepare a repository, and connect execution access. A workspace name alone
   does not complete setup. Keep the default Plan → Build pipeline for the
   first rehearsal; Linear is optional.
3. Run the selected sandbox provider's repository capability check. Resolve
   any blockers before creating the task. Confirm the worker has started and
   is publishing fresh heartbeats; see [Worker operations](WORKER-OPERATIONS.md#heartbeats-and-activity).
4. Describe a bounded change with a clear acceptance condition, such as fixing
   a specific README typo. Start the session once. In Runs, confirm it moves
   from queued into execution and produces an artifact ready for review.
5. Request one concrete change to the first artifact. Confirm the request
   succeeds, a new run appears, and a new artifact version becomes
   reviewable. Inspect the revised output before approving it.
6. Approve the stage and confirm the next configured stage starts. Continue
   through every selected stage and approve the final output. Confirm the
   session shows **Pipeline complete**.
7. Open the resulting PR when one was produced and verify its repository,
   changes, and checks on GitHub. If there is no PR, inspect the final artifact
   and confirm that matches the task's expected output. Pipeline completion
   does not mean a PR was merged or deployed.
8. Reload the completed session and open its URL in a second signed-in browser
   session. Confirm the output, artifact history, and completion state remain
   available.

Record the deployed commit, provider/model, session URL, review/revision outcome,
and any resulting PR URL. Record queue wait and execution duration separately
from Runs and worker logs; a fast-loading page does not prove fast execution.
Do not use seeded completed sessions as evidence that your deployment ran a task.

Before inviting a wider team, send a test invitation to an account you control
and follow it from a signed-out browser. Confirm it reaches the intended
workspace with the intended role. The local browser suite verifies selected
auth and UI behavior, but does not prove production email delivery or provider
execution; see [Verification](VERIFICATION.md).

If a session remains queued, inspect the worker logs and heartbeat freshness,
then workspace readiness and available capacity. If it has started but stops
making progress, inspect the latest run error/activity and provider access.
There is no public worker-health endpoint; a responsive web page alone does
not establish that the worker is healthy.

## Upgrading

Pull the latest code, redeploy both services, and apply any new migrations:

```bash
git pull
supabase db push   # applies any new migrations in supabase/migrations/
```

Roll out the web app and worker together so they run the same schema and code.

## Operational notes

- **Keep web app and worker on the same env + schema.** Drift causes subtle failures.
- **Back up your database** and store `WALLIE_ENCRYPTION_KEY` durably — losing it makes encrypted secrets unrecoverable.
- **Secrets hygiene:** never commit `.env.local`; keep the service-role key server-side only. See [SECURITY.md](../SECURITY.md).
- **Scaling the worker:** the queue uses atomic compare-and-swap claims, so you can run more than one worker if you need more throughput.
