# Factory failure cohorts

Wallie groups recurring failures by factory, recorded task class, producing
agent and symptom. Cohort membership preserves the source and configuration
identities from the failed run.

| Source                   | Counted failure                                   | Exact source in Wallie                                                                                |
| ------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Versioned scorer         | A completed evaluation returned a failing verdict | Run Inspector with the evaluation attempt selected and the evaluation job anchor                      |
| Deterministic validation | A harness command failed                          | The session validation evidence endpoint scoped to the member's run ID, with the recorded command key |

The recorded execution profile on the same Run Inspector page shows the
producing configuration. Members carry the pinned definition, execution and
agent revision identities when recorded. A missing identity remains unknown.

## Counts and qualification

- A run contributes once per cohort even when it has multiple source receipts.
- Sample support counts distinct sessions. Separate runs of one session still
  contribute one support sample.
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
  existing authorized reader.
