# TODOS

## Pipeline Dashboard — Phase 1 follow-ups

Deferred from the v0.2.0 ship. Tracked here so they don't fall on the floor.

### Processor direct unit tests

- **What:** `src/lib/pipeline/processor.ts` is a 600-line orchestrator with no direct unit tests. Coverage comes via integration tests in `events/route.test.ts` + `interactions/route.test.ts`, but the CAS claim, escalation-at-max-rejections, 23505 rejection-retry, terminal engineering→shipped transition, and spec-generation failure branches are not directly asserted.
- **Why:** Regressions here are silent until a PM hits them live. Phase 2 will grow this file further.
- **Effort:** S (human: ~3h / CC: ~20min)
- **Priority:** P2

### Pre-screen and product-agent unit tests

- **What:** Both `pre-screen.ts` and `product-agent.ts` have zero unit tests. Critical defensive code (fail-closed JSON parse, string-array filter, new tag-boundary neutralization, 8KB truncation) has no assertions. Mock the Anthropic client and add ~5 tests per module.
- **Why:** These are the LLM trust boundary. Any regression in the defensive filters is a security regression.
- **Effort:** S (human: ~2h / CC: ~15min)
- **Priority:** P1

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

### `PIPELINE_MODEL_NAME` drift

- **What:** `types.ts` exports `PIPELINE_MODEL_NAME` and `PIPELINE_MODEL_PROVIDER` but both `pre-screen.ts` and `product-agent.ts` hardcode `"claude-sonnet-4-20250514"`. Three sources of truth for a pinned model.
- **Why:** Model upgrade will miss one of them.
- **Effort:** XS (CC: ~5min)
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
