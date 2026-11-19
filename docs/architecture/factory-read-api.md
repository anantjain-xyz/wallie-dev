# Factory read API

The versioned read API uses a machine token or OAuth access token with
`sessions:read` in the selected factory. Wallie resolves the principal and
exact grant, applies durable quotas, and rechecks the credential in the
database transaction that serves the read. Reads cover the grant’s approved
writable repository. They return only sessions whose repository is bound by an
immutable definition or Git root.

Get the OpenAPI document from `/api/v1/openapi.json` on your Wallie deployment
for request parameters, response fields, and error codes. Each protected
response is private and non-cacheable.

## Read endpoints

Paths below start with `/api/v1/workspaces/{workspaceId}/factories/{factoryId}`.

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

| Status | Meaning                                                                    |
| ------ | -------------------------------------------------------------------------- |
| 400    | A parameter or cursor cannot be used for this request.                     |
| 401    | The request needs a live Wallie bearer credential.                         |
| 403    | The credential lacks the requested scope or factory access.                |
| 404    | The requested resource is missing, deleted, or outside the approved scope. |
| 409    | The command admission expired or conflicted. Retry with a fresh request.   |
| 410    | An authorized retained resource lacks readable content or provenance.      |
| 429    | A workspace or principal quota applies. Wait for `Retry-After`.            |
| 503    | The read service is temporarily unavailable.                               |
