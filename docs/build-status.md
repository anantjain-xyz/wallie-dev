# Build Status

## Current State

- Project: `wallie.cc` rebuild
- Implementation repo: `/Users/anant/src/wallie-cc`
- Reference repo: `/Users/anant/src/wallie`
- Status: bootstrap scaffold verified
- Baseline verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passing on March 30, 2026

## Active Agents

- Platform (Codex): repo bootstrap, shared shell scaffold, tooling baseline

## Branches

- `codex/bootstrap`: active bootstrap branch

## Stage Gates

- Gate A, Bootstrap Complete: complete
- Gate B, Schema Freeze v1: pending
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
- Shared shell scaffolding is workspace-prefixed and centered on `/w/[workspaceSlug]/*`.
- Initial placeholder routes exist for `/`, `/login`, `/signup`, `/onboarding/workspace`, `/w/[workspaceSlug]/issues`, `/w/[workspaceSlug]/issues/[issueNumber]`, and `/w/[workspaceSlug]/settings`.
- Environment schema currently requires app URL, Supabase URL, Supabase anon key, Supabase service role key, and a Wallie encryption key; GitHub and Stripe envs are reserved as optional placeholders.
- No ElectricSQL, PGlite, proxy/write servers, offline cache, or client-exposed storage credentials were introduced in bootstrap.

## Blockers

- None yet

## Deviations From Handoff

- None yet

## Notes

- Route helpers live in `src/lib/routes.ts` and should remain the shared source for workspace-prefixed navigation until a stronger contract is needed.
- The shared app shell in `src/components/app-shell` is intentionally data-agnostic so schema, auth, and feature agents can replace placeholder panels without reworking navigation chrome.
- Env validation is present but lazy; future integration agents should call the relevant parser at the server or client boundary they own.
- Feature agents should update this file when they introduce routes, schema assumptions, or shared interfaces.
