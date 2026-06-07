# Self-Hosting Wallie

This guide walks through deploying your **own production Wallie instance** on the internet. If you just want to use Wallie, the hosted instance at [**wallie.dev**](https://wallie.dev) is free and maintained — no setup required.

If you only want to run Wallie **locally for development**, follow the [README → Local Setup](../README.md#local-setup-end-to-end) instead. This document assumes you want a real, always-on deployment.

## Architecture: what you need to host

Wallie has two long-lived processes plus managed backing services:

| Component                                | What it is                                                                            | Where it runs                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Web app**                              | Next.js App Router (UI + API route handlers)                                          | Any Next.js host. Vercel is the smoothest path. Stateless.                                                  |
| **Worker**                               | `pnpm worker` — a long-running daemon that drains the job queue and runs agent stages | A host that supports **always-on processes** (Railway, Fly, Render, a VM, etc.). **Not** Vercel serverless. |
| **Database / Auth / Realtime / Storage** | Supabase                                                                              | Supabase Cloud (or your own Supabase).                                                                      |
| **Sandboxes**                            | Ephemeral VMs that run the agent per stage                                            | Vercel Sandbox.                                                                                             |
| **Integrations**                         | GitHub App, Linear, model provider (Codex / Claude Code)                              | External; configured per-workspace in the app UI.                                                           |

> **Why the worker can't be serverless:** it heartbeats, polls `agent_jobs`, claims work via an atomic compare-and-swap, runs stages that can take minutes, and reaps orphaned sandboxes. It must run continuously. Deploy the web app and the worker as **two separate services from the same repo**, sharing the same environment variables.

## Prerequisites

- A [Supabase](https://supabase.com) account and the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started).
- A host for the web app (e.g. [Vercel](https://vercel.com)).
- A host for the worker (e.g. [Railway](https://railway.com) — a `railway.json` is already included).
- A GitHub account/org where you can create a **GitHub App**.
- A [Vercel](https://vercel.com) account for Sandbox execution.
- Agent provider access (Codex and/or Claude Code) — entered per-workspace later, not at deploy time.
- A domain (recommended) for a stable origin.

## 1. Create the Supabase project

1. Create a new project in the Supabase dashboard. Note the **project ref**.
2. Link the CLI and push the schema from this repo:

   ```bash
   supabase link --project-ref <your-project-ref>
   supabase db push          # applies everything in supabase/migrations/
   ```

   `supabase db push` runs the baseline migration plus all forward migrations against your hosted database. Do **not** load `supabase/seed.sql` — that's local development demo data.

3. **Auth:** in **Authentication → URL Configuration**, set the **Site URL** and **Redirect URLs** to your production origin (e.g. `https://wallie.example.com`, plus `https://wallie.example.com/auth/callback`). Enable email sign-in. If you want the branded emails, copy the templates from `supabase/templates/auth/` into **Authentication → Email Templates**.
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

   | Variable                                                             | Value                                                     |
   | -------------------------------------------------------------------- | --------------------------------------------------------- |
   | `NEXT_PUBLIC_APP_URL`                                                | Your production origin, e.g. `https://wallie.example.com` |
   | `NEXT_PUBLIC_SUPABASE_URL`                                           | From step 1                                               |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`                               | From step 1                                               |
   | `SUPABASE_SECRET_KEY`                                                | From step 1                                               |
   | `WALLIE_ENCRYPTION_KEY`                                              | From step 2                                               |
   | `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET` | From step 5                                               |

3. Deploy, then point your domain at the deployment so `NEXT_PUBLIC_APP_URL` matches the real origin.

> **Vercel Sandbox credentials:** when the web app and worker run **on Vercel**, Sandbox execution uses Vercel OIDC automatically — you do **not** need `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`. If your worker runs **off** Vercel (e.g. Railway), see step 4. Per-workspace Sandbox connections are also entered in the app's Settings UI.

## 4. Deploy the worker

The worker runs `pnpm worker` continuously and needs the **same environment variables as the web app** (it talks to Supabase and reaches the web origin). A `railway.json` is included that sets `startCommand: pnpm worker` with an always-restart policy.

**Railway (uses the included config):**

1. Create a new Railway service from the same repo.
2. Add the same env vars as the web app.
3. Because the worker is **not** on Vercel, give it Sandbox credentials so it can create sandboxes:
   - `VERCEL_TOKEN` — a team-scoped token from <https://vercel.com/account/tokens>
   - `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`
   - (Or use the per-workspace Vercel connection saved in Settings.)
4. Deploy. The worker registers a heartbeat and starts draining `agent_jobs`.

**Any other always-on host (Fly, Render, a VM, Docker):** run the same repo with `pnpm install && pnpm worker` and the same environment. Keep it running (restart-on-exit). Without the worker, sessions get stuck at `agent_generating` and never progress.

## 5. Create the production GitHub App

This mirrors the [README → Create a GitHub App](../README.md#5-create-a-github-app) steps, but with production URLs. At <https://github.com/settings/apps> → **New GitHub App**:

- **Homepage URL:** your origin (e.g. `https://wallie.example.com`)
- **Callback URL:** `https://wallie.example.com/api/github/callback` (keep OAuth-during-install **off**)
- **Webhook URL:** `https://wallie.example.com/api/github/webhooks`
- **Webhook secret:** a strong random string → also set as `GITHUB_WEBHOOK_SECRET`
- **Repository permissions:** Pull requests → **Read-only** (add more only as later phases need them)
- **Subscribe to events:** `Pull request`
- **Where can this app be installed?** "Any account" if you want others to install it; "Only this account" for a private deployment.

After creating it: copy the **App ID** → `GITHUB_APP_ID`, generate a private key and put its PEM contents in `GITHUB_APP_PRIVATE_KEY` (escape newlines as `\n` if you inline it), and redeploy both services so the new env vars take effect.

## 6. Per-workspace setup (in the app, not env vars)

These are entered through the app's **Settings** UI and stored encrypted in your database — they are intentionally **not** environment variables:

- **Agent provider & model** — Codex or Claude Code, plus the provider credential (ChatGPT sign-in / Codex token / OpenAI key, or an Anthropic API key).
- **Linear API key** — for pulling issue context.
- **GitHub installation** — install the App onto the repos a workspace should see.
- **Vercel Sandbox connection** — the workspace's Sandbox account.

See [README → Configure agent provider](../README.md#configure-agent-provider) and the integration sections for details.

## 7. Smoke test

1. Open your origin and sign up via Supabase Auth.
2. Complete onboarding (create a workspace).
3. In **Settings → Integrations**, connect an agent provider, your Linear key, install the GitHub App, and pick a repo.
4. Create a session.
5. Confirm the **worker logs** show it claiming the job, and that an artifact appears in the session detail view for review.

If a session stays at `agent_generating`: the worker isn't running, agent credentials are missing/invalid, or the worker can't reach your web origin or Supabase. Check the worker logs first.

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
