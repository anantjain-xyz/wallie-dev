# Model routing policies

The factory definition accepts an optional `modelRouting` policy in JSON mode. The policy is included in the factory definition’s canonical digest. Publishing another draft creates a separate immutable revision. Production execution continues to use the factory’s existing profile during this increment.

| Field           | Contract                                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`       | `1` identifies the policy format.                                                                                                                                                                                     |
| `taskClasses`   | Give each class a stable UUID, unique lowercase slug, and display name. Rules match the UUID.                                                                                                                         |
| `rules`         | Array order survives compilation and publication. Each rule has its own UUID and references one class. A class can have one rule.                                                                                     |
| `configuration` | Use the exact benchmark experiment ID, definition revision ID, qualification ID, canonical model key, harness, and worker runtime. The agent UUID must match the referenced definition’s pinned implementation agent. |
| `onUnavailable` | Escalate or try one explicitly qualified fallback under the same constraints. Escalate if the fallback is unavailable or fails those constraints.                                                                     |
| `onUnmatched`   | Escalate or try one explicitly qualified fallback with its own constraints. Escalate if that fallback is unavailable or fails those constraints.                                                                      |

The compiler resolves primary and fallback configurations against frozen candidates and digest-verified definitions in the same factory. The frozen configuration records compatibility. A policy can exist before its benchmark has produced usable outcome evidence.

## Evidence requirements

| Field               | Value                                                                            | When evidence is unavailable                           |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `qualityFloorBps`   | Required quality floor from 0 to 10,000 basis points.                            | Treat the configuration as unavailable.                |
| `minResolvedTrials` | Required sample of 2 to 10,000 resolved trials.                                  | Treat the configuration as unavailable.                |
| `maxMeanCostUsd`    | Mean cost ceiling in USD. Set to `null` to omit the ceiling.                     | If configured, treat the configuration as unavailable. |
| `maxLatencyMs`      | Latency ceiling in milliseconds. Set to `null` to omit the ceiling.              | If configured, treat the configuration as unavailable. |
| `minConfidenceBps`  | Confidence floor from 0 to 10,000 basis points. Set to `null` to omit the floor. | If configured, treat the configuration as unavailable. |

Missing evidence follows `onUnavailable`. A configured zero floor or cost ceiling still requires a measured value.

## Benchmark-backed drafts

Workspace owners and admins can apply a comparison configuration to a task class. The draft save keeps the current factory activation and uses its normal stale-draft check. The routing rule retains the exact scorer revision from the experiment.

| Check               | Draft requirement                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen inputs       | The suite revision and scorer revision are current. The replay policy, capability check, connection and toolchain still qualify the exact configuration. A pending sandbox rotation or unavailable writer blocks the draft. |
| Quality and support | The comparable cohort clears the declared pass-rate floor and minimum resolved trials. Known failures count in the denominator.                                                                                             |
| Measured cost       | Every comparable trial has measured costs for execution and the selected judge. The total must fit the mean ceiling when one is configured.                                                                                 |
| Wall latency        | A configured ceiling requires wall-time observations from every comparable trial. The 95th percentile is rounded up to whole milliseconds.                                                                                  |
| Confidence          | The comparison currently supplies no confidence value. Leave the confidence floor unset when applying a finding.                                                                                                            |

The save transaction retains an immutable receipt with the draft and the exact experiment, candidate key, suite revision and purpose, scorer revision, and measured tradeoffs. The draft links to the frozen comparison configuration and suite revision. Later suite and scorer edits leave the receipt intact.
