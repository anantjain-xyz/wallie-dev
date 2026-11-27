# Signed-in runtime response budgets

`pnpm bench:authenticated` checks how much data the production app actually sends to a signed-in user. It complements the static route JavaScript budgets and doesn't gate on latency.

## Run locally

Use a clean, disposable checkout with dependencies installed, Supabase CLI 2.113.0, Docker, and `psql`. Don't point it at a shared database or run it with a dev server, worker, or other benchmarks active. The checkout must not contain auto-loaded `.env` files. If stale generated types from `next dev` break the build, recreate the checkout rather than bypassing TypeScript.

```sh
SUPABASE_TELEMETRY_DISABLED=1 supabase start --exclude studio,edge-runtime,logflare,vector,supavisor
pnpm bench:authenticated
```

The benchmark requires the stock demo seed. It adds 160 sessions, then grows the same fixture to 3,200 (178 and 3,218 total). The fixed IDs, stage and status mix, archived rows, failed runs, and 4,063 B / 112,562 B Markdown artifacts reproduce the audit workload. The seed refuses other data and doesn't enqueue work. Run `supabase db reset --local` on the **disposable stack only** before a replay. The benchmark uses the normal `pnpm build`, with its TypeScript gate enabled, and starts Next on `127.0.0.1:3102`. It reads the loopback keys from the local CLI and signs in via the real email confirmation route without sending mail. No hosted keys, remote agent runs, or provider integrations are used.

The default is two warmups and five measured sweeps per volume, with the case order reversed on alternating measured sweeps. Use `--runs N` (1–15) to change the number of measured sweeps, and `--out FILE` to retain multiple reports. Run comparisons on the same machine and stack configuration, alternating the revisions and preserving the fixture and sample count. Don't run a build, trace, or inspector alongside the timed sweeps.

## Reading the gate

The benchmark requires exact HTTP 200 and the expected media type, doesn't follow redirects, and rejects error streams or missing route markers. On Pipeline it checks populated board links, four JSON lanes, the expected matching total, and at most 25 cards per lane with a cursor when more match. The board document accepts the legacy Pipeline heading or a Sessions heading with Board selected, but never a heading alone. On the Sessions ledger it checks actual row links, up to 50, in first-page order for synthetic rows. The Awaiting review cases exclude archived sessions and runs that override their phase as Failed. On detail it verifies the fixture title and artifact, including the last section of the long artifact. Separate untimed checks require HTTP 401 for an anonymous caller and HTTP 404 for a signed-in nonmember on the Pipeline and long-artifact APIs.

The body budgets below count identity-encoded response bytes with HTTP framing removed. They use the largest warmed response at pinned main `d3ffb34acbf0ffff7900ffb342f5f9d459eb8956` as a baseline, with rounded headroom for incidental markup and asset metadata changes. Review these numbers when intentionally changing the response; don't raise them to make a regression pass.

| Case                     | 178 sessions: baseline → ceiling (B) | 3,218 sessions: baseline → ceiling (B) |
| ------------------------ | -----------------------------------: | -------------------------------------: |
| Pipeline document        |                    296,007 → 325,000 |                      313,178 → 345,000 |
| Pipeline JSON            |                      56,288 → 64,000 |                        56,636 → 64,000 |
| Pipeline Awaiting review |                      23,556 → 27,000 |                        56,656 → 64,000 |
| Ledger document          |                    274,628 → 305,000 |                      274,643 → 305,000 |
| Ledger Awaiting review   |                    234,489 → 260,000 |                      282,455 → 312,000 |
| Short detail document    |                    112,188 → 126,000 |                      112,188 → 126,000 |
| Long detail document     |                    796,052 → 850,000 |                      796,052 → 850,000 |
| Short detail Flight      |                      50,305 → 57,000 |                        50,305 → 57,000 |
| Long detail Flight       |                    416,304 → 440,000 |                      416,304 → 440,000 |

The timing JSON reports per-case medians, ranges, and valid/failed counts. Document and Flight readiness is the arrival of the chunk completing the required content markers, verified after the full response drains. JSON readiness is full-body receipt, followed by JSON and row validation. Neither marks browser paint or interactivity; Flight is a full-tree request, not a router click or prefetch. For click-to-review-ready and separate browser CPU/network traces, use the [navigation benchmark](navigation-bench.md) on its own disposable fixture. For database costs use separate query plans; returned row caps don't measure the number of rows Postgres examined.

The pull-request workflow runs on app, schema, dependency, or harness changes and can also be dispatched manually. It uploads only the numeric timing report and fixed case names/status/failure codes to `authenticated-runtime` (seven-day retention), never response bodies, cookies, URLs, auth state, or traces. Locally the same report defaults to `bench-results/authenticated-runtime.json`. Correctness and byte/row failures exit nonzero; a 20-second request deadline bounds broken requests, but medians and ranges are trend data only.

Run `node --test scripts/bench/runtime-http.test.mjs` to verify the gate rejects login redirects, wrong content markers, streamed errors, and over-budget bodies without starting Supabase.
