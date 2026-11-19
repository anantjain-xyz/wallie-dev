# Factory session inputs

Session creation acquires the workspace fence before reading the active factory definition. When a revision is active, session creation writes its revision ID and activation number to `session_factory_admission_inputs` in the same transaction as the session, first job, and queued run.

| Record                             | Captured inputs                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_factory_admission_inputs` | Exact activation and definition digest, pipeline, repository, stage order, model, policy, and original title and prompt with their digests.                                                                                                                                                     |
| `session_stage_approval_receipts`  | Exact approved artifact ID, version, and SHA-256. Every successful approval records a receipt. The current completion selects the applicable receipt.                                                                                                                                           |
| `session_attempt_manifests`        | Exact job, run, and attempt; pinned definition and its skill, tool, and policy references; selected source refs and actual checkout; predecessor receipts; digest, byte count, and renderer version of the rendered prompt; effective worker, model, sandbox, and credential binding selectors. |

The worker writes the manifest before starting the agent. The database checks ownership and validates predecessor and source identities. The service-only admission record preserves the original user input. Attempt manifests store rendered prompt digests and credential binding identifiers.

A completion from before approval receipts is recorded as `legacy_unverified`. The existing artifact loader can supply retained text for that stage. A legacy entry carries no approved artifact ID or digest. Historical attempts from before manifest capture have no manifest.

## Execution and retries

- Factory Definition shows the effective harness, model, supported options, sandbox provider, and credential authority for the selected saved definition. Current readiness checks the exact saved connection, repository capability receipt, and credential binding or human owner.
- Starting a session confirms the checked definition digest or the absence of an active revision at admission. Retry checks the original session owner or pinned service binding. The worker resolves the same model and sandbox provider from the admitted revision.
- Run Inspector reads the recorded profile from the exact attempt manifest and scoped credential receipt. It shows the actual worker runtime and preserves historical authority after revocation.

New enrolled sessions execute their compiled revision. The stage order, names, prompts, operating rules, approval policy, agent, sandbox provider, and execution and delivery policies come from that revision. Existing stable stage IDs anchor artifacts and reviews even when the live stage is renamed, moved, or archived. Publish a new revision to change the defaults for new sessions.

- Automatic retry and Retry keep the session's revision, Git lineage, and accepted predecessor. A credential revocation or disconnected repository or sandbox blocks further execution. Reconnecting the same provider requires a current capability check.
- The creation form shows the writable repository choices and stages. It starts with the factory default and confirms the chosen repository and displayed revision digest under the admission lock. If the default is unavailable, choose another writable repository explicitly.
- An explicit restart is a new `POST /api/sessions` request using `restartOfSessionId` and a fresh `requestId`. Send the desired input and attachments with the new request. It records the source session and starts fresh work under the current revision. When the request cites the same Linear issue, the source session retains its routing and the new session carries the issue link as context.

## Frozen run context

Each pinned factory attempt records a service-only `session_run_context_manifests` row before the agent starts. It has the owned run and attempt identity, a digest of the canonical manifest, and the exact origin when replaying. The manifest stores identities, digests, byte counts and inclusion or omission receipts, including exact read-context repository commits. Text remains in its owning source, conversation, feedback batch or artifact.

Packing reserves the required title, original prompt, applicable feedback and exact predecessor artifacts first. It then considers selected external revisions in definition order, up to eight approved factory memories, and up to 32 earlier messages in conversation sequence order. The input budgets are 128 KiB and 32,768 conservatively estimated tokens. Each UTF-8 byte of context content counts as one estimated token. The manifest records exclusions, omitted older messages and unavailable sources. A required input that cannot fit stops the attempt and names its provenance key.

A retry restores the exact manifest selected by its job lineage. Current access is checked before reading private revisions. Wallie verifies the retained conversation messages and the exact required inputs against their recorded digests. If an input is missing, inaccessible, or changed, the retry reports that dependency and stops before launching the agent. New conversation messages, replacement source revisions, and other artifact versions cannot change a frozen attempt.

## Factory memory

- A pinned run can write one Markdown proposal, up to 4 KiB, to its private file outside the checkout. The Run Inspector records tool activity on that file with a generic label. Wallie stages the proposal against the producing run, attempt and exact final artifact digest. After publication, a factory manager can import it by artifact ID and version. Import creates a pending revision and consumes the staged body.
- Approval or rejection records the current human member and exact pending revision. Correction creates a new pending revision and withdraws the prior approval from future retrieval. If the new version is approved, new attempts can use it. The review commands reject stale current or pending revision IDs.
- Expiry stops retrieval at the configured timestamp. Forgetting removes the stored memory bodies and leaves the revision digests and review history available to explain earlier use.
- New attempt manifests record the exact approved revision, approval receipt, digest and byte count. The packer uses memory as untrusted reference text. A retry stops if a selected revision was corrected, expired or forgotten. Version-one manifests replay without adding memory.

Factory managers can read paginated memory and decision history or submit lifecycle commands at `/api/workspaces/{workspaceId}/factories/{factoryId}/memories`. Management uses the caller's human session, and attempt retrieval is service-only and scoped to the session's factory.

## Context and Memory review

- **Context** shows repository read grants, sync status and exact revision history. Factory managers see revision IDs, commits, digests and sizes. The history endpoint and page load never return document bodies.
- **Memory** shows the producing run and artifact, revision history and human decisions. Managers can import a private proposal from its producing run, correct or review it, set expiry, or forget the stored note. A forgotten revision keeps its provenance and displays the unavailable note state.
- **Frozen inputs** in Run Inspector lists what the attempt used, unavailable inputs and budget omissions. Authorized reviewers see exact revision and decision IDs and digests. Managers can follow these receipts to the scoped source and memory history. The inspector does not fetch memory or document bodies.

### Context and memory retention

- Set **Historical context retention** in workspace settings to remove old, superseded document bodies and unimported private proposals from finished runs. Current source revisions stay available. An exact replay stops when its recorded revision is unavailable.
- Removing a Context source clears its sync lease and erases its stored bodies. Revision IDs, digests, and byte counts remain available for historical inspection. A new sync cannot restore an erased revision.
- A memory revision's configured expiry withdraws it from retrieval. The worker purges the elapsed body and retains its revision and review records. Forgetting clears the family title and all of its revision bodies immediately.

## Repository bindings

| Purpose                       | Execution behavior                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default writable repository   | Used when a new session leaves the selection empty.                                                                                                                                                                                                      |
| Alternate writable repository | Select one at creation. The admission receipt, Git checkpoint lineage, and canonical PR carry that same repository.                                                                                                                                      |
| Read-context repository       | The worker pins the default branch's exact commit for a fresh attempt and restores the recorded commit on retry. A repository-scoped token has `contents: read`. The attempt prompt records the snapshot SHA and its path outside the writable checkout. |

- Retry and stage transitions keep the admitted writable repository. Disconnecting that repository blocks execution while the original identity remains in the receipt.
- Restart without a repository override keeps the original writable repository if the current definition still permits it. Selecting another writable repository explicitly starts new Git lineage.
- Read-context snapshots contain tracked source files without Git credentials or repository metadata. A failed connection stops the run before the agent starts. Publication remains scoped to the admitted writable repository.

## Enrollment and compatibility

| Session at admission                           | Execution inputs                                   | Evidence                                                                                  |
| ---------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| No active definition                           | Legacy pipeline and workspace settings             | `sessions.factory_definition_provenance` is `legacy`. Older attempts may lack a manifest. |
| Revision recorded before the execution cutover | Legacy pipeline and workspace settings             | The recorded activation identifies what was active at admission.                          |
| Admitted for pinned execution                  | Exact compiled revision and original session input | The admission record identifies the revision. Each new attempt records its own manifest.  |

Publication and rollback serialize with admission. The transaction that acquires the workspace lock first determines which activation a new session sees. An idempotent creation retry returns the original enrollment. Existing pinned sessions continue to use their saved revision across publication and rollback.

Credentials, repository access, and the sandbox connection are checked against current workspace authority. Historical receipts remain readable according to workspace access. An older definition keeps its recorded configuration each time it is reactivated.

## Recover an enrollment or execution failure

1. If **Create session** reports that the definition changed, reload the form and review the current repository and stages before submitting. Use the original request ID when retrying a submission with an uncertain result.
2. If **Publish draft** or **Roll back** is blocked, review the candidate digest and current activation in the editor. Restore the required workspace access, run a fresh capability check where needed, and run the configuration test for that exact candidate again.
3. If an enrolled session stops because its credential or connection changed, restore current access and retry the session on its pinned revision. To run with a different configuration, use the explicit restart operation after activating the desired revision.
4. If a legacy attempt has no manifest or its approval evidence is `legacy_unverified`, use the retained session and artifact history. Treat the unavailable fields as unknown.

See [Factory definition activation](factory-definition-activation.md), [Git checkpoint lineage](git-checkpoint-lineage.md), and the [local qualification fixtures](../../test/release/README.md).
