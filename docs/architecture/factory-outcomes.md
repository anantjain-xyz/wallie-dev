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
