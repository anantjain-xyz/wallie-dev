# Validation evidence

## Retention and erasure

- Validation evidence retention covers privately stored command evidence, PNGs, and WebM. The worker protects required evidence in unarchived sessions and records an unavailable state before removing eligible bytes.
- Browser downloads go through Wallie's authenticated evidence routes. The routes check the exact viewer, run, asset, and live retention state after verifying the private bytes. A withheld clip or image keeps its immutable capture receipt and digest.
- A factory manager can erase retained content for the displayed archived session. Erasure withdraws exact evidence, removes retained transcripts and source-owned memory bodies, and revokes affected exports. The archive is permanent and retains provenance.
- Cleanup claims have bounded leases. A failed Storage removal or acknowledgement can retry the same path. Successful cleanup records the completion against that claim even when an earlier worker already removed the object.

Wallie records command execution independently of the agent's final markdown.
An agent saying that tests passed is a claim for a reviewer to read; it never
becomes observed execution evidence. The harness owns the command identity,
process exit status, execution timestamps, commit and validation tree, and the
private report manifest. PR readiness is evaluated separately in OP-508.

## Run validation plans

Validation plans belong to individual runs and stay out of Git. Before starting
the agent, Wallie creates `/tmp/wallie-validation-plan-<run-id>.json` with an empty
plan and includes its exact path in the prompt. The agent writes the commands
for that attempt there. Version 1 uses this shape:

```json
{
  "version": 1,
  "commands": [
    {
      "key": "unit-tests",
      "command": "pnpm test --reporter=json --outputFile=\"$WALLIE_EVIDENCE_DIR/tests.json\"",
      "timeoutSeconds": 300,
      "reports": [
        {
          "key": "unit-test-report",
          "path": "tests.json",
          "required": true,
          "kind": "report"
        }
      ]
    }
  ]
}
```

Each command and report has an explicit key. `timeoutSeconds` is between 1 and 300.
Configuration permits at most 20 commands, 10 reports per command, and 100 asset
identities across command logs and reports. A report path is relative to the fresh private directory provided for that
command through `WALLIE_EVIDENCE_DIR`; write outputs there rather than into the
source checkout. A previous command's files cannot satisfy a later command's
report. Reports declare their purpose (`report`, `screenshot`, or `preview`) and
whether they are required. Required evidence names in delivery policies identify
the recorded evidence; configuration alone does not establish success.

After the agent finishes, Wallie validates the plan and saves an immutable
`session_validation_plans` row before executing any command. The row is scoped
to the workspace, session, job and exact run attempt, with the captured commit
SHA and validation tree. Only the current worker can pin it; an identical retry
returns the original row, while a changed plan or checkpoint is rejected.
Execution uses the saved plan. Known credentials in a plan are rejected before
persistence; reference credentials through the command environment.

| Data                             | Location                                                         |
| -------------------------------- | ---------------------------------------------------------------- |
| Shared validation commands       | Repository scripts such as `pnpm check`                          |
| Commands selected for an attempt | Immutable plan on that run                                       |
| Observed execution and reports   | Private evidence on that run, bound to its exact commit and tree |

Parallel sessions and rejected-stage retries receive separate plan files and
rows. They never inherit a previous run's plan. Commands execute repository code with the sandbox's normal
capabilities. They should be noninteractive validation commands that leave the
source checkout unchanged. An observed zero exit status establishes execution
of that command; it does not prove that the repository's tests are exhaustive.

Git content transformations are currently unsupported for checkpoint capture and
validation. Declared `filter`, `text` (including the common `* text=auto` rule),
`eol`, `ident`, `working-tree-encoding`, and legacy `crlf` attributes cause capture
to fail closed, including explicit negative declarations such as `-text` and
`-filter`. Git's attribute-query output cannot distinguish every negative state
from a literal filter name, so this version rejects those declarations too.
Wallie checks both committed/index and working attributes, including
`.git/info/attributes` and global attribute files, without invoking filter
commands. Automatic CRLF conversion is disabled for capture. This conservative
restriction keeps the bytes actually executed distinguishable from Git's
normalized or filtered representation. A blocked source capture retains the
sandbox for recovery rather than publishing a checkpoint that omits those bytes.

## Browser verification plans

Version 2 adds a `browser` array to the same frozen run plan. Command
validation is unchanged. A browser check requests a bounded interaction
and private evidence from a particular preview path:

```json
{
  "version": 2,
  "commands": [],
  "browser": [
    {
      "key": "inbox",
      "path": "/fixtures/inbox",
      "timeoutSeconds": 15,
      "interactions": [
        { "action": "expectVisible", "testId": "inbox-demo" },
        { "action": "click", "testId": "inbox-filter" }
      ],
      "regionTestId": "inbox-demo",
      "excludedTestIds": ["account-menu"],
      "evidence": [
        { "kind": "screenshot", "required": true },
        { "kind": "video", "required": false }
      ]
    }
  ]
}
```

The plan may contain up to five checks. Each check allows up to 30 seconds,
12 interactions, 12 additional exclusions, and one request per media kind.
The trusted runtime resolves the target for the run's app preview. An intent
cannot supply an origin, external navigation, script, form value, output path,
or saved browser profile. Use a delivery policy evidence key such as
`browser:screenshot:inbox` to require that exact visual check for PR readiness.
A missing, stale, unavailable, or failed required visual check blocks delivery.
Unrequested or optional captures do not affect an otherwise passing
requirement. A text report or command receipt cannot satisfy a visual key.

### Isolation and capture policy

The `isolated-fixture-v1` policy admits only a Wallie-controlled capture adapter
for the current run's verified fixture preview. The adapter must establish its
own tool approval and capture readiness. An agent-installed browser or a
provider smoke check alone cannot establish this.

- Create a fresh browser session and context with no inherited credentials,
  profile, storage state, cookies, or prior origin data. Restrict navigation
  and requests to the isolated preview. Keep the repository's agent process
  and output files outside the capture trust boundary.
- Capture only the single approved region on a synthetic fixture page. Deny
  credential-bearing, private, excluded, or unverified regions by default.
  A plan can impose additional exclusions but cannot weaken the policy.
- Apply the policy before capturing any pixels and for every retained video
  frame. Withhold the capture if the region or its rendered contents cannot be
  established, including obscured content and overlapping exclusions. Sanitize
  image or video metadata before computing a digest or retaining the media.
- Record only bounded, fixed failure outcomes. Never persist provider
  exception text, URLs with credentials, browser profiles, opaque agent
  attachments, or full unreviewed frames as trusted receipts.

The worker records visual outcomes separately from command evidence. Each
receipt inherits its immutable workspace, session, run, job attempt, repository,
commit, and validation tree from the frozen plan. The receipt also records the
planned check, path, evidence kind, and capture policy. A successful capture
contract requires an isolated browser session identity and a private asset
manifest with verified content type, byte size, and SHA-256. A verified
private read must match that digest before a visual requirement can pass.

### Trusted screenshot execution

The Node worker can capture screenshots after it saves command evidence and
verifies the checkout still matches the frozen plan. Install the pinned browser
with `pnpm exec playwright-core install --with-deps chromium` on a Node worker
that supports Chromium’s kernel sandbox. Set these deployment values together.

| Setting                                 | Purpose                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `WALLIE_BROWSER_FIXTURE_BROKER_URL`     | The trusted HTTPS endpoint that supplies exact synthetic fixtures.                                 |
| `WALLIE_BROWSER_FIXTURE_BROKER_TOKEN`   | A deployment credential for the broker request only.                                               |
| `WALLIE_BROWSER_FIXTURE_ORIGIN`         | The one HTTPS origin from which the worker can fetch the broker’s preview document.                |
| `WALLIE_BROWSER_FIXTURE_APPROVAL_SCOPE` | The exact `<tool revision UUID>/<operation>` approved in the factory and its live execution grant. |

The broker response echoes the request nonce, run, attempt, commit, tree,
requested path, target region, and capture policy. It includes a short-lived
preview URL and the exact HTML digest. The worker downloads bounded, verified
HTML and renders it from an isolated document URL in a new browser session.
Use self-contained synthetic fixture pages. Chromium runs with no inherited
cookies or credentials. Network requests, downloads, and unverified navigation
stay blocked. After the planned interactions, Wallie disables fixture scripts,
checks the visible region and exclusions, and captures the cropped pixels.

Wallie validates and re-encodes the PNG, strips metadata, and limits the
image to 960 × 540 pixels and 1 MiB. The private object starts with a cleanup
reservation. The database records its manifest only after checking the exact
run, policy, live approval, and upload reservation in one transaction.
Unsettled uploads stay eligible for cleanup.

Failed checks and uploads produce a nonpassing outcome. Missing runtime or
approval is shown as unavailable. The native Workerd worker records browser
unavailability while continuing command validation.

`GET /api/sessions/{sessionId}/validation-evidence` lists bounded visual outcomes
and exact run provenance. A captured screenshot has an authenticated download
link at
`/api/sessions/{sessionId}/validation-evidence/browser-assets/{assetId}`.
The link works after teardown. Each request uses the signed-in viewer’s access
and verifies the private object size and SHA-256 before returning the PNG.

### Trusted video recordings

A video request captures the initial approved region and one frame after
each planned interaction in the same fresh browser context. Wallie freezes
fixture scripts, applies private-region exclusions, and crops the result
before retaining a frame. The worker restores the page between frames so
the next approved interaction runs in the same workflow. A missing step,
unsafe frame, changed region size, or cancellation discards the entire clip.

The Node worker sends sanitized crops to its configured FFmpeg executable.
The clip uses VP8 WebM at two frames per second. Each frame holds for 500 ms,
so offsets are exact media timestamps from the initial frame at zero through
the last planned step. The manifest includes validated encoded dimensions,
duration, offsets, and the observed start and finish time. A recording can
contain up to 13 frames and 8 MiB. It stays within the check's time budget.
FFprobe verifies the complete decoded frame sequence before the worker can
publish the private object.

Video requires a separate live `<tool revision UUID>/record_video` approval.
The worker rechecks approval at settlement. A mixed plan can settle verified
screenshots and recordings in the same exact run receipt. Unavailable
recordings and upload failures remain nonpassing. The browser evidence
metadata identifies the retained WebM by its asset ID. Authorized reviewers
can download the verified bytes after teardown through
`GET /api/sessions/{sessionId}/validation-evidence/browser-videos/{assetId}`.

## Commit and tree identity

After a successful agent completion, Wallie captures the intended code checkpoint
and runs configured validation through its sandbox execution API. It records the
actual exit status and checks the Git commit, tree, and checkout cleanliness
before and after execution. A failed command, changed commit/tree, dirty checkout,
missing required report, transport error, or timeout cannot produce passing
evidence. A tool-use event, hand-written report, or markdown assertion cannot
substitute for the harness execution receipt.

Wallie captures source again after validation so that edits made by validation
are retained rather than discarded. Evidence remains bound to the code it
observed: a later edit or checkpoint cannot reuse an earlier success merely
because its command key matches. Consumers must compare both the intended
checkpoint SHA and validation tree before accepting evidence. Failed and stale
records remain available to explain what happened.

Analysis-only delivery skips command execution. Wallie does not invent a test
run for a prose-only artifact. A missing, invalid, or unsaved plan never becomes
a passing receipt for a policy requirement. Plan or evidence failures still
preserve the source checkpoint for review and recovery.

### Migration from the committed manifest

- Apply the run-plan database migration before deploying the updated worker.
- `.wallie/validation-evidence.json` is obsolete. The worker never reads it, even
  if it is still tracked. Remove any previously tracked copy once and keep
  `.wallie/` ignored; agents must not update it for individual sessions.
- Existing evidence remains readable. Workers already running during deployment
  can still finish their receipts. New workers require a saved run plan before
  execution; receipts for a run with a plan must match its commands and reports.
- Required evidence names and exact-commit readiness checks are unchanged.

## Private, bounded assets

Logs and reports leave the ephemeral sandbox before teardown. They are stored
as private, workspace-scoped objects with immutable metadata and a digest of
the persisted, redacted bytes. Logs are limited to 64 KiB, reports to 1 MiB each,
and total captured assets to 4 MiB. Path containment, regular-file checks, and
UTF-8 text validation prevent reports from following a symlink outside their
fresh output directory or uploading arbitrary binary data.

Known runtime secrets, including the GitHub installation token and refreshed
agent credentials, are removed before persistence, including their JSON and
URL-encoded forms. Do not put credentials into report names or source files.
The collector reports sanitized failures rather than retaining raw provider
exceptions. Redaction protects known runtime material; it is not a claim that
arbitrary content is free of every possible secret.

Only the trusted browser path can produce screenshot evidence. Command uploads
are bounded text reports. A command-authored screenshot remains unavailable.
An unavailable required asset blocks its evidence.

Active workspace members can read metadata through
`GET /api/sessions/{sessionId}/validation-evidence` and download an asset through
`GET /api/sessions/{sessionId}/validation-evidence/assets/{assetId}`. The download
route verifies current membership, session ownership, and stored content
integrity. Durable identities are asset IDs and storage paths, not expiring
signed URLs. Objects remain accessible after sandbox teardown and follow the
workspace deletion lifecycle. An inaccessible required asset cannot satisfy a
delivery requirement.

The Review Workbench and Run Inspector share a **Browser screenshots**
disclosure. It loads metadata for the exact artifact's producing run or the
displayed run. **View screenshot** fetches the verified private PNG on demand.
The commit, tree, attempt, check, timestamp and digest remain visible when a
recorded image becomes unavailable. A screenshot link points to that receipt
on the same artifact or run, and opening it never fetches the PNG automatically.

The **Browser recordings** disclosure loads the exact run receipt.
**Load recording** and
recorded-step links fetch the verified WebM through the authorized same-origin
route. A step link pins the artifact version or run, recording asset and exact
recorded offset. It opens the player paused at that frame. The initial frame is
at zero and subsequent offsets correspond to the frozen plan interactions.

The player keeps the WebM in a revocable browser object URL and releases it
when closed or when the inspector changes. Missing or inaccessible bytes leave
the capture provenance visible. An incomplete capture has no playable clip.

## Artifact evidence links

Final Markdown can reference retained reports with an evidence identity:

```markdown
[Unit test report](wallie-evidence:unit-tests/unit-test-report)
[Command log](wallie-evidence:unit-tests/log)
```

- Identities use `<command key>/<report key>` from the committed configuration. Command logs use `<command key>/log`.
- The harness runs commands after the agent finishes. Each command generates or copies its report into its fresh `WALLIE_EVIDENCE_DIR`.
- Rendering resolves identities through the displayed artifact's immutable checkpoint, its producing run, and a receipt for that exact output commit. It never selects the latest run or matches files by name.
- Resolved links download private, integrity-checked assets through the authenticated session API. The download repeats the artifact association and workspace membership checks.
- Missing identities, legacy sandbox paths such as `/vercel/sandbox/docs/evidence/comments-toggle-pr-description.md`, and mismatched checkpoints display **Evidence unavailable**. Existing artifact Markdown remains immutable.
- External URLs, relative repository links, anchors, and safe document links retain their existing behavior. Agent-controlled images remain explicit links and never load automatically.

These Markdown links resolve the bounded command text reports. Trusted screenshot
downloads use the browser evidence records and the authenticated image route.

## Run artifact catalog

The catalog derives attempt identity from accepted checkpoints and immutable
validation receipts. It reads the same Markdown and private evidence objects
after sandbox teardown. A failed attempt can have a receipt for its own commit
and tree. The catalog includes accepted checkpoint identity only when the
receipt matches that checkpoint.

| Request                                                                | Result                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/workspaces/{workspaceId}/runs/{runId}/artifacts`             | Metadata, 20 entries by default and at most 50 per page |
| `GET /api/workspaces/{workspaceId}/runs/{runId}/artifacts/{kind}/{id}` | One entry with current availability                     |
| Add `?download=1` to the exact entry URL                               | Verified bytes as a private attachment, up to 1 MiB     |

Pass `nextCursor` as `cursor` for the next page of the same run. The catalog
returns SHA-256 for downloadable content. Retained checkpoints expose their
bundle digest or Git commit identity. Checkpoint recovery bytes remain in
worker storage.

| Availability            | Meaning                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `recorded`              | A private object has a manifest. An exact lookup verifies it. |
| `available`             | The exact content is ready to download.                       |
| `retained`              | Checkpoint metadata is available to authorized members.       |
| `missing`               | Storage could not find the recorded object.                   |
| `expired` or `redacted` | A durable withholding blocks object access.                   |
| `inaccessible`          | Access was denied or the content exceeds the download limit.  |
| `integrity_mismatch`    | The recorded manifest or content failed verification.         |
| `unavailable`           | A temporary read or transport failure prevented verification. |

Apply the artifact catalog migration before deploying its readers. Authorized
requests use workspace membership and row-level security. Existing evidence
links and the run download both verify private object size and SHA-256. PR
readiness checks only the required reports from the exact accepted receipt,
including their bytes, before counting them as accessible.

## Inspecting artifacts in Runs and Review

- Choose **Inspect artifact provenance** on a run or beside the selected
  artifact in Review. Both views open an accepted artifact by its recorded ID.
- Review resolves the selected artifact through its accepted checkpoint.
  Historical artifacts without a checkpoint show that their run was unrecorded.
- The inspector separates agent-authored Markdown, retained source, and
  harness-observed evidence. Files offer a private download after verification.
- Browsing another catalog page or checking a private object takes an explicit
  action. Opening the inspector does not load artifact versions or transcripts.

## Verification

Run the focused capture, persistence, API, and SQL tests, then `pnpm check` and
the generated database types check. The local smoke uses an isolated worktree
of `anantjain-xyz/wallie-dev` itself:

```bash
node --import ./scripts/register-server-only.mjs --import tsx \
  scripts/smoke-validation-evidence.ts
```

It makes no GitHub repository or production setting changes. It commits only
synthetic fixtures on a uniquely scoped local branch, verifies actual passing
execution and report redaction, then proves that a passing test followed by a
source edit cannot validate the later checkpoint. The temporary worktree and
local smoke branch are removed after completion. This proves the local harness
boundary; API/SQL tests separately establish storage access and workspace
isolation.

GitHub App permissions and webhook subscriptions remain the rollout prerequisite
documented in [GitHub PR verification](github-pr-verification.md). Local command
evidence neither changes nor attests the production App configuration.
