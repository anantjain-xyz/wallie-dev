# Connector installations

An installation binds a verified provider tenant and installation ID to a Wallie
workspace. Each resource has one factory owner. An authorized workspace owner
or admin publishes a mapping revision to enable or disable the resource.

| Provider | Resource identity     | Credential authority                                                                                                  |
| -------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GitHub   | Numeric repository ID | Existing GitHub App installation owned by the workspace. The repository must belong to that installation and factory. |
| Linear   | Team or project ID    | The workspace's `LINEAR_API_KEY` at the secret ID and material revision used to verify the Linear organization.       |
| Slack    | Channel ID            | Current Slack credential encrypted with Wallie's workspace secret encryption.                                         |

Provider setup verifies the tenant, installation, and selected resources before
calling the service-only configuration functions. Factory members can read
mapping history in their own factory. The installation state lookup returns
`connected`, `credential_unavailable`, or `disconnected` and omits credential
material.

## Rotation and disconnect

- Rotation increments the installation generation and replaces the credential
  reference or encrypted material. The resource IDs, mapping revisions, and
  existing conversation sources keep their identities.
- A change to the existing Linear key invalidates connector authority until
  provider setup verifies and records its new material revision. A suspended
  GitHub installation or unavailable repository also blocks live access.
- Disconnect clears connector-owned credential material and live credential
  references. Existing conversation sources keep their session access rules.
  GitHub and Linear credentials used by existing integrations have their own
  lifecycle.
- Reconnect through verified setup for the same workspace and provider tenant.
  Use the current generation. If the provider issued a replacement installation
  ID, the current installation must be disconnected or unavailable. Enabled
  mappings can resume their saved cursors. Disabled mappings require a new
  enabled revision.
- Workers resolve live subscriptions before use. Cursor writes require the
  exact installation generation, mapping revision, and cursor generation from
  that read. A stale worker must reload before it can advance a cursor.
