import { describe, expect, it } from "vitest";

import {
  mergeWallieRuns,
  normalizeWallieRuns,
  upsertWallieRunMessage,
} from "@/features/wallie/data";
import type { WallieRun } from "@/features/wallie/types";

function run(id: string, createdAt = "2026-07-18T12:00:00.000Z"): WallieRun {
  return {
    canCancel: false,
    canRetry: false,
    createdAt,
    finishedAt: createdAt,
    id,
    isActive: false,
    isTerminal: true,
    messages: [],
    modelName: "gpt-5",
    modelProvider: "codex",
    requestedByMember: null,
    requestedByMemberId: null,
    runType: "code",
    startedAt: createdAt,
    stageId: null,
    stageName: "Build",
    stageSlug: "build",
    status: "success",
  };
}

describe("Wallie run history data", () => {
  it("uses id as the deterministic descending tie-breaker", () => {
    expect(
      normalizeWallieRuns([run("run-a"), run("run-c"), run("run-b")]).map((row) => row.id),
    ).toEqual(["run-c", "run-b", "run-a"]);
  });

  it("preserves unaffected run references so memoized rows skip message updates", () => {
    const first = run("run-1");
    const second = run("run-2", "2026-07-18T11:00:00.000Z");
    const next = upsertWallieRunMessage([first, second], {
      agentRunId: first.id,
      message: {
        createdAt: "2026-07-18T12:01:00.000Z",
        id: "message-1",
        kind: "progress",
        messageMd: "Working",
      },
    });

    expect(next[0]).not.toBe(first);
    expect(next[1]).toBe(second);
  });

  it("deduplicates reconciled run ids while retaining cached messages", () => {
    const cached = {
      ...run("run-1"),
      messages: [
        {
          createdAt: "2026-07-18T12:01:00.000Z",
          id: "message-1",
          kind: "progress",
          messageMd: "Cached",
        },
      ],
    };
    const reconciled = mergeWallieRuns([cached], [{ ...run("run-1"), status: "error" }]);

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.status).toBe("error");
    expect(reconciled[0]?.messages).toEqual(cached.messages);
  });
});
