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
  the task.
- The capture command writes the task and suite membership in one transaction.
  Adding the same run to a suite returns its existing member. An explicit
  addition copies the suite's latest frozen members before appending the new
  task revision.
- Private input receipts keep references and digests. Original prompt and
  context bodies stay under their existing retention and access controls.
