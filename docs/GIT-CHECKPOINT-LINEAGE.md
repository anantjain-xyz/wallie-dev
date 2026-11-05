# Git checkpoint lineage

OP-494 adds immutable code provenance on top of the existing attempt-fenced source delivery lifecycle.

## Read and write contracts

- `session_git_roots` records the repository and initial base commit observed for a session. The first owned execution pins it; subsequent jobs reuse that initial base.
- `session_job_git_inputs` records one fixed code input per job intent. A retry keeps the job ID and advances `attempt_count`, while keeping the same input. A new review request creates a new job ID.
- `pin_session_job_git_input` requires the current job attempt and running run, locks session → job → run, and returns the persisted input. An empty receipt means ownership was lost. Workers restore the returned commit before running the agent; they fail closed if it cannot be fetched.
- `session_git_checkpoints` binds the accepted artifact to its exact input/output SHA and producing job/run/attempt. Adoption occurs in the same transaction as artifact publication. The source delivery outbox keeps the corresponding durable bundle and delivery lease.

`PinnedGitInput` and `GitCheckpoint` in `src/lib/pipeline/types.ts` derive from generated database types. `pinSessionJobGitInput` is the typed worker write boundary. Active workspace members can read provenance metadata; browser roles cannot write it or call the privileged pin/publication RPCs.

## Exact sandbox restoration

`SandboxCheckoutMode` supports `{ kind: "checkpoint", sha, ref? }`. A retained `refs/heads/...` or `refs/tags/...` ref is fetched and checked against the expected commit even if that commit is already cached locally. An omitted ref identifies the initial-base SHA compatibility path. Checkpoint mode ignores `baseBranch` and never falls back to a default branch.

The shared checkout verifies both HEAD and the attempt branch before dependency or agent bootstrap. Vercel creates an empty workspace for this mode; E2B, Daytona, and the fake use the same initialization and checkout code. A missing ref, inaccessible repository, changed ref, or dirty checkout produces an actionable `SandboxCheckpointRecoveryError`. Dirty tracked and untracked work is preserved, and acquired resources are stopped on failure or cancellation. Fake sandbox credentials use a separate temporary home outside its checkout.

For a retry, the worker reads the existing job input within its workspace and session before provisioning and passes its exact SHA into checkpoint mode. It revalidates claim ownership through the pinning RPC afterward. A repository change fails before provisioning, and the saved base-branch identity survives a default-branch rename.

Shared real-Git tests exercise all four providers. Run a live Vercel checkout-only smoke using operator credentials in a local env file:

```bash
node --env-file=.env.local --import ./scripts/register-server-only.mjs --import tsx scripts/smoke-checkpoint-checkout.ts owner/repo refs/heads/retained-checkpoint expected-40-character-sha
```

The smoke verifies exact checkout, rejects a mismatched or missing ref, and confirms its ephemeral sandbox is stopped. It does not execute an agent or deploy an application. OP-495's live Vercel smoke passed against `refs/heads/codex/op-494-git-checkpoints` at `55ff56f567490feb9d03461c8a68f6fc91ea7abf`; E2B and Daytona have shared contract coverage.

## Interpreting checkpoint metadata

An unchanged/no-code result has `output_sha = input_sha` and requires no invented commit or empty commit. Historical artifacts remain without a checkpoint when their source provenance is unknown. Repository disconnection preserves historical repository identity while preventing new work through that connection.

An output branch is a publication target, not evidence of remote delivery. The associated source delivery receipt records `delivered_ref` when GitHub delivery succeeds; it can identify a recovery branch instead of the intended attempt branch. That receipt is claim-fenced, and a recorded ref cannot be rewritten. No-code output and older delivery receipts retain a null ref rather than inventing a pushed branch. Delivery leases, status, and retry fields remain mutable; accepted checkpoint identities and their producing artifact/run associations are immutable.

## Follow-up boundaries

OP-495 provides exact restoration of a supplied checkpoint and starts retries from their saved input during provider setup. Orchestration still starts each new job from the session's pinned initial base; selecting prior accepted outputs and publishing retained checkpoints are subsequent integration work. OP-496 handles durable output publication/adoption, OP-497/OP-498 synchronize the canonical PR and review history, and OP-499 verifies the complete continuity workflow and rollout.

Migrations are forward-only and do not backfill fabricated historical SHAs. Run `pnpm check`, the database pgTAP suite, and generated-type drift verification before review. This change adds no user-facing UI.
