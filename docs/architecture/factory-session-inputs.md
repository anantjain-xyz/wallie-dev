# Factory session inputs

Session creation acquires the workspace fence before reading the active factory definition. It stores the definition revision and activation number in the same transaction as the session, first job, and queued run. A retried creation request returns the original session and pin. Workspaces without an active revision continue to create sessions marked `legacy`.

| Record                             | Captured inputs                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_factory_admission_inputs` | Exact activation and definition digest, admitted pipeline, repository, selected stage order, queued model, effective execution policy, and hashes of the original title and prompt.                                                                                                             |
| `session_stage_approval_receipts`  | Exact approved artifact ID, version, and SHA-256. Every successful approval records a receipt. The current completion selects the applicable receipt.                                                                                                                                           |
| `session_attempt_manifests`        | Exact job, run, and attempt; pinned definition and its skill, tool, and policy references; selected source refs and actual checkout; predecessor receipts; digest, byte count, and renderer version of the rendered prompt; effective worker, model, sandbox, and credential binding selectors. |

The worker writes the manifest before starting the agent. The database checks ownership and validates predecessor and source identities. Manifest records are immutable and available to service callers. Prompts and credentials stay with their existing sources. The manifest carries their digests or scoped binding identifiers.

A completion from before approval receipts is recorded as `legacy_unverified`. The existing artifact loader can supply retained text for that stage. A legacy entry carries no approved artifact ID or digest. Historical attempts from before manifest capture have no manifest.

OP-543 captures admitted definition and effective dispatch inputs separately. OP-544 switches execution and normal retries to the pinned definition. See [Factory definition activation](factory-definition-activation.md) and [Git checkpoint lineage](git-checkpoint-lineage.md) for the underlying identities.
