# GitHub PR verification collection

OP-506 collects authoritative GitHub observations for canonical session PRs.
It does not compute overall Ready, approve artifacts, merge PRs, or change
production settings. OP-507 supplies execution evidence; OP-508 combines the
observations and evidence into readiness decisions.

## GitHub App access

The installation must grant repository read access to `contents`, `checks`,
`statuses`, `pull_requests`, `actions`, `administration`, and `metadata`.
Wallie's existing publishing paths still need write access to contents and
pull requests. The collector uses an installation token restricted to the
session's numeric repository identity and read permissions. An installation
grant of write access does not give the collector a write token.

Classic branch protection requires **Administration: read**. A 404 without
that verified permission cannot establish that the branch is unprotected.
[GitHub's branch protection API](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection)
documents the permission. The separate
[rules-for-a-branch API](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch)
returns active applicable rules across repository and organization levels;
its metadata permission does not replace classic protection access.

Subscribe the App to these events at `/api/github/webhooks`:

- `check_run`, `check_suite`, and `status` for check and status changes.
- `pull_request`, `pull_request_review`, `pull_request_review_comment`, and
  `pull_request_review_thread` for PR state and review changes.
- `push` for head and base branch changes.

GitHub delivers installation lifecycle events automatically.
Each delivery is signature-verified before it can enqueue a refresh. The
delivery ID deduplicates a repeated notification; payloads provide scope and
invalidation signals, not successful verification results. See GitHub's
[event and delivery header reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads).
Periodic reconciliation recovers missed events and settings changes.

Changing an App permission is a separate operator action: update its requested
permissions, have each installation owner approve them, then rerun the audit.
This PR does not perform those changes. Missing permissions and subscriptions
must remain visible during rollout.

## Observation boundaries

Collection reads the pinned canonical PR, its exact head and base, current
checks and source Apps, applicable protection and rules, review decisions,
unresolved review threads, and mergeability. It verifies the PR identity again
before accepting a snapshot. Results for another head or repository cannot
satisfy the current observation. Test-merge checks and workflow provenance are
handled according to GitHub's required-check semantics.

An empty or unavailable check list is not a passing check result. Unknown
mergeability, unsupported repository rules, incomplete pagination, access loss,
rate limiting, and identity changes produce explicit nonpassing outcomes.
Only normalized evidence is retained; provider credentials and arbitrary
provider error bodies are excluded.

Collection does not require generic artifact approval and does not bypass it.
See the independent [delivery policy contract](DELIVERY-POLICY.md).

## Queue and recovery

At most one refresh queue entry exists per session. Events received during an
in-flight collection advance its generation; the older claim cannot publish a
current observation. Policy, review revision, checkpoint, canonical PR epoch,
and repository identity are fenced again when a claim finishes. Dirty or failed
entries invalidate historical verification currentness immediately.

Periodic admission selects at most 20 due sessions per cycle (RPC maximum 100).
The worker bounds each collection batch to three claims and 40 seconds. Claims
have two-minute leases, so a worker crash does not permanently lose the refresh.
After success the next poll is half the configured freshness, bounded between
30 and 300 seconds. Failures retry with exponential backoff between 30 and 900
seconds. Delivery deduplication records are retained for seven days and pruned
in bounded batches.

## Read-only permission smoke

Use the existing `anantjain-xyz/wallie-dev` repository. This audit reads one
existing PR and mints a short-lived token scoped to that repository. It does
not create a repository, branch, PR, check, webhook delivery, or settings change.
The output contains permission names, event names, identities, HTTP status
codes, and counts. Tokens, private keys, provider bodies, and review content
are not printed or saved.

Load the appropriate server environment privately, then run:

```bash
node --env-file=/private/path/to/server.env \
  --import ./scripts/register-server-only.mjs --import tsx \
  scripts/audit-github-pr-verification.ts \
  --repository anantjain-xyz/wallie-dev --repository-id 1196742316 \
  --pr 592 --output docs/evidence/op-506-github-permissions.json
```

The audit verifies access, not readiness. Its list probes request one page,
and the existing PR may already be merged. Full collection fixtures cover
pagination, stale head/base races, duplicate and reordered signals, check
identity, and failure handling. A failed audit reports only its stage and
HTTP status; do not paste credentials or raw provider errors when diagnosing it.
If the configured App cannot resolve the repository installation, it writes a
partial audit and exits unsuccessfully. That report describes the configured
environment only; a development App's permissions do not establish production
permissions. An operator-token smoke is separate evidence and cannot establish
that the installed App has the same access or event subscriptions.

## Qualification evidence for OP-506

The [configured local App audit](evidence/op-506-github-permissions.json) on
November 6, 2026 identified `wallie.dev.local` (App 4361881). That App could not
resolve an installation for `anantjain-xyz/wallie-dev` (HTTP 404), lacked
Administration read access, and had no event subscriptions. A separate
app-authenticated installation inventory returned no installations. These are
local configuration blockers; production App configuration was not inspected
or changed. Before enabling collection in an environment, its operator must
verify the intended installation, grant the documented read permissions, and
approve the subscriptions. The audit must pass using that environment's App.

The separate [operator smoke](evidence/op-506-github-collector-smoke.json) read
existing wallie-dev PR #592 with the authorized GitHub CLI user's credentials.
The collector observed the PR as merged, verified protection, and collected
passing checks, reviews, and threads. Unknown mergeability remained explicit
with `github_mergeability_unknown`; collection did not invent a passing value.
This smoke proves the reader's live API compatibility for that PR. It does not
prove App access, actual webhook delivery, or overall readiness. No production
database, App configuration, repository setting, or Git ref was changed.
