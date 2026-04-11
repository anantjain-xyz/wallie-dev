# TODOS

## Pipeline Dashboard — Phase 1 follow-ups

Deferred from the v0.2.0 ship. Tracked here so they don't fall on the floor.

### ~~Processor direct unit tests~~ — DONE (review pass)

- Added `src/lib/pipeline/processor.test.ts` covering handleApproval (CAS success, stale version, cross-workspace guard), handleRejection (cross-workspace, phase-status guard, version mismatch, escalation at rejection_count >= 3, enqueue-before-flip ordering, non-23505 enqueue failure, 23505 silent dedup), and processPipelineJob (terminal CAS, pre-screen fail, happy path, spec-save compensating delete, generic warning on LLM failure).

### ~~Pre-screen and product-agent unit tests~~ — DONE (review pass)

- Added `prompt-safety.test.ts`, `pre-screen.test.ts`, `product-agent.test.ts` covering sanitize/truncate/boundary neutralization, fail-closed JSON parse, missing-required-fields, string-array filter, error-message scrubbing.

### `handleApproval` non-atomic follow-up writes

- **What:** `src/lib/pipeline/processor.ts:270` CAS-updates `phase_status` to `approved`, then issues two separate follow-up UPDATEs (lines 293 and 303/312) for the approval timestamp and the phase advance. The follow-ups ignore errors. A partial failure can strand a row at `phase=product, phase_status=approved` with no timestamp and no next-phase enqueue.
- **Why:** Found by Codex adversarial review on the v0.2.0 ship. Each write is individually guarded by the CAS-updated row id, but the three writes are not transactional. The fix is a single `approve_pipeline_phase` RPC that does CAS + timestamp + phase advance in one transaction.
- **Effort:** S (human: ~2h / CC: ~15min)
- **Priority:** P2

### Dedupe gate blocks recovery from `rejected` state

- **What:** `src/app/api/slack/events/route.ts:143` dedupes incoming mentions by looking up `pipeline_issues` on `(workspace_id, linear_issue_id)` and bailing if any row exists. Once an issue has been rejected (pre-screen fail or manual rejection with no retry enqueued), a second @wallie mention on the same Linear URL is silently ignored.
- **Why:** Found by Codex adversarial review on the v0.2.0 ship. A rejected-then-mentioned-again issue is unrecoverable from Slack — the user has to delete the pipeline_issues row manually in the DB. Either (a) allow re-enqueue on rejected state, or (b) reply with a Slack message saying "this issue was already rejected; update the Linear description and ask again."
- **Effort:** S (human: ~2h / CC: ~15min)
- **Priority:** P2

### Enterprise Grid `team.id` fallback

- **What:** `src/app/api/slack/interactions/route.ts` and `src/app/api/slack/events/route.ts` require `payload.team.id`. For org-wide Slack Enterprise Grid installs, the payload may set `is_enterprise_install: true` with `team` null and `enterprise.id` set. Add an `enterprise.id` fallback path.
- **Why:** A Grid customer onboarding today would be 403'd on every interaction. Fail-closed (safe) but functionally broken.
- **Effort:** S (human: ~2h / CC: ~15min)
- **Priority:** P2 (blocker only if a Grid customer is in the pipeline)

### Events route sync DB chain → `after()`

- **What:** `POST /api/slack/events` does 6 sequential DB roundtrips + optional Slack API call before returning 200. Slack's 3s budget has no headroom. Move the issue/pipeline_issue/agent_jobs writes into `after()` and ack immediately after dedup.
- **Why:** Cold-start + Supabase hiccups could cause Slack retries → duplicate work.
- **Effort:** S (human: ~3h / CC: ~20min)
- **Priority:** P2

### Stale-button UX on version mismatch

- **What:** When `handleApproval` or `handleRejection` fails on version mismatch (`current_artifact_version` doesn't match the button's value), the response is an ephemeral error but the stale buttons remain live. The next click fails again. Replace the original message with "this version is outdated" when we detect a stale click.
- **Why:** Otherwise reviewers keep clicking and keep seeing errors.
- **Effort:** S (human: ~1h / CC: ~10min)
- **Priority:** P2

### Shared `verifySlackSignature` + constant extraction

- **What:** Both Slack route handlers duplicate `verifySlackSignature`. Extract to `src/lib/slack/verify.ts` and name the 5-min magic number `SLACK_REQUEST_MAX_AGE_SECONDS`.
- **Why:** Any signature-verify change has to be made in two places.
- **Effort:** XS (CC: ~5min)
- **Priority:** P3

### ~~`PIPELINE_MODEL_NAME` drift~~ — DONE (review pass)

- Both `pre-screen.ts` and `product-agent.ts` now import `PIPELINE_MODEL_NAME` from `./types`. Dead `PIPELINE_MODEL_PROVIDER` constant removed.

### Harden spec-save with an RPC instead of compensating delete

- **What:** Processor spec-save is now guarded by a compensating artifact-delete on pointer-bump failure, which avoids the wedge but leaves a small window where the compensator itself can fail. A single `save_pipeline_artifact` RPC that inserts the artifact + bumps current_artifact_version + flips phase_status in one transaction would close the window fully.
- **Why:** Current fix is "good enough" for Phase 1 and was verified by unit tests, but an RPC removes the last remaining compensator-failure mode.
- **Effort:** S (human: ~2h / CC: ~15min)
- **Priority:** P3

## Pipeline Dashboard — Phase 2

### PM/EM role mapping

- **What:** Add a `role` field to `workspace_members` (e.g., pm, designer, engineer, em) so the pipeline can identify who to escalate to and who can approve at each phase.
- **Why:** Current member model is just owner/admin/member/agent. Escalation flow needs to know who the EM is. Approval flow should eventually gate on PM/designer roles.
- **Phase 1 workaround:** Store EM Slack user ID as a `workspace_secret` key. Hardcode the escalation target.
- **Effort:** S (human: ~2h / CC: ~10min)
- **Priority:** P2
- **Depends on:** Nothing. Can be done independently.

### Slack App install/admin surface

- **What:** Build an admin settings page for Slack integration: workspace binding, channel selection, token rotation, scope failure handling, and recovery UX.
- **Why:** Phase 1 uses manual Slack App install + env vars. This doesn't scale to multi-workspace and makes token rotation a manual process.
- **Phase 1 workaround:** Manual Slack App creation, env var configuration, and workspace_secrets for tokens.
- **Effort:** M (human: ~1 week / CC: ~30min)
- **Priority:** P2
- **Depends on:** Pipeline Dashboard (Phase 2)

### PM preference learning / spec templates

- **What:** Learn from PM approval patterns to generate better specs over time. Build spec templates from approved specs.
- **Why:** The 10x version of Wallie compounds. Each spec should be better than the last because it has learned from what PMs accept.
- **Phase 1 workaround:** None needed. Feature is additive.
- **Effort:** M (human: ~1 week / CC: ~30min)
- **Priority:** P3
- **Depends on:** 5-10 real approvals (cold start problem). Cannot build until there's enough approval data to learn from.
