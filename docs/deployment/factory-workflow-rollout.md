# Factory workflow rollout and recovery

Qualify serial intake and a bounded branching workflow before offering a graph
revision to a canary factory. Keep the web app, worker, and database compatible
with every active session pin.

## Enroll a specific revision

1. Apply the forward migrations and check generated types on the rehearsal
   project. Verify the effective Cloudflare deployment, bindings, and dispatch
   settings separately from the Vercel web deployment. For Node, verify the
   deployed worker revision and heartbeat. [Cloudflare deployment](cloudflare-worker.md#production-deployment) · [Worker deployment](worker-operations.md#deployment-and-scaling)
2. Publish the reviewed draft in **Workflows** against the active factory
   definition. Record the base activation, definition revision and digest,
   workflow activation, and graph revision and digest. The intake picker offers
   the latest published workflow activation for the current base activation.
   Select that workflow for the canary. Use **Default pipeline** for ordinary
   serial intake. Existing specification triage follows its own admission
   settings. [Authored activation and session pin](../../supabase/migrations/20261123065456_author_factory_workflow_drafts_and_intake.sql)
3. Confirm the new session's pin through the scoped workflow inspection
   endpoint. For Product delivery, verify
   the specification approval accepts the exact artifact and checkpoint, then
   produces one initial authored route. Check that its children inherit the
   accepted scope. Review the joined parent artifact separately from child
   artifacts and the exact automated review. [Scope handoff](../architecture/factory-workflow-triage.md) · [Product template regression](../../supabase/tests/factory_workflow_templates.sql)

## Pause, cancel, or recover

Open **Workflow** on the session or exact run and follow its root link. A factory
manager can pause, resume, or cancel the root. The command carries the displayed
generation and a request UUID. After an uncertain response, retry identical
intent with the same UUID. On a 409, refresh the generation and choose an action
again. [Workflow lifecycle](../architecture/factory-workflow-lifecycle.md)

| Observed state               | Recovery                                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paused                       | Confirm queued work is parked and active attempts have exact retirement receipts. **Resume workflow** rechecks source and authority. Ordinary jobs can resume with a new attempt and run. Join and repository validation use their typed admission paths. |
| Canceled                     | Record the retired job, run, and attempt identities. Confirm approved artifacts and accepted heads remain readable. Keep cleanup active until sandbox stops or expiry and remote reconciliation have exact receipts.                                      |
| Lost worker or stale attempt | Compare the generation, job, run, attempt, and deadline with the current claim. Let compatible maintenance recover the existing publication or stop intent. Any new attempt uses its own identity. Keep the retired proof in history.                     |
| Exhausted root budget        | Record the pinned limit, accounted reservations, and reported or unavailable usage. Preserve accepted checkpoints. Use the supported human escalation or start fresh under an authorized policy.                                                          |

For a partial join, read every repository's status. Primary adoption can produce
a reviewable artifact while secondary delivery remains incomplete. A sealed
secondary validation stays available for publication under a fresh lease when
its deadline and authority still match. Maintenance verifies the exact remote
ref before writing. Preserve adopted repositories and record blocked delivery or
pending remote reconciliation with its exact blocker and receipt. [Repository delivery](../architecture/factory-workflow-branches.md#deliver-a-repository-set)

## Roll back intake or workers

- Use **Roll back to this revision** in Factory Definition history and confirm
  **Activate revision**. Rollback appends a new activation. Rebase and publish a
  compatible graph against that activation if new sessions should use it.
  Existing sessions keep their admission and graph pins, lineage, artifacts,
  and usage. [Revision rollback proof](../../e2e/factory-routing-rollback.spec.ts)
- To stop new pipeline claims, starts, and canonical PR promotion across the
  deployment, read `get_git_continuity_release_state()`. Use its current
  revision and a reason with `set_git_continuity_release`. Reload on a revision
  mismatch. In-flight remote requests can finish. Keep compatible publication
  and sandbox recovery available. [Continuity release control](worker-operations.md#controlled-checkpoint-continuity-release)
- Before replacing a Node worker, run `node scripts/worker-control.mjs status`
  on its owner-only `WORKER_CONTROL_SOCKET`. Run
  `node scripts/worker-control.mjs drain --timeout-seconds 2700`. Verify the
  same worker reports `drained` before sending the normal stop signal. Start the
  replacement to resume claims and maintenance. [Node drain](worker-container.md#drain-before-a-planned-stop)
- Before rolling back Workerd, arrange compatible recovery. Set
  `WALLIE_WORKER_DISPATCH_ENABLED=false` for subsequent dispatcher batches.
  A batch already running can still claim up to `WORKER_MAX_CONCURRENT_JOBS`
  jobs and schedule maintenance. Wait for it to return before switching
  revisions and account for the claims it made. Preserve the dispatcher namespace,
  `SESSION_ATTEMPT` and `MAINTENANCE` bindings, in-flight Workflow versions,
  and forward schema. Verify the effective revision and dispatch receipts
  after the switch. [Workerd rollback](cloudflare-worker.md#rollback)

Before removing a runtime capability, pause or cancel affected roots and verify
that active claims have settled. Keep compatible workers for paused work you
intend to resume and for outstanding publication and cleanup obligations.

## Collect qualification evidence

| Read                                                                                         | Record                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Signed-in `GET /api/sessions/{rootId}/workflow-lifecycle`                                    | Current root lifecycle and generation.                                                                                                                                               |
| Signed-in `GET /api/sessions/{sessionId}/workflow-inspection` with an optional exact `runId` | Parent and child attempts, read-only budget accounting, review and approval evidence, and recorded blockers.                                                                         |
| Signed-in `GET /api/sessions/{rootId}/workflow-join?joinId={joinId}`                         | Secondary validation run, per-repository blocker, accepted head receipt, and remote reconciliation flag.                                                                             |
| Authorized read-only worker and database inspection                                          | Exact job, run and attempt, claim deadline, worker version and heartbeat, and publication and stop receipts. Inspect enrollment with `get_session_git_continuity_state(session_id)`. |

Run these from the checkout with an exclusive local Supabase project. Set
`fixture_project` to its absolute project directory, with the current migrations
applied and `src/lib/supabase/database.types.ts` copied into that project.

```bash
pnpm check
pnpm check:types-drift "$fixture_project"
pnpm check:db-tests --workdir "$fixture_project"
WALLIE_CONTINUITY_SUPABASE_WORKDIR="$fixture_project" pnpm check:continuity
pnpm build
pnpm check:route-budgets
```

The SQL test launcher temporarily toggles the disposable project's release
revision. Record serial parity, duplicate completion, exhausted budget,
cancellation during publication, and partial repository delivery from the native
fixtures. Verify durable ownership, exact commit and tree, validation, usage,
and cleanup. [SQL launcher](../../scripts/check-db-tests.ts)

Set `handoff_project` to a fresh local Supabase project with the current
migrations, workspace seeding disabled, and no workers running. The proof stops a Node
process after its claim commits. Fresh Workerd maintenance recovers the exact
checkpoint and policy results. Another Node process verifies that the old lease
is stale and finishes the human gate using the exact approval receipt.

```bash
pnpm check:factory-runtime --workdir "$handoff_project" --m11
```

For signed-in Chrome, start the production build with the disposable browser
project's public settings. Set `WALLIE_M11_APP_URL` to the loopback app URL,
`WALLIE_M11_BROWSER_DATABASE_URL` to the same project's loopback Postgres URL,
and `WALLIE_M11_WITNESS_PATH` to an absolute file path inside an existing proof
directory. Supply `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
and `SUPABASE_SECRET_KEY` from that same project.

```bash
node --import tsx test/release/factory-workflow-qualification-browser.ts qualify
```

The browser admits default and compiled sessions, checks joined validation and
the automated review, and records distinct human approvals. The native fixture
stages deterministic worker evidence for those exact sessions. The proof
directory contains `browser-proof.json` and screenshots. [Runtime launcher](../../scripts/check-factory-runtime.ts) · [Browser qualification](../../test/release/factory-workflow-qualification-browser.ts)

Set the fixture IDs and the operator environment file path. Run the guarded
provider smoke in preview mode first.

```bash
node --import ./scripts/register-server-only.mjs --import tsx scripts/smoke-continuity-release.ts \
  --workspace-id "$fixture_workspace_id" --member-id "$fixture_member_id" \
  --repository-id "$fixture_repository_id" --database-workdir "$fixture_project" \
  --vercel-env-file "$fixture_operator_env"
```

Prepare the approved `anantjain-xyz/wallie-dev` fixture and its dedicated loopback
API 50321 and DB 50322 bindings. Add `--execute` after reviewing the preview and
confirming the fixture has exclusive admission. Capture the run-specific refs,
the exact checkpoint and PR target, and provider-confirmed stops. The current
smoke exercises serial source recovery with real Vercel and GitHub. Record the
parallel and multi-repository proof from the native fixtures. Keep
credentials and source bundles out of the retained evidence. [Guarded smoke](../../scripts/smoke-continuity-release.ts) · [Provider proof and cleanup](worker-operations.md#isolated-release-proof)
