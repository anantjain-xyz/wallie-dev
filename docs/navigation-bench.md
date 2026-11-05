# Time the five main navigation flows

Run this when a change should make the logged-in workspace feel faster. The benchmark uses a production build, the local Supabase database, and a fixed volume of sessions.

## Before you start

1. Start local Supabase with `supabase start`.
2. Confirm `psql` and Playwright are installed. The benchmark installs Chromium if it is missing.

## Run the benchmark

Run `pnpm bench:navigation`.

The command loads 160 extra sessions into the `acme-corp` workspace, builds the app, and measures each flow 5 times. It prints the median and the range for successful runs, then writes the samples to `bench-results/`.

Use `--skip-build` when the current production build is the one you want to measure. Use `--skip-seed` when the `[bench]` sessions are already loaded. Use `--runs 5` to change the run count. Use `--out bench-results/custom.json` to choose the result file.

## What each flow times

The clock stops when the content below is visible and the workspace shell has hydrated. A run that misses that content, throws a page error, or returns HTTP 500 is a failed run.

1. `pipeline-load`. A new browser context opens `/w/acme-corp`. Ready when the Pipeline heading, the pipeline board, and a session link are visible.
2. `sessions-switch`. From a loaded pipeline page, click Sessions. Ready when the Sessions heading and a session row are visible.
3. `session-open`. From the sessions list, open `[bench] Checkout latency`. Ready when that heading and the pipeline stage navigation are visible.
4. `settings-switch`. From the pipeline page, click Settings. Ready when the Settings heading, the GitHub section, and the Pipeline section are visible.
5. `new-session-modal`. From the pipeline page, click New session. Ready when the title field and the stage picker are visible.

Each sample records the request count, failed requests, transferred script, style, document, and RSC bytes, render-blocking requests, and the server timing records for that request. Server timing is written only when `WALLIE_TIMING_LOGS=1`. The benchmark sets that for the `next start` process.

## Volume

`scripts/bench/seed-navigation-volume.sql` deletes previous `[bench]` sessions and inserts 160 sessions numbered from 1001. Each session has one artifact and one successful run. Session 1001 is the session the benchmark opens, and its artifact is longer than the others. Run the SQL again to rebuild the same rows. `supabase db reset` removes them with the rest of the local database.

## Compare two results

Run both sides with the same `--runs`, the same seed, and a production build. Alternate the sides when the machine is busy. A gap smaller than the run-to-run range is not a measured difference. The server is localhost, so the number does not include a wide-area round trip.
