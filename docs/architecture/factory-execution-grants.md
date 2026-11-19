# Factory execution grants

A factory manager registers a named service principal and approves a versioned grant for it. The principal owns the service credential authority. An active human invokes the work, and the grant names the workspace member accountable for the execution budget.

| Grant field                                | Authority                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Factory and service principal              | One factory in one workspace, with a named credential owner.                                |
| Writable repository                        | One exact repository owned by the factory.                                                  |
| Read-context repositories and tools        | Explicit allowlists. Each configured execution input must be covered.                       |
| Execution policy revision and budget payer | One pinned policy and one active human workspace member accountable for its use.            |
| Version and expiry                         | A definition pins the approved version. The current version must match and still be active. |

## Manager operations

Factory managers can list and register principals at `/api/workspaces/{workspaceId}/factories/{factoryId}/service-principals`. They approve, replace, and revoke grants at `/api/workspaces/{workspaceId}/factories/{factoryId}/execution-grants`. An update or revocation includes the last seen `expectedVersion`. A stale request returns `409`. Reapproval after revocation creates a new grant ID. The factory audit shows the acting manager and the grant version for each decision.

Set `executionGrant` in the factory definition JSON to the grant's `id` and `version`. The definition also selects the granted writable repository and execution policy revision. Publishing, rolling back, admitting a session, and starting a queued attempt check the grant against the current factory scope.

## Admission attribution

`session_factory_admission_inputs` records the invoking actor, credential owner, budget payer, grant version, and policy revision as separate fields. Historical admissions preserve the evidence they originally recorded. Each queued attempt checks the exact grant version and the invoker's current factory access. Expiry, revocation, and changes to that grant block new attempts on the old version.

Grant-backed attempts stop before sandbox provisioning or personal credential lookup until scoped service credentials can be resolved. Human approvals continue to require an authenticated, authorized human.

## Governance

Open **Governance** and choose a factory you manage to create a service
principal, approve an execution grant, or revoke an existing version. The
change appears in the factory audit history with its actor and exact resource.

Credential history shows the bound principal, agent, provider, grant, and
revocation state. Workspace owners and admins manage saved credentials through
the shared Factory Definition controls. Open the selected factory’s active
definition to inspect current admission readiness.

## Machine tokens

A grant can explicitly approve machine commands for reading sessions, creating sessions, sending follow-ups, answering clarifications, or canceling session work. New and existing grants start with an empty command allowlist unless a manager approves one.

Open the grant in **Governance** to create, list, or revoke machine tokens. A token selects one or more of the grant’s approved commands. It belongs to the same workspace, factory, and service principal and stops working when the exact grant version expires, changes, or is revoked. The optional token expiry can shorten that window. Only the issue response contains the credential. The token list records the public ID, lifecycle, approved commands, and most recent successful command. Issuance and revocation appear in factory audit history.

Machine commands must call `internal.require_factory_machine_token` inside their authoritative database transaction before accessing protected data or changing state. Pass the parsed ID and digest from the server-only credential parser. The check locks the factory, credential, and exact grant, and records successful use in the same transaction. Use the returned grant ID and version to apply its resource restrictions to the operation. Machine credentials carry no human review authority.

## OAuth clients

In **Governance**, register a client with its exact callback URIs, allowed
commands, and one approved execution grant per factory. The operator selects
which factories the client can request. Each authorization records the
consenting human and the selected factories and scopes.

| Operation  | Authority                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorize  | `/oauth/authorize` checks the registered callback and S256 challenge. The consent decision uses the signed-in browser session and the selected factories’ current grants. |
| Exchange   | `POST /oauth/token` accepts the authorization code, verifier, client ID, and exact callback. It consumes the code once.                                                   |
| Refresh    | Submit the current refresh token to `/oauth/token`. A successful rotation replaces it. Reuse of an authenticated spent token revokes the connection and its credentials.  |
| Disconnect | Revoke the connection from **Connected clients** or revoke the registration from **OAuth clients** in Governance.                                                         |

Use `internal.require_factory_oauth_access_token` in the protected command’s
database transaction. It checks the connection, command scope, current human
factory access, and exact grant version. Record the service principal and the
consenting member separately. Artifact approval uses Wallie’s human review
flow.
