# Durable run history qualification

## Qualification matrix

| Profile                | Evidence and scope                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Node worker      | The production processor uses a deterministic runner, local Git, and isolated Supabase. A fresh Node process adopts the interrupted publication.                                                                                                                                                                                      |
| Native workerd         | An actual Workflow replays the dispatch against isolated Supabase. A deterministic stage driver uses the production capture and publication RPCs. It applies the same retained-history assertions as Node.                                                                                                                            |
| Real Vercel and GitHub | The [OP-499 continuity receipt](https://github.com/anantjain-xyz/wallie-dev/blob/a567807db7a2b3e5d2781fda071130b2407e0622/docs/evidence/op-499-vercel-github-continuity.json) and [smoke PR #583](https://github.com/anantjain-xyz/wallie-dev/pull/583) record an exact checkpoint recovery after the producer sandbox was destroyed. |
| Hosted Cloudflare      | Live proof remains pending for the twelve combinations of Codex, Claude Code, Cursor, and OpenCode with Vercel, E2B, and Daytona. Use an isolated Worker with separate bindings and test credentials. [Hosted qualification gate](../deployment/cloudflare-worker.md#qualification-and-cutover).                                      |

[PR #600](https://github.com/anantjain-xyz/wallie-dev/pull/600) records the native
maintenance rehearsal for OP-510. It covers GitHub verification and PR readiness
ordering and independent failure handling in workerd.

## Reproduce the local checks

Use a disposable loopback Supabase stack with current migrations and seed data.
Run fixture commands serially against that stack because they share the
continuity release settings.

- Run `WALLIE_CONTINUITY_SUPABASE_WORKDIR=<local-workdir> pnpm check:continuity`.
  The database CI job includes this Node and workerd gate.
- For browser qualification, configure `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, and
  `WALLIE_CONTINUITY_DB_URL` with values from the disposable stack. Use the default `localhost` app host
  for the browser and its Auth redirects. Run `pnpm build`, then
  `WALLIE_RUN_HISTORY_BROWSER=1 pnpm exec playwright test e2e/durable-run-history.spec.ts`.
  The test starts the same continuity fixture and coordinates recovery with
  an authenticated browser on the production build.

## Release evidence

- Chromium recovered the missed event by cursor, closed its context, and
  reopened the same terminal run after a fresh Node process adopted its
  publication. Runs listed one accepted Markdown artifact and one checkpoint.
  The downloaded bytes matched the digest and Review showed the same checkpoint.
- Node and native workerd exercised the same authenticated history assertions
  against isolated Supabase. The cancellation fixture rejected late success
  under the retired and newer claims. Ordered capture could be paused while
  old transcripts and new legacy activity stayed readable.
- A fresh Vercel checkout smoke returned HTTP 402 at sandbox creation due to the
  account’s usage limit. The archived live continuity result stays linked in the
  matrix above.

## Live Vercel checkout smoke

Use an operator environment file that provides `VERCEL_TOKEN`, `VERCEL_TEAM_ID`,
and `VERCEL_PROJECT_ID`. The archived checkpoint below belongs to the isolated
OP-499 fixture in the existing Wallie repository.

```bash
node --env-file="$WALLIE_VERCEL_SMOKE_ENV" \
  --import ./scripts/register-server-only.mjs --import tsx \
  scripts/smoke-checkpoint-checkout.ts anantjain-xyz/wallie-dev \
  refs/heads/wallie/checkpoints/5ba156cc-ba2e-40a8-87e8-29e383ef815d/538c7db75b663a795d8ce6fde06b98b4d42ed3e4 \
  538c7db75b663a795d8ce6fde06b98b4d42ed3e4
```

The smoke checks out the exact SHA in one utility sandbox, rejects a mismatched SHA or a
missing ref, and confirms sandbox teardown. It reads GitHub and creates only a
temporary Vercel sandbox. Retain the exact ref, SHA, and cleanup result with the
PR or release review.

For the full Vercel and GitHub lifecycle smoke, use the existing guarded
`scripts/smoke-continuity-release.ts` with exclusive loopback Supabase on API port
50321 and database port 50322. Seed an active human workspace manager and a GitHub
repository binding for `anantjain-xyz/wallie-dev` with numeric ID `1196742316`.
Run the script without `--execute` to preview its fixture scope. The live run
writes its own test refs and opens a smoke PR on its test base. Keep that fixture
history available. [Isolated release proof](../deployment/worker-operations.md#isolated-release-proof).

[op-499-receipt]: https://github.com/anantjain-xyz/wallie-dev/blob/a567807db7a2b3e5d2781fda071130b2407e0622/docs/evidence/op-499-vercel-github-continuity.json
[op-499-pr]: https://github.com/anantjain-xyz/wallie-dev/pull/583
[op-510-rehearsal]: https://github.com/anantjain-xyz/wallie-dev/pull/600
[cloudflare-qualification]: ../deployment/cloudflare-worker.md#qualification-and-cutover
