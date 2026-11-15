# Factory definition records

Each workspace gets one default factory during workspace creation. The migration provisions a default factory for each existing workspace. A default factory can exist before any definition is active.

| Record     | What it records                                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Factory    | Stable factory UUID and workspace ownership.                                                                                                                               |
| Draft      | One saved definition with an author UUID, creation time, and optional base activation number.                                                                              |
| Revision   | Published definition, author UUID, creation time, and optional source draft.                                                                                               |
| Activation | Selected revision, author UUID, and creation time. Activation numbers start at 1 and increase by 1 within each factory. The highest number identifies the active revision. |

Drafts and revisions each store a schema version and a lowercase SHA-256 digest of the exact UTF-8 bytes in `definition_json`. Database checks bind the digest to those bytes. The definition compiler establishes the canonical serialization. Workspace and factory keys keep draft, revision, and activation references inside the owning factory.

Activation history is append-only. An activation at number `N + 1` expects `N` as the current activation. A rollback records a new activation that points to a previous revision, so every activation remains distinct even when it reuses a revision.

Active workspace members can read factories, revisions, and activations through row-level security. Drafts are visible to workspace managers. Drafts, revisions, and activations remain immutable while the owning workspace exists.

## Existing session history

The migration adds factory definition provenance to sessions without rewriting their rows. Pre-enrollment sessions report `legacy` and have a null factory definition revision. Current creation paths also use `legacy` until admission supplies an exact revision. A session marked `pinned` must reference a revision in its workspace. The database preserves that provenance for the life of the session.

A legacy session retains its existing session ID, workspace number, pipeline, stage links, artifacts, and run history. Its legacy marker records that the session predates definition enrollment. The current factory definition supplies no evidence about the configuration that produced that history.
