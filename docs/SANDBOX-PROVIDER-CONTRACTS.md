# Sandbox Provider Contracts

Wallie uses an ephemeral sandbox for every agent job. Production providers are
Vercel Sandbox, E2B, and Daytona. The fake implementation is for tests and local
orchestration proof; it is not a production provider.

This document describes the provider-neutral lifecycle. Provider-specific SDK
behavior belongs behind [`src/lib/sandbox/`](../src/lib/sandbox/).

## Required driver surface

Every production provider implements:

- `create`: allocate, report ownership, prepare the repository, and return a
  command-capable handle.
- `listRunning`: discover live Wallie-owned resources within the provider's
  supported scope.
- `stopById`: idempotently request cleanup of a known resource.
- `validate`: check connection credentials without starting a session job.

The public façade chooses a driver from `SandboxProvider`, validates that the
connection discriminator matches, and redacts secrets from surfaced creation
errors.

## Provider matrix

| Concern          | Vercel                                       | E2B                                  | Daytona                              |
| ---------------- | -------------------------------------------- | ------------------------------------ | ------------------------------------ |
| Connection       | Project ID, team ID, token                   | API key                              | API key, optional API URL and target |
| Repository root  | `/vercel/sandbox`                            | `/home/user/wallie/repo`             | `/home/daytona/wallie/repo`          |
| Base runtime     | Node 22 sandbox                              | Provider base plus common Node setup | `node:22-bookworm` image             |
| Default lifetime | 30 minutes                                   | 30 minutes with kill-on-timeout      | Requested lifetime plus TTL margin   |
| Discovery        | Project-scoped, reconciled with DB ownership | Wallie metadata and workspace scope  | Wallie labels and workspace scope    |
| Stop             | Provider stop                                | Kill sandbox                         | Forced delete and client disposal    |

Daytona custom endpoints must be HTTPS, contain no embedded credentials, query,
or fragment, and exactly match the cloud endpoint or operator allowlist.

## Common creation sequence

After the provider allocates a resource:

1. Invoke `onSandboxCreated` immediately with the provider sandbox ID.
2. Persist the sandbox ID, provider, connection revision, and provider ownership
   fields on the still-active run.
3. If persistence loses a cancellation race, stop the new sandbox immediately.
4. Clone or verify the repository and check out the stage branch.
5. Write GitHub credentials with owner-only permissions and configure the
   Wallie commit identity.
6. Install the selected agent CLI.
7. Install Playwright and Chromium support.
8. Return the handle only after setup succeeds.

If the ownership callback or any later setup step fails, the provider must stop
the sandbox before propagating the error. This closes the gap where a resource
exists but no durable run row can identify it.

## Connections and revisions

- A workspace may retain multiple provider connections but selects one active
  provider.
- Each provider connection has an optimistic connection revision.
- Active-provider settings have their own optimistic revision.
- Secrets are encrypted in provider-specific database rows and decrypted only
  in server code.
- Execution fails closed when the selected provider is disabled, missing,
  disconnected, or does not match the requested implementation.
- Connection mutation is rejected while related jobs, runs, capability checks,
  or device-auth flows are active.
- Saving rotated credentials first cleans up owned sandboxes from the previous
  revision.
- The active connection cannot be disconnected before another provider is
  selected.

Run and capability-check ownership must record both provider and connection
revision. Cleanup must use that pair so credential rotation cannot make an old
resource appear to belong to a new connection.

## Capability and readiness

A repository capability check records:

- Git availability.
- Node and package-manager availability.
- The configured agent CLI.
- Required Codex external-sandbox flags where applicable.
- Playwright and Chromium.
- Screenshot smoke behavior.

A session is ready only when the latest successful check matches workspace,
repository, agent provider/model, sandbox provider, and connection revision, and
all required capabilities passed.

The current readiness function does not apply a wall-clock expiration to a
successful check. "Stale" currently means the configuration identity or
revision no longer matches, not that a fixed number of hours elapsed.

## Command and deadline behavior

- Provider adapters translate `AbortSignal` into their SDK's command
  cancellation mechanism.
- Setup, auth, and capability operations must have a bounded provider timeout or
  an explicit job-lifetime signal.
- Long-running agent execution is bounded by the job/sandbox lifetime and
  remains cancellable.
- Provider SDK calls stay in adapters so generic pipeline code can reason about
  command, timeout, abort, and stop semantics uniformly.

## Cleanup layers

1. Normal processor `finally` stops the sandbox.
2. Setup failure stops the resource before returning an error.
3. User or reconciler cancellation marks jobs/runs terminal, then stops recorded
   sandboxes.
4. The stall detector stops the sandbox for stale activity before retrying or
   terminating the job.
5. The reaper discovers older Wallie-known resources with no active run, job, or
   recent capability check.
6. Workspace deletion stops run, capability-check, and device-auth resources
   before cascading away ownership rows and credentials.
7. Provider TTLs bound resources missed by best-effort cleanup.

Cleanup is best effort. A returned "stopped sandbox ID" may mean the stop was
attempted; provider failure is logged and may require a later reaper pass.
Therefore database ownership rows and connection credentials must remain until
cleanup has had a chance to run.

## Adding a provider

A provider change is incomplete until it covers:

- Provider union and exhaustive driver loading.
- Connection schema, encryption, preview/status model, and mutation lock.
- Active-provider settings and UI.
- Credential validation and optional device-auth lifecycle.
- Sandbox create callback ordering and setup-failure cleanup.
- Repository setup, runtime resources, and default lifetime.
- Abort, timeout, idempotent stop, and paginated discovery behavior.
- Run/check ownership fields including connection revision.
- Capability probe and readiness matching.
- Cancellation, stall, reaper, rotation, disconnect, and workspace deletion.
- Worker deployment inputs and watch paths.
- Secret-redacted errors and realistic positive/failing contract tests.

## Known implementation gaps

- Only the driver loader is centrally exhaustive. Provider switches are
  duplicated across storage, readiness, UI, auth, and cleanup.
- Provider discovery and cleanup result types do not distinguish confirmed stop
  from best-effort attempted stop.
- Successful capability checks have no wall-clock freshness policy.
- Railway worker watch patterns do not include every transitive
  sandbox-connection, sandbox-capability, and teardown owner.

These gaps motivate a future canonical provider registry. Until it exists, use
the checklist above as the review contract and do not infer completeness from a
new driver compiling.

## Proof

- Driver contract tests with deliberately failing implementations.
- Setup-failure and ownership-callback cleanup tests.
- Abort and idempotent-stop tests.
- Capability/readiness tests across provider, model, repository, and revision.
- Cancellation and attach-after-cancel race tests.
- Reaper tests for young, known-active, unknown, terminal, and rotated
  resources.
- A real capability check for every production provider whose support is
  claimed.
