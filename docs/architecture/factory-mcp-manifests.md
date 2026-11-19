# Factory MCP manifests

A factory manager approves a specific HTTPS MCP server revision and its declared operation names. A service execution grant lists the permitted `revisionId/operation` keys. The compiler intersects those approvals with the operations selected for the implementation agent and pins the resulting manifest in the factory definition.

| Boundary               | Check                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry               | A stable server can have multiple immutable revisions. A revision records its endpoint, authentication kind, and declared operation names.                  |
| Grant                  | Review each operation as a separate `revisionId/operation` key.                                                                                             |
| Secret binding         | A workspace owner or admin may delegate an existing saved secret to an exact bearer-auth revision, grant, and agent. The manifest holds only its reference. |
| Admission and attempts | Check the exact current grant, tool revision, and optional secret binding. Revocation blocks new work and retains historical manifest metadata.             |

## Configure a binding

1. Manage server revisions and secret references at `/api/workspaces/{workspaceId}/factories/{factoryId}/tools`. Use `register` for a new server, `revise` for new endpoint or operation metadata, and `revoke` for an exact revision. Use `bind-secret` and `revoke-secret` for bearer credentials.
2. Add the required scope keys to the reviewed service grant.
3. In the factory definition JSON, set `mcpBindings` to objects with `toolRevisionId`, `operations`, and `secretBindingId` for bearer authentication. Pin the implementation agent and grant revision in that definition.
4. Inspect the compiled manifest in **Factory Definition**. **Run inspector** displays the manifest pinned to the admitted execution.

## Run a binding

Codex, Claude Code, and OpenCode launch a dedicated stdio adapter for each approved HTTPS endpoint. The adapter confirms the selected tool names against the pinned endpoint, exposes the approved catalog to the CLI, and checks each call before forwarding it. Endpoints must support Streamable HTTP. The adapter accepts JSON or streamed responses and refuses HTTP redirects.

The worker rechecks the exact attempt, grant, revision, and credential bindings before launch. Each adapter process reads its private bootstrap file once and unlinks it before connecting to the endpoint. The runner removes transient MCP configuration and credential files on completion, failure, or cancellation. Run history records verified tool scopes and an attempt-specific cleanup receipt.

Definitions with no bindings compile to an empty runtime manifest. Cursor uses a run-local home and checks checkout and ancestor MCP configuration. A Cursor run with approved MCP bindings shows an unavailable state because team marketplace tools are outside Wallie's configuration boundary. Choose a supported agent or remove its MCP bindings. OpenCode uses a run-local configuration, rejects machine-managed configuration, and carries over the checkout's root instructions.
