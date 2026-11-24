# Connector installations

An installation binds a verified provider tenant and installation ID to a Wallie
workspace. Each resource has one factory owner. An authorized workspace owner
or admin publishes a mapping revision to enable or disable the resource.

| Provider | Resource identity     | Credential authority                                                                                                  |
| -------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GitHub   | Numeric repository ID | Existing GitHub App installation owned by the workspace. The repository must belong to that installation and factory. |
| Linear   | Team or project ID    | The workspace's `LINEAR_API_KEY` at the secret ID and material revision used to verify the Linear organization.       |
| Slack    | Channel ID            | The verified workspace and app install with an encrypted bot token pinned to the current generation.                  |

Provider setup verifies the tenant, installation, and selected resources before
calling the service-only configuration functions. Factory members can read
mapping history in their own factory. The installation state lookup returns
`connected`, `credential_unavailable`, or `disconnected` and omits credential
material.

## Connector settings

Open **Settings → Integrations → Connector resources** and select a factory and
provider. Workspace owners and admins can verify the existing GitHub App or
Linear key or install Slack. Select a resource returned by the provider to map it to the factory.
A GitHub repository exposes separate intake labels for issues and pull requests.
On a Linear mapping, **Linear routing and outcomes** lets admins choose which
workflow state IDs trigger intake and whether to post progress or change an
issue's status after final approval.

Factory managers can inspect the selected resource's ingress and outbound
history. The panel shows retained delivery state, a bounded reason, and retry
timing. Linear discovery shows the next scan, a current provider cooldown, or a
sanitized failure that still belongs to the current scan configuration.
**Schedule retry** advances one eligible receipt within its original
retry window. **Check provider status** schedules an observation for a delivery
whose result remains unknown. Both actions preserve existing attempts, and the
worker rechecks credential and mapping authority before processing the receipt.

## Slack installation

1. Create an internal Slack app. Add the Wallie HTTPS `/api/slack/callback`
   URL as an OAuth redirect. Set `SLACK_APP_ID`, `SLACK_CLIENT_ID`,
   `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` on the Wallie server.
2. Add bot scopes `app_mentions:read`, `chat:write`, `channels:read`,
   `channels:history`, `groups:read`, and `groups:history`. Use a workspace
   installation with token rotation disabled for this connector. Add `openid`
   under **User Token Scopes** for the separate account-linking flow.
3. In **Connector resources → Slack**, enter the exact workspace ID from the
   `T…` segment of its Slack client URL and approve installation. Wallie
   compares the returned team and app IDs and shows the actual grants.
4. Invite the bot to a channel in Slack. Select the channel in Wallie and
   map it to the factory. Wallie verifies bot membership and rejects shared,
   archived, and direct-message conversations.
5. Each participant uses **Link Slack account** while signed in to Wallie.
   Wallie binds the signed Slack user and team IDs to the current Wallie
   member. The participant can revoke that link in Settings.

**Disconnect** removes Wallie's bot credential and advances the installation
generation. It preserves mappings, actor history, and source references.
Slack workspace administrators manage the app's installation in Slack.

[Slack OAuth installation](https://docs.slack.dev/authentication/installing-with-oauth/) ·
[Sign in with Slack](https://docs.slack.dev/authentication/sign-in-with-slack/)

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
are ignored at the webhook boundary. A retryable database lock defers the
exact signed delivery to the worker, which applies the same deduplication.
Review decisions use the signed-in Review Workbench and its exact review target.

Linked progress and outcomes use durable outbox receipts. Review-ready
notices link to the exact stage and artifact version. Wallie resolves the
current review revision for that artifact just before sending. Each notice
has its own immutable identity. A retry observes the original
GitHub thread before settling a write with an unknown result. The observation
needs the exact delivery marker and the App's verified bot identity.

The App needs **Issues** read access to receive issue comments. Replies on an
issue require **Issues** write access. Replies on a pull request use **Pull
requests** write access. Check the approved installation permissions and the
`Issue comment` webhook subscription when enabling this flow.
[GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)

## Slack thread intake

Enable Slack bot events `app_mention`, `message.channels`, and `message.groups`
with the HTTPS Request URL `/api/slack/events`. Slack signs the raw request
before Wallie accepts it. The app must already belong to a mapped channel.
A factory needs a published definition with an active session-creation grant.
Each person who sends a request or follow-up links their Slack identity in
Wallie.

Start a linked session by mentioning the installed bot at the root of a
thread. Follow-ups continue the existing conversation. Wallie checks the
current channel and actor before using the signed event. Duplicates do not
create another session. Edits append a new version and deletion retains a
record that fences later delivery. A follow-up from a linked actor can wait
briefly for its exact root when Slack delivers events out of order.

[Slack HTTP events](https://docs.slack.dev/apis/events-api/using-http-request-urls/)
