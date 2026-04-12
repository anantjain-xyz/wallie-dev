# TODOs

Deferred work from the session refactor stack (PRs #7–#10) plus pre-existing
follow-ups that survived the cutover. Closed-out Phase 1 items (processor
unit tests, pre-screen tests, product-agent tests, the atomic approval RPC,
`PIPELINE_MODEL_NAME` consolidation) have been removed from this file.

---

## Session refactor — deferred follow-ups

### Drop the anchor `issues` table

- **What:** Every session still has an `issues` row paired with it, referenced by `sessions.issue_id` + `agent_jobs.issue_id` + `github_issue_branches.issue_id`. The anchor is a transitional shim to avoid touching the wallie panel, the github webhook, and the job queue in the backend-cutover PR.
- **Steps:**
  1. Add `agent_jobs.session_id` (nullable FK → `sessions.id`). Processor prefers `session_id`; dual-path while jobs already queued still use `issue_id`.
  2. Rewrite `src/app/api/slack/events/route.ts` + `src/features/sessions/client.ts` (`createSessionFromClient`) to enqueue with `session_id` and skip the anchor `issues` insert.
  3. Migrate `features/wallie/*` data loaders off `Tables<"issues">` / `mapIssueDetailRow` onto sessions directly. Session detail page already has the session row; wallie panel just needs `title` + `descriptionMd` + `githubRepositoryId` which all live on `sessions`.
  4. Migrate github webhook off `github_issue_branches` onto `session_pull_requests` (keyed on `session_id`). Resolve branch → session via a `session_pull_requests.branch_name` unique index.
  5. Drop `github_issue_branches`, `sessions.issue_id`, `agent_jobs.issue_id`, `features/issues/*`, the `issues` table, and the `enforce_issue_defaults_and_refs` trigger.
- **Effort:** L (most of a day of careful migration work).
- **Priority:** P2. Cleanup only — everything works today.

### Rewrite the wallie stub mode onto sessions

- **What:** `src/lib/wallie/service.ts:persistProjectArtifacts` is a no-op. The stub executor still generates `designMd` / `planMd` strings but they're dropped on the floor because the `issues` columns are gone. The whole stub wallie flow (`StubProjectArtifacts`, `StubCodeArtifacts`, the `runStubWallie` path) was built against the old data model.
- **Fix:** Write stub artifacts to `session_artifacts` keyed on the session's current phase. Or, simpler, delete the stub wallie mode entirely — it predates the pipeline concept and has been dead code since the cutover.
- **Effort:** S if we delete, M if we migrate.
- **Priority:** P3. No user-visible impact today; the stub mode is only reachable via dev scripts.

### Real agents for design / engineering / review / land / monitor

- **What:** PR #9's phase router dispatches non-`product` phases to `manualPhaseStub`, which writes `{ manual: true }` to `session_artifacts`, flips `phase_status` to `awaiting_review`, and posts a Slack approval prompt. Humans drive the 5 non-product phases by clicking Approve.
- **Fix:** Per phase, add an agent function under `src/lib/pipeline/` (e.g., `design-agent.ts`), swap the entry in the phase-router map in `processor.ts`, update the artifact JSON shape in `features/sessions/types.ts:SessionArtifactSummary`, and add a phase-specific renderer in the session detail page.
- **Effort:** M per phase.
- **Priority:** P1 for design + engineering + review. P2 for land + monitor.

### Rename `next_issue_number` → `next_session_number`

- **What:** The RPC that allocates the per-workspace counter is still named `next_issue_number`. Sessions reuse it (it's keyed on `internal.workspace_issue_counters`, a counter table, not the issues table, so it survives anchor-issue removal), but the name is misleading.
- **Fix:** Rename in a migration, update callers in `src/features/sessions/client.ts` and `src/app/api/slack/events/route.ts`. Keep a compatibility `create or replace` alias for one deploy cycle if we want zero-downtime.
- **Effort:** XS.
- **Priority:** P3.

### Rename `agent_jobs.job_type = 'pipeline'` → `'session'`

- **What:** The job-type discriminator still uses the string `'pipeline'`. Pipeline is the workflow, but the job is really a "session job."
- **Fix:** Data migration to flip existing rows, code change in `src/lib/pipeline/types.ts` (`PIPELINE_JOB_TYPE`), and grep for `"pipeline"` string literals in agent_jobs writes.
- **Effort:** XS.
- **Priority:** P3.

### AGENTS.md glossary

- **What:** Lock down the new vocabulary (**session** = top-level entity, **phase** = product/design/eng/review/land/monitor, **artifact** = versioned JSON per phase, **run** = one agent execution) in `AGENTS.md` so future contributors don't reintroduce "issue" framing.
- **Effort:** XS.
- **Priority:** P2. Cheap guard against drift.

### Archived-sessions UI

- **What:** Approving `monitor` sets `archived_at` and the card falls off the pipeline dashboard via realtime, but there's no view to see archived sessions. They become invisible.
- **Fix:** Add an `archived` filter scope to `/w/{slug}/sessions` (the filter is already parsed — `parseScope` accepts `"archived"`; just confirm the query path in `sessions/list/data.ts` handles it, and surface the filter in the list page UI).
- **Effort:** XS.
- **Priority:** P2.

### Breaking change in the wild: old Slack action buttons

- **What:** PR #9 changed the action-value encoding from `{ pipeline_issue_id, version }` to `{ session_id, version }`. Any Slack spec message posted before the cutover deploys will have dead approve/reject buttons — clicking them 400s because the route can't parse the old shape.
- **Fix (optional):** Accept both shapes in `src/app/api/slack/interactions/route.ts` for one deploy cycle: if `pipeline_issue_id` is present, look up the session by `sessions.issue_id = pipeline_issue_id`'s anchor, then dispatch. Or just live with the breakage — users re-mention and a fresh session posts.
- **Effort:** XS if we add the fallback.
- **Priority:** P3. User impact is "re-mention the Linear issue."

---

## Pre-existing follow-ups (carried over from Phase 1)

### Stale-button UX on version mismatch

- **What:** When `handleApproval` / `handleRejection` fails because the button's version is stale, the response is an ephemeral error but the stale buttons remain live. The next click fails the same way.
- **Fix:** On stale-version detection, replace the original message with "this version is outdated; see the new spec above" and strip the buttons.
- **Effort:** S.
- **Priority:** P2.

### Slack events route: move DB writes into `after()`

- **What:** `POST /api/slack/events` still does ~5 sequential DB roundtrips + a Linear API call + a session insert before returning 200. Slack's 3s budget has no headroom on a cold start.
- **Fix:** Ack immediately after signature verification + dedup check; run the rest inside `after()`.
- **Effort:** S.
- **Priority:** P2.

### `save_session_artifact` RPC

- **What:** `processor.ts` spec-save is guarded by a compensating delete on pointer-bump failure. The compensator itself can fail, leaving an orphan.
- **Fix:** A single `save_session_artifact` Postgres function that inserts the artifact + bumps `current_artifact_version` + flips `phase_status` in one transaction.
- **Effort:** S.
- **Priority:** P3. Current fix is good enough and covered by unit tests.

### Shared `verifySlackSignature` helper

- **What:** `src/app/api/slack/events/route.ts` and `src/app/api/slack/interactions/route.ts` duplicate `verifySlackSignature`. The 5-minute magic number is also duplicated.
- **Fix:** Extract to `src/lib/slack/verify.ts` and export a `SLACK_REQUEST_MAX_AGE_SECONDS` constant.
- **Effort:** XS.
- **Priority:** P3.

### PM / EM role mapping on workspace_members

- **What:** `workspace_members.role` is still `owner | admin | member | agent`. Escalation DMs read the EM's Slack user ID from `workspace_secrets.EM_SLACK_USER_ID` — a hardcoded shim. Future phase-specific approval gates (PM approves product, designer approves design, etc.) need a real role field.
- **Effort:** S.
- **Priority:** P2.

### Slack App install/admin surface

- **What:** Slack integration currently requires a manual Slack App creation + env var wiring + a `workspace_secrets` entry for the bot token. Doesn't scale to multi-workspace; token rotation is manual.
- **Fix:** OAuth install flow + settings page for workspace binding, channel selection, token rotation, scope-failure recovery.
- **Effort:** M (~1 week).
- **Priority:** P2. Blocker for multi-customer onboarding.

### Spec template learning from approvals

- **What:** Each product spec is generated from scratch. Approved specs are artifacts we could learn from to bias future generations toward the PM's preferences.
- **Fix:** Build spec templates from approved artifacts; prepend to the product-agent prompt as few-shot examples.
- **Effort:** M.
- **Priority:** P3. Cold-start problem — needs 5–10 real approvals first.
