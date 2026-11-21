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

Missing evidence follows `onUnavailable`. A configured zero floor or cost ceiling still requires a measured value. Benchmark outcome checks and routing at admission are added in subsequent issues.
