# Factory definition records

Each workspace gets one default factory during workspace creation. The migration provisions a default factory for each existing workspace. A default factory can exist before any definition is active.

Factories now carry a workspace-unique name/slug, explicit membership and an archived lifecycle. Existing sessions, pipelines and repositories are backfilled into the default factory; see [Factory scope and membership](factory-scope-and-membership.md) for access resolution, lifecycle and audited commands.

| Record     | What it records                                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Factory    | Stable factory UUID and workspace ownership.                                                                                                                               |
| Draft      | One saved definition with an author UUID, creation time, and optional base activation number.                                                                              |
| Revision   | Published definition, author UUID, creation time, and optional source draft.                                                                                               |
| Activation | Selected revision, author UUID, and creation time. Activation numbers start at 1 and increase by 1 within each factory. The highest number identifies the active revision. |

Drafts and revisions each store a schema version and a lowercase SHA-256 digest of the exact UTF-8 bytes in `definition_json`. Database checks bind the digest to those bytes. Workspace and factory keys keep draft, revision, and activation references inside the owning factory. See the [serial factory definition compiler](serial-factory-compiler.md) for canonical serialization.

Activation history is append-only. An activation at number `N + 1` expects `N` as the current activation. A rollback records a new activation that points to a previous revision, so every activation remains distinct even when it reuses a revision.

Active workspace members can read factories, revisions, and activations through row-level security. Drafts are visible to workspace managers. Drafts, revisions, and activations remain immutable while the owning workspace exists.

## Existing session history

Sessions created before enrollment or without an active definition report `legacy` and have a null factory definition revision. [Session admission](factory-session-inputs.md) marks a session `pinned` when it captures an active revision in the session's workspace. The database preserves that provenance for the life of the session.

`execute_pinned_definition` distinguishes sessions admitted with compiled execution from older sessions that recorded the active revision for provenance. Both fields remain immutable for the session's lifetime.

A legacy session retains its existing session ID, workspace number, pipeline, stage links, artifacts, and run history. Its legacy marker records that the session predates definition enrollment. The current factory definition supplies no evidence about the configuration that produced that history.

See [Factory definition activation](factory-definition-activation.md) for draft, publish, and rollback commands.
