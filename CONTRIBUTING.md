# Contributing to Wallie

Thanks for your interest in improving Wallie! Contributions of all sizes are welcome — bug reports, docs fixes, and features.

By participating in this project you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** or **request a feature** via [GitHub Issues](https://github.com/anantjain-xyz/wallie-dev/issues) using the provided templates.
- **Ask a question** or share an idea in [Discussions](https://github.com/anantjain-xyz/wallie-dev/discussions).
- **Open a pull request** — for anything non-trivial, please open an issue first so we can align on the approach before you invest time.

## Getting set up

The full local development setup (Node, pnpm, local Supabase, GitHub App, worker) lives in the [README — Local Setup](README.md#local-setup-end-to-end). Follow that end-to-end before making changes. For deploying a real instance, see the [Self-Hosting guide](docs/SELF_HOSTING.md).

In short:

```bash
git clone https://github.com/anantjain-xyz/wallie-dev.git
cd wallie-dev
pnpm install
cp .env.example .env.local   # then fill in values per the README
supabase start
pnpm dev                     # in one terminal
pnpm worker                  # in another
```

## Before you open a PR

Run the full check suite locally — CI runs the same checks and the lint step allows **zero warnings**:

```bash
pnpm check   # format:check + lint + typecheck + test
```

You can run the pieces individually while iterating:

```bash
pnpm format       # auto-format with Prettier
pnpm lint:fix     # auto-fix lint issues
pnpm typecheck    # TypeScript, no emit
pnpm test         # Vitest (one-shot)
pnpm test:watch   # Vitest in watch mode
```

To run a single test file or a focused subset:

```bash
pnpm test path/to/file.test.ts
pnpm test -t "name of the test"
```

## Pull request guidelines

- **Keep PRs small and focused.** One logical change per PR is much easier to review.
- **Branch** off `main` and open your PR against `main`.
- **Write a clear description** — what changed and why. Link the issue it addresses.
- **Include screenshots or a short clip** for any user-facing UI change.
- **Update docs** (README, `docs/`, `.env.example`) when behavior, setup, or env vars change.
- **Add or update tests** for behavior changes where practical.
- Make sure `pnpm check` passes and the PR has no merge conflicts with `main`.

### Commit messages

Write clear, imperative-mood subject lines (e.g. "Fix webhook signature check"). Keep the subject concise and add a body when the change needs explanation. Squash-style, self-contained commits are appreciated.

## Project conventions

- **TypeScript, strict mode.** Prefer direct, typed data contracts.
- **Database naming is stable.** Don't rename existing tables/columns without a migration and a clear reason; add forward migrations in `supabase/migrations/` rather than editing the baseline.
- **Respect domain boundaries.** Schema, auth, GitHub, secrets, and the pipeline/worker orchestration are separate concerns — keep changes scoped.
- **Never commit secrets.** `.env.local` and anything matching `.env*` (except `.env.example`) is gitignored — keep it that way. See [SECURITY.md](SECURITY.md).

## A note on the agent tooling in this repo

Wallie is itself built with coding agents, so you'll find agent configuration committed at the repo root — `AGENTS.md`, `CLAUDE.md`, and the `.agents/`, `.claude/`, and `.codex/` directories. These are intentional and used by the maintainers' agent workflows. You don't need any of it to contribute; treat the README and this guide as the source of truth for human contributors.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
