# Versioned delivery policy and verification records

OP-505 establishes the configuration and persistence contract for milestone 7.
It does not collect GitHub state, execute validation, mark a session Ready, or
change approval/enqueue behavior. [OP-506 collects GitHub observations](GITHUB-PR-VERIFICATION.md), OP-507
captures execution evidence, and OP-508 evaluates readiness and delivery gates.
Merge remains a manual action in GitHub.

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

These are the semantics that collectors and the later readiness evaluator must
honor. Persisting this policy alone does not implement the decision algorithm.

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
be stored as Ready. This is a minimal storage guard; the OP-508 evaluator must
actually derive these outcomes from exact, current source evidence.

Authenticated reads use workspace RLS. The invoker-security
`session_pr_verification_currentness` view reports whether a result still matches
the stored policy, review revision, accepted checkpoint, synchronized PR head,
configured age, and known repository/installation availability. Archiving a
repository or suspending its installation makes prior records noncurrent.
This is identity metadata, not permission to merge or a
readiness evaluator: the GitHub refresh queue supplies authoritative current
base/check/review observations, and OP-508 must combine them with evidence before
exposing Ready. A dirty or failed refresh invalidates previous decisions; code
decisions must reference the latest completed GitHub observation and its exact
head/base, policy, checkpoint, PR epoch, and review revision.
The persisted base SHA remains part of the immutable observation identity.

History cannot be edited or deleted independently; deletion is allowed only as
part of its owning workspace/pipeline/session purge. Existing checkpoint
continuity release controls and worker deployment settings are unchanged.

## Verification

Run `pnpm check` and the database regression suite with the forward migration
applied to an isolated local Supabase stack. Database types must be generated
from that applied schema. SQL fixtures exercise manager authorization, RLS,
immutability, revision invalidation, canonical code identity, and analysis/legacy
cases. Browser proof covers the configuration form at desktop and 390px widths.
