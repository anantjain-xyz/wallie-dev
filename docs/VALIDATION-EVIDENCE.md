# Validation evidence

Wallie records command execution independently of the agent's final markdown.
An agent saying that tests passed is a claim for a reviewer to read; it never
becomes observed execution evidence. The harness owns the command identity,
process exit status, execution timestamps, commit and validation tree, and the
private report manifest. PR readiness is evaluated separately in OP-508.

## Repository configuration

Commit `.wallie/validation-evidence.json` with the code being validated. The
harness reads this exact committed file rather than a working copy or agent
output. Version 1 uses this shape:

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

This repository tracks the configuration file while ignoring other `.wallie`
runtime output. Commands execute repository code with the sandbox's normal
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
run for a prose-only artifact. A missing or invalid configuration never becomes
a passing receipt for a policy requirement.

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

Opaque screenshots and previews are explicitly unavailable until a sanitized
capture mechanism can remove sensitive pixels and metadata. They are never
accepted as text reports or described as redacted images. A required unavailable
asset blocks its evidence; an optional unavailable preview is distinguished from
required execution evidence.

Active workspace members can read metadata through
`GET /api/sessions/{sessionId}/validation-evidence` and download an asset through
`GET /api/sessions/{sessionId}/validation-evidence/assets/{assetId}`. The download
route verifies current membership, session ownership, and stored content
integrity. Durable identities are asset IDs and storage paths, not expiring
signed URLs. Objects remain accessible after sandbox teardown and follow the
workspace deletion lifecycle. An inaccessible required asset cannot satisfy a
delivery requirement.

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

This reuses the bounded text-report collector. It does not upload arbitrary local files or enable binary screenshot capture.

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
documented in [GitHub PR verification](GITHUB-PR-VERIFICATION.md). Local command
evidence neither changes nor attests the production App configuration.
