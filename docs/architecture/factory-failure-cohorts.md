# Factory failure cohorts

Wallie groups recurring failures by factory, recorded task class, producing
agent and symptom. Cohort membership preserves the source and configuration
identities from the failed run. Runs without a recorded task-class match stay
unclassified.

| Source                   | Counted failure                                   | Exact source in Wallie                                                                                |
| ------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Versioned scorer         | A completed evaluation returned a failing verdict | Run Inspector with the evaluation attempt selected and the evaluation job anchor                      |
| Deterministic validation | A harness command failed                          | The session validation evidence endpoint scoped to the member's run ID, with the recorded command key |

The recorded execution profile on the same Run Inspector page shows the
producing configuration. Members carry the pinned definition, execution and
agent revision identities when recorded. A missing identity remains unknown.

## Counts and qualification

- A run contributes once per cohort even when it has multiple source receipts.
- Sample support counts distinct sessions with at least one available
  evidence receipt. Separate runs of one session contribute one support sample.
- A cohort with fewer than three support samples, mixed producing versions,
  missing evidence, or incomplete identity is inconclusive. Qualification
  describes the evidence and sample, without inferring a cause.

## Collection and reads

- Receipt writes queue the source IDs. Both worker runtimes process that queue
  and catch up older receipts in bounded batches using durable cursors.
- `list_factory_failure_cohorts` returns summaries and
  `get_factory_failure_cohort` returns the corresponding evidence references.
  Both take an explicit workspace and factory and use live ID cursors.
- Reads recheck current factory and source visibility. Retention can hide
  members or restrict their evidence, which also changes what counts and
  qualification a reader can see. Private asset content stays behind its
  existing authorized reader. A missing expected validation log leaves the
  failure visible with unavailable evidence.

## Reviewed groups

Open **Improve → Failure groups** to filter a factory by symptom, producing
definition revision, or review state. The member list opens the exact run,
evaluation or validation receipt, and the recorded execution profile.

An active factory manager can label, dismiss, or split a group. Each action
records a review revision. A stale form asks the reviewer to reload.

A split puts the selected runs in one group and the remaining runs in another.
Both groups reference the reviewed snapshot of the original members. The
original group retains its source history and can receive new failures.
Current evidence access determines which members and counts each reader sees.
