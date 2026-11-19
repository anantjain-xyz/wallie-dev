# Factory context sources

A factory manager can explicitly register and sync one GitHub Markdown or plain-text file through the workspace app API. A source pins the local repository, GitHub installation, numeric upstream repository, exact approved execution grant version, and case-sensitive path. The repository must appear in the grant's read-context scope.

## Operator commands

Use a signed-in Wallie session to call the factory-scoped endpoint.

`/api/workspaces/{workspaceId}/factories/{factoryId}/context-sources`

| Method | Request                                                                                              | Result                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | Optional query parameters `afterId` and `limit`                                                      | Manager-only metadata in stable ID order.                                              |
| POST   | `{"action":"register","repositoryId":"…","grantId":"…","grantVersion":1,"filePath":"docs/setup.md"}` | Register the source. Repeating the same registration returns the existing source.      |
| POST   | `{"action":"sync","sourceId":"…"}`                                                                   | Sync the source once and return its recorded status. Submit the same command to retry. |
| POST   | `{"action":"remove","sourceId":"…"}`                                                                 | Retire the source and invalidate any outstanding sync.                                 |

Remove a source before registering the same path against a different installation or grant version.

## Sync and retention

Sync leases one source for one attempt. Wallie checks current factory and repository access before fetching and again before saving. A retried request receives a conflict while a lease is active. An expired lease can be reclaimed, and its previous holder can no longer write results.

Wallie fetches at most 128 KiB of UTF-8 text from an exact GitHub default-branch commit. It verifies that the path names a regular file and checks the Git blob digest. A matching content digest reuses the first immutable revision. The source separately records the latest successfully checked commit and its timestamp.

| Status           | Meaning                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| Pending          | The source has yet to complete a sync.                                             |
| Synced           | The latest sync confirmed and saved the file.                                      |
| Stale            | The latest sync failed and the source still has a previously confirmed revision.   |
| Unavailable      | The selected file could not be confirmed and there is no active revision.          |
| Access revoked   | The pinned grant or installation is unavailable, or GitHub rejected its authority. |
| Upstream deleted | The path was absent from a complete Git tree for the checked commit.               |
| Deleted          | A manager removed the registered source.                                           |

Revocation, upstream deletion, and removal clear the active revision pointer. Historical revisions remain private. A successful fetch can reactivate a previously synchronized body when the same registered source is still authorized. Source status records an observed result. A later consumer must recheck its own current access.

The operator API returns source metadata only. Revision bodies are stored as untrusted external text. This import path never sends them to the agent or prompt renderer.
