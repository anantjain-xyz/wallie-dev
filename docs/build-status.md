# Build Status

## Current State

- Project: `wallie.cc` rebuild
- Implementation repo: `/Users/anant/src/wallie-cc`
- Reference repo: `/Users/anant/src/wallie`
- Status: Gate D core issue workflow verified
- Baseline verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passing on March 30, 2026
- Schema verification: `supabase db start`, `supabase db reset --local --yes`, `supabase db lint --local --fail-on error`, and `supabase gen types typescript --local --schema public` all passing on March 30, 2026
- Gate C verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passing on March 30, 2026 after auth, onboarding, and workspace route gating landed
- Gate D verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passing on March 30, 2026 after issue list, detail editing, comments, and issue links landed

## Active Agents

- Platform (Codex): repo bootstrap, shared shell scaffold, schema/RLS baseline, Supabase app plumbing

## Branches

- `main`: active default branch

## Stage Gates

- Gate A, Bootstrap Complete: complete
- Gate B, Schema Freeze v1: complete
- Gate C, Auth + Workspace Entry: complete
- Gate D, Core Issue Workflow: complete
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
- Gate C auth entrypoints now live at `/login`, `/signup`, `/auth/oauth`, `/auth/email`, `/auth/callback`, `/auth/confirm`, and `/auth/signout`.
- Workspace bootstrap now lands through `POST /api/workspaces`, which delegates transactional owner membership and system `wallie` member creation to the `public.create_workspace(workspace_name text, requested_slug text default null)` RPC.
- Workspace shell routes under `/w/[workspaceSlug]/*` now require a Supabase session plus RLS-backed workspace membership before the shell renders.
- Supabase session refresh now runs through `middleware.ts` plus `src/lib/supabase/middleware.ts` so auth cookies stay current for server-rendered routes.
- Gate D list and detail entrypoints now live on real server loaders at `/w/[workspaceSlug]/issues` and `/w/[workspaceSlug]/issues/[issueNumber]`, with client-side CRUD shells layered on top of the initial server render.
- Gate D issue list query params are now `query`, `status`, `priority`, `estimate`, `sort`, and `direction`; the parser still accepts legacy `orderBy` and `orderDirection` aliases from the old app.
- Gate D stores list sort preference in `workspace_members.preferences.issues.sort` and `.direction`, with the URL remaining the shareable source of truth when explicit query params are present.
- Gate D models `blocked_by` rows directionally: `source_issue_id = current issue, target_issue_id = other issue` renders as "Blocked by", and the inverse row renders as "Blocks".
- Gate D models `sub_issue` rows directionally: `source_issue_id` is the child issue and `target_issue_id` is the parent issue; outgoing rows from the current issue surface parent links and incoming rows surface sub-issues.
- Gate D preserves PR and Wallie timeline sections on the detail route as placeholder shells so later gates can fill them without changing the route contract.

## Blockers

- None yet

## Deviations From Handoff

- Root redirect currently selects the most recently updated accessible workspace when a user has multiple workspaces; the handoff’s explicit "last active workspace" preference will need a later server-backed preference contract.
- Gate D uses textarea-backed markdown fields for description, plan, and design instead of a richer editor so the data contract can land before the editor stack is introduced.
- Gate D list search/filter/sort currently run against the workspace issue set inside the typed server loader instead of pushing every combination into the DB query surface; revisit if workspace issue volume grows materially.
- Gate D does not enable issue realtime yet; list bulk mutations refresh through the route loader, while detail edits patch the currently open issue/comments/links locally after successful writes.

## Notes

- Route helpers live in `src/lib/routes.ts` and should remain the shared source for workspace-prefixed navigation until a stronger contract is needed.
- The shared app shell in `src/components/app-shell` is intentionally data-agnostic so schema, auth, and feature agents can replace placeholder panels without reworking navigation chrome.
- Env validation is present but lazy; future integration agents should call the relevant parser at the server or client boundary they own.
- Realtime publication is intentionally narrow in schema v1: issues, comments, links, GitHub issue branches, agent runs, and agent run messages.
- App-side Supabase helpers now live in `src/lib/supabase/*`; future agents should import those helpers instead of creating raw clients ad hoc.
- On this machine, local Supabase CLI startup hangs in `docker-credential-desktop get` unless commands are run with `DOCKER_CONFIG=/tmp/wallie-cc-docker` and `DOCKER_HOST=unix:///Users/anant/.docker/run/docker.sock`.
- Feature agents should update this file when they introduce routes, schema assumptions, or shared interfaces.
- Authenticated entry pages now upsert `profiles` from Supabase user metadata before redirecting into onboarding or workspace routes.
- The workspace layout returns `notFound()` for inaccessible workspace slugs once the signed-in user already has at least one accessible workspace; users with no accessible workspaces are redirected to `/onboarding/workspace`.
- Gate D surfaces only one parent issue as an editable target in the UI even though the current schema permits multiple `sub_issue` parent rows for a single child; if older or manual data creates multiple parents, the detail page shows them and requires manual cleanup.
