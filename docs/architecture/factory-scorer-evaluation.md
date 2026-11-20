# Factory scorer evaluation

Each run uses the scorer revision IDs pinned by its session's factory
definition. A sampling policy belongs to one of those revisions. A factory
manager can append policy revisions with an expected revision number.

## Policy and eligibility

| Field             | Rule                                                              |
| ----------------- | ----------------------------------------------------------------- |
| Rate              | Integer basis points from 0 to 10,000                             |
| Seed              | Stable text used with the run UUID to compute the draw            |
| Terminal statuses | Success, error, or canceled. The default cohort includes success. |
| Stages            | Optional list of stage UUIDs in the factory                       |

The sampler checks the terminal status, stage, and retained evidence first.
It then compares a SHA-256 draw with the policy rate. Keeping the seed and
increasing the rate preserves membership for runs that already fell below
the lower rate. A new policy revision records a separate cohort.

Each policy and run pair has one immutable receipt. The receipt records the
attempt, pinned definition, finish time, commit when available, and evidence
references. Unsupported lineage, missing evidence, and withheld evidence
produce explicit exclusions. Command reports must match the frozen validation
plan and the exact input and final commit and tree.

## Live sampling and backfill

- The worker reads committed `run.finished` observations. Each observation uses
  the latest policy that existed when Wallie recorded it. The sampler advances
  through committed transaction IDs so a late commit cannot be skipped.
- Service-only backfill uses an explicit policy revision and a fixed exclusive
  finish time. The first page freezes the set of committed transactions.
  Continue with the returned run ID, finish timestamp, and signed horizon.
  Forward the timestamp strings unchanged to preserve their precision.
- Repeat a page with the same inputs to reuse its receipts. Start a new
  traversal to include runs that committed after the previous horizon.
- Candidates equal eligible plus excluded. Eligible includes sampled and
  unsampled runs. Sampled counts measure admission to the sampled cohort.

## Evaluation queue

Each sampled receipt can create one evaluation job for its run and scorer
revision. The job pins the receipt and target commit. Sampling another policy
revision for the same run and scoring rules reuses the existing job.

| Event                              | Queue behavior                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| Claim                              | Reserve one workspace slot and issue a 90-second lease with a new attempt ID.              |
| Retryable failure or expired lease | Retain the attempt and schedule a retry with backoff. The job allows up to three attempts. |
| Permanent failure or cancellation  | Close the job and retain attempt history.                                                  |
| Pause or factory archive           | Keep queued jobs and hold new claims. Active attempts keep their existing leases.          |

An attempt can settle only its own current, unexpired lease. An expired or
canceled attempt cannot complete another worker's claim. The worker can
recover leases in both Node and Cloudflare.

Workspace owners and admins can pause the evaluation lane or set its
concurrency limit. Factory managers can cancel scoped jobs. Evaluations have
their own locks and capacity. Production runs, publication, and human
review continue through their existing commands.

## Judge execution

Workspace owners and admins can configure a dedicated OpenRouter judge
through `/api/workspaces/[workspaceId]/evaluation-lane/judge-profile`.

| Method   | Purpose                                                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | Read the current profile revision and approved media types.                                                                                           |
| `PUT`    | Save the model, provider route, and media permissions against `expectedRevision`. Supply a dedicated API key to enable the profile or rotate its key. |
| `DELETE` | Revoke the active key against `expectedRevision` and retain prior profile metadata.                                                                   |

The dedicated key is encrypted and kept outside production credential
bindings. A worker can claim judge work when the workspace has an enabled
profile. Wallie releases the key once per attempt after checking the current
lease, profile, evidence references, and retention state.

The judge reads only the sampled evidence for the exact run and commit.
Snapshots and reports retain their private paths. The worker verifies the exact
bytes before it sends inline media. Commit comparisons reject missing changes
and comparisons that differ from the accepted checkpoint.

The request uses one approved provider route with no fallback. Wallie asks for
structured output and validates the score and any cited locations. Rubrics and
evidence enter the model as data. The judge has no tools or production write
access. Wallie applies the pinned thresholds after parsing the score.
[OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
· [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)

The adapter bounds text to 96 KiB, screenshots to 1 MiB, and recordings to
8 MiB and 30 seconds. A missing, unsupported, malformed, or unavailable input
or answer produces an explicit non-passing state. The invocation records
the model, worker runtime, evidence digest, and typed candidate result.
Temporary evidence outages use the queue's retry limit. Cancellation and
lease expiry close the owning invocation without adopting a candidate.

## Evaluation receipts

Wallie records one immutable receipt when an evaluation attempt settles.
The receipt pins the job, attempt, target commit, scorer revision, and
original sample. An authorized invocation also pins the judge profile and
the digest of the evidence the worker prepared. A worker can settle only
the exact current attempt before its lease expires. Duplicate or late
completion cannot add another receipt or change the recorded result.

| Usage provenance | When Wallie records it                                       |
| ---------------- | ------------------------------------------------------------ |
| Measured         | The provider reports the paired token counts or billed cost. |
| Estimated        | A trusted writer supplies the estimate and its revision.     |
| Unavailable      | The attempt completes without that measurement or estimate.  |

Tokens and cost each have their own provenance. An unavailable amount stays
null and leaves its job total unavailable. A recorded zero remains a known
amount. Cancellation and lease recovery keep the attempt's timing and
identity even when usage is unavailable. Production execution budgets use
their existing usage records.

Authorized factory readers can open the bounded attempt history at
`GET /api/workspaces/[workspaceId]/factories/[factoryId]/evaluations/[evaluationId]`.
Use the evaluation job ID in the path. Wallie checks the run's current
visibility and withholds explanations and evidence locations when the
underlying evidence is no longer readable.

## Scorer presets

Factory managers can copy a shipped version from **Scorers → New scorer**.
The copy fills the draft name, identifier, rubric, evidence requirements, and
passing value. Edit the draft and publish it as a factory scorer, then bind
its exact revision through the factory definition. A new copy starts from
the shipped version each time.

| Version 1 preset                | Required evidence      | What the judge checks                                        |
| ------------------------------- | ---------------------- | ------------------------------------------------------------ |
| Correctness                     | Code diff and artifact | Whether the change supports the intended behavior.           |
| Verification                    | Validation report      | Whether relevant checks ran and passed for the exact commit. |
| Scope                           | Code diff and artifact | Whether material changes belong to the requested work.       |
| Redundant tests and scaffolding | Code diff              | Whether new coverage or setup adds a distinct test outcome.  |

The redundant-test preset distinguishes a regression test that detects a
previously uncaught behavior from an assertion that repeats existing coverage
or uses unrelated setup. Findings cite the relevant lines in the exact diff.
Ambiguous context and unsupported diffs produce an inconclusive receipt with
a reason. Presets use the same sampling and binding controls as custom rubrics.
