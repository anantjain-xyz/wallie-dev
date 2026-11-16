# Factory candidate smoke tests

A smoke test exercises a saved factory draft or a previously active revision. Its receipt identifies the exact definition digest, target record, activation base, test policy, workspace, and sandbox connection revision.

## Run a test

Workspace owners and admins can use `/api/workspaces/[workspaceId]/factory-definition/candidate-tests`.

| Operation | Request                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Start     | `POST` with `target: {kind, id}`, `expectedActivationNumber`, and `expectedDigest`. The target kind is `draft` or `revision`. |
| Read      | `GET` with `targetKind`, `targetId`, and `digest`.                                                                            |
| Cancel    | `DELETE /[testId]?digest=<sha256>` while the exact request is running.                                                        |

The shared compiler checks the saved definition. Postgres verifies the caller, eligible approvers, repository, credential, and current capability receipt before the background execution starts. Private stage and policy reservations can pass preflight from the draft. Their backing records are created only by a successful publish transaction.

The runner renders each candidate stage with synthetic session and predecessor inputs. A bare utility sandbox runs Wallie’s fixed handoff protocol for every stage and retains counts and a bounded sample of stage IDs and prompt digests. Candidate text stays on the host. The utility receives no repository checkout, agent credentials, or connector credentials. This test purpose has no pipeline job, PR publication, messaging, or deployment path.

The receipt shows whether authorization blocked the test, the fixture passed or failed, the runtime was unsupported, or the request was canceled. A request owns a five-minute lease. A canceled or expired request cannot be completed by a late result.

## Activate a definition

Publish and rollback require the latest passing receipt for the exact target, digest, activation base, current sandbox connection, and policy version. The receipt expires after 24 hours. The activation transaction also rechecks the caller’s authority and that the test requester is still a workspace manager.

Edit the draft or rotate the sandbox connection and run a new test. A failed, fake, canceled, stale, or differently bound receipt cannot authorize activation. Activation changes the definition used by new sessions. Sessions that have already started retain their admission revision.

## Qualify the runtime

Run the same fixture with the fake adapter and the Node 22 utility image.

```bash
node --conditions=react-server --import tsx scripts/smoke-factory-candidate.ts fake
docker pull node:22-bookworm
node --conditions=react-server --import tsx scripts/smoke-factory-candidate.ts docker
```

The Docker fixture uses a disposable container with networking disabled and the base filesystem read-only. To exercise the Vercel Sandbox adapter, set `WALLIE_CANDIDATE_SMOKE_VERCEL_TOKEN`, `WALLIE_CANDIDATE_SMOKE_VERCEL_TEAM_ID`, and `WALLIE_CANDIDATE_SMOKE_VERCEL_PROJECT_ID` for a dedicated test project and run the script with `vercel`. Workspace activation receipts are created by the API. The standalone fixture reports runtime qualification.
