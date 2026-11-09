import { describe, expect, it } from "vitest";
import { newerStageExecution, parseStageExecution, type StageExecution } from "./stage-execution";

const queued: StageExecution = {
  id: "rerun",
  stageId: "stage",
  status: "queued",
  createdAt: "2026-11-08T12:01:00Z",
  updatedAt: "2026-11-08T12:01:00Z",
};

describe("stage execution ordering", () => {
  it("prefers a newer attempt over a late update to an older failure", () => {
    const oldError = {
      ...queued,
      id: "old",
      status: "error" as const,
      createdAt: "2026-11-08T12:00:00Z",
      updatedAt: "2026-11-08T12:02:00Z",
    };
    expect(newerStageExecution(queued, oldError)).toBe(queued);
    expect(newerStageExecution(oldError, queued)).toBe(queued);
  });
  it("does not regress the same run when updates arrive out of order or share a timestamp", () => {
    const running = { ...queued, status: "running" as const };
    const failed = { ...queued, status: "error" as const, updatedAt: "2026-11-08T12:02:00Z" };
    expect(newerStageExecution(running, queued)).toBe(running);
    expect(newerStageExecution(queued, running)).toBe(running);
    expect(newerStageExecution(failed, running)).toBe(failed);
    expect(newerStageExecution(running, failed)).toBe(failed);
    expect(newerStageExecution(queued, null)).toBe(queued);
  });
  it("treats missing or malformed execution as unknown", () => {
    expect(parseStageExecution(queued)).toEqual(queued);
    for (const value of [
      null,
      undefined,
      {},
      { ...queued, status: "failed" },
      { ...queued, updatedAt: "invalid" },
    ]) {
      expect(parseStageExecution(value)).toBeNull();
    }
  });
});
