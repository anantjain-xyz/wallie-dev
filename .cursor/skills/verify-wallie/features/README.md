# Wallie verification map

This directory is the maintained source for verifying user-facing Wallie behavior. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch Wallie with `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs launch` so the run owns the Next process and evidence directory.
- Require `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs doctor` to pass before driving.
- `.env.local` must define `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, and `WALLIE_ENCRYPTION_KEY`.
- Authenticated workspace recipes need local Supabase with seed applied (`supabase start` then `supabase db reset`) so workspace slug `acme-corp` and user `anant@example.com` exist.
- Never drive an instance that was not started by this verification run.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS selectors or DOM position.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run browser actions through `control-wallie browser`. Commands share one live page started at `launch`; fill then click works without reloading.
- Sign in through `control-wallie sign-in` when Supabase is healthy; do not invent passwords (Wallie has no password login UI).
- Restore seeded review state after mutations when possible. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with the Wallie identity visible.
- Auth and mutation proof includes a second user-visible view (URL + heading or list row).
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-wallie` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Landing and sign-in](./landing-and-sign-in.md) covers the public landing CTA, login form, magic-link request, and unauthenticated redirect into login.
- [Sessions ledger](./sessions-ledger.md) covers the seeded workspace session list, search, filters, and opening a session.
- [Pipeline board](./pipeline-board.md) covers the workspace pipeline board, filters, and opening a session from a column.
- [Session review](./session-review.md) covers approve / request-changes on an awaiting-review artifact.
- [Settings](./settings.md) covers settings categories and the verify-setup surface.
