# Versioned delivery policy and verification records

OP-505 establishes the configuration and persistence contract for milestone 7.
It does not collect GitHub state or execute validation by itself. [OP-506 collects GitHub observations](github-pr-verification.md), OP-507
captures execution evidence, and OP-508 evaluates readiness and enforces the
final-approval delivery gate. Merge remains a manual action in GitHub.

## Configure a pipeline

Workspace owners and admins can edit **Settings → Integrations → Pipeline → Delivery
policy**. A policy belongs to a pipeline, not a stage name. Code delivery always
requires a canonical session PR. Analysis work can explicitly use `analysis`,
which supports `not_applicable` without a repository or PR.

The initial form is an unsaved draft. It has no effect until saved. Every field
is required in the stored version-1 object, including deliberately empty check
and evidence lists and zero approvals. Unknown fields and versions are rejected.
No configuration is inferred from legacy stage names or artifact approvals.

The authenticated API is:

- `GET /api/workspaces/{workspaceId}/delivery-policy?pipelineId={pipelineId}`
  returns `{ policy: null }` when no policy exists.
- `PUT /api/workspaces/{workspaceId}/delivery-policy` accepts
  `{ pipelineId, expectedRevision, requirements }`. `expectedRevision: 0` creates
  the first revision. A stale save returns 409; reload the current policy before
  retrying. The authenticated user supplies no actor or workspace authority in
  the request body.

The database uses `PT409` for a stale revision so the REST transport returns a
semantic conflict without treating it as a serialization failure. See
[PostgREST custom HTTP status errors](https://docs.postgrest.org/en/stable/references/errors.html#raise-errors-with-http-status-codes).

```json
{
  "version": 1,
  "deliveryMode": "code",
  "requiredChecks": ["check:fast", "test"],
  "minimumApprovals": 1,
  "requireCodeOwnerReview": false,
  "requireResolvedThreads": true,
  "requiredEvidence": ["smoke"],
  "freshnessSeconds": 3600,
  "requireArtifactApprovalForDelivery": true
}
```

Check/evidence names are exact, case-sensitive identifiers, unique within each
list (at most 100 names, 1–200 characters each). Approval counts range from 0 to
20; freshness ranges from 60 seconds to seven days. Empty lists mean that the
manager explicitly configured no additional named requirement of that kind.
Repository rules still need reconciliation by the GitHub collector/evaluator.
An empty list never waives canonical PR identity, GitHub access, freshness, or
known state.

## Policy decision table

These are the semantics that the collectors and the readiness evaluator
honor. Persisting this policy alone does not implement the decision algorithm;
the table below is enforced by the evaluator and gate described above.

| Condition                                                                                       | Required interpretation                                                                              |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| No policy, malformed policy, unsupported version, or no observation                             | Unknown; never infer a successful history                                                            |
| Explicit analysis policy with no repository/PR                                                  | Not applicable; no synthetic PR or merge                                                             |
| Code delivery without a canonical PR/checkpoint/complete identity                               | Cannot be Ready; a successful code observation cannot be recorded without identity                   |
| GitHub access missing/revoked or pagination/information incomplete                              | Unknown or blocked; cannot imply successful checks or review                                         |
| Any named required check absent/pending/failing                                                 | Checking or blocked; absent is not success                                                           |
| Required approval count or code-owner review not satisfied                                      | Blocked                                                                                              |
| Resolved threads required, and blocking feedback remains                                        | Blocked; a revision alone does not resolve feedback                                                  |
| Any named evidence absent, failing, or for different commits                                    | Blocked                                                                                              |
| Policy revision, repository, PR epoch/number, head/base, checkpoint, or review revision differs | Previous decision is stale; re-observe/re-evaluate                                                   |
| Observation older than configured freshness                                                     | Previous decision is stale even when checks previously passed                                        |
| Every requirement known and satisfied for current identity                                      | Eligible for Ready, independently of generic artifact approval                                       |
| `requireArtifactApprovalForDelivery` enabled                                                    | Final delivery approval requires both current artifact approval and independently verified readiness |
| PR merged/closed                                                                                | Merged/closed only from authoritative GitHub observations; artifact approval never implies either    |

`unknown`, `checking`, `blocked`, `ready`, `merged`, `closed`, and
`not_applicable` are a separate database enum from `phase_status`. No build,
review, or land slug has special meaning here. Artifact approval is deliberately
absent from the readiness inputs, avoiding a circular approval gate.

## Readiness evaluation and the delivery gate

`src/lib/pipeline/pr-readiness.ts` owns the deterministic evaluator. It reads
only stored state — the completed GitHub observation behind
`session_pr_refresh_queue.last_observation_id`, the accepted checkpoint and
canonical PR epoch, the current policy revision, the session's artifact review
revision, open blocking review threads, and the OP-507 harness receipts bound to
the accepted commit — and derives one decision per dimension:

| Dimension                    | Derived from                                                                                     | Unknown fails closed as                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| GitHub access                | the collector's attested `githubAccess` plus repository/installation availability                | `github_access_unavailable`, `github_repository_archived`, `github_installation_suspended`                   |
| Identity / synchronization   | policy revision, PR epoch/number, sync status, checkpoint, PR head                               | `pr_epoch_changed`, `pr_head_checkpoint_mismatch`, …                                                         |
| Observation currency         | a clean (`current`) refresh queue and the consumed observation's age within configured freshness | `github_refresh_pending`, `github_refresh_failed`, `github_observation_expired`, `github_observation_future` |
| Required checks              | the collector's check outcome                                                                    | `github_checks_not_passed`                                                                                   |
| GitHub reviews               | the collector's review outcome                                                                   | `github_reviews_not_passed`                                                                                  |
| Threads                      | collector threads plus open Wallie blocking feedback                                             | `artifact_blocking_feedback_open`                                                                            |
| Named evidence               | revalidated harness receipts for the exact accepted commit                                       | `evidence_missing`/`_stale`/`_failed`/`_unavailable`                                                         |
| Mergeability and draft state | the collector's mergeability plus the authoritative draft flag                                   | `github_pr_draft`, `github_mergeability_not_passed`                                                          |

A decision is `ready` only when every dimension is `passed`; `merged` and
`closed` come only from the authoritative PR state; anything unknown is
`unknown`, never success. The evaluator records its decision through the same
service-only observation/result RPCs, bound to the exact repository, PR epoch
and number, head/base SHA, checkpoint run, policy revision, and artifact review
revision it consumed, with `observed_at` from the evaluation moment. The
payload also records `sourceObservationId` — the exact completed GitHub
observation the evaluation consumed — so a decision evaluated from a
superseded collection is distinguishable from one bound to the latest
completed observation. The currency checks mirror the delivery gate, so the
review-time summary never shows Ready where the gate would reject.

The worker's reconciliation drains `reconcilePrReadiness` after each GitHub
refresh cycle. Archived sessions are excluded before the batch limit — their
queue rows stay `current` forever with old timestamps and would permanently
occupy the batch — and already-consumed work is skipped without occupying an
evaluation slot, so completed history cannot starve active sessions. The
approval path (`handleApproval`) evaluates and records once more immediately
before the gated RPC, so the gate validates a decision bound to the current
identity.

### The final-approval gate

`internal.assert_delivery_readiness_gate` runs inside `approve_session_stage`
after its session lock, so every readiness-invalidating writer — refresh
enqueue/finish, publication, rejection, review writers — serializes with it.
It applies only when the session's pipeline has a current **code** policy with
`requireArtifactApprovalForDelivery` enabled **and** the approved stage is the
final selected stage. The gate then requires the newest `ready` decision from a
`readiness`-source observation to still be `is_current` per
`session_pr_verification_currentness`: same repository, canonical PR epoch and
number, head and base SHA, accepted checkpoint, policy revision, artifact
review revision, within configured freshness, consuming the latest completed
GitHub observation of a clean refresh queue. The decision's recorded
`sourceObservationId` must equal the queue's current `last_observation_id`:
the currentness view's created-at ordering alone cannot tell that a refresh
landed between the evaluator's read and its recording with unchanged
head/base SHAs, so the gate binds the accepted decision to the exact
observation it consumed. A missing or absent `sourceObservationId` fails
closed.

- No policy, an `analysis` policy, or a policy without the approval gate:
  approval proceeds without a PR gate; `not_applicable` is the analysis
  outcome and never a code state.
- Missing, stale, or blocked readiness raises `PT428`; the phase-action route
  maps it to a deterministic conflict. A stale review token still raises
  `PT412` first.
- Approval of a non-final stage never consults readiness; a configured final
  approval validates the current artifact and readiness atomically in one
  transaction.
- The reviewer sees the server-owned readiness summary beside the blocking
  count through `GET /api/sessions/{sessionId}/approval-review`, which adds a
  `delivery` object derived from the same evaluator. Clients cannot submit a
  readiness value anywhere; every decision is server-derived.

No automatic merge exists anywhere in this flow. `merged` and `closed` appear
only from authoritative GitHub observations, and manual successor PRs remain
the only path after a close or merge. Reviewers inspect the live decision,
blocker sources, validation receipts, and a bounded canonical diff in the
[session review evidence surface](review-evidence.md).

## Persistence and authorization

`delivery_policies` holds the current revision pointer;
`delivery_policy_revisions` is append-only. The service-only
`save_delivery_policy` RPC locks the pipeline, verifies an active human manager,
checks the expected revision, appends the new revision, and advances the pointer
atomically. Updating a policy retains historical verification records but makes
their old policy identity noncurrent. There is no legacy backfill.

`session_pr_verification_observations` stores immutable source snapshots bound
to workspace, session, policy revision, repository ID/name, canonical PR epoch
and number, head/base SHA, checkpoint run, artifact-review revision, source,
payload, and observation time. `session_pr_verification_results` stores immutable
decisions and blockers referencing those snapshots. All verification writes use
service-only RPCs. An authenticated user cannot manufacture observations or
results, and the policy API exposes no verification-write endpoint.

A code `ready` result requires a `readiness` source and explicit trusted receipt
fields `githubAccess: "available"`, `checks: "passed"`, `reviews: "passed"`,
`evidence: "passed"`, and `threads: "passed"`. Missing or unknown outcomes cannot
be stored as Ready. This is a minimal storage guard; the evaluator derives these
outcomes from exact, current source evidence before recording them.

Authenticated reads use workspace RLS. The invoker-security
`session_pr_verification_currentness` view reports whether a result still matches
the stored policy, review revision, accepted checkpoint, synchronized PR head,
configured age, and known repository/installation availability. Archiving a
repository or suspending its installation makes prior records noncurrent.
This is identity metadata, not permission to merge or a readiness decision:
the GitHub refresh queue supplies authoritative current base/check/review
observations, and the evaluator combines them with evidence before exposing
Ready. A dirty or failed refresh invalidates previous decisions; code decisions
must reference the latest completed GitHub observation and its exact
head/base, policy, checkpoint, PR epoch, and review revision.
The persisted base SHA remains part of the immutable observation identity.

History cannot be edited or deleted independently; deletion is allowed only as
part of its owning workspace/pipeline/session purge. Existing checkpoint
continuity release controls and worker deployment settings are unchanged.

## Verification

Run `pnpm check` and the database regression suite with the forward migration
applied to an isolated local Supabase stack. Database types must be generated
from that applied schema. SQL fixtures exercise manager authorization, RLS,
immutability, revision invalidation, canonical code identity, the evaluator
truth table, stale-decision rejection, the approval/refresh race, and
analysis/legacy cases. Browser proof covers the configuration form and the
review-time readiness summary at desktop and 390px widths.
