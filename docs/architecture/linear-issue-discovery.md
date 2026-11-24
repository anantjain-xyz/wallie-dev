# Linear issue discovery

Enable discovery on a mapped Linear team or project. The factory's published
definition supplies the named agent, writer repository, execution grant, and
budget payer. A discovery configuration pins that definition until an operator
confirms a replacement.

| Setting       | Effect                                                                             |
| ------------- | ---------------------------------------------------------------------------------- |
| Resource      | The exact Linear team or project in the verified organization                      |
| States        | One to twenty Linear workflow state IDs                                            |
| Label         | An optional issue-label ID                                                         |
| Service actor | An optional verified Linear actor link to the factory's approved service principal |

For human attribution, the issue creator needs a verified link and current
access to the mapped factory. For service attribution, the authenticated
Linear viewer must match the configured identity. The execution grant supplies
the payer in both cases. An explicitly configured project takes precedence over
team discovery of the same issue. Disabling the project stops discovery there.

The worker fetches at most one 20-issue page per due resource during a sweep,
using Linear's issue filters and Relay cursor. Each page and its cursor advance
commit together under the current installation, mapping and configuration
revisions. A workspace/tenant/issue UUID receipt deduplicates replays and moves
between resources and retains the normalized issue-state event. Linear's
previous issue identifiers also protect legacy links after a team move. Session
origin links retain the human-readable issue identifier and URL. The
conversation source uses the mapped resource UUID as its namespace and the
canonical issue UUID as its thread ID.

A provider rate limit defers polling for every mapping that uses the same
workspace credential and material revision. The next worker sweep respects the
recorded deadline. Newly verified credential material can poll immediately.

Discovery uses its own cursor. The linked-session reconciler still records the
first coherent state span as a baseline and applies later transitions through
its existing receipts. [Linear filtering](https://linear.app/developers/filtering),
[Linear pagination](https://linear.app/developers/pagination).

## Configuration

Use `GET` and `PUT` on
`/api/workspaces/{workspaceId}/factories/{factoryId}/linear-discovery/{resourceId}`.
A workspace owner or admin can save `enabled`, `expectedRevision`, the current
`mappingRevision`, `stateIds`, and optional `labelId` and `serviceActorId`.
Enabling or changing a configuration restarts discovery from the first page.

## Qualification

1. In a disposable Wallie project, save the approved test organization's Linear
   key. Verify that organization and the exact test resource, then configure the
   installation and publish the resource mapping.
2. Verify and link the selected existing test issue's creator. For service
   attribution, use an approved service identity whose ID matches Linear's
   authenticated viewer.
3. Enable discovery for the issue's state and a label unique to that test
   fixture. Use the existing service-backed factory definition.
4. Run one scoped sweep with the disposable project's app environment. The
   sweep records the qualifying session and its first queued job.

```bash
node --env-file=.env.local --import ./scripts/register-server-only.mjs --import tsx --input-type=module - <<'JS'
import { createRequire } from 'node:module';
const load = createRequire(import.meta.url);
const { createSupabaseAdminClient } = load('./src/lib/supabase/admin.ts');
const { reconcileLinearIssueDiscovery } = load('./src/lib/connectors/linear-discovery.ts');

const database = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://invalid');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)) {
  throw new Error('Use a disposable local Supabase project.');
}
const workspaceId = process.env.OP672_WORKSPACE_ID;
if (!workspaceId) throw new Error('Set OP672_WORKSPACE_ID to the disposable workspace.');
console.log(await reconcileLinearIssueDiscovery(createSupabaseAdminClient(), { workspaceId }));
JS
```

5. Open the session in Wallie and verify its Linear origin link. After the next
   polling interval, run the same command again and verify that the session and
   its first queued job are unchanged.
