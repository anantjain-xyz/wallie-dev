# Factory outcome evidence

Factory analytics is built from observations captured in the transactions
that commit session, job, run, and review changes. Each observation carries the
factory, source identity, source timestamp, and database observation timestamp.
Actor and pinned configuration IDs are retained when the source proves them.

| Evidence         | Identity                                                         |
| ---------------- | ---------------------------------------------------------------- |
| Session creation | Session ID with the original command actor where available       |
| Queue activity   | Job ID and queue generation                                      |
| Execution        | Run ID and exact attempt                                         |
| Review           | Exact artifact, approval, feedback, or clarification receipt     |
| Cancellation     | Exact requested generation when supported by the command receipt |

The ledger keeps business identifiers and status values. Tenant-owned
observations are independent of webhook subscriptions and UI performance
telemetry. Original session and run records still own product state.

## Coverage and rebuilding

- The lifecycle coverage row records when transactional collection began.
  Earlier retained facts can be backfilled in bounded batches. Their original
  timestamp and `backfill` provenance identify those points without establishing
  coverage for the intervening history.
- Backfill and live capture use the same source identity. Replay preserves the
  first stored observation and its original evidence. A missing endpoint
  remains unknown.
- Each projection identifies its immutable metric definition revision and its
  most recent coherent source snapshot. Late observations can affect earlier
  periods. Their source timestamps cannot serve as a projection cursor.

For historical repair, the owner-only
`internal.backfill_factory_outcome_observations` function accepts one workspace,
factory, event type, and fixed exclusive cutoff. Keep the cutoff at or before
the lifecycle coverage start and pass the returned source ID to the next batch.
Replaying a batch is safe. A null cursor means that the bounded scan is complete.

## GitHub merges

The canonical PR publisher and GitHub webhook observer record merges from
their fenced GitHub reads. The repository’s GitHub ID and PR number identify
one change within a workspace. Each observation keeps GitHub’s merge time,
provider revision time, and Wallie’s receipt time.

- Throughput uses one current observation per PR. An equal provider timestamp
  with conflicting merge evidence leaves the PR unresolved until a newer
  observation settles it.
- The canonical PR epoch links the session. A run link requires the exact
  source head and its acknowledged publication fence.
- A deleted source repository still permits a trusted merge receipt when GitHub
  returns its source head. The canonical readiness record keeps the unknown
  live head separate from that retained source evidence.

## Deployment observers

- A factory manager approves a source through
  `POST /api/workspaces/{workspaceId}/factories/{factoryId}/deployment-sources`.
  The `approve` command takes `executionGrantId`, `executionGrantVersion`,
  `provider`, `providerProjectId`, and `environment`. Set
  `providerTimeAuthoritative` only when the reporter obtains exact outcome times
  from that provider. It defaults to false.
- The reporter needs a machine token or API OAuth access token carrying
  `deployments:observe` for the API audience. The approved grant fixes the
  reporter and repository.
  Call `POST /api/v1/workspaces/{workspaceId}/factories/{factoryId}/deployment-observations`
  with the approved `sourceId`, matching `environment`, `externalDeploymentId`,
  and positive provider `revision`.
- Provide `outcome` as `pending`, `failed`, `unknown`, or `succeeded`. Provide
  the provider's exact 40-character commit in `sourceRevision` and the
  provider's timestamp of that outcome in `providerOccurredAt`. Use JSON
  `null` for either unknown value.
- The response preserves the immutable observation ID and its receipt time.
  Identical retries return the same observation. Changed facts require a
  greater provider revision. The highest revision determines the current
  report even when earlier revisions arrive late.
- A delivery measurement needs the current successful outcome, an
  authoritative source timestamp, and an exact canonical source-change
  match in the same factory and repository. Receipt time records when Wallie
  learned the fact. An unmatched or unknown commit is unlinked.
- The deployments coverage row records when the ingestion schema was
  installed. Each approved source records the start and end of its authority.
  The completeness of provider reporting remains unknown.
- Revoke the source through the management endpoint with `action: "revoke"`
  and its `sourceId`. The previous evidence stays attributable to the old
  source. Replacing its authorization preserves the logical deployment
  identity for that provider project, environment, and repository.
