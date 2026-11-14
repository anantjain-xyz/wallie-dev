# Marked-page quiet allowance

**The marked-page allowance is removed; the end-to-end latency comparison is inconclusive.** Separate profiles confirm the intended timer changes from 79 ms to zero. The generic 80 ms fallback, final animation frame, and 2,000 ms deadline remain.

## Change

- Start: latest main `31b1728b`, after the [prefetch investigation](session-prefetch-wait-investigation.md). Implementation: `99b887db`.
- [The session link](../../src/features/sessions/components/session-detail-link.tsx) latches validated page-data evidence and schedules zero-delay completion. Later tree observations cannot reintroduce the allowance.
- The existing helper still requires current-intent, same-origin, bodyful, successful marked page data. Unmarked/unsupported/failed evidence follows the existing fallback; missing matching responses retain the deadline.
- Observer cleanup and the final frame precede navigation. Prefetch lifecycle and Next cache behavior are unchanged.
- Main advanced to `4c6060ee` during measurement. Its unrelated delivery-policy changes were merged afterward. Final review also removed two redundant comment blocks. Executable behavior, the timing helper, Next configuration, and benchmark files stay as measured.

## Before/after

Native click to the expected latest v1 artifact and enabled review controls across a painted frame, in milliseconds:

| Condition/input              | Before median (range) | After median (range) | Verdict      |
| ---------------------------- | --------------------: | -------------------: | ------------ |
| Default, immediate mouse     |   269.7 (195.1–290.4) |  196.1 (188.0–518.8) | Inconclusive |
| Default, touch               |   265.3 (180.5–272.6) |  191.2 (173.9–197.9) | Inconclusive |
| Constrained, immediate mouse |   731.6 (729.0–751.8) |  746.5 (728.8–802.5) | Inconclusive |
| Constrained, touch           |   749.0 (729.1–753.9) |  741.6 (735.8–753.9) | Inconclusive |

- Five untraced samples per side, input, and condition: **40/40 pass**, including the expected artifact and successful Request changes action. Zero failed requests under the harness's separate aborted-RSC accounting.
- Default medians are lower, but ranges overlap and local variability exceeds the proposed saving. These samples do not establish an end-to-end speedup. The constrained results show no clear difference.
- Alternating frozen production builds and reversed order by repeat; fresh browser contexts after list warmup. No concurrent builds or test suites during this matrix.
- Same [harness and endpoint](navigation-bench.md): the benchmark spec and driver hashes are unchanged. Session-only mode retains the native-click probe and review-ready mark before selector checks.
- Same isolated local Supabase fixture, with migrations through OP-504 and 160 additional benchmark sessions. Chromium 149.0.7827.55; 10-core desktop host with other desktop processes retained.
- Default: CPU 1×, no configured network delay. Constrained: CPU 4×, 80 ms HTTP latency, 1600 kbps down, 750 kbps up. Server/database traffic stays local; these are desktop lab conditions.

[Samples, conditions, hashes, branch traces, and verification](../evidence/session-marked-page-wait-performance.json).

## Explain the number

Eight separate instrumented profiles establish the changed mechanism. Their durations are excluded from the comparison above.

| Observation                                             | Before                   | After                    |
| ------------------------------------------------------- | ------------------------ | ------------------------ |
| Three default profiles: marked branch replacement timer | 79 ms each               | 0 ms each                |
| Default profile push from click                         | 162.3–180.8 ms           | 90.1–105.0 ms            |
| Constrained touch profile: tree fallback                | 80 ms                    | 80 ms                    |
| Final frame; hard deadline cleared before firing        | All profiles             | All profiles             |
| Destination RSC requests, every untraced sample         | Default 2; constrained 3 | Default 2; constrained 3 |

The default profiles observe marked-page EOF before completing the app wait. The constrained profiles navigate through the tree fallback before marked-page data is observed, so they never execute the changed branch. Body EOF, resource timing, observer delivery, and Next cache writes remain distinct observations.

The slow untraced default after-sample reaches review-ready at 518.8 ms. It pushes at 111.1 ms; marked page data ends at 130.6 ms. The unchanged fallback therefore wins before the modified branch can run. Artifact appears at 429.0 ms. The post-push gap is consistent with the previously identified React commit deadline, but that attribution for this untraced sample remains an inference.

A separate constrained after-profile reaches review-ready at 1042.5 ms versus 738.3 ms before. Its initial route scripts finish 68.8 ms later, followed by a source-matched React `"Throttled"` commit timer from 650.6 to 889.7 ms. The 239 ms timer is an observed post-download gate in unchanged React code; the React chunk hash matches both builds. An earlier 289 ms timer overlaps script downloads and must not be added to that interval. The app's unchanged tree fallback completes at 166.9 ms, before any marked-page evidence. These profiles explain a tail; they do not establish a candidate regression.

## Limits and next work

- Remaining work includes page-data transfer/observation, initial route scripts, React render/commit, and approval-review HTTP. Removing timer waiting does not establish a CPU improvement.
- The partial-head fallback and its third constrained RSC request remain as described in the prior investigation. This patch does not change that selection policy.
- The harness records requests through 250 ms after observed readiness. Counts do not establish total background-query reduction; deferred SDK recovery can occur later.
- Five samples per side and the recorded spread limit the conclusion. Stop this bounded experiment at the inconclusive result; no extra samples were selected to obtain a favorable claim.

Pstack's Explain the Number kept profiles separate from untraced measurements and limited the claim to the verified branch change. Sequence Verifiable Units kept baseline, implementation, browser checks, and comparison independently reviewable.

## Validation

- Both production builds pass. Route budgets and authenticated-bundle guards pass on the candidate.
- After the main merge, `pnpm check:fast` passes; `pnpm test --maxWorkers=4`: 4,952 passed, two existing skips.
- `pnpm check:cloudflare`: 35 tests pass; native types and Wrangler dry run pass.
- Eight production browser cases pass: prefetch intent/marker, native-click delayed tree/page reuse and back navigation, missing-marker fallback, failed-prefetch recovery, and both held-SDK cases.
- New client tests cover marked completion, buffered evidence, unmarked/failed/unsupported/stale/foreign evidence, missing/bodyless responses, final frame, deadline, and once-only navigation.
- All five existing navigation smoke flows pass. Screenshots add no evidence for this timing-only change; branch traces and artifact/action checks verify its behavior.

Raw samples and diagnostic traces remain in `bench-results/session-marked-page-wait/`. The comparison uses the same benchmark spec and driver as the prior investigation; their hashes and raw artifact hashes are retained in the evidence.

throughput checkpoint: n/a, bounded client timer change
