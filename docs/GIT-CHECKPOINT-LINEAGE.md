# Git checkpoint lineage

OP-494 adds immutable code provenance on top of the existing attempt-fenced source delivery lifecycle.

## Read and write contracts

- `session_git_roots` records the repository and initial base commit observed for a session. The first owned execution pins it; subsequent jobs reuse that initial base.
- `session_job_git_inputs` records one fixed code input per job intent. A retry keeps the job ID and advances `attempt_count`, while keeping the same input. A new review request creates a new job ID.
- `pin_session_job_git_input` requires the current job attempt and running run, locks session → job → run, and returns the persisted input. An empty receipt means ownership was lost. Workers restore the returned commit before running the agent; they fail closed if it cannot be fetched.
- `session_git_checkpoints` binds the accepted artifact to its exact input/output SHA and producing job/run/attempt. Adoption occurs in the same transaction as artifact publication. The source delivery outbox keeps the corresponding durable bundle and delivery lease.

`PinnedGitInput` and `GitCheckpoint` in `src/lib/pipeline/types.ts` derive from generated database types. `pinSessionJobGitInput` is the typed worker write boundary. Active workspace members can read provenance metadata; browser roles cannot write it or call the privileged pin/publication RPCs.

## Interpretation

An unchanged/no-code result has `output_sha = input_sha` and requires no invented commit or empty commit. Historical artifacts remain without a checkpoint when their source provenance is unknown. Repository disconnection preserves historical repository identity while preventing new work through that connection.

An output branch is a publication target, not evidence of remote delivery. The associated source delivery receipt records `delivered_ref` when GitHub delivery succeeds; it can identify a recovery branch instead of the intended attempt branch. That receipt is claim-fenced, and a recorded ref cannot be rewritten. No-code output and older delivery receipts retain a null ref rather than inventing a pushed branch. Delivery leases, status, and retry fields remain mutable; accepted checkpoint identities and their producing artifact/run associations are immutable.

## Follow-up boundaries

OP-495 restores prior accepted outputs in fresh sandboxes and carries lineage across stages. OP-496 adopts revision outputs, OP-497/OP-498 synchronize the canonical PR and review history, and OP-499 verifies the complete continuity workflow and rollout. OP-494 keeps the existing stage execution behavior of starting each new job from the session's pinned initial base; it makes retries reproducible and records their precise provenance. It does not claim that prior-stage source restoration or canonical PR synchronization is complete.

Migrations are forward-only and do not backfill fabricated historical SHAs. Run `pnpm check`, the database pgTAP suite, and generated-type drift verification before review. This change adds no user-facing UI.
