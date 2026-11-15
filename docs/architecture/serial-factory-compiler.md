# Serial factory definition compiler

`compileFactoryDefinition` turns a structured value or JSON file into a serial workflow bundle. Both inputs use the same version 1 schema and validation. Stage order comes from the `stages` array. Keep a stage's UUID when renaming or moving it.

## Input and component resolution

This example uses `default` and `team/service` as aliases in the caller's catalog.

```json
{
  "schemaVersion": 1,
  "kind": "serial",
  "pipeline": "default",
  "repository": "team/service",
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

## Stage order and prompt references

- Stage prompts can reference artifacts from earlier stages. Shared operating rules can reference any stage. A conditional such as `{{#if artifact.previousStages.design-review}}…{{/if}}` lets shared rules wait until the artifact exists.
- A stage with `anyoneCanApprove: false` and an empty approver list uses Wallie's existing owner and admin approval policy. Explicit approver IDs must resolve to eligible workspace members.
- The compiler resolves these references to stage UUIDs and preserves prompt text. At execution, the existing renderer receives classified configuration and separately classified session, repository, feedback, and artifact values.
- Invalid candidates return diagnostics with a field path, code, and message. Diagnostics identify missing or ambiguous components, unsupported options, duplicate stages, and unreachable stage references.

## Canonical bundle

The bundle replaces aliases with stable IDs. The compiler sorts and deduplicates skill, tool, and approver ID sets. Canonical JSON sorts object keys and preserves array order and string contents. File formatting and object key order produce the same digest when the resolved configuration is equivalent. Stage order contributes to the digest.

`canonicalDigest` is the lowercase SHA-256 of the exact UTF-8 bytes in `definitionJson`. The records migration checks those bytes at persistence. See [Factory definition records](factory-definition-records.md).

Compilation uses the supplied catalog without external calls. OP-542 handles publication and activation and verifies current authority. OP-543 pins the active revision and execution inputs at session admission.
