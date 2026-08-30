import { describe, expect, it } from "vitest";

import { parseToolUseMessage } from "@/features/wallie/run-message-body";

describe("parseToolUseMessage", () => {
  it("parses a Cursor-style Tool name plus fenced JSON and pretty-prints the payload", () => {
    const parsed = parseToolUseMessage(
      '**Tool:** read\n\n```\n{"path":"src/lib/agent-runner/cursor.ts"}\n```',
    );

    expect(parsed).toEqual({
      payload: '{\n  "path": "src/lib/agent-runner/cursor.ts"\n}',
      tool: "read",
    });
  });

  it("parses a Codex bash tool-use row", () => {
    const parsed = parseToolUseMessage('**Tool:** bash\n\n```\n{"cmd":"ls"}\n```');

    expect(parsed?.tool).toBe("bash");
    expect(parsed?.payload).toContain('"cmd": "ls"');
  });

  it("takes the last wrapper fence when the payload contains inner fences", () => {
    const parsed = parseToolUseMessage("**Tool:** read\n\n```\nbefore\n```\nafter\n```");

    expect(parsed).toEqual({
      payload: "before\n```\nafter",
      tool: "read",
    });
  });

  it("leaves truncated JSON unchanged and does not throw", () => {
    const truncated = '{"path":"src/lib/agent-runner/cursor.ts","result":"…[truncated]';

    expect(() =>
      parseToolUseMessage(`**Tool:** read\n\n\`\`\`\n${truncated}\n\`\`\``),
    ).not.toThrow();
    expect(parseToolUseMessage(`**Tool:** read\n\n\`\`\`\n${truncated}\n\`\`\``)).toEqual({
      payload: truncated,
      tool: "read",
    });
  });

  it("returns null for a non-template string", () => {
    expect(parseToolUseMessage("Cloning repository")).toBeNull();
    expect(parseToolUseMessage("**Tool:** read")).toBeNull();
    expect(parseToolUseMessage("**Error:** boom")).toBeNull();
  });
});
