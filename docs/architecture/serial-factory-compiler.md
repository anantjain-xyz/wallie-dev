# Serial factory definition compiler

`compileFactoryDefinition` turns a structured value or JSON file into a serial workflow bundle. Both inputs support schema versions 1 and 2. Stage order comes from the `stages` array. Keep a stage's UUID when renaming or moving it.

## Input and component resolution

This example uses `default` and `team/service` as aliases in the caller's catalog.

```json
{
  "schemaVersion": 1,
  "kind": "serial",
  "pipeline": "default",
  "repository": "team/service",
  "writableRepositories": ["team/worker"],
  "readContextRepositories": ["team/engineering-docs"],
  "sandboxProvider": "vercel",
  "agent": {
    "provider": "codex",
    "model": "gpt-5.6-sol",
    "concurrencyLimit": 1,
    "stallTimeoutMs": 900000,
    "maxRetries": 3,
    "maxTurns": 5
  },
  "stages": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "slug": "design-review",
      "name": "Design review",
      "anyoneCanApprove": true,
      "promptTemplateMd": "Review {{session.prompt}}."
    }
  ]
}
```

The caller supplies eligible pipelines, repositories, execution and delivery policy revisions, skills, tools, active human approvers, and sandbox providers. The compiler resolves an exact ID first, then a unique alias inside the workspace. It uses the existing pipeline, agent, and sandbox settings schemas and checks the chosen model, effort, and component support. A delivery policy revision must belong to the chosen pipeline.

| Repository field          | Purpose                                  |
| ------------------------- | ---------------------------------------- |
| `repository`              | Default writable repository              |
| `writableRepositories`    | Optional alternate writable repositories |
| `readContextRepositories` | Optional read-only context repositories  |

Each repository must belong to the factory and its active GitHub installation.
The default is required. The compiler rejects duplicate references across the
three fields after resolving aliases. It sorts both optional lists by stable ID
and omits empty lists from the compiled bundle.

Publication checks the default writable repository. To qualify an alternate,
select it in **Sandbox capability** and run the check for the saved definition.
Session creation and execution require a current capability check for the
selected repository, sandbox connection, and agent configuration.

The optional `implementationAgent` field selects an immutable prompt revision
UUID from the factory's agent catalog. The compiler embeds its agent ID,
revision ID, static instructions, and digest. Omission preserves the default
implementation agent's initial empty instructions. Provider and model settings
remain in `agent`.

The `skills` array selects up to 20 immutable skill revision UUIDs from the
same factory. The compiled serial definition binds those revisions to its
implementation agent. Draft validation, publication, and new session admission
require each revision to remain available and unrevoked.

Execution loads the pinned revisions and verifies their SHA-256 digests before
adding their literal text to the attempt prompt. Wallie onboarding skills and
manager-authored instructions use the trusted prompt boundary. Repository
snapshots retain their declared source and enter through the untrusted boundary.
Retries use their original revision IDs after an edit or revocation. The run
inspector reads the exact revisions from the execution manifest.

Version 2 adds a required `scorerRevisionIds` array with up to 32 immutable
revision UUIDs from the same factory. An empty array opts out of scoring.
Compilation normalizes and sorts the UUIDs and rejects duplicates or
unavailable revisions. Draft storage and activation enforce the same scope.
Version 1 definitions omit the field and retain their original canonical
bytes. See [Scorer revisions and results](factory-definition-records.md#scorer-revisions-and-results).

## Stage order and prompt references

- Stage prompts can reference artifacts from earlier stages. Shared operating rules can reference any stage. A conditional such as `{{#if artifact.previousStages.design-review}}…{{/if}}` lets shared rules wait until the artifact exists.
- A stage with `anyoneCanApprove: false` and an empty approver list uses Wallie's existing owner and admin approval policy. Explicit approver IDs must resolve to eligible workspace members.
- The compiler resolves these references to stage UUIDs and preserves prompt text. At execution, the existing renderer receives classified configuration and separately classified session, repository, feedback, and artifact values.
- Named-agent instructions are static text. Template tokens in those
  instructions remain literal and introduce no artifact dependencies.
- Invalid candidates return diagnostics with a field path, code, and message. Diagnostics identify missing or ambiguous components, unsupported options, duplicate stages, and unreachable stage references.

## Canonical bundle

The bundle replaces aliases with stable IDs. The compiler sorts and deduplicates skill, tool, and approver ID sets. Canonical JSON sorts object keys and preserves array order and string contents. File formatting and object key order produce the same digest when the resolved configuration is equivalent. Stage order contributes to the digest.

`canonicalDigest` is the lowercase SHA-256 of the exact UTF-8 bytes in `definitionJson`. The records migration checks those bytes at persistence. See [Factory definition records](factory-definition-records.md).

Compilation uses the supplied catalog without external calls. [Publication and activation](factory-definition-activation.md) verify current authority. [Session input records](factory-session-inputs.md) capture the active revision at admission and the exact inputs used by each attempt.
