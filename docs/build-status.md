# Build Status

## Current State

- Project: `wallie.cc` rebuild
- Implementation repo: `/Users/anant/src/wallie-cc`
- Reference repo: `/Users/anant/src/wallie`
- Status: Gate B schema freeze v1 verified
- Baseline verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passing on March 30, 2026
- Schema verification: `supabase db start`, `supabase db reset --local --yes`, `supabase db lint --local --fail-on error`, and `supabase gen types typescript --local --schema public` all passing on March 30, 2026

## Active Agents

- Platform (Codex): repo bootstrap, shared shell scaffold, schema/RLS baseline, Supabase app plumbing

## Branches

- `main`: active default branch

## Stage Gates

- Gate A, Bootstrap Complete: complete
- Gate B, Schema Freeze v1: complete
- Gate C, Auth + Workspace Entry: pending
- Gate D, Core Issue Workflow: pending
- Gate E, Integrations: pending
- Gate F, Wallie Control Plane: pending
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
- Environment schema currently requires app URL, Supabase URL, Supabase anon key, Supabase service role key, and a Wallie encryption key; GitHub and Stripe envs are reserved as optional placeholders.
- No ElectricSQL, PGlite, proxy/write servers, offline cache, or client-exposed storage credentials were introduced in bootstrap.
- Schema v1 uses `auth.uid()` plus `workspace_members` for tenancy and RLS; it does not reuse the old email-claim workspace lookup model.
- An internal `workspace_issue_counters` table backs the `next_issue_number(workspace_id uuid)` RPC so issue numbers are allocated atomically across separate client transactions.
- Client-writable SQL surface is limited to `issues`, `issue_comments`, `issue_links`, `profiles`, and `workspace_members.preferences`; `workspace_secrets` and `agent_jobs` remain service-only.
- Generated public DB types now live in `src/lib/supabase/database.types.ts` and should be refreshed from local Supabase whenever schema migrations change.

## Blockers

- None yet

## Deviations From Handoff

- None yet

## Notes

- Route helpers live in `src/lib/routes.ts` and should remain the shared source for workspace-prefixed navigation until a stronger contract is needed.
- The shared app shell in `src/components/app-shell` is intentionally data-agnostic so schema, auth, and feature agents can replace placeholder panels without reworking navigation chrome.
- Env validation is present but lazy; future integration agents should call the relevant parser at the server or client boundary they own.
- Realtime publication is intentionally narrow in schema v1: issues, comments, links, GitHub issue branches, agent runs, and agent run messages.
- App-side Supabase helpers now live in `src/lib/supabase/*`; future agents should import those helpers instead of creating raw clients ad hoc.
- On this machine, local Supabase CLI startup hangs in `docker-credential-desktop get` unless commands are run with `DOCKER_CONFIG=/tmp/wallie-cc-docker` and `DOCKER_HOST=unix:///Users/anant/.docker/run/docker.sock`.
- Feature agents should update this file when they introduce routes, schema assumptions, or shared interfaces.
