# Benchmark suites and task revisions

A suite revision records the exact task revisions it contains. Task and suite
edits append revisions under stable identities.

| Record         | Frozen data                                                               |
| -------------- | ------------------------------------------------------------------------- |
| Task           | Factory, source run and session IDs, and copied run provenance            |
| Task revision  | Name, acceptance criteria, tags, and replay eligibility with its reason   |
| Suite revision | Name, purpose (`regression` or `holdout`), and selection tags when used   |
| Suite member   | Exact task revision, with one entry per stable task ID per suite revision |

## Save and read revisions

- Factory managers save through service-role RPCs. Each edit provides the
  current revision ID. A stale edit returns `PT409` so the caller can reload.
- Specify task revision IDs to curate a suite explicitly, including an empty
  suite. Specify tags to select the latest revision of each task that has every
  requested tag. The save writes those members in the same transaction.
- Read `factory_benchmark_suite_members` by suite revision ID. Follow
  `task_revision_id` for the criteria and eligibility saved with that suite.
- Factory access controls all reads. Composite foreign keys keep suites and
  members in the same workspace and factory.

## Source evidence

The task copies source IDs and run metadata at creation. The capture keeps
that provenance if the source run changes or is removed. Tasks begin as
`unverified` when eligibility is unknown. Replay requires separate checks of
retained inputs and current access to their contents.

## Capture a historical run

- A factory manager opens **Add to benchmark** on a finished run. The preview
  reads the original request, effective checkout, and exact definition and
  context receipts. The rendered prompt receipt records its digest.
- Capture checks the historical Git reference and current access to recorded
  context before assigning eligibility. Missing inputs leave an inspectable
  task with a reason. Replay will verify retained bytes again when it restores
  the task. Historical image inputs without an integrity receipt make the
  task ineligible.
- The capture command writes the task and suite membership in one transaction.
  Adding the same run to a suite returns its existing member. An explicit
  addition copies the suite's latest frozen members before appending the new
  task revision. If the previewed task or suite changed, the save returns a
  conflict so the manager can review the new revision.
- Private input receipts keep references and digests. Original prompt and
  context bodies stay under their existing retention and access controls.

## Curate a suite

- Open **Benchmarks** and select a factory. Use tags to collect tasks by work
  type and set the suite purpose to **Regression** or **Holdout**.
- Open a suite revision to inspect its members, criteria, and recorded
  eligibility. Use revision history to inspect a previous selection.
- Editing a task saves a new task revision. To change a suite's criteria,
  select that task revision and save the suite. The previous suite revision
  remains available with its original criteria.

## Restore captured inputs

The server-side replay boundary accepts an exact task revision, an authorized
factory manager, and an explicit utility sandbox connection. It verifies live
access to the source session, Git repositories and selected context before
restoring. Revocation, source erasure, missing records, and digest mismatches
stop restoration. A retained ref must still resolve to the captured commit. A
historical SHA without a named ref must be fetched by SHA from the same
repository. A manual retry can also require the original private Git bundle.

| Input                              | Verification                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| Checkout and optional retry bundle | Exact retained ref or commit, private bundle digest, final commit and Git tree              |
| Original request and definition    | Admission prompt bytes and canonical definition digest                                      |
| Context, feedback and predecessors | Canonical manifest and the original fingerprints for selected bodies and repository commits |
| Skills and agent prompt            | Exact scoped revisions and independently checked digests                                    |

Verified text is staged in a private temporary file outside the checkout.
Read-context repositories are exported at the recorded commits. The restoration
receipt identifies the task revision, source attempt, checkout and tree, staged
bundle digest, original renderer and runtime identity, and reproducibility
limits. The receipt contains no prompt or context bodies. Wallie only returns
the restored files to the authorized server operation. It removes the temporary
bundle and stops the sandbox when that operation ends.

The original task prompt is available when its admission receipt survives.
The historical rendered prompt is digest-only. The receipt reports missing
rendered bytes, renderer version drift, unverified model aliases, and unknown
runtime versions separately. The receipt identifies the actual utility provider and
connection revision, with an explicit limit when either differs. Requested candidate changes are identified
explicitly and do not replace the restored baseline. Restoration opens no PR,
updates no ref, and starts no agent.

For the read-only Vercel smoke, use credentials for a dedicated sandbox test
project and the archived fixture in the existing Wallie repository:

```sh
node --env-file="$WALLIE_VERCEL_SMOKE_ENV" \
  --import ./scripts/register-server-only.mjs --import tsx \
  scripts/smoke-benchmark-replay.ts \
  refs/heads/wallie/checkpoints/5ba156cc-ba2e-40a8-87e8-29e383ef815d/538c7db75b663a795d8ce6fde06b98b4d42ed3e4 \
  538c7db75b663a795d8ce6fde06b98b4d42ed3e4
```

The smoke verifies the same tree and bundle receipt in two fresh sandboxes.
It confirms the original sandbox is stopped and its source removed before
starting the second.

## Isolate replay tools

| Policy profile      | Tool behavior                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `blocked`           | Deny every call.                                                                                         |
| `recorded_fixtures` | Serve an approved, pinned fixture for an exact tool read. Deny other calls.                              |
| `isolated_test`     | Serve an approved, pinned local response for an exact recognized operation, including a simulated write. |

- Each execution pins the task revision, restoration receipt, and policy
  revision. Wallie records the decision before returning a denial or the
  digest-checked fixture bytes. Revocation stops future fixture responses.
- Trusted restoration uses repository-scoped read credentials and GitHub-only
  egress. Before the trial can run, Wallie removes the checkout remote, verifies
  Vercel's `deny-all` policy, and rechecks access. Trial commands cannot inject
  environment variables. The replay broker has no production transport.
- The isolated runtime receives approved task context for local processing.
  Snapshot exports contain IDs, digests, and qualification codes. Private
  context, raw fixture responses, endpoints, and credentials are outside that
  export.

Run the hosted smoke with the dedicated Vercel test project:

```sh
node --env-file="$WALLIE_VERCEL_SMOKE_ENV" \
  --import ./scripts/register-server-only.mjs --import tsx \
  scripts/smoke-benchmark-replay-isolation.ts
```

## Run one isolated trial

- Admission pins the task revision, policy and approved fixture, Vercel connection,
  and runner version. The internal session uses the ordinary queue and exact
  job/run claim. Updated Node and Workerd workers opt in to benchmark claims.
- The worker rechecks current access as the admitted actor. The
  `recorded-fixture-v1` runner reads a pinned Git blob in the sealed sandbox,
  commits its result locally, and validates the produced commit and tree.
- One terminal transaction binds the restored input receipt, approved tool
  response receipt, private artifact and checkpoint to the exact attempt.
  Cancellation or an expired claim prevents a late result from being adopted.
- Trial sessions stay outside production session numbers, totals, notifications,
  scorer sampling, and Git or pull-request publication.

Run the live fixture against disposable Supabase and the Vercel test project:

```sh
WALLIE_BENCHMARK_TRIAL_SMOKE_WORKDIR=/path/to/disposable-supabase \
  node --env-file="$WALLIE_VERCEL_SMOKE_ENV" node_modules/vitest/vitest.mjs \
  run src/lib/factory-benchmarks/trial-live.fixture.test.ts
```

The fixture uses anonymous read access to the archived public Wallie ref.
It checks the private bundle in Storage and removes the temporary trial data.

## Freeze a comparison

- An experiment pins the suite revision, replay policy revision, and exact
  candidate factory revisions. In the suite’s comparison form, choose the
  model, harness, worker runtime, and whole factory revision for each side.
- Qualified comparisons currently use exact OpenAI model snapshots through
  Codex or OpenCode on Node with Vercel. A capability check must match the
  repository, harness, native model ID, and active connection. A repository
  mismatch with an eligible task, unresolved stage, remote tool, or unsupported
  runtime blocks the freeze.
- The baseline and candidate positions retain the definition digest, model and
  harness IDs, capability receipt, connection revision, CLI version, and
  toolchain digest. The check qualifies the configured tools. Actual replay
  results require a runner that uses those exact pins. The recorded-fixture
  scheduler rejects comparisons with these pins.
- The freeze command materializes one identity per task, candidate, and
  repetition. Repeated candidates share the planned seed for each repetition.
  Each cell retains its exact task revision, timeout, and recorded eligibility.
- The receipt reports expected, materialized, eligible, and ineligible counts.
  Unverified tasks count as ineligible and keep their recorded status in the
  matrix. A matching retry returns the same comparison. Scheduling uses these
  frozen identities as the input to trial admission.
