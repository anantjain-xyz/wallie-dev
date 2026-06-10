# Repository Guidelines

## Purpose

This repo is the implementation target for Wallie at `wallie.dev`.

## Architecture Direction

Build for:

- Next.js App Router on Vercel
- Supabase Auth
- Supabase Postgres + RLS
- Supabase Realtime
- Supabase Storage

Use Vercel route handlers for privileged and third-party integrations.

## Commands

```bash
pnpm check                      # format:check + lint + typecheck + test — the pre-PR gate
pnpm test path/to/file.test.ts  # run a single test file
pnpm test -t "name of test"     # run tests matching a name
pnpm test:watch                 # Vitest watch mode
pnpm lint                       # ESLint, zero warnings allowed
pnpm typecheck                  # tsc --noEmit
pnpm dev                        # Next.js dev server (localhost:3000)
pnpm worker                     # background worker daemon (required for jobs to progress)
supabase start                  # local Postgres/Auth/Realtime/Storage via Docker
supabase db reset               # re-apply migrations + seed
```

CI runs `format:check`, `lint`, and `test` but **not** `typecheck` — run `pnpm check` locally to catch TypeScript errors before review.

Running the app end-to-end needs two terminals: `pnpm dev` and `pnpm worker`. Without the worker, sessions stay stuck in `agent_generating`.

## Architecture

Wallie turns Linear issues into **sessions** that move through a user-configurable **pipeline** of **stages**, each producing a versioned markdown **artifact** that a human approves or rejects from the dashboard. See the README for the full walkthrough; the essentials:

**Stages are data, not code.** Each stage is a row in `pipeline_stages` (slug, position, prompt template, approver list). Nothing in code distinguishes one stage from another — a single generic runner drives all of them. New workspaces are seeded with `product → design → engineering → review → land`, but workspaces can edit, add, remove, or reorder stages. Sessions are pinned to a pipeline at create time, so pipeline edits don't reshape historical sessions.

**The core loop:** a job is enqueued (deduped per active stage) → the worker polls `agent_jobs` and claims one with an atomic compare-and-swap on `phase_status` → `processPipelineJob()` renders the stage's prompt template against session context, spins up a Vercel Sandbox cloned from the workspace's GitHub repo, runs the configured agent CLI (Codex or Claude Code) inside it, and writes the output as a versioned artifact → session flips to `awaiting_review` → approval calls the `approve_session_stage` RPC (advances to the next stage by position, enqueues the next job); rejection saves feedback on the artifact and re-runs the same stage with `{{attempt.feedback}}` injected.

**Four layers:** the Supabase schema defines the nouns; `src/lib/pipeline/` is the verb engine; `src/app/api/` is the edge (ingest + ack); `src/worker/` drains the queue. Everything else is UI glue or integration plumbing.

**Hub files** (read these first):

- `src/lib/pipeline/processor.ts` — generic stage runner + approve/reject handlers
- `src/lib/pipeline/stages.ts` — pipeline/stage loaders, prior-artifact map for prompts
- `src/app/api/sessions/[sessionId]/phase-action/route.ts` — in-app approve/reject endpoint
- `src/lib/wallie/service.ts` — job enqueue, dedupe keys, run lifecycle
- `src/worker/index.ts` — daemon entry (heartbeat, poll loop, stall detector, reconciler, sandbox reaper)

## Key Conventions

- **Multi-tenancy via RLS.** Every row is scoped to `workspace_id`; Supabase RLS enforces isolation. Three client flavors in `src/lib/supabase/`: `admin.ts` (service role, bypasses RLS — worker/privileged routes only), `server.ts` (RLS, user session), `browser.ts` (anon). `database.types.ts` is auto-generated — don't hand-edit.
- **Migrations are forward-only.** `20260422000000_init.sql` is the consolidated baseline (tables, RLS, triggers, RPCs); add new migrations rather than editing it. Migration timestamps must be unique.
- **Env vars are Zod-validated** in `src/env/` (`client.ts`, `server.ts`, `deploy.ts`). Add new env vars to the schema there and to `.env.example`.
- **Workspace secrets live in the DB, not env.** Linear keys, agent credentials, and the Vercel Sandbox connection are entered in Settings and stored AES-256-GCM encrypted (`src/lib/secrets/crypto.ts`).
- **Tests are colocated** as `src/**/*.test.ts` (Vitest, node environment, globals enabled). `@/` aliases `src/`; the `server-only` package is stubbed via `test/server-only-stub.ts`. Set `WALLIE_SANDBOX_IMPL=fake` to use the in-process sandbox fake (`src/lib/sandbox/`).
- **Prompt-injection caveat:** `sanitizeUntrusted()` in `src/lib/pipeline/prompt-safety.ts` exists but is **not wired into the prompt path** — apply it yourself when extending prompts with untrusted input (e.g. Linear text).
- **Concurrency is CAS-based.** Job claims and stage approvals only succeed from the expected status/artifact version — preserve this when touching `phase_status` transitions or the `approve_session_stage` RPC.

## Coordination Rules

- You are not alone in the codebase.
- Stay within your ownership boundary.
- Do not overwrite unrelated work.
- Coordinate via PR descriptions when making cross-cutting changes.

## Working Norms

- Prefer small, reviewable commits.
- Prefer direct and typed data contracts.
- Keep DB naming stable once feature agents begin.
- Treat schema, auth, GitHub, secrets, and Wallie orchestration as separate domains.

## Glossary

- **Session** — top-level entity representing one end-to-end Wallie workflow. Replaces the legacy "issue" framing.
- **Pipeline** — an ordered, workspace-owned list of stages. Sessions are pinned to a pipeline at create time.
- **Stage** — a row in `pipeline_stages` (slug, position, name, prompt template, approver list). User-configurable; new workspaces are seeded with `product → design → engineering → review → land`. The legacy term "phase" survives in column names like `phase_status`.
- **Artifact** — versioned markdown output per stage. Stored in `session_artifacts`, keyed on `(session_id, stage_slug, version)`.
- **Run** — one agent execution within a stage. A rejected artifact triggers a new run of the same stage.

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available skills: `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/retro`, `/investigate`, `/document-release`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`.
