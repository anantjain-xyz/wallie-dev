import { describe, expect, it } from "vitest";

import { formatToolPayload, summarizeToolUse } from "@/features/wallie/run-message-body";

describe("summarizeToolUse", () => {
  it.each([
    ["Read", '{"file_path":"src/a.ts"}', "Read", "src/a.ts", "read"],
    ["read_file", '{"path":"src/b.ts"}', "Read", "src/b.ts", "read"],
    ["functions.exec_command", '{"cmd":"pnpm test\\n--run"}', "Shell", "pnpm test --run", null],
    ["grep", '{"pattern":"tool_use","path":"src"}', "Search", "tool_use", "search"],
    ["write_file", '{"path":"a.ts","content":"large body"}', "Write", "a.ts", null],
    ["mcp.custom", '{"url":"https://example.com"}', "mcp.custom", "https://example.com", null],
    ["bash", '{"result":{"exitCode":0}}', "Shell", "", null],
    ["unknown", '"not an object"', "unknown", "", null],
    ["unknown", "not JSON", "unknown", "", null],
  ])("summarizes %s without deriving a lifecycle state", (name, input, title, target, category) => {
    expect(summarizeToolUse(name, input)).toEqual({ title, target, category });
  });
});

describe("formatToolPayload", () => {
  it("pretty-prints JSON payloads", () => {
    expect(formatToolPayload('{"path":"src/lib/agent-runner/cursor.ts"}')).toEqual(
      '{\n  "path": "src/lib/agent-runner/cursor.ts"\n}',
    );
  });

  it.each([
    "before\n```\nafter",
    '{"path":"src/lib/agent-runner/cursor.ts","result":"…[truncated]',
  ])("preserves a non-JSON or truncated payload", (payload) =>
    expect(formatToolPayload(payload)).toBe(payload),
  );

  it("pretty-prints JSON without rounding integers outside the JS safe range", () => {
    const result = formatToolPayload('{"id":9007199254740993,"ok":true}');
    expect(result).toEqual('{\n  "id": 9007199254740993,\n  "ok": true\n}');
    expect(result).not.toContain("9007199254740992");
  });

  it("preserves original number tokens that JSON.parse would canonicalize", () => {
    expect(formatToolPayload('{"n":1.0,"exp":1e2}')).toBe('{\n  "n": 1.0,\n  "exp": 1e2\n}');
  });
});
