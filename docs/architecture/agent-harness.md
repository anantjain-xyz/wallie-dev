# Agent Harness

Wallie's agent harness turns a workspace-configured stage into one sandboxed
Codex, Claude Code, Cursor, or OpenCode execution and one reviewable markdown artifact. This
document owns the prompt, credential, repository, event, and output contracts
around that execution.

For session and job transitions, see
[Pipeline and worker lifecycle](pipeline-worker-lifecycle.md). For provider
resource ownership and cleanup, see
[Sandbox provider contracts](sandbox-provider-contracts.md). For execution limits
and usage/cost provenance, see [Execution budgets](execution-budgets.md).

## Canonical owners

- [`src/lib/pipeline/processor.ts`](../../src/lib/pipeline/processor.ts):
  execution orchestration, events, artifacts, PR synchronization, and teardown.
- [`src/lib/prompt-templates/`](../../src/lib/prompt-templates/): template
  variables and rendering.
- [`src/lib/agent-runner/`](../../src/lib/agent-runner/): runner selection and the
  provider-specific process contracts.
- [`src/lib/agent-credentials/`](../../src/lib/agent-credentials/): session-owner
  credential resolution.
- [`src/lib/sandbox/`](../../src/lib/sandbox/): repository setup and isolated
  command execution.
- [`src/lib/repo-onboarding/skills.ts`](../../src/lib/repo-onboarding/skills.ts):
  canonical installable repository skill assets.

## Execution sequence

1. The worker loads the session and its current stage, then CAS-claims the
   unarchived session into `in_progress`.
2. The processor resolves the workspace's selected agent provider and model.
3. It loads pipeline operating rules, the job's immutable feedback batch (or
   legacy whole-stage feedback when no batch exists), and the latest unambiguous
   artifact for each stage with a valid completion row. Artifacts are matched by
   stage ID and exposed under the stage's current slug.
4. It prepends operating rules to the stage template and performs template
   substitution.
5. It resolves the credential belonging to the human who created the session.
6. It resolves the pinned repository, mints a GitHub installation token scoped to that repository with only
   read-only contents permissions,
   derives the stage branch, and loads the selected sandbox connection.
7. The provider creates a sandbox and reports its identity before setup. The
   processor persists provider, connection revision, and sandbox ownership on
   the active run.
8. Common setup checks out the branch, configures Git, installs the selected
   agent CLI, and installs Playwright/Chromium support.
9. The runner creates a private per-invocation directory outside the checkout,
   writes the prompt and provider auth there with owner-only permissions, starts
   the CLI, and streams normalized, sanitized events.
10. The processor persists events and fenced usage snapshots, uses only the
    successful completion event's nonblank `finalOutput` as the artifact,
    captures the source and immutable publication
    intent, verifies its retained ref, then atomically accepts the
    checkpoint/artifact for review. Trusted maintenance synchronizes one
    canonical PR separately.
11. Cleanup runs in `finally`. The sandbox is stopped unless source recovery
    requires retention; that recovery window ends at the provider's existing
    expiry.

Every retry creates a fresh sandbox and restores the same generation's fixed input
SHA/ref/repository before agent bootstrap. Review handoff selects the accepted
checkpoint for a new generation. A session does not own a persistent filesystem
across attempts. Agents work locally; their read-only GitHub credentials and typed
platform policy leave remote publication to the trusted worker.

## Prompt assembly

The renderer currently exposes:

| Variable                         | Source                                                             | Classification                   |
| -------------------------------- | ------------------------------------------------------------------ | -------------------------------- |
| `session.title`                  | `sessions.title`                                                   | Member-controlled data           |
| `session.prompt`                 | `sessions.prompt_md`                                               | Member-controlled data           |
| `session.stageSlug`              | Current `pipeline_stages` row                                      | Manager-controlled configuration |
| `attempt.number`                 | `rejection_count + 1`                                              | Derived value                    |
| `attempt.feedback`               | Saved feedback for the exact job, with legacy stage fallback       | Reviewer-controlled data         |
| `artifact.previousStages.<slug>` | Latest unambiguous artifact for a completed stage, by current slug | Agent-generated data             |
| `repo.name`                      | Resolved session repository name                                   | Repository data                  |
| `repo.fullName`                  | Resolved session repository full name                              | Repository data                  |
| `repo.defaultBranch`             | Resolved default branch, falling back to `main` if absent          | Repository data                  |

Pipeline `operating_rules_md` is trimmed and prepended to
`pipeline_stages.prompt_template_md`. Both are manager-controlled instruction
planes. The renderer supports variable substitution and non-nested conditional
blocks. Unknown variables become empty strings.

Template variable paths support letters, digits, underscores, dots, and hyphens.
References such as `artifact.previousStages.code-review` work in both
substitutions and conditional blocks.

`loadCompletedStageArtifacts()` requires a `session_phase_completions` row for
the stage's durable ID, then selects that stage's highest artifact version and
maps it to the current slug. Missing stage identities and invalidated completions
do not contribute prompt input; duplicate artifacts at the highest version stop
the attempt. This is a completed-stage projection, not an immutable snapshot of
the originally approved artifact. Treat every value as agent-generated input.

## Current instruction and trust boundary

The production `runStage()` path classifies every prompt slot before rendering.
Control text uses `trustedPromptValue()`; session, feedback, attachment, and
artifact data uses `untrustedPromptValue()`.
[`renderStagePrompt()`](../../src/lib/prompt-templates/index.ts) accepts only those
pre-classified values. The single crossing into a renderer string is
[`verifyPromptBoundary()`](../../src/lib/pipeline/prompt-safety.ts): trusted
control text keeps its template syntax, and untrusted data is wrapped in
collision-free boundary markers that cannot occur in its body.

The compile fixture in
[`src/lib/prompt-templates/index.typecheck.ts`](../../src/lib/prompt-templates/index.typecheck.ts)
uses `@ts-expect-error` to prove raw strings are rejected. When extending
prompts, classify every new slot and preserve the typed value through the
rendering API; never pass a raw string across the boundary.

The typed boundary covers values Wallie interpolates into the stage prompt. It
does not cover repository-local instructions the CLI discovers after clone.
Treat interpolated untrusted values as capable of containing instructions,
delimiters, or unexpectedly large content — they are labeled and delimited, not
stripped.

Configuration query failures stop the attempt; only absent configuration keys
use defaults. Claude Code receives the workspace `max_turns` budget (1–100, default 5), editable in Coding agent Settings or through `/api/agent-config`
within one CLI invocation, including its tool round trips. All assistant content
blocks are preserved. A successful Claude result and zero process exit are both
required before emitting completion; error results, turn-limit exhaustion, and
missing results cannot publish partial work. The pipeline requires a successful
completion event from every runner before it publishes reviewable output.

## Runner and credential contract

| Runner      | Credential path                                                                                 | Process behavior                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Codex       | OpenAI API credential or per-user ChatGPT/Codex credential                                      | Runs inside the external sandbox with the configured model and streams normalized events                    |
| Claude Code | Per-user Anthropic API credential                                                               | Runs with permission bypass inside the external sandbox and streams normalized events                       |
| Cursor      | Expiring per-user API key minted by Cursor browser sign-in                                      | Runs Cursor CLI inside the external sandbox and streams normalized events                                   |
| OpenCode    | Per-user OpenCode Zen API key, plus optional per-provider keys keyed by the model’s provider id | Runs OpenCode CLI with isolated XDG auth (`auth.json` entries by provider id) and streams normalized events |

Credentials belong to the session creator, not the current reviewer. ChatGPT
subscription credentials are written to an isolated Codex home under a private
`/tmp/wallie-codex-*` directory with owner-only permissions. Refreshed auth caches are persisted after the run with optimistic
credential-version and generation guards. Runs may use the same saved
credential concurrently; stale refresh and reconnect writes do not replace
newer state, including after a disconnect and reconnect. Within one credential
generation, the provider's latest `last_refresh` wins when concurrent runs
rotate auth tokens.

GitHub installation tokens are scoped to one repository and their purpose:

- `checkout`: the coding-agent sandbox receives contents-read access for checkout.
- `execution`: the trusted publisher receives contents-write and pull-request-write
  access. These credentials are not supplied to the coding-agent process.
- `capability-check`: provider probes receive contents-read access.

The trusted publication policy requires local agent work and reserves remote Git
and PR writes for Wallie, including when a customized prompt requests a push.
Arbitrary `workspace_secrets` are not injected into the coding-agent process.

Repository-local `AGENTS.md` files and installed skills are interpreted by the
selected CLI. Wallie prepares those assets during repository onboarding, but
the target repository remains their runtime semantic owner.

## Event, source, and artifact contract

- Runner output redacts active credentials before events reach logs, artifacts,
  or PR prose. Setup and SDK errors pass through the same boundary.
- Text, tool, completion, and error events remain distinct. Publication requires
  explicit successful completion and a nonblank `finalOutput`. Progress, tool
  activity, partial output, and completion summaries do not become the artifact.
  Missing final output creates a visible run diagnostic, publishes no artifact,
  and does not automatically retry; progress and partial output remain in Run history.
- New attempts append version 1 envelopes to `agent_run_events`. Page within
  the exact run and attempt by increasing `sequence`. `causation_sequence`
  links tool results and unresolved-call gaps to their calls. It also links
  terminal usage to its completion. An identical replay keeps the original
  event and legacy message.
- Payloads use typed, bounded fields for text, progress, tool calls and
  results, terminal outcomes, and usage. The worker redacts credentials before
  clipping and marks shortened fields with `truncated`. Codex captures command
  and MCP tool items. Claude Code captures assistant tool calls and user tool
  results. The adapters retain text output and record gaps for unsupported
  content and missing pairs. Provider IDs stay in memory. Cursor and OpenCode
  report `normalized_source_only` until OP-533.
- Codex turn usage remains an accounting event. The final-message file is the
  authoritative Codex deliverable. Claude Code uses the successful result event
  as its deliverable.
- `capture_end` reports whether Wallie drained the normalized stream to a
  terminal outcome. An interrupted or missing end marker, a missing sequence,
  a gap, or a truncated event indicates incomplete capture. For Codex and
  Claude Code, the end marker also counts tool calls, results, missing pairs,
  unsupported events, and truncated events for the exact attempt.
  The source formats are documented by [Codex exec JSONL](https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs)
  and [Claude Code streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output).
- The append transaction also writes the compatible `agent_run_messages`
  projection for Run history. Existing runs keep their legacy messages, and
  post-run diagnostics continue to use that history.
- Before publication, Wallie commits remaining nonignored working-tree changes
  with repository hooks disabled, then captures an incremental Git bundle from
  the original base to the final head. Dirty submodules and changed gitlinks
  (including intermediate commits) cannot be checkpointed because bundles omit
  submodule objects; unchanged baseline gitlinks are allowed.
  New or modified Git LFS pointers, including intermediate commits, are rejected
  before publication because a Git bundle omits their external payloads. Source
  is retained only in its original sandbox until provider expiry, without a
  durable payload guarantee; unchanged pointers in the base are allowed.
- Bundles are limited to 4 MiB and stored privately under
  `session-source-checkpoints/<workspace>/<run>.bundle`. If Storage is unavailable,
  a service-only outbox row can hold a bounded base64 fallback.
- Source and artifact text are persisted in one immutable intent before remote I/O.
  The original attempt deadline, exact run/attempt, repository and bundle digest
  remain fixed through worker restart. Remote retained-ref proof precedes atomic
  artifact/checkpoint adoption; no-code output inherits its actual restore ref.
- Trusted PR synchronization is independent: one immutable epoch fixes the PR
  identity, atomic code/fence leases preserve external commits, and publisher and
  webhook observations share a token reserved before their final GET. A PR/head
  mismatch is unsynchronized, never merge readiness.
- Closed/merged PRs are terminal and require an explicit human successor. Unknown
  creation outcomes remain GET-only until reconciled. Agents never push or create
  PRs themselves, including when older customized stage text asks them to do so.
- Each trusted remote operation verifies the connected installation and numeric
  repository identity. Recovery uses bare Git plumbing without source execution.

## Failure, retry, and teardown

- Setup and execution failures retire only their captured attempt. Each new
  attempt receives a distinct branch and sandbox.
- A saved checkpoint survives sandbox teardown and worker crashes. Checkpoint
  publication failures retry the same immutable intent within the original
  attempt deadline, without rerunning the agent. Canonical PR synchronization
  is a separate recoverable obligation.
- A Storage outage uses the private database fallback. Successful GitHub delivery
  clears fallback bytes; Storage checkpoints remain until workspace deletion.
- If both durability stores fail, no artifact is published and no automatic new
  attempt is queued. The sandbox and `source_recovery_required` marker are kept
  for operator recovery until the provider's existing expiry. This is a finite
  recovery window, not a guarantee of durability during a dual-store outage.
- A failed retention-marker write still permits capture and Storage upload. If
  the marker and both stores are unavailable, retention exists only in the live
  worker; a process loss cannot guarantee that the reaper will preserve it.
- Cancellation and workspace deletion retain their authority to stop sandboxes.
  Deletion blocks new delivery claims/uploads and drains checkpoint storage before
  removing tenant rows and credentials.

## Continuity release contract

The database release control starts paused. Fresh-session enrollment is explicit
and immutable; pre-release sessions require a new session rather than a guessed
head import. Admission/revision checks span claim, execution start and canonical
promotion; pause defers unstarted claims without failing their generation. Durable
checkpoint recovery remains available while paused. See
[Worker operations](../deployment/worker-operations.md#controlled-checkpoint-continuity-release)
for operator enable/disable, legacy recovery and retention steps.

The opt-in `pnpm check:continuity` fixture exercises the actual processor and DB
with deterministic runner/provider boundaries; real-provider qualification uses
`scripts/smoke-continuity-release.ts`. Both record exact input/output lineage,
review transitions, restart recovery and stable canonical PR identity. Ordinary
`pnpm test` remains independent of a local database. Candidate cleanup retires
only unadopted, expired owned refs after seven days and cannot delete referenced
lineage; private payload-retention exceptions are documented in Worker operations.

## Known implementation gaps

These are current limitations, not desired contracts:

- A total rendered-prompt budget is not enforced.
- Session prompts and legacy reviewer feedback are not bounded by the prompt
  renderer. New feedback batches enforce a 40,000-code-point limit, but this and
  route limits on templates and operating rules do not bound the combined prompt.
- Continuation IDs are not supplied by the generic processor. It supplies the
  remaining session ceiling as `maxTokens`, but no current CLI adapter has a
  verified max-output-token option; attempts, elapsed time, and reactive usage
  checks remain the enforcement path.

Remove a limitation from this section only in the pull request that establishes
and proves the replacement contract.

## Change checklist

When changing the harness:

1. Classify every new prompt value as instruction, trusted configuration,
   member data, reviewer data, agent data, or derived metadata.
2. Update the variable table and test missing, malformed, and delimiter-bearing
   input.
3. Preserve session-owner credential selection and version-and-generation-guarded auth-cache
   persistence.
4. Keep provider SDK details behind runner and sandbox interfaces.
5. Define what becomes an event, artifact, PR update, or diagnostic.
6. Test empty output, cancellation, setup failure, and a late terminal write.
7. Use the fake sandbox for deterministic orchestration proof and a real
   provider capability check for provider claims.
