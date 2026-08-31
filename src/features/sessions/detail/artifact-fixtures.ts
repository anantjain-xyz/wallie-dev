/**
 * Shared Markdown fixtures for artifact rendering and security coverage.
 * Covers every supported element plus hostile, empty, structured, and failure cases.
 */

export const ARTIFACT_FIXTURE_FULL_MARKDOWN = `# Heading One

## Heading Two

### Heading Three

#### Heading Four

Paragraph with **bold**, *italic*, and \`inline code\`.

> Blockquote about the change.

- Unordered one
- Unordered two

1. Ordered one
2. Ordered two

- [x] Completed task
- [ ] Pending task

| Column A | Column B |
| -------- | -------- |
| alpha    | beta     |
| gamma    | delta    |

\`\`\`ts
const answer = 42;
\`\`\`

[External docs](https://example.com/docs)

![Diagram](https://example.com/diagram.png)

---

Final paragraph.
`;

export const ARTIFACT_FIXTURE_HOSTILE = [
  'Hello <script>alert(1)</script> <img src=x onerror="alert(2)">',
  "[click](javascript:alert(1))",
  '[click](jav&#x61;script:alert(1)) <a href="https://safe.example" onclick="alert(2)">safe</a>',
  "![track](https://attacker.example/track.png)",
].join("\n\n");

export const ARTIFACT_FIXTURE_EMPTY = "";

export const ARTIFACT_FIXTURE_PLAIN_TEXT = "Just a plain-text artifact with no Markdown structure.";

export const ARTIFACT_FIXTURE_RAW_JSON = {
  status: "ok",
  steps: ["clone", "build", "test"],
  meta: { attempt: 2 },
} as const;

export const ARTIFACT_FIXTURE_FAILED = {
  error: "Agent run failed before an artifact was produced.",
  code: "agent_failed",
} as const;
