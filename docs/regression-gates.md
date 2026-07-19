# Regression gates (visual, keyboard, accessibility, performance)

This suite protects the redesign against visual hierarchy, responsive overflow, keyboard, accessibility, and bundle regressions.

## What runs where

| Gate                                               | Command                           | CI job                        |
| -------------------------------------------------- | --------------------------------- | ----------------------------- |
| Visual baselines + axe serious/critical + overflow | `pnpm test:regression`            | `regression-gates`            |
| Bundle ceilings                                    | `pnpm check:route-budgets`        | `regression-gates` (same job) |
| Production interaction benchmark                   | `pnpm test:benchmark:interaction` | `regression-gates` (same job) |
| Unit / lint / format                               | `pnpm check`                      | `test` + `lint-and-format`    |

CI never passes `--update-snapshots`. Snapshot updates are always intentional and local.

## Prerequisites

1. Local Supabase with seed data: `supabase start && supabase db reset`
2. `.env.local` with `NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SECRET_KEY`, and `WALLIE_ENCRYPTION_KEY` (see `.env.example`)
3. Production build: `pnpm build`
4. Chromium for Playwright: `pnpm exec playwright install chromium`

## Fixture map

Deterministic fixtures live in `e2e/helpers/fixtures.ts`.

| State               | Source                                   |
| ------------------- | ---------------------------------------- |
| empty               | `/dev/sessions-ledger` empty section     |
| normal              | seeded `/w/acme-corp/sessions`           |
| high-density        | `/dev/sessions-ledger` (50 rows)         |
| validation-error    | New session dialog + invalid Linear URL  |
| network-error       | Playwright route mock on sessions API    |
| running             | seeded session `#2` (`agent_generating`) |
| awaiting-review     | seeded session `#1`                      |
| changes-requested   | seeded session `#10` (`rejected`)        |
| failed              | `/fixtures/artifact-reader?view=failed`  |
| archived / complete | seeded session `#6`                      |

Route/theme/viewport matrix routes are listed as `REGRESSION_ROUTES` in the same file (Landing, Login, Pipeline, Sessions, session detail, Onboarding, every Settings category).

## Local commands

```bash
# Full regression suite (build + Playwright regression specs)
pnpm test:regression

# Intentionally update screenshot baselines after a reviewed visual change
pnpm test:regression:update

# Re-run only (assumes `pnpm build` already done)
pnpm exec playwright test e2e/regression

# Flake probe (CI-equivalent: production server, one worker)
pnpm test:regression:flake
```

## Baseline update policy

1. Change UI deliberately.
2. Prefer updating baselines in the same environment CI uses (Linux Chromium). Baselines are platform-scoped under `*-snapshots/{linux|darwin}/`. On macOS Apple Silicon:

   ```bash
   docker run --rm \
     -v "$PWD":/work -v /work/node_modules -w /work \
     --add-host=host.docker.internal:host-gateway \
     -e CI=1 \
     -e PLAYWRIGHT_HOST=127.0.0.1 \
     -e PLAYWRIGHT_PORT=3100 \
     -e NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100 \
     -e NEXT_PUBLIC_SUPABASE_URL=http://host.docker.internal:54321 \
     -e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=… \
     -e SUPABASE_SECRET_KEY=… \
     -e WALLIE_ENCRYPTION_KEY=… \
     -e WALLIE_SANDBOX_IMPL=fake \
     mcr.microsoft.com/playwright:v1.61.1-jammy \
     bash -lc 'corepack enable && corepack prepare pnpm@10.15.0 --activate && pnpm install --frozen-lockfile && pnpm build && pnpm exec playwright test e2e/regression --update-snapshots'
   ```

   Or run `pnpm test:regression:update` on a Linux machine / CI runner and commit the resulting PNGs under `*-snapshots/linux/`.

3. Review **both** viewports (`mobile` 390×844, `desktop` 1440×1000) and **both** themes (light/dark).
4. Commit baselines in the same PR as the UI change. PR description must call out why pixels moved.
5. Never update baselines to silence an unexplained failure. Never enable auto-update in CI (`--update-snapshots` is omitted from the workflow on purpose).

## Accessibility review bar

- Serious/critical axe violations fail the suite (`e2e/helpers/axe.ts`).
- Interactive controls must expose an accessible name.
- Overlay primitives must move focus in and restore it on dismiss (`e2e/regression/keyboard-overlays.spec.ts`).
- Statuses must remain distinguishable with forced colors and reduced motion (`e2e/regression/status-forced-colors.spec.ts`).

## Adding a new route or state

1. Add the route or state to `e2e/helpers/fixtures.ts`.
2. If the state needs seeded rows, extend `supabase/seed.sql` with a stable session number and document it in the fixture map.
3. Prefer `/dev/*` or `/fixtures/*` surfaces (gated by `isProductionDeploy()`) when a product route cannot express the state.
4. Extend `e2e/regression/visual-matrix.spec.ts` or `state-fixtures.spec.ts` as needed.
5. Run `pnpm test:regression:update`, review new baselines, and commit them.

## Proving the gates

`scripts/prove-regression-gates.mjs` intentionally introduces and reverts:

- an accessibility defect
- a horizontal overflow defect
- a screenshot-visible copy change
- a route-budget ceiling breach

Each must fail, then the script restores the tree.
