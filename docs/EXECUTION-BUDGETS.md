# Execution Budgets and Usage Accounting

Wallie can pin a versioned execution policy to each new session. The policy bounds automated repair and normalized provider accounting without changing pipeline stages, checkpoint lineage, artifact review, or PR delivery readiness.

## Policy identity and lifecycle

- Workspace managers edit policies in **Settings → Coding agent → Execution budgets**. Each save creates an immutable `execution_policy_revisions` row with optimistic revision checks.
- A session pins `execution_policy_revision_id` at creation. Editing a policy affects only later sessions; it never rewrites an existing session's limits or clears exhaustion.
- A legacy session with no policy remains unlimited. The migration does not invent historical repair counts or usage measurements.
- Every policy requires `maxRepairAttempts` (0–100) and `maxExecutionMs` (1 second–24 hours). `maxTotalTokens` and `maxCostUsd` are optional.
- Exhaustion stores its first durable code, time, observed/limit details, and policy identity on the session. `repair_attempts`, `elapsed_execution`, `tokens`, `tokens_unavailable`, `spend`, and `spend_unavailable` are separate reasons.
- Final artifact approval and manual PR delivery remain available. An exhausted session cannot start or enqueue another execution; archive and cancellation remain available.

## Repair and elapsed semantics

A repair is a manual retry, reviewer-requested revision, Linear rework/continuation, or automatic retry. Normal stage advancement is not a repair.

- Creating a new repair job reserves one attempt. Adopting the same active job reserves nothing.
- Automatic requeue reserves one attempt in `fail_session_job_attempt`, including a runless setup failure. Proven release-only deferrals retain their existing credit and are not repairs.
- A repair job that is admitted with the final slot may finish. A later repair request marks `repair_attempts` and creates no job.
- Reservation, enqueue adoption, automatic retry, and final start validation serialize on the existing session → job → run locks. Claim identities are never decremented or reused.
- Elapsed execution is the sum of `finished_at - started_at` for completed runs plus database-clock elapsed for the active run. Queue time and human-review idle time do not count.
- The processor uses the earlier of the worker deadline and remaining session elapsed budget. Expiration cancels the exact attempt and records the reason without another repair.

## Usage provenance

Each started run has independent token and cost provenance:

| State         | Meaning                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `measured`    | The provider CLI explicitly reported the value. Explicit zero is valid.                                         |
| `estimated`   | A bounded estimate with a required estimation revision. A later measured value replaces rather than adds to it. |
| `unavailable` | No trustworthy total exists. Stored numeric totals remain `NULL`; they are never zero.                          |

`record_session_run_usage` is service-only and fenced to the exact `(job_id, attempt_count, run_id)`. It runs before checkpoint publication and on unsuccessful completion, so failure and cancellation do not discard reported usage. A measured value cannot be downgraded to an estimate. Terminal runs record finalization time and a fixed unavailable reason where needed.

Workspace and session aggregates derive from run rows, including successful, failed, and canceled executions. Queued unstarted placeholders are excluded. Known values are summed once; unavailable coverage and estimated contributions are explicit. Partial aggregates use `+` and a partial/estimated label rather than presenting unknown data as complete or `$0.00`.

## Provider support

Sandbox setup currently installs largely unpinned CLIs. This matrix describes the event shapes Wallie parses, not a guarantee about every future CLI release.

| Provider    | Token evidence                                                                                        | Cost evidence                                                                    | Turn/token CLI limits                                                  | Reporting and enforcement                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Codex       | `turn.completed` / `result` `usage.input_tokens` and `output_tokens`, when complete and valid         | Unavailable                                                                      | No verified `maxTurns` or `maxTokens` option is supplied               | Terminal usage is measured reactively; attempts and elapsed remain enforceable                  |
| Claude Code | Successful and unsuccessful `result` `usage.input_tokens` / `output_tokens`                           | Provider-reported `result.total_cost_usd`                                        | `--max-turns` is supported; no verified `maxTokens` option is supplied | Terminal usage/cost are measured reactively; attempts and elapsed remain enforceable            |
| OpenCode    | Aggregated `step_finish.part.tokens.input` / `output`; any malformed step makes the total unavailable | Aggregated `step_finish.part.cost` only when every usage-bearing step reports it | No verified `maxTurns` or `maxTokens` option is supplied               | Steps are aggregated into a terminal measured snapshot; attempts and elapsed remain enforceable |
| Cursor      | Unavailable in the current adapter                                                                    | Unavailable                                                                      | No verified `maxTurns` or `maxTokens` option is supplied               | Attempt and elapsed limits only                                                                 |

The processor passes the remaining token ceiling through `AgentRunnerStartInput.maxTokens` for adapter forward compatibility. No current CLI adapter has a verified max-output-token option, so Wallie does not claim proactive token enforcement. Terminal-only telemetry cannot prevent the final in-flight provider request from crossing a cap. It does prevent publication, automatic retry, and later execution after the measured excess is recorded.

When a token or spend cap is configured, finalized unavailable telemetry is not budget compliance. The first execution may run using the mandatory attempt/elapsed limits; finalization then records `tokens_unavailable` or `spend_unavailable` and blocks subsequent execution. Subscription/non-metered credentials must not be presented as zero spend.

## Canonical owners

- `src/lib/execution-policy/contracts.ts` and the execution-policy API: strict versioned configuration.
- `src/features/settings/execution-policy-section.tsx`: manager editor and read-only policy view.
- `supabase/migrations/20261106220000_execution_budgets_usage_accounting.sql`: immutable revisions, session pins, reservations, exhaustion, usage provenance, and run-derived aggregates.
- `src/lib/pipeline/execution-budget.ts` and `processor.ts`: remaining deadlines, adapter limits, fenced telemetry, and reactive exhaustion.
- `src/lib/agent-runner/usage.ts`: finite/nonnegative provider normalization.
- `src/features/wallie/run-activity.tsx` and Settings Usage: measured, estimated, partial, pending, and unavailable presentation.

Required regression coverage includes adapter fixtures, `execution_budgets.sql`, `execution_budgets_concurrency.sql`, processor cancellation/reactive-exhaustion tests, and missing-usage UI tests. Run the full `pnpm check` gate and desktop/390px browser proof for UI changes.
