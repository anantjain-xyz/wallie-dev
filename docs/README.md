# Wallie Documentation

Start with [`AGENTS.md`](../AGENTS.md) for repository-wide commands and
conventions, then use this page to find the owner of the part of Wallie you are
changing. Read the narrowest relevant document before following links into the
implementation.

## Full factory implementation plan

- [Implementation plan](plans/FACTORY-IMPLEMENTATION-PLAN.md): all 100 capabilities,
  current design continuity, reusable owners, dependencies, incremental milestones,
  migration strategy, and release gates.
- [Capability matrix](plans/FACTORY-CAPABILITY-MATRIX.md): one implementation and
  completion proof for every capability, with recording timestamps.
- [Machine-readable register](plans/factory-capabilities.json): feature and milestone
  dependencies for future work tracking. All entries currently describe planned work.
- [Linear delivery index](https://linear.app/optimism-llc/document/factory-delivery-map-206-prs-100-capabilities-9853c51dac5c): 17 milestones, 206 one-PR issues and 283 native blocking relationships.
- [Local Linear map](plans/linear-delivery-map.json): stable issue links, capability coverage and the imported dependency graph.

## Task map

| When you are changing…                                                                | Read                                                          | Canonical implementation owners                                                  | Prove it with                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Documentation navigation or ownership                                                 | [Documentation index](README.md)                              | `docs/README.md`                                                                 | Structural review of links and owners                      |
| System boundaries, ownership, or dependency direction                                 | [Architecture](ARCHITECTURE.md)                               | `supabase/migrations/`, `src/lib/`, `src/app/api/`, `src/worker/`                | The checks for every affected boundary                     |
| Session, stage, job, run, review, cancellation, or recovery behavior                  | [Pipeline and worker lifecycle](PIPELINE-WORKER-LIFECYCLE.md) | `src/lib/pipeline/`, `src/lib/wallie/`, `src/worker/`, pipeline RPCs             | Focused state tests, then `pnpm check`                     |
| Prompt construction, agent credentials, events, artifacts, or runner behavior         | [Agent harness](AGENT-HARNESS.md)                             | `src/lib/prompt-templates/`, `src/lib/agent-runner/`, pipeline processor         | Runner/processor tests and a sandboxed smoke run           |
| Execution budgets, usage provenance, cost totals, or exhaustion                       | [Execution budgets](EXECUTION-BUDGETS.md)                     | `src/lib/execution-policy/`, execution-policy API, budget/usage RPCs and UI      | Adapter fixtures, budget races, cancellation, and UI proof |
| Tables, RLS, grants, RPCs, migrations, Realtime, or generated database types          | [Database and RLS](DATABASE-AND-RLS.md)                       | `supabase/migrations/`, `src/lib/supabase/`                                      | Local schema/identity proof plus `pnpm check`              |
| Delivery policy configuration and PR verification identity                            | [Delivery policy](DELIVERY-POLICY.md)                         | `src/lib/delivery-policy/`, delivery-policy API, verification RPCs               | Policy/RLS fixtures and settings browser proof             |
| Review readiness, blocker sources, and bounded PR diffs                               | [Review evidence](REVIEW-EVIDENCE.md)                         | `src/lib/pipeline/pr-readiness.ts`, review-evidence routes, session detail UI    | UI state tests and desktop/390px browser proof             |
| Sandbox connection, capability, provider, acquisition, cancellation, or cleanup       | [Sandbox provider contracts](SANDBOX-PROVIDER-CONTRACTS.md)   | `src/lib/sandbox/`, sandbox connection/capability services                       | Contract tests plus a real provider capability check       |
| Worker deployment, heartbeat, stall, reconciliation, reaping, or operational recovery | [Worker operations](WORKER-OPERATIONS.md)                     | `src/worker/`, worker-facing RPCs, maintenance service                           | Worker logs and durable job/run/sandbox receipts           |
| Test strategy, CI evidence, or the pre-PR gate                                        | [Verification](VERIFICATION.md)                               | `package.json`, `vitest.config.ts`, `playwright.config.ts`, `.github/workflows/` | The claim-matched command described there                  |
| Production deployment or self-hosting                                                 | [Self-hosting](SELF_HOSTING.md)                               | `.env.example`, `src/env/`, `wrangler.jsonc`, Supabase migrations                | Deployment smoke test plus worker heartbeat                |
| Accessible composite controls and overlays                                            | [Accessibility primitives](accessibility-primitives.md)       | `src/components/ui/`                                                             | Focused component tests and keyboard/browser proof         |
| Product telemetry or performance measurements                                         | [Telemetry](telemetry.md)                                     | `src/lib/telemetry/`, analytics components, performance tests                    | Unit tests plus the relevant runtime measurement           |
| Logged-in navigation timing                                                           | [Navigation benchmark](navigation-bench.md)                   | `scripts/bench-navigation.mjs`, `e2e/navigation-bench.benchmark.spec.ts`         | `pnpm bench:navigation`                                    |
| Typography roles and small-text rules                                                 | [Typography](typography.md)                                   | Typography utilities and the custom ESLint rule                                  | `pnpm lint` and responsive visual proof                    |

## Document roles

- `AGENTS.md` is the compact agent-facing map. It should route to deeper
  contracts instead of accumulating their full implementation detail.
- `README.md` explains the product, repository, and end-to-end setup to a new
  contributor.
- `docs/*.md` owns durable architecture, lifecycle, verification, design, and
  operational contracts.
- Code, migrations, generated types, and executable tests remain the source of
  runtime truth. When behavior changes, update its owning document in the same
  pull request.

Core architecture and operations documents describe invariants and repair
paths. The AWS rollout documents also preserve dated deployment evidence and
replay steps; their historical resource and permission details are not a live
inventory or current deployment policy.

## Reading order

For AWS work, start with the [staging web milestone, replay, and teardown guide](AWS-STAGING-MILESTONE.md). Use the [self-hosting guide](SELF_HOSTING.md) for the current deployment procedure and the [factory plan](plans/FACTORY-IMPLEMENTATION-PLAN.md) for planned hosting and release capabilities.

1. Read `AGENTS.md` and the one task-specific document from the table above.
2. Follow its links to the semantic owner in code or SQL.
3. Inspect nearby tests before changing the owner.
4. Run the narrowest proof while iterating.
5. Finish with the full proof required by [Verification](VERIFICATION.md).
