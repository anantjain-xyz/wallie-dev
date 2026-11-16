# Factory session inputs

Session creation acquires the workspace fence before reading the active factory definition. It stores the definition revision and activation number in the same transaction as the session, first job, and queued run.

| Record                             | Captured inputs                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_factory_admission_inputs` | Exact activation and definition digest, pipeline, repository, stage order, model, policy, and original title and prompt with their digests.                                                                                                                                                     |
| `session_stage_approval_receipts`  | Exact approved artifact ID, version, and SHA-256. Every successful approval records a receipt. The current completion selects the applicable receipt.                                                                                                                                           |
| `session_attempt_manifests`        | Exact job, run, and attempt; pinned definition and its skill, tool, and policy references; selected source refs and actual checkout; predecessor receipts; digest, byte count, and renderer version of the rendered prompt; effective worker, model, sandbox, and credential binding selectors. |

The worker writes the manifest before starting the agent. The database checks ownership and validates predecessor and source identities. The service-only admission record preserves the original user input. Attempt manifests store rendered prompt digests and credential binding identifiers.

A completion from before approval receipts is recorded as `legacy_unverified`. The existing artifact loader can supply retained text for that stage. A legacy entry carries no approved artifact ID or digest. Historical attempts from before manifest capture have no manifest.

## Execution and retries

New enrolled sessions execute their compiled revision. The stage order, names, prompts, operating rules, approval policy, agent, sandbox provider, and execution and delivery policies come from that revision. Existing stable stage IDs anchor artifacts and reviews even when the live stage is renamed, moved, or archived. Publish a new revision to change the defaults for new sessions.

- Automatic retry and Retry keep the session's revision, Git lineage, and accepted predecessor. A credential revocation or disconnected repository or sandbox blocks further execution. Reconnecting the same provider requires a current capability check.
- The creation form shows the active repository and stages. It confirms the displayed revision digest under the admission lock and refreshes its options on a conflict.
- An explicit restart is a new `POST /api/sessions` request using `restartOfSessionId` and a fresh `requestId`. Send the desired input and attachments with the new request. It records the source session and starts fresh work under the current revision. When the request cites the same Linear issue, the source session retains its routing and the new session carries the issue link as context.

## Enrollment and compatibility

| Session at admission                           | Execution inputs                                   | Evidence                                                                                 |
| ---------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| No active definition                           | Legacy pipeline and workspace settings             | The session has a `legacy` admission record. Older attempts may have no manifest.        |
| Revision recorded before the execution cutover | Legacy pipeline and workspace settings             | The recorded activation identifies what was active at admission.                         |
| Admitted for pinned execution                  | Exact compiled revision and original session input | The admission record identifies the revision. Each new attempt records its own manifest. |

Publication and rollback serialize with admission. The transaction that acquires the workspace lock first determines which activation a new session sees. An idempotent creation retry returns the original enrollment. Existing pinned sessions continue to use their saved revision across publication and rollback.

Credentials, repository access, and the sandbox connection are checked against current workspace authority. Historical receipts remain readable according to workspace access. An older definition keeps its recorded configuration each time it is reactivated.

## Recover an enrollment or execution failure

1. If **Create session** reports that the definition changed, reload the form and review the current repository and stages before submitting. Use the original request ID when retrying a submission with an uncertain result.
2. If **Publish draft** or **Roll back** is blocked, review the candidate digest and current activation in the editor. Restore the required workspace access, run a fresh capability check where needed, and run the configuration test for that exact candidate again.
3. If an enrolled session stops because its credential or connection changed, restore current access and retry the session on its pinned revision. To run with a different configuration, use the explicit restart operation after activating the desired revision.
4. If a legacy attempt has no manifest or its approval evidence is `legacy_unverified`, use the retained session and artifact history. Treat the unavailable fields as unknown.

See [Factory definition activation](factory-definition-activation.md), [Git checkpoint lineage](git-checkpoint-lineage.md), and the [local qualification fixtures](../../test/release/README.md).
