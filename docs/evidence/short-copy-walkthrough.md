# Short error and info copy: review record

This report records the local walkthrough for this change. It is a historical
account, not a substitute for Wallie's command receipts. The evidence configuration
copies this UTF-8 report into the command's fresh `WALLIE_EVIDENCE_DIR`.

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

The production build and all 27 selected Playwright checks passed. Earlier runs exposed
stale copy assertions and browser selectors, which were corrected. One build and
one concurrently running check process exited 137 under the sandbox's 4 GiB memory
limit. Next.js detected 64 CPUs and initially spawned 63 page-data workers. The
production build passed with `CIRCLE_NODE_TOTAL=3` (two Next.js workers). CPU affinity
bounds Vitest workers for the full check; no validation steps are skipped.

| Command                                                                                                                                                                              | Outcome                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                                                                                                     | Passed; lockfile unchanged.                                               |
| `pnpm dev` + Playwright reproduction                                                                                                                                                 | Confirmed the original search and draft copy at both widths before edits. |
| `CIRCLE_NODE_TOTAL=3 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=playwright-local-key NEXT_PUBLIC_APP_URL=http://localhost:3100 pnpm build` | Passed after bounding Next.js workers.                                    |
| `pnpm exec playwright test e2e/concise-copy.spec.ts e2e/comment-access.spec.ts e2e/sessions-ledger-hydration.spec.ts e2e/run-failure-guidance.spec.ts`                               | 27 passed, 48.1 seconds (final production build).                         |
| `taskset -c 0,1,2,3 pnpm check`                                                                                                                                                      | Final run in progress; outcome recorded before completion.                |
| Evidence configuration schema and report-copy command                                                                                                                                | Parsed successfully; report copied into a fresh evidence directory.       |

## Browser walkthrough and proof

`e2e/concise-copy.spec.ts` runs at 1440px and 390px against a production build. It
captures full-page screenshots of typed/cleared search, empty states, an active
comment draft, save failure, saved comments, invalid pipeline, failed/successful
pipeline save, route error/recovery, Settings loading/error/loaded/usage states,
workspace save failure, invite dialog, artifact evidence, delivery loading/failure/
queued refresh, onboarding validation/save failure, saved pipeline with failed
step acknowledgement, and verification guidance.

Existing comment-access tests cover keyboard block comments, passage selection,
approved/archived read-only reasons, loading and failed permission checks, restored
reply drafts, and close-button focus. Run-failure tests cover collapsed, expanded,
and detailed recovery guidance. Ledger tests cover the real row tree, links, action
menus, and mobile layout. Existing ledger selectors were updated to measure the clipping
wrapper rather than the minimum-touch-height title link; run-activity selectors
now include the existing attempt/run identity. Screenshots are generated outside
the source diff.

## Limits and cleanup

The `/dev/sessions-ledger` typing fixture proves command-bar interaction and clearing;
it does not prove authenticated database-backed search. Submission, later edits,
applied queries, filter preservation, pagination reset, whitespace, history, and
exact request counts are covered by command-bar tests. The authenticated
`/w/{workspaceSlug}/sessions` walkthrough and auth-dependent Playwright suites could
not run: this checkout has no Supabase service, Docker executable, or authenticated
workspace session. Running those suites requires an isolated local Supabase stack
with the repository seed and test credentials. No production service was contacted.

All mutation endpoints used by the new browser tests are intercepted. No external
rows, tracker comments/issues, GitHub refs, PRs, or other test data were created.
No worker was started because no real session execution was tested. Screenshots
remain local proof artifacts and are excluded from commits. The text evidence
mechanism does not retain their binaries. GitHub screenshot embeds and PR writes
are left to Wallie's trusted publisher under the publication policy.
