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

## The three status domains

| Row                    | Active states                                | Terminal states                | Purpose                                   |
| ---------------------- | -------------------------------------------- | ------------------------------ | ----------------------------------------- |
| Session `phase_status` | `in_progress`, `awaiting_review`, `rejected` | `approved`                     | Product position within the current stage |
| Agent job `status`     | `queued`, `started`, `running`               | `success`, `error`, `canceled` | Durable queue and retry unit              |
| Agent run `status`     | `queued`, `started`, `running`               | `success`, `error`, `canceled` | One observable agent execution            |

`sessions.archived_at` is an orthogonal freeze marker, not another phase.
Enqueue preflight rejects a session already observed as archived, and processor
eligibility requires `archived_at is null`. Enqueue is not transactionally
excluded from racing archive; that gap is detailed below.

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

| Event                        | Guard or atomic boundary                                                                                                         | Durable result                                                                                           | Follow-up                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Create session               | `create_session_with_first_job` runs transactionally                                                                             | Session at first stage, queued job, and queued run are inserted together                                 | Worker polling discovers the job              |
| Claim job                    | `claim_next_agent_job` locks and CAS-updates a ready queued job while enforcing workspace capacity                               | Job becomes running and its attempt count advances                                                       | Scheduler advertises the job in its heartbeat |
| Claim session for generation | Processor updates only an unarchived, nonterminal session                                                                        | Session becomes or remains `in_progress`                                                                 | Generic stage execution begins                |
| Complete generation          | Artifact insert followed by `in_progress` + unarchived CAS                                                                       | Artifact version becomes current and session becomes `awaiting_review`                                   | Run and job finish successfully               |
| Fail generation              | Guarded compensation and retry scheduling                                                                                        | Run becomes error; session parks in `rejected`; job is queued with backoff or becomes terminally errored | A later claim may start the retry             |
| Reject artifact              | Version/status/rejection-count CAS, then feedback insert and enqueue                                                             | Feedback is first-write-wins for that stage version; a new job/run is queued; session becomes `rejected` | Worker claim returns it to `in_progress`      |
| Approve nonterminal stage    | `approve_session_stage` transaction checks workspace, version, status, and approver; records completion and advances by position | Session points to next stage at version zero and `in_progress`                                           | TypeScript enqueues the next job/run          |
| Approve terminal stage       | Same approval transaction                                                                                                        | Session remains `approved` and receives `archived_at`                                                    | No further job is created                     |

The artifact insert and session-pointer update are separate operations. If
cancellation wins after the artifact insert, the processor deletes the
unpublished artifact so that its version can be reused safely. Deletion
re-reads the session pointer first: if another generation has already
published that version, the row is left in place. A retry that finds an
unpublished row at the next version publishes the stored markdown instead of
regenerating, so reviewers never approve an artifact that does not match the
successful run.

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

Rejection is deliberately a compensated multi-step workflow:

1. CAS-increment `rejection_count` against workspace, status, version, and
   `archived_at is null`.
2. Insert immutable feedback for the reviewed stage version.
3. Enqueue the rerun before changing the session to `rejected`.
4. Change the phase only after a job exists or an equivalent active dedupe row
   is found.

Do not describe rejection as one database transaction. Changes to this path
must test failures between every step.

Current limitation: approval can land after step 1 while the rejection remains
in progress. Approval does not check `rejection_count`, and the rejection's
final `phase_status = rejected` write is unguarded. The rejection can therefore
enqueue against the now-current stage and change an `in_progress` or
`approved` phase to `rejected`. A terminal approval remains archived because
rejection does not clear `archived_at`. Treat approval versus an in-flight
rejection as an unresolved concurrency bug, not a safe losing-race outcome.

## Deduplication

Session creation, stage transitions, and interactive retry use:

```text
session:<session_id>:active
```

Linear-driven paths also retain keys based on the linked issue:

```text
pipeline:<linear_issue_id>:active
pipeline:session:<session_id>:active
```

The partial unique index prevents two active jobs with the same
`(workspace_id, dedupe_key)`. Different key families mean the database does not
provide a universal one-active-job-per-session guarantee. Code that requires
that stronger claim must query by session and active statuses or consolidate
the owner first.

## Cancellation and archive

[`cancelSessionWork`](../src/lib/pipeline/cancel.ts) is the shared cancellation
primitive:

1. Mark active jobs `canceled`.
2. Mark active runs `canceled`.
3. Stop any recorded sandboxes on a best-effort basis.
4. Record cancellation messages.
5. When requested, park an `in_progress` session in `rejected`.

Terminal job/run writes are guarded so a late worker cannot overwrite
`canceled` with `success` or `error`. The sandbox-attachment callback also
checks active run status and best-effort stops a sandbox when cancellation wins
that race. A crash before the callback records ownership remains outside this
guard.

User-facing archive writes `archived_at` before cancellation. Subsequent
enqueue validation and processor claims reject the archived session, but the
marker is not atomic with enqueue: a request that passed validation first can
insert a job and run after this cancellation pass. That work cannot execute
while the session remains archived, but its rows may require a later
archive/cancellation pass to converge. Unarchive only clears the marker; it
does not enqueue work.

## Worker scheduling and recovery

- One process runs up to `WORKER_MAX_CONCURRENT_JOBS`; the claim RPC separately
  enforces the per-workspace concurrency limit.
- The worker heartbeat records the full in-flight job set.
- A fresh heartbeat protects an active job from the stall detector.
- A running job whose attached run is already `success` is marked `success`
  rather than retried, so a crash after publish cannot mint a second artifact.
- A run with no activity beyond its workspace timeout and no fresh owning
  heartbeat is marked errored. Its sandbox is stopped, and its job is either
  rescheduled with backoff or marked terminally errored.
- A running job with no `agent_runs` row is retried only after `started_at`
  (falling back to `created_at`) exceeds the workspace stall timeout. That
  covers the claim → heartbeat → `startAgentRun` gap for Linear-routed jobs.
- Stall recovery parks the session in `rejected`; a retried job returns it to
  `in_progress` when claimed.
- Linear reconciliation may keep a current stage queued, reroute a session to a
  configured stage, or archive it. It cancels active work before rerouting.
- The sandbox reaper stops only provider resources whose IDs Wallie already
  recorded for the exact connection revision and whose run, job, or capability
  check is no longer active. It skips unknown provider sandboxes, including one
  created before a crash that prevented ownership from being recorded; those
  rely on provider TTLs or operator cleanup.
- Graceful worker shutdown stops new claims, keeps heartbeats and maintenance
  timers active while already-claimed jobs finish, then waits for timer
  callbacks already in progress before deregistering. Hard termination still
  makes recorded active jobs and runs eligible for stall recovery after their
  heartbeat becomes stale; unrecorded provider resources remain outside that
  recovery path.

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
artifact, and sandbox state without resurrecting work. The approval/rejection
gap and unrecorded provider resources documented above are current exceptions.

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
