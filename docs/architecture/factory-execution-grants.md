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
