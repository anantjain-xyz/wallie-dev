# Factory scorer sampling

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
