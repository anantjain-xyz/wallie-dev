# Factory session inputs

Session creation acquires the workspace fence before reading the active factory definition. It stores the definition revision and activation number in the same transaction as the session, first job, and queued run. A retried creation request returns the original session and pin. Workspaces without an active revision continue to create sessions marked `legacy`.

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
- An explicit restart is a new `POST /api/sessions` request using `restartOfSessionId` and a fresh `requestId`. It records the source session and admits fresh work under the current revision. Send the desired input and attachments with the new request. The new session starts its own source lineage.
- Activations captured before the execution cutover remain provenance for those sessions, which run through the legacy path. Historical completions without receipts remain `legacy_unverified` there.

See [Factory definition activation](factory-definition-activation.md) and [Git checkpoint lineage](git-checkpoint-lineage.md) for the underlying identities.
