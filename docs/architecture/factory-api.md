# Factory API

The versioned API accepts Wallie machine tokens and OAuth access tokens with
the requested scope in the selected factory. Wallie resolves the principal
and exact grant, applies durable quotas, and rechecks the credential in the
database transaction that handles the command.

Get the OpenAPI document from `/api/v1/openapi.json` on your Wallie deployment
for request parameters, response fields, and error codes. Each protected
response is private and non-cacheable.

## Read endpoints

Paths below start with `/api/v1/workspaces/{workspaceId}/factories/{factoryId}`.
Reads require `sessions:read` and cover sessions whose approved writable
repository is bound by an immutable definition or Git root.

| Endpoint                                           | Result                                                   |
| -------------------------------------------------- | -------------------------------------------------------- |
| `GET /sessions`                                    | Sessions and their current review references.            |
| `GET /sessions/{sessionId}`                        | One session with its browser URL and exact review state. |
| `GET /sessions/{sessionId}/conversation`           | Messages and their sanitized source associations.        |
| `GET /runs`                                        | Runs, optionally filtered by `sessionId`.                |
| `GET /runs/{runId}`                                | One run with its artifact identity and coverage.         |
| `GET /sessions/{sessionId}/artifacts/{artifactId}` | One immutable artifact with its producing run and SHA.   |

Use the returned `nextCursor` with the same endpoint, factory, and filters.
The default page size is 25 and the maximum is 50. Sessions and runs list newest
first. Conversation defaults to `direction=before`. Use the returned
`resumeCursor` with `direction=after` to fetch messages added since the last
observed sequence, including after a complete or empty page.

## Session commands

Each write takes a UUID in the `Idempotency-Key` header.

| Endpoint                                                              | Scope                | Required intent                              |
| --------------------------------------------------------------------- | -------------------- | -------------------------------------------- |
| `POST /sessions`                                                      | `sessions:create`    | Title, prompt, repository, and named agent   |
| `POST /sessions/{sessionId}/follow-ups`                               | `sessions:follow-up` | Exact stage, artifact, version, and feedback |
| `POST /sessions/{sessionId}/clarifications/{clarificationId}/answers` | `sessions:clarify`   | Exact artifact, version, and answer          |
| `POST /sessions/{sessionId}/cancel`                                   | `sessions:cancel`    | The exact run to stop                        |

- Reuse the same key and body after a lost reply. Wallie rechecks current
  authority and returns the original receipt. Changing the intent under the
  same key returns `409`.
- Creation requires the published agent and writable repository covered by
  the grant. Equivalent browser and API requests under the same key converge
  when they select the same service execution configuration.
- Follow-ups and clarification answers include the displayed review revision.
  Answer an open specification question through its exact clarification
  endpoint. Review decisions open in the authenticated Workbench.
- A write receipt includes the canonical session and conversation links
  and the exact job or run IDs when available. The receipt records the
  original actor. OAuth records the consenting human separately.

## Review and availability

- A review reference identifies the current stage, artifact ID and version,
  producing run and attempt, and review revision. Open its link in the
  authenticated Review Workbench to take the human action. The link preserves
  that artifact and revision through sign-in. A superseded review opens its
  designated artifact read-only, with a link to open the current review.
- An artifact read returns its recorded stage and version, producing run and
  attempt, and exact checkpoint commit. Run coverage distinguishes unavailable
  artifact provenance and the expiry of retained transcript data.
- Message and artifact text is returned as sanitized HTML. Images render as
  labels. Source links use HTTPS paths, and private destinations, credentials,
  URL queries, and fragments are withheld.

| Status | Meaning                                                                     |
| ------ | --------------------------------------------------------------------------- |
| 400    | A parameter or cursor cannot be used for this request.                      |
| 401    | The request needs a live Wallie bearer credential.                          |
| 403    | The credential lacks the requested scope or factory access.                 |
| 404    | The requested resource is missing, deleted, or outside the approved scope.  |
| 409    | The admission expired, the intent is stale, or the operation key conflicts. |
| 410    | An authorized retained resource lacks readable content or provenance.       |
| 413    | The request body exceeded the supported size.                               |
| 415    | The command expected an application/json body.                              |
| 422    | The requested agent or factory execution configuration is unavailable.      |
| 429    | A workspace or principal quota applies. Wait for `Retry-After`.             |
| 503    | The read service is temporarily unavailable.                                |

## Outbound events

A factory manager can register a receiver in Governance under **Event subscriptions**. Choose an active machine token or OAuth authorization with `sessions:read`. The subscription follows the exact factory, writer repository, service principal, and execution grant version bound to that authorization. Wallie shows the signing secret once when the subscription is created.

Configure the receiver, then choose **Verify endpoint**. Wallie sends an HTTPS POST with JSON fields `type` set to `wallie.subscription.verification` and `challenge` containing a random value. The receiver must reply with a 2xx status and return that value in the `Wallie-Verification` response header. The configured URL must use a public DNS host on port 443. Wallie re-resolves DNS and pins the connection for each request. Redirects are rejected.

For events, the receiver gets JSON with version `1`, stable event ID, event type, occurrence time, workspace, factory, session, and identifiers specific to the event. The receiver gets no conversation text, artifact content, trace data, or credentials. The event ID also appears in `Wallie-Event-Id` and the type in `Wallie-Event-Type`. If a session establishes its writer on the first Git input, creation and the initial start become eligible for delivery once that ownership is verified. The events retain their original occurrence times.

Verify `Wallie-Signature` by parsing `t=<unix-seconds>,v1=<hex>`. Compute HMAC-SHA256 with the signing secret as UTF-8 and the exact bytes of `<timestamp>.<eventId>.<raw HTTP body>`. Check equality in constant time before parsing or applying the body. Check the timestamp against a bounded clock-skew window and deduplicate on the stable event ID before applying side effects. Each retry has a fresh signature and the same event ID.

Use **Inspect deliveries** to see the delivery state, attempt count, HTTP status, and retry time. A timeout or process interruption can leave delivery unconfirmed even when the receiver applied it. Automatic and eligible manual retries are bounded. The current credential and grant must still allow sending after the connection is verified and before Wallie signs or writes the request. A send whose permission was already recorded may settle after revocation. Delivery history is retained for seven days.

The Node daemon sends directly. The native worker invokes the Node sender at `WALLIE_FACTORY_EVENT_DISPATCH_RELAY_URL`, which targets `/api/internal/factory-event-dispatch` on the Wallie application. Set the same dedicated `WALLIE_FACTORY_EVENT_DISPATCH_RELAY_SECRET` on the native worker and Node application. Both runtimes use the same durable delivery claims and authorization checks.
