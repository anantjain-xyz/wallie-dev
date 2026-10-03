# Pipeline and Worker Lifecycle

This document is the contract for sessions, jobs, runs, artifacts, review
actions, cancellation, and worker recovery. It describes current behavior,
including the places where a workflow intentionally spans more than one
transaction.

## Canonical owners

- [`src/lib/pipeline/processor.ts`](../src/lib/pipeline/processor.ts): generic
  stage execution and approve/reject orchestration.
- [`src/lib/pipeline/stages.ts`](../src/lib/pipeline/stages.ts): pipeline and
  stage loading plus prior-artifact projection.
- [`src/lib/pipeline/cancel.ts`](../src/lib/pipeline/cancel.ts): shared
  cancellation and sandbox cleanup.
- [`src/lib/pipeline/archive.ts`](../src/lib/pipeline/archive.ts): user-facing
  archive and unarchive ordering.
- [`src/lib/wallie/service.ts`](../src/lib/wallie/service.ts): interactive job
  and run enqueue lifecycle.
- [`src/worker/`](../src/worker/): claim scheduling, heartbeats, stalls,
  reconciliation, and reaping.
- [`supabase/migrations/`](../supabase/migrations/): status enums, constraints,
  indexes, and transactional RPC definitions.

The applied schema is the ordered result of the baseline and every forward
migration. A function redefined by a later migration is governed by the latest
definition, not by the copy in the baseline.

## Execution ownership

Workers and control paths use these service-role-only APIs for state transitions.
The ownerless publication and retry APIs have been removed.

An execution owner is the captured `(agent_jobs.id, attempt_count)` from queue
claim. A started run stores that attempt in `agent_runs.attempt_count`; historical
runs and queued placeholders may remain unbound (`null`). New execution intents use new job IDs, and retries
use a new attempt. Callers must never reload the latest attempt to authorize an
older worker's writes.

| API                                                            | Atomic boundary                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `start_session_job_attempt`                                    | Validate the claimed attempt, expected stage/version, bind legacy job stage, and claim/start its run.   |
| `publish_session_job_attempt`                                  | Validate ownership, insert markdown, advance the review pointer, and mark the exact run successful.     |
| `complete_session_job_attempt`                                 | Close only the exact published job/run, including after approval advances the session.                  |
| `fail_session_job_attempt`                                     | Fail/retry only the captured owner; a published run remains successful and its artifact remains intact. |
| `cancel_session_job_attempts` / `archive_session_job_attempts` | Cancel owned work and park/archive the session before sandbox cleanup.                                  |

The functions lock the session before its jobs and runs. Cancellation returns
run IDs for cleanup outside the transaction. A stale expected run cannot cancel
its successor attempt. Publication, failure, and completion never authorize a
worker using artifact version alone.

## Cutover rollout

This change requires a coordinated deployment; old and new workers must not run
at the same time.

1. Pause web/Linear queue producers, drain in-flight old control requests,
   and stop/drain old workers.
2. Confirm that no job or run is `started` or `running`. Finish or explicitly
   cancel remaining executions; queued work can remain for the new worker.
3. Inspect the unpublished artifact report below. For each row, verify whether
   it was ever reviewed. Restore the correct pointer for reviewed output;
   export genuinely unpublished rows to a durable backup and remove only those
   verified IDs in a transaction. Never bulk-delete or overwrite markdown.
4. Apply `20261003003927_worker_ownership_cutover.sql`, deploy matching web and
   worker code, then restart workers and producers.

The migration freezes writes while checking readiness and removing the two old
APIs. It fails without dropping either API when claimed work or unpublished
current-stage artifacts remain. It does not repair or delete existing data.

```sql
select 'job' as kind, id, workspace_id, session_id, status::text
from public.agent_jobs where status in ('started', 'running')
union all
select 'run', id, workspace_id, session_id, status::text
from public.agent_runs where status in ('started', 'running');

select artifact.id, artifact.workspace_id, artifact.session_id,
       artifact.stage_slug, artifact.version, session.current_artifact_version,
       artifact.artifact_json
from public.session_artifacts artifact
join public.sessions session on session.id = artifact.session_id
join public.pipeline_stages stage on stage.id = session.current_stage_id
where artifact.stage_slug = stage.slug
  and artifact.version > session.current_artifact_version;
```

## The three status domains

| Row                    | Active states                                | Terminal states                | Purpose                                   |
| ---------------------- | -------------------------------------------- | ------------------------------ | ----------------------------------------- |
| Session `phase_status` | `in_progress`, `awaiting_review`, `rejected` | `approved`                     | Product position within the current stage |
| Agent job `status`     | `queued`, `started`, `running`               | `success`, `error`, `canceled` | Durable queue and retry unit              |
| Agent run `status`     | `queued`, `started`, `running`               | `success`, `error`, `canceled` | One observable agent execution            |

`sessions.archived_at` is an orthogonal freeze marker, not another phase.
The enqueue and start RPCs lock the session and reject archived work. Archive
uses the same session lock, so interactive and Linear enqueue cannot slip past
its cancellation pass.

`rejected` is also the general parked/recoverable phase. Reviewer rejection,
explicit cancellation, generation failure, stall recovery, and some Linear
reroutes can all place a session there.

## Stage identity

- A stage is identified durably by `pipeline_stages.id`.
- Its slug is workspace-editable display and template identity; artifact rows
  retain both stage ID and slug where the schema requires them.
- Stage ordering comes from `pipeline_stages.position`.
- The generic runner executes the session's current stage. It must not branch on
  the seeded default stage names or slugs.
- A session remains pinned to its pipeline. Advancement finds the next greater
  stage position on that pipeline.

## Normal lifecycle

| Event                        | Guard or atomic boundary                                                                                                         | Durable result                                                                                                   | Follow-up                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Create session               | `create_session_with_first_job` runs transactionally                                                                             | Session at first stage, queued job, and queued run are inserted together                                         | Worker polling discovers the job              |
| Claim job                    | `claim_next_agent_job` locks and CAS-updates a ready queued job while enforcing workspace capacity                               | Job becomes running and its attempt count advances                                                               | Scheduler advertises the job in its heartbeat |
| Claim session for generation | `start_session_job_attempt` validates captured job/attempt, expected stage/version, and archive state                            | Session becomes or remains `in_progress`                                                                         | Generic stage execution begins                |
| Complete generation          | `publish_session_job_attempt` inserts markdown, claims `awaiting_review`, and records run success atomically, then PR            | Artifact version becomes current and session becomes `awaiting_review`; the winner publishes its attempt branch  | Run and job finish successfully               |
| Fail generation              | `fail_session_job_attempt` checks the captured job/attempt/run before failure or retry                                           | Run becomes error; session parks in `rejected`; job is queued with backoff or becomes terminally errored         | A later claim may start the retry             |
| Reject artifact              | `reject_session_stage` locks the session row and applies feedback, enqueue, and `rejected` in one transaction                    | Feedback is recorded; a queued rerun is inserted or a queued job is adopted; a publishing generation is replaced | Worker claim returns it to `in_progress`      |
| Approve nonterminal stage    | `approve_session_stage` transaction checks workspace, version, status, and approver; records completion and advances by position | Session points to next stage at version zero and `in_progress`                                                   | TypeScript enqueues the next job/run          |
| Approve terminal stage       | Same approval transaction                                                                                                        | Session remains `approved` and receives `archived_at`                                                            | No further job is created                     |

The processor calls `start_session_job_attempt` before creating a sandbox, then
publishes markdown, the review pointer, and exact run success together in
`publish_session_job_attempt`. Artifact rows are inserted once; publication
never overwrites existing markdown or deletes a losing attempt's output.
Attempt-specific branches prevent an expired worker from rewriting a successor's
branch. A late failure after publication closes the published job successfully
without changing the artifact or review state.

## Review concurrency

Approval is one transactional database operation:

- The session must belong to the expected workspace.
- It must still be `awaiting_review`.
- `current_artifact_version` must match the reviewed version.
- The approver must be an active member of the session workspace. Authorization
  then follows this precedence: `anyone_can_approve = true` allows any active
  member; otherwise a nonempty approver list allows only its active members;
  otherwise only active owners and admins may approve.
- Completion recording and stage-pointer advancement occur in the same
  transaction.

Enqueueing the next stage happens after that transaction. An enqueue failure
does not roll back an already approved stage; the session remains
`in_progress` on the next stage and can be queued again through an
idempotent interactive or reconciliation path.

Rejection is one transactional database operation (`reject_session_stage`):

- The function locks the session row for the rest of the transaction.
- The session must belong to the expected workspace.
- It must still be `awaiting_review` and unarchived.
- `current_artifact_version` must match the reviewed version.
- Feedback is recorded, the rerun job and queued run are inserted or an
  already-active dedupe row is adopted, and the session becomes `rejected`
  in the same transaction.

A concurrent approval serializes behind the same row lock and re-validates
the phase. After rejection commits, approval observes `rejected` and returns
empty instead of racing a later unguarded write. Validation failures raise so
the whole transaction rolls back.

TypeScript resolves the workspace agent config before calling the RPC; those
reads are not state transitions. Do not describe rejection as a compensated
multi-step workflow.

## Deduplication

Every enqueue producer uses:

```text
session:<session_id>:active
```

The database also enforces one active job per session. New execution intents
create new job IDs; only retries of the same intent reuse a job with an advanced
attempt. Terminal jobs are never reactivated.

## Cancellation and archive

[`cancelSessionWork`](../src/lib/pipeline/cancel.ts) calls
`cancel_session_job_attempts` to cancel active jobs/runs and park an
`in_progress` session under one session lock. Run-level cancellation supplies
`expectedRunId`; an outdated button cannot cancel a successor attempt.

The returned run IDs are the cleanup authority. Provider cleanup stops only
those resources, including a successfully published run whose job was still
active when canceled. That run and its artifact remain successful. A sandbox
that attaches after cancellation is stopped by the processor's guarded callback;
an unrecorded resource after a crash still relies on its provider TTL.

Archive uses `archive_session_job_attempts` to set the archive marker and cancel
work atomically. It preserves an existing review, rejection, or approved phase;
Linear completion explicitly marks the session approved, including when a
concurrent user archive won first, and retains the original archive timestamp.
Cleanup never writes session state after a provider await. A failed metadata read is retried three
times; cancellation/archive still report the committed result if cleanup must
be deferred to the reaper.

Workspace deletion commits every session's cancellation before provider cleanup.
Retries also recover recorded terminal runs, including legacy runs without a
parent job. A metadata, credential lookup, or provider failure returns `503`
before the workspace cascade removes those references and credentials. Definite
provider not-found responses are successful cleanup; a verified absent
connection is logged and skipped because no credentials remain to preserve.
Unarchive compares the expected archive marker when supplied and does not enqueue work.

## Worker scheduling and recovery

- One process runs up to `WORKER_MAX_CONCURRENT_JOBS`; the claim RPC separately
  enforces the per-workspace concurrency limit.
- The worker heartbeat records the full in-flight job set.
- A fresh heartbeat protects an active job from the stall detector.
- A claimed job whose run is already `success` for the same captured attempt
  is completed through the ownership RPC. Historical successful runs do not
  complete a newer retry or protect its older sandbox. Recovery skips provider
  cleanup if publication wins its failure RPC race.
- A run with no activity beyond its workspace timeout and no fresh owning
  heartbeat is failed through the captured job/attempt/run guard before its
  sandbox is stopped. Its job is rescheduled with backoff or terminally errored.
  Stale snapshots never authorize mutations using a reloaded latest attempt.
- A running job with no `agent_runs` row is retried only after this
  attempt's `started_at` (falling back to `created_at`) exceeds the
  workspace stall timeout. `claim_next_agent_job` refreshes `started_at` on
  every claim so a retried job is not immediately expired. That covers the
  claim → heartbeat → `start_session_job_attempt` gap for Linear-routed jobs.
- Claimed jobs in the legacy `started` status are included in the
  terminal-run recovery sweep so their active dedupe keys cannot stick.
- Stall recovery parks only the current owned stage in `rejected`; atomic
  attempt start returns an eligible retry to `in_progress`.
- Linear reconciliation consumes a durable source transition receipt and commits
  cancellation, rerouting, and replacement enqueue together. Repeated polls do
  not restart reviewed or advanced work.
- The sandbox reaper stops only provider resources whose IDs Wallie already
  recorded for the exact connection revision and whose run, matching job attempt, or capability
  check is no longer active. It skips unknown provider sandboxes, including one
  created before a crash that prevented ownership from being recorded; those
  rely on provider TTLs or operator cleanup. Credential rotation/disconnection
  uses the same matching-attempt rule for terminal run protection. A completed
  successful job stays protected while a fresh worker heartbeat still reports
  that job and the run matches its current attempt; canceled/error jobs never gain
  that protection. Rotation/disconnection waits for protected work in the owning
  workspace so credentials stay available through PR delivery.
- Graceful worker shutdown stops new claims, keeps heartbeats and maintenance
  timers active while already-claimed jobs finish, then waits for timer
  callbacks already in progress before deregistering. Hard termination still
  makes recorded active jobs and runs eligible for stall recovery after their
  heartbeat becomes stale; unrecorded provider resources remain outside that
  recovery path.

## Linear transition receipts

- Source identity is Linear's current `IssueStateSpan.id` and `startedAt` from
  `Issue.stateHistory`; unrelated issue edits retain the span, while a missed
  leave/return has a new span. History is paginated until the open span is found.
  Missing, inconsistent, or changing snapshots fail closed until the next sweep.
- `apply_linear_session_transition` validates session and routing-config
  snapshots, then locks pipeline → config → session → jobs/runs. Its private
  receipt rejects older observations and deduplicates the source span plus its
  effective route/target. Unrelated mapping edits do not restart work.
- Pause, ignore, and unmapped observations are also recorded. A changed effective
  route or a later source span can apply once; polls are latest-state observation,
  not replay of every intermediate Linear transition.
- The same transaction cancels owned attempts, invalidates target/downstream
  completion and feedback, preserves artifact history, resets the stage, and
  enqueues its replacement job/run. Only returned run IDs authorize sandbox
  cleanup after commit. A failed enqueue rolls back the transition and receipt.
- Stage changes normalize the artifact counter to at least the highest preserved
  version. New output appends a version; prompts include only stages with valid
  completion rows. Stale downstream history remains visible as history but is
  excluded from `artifact.previousStages`.
- Session creation atomically seeds a baseline receipt. Its preexisting Linear
  stage intent is consumed without undoing explicit session creation. Migration
  adopts existing work the same way. Canceled and manual Done are enforced even
  on the first poll; a verified Done can complete a concurrently archived session
  while preserving its archive timestamp. Routing never unarchives a session.
- Before deploying this migration and worker together, stop/drain old workers:
  their old reconciler performs separate writes and does not honor receipts.
  Resume workers only with the matching implementation. No Linear backfill is
  replayed automatically; this describes rollout requirements, not deployment.

Proof: `supabase test db --local` includes sequential receipt and overlapping
transition tests; `pnpm test src/worker/reconciler.test.ts
src/lib/linear-routing/observations.test.ts src/lib/pipeline/stages.test.ts`
checks observation, receipt cleanup, and prompt-history behavior.

## Race outcomes that are normal

Callers must treat these as expected concurrency outcomes, not exceptional
corruption:

- A job is claimed by another worker first.
- A session is archived or approved before a queued job claims it.
- An approval or rejection observes a stale artifact version.
- A second rejection loses the rejection-count CAS.
- Cancellation wins while a worker is inserting an artifact or recording a
  sandbox ID.
- A retry collides with an existing active dedupe key.

Handled losing-race paths are designed to close or preserve their own job, run,
artifact, and sandbox state without resurrecting work. Unrecorded provider
resources remain outside recovery as described above.

## Change checklist

When adding or changing a transition:

1. Name the semantic owner: RPC for transactional cross-row behavior, otherwise
   a single domain service.
2. State the expected phase, version, archive, job, and run predicates.
3. Define the losing-race result and whether it is an idempotent success,
   conflict, no-op, or retry.
4. Account for artifact versions, feedback, active dedupe rows, and sandbox
   cleanup.
5. Test the success path and at least one stale, concurrent, canceled, and
   archived path as applicable.
6. Update this document if the durable contract changes.
