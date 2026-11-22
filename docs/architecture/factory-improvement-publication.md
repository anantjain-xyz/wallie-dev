# Publish a benchmarked factory improvement

A factory manager binds a connected GitHub repository and a dedicated definition base branch. The base must already contain the active canonical definition at `.wallie/factory-definitions/{factoryId}.json`. The publisher checks the exact file digest before freezing the remote commit and tree.

| Operation                                                                | Factory API                                                                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Configure the repository and branch with `repositoryId` and `baseBranch` | `POST /api/workspaces/{workspaceId}/factories/{factoryId}/improvement-publication-target`                                        |
| Publish or retry the exact qualified revision with an empty body         | `POST /api/workspaces/{workspaceId}/factories/{factoryId}/improvement-proposals/{proposalId}/revisions/{revisionId}/publication` |
| Read the recorded publication                                            | `GET` on the same revision-specific route                                                                                        |

- Publication binds the latest qualified proposal, its active base, both frozen comparisons, and the configured repository. The PR body records those identities and the rollout expectation.
- A leased publisher pins one commit whose parent is the frozen base and whose tree replaces only the definition file. The publisher creates its revision-specific head with create-only semantics.
- If GitHub's create response is uncertain, retry the same revision. The publisher searches all PR states and verifies repository, refs, commits, and candidate bytes before attaching a PR. A pending response preserves the outstanding request.
- GitHub review and merge are separate from activation. Wallie records the published identity for a later explicit adoption decision.

The scoped smoke uses the existing `anantjain-xyz/wallie-dev` repository, a unique test base, and synthetic definitions. It drops the successful create response, checks that a retry attaches the same PR, and verifies the exact file diff and untouched default ref.
