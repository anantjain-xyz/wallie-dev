# Git checkpoint lineage

Immutable code provenance builds on the attempt-fenced source delivery lifecycle (OP-494–OP-497).

## Read and write contracts

- `session_git_roots` records the repository and initial base commit observed for a session. The first owned execution pins this immutable identity; later generations may start from an accepted output in the same repository.
- `session_git_heads` records the session's last accepted output checkpoint. Checkpoint insertion advances it in the artifact-adoption transaction under the session lock. It describes a published result, which can still await human review. Service and browser roles can read scoped metadata; only the private checkpoint trigger maintains the cursor.
- `session_job_git_inputs` records one fixed code input per job intent, including its exact source checkpoint and effective restore ref. Enqueue preselects successor inputs before a worker can claim them. The execution binding pair starts null and is filled once by the first owned pin; every Git identity field is immutable. A retry keeps the job ID and advances `attempt_count`, while keeping the original input and binding. A new review request creates a new job ID.
- `pin_session_job_git_input` requires the current job attempt and running run, locks session → job → run, verifies the observed checkout, and returns the persisted input. An empty receipt means ownership was lost. Workers restore the selected SHA and ref before agent bootstrap; they fail closed if it cannot be fetched or no longer matches.
- `session_git_checkpoints` binds the accepted artifact to its exact input/output SHA and producing job/run/attempt. Adoption occurs in the same transaction as artifact publication. The source delivery outbox keeps the corresponding durable bundle and delivery lease.
- `session_checkpoint_publications` privately saves the original artifact text, source identity, expected version, retained ref, and original attempt deadline before any remote push. Its identity and payload cannot be replaced during recovery. Browser roles cannot read it; service-role mutations use fenced RPCs.

`PinnedGitInput` and `GitCheckpoint` in `src/lib/pipeline/types.ts` derive from generated database types. `pinSessionJobGitInput` is the typed worker write boundary. Active workspace members can read provenance metadata; browser roles cannot write it or call the privileged pin/publication RPCs.

## Exact sandbox restoration

`SandboxCheckoutMode` supports `{ kind: "checkpoint", sha, ref? }`. It fetches the exact `refs/wallie/checkpoints/...` ref or a historical branch or tag ref. It verifies the expected commit even when the sandbox already has that commit. An omitted ref identifies the initial-base SHA compatibility path. Checkpoint mode ignores `baseBranch` and never falls back to a default branch.

The shared checkout verifies both HEAD and the attempt branch before dependency or agent bootstrap. Vercel creates an empty workspace for this mode; E2B, Daytona, and the fake use the same initialization and checkout code. A missing ref, inaccessible repository, changed ref, or dirty checkout produces an actionable `SandboxCheckpointRecoveryError`. Dirty tracked and untracked work is preserved, and acquired resources are stopped on failure or cancellation. Fake sandbox credentials use a separate temporary home outside its checkout.

For both a successor and a retry, the worker reads the job input within its workspace and session before provisioning and passes its exact SHA and effective ref into checkpoint mode. The selected repository wins over changed PR or workspace defaults; a missing or archived connection cannot redirect execution. An explicit session repository conflict fails before provisioning. The pinning RPC revalidates ownership and checkout afterward, and the saved base-branch identity survives a default-branch rename.

Shared real-Git tests exercise all four providers. Run a live Vercel checkout-only smoke using operator credentials in a local env file:

```bash
node --env-file=.env.local --import ./scripts/register-server-only.mjs --import tsx scripts/smoke-checkpoint-checkout.ts owner/repo refs/heads/retained-checkpoint expected-40-character-sha
```

The smoke verifies exact checkout, rejects a mismatched or missing ref, and confirms its ephemeral sandbox is stopped. It does not execute an agent or deploy an application. OP-495's live Vercel smoke passed against `refs/heads/codex/op-494-git-checkpoints` at `55ff56f567490feb9d03461c8a68f6fc91ea7abf`; E2B and Daytona have shared contract coverage.

## Durable publication and atomic adoption

The worker captures safe tracked and nonignored untracked changes using explicit literal paths. It reserves runtime credential and prompt paths, scans staged content and newly introduced Git history, and rejects captured runtime prompt or registered credential values. All four agent runners report current and refreshed credential fields in memory. Matching covers known values of at least eight characters and their raw, URL-encoded, and JSON-escaped forms; it is not a general secret detector. Existing reserved files may remain unchanged or be deleted. Runtime validation data uses a private temporary directory outside the checkout and is removed after capture.

The worker records normalized usage and provenance through `record_session_run_usage` on the exact running attempt before source preparation. After durable private bundle storage, it atomically prepares the source and immutable publication intent. A leased consumer restores that bundle and pushes `refs/wallie/checkpoints/<run-id>/<output-sha>` with a create-only lease. Existing intents keep their pinned `refs/heads/wallie/checkpoints/...` ref. The consumer verifies the exact remote SHA after push, including after an ambiguous response, before passing the proof to adoption. It checks ownership before the push and before adoption.

`adopt_session_checkpoint_publication` locks session → job → run, verifies the current attempt, publication lease, repository/installation identity, and original deadline, then commits the remote receipt, checkpoint, artifact, successful run/job, and `awaiting_review` transition in one transaction. Failure after push leaves an orphan retained ref and the same private intent available for recovery. Failure after commit is resolved by its adopted receipt. Remote failure leaves the session in progress and never accepts an artifact claiming that code. Node stall recovery and Cloudflare interruption recovery preserve this obligation. Maintenance retries within the original deadline without rerunning the agent; expiration retires that attempt. Stale or cancelled work cannot adopt.

Accepted head changes enqueue canonical PR synchronization separately from artifact adoption. PR or GitHub API failures do not undo a durable checkpoint or prevent reviewing its artifact.

## Lifecycle handoff

Approval validates the displayed stage, artifact ID and version, then selects the next selected stage by position. The reviewed artifact's checkpoint becomes that successor job's fixed input in the same transaction, including when intermediate stages are excluded. Request changes selects the exact reviewed checkpoint for a new job of the same stage. Adopting an existing queued job requires its frozen input to agree; it never repoints an executing generation.

Automatic retries retain the generation's original input. A failed attempt's private bundle or remotely pushed candidate is not an accepted checkpoint and cannot become a retry input. Cancellation and stale review requests keep their existing ownership and version guards.

No-code results keep `output_ref` null and `output_sha = input_sha`. Successors inherit the producing job's effective input ref, so any number of text-only stages preserve the same code and repository without making empty commits or PRs.

Historical cursor recovery uses only an exact current-artifact/checkpoint association. It does not guess from the newest timestamp. Older code checkpoints require a known actual delivery ref; an old intended branch alone does not prove restoration. Missing or ambiguous known lineage produces an actionable recovery error instead of silently resetting to the initial base or current main. Already pinned generations keep their original input.

## Interpreting checkpoint metadata

An unchanged/no-code result has `output_sha = input_sha` and requires no invented commit or empty commit. Historical artifacts remain without a checkpoint when their source provenance is unknown. Repository disconnection preserves historical repository identity while preventing new work through that connection.

New code checkpoints store the verified retained remote ref in `output_ref`. New no-code checkpoints have a null `output_ref`, reuse their input SHA, and skip retained-checkpoint pushes. Initial no-code output creates no PR; a later canonical operation can advance its fence while preserving the existing code and PR. Historical checkpoints keep their original metadata, where an output branch was only an intended publication target. The separate source delivery receipt records `delivered_ref` after PR delivery; it can identify a recovery branch instead of the intended attempt branch. Both receipts are claim-fenced, and recorded refs cannot be rewritten. Delivery leases, status, and retry fields remain mutable; accepted checkpoint identities and their producing artifact/run associations are immutable.

## Canonical session pull request

`session_pr_sync` records the intended accepted checkpoint, generation, observed source/PR heads and synchronization status. `session_pr_epochs` fixes the repository, base branch, canonical source branch and eventual PR number for each explicit PR lifecycle. `session_pr_operations` is a private, immutable publication ledger with leased claims and accepted receipts. Browser roles can read scoped synchronization metadata; service-role mutations go through fenced RPCs. New operation admission locks the workspace before session → synchronization → epoch → operation, so deletion cannot race an uncommitted publication claim.

The trusted publisher restores the accepted checkpoint from its exact remote ref without running repository source. It atomically updates the PR branch `refs/heads/wallie/sessions/<session>/<epoch>` and its fence `refs/wallie/fences/<epoch>` with explicit leases. The PR branch points at the accepted code SHA and can trigger normal previews. The custom checkpoint and fence refs sit outside the branch namespace. Each operation advances the fence to a unique commit even when the code SHA stays the same. A stale publisher fails the fence lease if the PR branch returns to an earlier SHA. Unsupported atomic pushes and unexpected ref changes stop publication.

Existing epochs keep their original `refs/heads/wallie/session-fences/...` ref. Successor epochs use a custom ref. Deploy the compatible Node and Cloudflare workers before applying the custom-ref migration so both runtimes can handle newly prepared refs.

Only a known operation's exact source/fence pair reconciles a lost Git response. A newer desired checkpoint never rewrites an unresolved operation. An older operation can record its own receipt, then maintenance promotes the newer target from that owned receipt; it cannot mark the newer target synchronized. The exact open PR head must agree before synchronization is reported. Webhooks dirty canonical state before a fresh, token-fenced GitHub observation; stale observations cannot regress state. This status is synchronization evidence, not the CI/review/mergeability readiness gate owned by OP-506.

PR identity is pinned once. Before creating it, the publisher examines all PR states for the exact repository and epoch branch. A durable creation marker prevents repeating an uncertain POST. A definitive permission/validation rejection can be retried after reconciliation. A lost response that committed recovers by observing the same PR, including if it has since closed. If a request's outcome remains unknowable and no PR can be observed, `pr_creation_uncertain` remains visible and automatic creation stays stopped; reconcile that reserved branch with GitHub before operator recovery. A failed or missing GET of a pinned PR never permits replacement.

Closed and merged epochs are terminal. The publisher checks before a Git update and observes afterward; closure and Git ref updates cannot share a cross-service transaction, so a concurrent close can race an in-flight push, but the result is recorded as terminal/unsynchronized and future publication stops. Wallie never reopens a PR. An active human workspace member can explicitly request a successor with `POST /api/sessions/<id>/pull-request` and `{ "expectedEpochId": "<uuid>", "requestId": "<uuid>" }`. The idempotent request creates a distinct epoch and branch while retaining prior PR history. `GET` on that route exposes scoped metadata with private, non-cacheable responses. No dashboard UI is added in this milestone.

New managed sessions suppress legacy attempt publishers, including claim rechecks immediately before old remote mutations. Enrollment waits for existing legacy leases to expire. Known open/unknown legacy PRs and attempted but unreceipted legacy deliveries halt enrollment with `legacy_pr_cutover_required`; reconcile that history or start a new session. Lease expiry cannot revoke an already-sent GitHub request. Historical links remain historical rather than being silently adopted as canonical. Initial no-code output creates no branch or empty PR. Later text-only outputs preserve the existing code and canonical PR. Agents receive read-only checkout tokens and a typed platform policy requiring local work; trusted publishers alone receive repository write tokens.

Use `scripts/smoke-continuity-release.ts` for the combined live-provider/GitHub proof in the existing `anantjain-xyz/wallie-dev` repository. It uses unique test refs and its own PR base while preserving `main`, repository settings and unrelated history. Do not create per-run repositories. The older standalone `smoke-canonical-pr.ts` is a historical empty-fixture helper; it is superseded by the combined release proof. See [Worker operations](../deployment/WORKER-OPERATIONS.md#isolated-release-proof) for execution and integration boundaries.

## Follow-up boundaries

OP-495 provides exact restoration of a supplied checkpoint. OP-496 adds durable remote publication and atomic adoption, and OP-497 carries accepted checkpoints through review transitions and fixed-input retries. OP-498 synchronizes the canonical PR, OP-502 snapshots inline feedback for a revision, and OP-499 verifies the complete continuity workflow and rollout.

Migrations are forward-only and do not backfill fabricated historical SHAs. Run `pnpm check`, the database pgTAP suite, and generated-type drift verification before review. This change adds no user-facing UI.
