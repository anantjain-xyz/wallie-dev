# Time the five main navigation flows

Run this when a change should make the logged-in workspace feel faster. The benchmark uses a production build, the local Supabase database, and a fixed volume of sessions.

## Before you start

1. Start local Supabase with `supabase start`.
2. Confirm `psql` and Playwright are installed. The benchmark installs Chromium if it is missing.

## Run the benchmark

Run `pnpm bench:navigation`.

The command loads 160 extra sessions into the `acme-corp` workspace, builds the app, and measures each flow 5 times. It prints the median and the range for successful runs, then writes the samples to `bench-results/`.

Use `--skip-build` when the current production build is the one you want to measure. Use `--skip-seed` when the `[bench]` sessions are already loaded. Use `--runs 5` to change the run count. Use `--out bench-results/custom.json` to choose the result file.

## Measure session review readiness

Run `pnpm bench:navigation --session-only --session-intent immediate`. The default intent keeps the existing mouse-click flow. Other intent values are `settled`, which waits for hover prefetch responses before clicking, `keyboard`, which focuses the row then presses Enter, and `touch`, which taps at a 390px viewport with touch enabled. Use `--supabase-workdir /path/to/local/project` for an isolated local Supabase stack.

Session samples retain the original `durationMs` metric and add `sessionOpen` timings from browser marks:

| Field                  | Boundary                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `clickToPushMs`        | Native click capture to the router's push call                                                                    |
| `clickToArtifactMs`    | Native click to the expected rendered latest artifact                                                             |
| `clickToReviewReadyMs` | Native click to a painted frame with the expected artifact and enabled Approve stage and Request changes controls |
| `pushToReviewReadyMs`  | Router push to that review-ready frame                                                                            |
| `rscResponses`         | Destination RSC request start and response end, relative to the native click                                      |

The readiness check requires the seeded Checkout latency heading, its expected paragraph, and the v1 Latest label. It checks that Request changes loads a review successfully after the timed region. Run activity and the unopened comments panel are separate work and do not delay this metric. Browser marks exclude Playwright's actionability and pointer setup time. Resource timings remain intact between intent and click so the app can observe its prefetch responses. Request recording extends 250 ms after the benchmark observes readiness to capture later recovery reads.

Reported runs disable Playwright tracing. Use `--profile --session-only --trace-out bench-results/session-open.trace.json` for a separate Chrome diagnostic trace with browser tasks, CPU samples, network work, and the same marks. Profiling defaults to one run. The result JSON labels these runs `diagnostic`; do not use their durations for before/after claims.

### Separate request waiting from browser work

The result records the production build ID, Chromium version, and browser conditions. Use these flags to constrain the timed interaction:

| Flag              | Default | Meaning                                           |
| ----------------- | ------: | ------------------------------------------------- |
| `--cpu-rate`      |     `1` | Browser CPU slowdown multiplier, at least 1       |
| `--latency-ms`    |     `0` | Minimum browser request latency in milliseconds   |
| `--download-kbps` |    `-1` | Download kilobits per second, or -1 for unlimited |
| `--upload-kbps`   |    `-1` | Upload kilobits per second, or -1 for unlimited   |

Conditions apply after the list warmup and before the timed interaction. Browser networking is constrained; server-to-database networking remains local. Use the same values for every compared sample. A constrained desktop browser is not a measurement of a physical mobile device.

```bash
pnpm bench:navigation --session-only --session-intent touch --cpu-rate 4 --latency-ms 80 --download-kbps 1600 --upload-kbps 750
```

`sessionOpen.intentEvents` records pointer entry, pointer down, focus, prefetch, and click relative to the native click. An immediate Playwright click can start prefetch on hover before its click. A touch tap can also focus the link. These fields expose that lead time instead of treating either flow as guaranteed unprefetched navigation.

Session-only runs wait on the browser readiness mark before running Playwright's URL, heading, and control assertions. This keeps selector and style inspection out of the primary click-to-review-ready interval. Their `durationMs` still ends at stage readiness, using the browser's stage mark instead of the test driver's observation. The default five-flow mode retains its original locator timing. Compare session-only samples produced by the same harness revision.

Diagnostic runs profile every requested run. `--trace-out bench-results/session-open.trace.json --runs 3` writes `session-open.trace-run1.json` through `session-open.trace-run3.json`, with a matching `.network.json` sidecar per run. The sidecar contains:

- CDP request, response-header, body-byte, completion, and failure events for the destination. Only routing and content/timing headers are retained.
- Diagnostic-only observer delivery, timer callback IDs and firing, animation frames, digest completion, and destination fetch-reader events. Browser event times use `performance.now()`; CDP event timestamps use monotonic seconds, and each request also records its epoch wall time.
- No response bodies, auth headers, or cookies.

These probes add work. Keep diagnostic traces separate from untraced latency samples. Reader completion, CDP network completion, and `PerformanceResourceTiming.responseEnd` are distinct observations; do not substitute one for another without checking the trace.

## What each flow times

The clock stops when the content below is visible and the workspace shell has hydrated. A run that misses that content, throws a page error, or returns HTTP 500 is a failed run.

1. `pipeline-load`. A new browser context opens `/w/acme-corp`. Ready when the Pipeline heading, the pipeline board, and a session link are visible.
2. `sessions-switch`. From a loaded pipeline page, click Sessions. Ready when the Sessions heading and a session row are visible.
3. `session-open`. From the sessions list, open `[bench] Checkout latency`. Ready when that heading, the pipeline stage navigation, and a stage button are visible.
4. `settings-switch`. From the pipeline page, click Settings. Ready when the Settings heading, the GitHub section, and the Pipeline section are visible.
5. `new-session-modal`. From the pipeline page, click New session. Ready when the title field and the stage picker are visible.

Each sample records the request count, failed requests, transferred script, style, document, and RSC bytes, render-blocking requests, and the server timing records for that request. Render-blocking counts include only resources that start after the clock starts, so a warmup page is not charged to the click. An even number of successful runs reports the average of the two middle durations. The diagnostic row is the upper of those two when the count is even. Server timing is written only when `WALLIE_TIMING_LOGS=1`, and the JSONL path is `WALLIE_TIMING_LOG_PATH`. The benchmark sets both for the `next start` process.

Script transfers include background requests that start before readiness, even when they finish during sample collection. They are not the same as the JavaScript required to hydrate the page. Server timings can also include navigation prefetches. The summary's server duration is the largest loader duration in that sample, not the total time for the Pipeline document.

## Inspect required client JavaScript

After `pnpm build`, run `pnpm analyze:authenticated-bundle`. Its `initialRouteJavaScript` output reports deduplicated client-entry chunks in raw and gzip bytes. Next's separate runtime chunks are excluded. The check rejects an eager create-session form on Pipeline, Sessions, Settings, or session detail, and an eager Supabase SDK on Pipeline or session detail.

The board starts the realtime SDK after hydration. A delayed or failed SDK load still uses the existing subscription recovery and snapshot reconciliation. Run `pnpm exec playwright test e2e/pipeline-first-load.spec.ts` against the production build and local Supabase to verify that Pipeline filters work while the SDK request is blocked.

Session detail also loads the SDK asynchronously for detail, activity, and approval subscriptions. Run `pnpm exec playwright test e2e/session-sdk-deferral.spec.ts` with the benchmark seed to verify review controls and activity while the SDK is blocked, authenticated recovery after release, and cleanup during navigation. The authoritative HTTP approval check still runs immediately.

## Volume

`scripts/bench/seed-navigation-volume.sql` deletes previous `[bench]` sessions and inserts 160 sessions numbered from 1001. Each session selects every active stage in its pipeline and has one artifact and one successful run. Session 1001 is the session the benchmark opens, and its artifact is longer than the others. Run the SQL again to rebuild the same rows. `supabase db reset` removes them with the rest of the local database.

## Compare two results

Run both sides with the same `--runs`, the same seed, and a production build. Alternate the sides when the machine is busy. A gap smaller than the run-to-run range is not a measured difference. The server is localhost, so the number does not include a wide-area round trip.
