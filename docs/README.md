# Wallie Documentation

Start with [`AGENTS.md`](../AGENTS.md) for repository-wide commands and
conventions, then use this page to find the owner of the part of Wallie you are
changing. Read the narrowest relevant document before following links into the
implementation.

## Task map

| When you are changing…                                               | Read                                                          | Canonical implementation owners                                                  | Prove it with                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| Documentation navigation or ownership                                | This index                                                    | `docs/README.md`                                                                 | Structural review of links and owners              |
| System boundaries, ownership, or dependency direction                | [Architecture](ARCHITECTURE.md)                               | `supabase/migrations/`, `src/lib/`, `src/app/api/`, `src/worker/`                | The checks for every affected boundary             |
| Session, stage, job, run, review, cancellation, or recovery behavior | [Pipeline and worker lifecycle](PIPELINE-WORKER-LIFECYCLE.md) | `src/lib/pipeline/`, `src/lib/wallie/`, `src/worker/`, pipeline RPCs             | Focused state tests, then `pnpm check`             |
| Test strategy, CI evidence, or the pre-PR gate                       | [Verification](VERIFICATION.md)                               | `package.json`, `vitest.config.ts`, `playwright.config.ts`, `.github/workflows/` | The claim-matched command described there          |
| Production deployment or self-hosting                                | [Self-hosting](SELF_HOSTING.md)                               | `.env.example`, `src/env/`, `railway.json`, Supabase migrations                  | Deployment smoke test plus worker heartbeat        |
| Accessible composite controls and overlays                           | [Accessibility primitives](accessibility-primitives.md)       | `src/components/ui/`                                                             | Focused component tests and keyboard/browser proof |
| Product telemetry or performance measurements                        | [Telemetry](telemetry.md)                                     | `src/lib/telemetry/`, analytics components, performance tests                    | Unit tests plus the relevant runtime measurement   |
| Typography roles and small-text rules                                | [Typography](typography.md)                                   | Typography utilities and the custom ESLint rule                                  | `pnpm lint` and responsive visual proof            |

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

These documents describe invariants and repair paths, not a snapshot of past
agent sessions. Historical rollouts are useful evidence for deciding what to
encode, but they are not repository policy.

## Reading order

1. Read `AGENTS.md` and the one task-specific document from the table above.
2. Follow its links to the semantic owner in code or SQL.
3. Inspect nearby tests before changing the owner.
4. Run the narrowest proof while iterating.
5. Finish with the full proof required by [Verification](VERIFICATION.md).
