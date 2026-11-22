# Factory improvement validation

Validation compares an exact proposal revision with its recorded base in two immutable benchmark suites. The targeted suite tests the proposed benefit. The held-out suite checks behavior on separate tasks and source sessions.

- A factory manager supplies the neutral scorer, Workerd execution configuration, and acceptance thresholds. The same definition digests, experiment axes, seed, repetition count, scorer, and replay policy apply to both suites.
- A single database transaction binds both suites before scheduling either. An exact retry returns the same two experiment IDs. Use the existing benchmark schedule controls to pause, resume, or cancel a comparison.
- The validation read reconciles the complete frozen grid. It checks current source evidence, comparable scorers and restored inputs, independent task support, and the measured cost and latency of both arms.

| Status       | Meaning                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Qualified    | Both suites meet the reviewed thresholds. The targeted suite shows an improvement.                                         |
| Failed       | A known regression or a measurable threshold breach occurred.                                                              |
| Inconclusive | The results have insufficient support, unavailable evidence, incomplete required measurements, or no observed improvement. |
| Stale        | A newer proposal or factory activation superseded the validated inputs.                                                    |

Read a validation through its exact proposal revision. The historical comparison IDs and measurements remain available when the proposal changes. Publication and adoption require current qualification for the revision being reviewed.
