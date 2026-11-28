# Factory scope and membership

Workspace remains the tenant boundary. A factory is a named child of exactly one
workspace that owns a scoped set of sessions, pipelines and GitHub repositories.
The M02 default factory is the compatibility anchor: the migration backfills
every existing workspace resource into the workspace default factory without
rewriting the resource ID, workspace number, pipeline pin, artifact history or
URL.

| Record              | What it records                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Factory             | Stable UUID, workspace ownership, name, workspace-unique slug, `active`/`archived` status and archive attribution. `is_default` marks the migration target.                                                                                                                  |
| Factory membership  | A workspace member's `manager` or `member` grant for one factory, with grant attribution, revocation attribution and append-only history. Active grants are unique per factory/member.                                                                                       |
| Factory audit event | Immutable `factory.created`, `factory.renamed`, `factory.slug_changed`, `factory.archived`, `factory.restored`, `membership.granted`, `membership.revoked`, `membership.suspended` and `membership.reinstated` events. Actor and subject attribution survive member removal. |
| Scoped resource     | `sessions.factory_id`, `pipelines.factory_id` and `github_repositories.factory_id`. A resource stays in its factory for its full lifetime.                                                                                                                                   |

## Access resolution

`internal.can_access_factory(workspace_id, factory_id)` is true for an active
workspace owner/admin or an active factory member. `internal.can_manage_factory`
is true for the same workspace managers and for factory `manager` grants. Both
helpers also require the workspace deletion fence to be clear. Ordinary members
only see their granted factories; workspace managers remain operators over every
factory in their workspace.

Row-level security uses the same helpers for factory lists, definition history,
sessions, pipelines, repositories, pipeline stages, run and artifact evidence,
review threads, git/PR/validation lineage and validation storage objects.
Child rows inherit the session's factory fence through
`internal.can_access_session(session_id)`. Repository profiles, onboarding
status, and repository capability checks inherit access from their repository.

New workspace members inherit a `member` grant in the default factory. Owners
and admins get operator access from their current workspace role. Demotion
removes that access while preserving explicit factory grants. Deactivation
removes factory access and records `membership.suspended`. Reactivation records
`membership.reinstated`.

## Lifecycle and admission

Creating a factory requires a workspace owner/admin. The creator becomes its
first manager. Archive and restore are audited operator actions available to a
workspace manager or a factory manager. An archived factory

- rejects new session admission with `P0011` while keeping the factory, its
  pinned sessions, artifacts and audit history readable by authorized people
- rejects new pipeline and repository creation while GitHub sync continues to
  refresh existing repositories and remove disconnected ones
- cannot receive new membership grants until restored.

Existing sessions do not need to be rewritten or moved when a factory is
archived. Restoring the factory reopens admission without changing any pinned
session identity. When workspace member removal would leave a factory without
an explicit manager, the factory promotes an eligible member when one exists.
Workspace operators can still manage factories with no explicit manager.

Factory definitions can only reference pipelines and repositories in the same
factory. Session repository lookup and Git pinning also enforce this scope.

## Sessions and Runs

With no `factory` in the URL, the Sessions Board and List and the Runs list use
the authorized default factory when available. A factory ID scopes rows and
counts to that factory.
`factory=all` reads across the viewer's authorized factories. An unavailable
scope displays an empty state with the factory selector so the viewer can
choose their next scope. Switching factories resets stage and pagination
filters. Session and run detail links keep their existing IDs and URLs.

Sessions is where people move and review work. Runs opens directly from the
workspace navigation and lists execution attempts and their outcomes. Opening
an attempt locks the scope to its factory. The inspector's Back link restores
the list's factory, filters, and page when opened from Runs.

## Commands

| Command                                                                | Purpose                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `read_factory_scope(workspace, actor)`                                 | Accessible factory rows plus session/pipeline/repository/member counts and effective role. |
| `create_factory(workspace, actor, name, slug)`                         | Create a non-default factory and grant the creator manager access.                         |
| `archive_factory(workspace, factory, actor, reason)`                   | Stop new admission and record the archive event.                                           |
| `restore_factory(workspace, factory, actor)`                           | Reopen an archived factory and record the restore event.                                   |
| `grant_factory_membership(workspace, factory, actor, member, role)`    | Grant or update an active membership and record the event.                                 |
| `revoke_factory_membership(workspace, factory, actor, member, reason)` | Revoke membership immediately and record the event.                                        |

The browser edge exposes these through
`/api/workspaces/[workspaceId]/factories` and its `[factoryId]` lifecycle,
membership and audit routes. Routes call the service-role command RPCs only after
`requireWorkspaceAccessById`; the database independently checks the same actor
and factory-manager authority.

In Workspace Settings, managers can update an active factory's display name
(`rename_factory`) and slug (`set_factory_slug`) independently, including for
the workspace default. Each command checks the displayed value and authorizes
against the current workspace role or factory grant under lock.

The directory and the browser factory-list API show the current slug as
metadata. App links, versioned API paths, connectors, grants and stored
definitions use stable factory IDs, not slugs. The legacy default is resolved by
`is_default`; `default` remains reserved to the original factory even if it
chooses a different slug. Every former slug stays reserved to its original ID
for the workspace's lifetime. That factory can reclaim it, but creation or an
edit can never attach it to another factory in the workspace. Reservations do
not add a slug lookup or change access.

Archive goes through `archive_additional_factory`, which preserves the
workspace default and calls the existing archive command for every other
factory. Archived factories keep their history and grants; restore before
editing them in Settings. Factory grants never change workspace roles or access
to other factories.

See [Factory definition records](factory-definition-records.md) for definition
draft, revision and activation history.
