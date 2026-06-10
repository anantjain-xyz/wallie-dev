# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

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

## Key conventions

- **Multi-tenancy via RLS.** Every row is scoped to `workspace_id`; Supabase RLS enforces isolation. Three client flavors in `src/lib/supabase/`: `admin.ts` (service role, bypasses RLS — worker/privileged routes only), `server.ts` (RLS, user session), `browser.ts` (anon). `database.types.ts` is auto-generated — don't hand-edit.
- **Migrations are forward-only.** `20260422000000_init.sql` is the consolidated baseline (tables, RLS, triggers, RPCs); add new migrations rather than editing it. Migration timestamps must be unique.
- **Env vars are Zod-validated** in `src/env/` (`client.ts`, `server.ts`, `deploy.ts`). Add new env vars to the schema there and to `.env.example`.
- **Workspace secrets live in the DB, not env.** Linear keys, agent credentials, and the Vercel Sandbox connection are entered in Settings and stored AES-256-GCM encrypted (`src/lib/secrets/crypto.ts`).
- **Tests are colocated** as `src/**/*.test.ts` (Vitest, node environment, globals enabled). `@/` aliases `src/`; the `server-only` package is stubbed via `test/server-only-stub.ts`. Set `WALLIE_SANDBOX_IMPL=fake` to use the in-process sandbox fake (`src/lib/sandbox/`).
- **Prompt-injection caveat:** `sanitizeUntrusted()` in `src/lib/pipeline/prompt-safety.ts` exists but is **not wired into the prompt path** — apply it yourself when extending prompts with untrusted input (e.g. Linear text).
- **Concurrency is CAS-based.** Job claims and stage approvals only succeed from the expected status/artifact version — preserve this when touching `phase_status` transitions or the `approve_session_stage` RPC.
