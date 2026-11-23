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

## Typed workflow graphs

`compileWorkflowGraph` compiles version 1 graph definitions to canonical JSON and a SHA-256 digest. Nodes, edges, and grant declarations are ordered by stable ID. The caller supplies the eligible agent prompt revisions, approvers, and grant revisions for the factory.

| Node                                        | Transitions                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Agent, deterministic step, human gate, join | At most one forward successor                                                                         |
| Route                                       | A choice among distinct destinations, with at least one forward option                                |
| Branch                                      | Two or more isolated agents, including at least one required agent. Every result feeds the same join. |

- Every node must be reachable from the entry through forward edges. Forward edges form a directed acyclic graph.
- A loop returns to its route or an ancestor. Each loop limit applies across the root execution, including re-entry and recovery. Multiplying the node count by one plus the total allowed loop traversals must fit within 1,024 visits.
- A join receives the named results of one branch. Its inputs retain the identity and required status of each branch edge.
- `projectSerialWorkflow` derives an agent node and a human gate for each stored stage, in order. The stage UUID anchors both identities. The gate retains its original approval settings, including the owner and admin fallback. Published serial bytes and digests continue to identify the existing execution inputs.

## Workflow execution receipts

The service can enroll a root session with its exact pinned serial projection. Enrollment verifies the definition digest, selected stage order, and approval policies. The execution retains those pins and the submitted workflow digest.

- Mutations check workspace and factory admission, then lock the root session and the workflow execution. Descendant commands take session, job, and run locks after the root locks.
- A worker writes with the generation and its ownership token. A handoff advances the generation, rotates the token, and retains accepted results and transition receipts. Restart reads and enrollment replays exclude the token.
- Admission requires the exact successful result from the preceding occurrence. Replaying a request returns the same receipt and target occurrence.
- Restart reads occurrences, results, and ready edges in one snapshot. An active workspace and factory can advance an edge with a successful source result until its transition receipt is recorded.

## Guarded workflow steps

A graph execution pins the compiled graph revision and its base factory definition. Validation, checkpoint, and human gates require the exact run that supplied the checkpoint intent. The deterministic executor follows the registered graph’s ordered next edges.

| Step       | Evidence for advancing                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| Validation | Required harness results or browser receipts, with their accessible assets, for the exact commit and validation tree |
| Policy     | The pinned execution policy with budget available                                                                    |
| Checkpoint | An adopted publication and its exact retained source receipt                                                         |
| Human gate | A current approval of the exact artifact under the pinned approver policy                                            |

Pending evidence and open blockers leave the occurrence available for recovery. Success records the verified result before admitting a successor. A recovery handoff issues a fresh token and continues from the original result or transition.

## Bounded route decisions

Route nodes use stable destination IDs and a pinned confidence threshold. The compiled policy declares each route's proposal allowlist, one escalation path, and root-wide visit and loop limits.

| Proposal                                                                 | Outcome                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Allowed destination with sufficient confidence                           | Record the exact route decision and admit that destination    |
| Allowed destination below the threshold or an unresolved proposal        | Use the configured forward fallback or record a clarification |
| Unknown destination, exhausted limits, or a grant outside the root scope | Reject without admitting work                                 |

The worker accepts bounded JSON with a destination, confidence, and reason, or an explicit unresolved reason. The reason is evidence text. The configured policy supplies every destination and permission.

Admission checks the current grant and execution budget under the root lock. It records the decision before creating a target occurrence in the same transaction. A clarification retains the decision without creating a target. An exact retry returns the original receipt across ownership changes. A changed proposal for the same occurrence conflicts with the retained decision.
