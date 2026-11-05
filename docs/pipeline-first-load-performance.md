# Pipeline first-load bundle split

Pipeline can hydrate and filter sessions before the realtime SDK arrives. Its required app client chunks shrink by 59,443 gzip bytes. Local navigation latency shows no measurable improvement.

## Required JavaScript

Production Turbopack builds on Node 22.23.1 and Next.js 16.3.4. Baseline is merged main at `53bd8a26`.

| Pipeline app client chunks |  Before |   After |   Change |
| -------------------------- | ------: | ------: | -------: |
| Raw bytes                  | 526,381 | 302,018 | −224,363 |
| Gzip bytes                 | 161,545 | 102,102 |  −59,443 |

- These totals exclude Next's separately loaded runtime chunks.
- The SDK still loads for realtime. This moves its dependency out of hydration rather than removing its eventual transfer.
- The navigation benchmark's median script transfer is 371,176 bytes before and 375,284 after. That counter also includes background requests started before readiness.
- `pnpm analyze:authenticated-bundle` checks the split and prints the app client chunk totals.

## Navigation measurements

Five alternating runs per build, using frozen production builds, the same isolated local Supabase fixture, 160 additional benchmark sessions, and the unchanged `bench:navigation` ready conditions. Every sample uses a fresh browser context. All 50 samples pass.

| Flow              | Before median, range in ms | After median, range in ms |
| ----------------- | -------------------------: | ------------------------: |
| Pipeline load     |               189, 181–217 |              198, 188–203 |
| Sessions switch   |               146, 128–395 |              135, 133–140 |
| Session open      |               303, 203–496 |              327, 302–508 |
| Settings switch   |               147, 118–405 |              146, 136–153 |
| New session modal |               139, 115–160 |              122, 111–130 |

The ranges overlap for every flow. These results do not establish a latency improvement or regression. The server is localhost, so the results exclude wide-area network latency.

One separate diagnostic profile attributes about 11 ms of sampled CPU to the eager SDK chunk. React hydration, Pipeline rendering, and other bootstrap work remain. Diagnostic profiles include tracing overhead and are excluded from the latency table.

## Behavior and scope

- The browser regression holds the SDK request open, filters all cards out, restores them, and then releases the request. Navigation still works afterward.
- Recovery registers before the import. Import failures reach the existing retry path, and the first subscription reconciles changes since the server snapshot.
- Unmount and workspace changes invalidate pending imports and stale reads.
- A separate paint/idle navigation-prefetch experiment did not improve Pipeline latency and made immediate tab switches less consistent. It was removed.
- The two session RSC requests are Next's route-tree and page-data phases. The trace confirms `/_tree` prefetch headers on the first request. The existing session prefetch hold remains.
- Session rendering and activity loading are separate follow-ups.

See [the navigation benchmark instructions](navigation-bench.md) to reproduce the production measurements.
