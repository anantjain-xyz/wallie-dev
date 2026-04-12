# Repository Guidelines

## Purpose

This repo is the implementation target for the Wallie cloud rebuild at `wallie.cc`.

The old repo at `/Users/anant/src/wallie` is reference-only.

## Reference Repo Rules

- You may read `/Users/anant/src/wallie` to recover product behavior, schema intent, and integration details.
- Do not modify `/Users/anant/src/wallie`.
- Do not port dead architecture from the old repo.

Specifically do not reintroduce:

- ElectricSQL
- PGlite
- proxy/write server topology
- local-first sync metadata
- client-exposed storage credentials
- board/offline support unless explicitly requested later

## Architecture Direction

Build for:

- Next.js App Router on Vercel
- Supabase Auth
- Supabase Postgres + RLS
- Supabase Realtime
- Supabase Storage

Use Vercel route handlers for privileged and third-party integrations.

## Coordination Rules

- You are not alone in the codebase.
- Stay within your ownership boundary.
- Do not overwrite unrelated work.
- Coordinate via PR descriptions when making cross-cutting changes.

## Working Norms

- Prefer small, reviewable commits.
- Prefer direct and typed data contracts.
- Keep DB naming stable once feature agents begin.
- Treat schema, auth, GitHub, Slack, secrets, and Wallie orchestration as separate domains.

## Glossary

- **Session** — top-level entity representing one end-to-end Wallie workflow. Replaces the legacy "issue" framing.
- **Phase** — a stage within a session: `product`, `design`, `engineering`, `review`, `land`, `monitor`.
- **Artifact** — versioned JSON output per phase (e.g. the product spec). Stored in `session_artifacts`, keyed on `(session_id, phase, version)`.
- **Run** — one agent execution within a phase. A rejected artifact triggers a new run of the same phase.

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available skills: `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/retro`, `/investigate`, `/document-release`, `/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`.

