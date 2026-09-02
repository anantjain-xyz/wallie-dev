---
name: verify-wallie
description: Drive the Wallie Next.js web app (landing, auth, workspace pipeline/sessions/settings) the way a user does. Use when proving UI behavior, running /verify-wallie, or capturing browser evidence for Wallie changes.
---

# Verify Wallie

Wallie's primary user surface is the **Next.js web UI** at `http://localhost:3000`. Secondary surfaces: `pnpm worker` (pipeline job progress), HTTP APIs under `/api/*`, and local Supabase Studio/Inbucket. This skill drives the web UI.

Prefer the shipped helper `control-wallie` over ad-hoc curl or CDP. It records PIDs, keeps evidence under `.wallie/verify/<run-id>/`, and only tears down what it started.

## Launch

From the repo root:

```bash
# One-time / when deps are missing
pnpm install
command -v supabase >/dev/null || (curl -fsSL https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz | sudo tar -xz -C /usr/local/bin supabase)
pnpm exec playwright install chromium   # browsers for @playwright/test

# Env (gitignored). Fill keys from `supabase status` after start.
test -f .env.local || cp .env.example .env.local
# Required keys: NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_SUPABASE_URL,
# NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, WALLIE_ENCRYPTION_KEY
# Generate encryption key: openssl rand -hex 32
# For hermetic agent runs: WALLIE_SANDBOX_IMPL=fake

# Full local stack (authenticated features need this)
supabase start
supabase db reset   # applies migrations + supabase/seed.sql (acme-corp, anant@example.com)

# Start the app for verification (records PIDs + evidence dir)
node .cursor/skills/verify-wallie/scripts/control-wallie.mjs launch
```

**Ready signal:** helper prints `ready baseUrl=http://127.0.0.1:<port>` after `GET /` returns 200 and the HTML contains `Sign in to Wallie` or `Wallie`. Dev server logs `✓ Ready` / `Local:`.

**Default port:** `3000` (`WALLIE_VERIFY_PORT` to override). Playwright's packaged e2e server uses `3100` separately; do not point this skill at a foreign Playwright webServer unless you own it.

**Worker:** not required for landing, login, or reading seeded authenticated pages. Required for session jobs to leave `in_progress` and for full approve→next-stage execution. Start with a second terminal `pnpm worker` when proving pipeline progression.

**Teardown:** `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs stop` (kills only recorded PIDs; leaves `.wallie/verify/<run-id>/` intact). Do not `pkill -f next`.

## Doctor

Read-only health check before any drive:

```bash
node .cursor/skills/verify-wallie/scripts/control-wallie.mjs doctor
```

Requires: a run state file from `launch`, `GET <baseUrl>/` → 200, body contains `Sign in to Wallie` (logged-out landing) **or** workspace chrome such as `Workspace navigation` (already signed in). Optionally probes `GET <baseUrl>/login` for `Sign in to Wallie` + `Work email`.

If doctor fails, stop and relaunch. Never drive an instance you did not start.

## Drive

Harness: **Playwright** (`@playwright/test` Chromium) via `control-wallie`. Stable handles are ARIA roles/names from production UI — almost no `data-testid` on real pages.

```bash
# Navigate
node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser goto /

# Click by role + accessible name
node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser click --role link --name "Sign in to Wallie"

# Fill
node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser fill --role textbox --name "Work email" --value "anant@example.com"

# Auth shortcut when local Supabase is up (seed user)
node .cursor/skills/verify-wallie/scripts/control-wallie.mjs sign-in --destination /w/acme-corp/sessions

# Capture
node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser screenshot --path landing.png
node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser snapshot --aria --path landing.aria.txt
```

Checked-in e2e helpers remain valid for suite runs: `e2e/helpers/auth.ts` (`signIn` / `signInViaMagicLink` as `anant@example.com` → `/w/acme-corp`). Prefer `control-wallie` for skill-driven proofs so evidence lands in the run directory.

Feature recipes live in [`features/`](./features/). Drive from the map; one feature per proof is enough for a focused change.

## Evidence

- **Location:** `.wallie/verify/<run-id>/` (gitignored). Helper prints the path on launch.
- **Minimum proof:** action + resulting state (e.g. click Sign in → URL `/login` + heading `Sign in to Wallie`), not only a final screenshot.
- **UI:** screenshot + ARIA snapshot with Wallie identity visible (`Wallie` mark/heading).
- **Auth mutations:** after magic-link/OTP, prove landing on `/w/acme-corp/...` and workspace nav.
- **Pipeline mutations:** prove visible stage/status change; worker must be running for real progress. Mocks only at production boundaries (`WALLIE_SANDBOX_IMPL=fake` for sandboxes).
- **Do not** treat Vitest or `pnpm check` as UI proof.

## Cleanup

```bash
node .cursor/skills/verify-wallie/scripts/control-wallie.mjs stop
```

Stops Next (and optional worker) PIDs recorded at launch. Does **not** delete evidence. Does **not** run `supabase stop` unless you passed `--manage-supabase` at launch (default: leave shared local Supabase running).

Confirm evidence still exists: `ls .wallie/verify/<run-id>/`.

## Isolate

- Two Next processes can share one local Supabase if ports differ (`WALLIE_VERIFY_PORT=3200`; auth redirect allowlist in `supabase/config.toml` includes 3000/3100/3200).
- One local Supabase stack per machine (`project_id = wallie-dev`, fixed ports 54321–54324). A second `supabase start` in another checkout conflicts unless ports/`project_id` change.
- Seed workspace `acme-corp` is shared. Parallel mutators can collide; keep `workers: 1` for Playwright suites.
- If Docker bridge networking cannot connect containers to each other, `supabase start` fails during schema init. Fix Docker networking before claiming authenticated features. Public landing + login HTML still render with a valid-shaped `.env.local` even when Supabase is down (OTP submit will fail).

## Helpers

Executable entrypoint (no install step beyond repo `pnpm install` + Playwright browser):

```bash
node .cursor/skills/verify-wallie/scripts/control-wallie.mjs <command>
```

| Command     | Purpose                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `launch`    | Start `pnpm dev` (optional `--worker`, `--manage-supabase`), wait until ready, write run state |
| `doctor`    | Read-only readiness check                                                                      |
| `browser …` | goto / click / fill / press / screenshot / snapshot                                            |
| `sign-in`   | Admin magic-link sign-in as `anant@example.com`                                                |
| `stop`      | Tear down recorded PIDs only                                                                   |

State file: `.wallie/verify/current-run.json` → points at the active run directory.
