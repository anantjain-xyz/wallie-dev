import { describe, expect, it } from "vitest";

import {
  connectionStateCopy,
  currentOperationLabel,
  formatMessageSourceLabel,
  groupActivityMessages,
  isRunActivityStalled,
  lastActivityTimestamp,
  messagesEmptyCopy,
  messagesFailedCopy,
  messagesLoadingCopy,
} from "@/features/wallie/activity-summary";
import type { WallieRun } from "@/features/wallie/types";

function run(overrides: Partial<WallieRun> = {}): WallieRun {
  return {
    attemptCount: 1,
    canCancel: false,
    canRetry: false,
    createdAt: "2026-07-18T12:00:00.000Z",
    finishedAt: null,
    id: "run-1",
    isActive: true,
    isTerminal: false,
    lastActivityAt: "2026-07-18T12:00:00.000Z",
    messages: [],
    modelName: "gpt-5",
    modelProvider: "codex",
    requestedByMember: null,
    requestedByMemberId: null,
    runType: "code",
    sandboxId: null,
    sandboxProvider: null,
    startedAt: "2026-07-18T12:00:00.000Z",
    stageId: null,
    stageName: "Build",
    stageSlug: "build",
    status: "running",
    updatedAt: "2026-07-18T12:00:00.000Z",
    ...overrides,
  };
}

describe("activity-summary helpers", () => {
  it("groups only adjacent exploration and keeps stable event IDs as the group grows", () => {
    const tool = (id: string, name: string) => ({
      id,
      kind: "tool_use",
      createdAt: "2026-07-18T12:00:00.000Z",
      messageMd: `**Tool:** ${name}\n\n\`\`\`\n{}\n\`\`\``,
    });
    const read = tool("read", "read_file");
    expect(groupActivityMessages([read])[0].id).toBe("read");
    const groups = groupActivityMessages([
      read,
      tool("search-1", "grep"),
      tool("search-2", "grep"),
      tool("shell", "bash"),
      tool("list", "list"),
    ]);
    expect(groups.map(({ id, summary }) => ({ id, summary }))).toEqual([
      { id: "read", summary: "1 read, 2 searches" },
      { id: "shell", summary: null },
      { id: "list", summary: "1 list" },
    ]);
    expect(groups.flatMap((group) => group.messages.map((message) => message.id))).toEqual([
      "read",
      "search-1",
      "search-2",
      "shell",
      "list",
    ]);
  });
  it("detects stalled active runs at the workspace stall threshold", () => {
    const nowMs = Date.parse("2026-07-18T12:15:00.000Z");
    expect(
      isRunActivityStalled({
        createdAt: "2026-07-18T12:00:00.000Z",
        isActive: true,
        lastActivityAt: "2026-07-18T12:00:00.000Z",
        nowMs,
        stallTimeoutMs: 900_000,
        status: "running",
      }),
    ).toBe(true);
    expect(
      isRunActivityStalled({
        createdAt: "2026-07-18T12:00:00.000Z",
        isActive: true,
        lastActivityAt: "2026-07-18T12:10:00.000Z",
        nowMs,
        stallTimeoutMs: 900_000,
        status: "running",
      }),
    ).toBe(false);
    expect(
      isRunActivityStalled({
        createdAt: "2026-07-18T12:00:00.000Z",
        isActive: true,
        lastActivityAt: "2026-07-18T12:00:00.000Z",
        nowMs,
        stallTimeoutMs: 900_000,
        status: "queued",
      }),
    ).toBe(false);
  });

  it("labels operations and message sources with distinct copy", () => {
    expect(currentOperationLabel({ run: run({ status: "queued" }), stalled: false })).toBe(
      "Waiting in queue",
    );
    expect(currentOperationLabel({ run: run(), stalled: true })).toBe("No recent activity");
    expect(currentOperationLabel({ run: run(), stalled: false })).toBe("Working");
    expect(formatMessageSourceLabel("progress")).toBe("Progress");
    expect(formatMessageSourceLabel("error")).toBe("Error");
    expect(formatMessageSourceLabel("tool_use")).toBe("Tool use");
    expect(messagesLoadingCopy()).toBe("Loading run messages…");
    expect(messagesEmptyCopy()).toContain("No messages");
    expect(messagesFailedCopy()).toContain("Collapse and expand");
    expect(connectionStateCopy("reconnecting")).toContain("Reconnecting");
    expect(connectionStateCopy("recovered")).toContain("restored");
  });

  it.each([
    ["shell", "Running a command"],
    ["read", "Reading files"],
    ["glob", "Searching the repository"],
    ["unknown-provider-tool", "Using a tool"],
  ])("summarizes %s without exposing its payload", (tool, expected) => {
    const active = run({
      messages: [
        {
          id: "message-1",
          kind: "tool_use",
          messageMd: `**Tool:** ${tool}\n\n\`\`\`\n{"command":"pnpm check"}\n\`\`\``,
          createdAt: "2026-07-18T12:00:00.000Z",
        },
      ],
    });
    expect(currentOperationLabel({ run: active, stalled: false })).toBe(expected);
  });

  it("prefers the newest activity timestamp for last-event display", () => {
    expect(
      lastActivityTimestamp(
        run({
          lastActivityAt: "2026-07-18T12:01:00.000Z",
          messages: [
            {
              createdAt: "2026-07-18T12:02:00.000Z",
              id: "m1",
              kind: "progress",
              messageMd: "Cloning repo",
            },
          ],
          updatedAt: "2026-07-18T12:00:30.000Z",
        }),
      ),
    ).toBe("2026-07-18T12:02:00.000Z");
  });
});
