# Model routing policies

Use the Model routing controls or JSON mode in Factory Definition to configure an optional `modelRouting` policy. The policy is part of the factory definition’s canonical digest. Publishing a draft creates an immutable revision. Shadow routing records the recommended configuration while production execution uses the factory’s admitted profile.

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

Missing evidence follows `onUnavailable`. A configured zero floor or cost ceiling still requires a measured value. Shadow admission uses the full eligible cohort. The evidence must identify a frozen scorer, or the experiment must have exactly one. Admission checks the p95 of measured trial runtimes when a latency ceiling is configured. The current benchmark facts have no confidence measure, so a configured confidence floor makes the configuration unavailable.

## Admission receipts

- The first selected stage’s slug comes from the pinned factory definition. Admission matches that slug to a configured task class. An absent match follows `onUnmatched`. An ambiguous match escalates.
- Admission checks the exact candidate’s current capability profile and the session’s scoped credential authority. It records the result, policy revision and digest, rule, and candidate identity before it queues the first run.
- Each attempt manifest links to the original admission receipt. Publishing a later policy or retrying a run preserves that receipt. The manifest’s model and worker runtime continue to describe actual execution.

## Preview and inspect

- Edit routing rules in Factory Definition and save the draft. Preview a task class slug against that saved draft. A change to the draft or active definition requires a fresh preview.
- Preview and admission share the same resolver. Preview uses the manager’s authority and the draft’s writer repository. An admitted session uses its own authority and writer repository.
- Run Inspector reads the exact attempt’s routing receipt and original policy label. Factory managers can follow the retained benchmark evidence for the exact selected configuration.

## Benchmark-backed drafts

Workspace owners and admins can apply a comparison configuration to a task class. The draft save keeps the current factory activation and uses its normal stale-draft check. The routing rule retains the exact scorer revision from the experiment.

| Check               | Draft requirement                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen inputs       | The suite revision and scorer revision are current. The replay policy, capability check, connection and toolchain still qualify the exact configuration. A pending sandbox rotation or unavailable writer blocks the draft. |
| Quality and support | The comparable cohort clears the declared pass-rate floor and minimum resolved trials. Known failures count in the denominator.                                                                                             |
| Measured cost       | Every comparable trial has measured costs for execution and the selected judge. The total must fit the mean ceiling when one is configured.                                                                                 |
| Wall latency        | A configured ceiling requires wall-time observations from every comparable trial. The 95th percentile is rounded up to whole milliseconds.                                                                                  |
| Confidence          | The comparison currently supplies no confidence value. Leave the confidence floor unset when applying a finding.                                                                                                            |

The save transaction retains an immutable receipt with the draft and the exact experiment, candidate key, suite revision and purpose, scorer revision, and measured tradeoffs. The draft links to the frozen comparison configuration and suite revision. A subsequent save keeps that link when the class identity, rule configuration, evidence thresholds, and repository scope still match. A fresh benchmark proposal records its own receipt.

## Reviewed activation

- Use **Activate reviewed routing** on a saved draft with frozen benchmark evidence and a passing configuration test. Activation checks the expected head and requalifies the exact targets against current factory authority.
- A new admission pins its reviewed activation, normal decision, and exact execution configuration. The workflow, repository, grants, approvals, tools, and budgets still come from the admitted factory definition.
- A workspace owner or admin can choose a reviewed target for one new pipeline session and supply a reason. The admission records the operator, reason, and resolved configuration alongside the policy recommendation. A retry of the creation request replays the recorded result.
- Worker claims and attempt receipts check the pinned runtime, harness, native model, agent prompt, and sandbox connection. Codex also uses the reasoning effort from the qualified benchmark configuration. Later activations affect future admissions. Retries and later stages reuse the session’s existing pin.

## Canary rollout

- Start a canary for a class with a reviewed benchmark proposal. Select the candidate share and use a compatible prior activation as the baseline. The rollout keeps the same workflow and authority across both arms.
- Each new admission records its assignment before queueing. The bucket is deterministic for the canary, task class, and session. Worker restarts and retries reuse that assignment.
- Analytics compares the assigned cohorts using production attempts, including failed attempts and retries. The report shows missing measurements and explicit overrides. A comparison remains inconclusive when either arm lacks enough comparable evidence.
