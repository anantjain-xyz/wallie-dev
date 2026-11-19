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
  authenticated Review Workbench to take the human action.
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
