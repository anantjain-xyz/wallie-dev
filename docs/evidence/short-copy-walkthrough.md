# Short error and info copy: review record

This report records the original walkthrough and the November 9 retries. It is a
historical account, not a substitute for Wallie's command receipts. The evidence configuration
copies this UTF-8 report into the command's fresh `WALLIE_EVIDENCE_DIR`.

## Merge-conflict retry: November 9, 2026

Reproduced the reported conflict by merging `origin/main` at `a15f480` into the
existing attempt branch. Only `.wallie/validation-evidence.json` conflicted
(add/add); all application, test, migration, and generated-type changes merged
automatically. Commit `b2f8c0c` records the merge and resolution. No application
copy or behavior needed further changes for this retry.

The combined configuration retains this change's `review/report` walkthrough,
main's focused stage tests as `stage-review/report`, and both browser suites in
one build/run with a required `browser/report` JSON report. Main's `fast-check`,
`unit-suite`, and `cloudflare` command identities are preserved without duplicate
checks. All six command definitions pass the production configuration schema.

Reproduced the original search and comment-draft copy again in `pnpm dev` using
the two unchanged upstream components, then restored the implementation exactly
and repeated both interactions. At 1440px and 390px, the old search showed both
the long unapplied-search hint and unfiltered summary; the updated search showed
only `Press Enter to search.`. The draft buttons changed from `Save comment` /
`Cancel new comment` to `Save` / `Discard`. Eight fresh full-page before/after
screenshots were captured. Git confirmed both components were restored unchanged.

Fresh validation after merging:

| Command / check                                                    | Result                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITEST_MAX_WORKERS=2 taskset -c 0,1 pnpm check`                   | Passed: validation contract, format, lint, TypeScript, privileged imports; 383 unit-test files passed, 5,674 tests passed, two existing credential-gated tests skipped; Cloudflare typecheck, 42 runtime tests, and Wrangler dry run passed. |
| Configured `stage-review` command, with a fresh evidence directory | 92 tests passed; valid UTF-8 JSON report generated (30,034 bytes).                                                                                                                                                                           |
| Configured `browser` command, with a fresh evidence directory      | Production build passed; 34 Playwright tests passed in 42.0 seconds across concise-copy, comment-access, sessions-ledger-hydration, run-failure-guidance, and stage-startup suites; valid JSON report generated (43,109 bytes).              |
| Configuration schema and configured `review` command               | Six unique commands parsed; walkthrough copied byte-for-byte into a fresh evidence directory.                                                                                                                                                |

This retry generated 100 full-page screenshots: the eight before/after captures,
the 76 existing copy/comment/run-failure captures, and 16 stage-startup captures.
Visually inspected the mobile draft and typed search and the desktop save error.
All screenshots remain ignored proof artifacts outside the source diff; the
text-only evidence collector cannot retain their binaries or embed them in a PR.

The authenticated `/w/{workspaceSlug}/sessions` walkthrough remains unavailable:
the local Supabase health request failed with connection refused on port 54321,
Docker is absent, and no authenticated workspace session is available. It requires
an isolated seeded Supabase stack and test credentials. Search submission,
in-flight edits, clearing, query summaries, and request counts remain covered by
the interaction unit tests. No real runs or external test data were created.
No GitHub or tracker writes were made; publication remains with Wallie's trusted
publisher. No linked Linear issue was supplied.

## Interaction-state inventory

| Surface and owner                       | Trigger / state                                                                                                               | Decision                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions command bar                    | Type; submit; edit while pending; receive results; clear; history navigation                                                  | One `Press Enter to search.` hint. Pending requests show `Searching…` or `Updating…`; newer edits show `New edits not searched.`. Hide the previous result summary during navigation. Keep a short applied-query summary so displayed results remain identifiable. Remove the unfiltered summary. Preserve the search description's supported fields and live region. |
| Sessions list and row actions           | No sessions; archived-only; no matches; rename/archive failure                                                                | Shorten empty-state descriptions and use `No matching sessions` / `Adjust filters.`. Existing short row actions and API errors are retained. Archive/restore feedback still identifies the affected session; title-edit controls retain their distinct accessible names.                                                                                              |
| Session creation                        | Repository loading/stale/empty; incomplete input; pending uploads; expired images; rejected or uncertain creation             | Shorten repository/upload instructions and uncertain-creation copy. Preserve the original-request retry instruction because retrying must resolve a potentially committed creation. Retain short URL/stage validation and attachment-specific errors. Existing tests continue to verify exact request replay and attachment safety.                                   |
| Artifact comments                       | Load; permissions unavailable; unauthorized; compose; failed save; retry; reply; edit; discard; approved/archived             | `Save`, `Reply`, `Discard`; one `Draft kept.` suffix. Shorten read-only and empty notices. Preserve the distinct `Edit your comment` field name, permission checking status, block/selection controls, thread status reasons, and conflict recovery. API-provided causes remain intact.                                                                               |
| Revision review                         | First version; empty feedback; loading a submitted batch; no accepted output; compare error                                   | Shorten first-version, empty, and loading labels. Keep Retry Run / reselect-thread recovery. Preserve comparison identity errors, mapped/unmapped passage explanations, and immutable submission metadata: these distinguish historical feedback from current output.                                                                                                 |
| Session review bar                      | Preview error; changed review; unconfirmed submission; artifact changes                                                       | Shorten retained-note/draft and refresh instructions. Preserve explicit reselect, review-latest-output, and retry-this-submission recovery. Approval consequences, blocking-request counts, and permission/stale-artifact restrictions remain specific.                                                                                                               |
| Delivery evidence                       | Historical or non-final stage; load failure; refresh failure; last-loaded fallback; queued/running refresh                    | Short historical/advisory notices, `Evidence unavailable. Retry to confirm readiness.`, `Verification queued.`, `Verifying…`. Remove the automatic-update explanation; shorten delivery success and empty summaries. Preserve check/review sources, stale PR identity, exact accepted commit/tree, required evidence, and refresh-failure recovery.                   |
| Run activity                            | Usage unavailable; collapsed/expanded failure; legacy failure without cause                                                   | `Usage not reported`; shorter legacy fallback. Retain persisted category/cause and targeted recovery for credentials, sandbox, repository, timeout, budget, and publication. These explain distinct actions and are not interchangeable with a generic retry. Provider diagnostics and agent-authored activity are unchanged.                                         |
| Settings: workspace/members             | Open invite dialog; invalid name/email; failed/successful save; member removal; workspace deletion/leave                      | Shorten section and invitation descriptions. Retain short field validation, role/owner restrictions, invitation expiry/access explanations, and destructive consequences. No role, workflow, or endpoint changes.                                                                                                                                                     |
| Settings: integrations                  | GitHub callback failure; repository setup; Linear removal; sandbox selection/disconnect; agent access                         | Shorten section summaries, callback errors, and Linear-key removal copy. Preserve missing-key detail, OAuth/device sign-in instructions, saved-connection behavior, no-provider-fallback guarantee, secret deletion consequences, and capability-check recovery.                                                                                                      |
| Settings: pipeline/policies/maintenance | Invalid pipeline; failed save; retry; restore stage; stale policy; saved policy; maintenance results                          | Shorten shared pipeline save failures and restoration guidance, policy conflict/success, and maintenance summaries. Retain field-specific validation, slug conflict recovery, archive consequences, policy limit units, and required reload actions.                                                                                                                  |
| Onboarding                              | Pipeline validation/save failure; failed step acknowledgement; verification idle/pending/stale/success; missing prerequisites | Shorten pipeline-save errors and verification descriptions. Keep blocker names/actions, connection instructions, read-only manager guidance, and verification failure detail.                                                                                                                                                                                         |
| Shared page failure and action feedback | Missing page; route error; retry; success                                                                                     | Shorten the explanatory paragraph. Keep descriptive headings, return destinations, and retry actions. Shared pending labels (`Saving…`, `Loading…`, etc.) are already brief; keep button busy states and polite/assertive announcements.                                                                                                                              |

No API response structures, error codes, backend transitions, schema, permissions,
search queries, diagnostic logs, or user-authored text were changed.

## Reproduction

Installed pinned dependencies with `corepack enable` and `pnpm install --frozen-lockfile`,
then installed Playwright Chromium. Launched `pnpm dev` with local preview-only
Supabase public configuration. Before editing, Playwright confirmed at 1440px and
390px that typing `retry` produced both the long unapplied-search instruction and
the unfiltered summary. Opening a block comment and typing a draft showed
`Save comment` and `Cancel new comment`. Full-page before screenshots were captured
for both interactions at both widths.

## Commands and outcomes

The retry inspected the five recovered commits and reinstalled pinned dependencies
without changing the lockfile. Its first full `pnpm check` completed with two stale
empty-state assertions (5,630 tests passed). Those assertions were aligned with the
shortened first-run and archived copy; the focused empty-state tests then passed.
The focused search suite also passed all 23 tests, including pending navigation,
later edits, history, clearing, and exact request counts.

The production build passed. All 30 selected Playwright tests passed in 48.7 seconds,
including the added mobile keyboard/selection and initial permission-loading/error
checks. The final full gate passed: 380 unit-test files (5,632 tests), Cloudflare native
typechecking, 42 Cloudflare runtime tests, and the Wrangler worker dry run. The two
live sandbox smoke tests remain conditionally skipped without provider credentials.

The original attempt encountered exit 137 under the sandbox's 4 GiB memory limit.
Next.js detects 64 CPUs despite the two-CPU quota, so builds use `CIRCLE_NODE_TOTAL=3`
(two page-data workers). The retry's final gate bounds CPU affinity and Vitest
workers; no validation steps are skipped by these resource settings.

| Command                                                                                                                                                                              | Outcome                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                                                                                                     | Passed; lockfile unchanged.                                                                                                                                                                                   |
| `pnpm dev` + Playwright reproduction (original attempt)                                                                                                                              | Confirmed original search and draft copy at 1440px and 390px before edits.                                                                                                                                    |
| `CIRCLE_NODE_TOTAL=3 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=playwright-local-key NEXT_PUBLIC_APP_URL=http://localhost:3100 pnpm build` | Passed; compilation 22.0 seconds, TypeScript 21.8 seconds, two page-data workers.                                                                                                                             |
| `pnpm exec playwright test e2e/concise-copy.spec.ts e2e/comment-access.spec.ts e2e/sessions-ledger-hydration.spec.ts e2e/run-failure-guidance.spec.ts`                               | 30 passed, 48.7 seconds against the production build.                                                                                                                                                         |
| `pnpm test src/features/sessions/list/sessions-command-bar.test.tsx --maxWorkers=1 --reporter=verbose`                                                                               | 23 passed.                                                                                                                                                                                                    |
| `pnpm test src/features/sessions/components/sessions-zero-state.test.tsx --maxWorkers=1`                                                                                             | 2 passed after correcting the stale assertions.                                                                                                                                                               |
| `VITEST_MAX_WORKERS=4 taskset -c 0,1 pnpm check`                                                                                                                                     | Passed: validation contract, formatting, lint, typecheck, privileged imports; 5,632 unit tests passed (2 credential-gated skips); native Cloudflare typecheck, 42 runtime tests, and Wrangler dry run passed. |
| Evidence configuration schema and report-copy command                                                                                                                                | Passed: five command definitions parsed; review command copied this UTF-8 report byte-for-byte into a fresh evidence directory.                                                                               |

## Browser walkthrough and proof

`e2e/concise-copy.spec.ts` runs at 1440px and 390px against a production build. It
captures full-page screenshots of typed/cleared search, empty states, an active
comment draft, save failure, saved comments, invalid pipeline, failed/successful
pipeline save, route error/recovery, Settings loading/error/loaded/usage states,
workspace save failure, invite dialog, artifact evidence, delivery loading/failure/
queued refresh, onboarding validation/save failure, saved pipeline with failed
step acknowledgement, and verification guidance.

Comment-access tests now cover keyboard block comments, passage selection,
approved/archived read-only reasons, loading and failed permission checks, restored
reply drafts, and close-button focus at both desktop and mobile widths. Run-failure tests cover collapsed, expanded,
and detailed recovery guidance. Ledger tests cover the real row tree, links, action
menus, and mobile layout. Existing ledger selectors were updated to measure the clipping
wrapper rather than the minimum-touch-height title link; run-activity selectors
now include the existing attempt/run identity. Screenshots are generated outside
the source diff. The retry produced 76 full-page captures: 50 from the copy walkthrough and 26
from comment-access and run-failure checks. The original attempt recorded four
before-change captures; their binaries were not recovered in this retry checkout.
The retry regenerated after-change screenshots and visually inspected the mobile
composer and desktop save-error state.

## Limits and cleanup

The `/dev/sessions-ledger` typing fixture proves command-bar interaction and clearing;
it does not prove authenticated database-backed search. Submission, later edits,
applied queries, filter preservation, pagination reset, whitespace, history, and
exact request counts are covered by command-bar tests. The authenticated
`/w/{workspaceSlug}/sessions` walkthrough and auth-dependent Playwright suites could
not run: this checkout has no Supabase service, Docker executable, or authenticated
workspace session. Running those suites requires an isolated local Supabase stack
with the repository seed and test credentials. A local health request failed with
connection refused on port 54321. No production service was contacted. The two
credential-gated live sandbox smoke tests are also unavailable without E2B/Daytona
API keys; these are the suite's existing conditional skips.

All mutation endpoints used by the new browser tests are intercepted. No external
rows, tracker comments/issues, GitHub refs, PRs, or other test data were created.
No worker was started because no real session execution was tested. Screenshots
remain local proof artifacts and are excluded from commits. The text evidence
mechanism does not retain their binaries. GitHub screenshot embeds and PR writes
are left to Wallie's trusted publisher under the publication policy.

## Diff and local commits

The change updates UI-owned copy and existing label assertions, adds deterministic
preview/browser coverage, and retains this inventory through the evidence config.
It does not change API response shapes or diagnostic logs. Screenshots are excluded
from the 57-file source diff.

- `fe60781`: shorten error and informational copy across the audited surfaces.
- `f0b3a5b`: trim delivery summaries and align their assertions.
- `ca9fc45`: add interaction coverage, preview fixtures, and evidence configuration.
- `16182ae`: align Settings success-feedback assertions.
- `f9285b6`: preserve the original browser/runtime validation record.
- `cbcf00a`: finish mobile keyboard/permission coverage and empty-state assertions.
- The final documentation commit records this retry's completed validation.

No linked Linear issue was supplied. No PR or tracker writes were made; Wallie's
trusted publisher owns publication. Screenshot embeds were not written to GitHub
because the platform policy prohibits agent GitHub writes and does not retain
binary screenshots through the text-report evidence mechanism.
