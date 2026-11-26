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

## Flow and delivery time

- Queue, active, clarification, and review time pair exact job, run, or review
  evidence. Final approval starts a delivery wait whose end requires a verified
  merge. Each chronological span contributes to one phase and retains its
  supporting observation IDs. Unpaired intervals and gaps stay visible.
- Request-to-merge uses the first proven merge for each request in the cohort.
  Request-to-deployment uses the first eligible deployment in the selected
  environment. Their distributions count measured samples separately from
  requests still missing an endpoint.
- New session observations enqueue the same reducer used by a full rebuild.
  The Node and Workerd maintenance cycles each process one bounded batch.
  Delivery samples use current verified linkage, so late deployments and
  corrections are reflected on the next read.

Overview reads the same Analytics cohort and links to its evidence. Projection
health shows the latest successful snapshot, pending work and its age, and
the status of any rebuild.

| Factory manager action | Effect                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| Pause projection       | Stops processing for the selected factory. Outcome capture and session execution continue.     |
| Rebuild projection     | Queues a bounded pass over the retained sessions. The rebuild resumes from its saved position. |
| Resume projection      | Restores processing of pending observations and rebuild work.                                  |

If a batch fails, its partial projection changes roll back. The worker records
the failure and retries with backoff while healthy factories continue. A rebuild
uses the retained observations. It leaves authoritative sessions and runs intact.
Cost, throughput, and revert summaries read their retained source evidence
independently of the flow projection.

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

## Throughput attribution

Throughput counts unique canonical PRs using their provider merge time.
Breakdowns use the recorded request surface and invoking actor, or the
producing run’s exact manifest for agent, model, harness, and definition.

- Each PR belongs to one bucket per dimension. Complete evidence with
  distinct producing values uses the mixed bucket. Known values with incomplete
  producer evidence use the partial bucket. Drilldowns keep each contributing run.
- The request surface retains its creation receipt even after the command
  admission is pruned. The invoking actor, credential owner, and budget payer
  each keep their own identity. Factory managers can inspect the credential
  owner and budget payer.
- An unlinked PR keeps its request attribution. Unknown remains visible for
  request sources or producing settings whose exact evidence is unavailable.

## Verified reverts

A factory manager can confirm a relationship after Wallie reads the exact
merged revert PR from GitHub. Both merges must belong to the same repository
and base branch. A candidate stays unverified and a correction keeps the prior
receipt. [GitHub’s revert workflow](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/reverting-a-pull-request)

- Revision 1 matures after 30 elapsed days from the original provider merge
  time. A valid revert within the window counts the original PR once.
- Managers record reviewed observation intervals for the exact repository and
  base branch. Only mature, fully covered outcomes contribute to the rate.
  Verified reverts in incomplete or immature windows remain inspectable.
- Withdrawing coverage or correcting a relationship updates the current rate.
  Historical receipts retain what was reviewed and when it was observed.

Managers submit relationship and coverage decisions at
`POST /api/workspaces/{workspaceId}/factories/{factoryId}/outcome-reverts`.

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
- Delivery timing uses the current successful revision when its exact commit
  matches one verified canonical merge in the same workspace, factory, and
  repository. The provider's authoritative deployment time must be at or
  after the merge. The link carries both observation IDs. Missing or
  ambiguous links leave the raw report available for inspection. A competing
  PR with conflicting current evidence can keep a commit ambiguous until
  a newer observation settles its identity.
- The deployments coverage row records when the ingestion schema was
  installed. Each approved source records the start and end of its authority.
  The completeness of provider reporting remains unknown.
- Revoke the source through the management endpoint with `action: "revoke"`
  and its `sourceId`. The previous evidence stays attributable to the old
  source. Replacing its authorization preserves the logical deployment
  identity for that provider project, environment, and repository.

## Cost per merged PR

Both measures use one currently verified canonical PR per denominator entry,
selected by GitHub merge time in the half-open period `[from, to)`.

| Measure          | Product attempt cost included                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Delivery cohort  | Lifetime settled attempts attributable to those merges, including failed and canceled attempts from before the selected period |
| Period operating | All attempts started in the selected period, including abandoned work, detached runs, and runs unlinked to any merge           |

- An exact source publication qualifies first. Other attempts must fit wholly
  within a provable session delivery window. Assignment considers earlier
  epochs outside the selected period. A run contributes to at most one merge.
  Cross-boundary evidence and unfinished runs remain visible as unresolved.
- Product attempt values come from the retained usage receipt. Measured and
  estimated amounts contribute to the known subtotal. Pending or unavailable
  costs have no numeric value. An explicit measured zero remains zero.
- The ratio divides the known subtotal by observed merges. The coverage state
  exposes partial usage or merge history. The ratio is undefined with zero
  observed merges. Evaluation, experiment, maintenance, and compute costs
  remain separately unavailable until their sources are instrumented.
- `get_factory_cost_summary` reads the current scope. The
  `list_factory_cost_contributions` cursor reads its retained run IDs and
  exact merge observation IDs. A correction can change current membership.

## Reading Analytics

Analytics uses one authorized factory and UTC dates. The end date is
exclusive. The previous-period comparison applies the same filters to the
immediately preceding period of equal length.

| View                                      | How Analytics selects its cohort                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| Workflow flow                             | Closed intervals overlapping the period, clipped at both boundaries                  |
| Request to merge or deployment            | Requests admitted during the period. Deployment can filter by environment.           |
| Delivery cost, PR throughput, and reverts | Canonical PR merge time. Each metric applies its own verified evidence rules.        |
| Operating cost                            | Attempt start time for the numerator and canonical PR merge time for the denominator |

Each outcome table combines values and comparison bars with a single link to
the exact evidence per value. Phase, sample
status, attribution, and revert filters apply before pagination. Cost ratios
link separately to the contributing attempts and the exact observed merges.
Projection freshness and capture boundaries are reported with the results.
Pending inputs, a missing denominator, and an immature revert window have
separate states from a measured zero.

## Exporting a cohort

Use **Create export snapshot** in Analytics to capture the applied filters,
periods, metric revisions, and supporting observations from one database
snapshot. CSV and JSON downloads use the same snapshot ID. CSV includes
common evidence fields and a JSON column for the complete record.

- A snapshot expires after 24 hours. Downloads require an active login and
  the requester's current factory access. Downloads with manager-only fields
  also require current manager access.
- Requests above 100 rows per evidence set, 800 evidence rows in total, or
  1 MiB of stored JSON fail. Shorten the period to export a smaller cohort.
- Data that arrives after capture affects new snapshots. A snapshot keeps
  its original values and observation IDs until expiry.

## Qualification and coverage limits

- Complete lifecycle coverage begins at the recorded capture boundary.
  Backfilled facts preserve their exact times. Intervening gaps remain unknown.
- Deployment reliability depends on approved sources reporting authoritative
  outcomes and linking their commits to canonical merges. Inspect the receipt
  and environment behind each measured deployment.
- Throughput can be grouped by request source, invoking actor, or pinned
  producing configuration. Time and cost compare selected factory periods.
- Revert coverage depends on manager-recorded evidence for the full 30-day
  window. Ambiguous and immature originals remain visible alongside the
  eligible denominator.

Use the [adversarial cohort qualification](../development/verification.md#factory-outcome-analytics)
to reproduce the reconciliation and the
[projection recovery procedure](../deployment/worker-operations.md#factory-outcome-projection-recovery)
to replay retained evidence safely.
