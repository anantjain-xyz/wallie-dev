# Factory delivery commands

A factory manager can request delivery of an already-merged, approved source through the workspace factory's `delivery-commands` route. The command binds the exact checkpoint, the latest approval of that artifact, the session's pinned code delivery policy, the current canonical merge observation, and one approved M06 deployment source. The pinned policy must require artifact approval. The operation records intent for a downstream adapter. Source PRs still merge through the repository's existing manual flow.

| Command state        | Deployment outcome                     | What happened                                                                   |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| Queued               | —                                      | The manager recorded a request.                                                 |
| Dispatching          | —                                      | One adapter owns a 60-second claim.                                             |
| Accepted             | Pending                                | The provider accepted the request.                                              |
| Rejected             | —                                      | The provider definitively refused the request.                                  |
| Unknown              | Unknown                                | The dispatch timed out, or a correlated provider report contradicts its source. |
| Accepted             | Pending, unknown, succeeded, or failed | The scoped M06 deployment report supplied this outcome.                         |
| Blocked or cancelled | —                                      | An authority or source changed before claim, or the manager cancelled first.    |

- GET with `sessionId` and `deploymentSourceId` resolves a candidate, including the approved PR head and merged source SHA.
- POST with `action: "prepare"` submits a new `commandId` and the candidate's `sessionId`, `checkpointRunId`, `approvalId`, `policyRevisionId`, `mergeObservationId`, and `deploymentSourceId`. An exact retry returns the same command.
- GET with `commandId` reads the command. POST with `action: "cancel"` and `commandId` cancels a queued command.

The first successful claim or cancellation wins. A claim rechecks the source, policy, approval, and reporter authority. A manager can submit a fresh command after a cancellation, blocked claim, or definitive provider rejection. The database records the dispatch and deployment transitions as separate evidence from the merge.

The adapter uses the command UUID as the M06 external deployment ID. An authenticated M06 observation can reconcile a timeout only for the same repository, provider project, environment, and merged commit. The latest observation revision controls the recorded outcome, including when the reporter credentials rotate. Unknown commands stay ineligible for automatic redispatch.
