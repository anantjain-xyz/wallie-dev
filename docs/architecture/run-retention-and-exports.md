# Run retention and exports

Workspace owners and admins manage run retention and request exports under
**Settings → Advanced → Run history**.

| Data                                                                                                 | Retention rule                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exact-attempt ordered events                                                                         | A finite setting expires terminal transcripts by run age. Blank keeps transcripts indefinitely.                                                              |
| Validation evidence files                                                                            | A finite setting expires eligible files by run and receipt age. Required evidence remains available for unarchived sessions. Blank keeps files indefinitely. |
| Run identity, usage, worker diagnostics, stage Markdown, checkpoint lineage, and validation receipts | Wallie preserves these records until workspace deletion.                                                                                                     |
| Export copies                                                                                        | Completed exports expire at seven days or the earliest source retention deadline, whichever comes first.                                                     |

Limits accept whole days from 1 to 3650 and apply to existing content. Workers
mark expired transcripts and evidence before purging their data. Catalog entries
continue to explain why content is unavailable.

The ordered-events migration removes the superseded transcript copies and
expires exports that included them. It keeps explicit worker diagnostics and
any recorded ordered events.

## Export contract

A worker freezes a workspace catalog snapshot on the first claim. A lease and
durable ordinal let another worker resume from the last committed page after a
restart. Each page commits only after its private objects are stored with their
SHA-256 digests. Completion requires contiguous coverage of the entire snapshot.

1. Download the JSON manifest from the export row. It contains the snapshot
   timestamp, record count, and ordered page URLs with SHA-256 digests and sizes.
2. Fetch the page URLs on the same Wallie origin with an active workspace admin
   session. Each page lists typed records with ordinals and availability.
3. Fetch any available asset using its link in the page. Verify page and asset
   bytes against the supplied SHA-256 digests when archiving them offline. A
   record marked `payloadEncoding: "base64"` contains UTF-8 text encoded as base64.

Records identify capture gaps, expired or redacted content, missing files, and
metadata-only checkpoints. The manifest covers ordered activity, worker diagnostics, and catalog entries,
including Markdown without an exact checkpoint link. A complete
export can contain unavailable records. It means every record in scope is
accounted for.

Wallie checks the live Auth session, workspace role, and export status on each download. The Storage bucket
is private. Export object URLs point to Wallie, which checks the digest before
serving a file. Workspace deletion fences new work, then uses the existing
cancellation and cleanup flow to remove catalog rows and private files.

## Worker operation

Deploy the migrations before the application and workers. The Node worker and
the native Cloudflare worker process exports and retention outside the browser.
A transient Storage error leaves the durable cursor or cleanup claim available
for retry. An export that cannot finish within 24 hours becomes failed.
