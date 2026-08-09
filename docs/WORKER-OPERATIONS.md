# Worker Operations

The Wallie worker is an always-on Node process. It claims durable jobs, executes
pipeline stages, publishes heartbeats, detects stalls, reconciles Linear state,
and reaps orphaned sandboxes. It cannot run as a Vercel serverless callback.

Deployment setup lives in [Self-hosting](SELF_HOSTING.md). Session transition
semantics live in
[Pipeline and worker lifecycle](PIPELINE-WORKER-LIFECYCLE.md).

## Runtime entry

`pnpm worker` preloads process crash handlers and the `server-only` registration
shim before importing [`src/worker/index.ts`](../src/worker/index.ts).

Startup performs:

1. Parse worker configuration.
2. Create the service-role Supabase client.
3. Register a heartbeat row.
4. Create the bounded scheduler.
5. Start heartbeat, stall, Linear reconciliation, and sandbox-reaper timers.
6. Enter the claim loop.

The code is authoritative for defaults:

| Setting                        | Current default | Owner                        |
| ------------------------------ | --------------- | ---------------------------- |
| Poll interval                  | 2 seconds       | `src/worker/config.ts`       |
| Heartbeat interval             | 10 seconds      | `src/worker/config.ts`       |
| Stall sweep interval           | 30 seconds      | `src/worker/config.ts`       |
| Linear reconciliation interval | 60 seconds      | `src/worker/config.ts`       |
| Sandbox reaper interval        | 60 seconds      | `src/worker/config.ts`       |
| Default stall timeout          | 15 minutes      | `src/worker/config.ts`       |
| Default workspace concurrency  | 2               | Claim RPC/config fallback    |
| Process concurrency            | 10              | `WORKER_MAX_CONCURRENT_JOBS` |

Workspace `concurrency_limit`, `stall_timeout_ms`, and `max_retries` live in
database configuration. Runtime workspace concurrency is enforced by the
current `claim_next_agent_job` SQL, not by the unused TypeScript
`worker/concurrency.ts` helper.

## Claim and scheduling loop

The scheduler fills free process slots through `claim_next_agent_job`. The RPC:

- Selects the oldest ready queued job with row locking.
- Skips future `scheduled_at` values.
- Avoids a workspace whose active sandbox connection is being mutated.
- Checks current running jobs against the workspace limit.
- Atomically moves one queued job to running.
- Increments its attempt count.

After claim, the scheduler advertises the job immediately in its heartbeat and
starts processing it. A claim error backs off to twice the normal poll interval.
At capacity, the scheduler wakes when a job finishes or the poll interval
expires.

Do not manually set a queued job to running. That bypasses row locks, workspace
capacity, mutation locks, attempt accounting, and heartbeat ownership.

## Heartbeats and activity

- Registration upserts worker start time, heartbeat time, and an empty active
  job list.
- Periodic, claim, and completion paths each publish a snapshot of the
  scheduler's in-flight set. Those writes are not serialized, so an older
  snapshot can commit after a newer one and temporarily omit a live job.
- Heartbeat failure is logged but does not crash the worker.
- Before processing, the worker touches activity on linked active runs.
- Persisting an agent event refreshes the run's `last_activity_at`.
- The stall detector protects jobs advertised by a heartbeat newer than its
  freshness window.

During an out-of-order heartbeat window, freshness alone does not prove that
every live job appears in the stored snapshot. A long-running setup or runner
that emits no activity can therefore be treated as unowned and recovered once
its activity exceeds the stall timeout.

There is currently no public worker health endpoint. Service-role-only
`worker_heartbeats`, worker logs, and durable job/run activity are the health
evidence.

## Recovery loops

### Stall detector

The stall sweep:

1. Pages active runs.
2. Ignores a queued run until its parent job is running.
3. Calculates the workspace timeout from last activity or creation time.
4. Skips jobs owned by a fresh worker heartbeat.
5. Issues a status-filtered update that marks a stale active run as error, but
   does not request or verify an affected row.
6. Attempts to stop its sandbox.
7. Reschedules the job with exponential backoff when retries remain, otherwise
   marks it terminally errored.
8. Parks a generating session in `rejected`.

A scheduled retry returns to `in_progress` only after a worker claims it.
Because the detector does not verify that step 5 changed the run, a processor
can complete between the sweep's read and update while the detector continues
with diagnostics, sandbox stop, retry/error handling, and session parking. This
transition is not currently a successful compare-and-swap boundary.

### Linear reconciler

The reconciler pages nonarchived, Linear-linked sessions in active phases,
batches issue-state reads by workspace, and applies the workspace's routing
configuration. Pagination orders only by `created_at`, limits each page to 50
rows, and advances with `created_at > previous_cursor`. If more than 50 eligible
sessions share the boundary timestamp, the remaining tied rows are skipped;
subsequent sweeps repeat the same ordering and may never reach them. For rows
that are reached, the reconciler may:

- Ensure the current stage has work queued.
- Cancel work and reroute to a configured stage.
- Archive a session.
- Pause or ignore an unmapped status.

Linear rate limits are retried once with a bounded delay. Persistent throttling
aborts the sweep so the next interval can continue later.

### Sandbox reaper

The reaper is independent of stall detection so it can recover resources whose
IDs were recorded on run or capability-check rows and later lost their active
owner. It gives new resources a creation grace period and only attempts to stop
provider resources that are known to Wallie and are not protected by an active
run, job, or recent capability check.

A process death after provider allocation but before `onSandboxCreated` records
the ID leaves no Wallie-known row for the reaper to match. Such an unrecorded
resource relies on provider TTL or operator cleanup.

Timer tasks are fire-and-forget. There is currently no mutex preventing a slow
sweep from overlapping its next interval or a manager-triggered maintenance
tick.

## Cancellation and shutdown

User and reconciler cancellation must call the shared cancellation service.
Direct status updates do not close sandbox-attachment and late-write races.

Graceful process shutdown drains already-claimed work:

1. `SIGINT` or `SIGTERM` sets the shutdown flag.
2. The scheduler stops claiming new jobs while active jobs continue running.
3. Heartbeat and maintenance timers remain active until every in-flight job
   settles, so the stall detector continues to see those jobs as owned.
4. The worker clears its timers, deregisters its heartbeat row, and exits
   naturally after the drain completes.

The worker does not impose a separate drain deadline. Sandbox provider timeouts
bound normal execution, while a shorter application deadline would recreate the
orphaned-command window that graceful draining is intended to close.

Crash handlers log a stack and exit nonzero; the host restart policy is
responsible for starting a replacement.

Hard kills, OOM termination, and hosts that do not deliver a graceful signal
still rely on stale-heartbeat detection, retries, provider TTLs, and the reaper.

## Deployment and scaling

- Deploy the web app and worker from compatible code and schema versions.
- Give both runtimes the required shared environment; keep service-role and
  encryption values server-side.
- Run the worker on an always-on host with restart-on-exit.
- Multiple worker processes are safe at the queue-claim layer because the
  database claim uses locks and workspace capacity checks.
- Process concurrency and per-workspace concurrency are independent limits.
- Apply expand/contract database changes so old and new worker versions can
  coexist during a rollout.
- Confirm the deployment system watches every transitive worker owner, not only
  `src/worker/**`.

Railway currently starts `pnpm worker`, restarts it unconditionally, and defines
no health endpoint.

## Safe troubleshooting

| Symptom                                         | Read-only evidence                                                                                    | Safe action                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Jobs remain queued                              | Worker startup/fatal logs, latest heartbeat, `scheduled_at`, running count, connection-mutation state | Restore worker/environment/schema; wait if backoff is scheduled                 |
| Job remains running                             | Fresh heartbeat ownership, run status, `last_activity_at`, messages                                   | Fresh ownership means wait; stale ownership is handled by the stall timeout     |
| Session remains `in_progress`                   | Latest job/run status and error, provider connection, capability readiness                            | Fix readiness; cancel active work through the session action when needed        |
| Session is `rejected` without reviewer feedback | Latest run error/cancel message and queued retry                                                      | Distinguish recovery parking from human rejection before rerunning              |
| Orphan sandbox suspected                        | Recorded provider/revision/ID and reaper/provider logs                                                | Use cancellation or the maintenance path; preserve ownership rows until cleanup |
| Linear state is stale                           | Reconciler errors/rate-limit messages                                                                 | Run one manager maintenance tick or wait for the next sweep                     |
| Connection cannot rotate                        | Active jobs/runs/checks/device-auth or mutation-lock evidence                                         | Finish or cancel related work; do not delete the lock or credential row         |

The manager maintenance endpoint runs workspace-scoped stall cleanup and Linear
reconciliation, but its sandbox-reaper call is currently global. A manager can
therefore trigger reaping of eligible Wallie-known resources belonging to other
workspaces. It does not process queued jobs. Treat this cross-workspace reaper
scope as an implementation gap, and do not use the endpoint as a replacement
worker loop.

## Unsafe manual repairs

Avoid:

- Setting jobs to running or success by hand.
- Flipping session phase without its transition owner.
- Deleting active runs, capability checks, provider connections, or ownership
  rows before sandbox cleanup.
- Clearing connection-mutation locks while work may still be active.
- Requeueing canceled jobs outside the guarded retry owner.
- Running destructive database reset or migration commands against a shared or
  hosted project.

Those actions bypass CAS, authorization, retry, cancellation, and resource
ownership invariants.

## Operational proof

A healthy deployment should provide:

1. Successful worker startup and registration.
2. A fresh heartbeat containing the expected in-flight set.
3. A queued test job claimed within the poll interval.
4. Run activity and normalized messages.
5. A reviewable artifact or an actionable terminal error.
6. No surviving sandbox after completion/cancellation beyond provider cleanup
   latency.
7. Recovery of a deliberately interrupted job through stale heartbeat and retry
   in a safe test environment.

## Known operational gaps

- No public worker readiness/health endpoint or code/schema compatibility
  marker exists.
- Periodic recovery sweeps can overlap.
- Heartbeat writes are not serialized, so a stale snapshot can overwrite a
  newer in-flight job set.
- The stall detector does not verify that its status-filtered run update won
  before performing the remaining recovery actions.
- Linear reconciliation uses a `created_at`-only cursor and can skip sessions
  tied at a 50-row page boundary.
- Manager-triggered maintenance invokes the sandbox reaper without a workspace
  filter.
- The reaper cannot discover a sandbox whose provider ID was never recorded on
  a run or capability-check row.
- `WORKER_MAX_CONCURRENT_JOBS` is consumed directly by worker config but is not
  represented in the shared environment schema.
- Railway watch patterns omit some transitive sandbox lifecycle owners.

Keep these visible during deployment work; do not silently describe the desired
future state as current behavior.
