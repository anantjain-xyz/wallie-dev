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
