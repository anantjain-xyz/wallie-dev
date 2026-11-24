# Connector installations

An installation binds a verified provider tenant and installation ID to a Wallie
workspace. Each resource has one factory owner. An authorized workspace owner
or admin publishes a mapping revision to enable or disable the resource.

| Provider | Resource identity     | Credential authority                                                                                                  |
| -------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GitHub   | Numeric repository ID | Existing GitHub App installation owned by the workspace. The repository must belong to that installation and factory. |
| Linear   | Team or project ID    | The workspace's `LINEAR_API_KEY` at the secret ID and material revision used to verify the Linear organization.       |

Provider setup verifies the tenant, installation, and selected resources before
calling the service-only configuration functions. Factory members can read
mapping history in their own factory. The installation state lookup returns
`connected`, `credential_unavailable`, or `disconnected` and omits credential
material.

## Rotation and disconnect

- Rotation increments the installation generation and replaces the credential
  reference. The resource IDs, mapping revisions, and existing conversation
  sources keep their identities.
- A change to the existing Linear key invalidates connector authority until
  provider setup verifies and records its new material revision. A suspended
  GitHub installation or unavailable repository also blocks live access.
- Disconnect clears live connector credential references. Existing conversation
  sources keep their session access rules. GitHub and Linear credentials used
  by existing integrations have their own lifecycle.
- Reconnect through verified setup for the same workspace and provider tenant.
  Use the current generation. If the provider issued a replacement installation
  ID, the current installation must be disconnected or unavailable. Enabled
  mappings can resume their saved cursors. Disabled mappings require a new
  enabled revision.
- Workers resolve live subscriptions with `readConnectorSubscription` before
  use. Cursor writes require the exact installation generation, mapping
  revision, and cursor generation from that read. A stale worker must reload
  before advancing a cursor.

## External actors

Provider adapters verify the installation, tenant, and immutable upstream
actor ID before requesting a link. A human links their own Wallie account.
A workspace owner or admin can link a service actor to an existing factory
service principal. Revocation retires the link and preserves its history.

| Decision    | Required authority                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Start work  | A current resource mapping, a verified actor link, and an exact execution grant with permission to create sessions. |
| Review work | A verified human link and current factory access. The review command applies its own artifact and reviewer checks.  |

The event resolver records the initiator separately from the service principal
and budget payer. A service actor must match the principal on the grant.
Intake and review commands recheck the actor link in the same transaction as
the admission or decision so revocation can take effect before the write.

## GitHub requests

A GitHub request starts when a verified human applies a configured label to an
open issue or pull request. The factory owner or admin saves the label ID for
each item type on the mapped repository. The rule pins the current mapping,
service execution grant, and active factory definition. Update the rule after
changing the mapping or definition.

The webhook records newer open, close, and label removal events for each source.
It captures the exact base branch and same-repository head SHA for pull
requests. The session prompt includes bounded GitHub title and body as external
context. One transaction rechecks the actor and grant, creates the session and
first job, and binds the issue or pull request to the conversation.

The same pull request deliveries still wake verification refresh. Existing
automation rules consume their existing event types independently. A pull
request with an existing Wallie source or an active automation intake keeps
that attribution when it receives the request label.

### GitHub conversation continuity

The `issue_comment` webhook attaches comments from a verified human to the
existing issue or pull request conversation. Wallie matches the repository and
thread against its admission receipt. GitHub uses a separate numeric issue ID
for the pull request timeline. The first qualified comment records that
association. Edits preserve the original conversation entry and append the
new version. Deletions record a tombstone and leave the conversation history
available. Replays share the provider's comment identity. App and bot actors
are ignored at the webhook boundary. Review decisions still use the signed-in
Review Workbench and its exact review target.

Linked progress and outcomes use durable outbox receipts. Review-ready
notices link to the exact stage, artifact version, and review revision.
Each notice has its own immutable identity. A retry observes the original
GitHub thread before settling a write with an unknown result. The observation
needs the exact delivery marker and the App's verified bot identity.

The App needs **Issues** read access to receive issue comments. Replies on an
issue require **Issues** write access. Replies on a pull request use **Pull
requests** write access. Check the approved installation permissions and the
`Issue comment` webhook subscription when enabling this flow.
[GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
