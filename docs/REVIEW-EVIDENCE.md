# Review evidence and readiness

OP-509 exposes the OP-506 GitHub observations, OP-507 harness receipts, and the
OP-508 server-owned readiness decision in the session review surface. It does
not merge, deploy, approve, or collect provider state by itself.

## What the reviewer sees

The delivery panel appears above the review actions for code-delivery pipelines.
It shows the live evaluator state (`ready`, `checking`, `blocked`, `unknown`,
`merged`, or `closed`), the canonical repository/PR, head and base SHAs, the
observation time and configured freshness, required checks, current-head
approvals, unresolved GitHub and Wallie threads, merge state, named evidence,
and every named blocker. A historical artifact selection keeps the panel visible
but labels the readiness and diff as the current canonical PR rather than the
older artifact. Approval-only completion text never says a PR merged or the code
deployed; merge state comes only from GitHub observations.

Every blocker has a deterministic label and a source link:

- check, review, thread, draft, and mergeability blockers open the canonical PR
  (checks, reviews, or the pull request itself);
- named evidence blockers scroll to the in-page evidence section, where harness
  receipts and private asset downloads are listed;
- blocking artifact feedback opens the existing Comments panel;
- refresh and observation-currency blockers point at the refresh control.

The diff is lazy-loaded. It displays explicit limits instead of silently omitting
content: GitHub files without a text patch are labelled binary/too large, a
truncated patch says so, and a paginated result says that only the first page is
shown and links to GitHub for the complete view. A GitHub head that moved after
the last verification is called out with both SHAs and a refresh instruction.

## APIs

Both routes require an authenticated active workspace member and use
`Cache-Control: private, no-store`.

- `GET /api/sessions/{sessionId}/review-evidence` returns the current evaluator
  detail derived from the same stored state as the final-approval gate. It
  returns `{ "delivery": null }` when the pipeline has no delivery policy. No
  request value can supply a readiness state or an observation.
- `GET /api/sessions/{sessionId}/review-evidence/diff` resolves the canonical
  epoch from the session's server-side synchronization row, mints a read-only
  installation token scoped to that exact repository, verifies the PR identity,
  and returns a bounded first page of changed files. It returns deterministic
  conflicts when no canonical PR exists or repository/installation access is
  unavailable, and fixed provider error codes otherwise.

Refresh uses the existing
`POST /api/sessions/{sessionId}/pr-verification/refresh` endpoint. The panel
shows queued/in-progress/error states, polls a bounded number of times while a
request is pending, permits an explicit retry after failure, and never labels a
merge or deployment from a refresh result. The UI does not write verification
records or approval decisions. It reloads when review threads, the refresh
queue, or stored observations change, and schedules its own re-read when the
displayed observation reaches the configured freshness limit. A refresh-queue
observation from a predecessor PR epoch is never merged with the current
canonical PR: the panel shows the current epoch identity without the
predecessor's head, checks, review, or terminal state.

## Bounds

One diff response contains at most 100 files, 400 patch lines and 24,000 patch
characters per file, and 160,000 patch characters across the response. The
provider response is size- and time-bounded. These are presentation limits, not
readiness limits; GitHub remains the full source.

## Verification

```bash
pnpm test src/features/github/pr-diff.test.ts \
  src/features/sessions/detail/session-review-evidence.test.tsx \
  src/features/sessions/detail/session-review-diff.test.tsx \
  src/lib/pipeline/pr-readiness.test.ts
pnpm check
```

Browser proof covers ready, stale, blocked, refresh failure, large/binary diff,
and historical selection at desktop and 390px widths. GitHub App permissions and
webhook subscriptions remain the rollout prerequisite documented in
[GitHub PR verification](GITHUB-PR-VERIFICATION.md).
