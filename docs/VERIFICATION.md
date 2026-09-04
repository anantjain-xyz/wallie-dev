# Verification

Verification should match the claim being made. A focused unit test proves a
function; it does not prove the worker is deployed, a browser journey works, or
RLS isolates two workspaces.

## Canonical validation profiles

The repository owns two validation profiles:

```bash
pnpm check:fast
pnpm check
```

The fast profile runs:

```text
verify:validation → format:check → lint → typecheck → check:privileged-imports
```

The full profile runs `check:fast` and then the complete Vitest suite. Before
review, run `pnpm check`, the repository-owned full pre-PR gate.

Pull-request CI delegates directly to both canonical profiles: the fast
validation job runs `pnpm check:fast`, and the test job runs `pnpm check`.
Typechecking therefore runs in PR CI. A separate CI job builds the production
app and enforces route budgets; production builds and route-budget checks are
not part of either canonical profile.

## Verification lanes

| Lane                       | Command                                           | What it proves                                                                                                | What it does not prove                                     |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Focused unit or contract   | `pnpm test path/to/file.test.ts`                  | The selected Vitest file in the Node test environment                                                         | Unrelated tests, formatting, types, browser behavior       |
| Focused behavior           | `pnpm test -t "name"`                             | Tests matching one title                                                                                      | That the intended file was the only match                  |
| Formatting                 | `pnpm format:check`                               | Tracked and nonignored files match Prettier                                                                   | Types or behavior                                          |
| Static analysis            | `pnpm lint`                                       | ESLint and repository custom rules pass with zero warnings                                                    | TypeScript or runtime behavior                             |
| Types                      | `pnpm typecheck`                                  | TypeScript compiles with no emit                                                                              | Database runtime compatibility                             |
| Unit suite                 | `pnpm test`                                       | All colocated Vitest tests pass                                                                               | A real browser, worker, provider, or hosted database       |
| Canonical fast profile     | `pnpm check:fast`                                 | Validation contract, format, lint, types, and privileged imports pass                                         | Unit tests, production build, route budgets, E2E           |
| Canonical full profile     | `pnpm check`                                      | The fast profile and all unit tests pass together                                                             | Production build, route budgets, E2E, hosted integrations  |
| Production route budget    | `pnpm build && pnpm check:route-budgets`          | Next production build succeeds and committed route ceilings hold                                              | Interaction latency or user-perceived behavior             |
| Authenticated bundle check | `pnpm build && pnpm analyze:authenticated-bundle` | Selected authenticated chunks omit the script's prohibited bundle markers                                     | A general dependency audit or runtime correctness          |
| Local schema reset         | `supabase db reset`                               | The full migration chain and seed apply to a clean local stack                                                | Upgrade compatibility from an older deployed schema        |
| SQL test suite             | `pnpm check:db-tests`                             | The checked-in pgTAP tests pass against local Supabase                                                        | Complete RLS/RPC coverage beyond the checked-in assertions |
| Generated-types heuristic  | `pnpm db:types:check` / `pnpm check:types-drift`  | Types file exists; git timestamps do not show types older than the latest migration when history is available | A full regen; shallow CI checkouts often cannot compare    |
| Generated types            | `pnpm db:types` followed by a clean diff          | Applied local schema projects to the committed TypeScript types                                               | RLS behavior for multiple identities                       |

`pnpm db:types` rewrites a generated file. Run it only against the intended
local Supabase schema and inspect the diff.

`pnpm db:types:check` (`pnpm check:types-drift`) is a heuristic, not a full
regen. `src/lib/supabase/database.types.ts` has no version header, so the
script cannot match the latest migration filename to a stamp. When the latest
migration cannot change generated types, the timestamp comparison is skipped.
When git history is complete it compares commit timestamps of the types file
and a type-changing latest migration and fails if types look older. A shallow
clone cannot trust those timestamps, so a type-changing latest migration fails
the heuristic instead of printing OK. It is **not** part of `check:fast`. The
live-repo Vitest skips the timestamp assertion on shallow checkouts; a fixture
covers the fail path.

The Test workflow runs the SQL suite in a separate `database-tests` job on every
pull request and main push. It installs a pinned Supabase CLI, starts disposable
local services with migrations and seed data, and runs `pnpm check:db-tests`.
The job uses no hosted database or production credentials. Studio, the Edge
runtime, analytics, and the pooler are excluded because the SQL tests do not need
them. Failure diagnostics print local container status and database logs, and
cleanup runs even when tests fail. The validation contract rejects skipped or
non-blocking variants of this job.

Locally, continue to run `pnpm check:db-tests` after `supabase start`. The SQL suite
is an additional CI check; `pnpm check` remains usable without Docker. Repository
owners can require the `database-tests` check in branch protection after its
first successful run.

Database, browser, sandbox-provider, and hosted-integration checks depend on
additional local services, credentials, or external environments. Run the
relevant lane explicitly when the change makes that claim; neither canonical
profile substitutes for it.

## Runtime development

An end-to-end local session needs three services:

```bash
supabase start
pnpm dev
pnpm worker
```

Run the web app and worker in separate terminals. Without the worker, queued
sessions remain in `in_progress`.

For hermetic pipeline tests and local work that must not allocate a remote
sandbox, set:

```bash
WALLIE_SANDBOX_IMPL=fake
```

The fake proves Wallie's orchestration contract. It does not prove Vercel, E2B,
Daytona, GitHub credentials, agent CLI installation, network access, or resource
limits.

## Browser and benchmark commands

The checked-in Playwright suites are targeted rather than one universal E2E
command:

| Command                                  | Primary claim                                   |
| ---------------------------------------- | ----------------------------------------------- |
| `pnpm test:e2e:onboarding`               | Onboarding mutation requests and setup flow     |
| `pnpm test:e2e:responsive`               | Responsive product behavior                     |
| `pnpm test:e2e:session-prefetch`         | Session-detail navigation and prefetch behavior |
| `pnpm test:benchmark:interaction`        | Repeated interaction timing benchmark           |
| `pnpm test:benchmark:content-visibility` | Content-visibility benchmark                    |

These scripts build first. Other specs in [`e2e/`](../e2e/) may be run directly
with Playwright when their journey is affected.

The checked-in development visual-proof surfaces are the retained `/dev/*`
routes: `/dev/content-visibility` for the rendering benchmark,
`/dev/sessions-ledger` for hydration coverage, `/dev/ui-primitives` for the
accessibility-primitives walkthrough, `/dev/pipeline-editor` for pipeline
editor accessibility and UX captures, and `/dev/statuses` for the responsive
status showcase. For other user-facing changes, capture the affected
production route at the relevant states and viewports; there is no separate
unreferenced fixture-lab route to keep in sync.

To run the complete checked-in Playwright inventory after building:

```bash
pnpm build
pnpm exec playwright test
```

For a user-facing change, exercise the actual changed journey at the relevant
desktop and mobile viewports. A screenshot proves rendered appearance at one
state and viewport; keyboard behavior, focus movement, async recovery, and
performance require separate evidence.

## Claim-to-proof matrix

| Claim                                  | Required evidence                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Pure transformation or parser behavior | Focused unit tests including invalid input                                                         |
| Session/job state behavior             | Focused transition tests with stale or losing-race cases                                           |
| RLS or workspace isolation             | Positive identity plus cross-workspace negative identity                                           |
| Migration correctness                  | Clean reset; for compatibility-sensitive DDL, an isolated upgrade from the prior schema            |
| Route authentication or mutation       | Route test covering unauthenticated, unauthorized, stale, and success outcomes                     |
| Worker recovery                        | Worker test or local run showing job/run/session terminal state and sandbox cleanup                |
| Sandbox provider support               | Contract tests plus a real capability check for that provider                                      |
| Realtime reconciliation                | Initial snapshot, event update, reconnect/fallback, and stale-event behavior                       |
| User-facing workflow                   | Focused tests plus browser exercise of the critical journey                                        |
| Responsive or accessibility behavior   | Viewport matrix, keyboard path, focus state, and automated accessibility evidence where applicable |
| Performance budget                     | Production build output or benchmark tied to a committed threshold                                 |
| Deployment health                      | Web smoke test, fresh worker heartbeat, claimed test job, and observed artifact/review completion  |

## Test conventions

- Vitest discovers `src/**/*.test.{ts,tsx}` in a Node environment.
- Tests are colocated with their owner.
- `@/` resolves to `src/`.
- `server-only` is replaced by `test/server-only-stub.ts`.
- Prefer production-shaped mocks. Receiver-sensitive SDK methods must preserve
  their receiver; database races should return the same empty-row shape as the
  real CAS.
- A verifier needs both a passing fixture and a deliberately failing fixture.
  A test that only searches for a token should also prove that comments and
  strings cannot create a false green.
- Use isolated temporary resources for database, browser, and provider tests.
  Never reset a developer's shared or hosted project as part of an automated
  check.

## Reporting proof

A pull request should state:

1. The behavior or invariant changed.
2. The exact commands run and their outcomes.
3. Any required proof that was not run, with the reason.
4. For UI work, the exercised route, state, viewport, and interaction.
5. For operations work, the environment and durable receipt: heartbeat, job,
   run, artifact, deployment, or provider cleanup result.

Do not claim the full gate from a focused test, or a deployed outcome from local
checks. Keep temporary browser output, caches, traces, and screenshots out of
the repository unless the artifact is intentionally reviewed and owned.
