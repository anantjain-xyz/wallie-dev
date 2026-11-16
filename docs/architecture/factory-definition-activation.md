# Factory definition activation

The default factory's active revision is the target of its highest activation number. Publication and rollback append to that history. [Session admission](factory-session-inputs.md) pins the active revision under the same workspace lock fence.

## Commands

`/api/workspaces/[workspaceId]/factory-definition` exposes the workspace’s default factory.

| Method and action      | Behavior                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET`                  | Active workspace members can read the observed head and recent activations. Use `beforeActivationNumber` to page backwards. |
| `POST` with `draft`    | Managers save a compiled structured or JSON source against `expectedActivationNumber`.                                      |
| `POST` with `publish`  | Managers publish a saved `draftId` against the same expected activation it was saved from.                                  |
| `POST` with `rollback` | Managers activate a previously active `revisionId` against the expected current activation.                                 |

Use `expectedActivationNumber: 0` when no definition is active. A stale activation or draft base returns `409`. Activation also returns `409` if a concurrent GitHub update holds the installation or repository lock. Invalid references, incompatible configuration, and unavailable authority or capability evidence return `422`. The caller can inspect compiler diagnostics by field path.

## Shared draft in workspace settings

Settings use `/api/workspaces/[workspaceId]/factory-definition/settings` to show the published activation and the latest draft for that activation. The existing pipeline, coding agent, sandbox provider, execution policy, and delivery policy controls save sections of the same draft.

- Each section saves against the activation number and draft ID that supplied its values. A stale save returns `409`. **Reload configuration** refreshes those identities and retains unsaved fields.
- **Publish draft** activates the exact saved draft displayed in Settings. Staged policy revisions join the published configuration in the activation transaction.
- Credentials and connection tests use the operational integration records. Linear routing changes apply immediately and use the published stage IDs.

## Checking a saved runtime

Managers can run a capability check at `/api/workspaces/[workspaceId]/factory-definition/capability-check`. Submit `{"target":{"kind":"draft","id":"<draft UUID>"}}` or use `"revision"` and its UUID. The API returns `202` and runs the probe against the saved definition’s repository, agent, model, and sandbox provider. Poll the same endpoint with `draftId` or `revisionId`.

The probe uses the current sandbox connection and current manager credential. Its receipt belongs to the saved definition digest. Onboarding and the existing worker continue to read workspace runtime checks. Activation prefers the latest receipt for the saved digest and can use an exact matching workspace receipt when the definition has no prospective check.

## Authority and transaction ordering

Publication and rollback recompile stored bytes against the current workspace catalog and require the same canonical definition and digest. The service obtains enabled sandbox providers and probe requirements from the deployed provider contracts. The workspace currently has no per-factory skill or tool grants. Those references become selectable when the grant catalog ships in M03.

The database serializes writes through the workspace and factory locks and rechecks live rows before appending. The actor must still be an active owner or administrator with a current personal credential for the selected agent. The selected repository and its GitHub installation, policy revisions, approvers, sandbox connection, and latest matching capability report must remain eligible. Authority and credentials stay with their operational records. The revision keeps the compiled configuration and author identity.

Publishing copies the immutable draft bytes into a revision and appends its activation in the same transaction. Rollback appends an activation for an earlier revision. A failed command leaves drafts, revisions, history, and existing session pins intact. See [Factory definition records](factory-definition-records.md) for the storage contract.
