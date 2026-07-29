# Database and RLS

Supabase Postgres is Wallie's durable authority for identity-scoped data,
pipelines, sessions, jobs, runs, artifacts, encrypted connections, and atomic
transitions. This document defines how code may exercise that authority and how
the schema evolves.

## Schema ownership

The current schema is the ordered result of:

1. The frozen consolidated baseline
   [`20260422000000_init.sql`](../supabase/migrations/20260422000000_init.sql).
2. Every later SQL file in [`supabase/migrations/`](../supabase/migrations/) in
   filename order.

A function or policy redefined by a forward migration is governed by its latest
definition. The generated
[`database.types.ts`](../src/lib/supabase/database.types.ts) is a projection of
the applied local schema and must not be hand-edited.

## Client authority

| Client  | Identity and key                                | Authority    | Intended callers                                                     |
| ------- | ----------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| Browser | Publishable key plus browser auth session       | RLS-scoped   | Client components and Realtime subscriptions                         |
| Server  | Publishable key plus cookie-backed user session | RLS-scoped   | Server components, actions, route identity, and membership checks    |
| Admin   | Secret service-role key                         | Bypasses RLS | Worker and explicitly privileged server services after authorization |

Canonical constructors live in
[`src/lib/supabase/`](../src/lib/supabase/). Passing a workspace ID to an admin
query is not authorization by itself.

## Privileged request pattern

A user-triggered privileged route must:

1. Verify the authenticated JWT identity.
2. Resolve active workspace membership with the server client.
3. Require the role appropriate for the operation.
4. Only then create or call an admin-backed service.
5. Scope every user-derived admin query to the already-authorized workspace.
   The manager maintenance reaper currently violates this rule, as called out
   below.
6. Repeat identity, workspace, version, or state predicates inside the final
   transactional RPC when the mutation must be atomic.

Return not-found for cross-workspace resource probes where revealing existence
would cross the tenant boundary.

The manager-triggered maintenance path is a current exception to this pattern.
It scopes stall detection and Linear reconciliation to the authorized
workspace, but invokes sandbox reaping without a workspace filter. The reaper
can therefore inspect and stop eligible Wallie-known resources for other
workspaces. Do not treat workspace-manager authorization on that endpoint as a
tenant-scoped reaper boundary.

The worker is different: it is an infrastructure principal and uses the admin
client directly across pipelines and stages, sessions, jobs, runs, messages,
artifacts, PR records, sandbox connection and capability state, workspace
configuration, and integration routing. Reconciliation also reads and decrypts
workspace secrets such as Linear API keys. Because the service role bypasses
RLS, explicit workspace and state predicates, transition guards, database
constraints, and narrowly scoped secret loaders are the worker's authority
boundaries.

## Tenant and identity model

- Tenant-owned rows carry `workspace_id`.
- User-global exceptions include profiles and personal agent credentials.
- Active workspace membership is the reusable authorization relationship.
- Tenant-owned references should enforce that a child and its parent belong to
  the same workspace. Most such relationships are checked by constraints or
  triggers, but `repository_onboarding_status.github_repository_id` and
  `sandbox_capability_checks.github_repository_id` currently are not. An
  authenticated manager who knows another workspace's repository UUID can
  write either kind of row in their own workspace with that cross-workspace
  reference.
- RLS policy and SQL privilege are separate gates. A policy cannot compensate
  for an accidentally broad grant, and a revoke cannot express row-level
  identity.
- Plaintext credential decryption stays in server-only services. However, the
  baseline grants table-wide `SELECT` on a user's own
  `user_codex_credentials` and `user_claude_code_credentials` rows, so
  authenticated browser clients can read ciphertext and non-preview columns.
  Minimum preview/status projection is a desired boundary, not one currently
  enforced for those two tables.
- Service-only tables revoke authenticated access and use explicit restrictive
  policies as defense in depth.

## New public table checklist

One migration introducing a tenant-owned table should include:

- `workspace_id`, foreign keys, and deliberate delete behavior.
- Cross-workspace consistency enforcement for every tenant-owned reference.
- Domain constraints and indexes.
- `ALTER TABLE … ENABLE ROW LEVEL SECURITY`.
- Initial `REVOKE ALL`, followed by narrow role and column grants.
- Named policies for each authenticated operation that is actually granted.
- Service-role privileges where worker or privileged services need them.
- Realtime publication and replica identity only when a real subscriber needs
  them.
- Positive member access and negative cross-workspace tests.

Do not leave RLS, grants, or cross-tenant triggers for a later migration unless
the table is unreachable until that migration lands.

## Function and RPC security

Prefer `SECURITY INVOKER` when ordinary grants and RLS are sufficient.

Use `SECURITY DEFINER` only when the function needs elevated authority or owns a
transactional invariant. Every definer function must:

- Set a fixed safe `search_path` and schema-qualify referenced objects.
- Revoke execution from `PUBLIC`, `anon`, and every unintended role.
- Grant the exact intended signature to the narrowest role.
- Re-establish grants when a signature changes.
- Validate `auth.uid()`, active membership, workspace, and resource
  relationships internally when exposed to authenticated callers.
- Accept only already-authorized inputs when service-role-only.
- Have success, wrong-workspace, wrong-role, stale-state, and direct-call tests
  appropriate to its authority.

Service-role RPCs such as atomic session creation or job claim do not replace
route authorization. They own atomicity after a trusted caller has established
who may request the operation.

## Forward migration workflow

1. Never edit, delete, or rename the baseline or an applied migration.
2. Add one migration with a unique 14-digit timestamp prefix.
3. Make the new schema compatible with the currently deployed web and worker
   versions.
4. Backfill before adding `NOT NULL` or a stricter constraint.
5. Deploy code that can read old and new representations.
6. Contract old columns, values, or function signatures only in a later rollout
   after old processes can no longer call them.
7. Regenerate TypeScript bindings from the applied local schema.
8. Prove a clean reset and, for destructive or rolling changes, an isolated
   upgrade from the previous schema.

Dropping a column while an older worker is still running is not a safe
"forward-only" migration. Use expand, compatible deployment, backfill, and
later contract.

Function replacement must account for Postgres's exact argument signature.
Dropping an old overload and creating a new one in one migration is acceptable
only when no deployed caller still requires the old signature and grants are
reapplied explicitly.

## Generated bindings

Generate against local Supabase:

```bash
pnpm db:types
```

Then inspect the complete diff. A safe freshness check is:

```bash
pnpm db:types
git diff --exit-code -- src/lib/supabase/database.types.ts
```

Application code must not cast away generated types merely to hide a stale
projection. When a deliberate forward RPC is temporarily ahead of bindings,
isolate the cast at one owner and remove it when bindings catch up.

Supabase methods may depend on their client receiver. Call `client.rpc(...)` or
bind deliberately; do not detach a raw method and rely on a context-free test
mock.

## Realtime and Storage

- Realtime tables are explicitly added to the publication.
- Consumers of delete events may require `REPLICA IDENTITY FULL`.
- Publication changes must update the existing Realtime projection tests.
- Storage buckets have their own access surface. Public object reads do not
  imply public mutation authority.
- Workspace-avatar mutation is mediated by privileged server code with size and
  MIME validation; authenticated clients do not receive a service-role storage
  client.

## Required proof

| Claim                                  | Proof                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Migration chain is self-consistent     | `supabase db reset`                                                                        |
| SQL privileges and RLS behavior        | `SUPABASE_TELEMETRY_DISABLED=1 supabase test db --local` plus the relevant identity matrix |
| Generated schema projection is current | `pnpm db:types` and clean generated diff                                                   |
| Migration versions are unique          | Existing migration-version Vitest                                                          |
| Realtime projection is current         | Existing Realtime publication Vitest                                                       |
| Rolling compatibility                  | Isolated upgrade using the prior schema and old/new caller versions                        |
| TypeScript consumers remain sound      | Focused tests and `pnpm check`                                                             |

String inspection of SQL is useful for narrow projections; it is not a
substitute for applying the migration or exercising Postgres identities.

## Known implementation gaps

- The admin client constructor itself does not carry a `server-only` marker.
- Some privileged paths use the admin client for reads that an already
  authenticated RLS client could perform.
- Existing definer functions use several `search_path` styles rather than one
  documented exception model.
- A temporary loose Supabase client remains in production call paths.
- Personal agent credential tables grant authenticated users table-wide
  self-`SELECT`, exposing ciphertext and non-preview columns to browser clients.
- `repository_onboarding_status.github_repository_id` and
  `sandbox_capability_checks.github_repository_id` lack database-enforced
  workspace consistency with their referenced repositories.
- Manager-triggered maintenance scopes stall and Linear work to one workspace
  but runs sandbox reaping globally.
- Generated-type freshness and a global applied-schema RLS/grant inventory are
  not enforced in CI.
- Most migration tests inspect source text; the transactional session-creation
  pgTAP suite is the main current database-executed authorization model.

Treat these as migration targets. Do not copy them into new code as precedent.
