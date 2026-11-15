# Factory definition activation

The default factory's active revision is the target of its highest activation number. Publication and rollback append to that history. Session admission will use the active revision when OP-543 adds pins.

## Commands

`/api/workspaces/[workspaceId]/factory-definition` exposes the workspace’s default factory.

| Method and action      | Behavior                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET`                  | Active workspace members can read the observed head and recent activations. Use `beforeActivationNumber` to page backwards. |
| `POST` with `draft`    | Managers save a compiled structured or JSON source against `expectedActivationNumber`.                                      |
| `POST` with `publish`  | Managers publish a saved `draftId` against the same expected activation it was saved from.                                  |
| `POST` with `rollback` | Managers activate a previously active `revisionId` against the expected current activation.                                 |

Use `expectedActivationNumber: 0` when no definition is active. A stale activation or draft base returns `409`. Activation also returns `409` if a concurrent GitHub update holds the installation or repository lock. Invalid references, incompatible configuration, and unavailable authority or capability evidence return `422`. The caller can inspect compiler diagnostics by field path.

## Authority and transaction ordering

Publication and rollback recompile stored bytes against the current workspace catalog and require the same canonical definition and digest. The service obtains enabled sandbox providers and probe requirements from the deployed provider contracts. The workspace currently has no per-factory skill or tool grants. Those references become selectable when the grant catalog ships in M03.

The database serializes writes through the workspace and factory locks and rechecks live rows before appending. The actor must still be an active owner or administrator with a current personal credential for the selected agent. The selected repository and its GitHub installation, policy revisions, approvers, sandbox connection, and latest matching capability report must remain eligible. Authority and credentials stay with their operational records. The revision keeps the compiled configuration and author identity.

Publishing copies the immutable draft bytes into a revision and appends its activation in the same transaction. Rollback appends an activation for an earlier revision. A failed command leaves drafts, revisions, history, and existing session pins intact. See [Factory definition records](factory-definition-records.md) for the storage contract.
