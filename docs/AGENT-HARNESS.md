# Agent Harness

Wallie's agent harness turns a workspace-configured stage into one sandboxed
Codex or Claude Code execution and one reviewable markdown artifact. This
document owns the prompt, credential, repository, event, and output contracts
around that execution.

For session and job transitions, see
[Pipeline and worker lifecycle](PIPELINE-WORKER-LIFECYCLE.md). For provider
resource ownership and cleanup, see
[Sandbox provider contracts](SANDBOX-PROVIDER-CONTRACTS.md).

## Canonical owners

- [`src/lib/pipeline/processor.ts`](../src/lib/pipeline/processor.ts):
  execution orchestration, events, artifacts, PR synchronization, and teardown.
- [`src/lib/prompt-templates/`](../src/lib/prompt-templates/): template
  variables and rendering.
- [`src/lib/agent-runner/`](../src/lib/agent-runner/): runner selection and the
  Codex/Claude Code process contracts.
- [`src/lib/agent-credentials/`](../src/lib/agent-credentials/): session-owner
  credential resolution.
- [`src/lib/sandbox/`](../src/lib/sandbox/): repository setup and isolated
  command execution.
- [`src/lib/repo-onboarding/skills.ts`](../src/lib/repo-onboarding/skills.ts):
  canonical installable repository skill assets.

## Execution sequence

1. The worker loads the session and its current stage, then CAS-claims the
   unarchived session into `in_progress`.
2. The processor resolves the workspace's selected agent provider and model.
3. It loads pipeline operating rules, the latest feedback for this stage, and
   the latest artifact version for every stage slug present on the session.
   After a rejection, that map can include the current stage's unapproved
   artifact.
4. It prepends operating rules to the stage template and performs template
   substitution.
5. It resolves the credential belonging to the human who created the session.
6. It resolves the pinned repository, mints a GitHub installation token,
   derives the stage branch, and loads the selected sandbox connection.
7. The provider creates a sandbox and reports its identity before setup. The
   processor persists provider, connection revision, and sandbox ownership on
   the active run.
8. Common setup checks out the branch, configures Git, installs the selected
   agent CLI, and installs Playwright/Chromium support.
9. The runner writes the prompt to `.wallie-prompt.txt`, starts the CLI, and
   streams normalized events.
10. The processor persists events, concatenates text events into the artifact,
    optionally opens or refreshes the stage PR, and CAS-publishes the artifact
    for review.
11. The sandbox is stopped in `finally`, whether the run succeeds or fails.

Every retry creates a fresh sandbox and checks out the stage branch again. A
Wallie session does not own a persistent filesystem across attempts.

## Prompt assembly

The renderer currently exposes:

| Variable                         | Source                                                        | Classification                           |
| -------------------------------- | ------------------------------------------------------------- | ---------------------------------------- |
| `session.title`                  | `sessions.title`                                              | Member-controlled data                   |
| `session.prompt`                 | `sessions.prompt_md`                                          | Member-controlled data                   |
| `session.stageSlug`              | Current `pipeline_stages` row                                 | Manager-controlled configuration         |
| `attempt.number`                 | `rejection_count + 1`                                         | Derived value                            |
| `attempt.feedback`               | Latest feedback for the current immutable stage ID            | Reviewer-controlled data                 |
| `artifact.previousStages.<slug>` | Latest artifact per slug, including the current slug on retry | Agent-generated data                     |
| `repo.name`                      | Declared by the renderer                                      | Currently empty in pipeline execution    |
| `repo.fullName`                  | Declared by the renderer                                      | Currently empty in pipeline execution    |
| `repo.defaultBranch`             | Renderer fallback                                             | Currently `"main"` in pipeline execution |

Pipeline `operating_rules_md` is trimmed and prepended to
`pipeline_stages.prompt_template_md`. Both are manager-controlled instruction
planes. The renderer supports variable substitution and non-nested conditional
blocks. Unknown variables become empty strings.

Template variable paths currently match only letters, digits, underscores, and
dots. Stage slugs permit hyphens, so a reference such as
`artifact.previousStages.code-review` is not recognized by either substitution
or conditional parsing and remains verbatim in the rendered prompt. Only stage
slugs without hyphens currently resolve through this dot-path syntax.

Despite its name, `loadCompletedStageArtifacts()` currently chooses the latest
artifact version for every slug on the session. It does not require a matching
completion row or filter by stage position. On a retry after rejection,
`artifact.previousStages.<current-slug>` therefore contains the current stage's
unapproved prior output. Treat every value in this map as agent-generated input,
even when its stage was approved.

## Current instruction and trust boundary

The present renderer performs raw substitution. It does not escape, delimit, or
sanitize session text, feedback, artifacts, operating rules, or stage
templates. [`sanitizeUntrusted()`](../src/lib/pipeline/prompt-safety.ts) is not
called by the production prompt path and recognizes boundaries from the retired
fixed-stage prompts.

There is therefore no mechanically enforced precedence between:

1. Workspace operating rules.
2. The current stage template.
3. Interpolated member, reviewer, or agent-generated data.
4. Repository-local instructions discovered by the CLI after clone.

Until a typed prompt boundary is implemented, changes must not claim that
untrusted prompt content is isolated. Treat every interpolated value as capable
of containing instructions, delimiters, or unexpectedly large content.

## Runner and credential contract

| Runner      | Credential path                                            | Process behavior                                                                         |
| ----------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Codex       | OpenAI API credential or per-user ChatGPT/Codex credential | Runs inside the external sandbox with the configured model and streams normalized events |
| Claude Code | Per-user Anthropic API credential                          | Runs with permission bypass inside the external sandbox and streams normalized events    |

Credentials belong to the session creator, not the current reviewer. ChatGPT
subscription credentials are written to `.codex/auth.json` with owner-only
permissions. Refreshed auth caches are persisted after the run with optimistic
credential-version and generation guards. Runs may use the same saved
credential concurrently; stale refresh and reconnect writes do not replace
newer state, including after a disconnect and reconnect. Within one credential
generation, the provider's latest `last_refresh` wins when concurrent runs
rotate auth tokens.

The GitHub installation token is placed in the isolated sandbox's credential
store for clone and push. Arbitrary `workspace_secrets` are not injected into
the coding-agent process.

Repository-local `AGENTS.md` files and installed skills are interpreted by the
selected CLI. Wallie prepares those assets during repository onboarding, but
the target repository remains their runtime semantic owner.

## Event and artifact contract

- Normalized runner events are appended to `agent_run_messages`.
- Text, tool input, completion, and error events remain distinguishable.
- Only text events are concatenated into the markdown artifact.
- An execution that produces no text is a stage error and creates no artifact.
- Artifact versions are per session and stage slug.
- Publishing the artifact requires the session to remain unarchived and
  `in_progress`.
- After the GitHub App and installation client initialize, PR synchronization
  failures are returned and logged without preventing artifact review.
- GitHub App construction or installation-client initialization happens outside
  that recoverable boundary; either failure currently fails the stage after the
  artifact insert, removes the unpublished artifact, and enters job retry/error
  handling.
- The artifact prefix is used as fallback PR prose; the artifact in Supabase is
  the review source of truth.

If cancellation wins after artifact insertion but before the guarded pointer
update, the processor deletes the unpublished artifact so the version remains
reusable.

## Failure, retry, and teardown

- Runner, setup, and artifact failures mark the run as error and park the
  session in `rejected`.
- Retry scheduling belongs to the job lifecycle and may reuse the stage branch,
  but never the sandbox.
- Cancellation first makes the job and run terminal, then attempts sandbox
  cleanup. Late processor writes preserve `canceled`.
- Setup failure after sandbox creation must stop the resource before the create
  call returns an error.
- Normal teardown is best effort; the stall detector, provider TTL, and sandbox
  reaper are recovery layers, not permission to omit `finally` cleanup.

## Known implementation gaps

These are current limitations, not desired contracts:

- Prompt trust isolation and a total rendered-prompt budget are not enforced.
- Session prompt and reviewer feedback sizes are not bounded by the prompt
  renderer; route limits on templates and operating rules do not bound the
  combined prompt.
- Repository variables are declared but not supplied by the processor because
  prompt rendering occurs before GitHub context is loaded.
- Artifact variables for valid hyphenated stage slugs are not recognized and
  remain verbatim in rendered prompts.
- Workspace `maxTurns` is loaded but not used by the generic processor;
  continuation IDs and `maxTokens` are also not supplied.
- `.wallie-prompt.txt` and repository-local `.codex/auth.json` are sensitive
  temporary files inside the checkout and are not mechanically protected from
  an accidental Git add by the target repository.
- Persisted text, tool, artifact, and PR output is not uniformly passed through
  one diagnostic-redaction boundary.
- GitHub App construction and installation-client initialization are outside
  the recoverable PR-synchronization boundary.

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
