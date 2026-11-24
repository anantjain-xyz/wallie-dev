# Factory automation qualification

Run the runtime replay and the isolated delivery proof before qualifying an automation release. The replay checks persisted receipts against the real Node daemon and Workerd maintenance. The delivery proof checks the provider run, authenticated deployment, and signed monitoring follow-up.

## Runtime replay

Use a dedicated local Supabase project with the current migrations. Reset only that disposable project. Run from a worktree with no application credentials or other workers attached to it.

```bash
supabase db reset --local --no-seed --workdir /path/to/runtime-fixture
pnpm check:factory-runtime --workdir /path/to/runtime-fixture --m12
```

The replay builds the production app, sends signed GitHub events to its loopback route, and runs the production Linear client against a loopback GraphQL fixture. Leave the database available until both workers finish. The Node daemon uses its normal maintenance interval, and an abandoned delivery lease expires on its original clock.

| Witness                   | Required evidence                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schedule and event intake | One receipt and root job for each admitted schedule tick, GitHub change, and Linear span. The original and replayed GitHub deliveries share the same logical event.       |
| Pause and revoked grant   | A paused receipt remains pending. An event received after authority is revoked has a terminal denial and no session.                                                      |
| Worker restart            | Existing occurrence, job, source, and approval identities survive the restart. The expired delivery lease becomes unknown. A second claim and a stale response both fail. |
| Deployment outcome        | An unknown delivery and an authenticated failed deployment both fail the success assertion.                                                                               |

## Isolated Actions and monitoring

Use a second disposable local project and keep other workers disconnected. Reset it with `--no-seed` and run `pnpm build` with its loopback `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. The qualification script starts the compiled app with local credentials. Pass `--app-dir` if that build is in a separate checkout.

The live command normally requires a GitHub immutable release. For the existing smoke repository, create a new `wallie-m12-fixture-*` tag in `anantjain-xyz/wallie-dev` at the reviewed fixture commit `097db97c1ddf078c682695be43875b979cbc8a39`. Set `fixture_tag` to that tag, keep the ref fixed while qualification runs, and preserve the tag and run as evidence. [GitHub immutable releases](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/using-immutable-releases-and-tags-to-manage-your-actions-releases)

```bash
node --import ./scripts/register-server-only.mjs --import tsx \
  test/release/factory-automation-live.ts \
  --workdir /path/to/delivery-fixture --tag "$fixture_tag" --effectless-smoke-tag
```

The effectless smoke option supplies fixture credentials and simulated immutable-release metadata for the reviewed commit and workflow. It rereads the exact ref immediately before dispatch. The provider run must match the command, commit, and workflow before the separate authenticated M06 observation can establish success. The signed Sentry-compatible event and its replays must produce one incident with the original approval and deployment identities.

If the process is forcibly stopped, reset the disposable database before replaying with a fresh smoke tag.

## Safely disable a rule

1. In **Configure → Automations**, select the exact factory and rule. Pause it and verify **Paused** on the rule and the pending reason in occurrence history. Sessions that already started can be managed from their own session pages.
2. If the credential or grant is compromised, identify its other consumers and revoke it in **Governance**. To stop new monitoring work, disable the exact monitoring binding. The queue checks current authority before admission.
3. Cancel a queued delivery from its command. For a dispatch already accepted or unknown, inspect the original run and provider evidence for its command, exact SHA, and environment. Let the authenticated M06 reporter reconcile the outcome. An unknown command is ineligible for redispatch.
4. For a routine pause, resume the same published revision when it is ready. After replacing authority, dry-run a fresh draft against the active grant and publish the reviewed revision. Verify the next expected occurrence and its session. History retains the earlier decision.

[Automation definitions and controls](../architecture/factory-automation-definitions.md) · [Guarded Actions recovery](../architecture/factory-actions-delivery.md) · [Monitoring bindings](../architecture/factory-monitoring-incidents.md)
