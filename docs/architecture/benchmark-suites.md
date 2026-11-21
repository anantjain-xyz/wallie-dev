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
