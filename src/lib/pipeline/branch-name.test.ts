import { describe, expect, it } from "vitest";

import { buildLegacyStageBranchName, buildStageBranchName } from "@/lib/pipeline/branch-name";

describe("buildStageBranchName", () => {
  it("isolates automatic retries and replacement jobs for the same session stage", () => {
    const first = buildStageBranchName("session-abc", "build", { jobId: "job-1", attemptCount: 1 });
    const retry = buildStageBranchName("session-abc", "build", { jobId: "job-1", attemptCount: 2 });
    const replacement = buildStageBranchName("session-abc", "build", {
      jobId: "job-2",
      attemptCount: 1,
    });
    expect(new Set([first, retry, replacement]).size).toBe(3);
    expect(first).toBe("wallie/build-session-abc-job-job-1-attempt-1");
    expect(buildStageBranchName("session-abc", "build", { jobId: "job-1", attemptCount: 1 })).toBe(
      first,
    );
  });

  it("retains stage slug sanitization in execution branches", () => {
    expect(
      buildStageBranchName("session-abc", "Plan Review", { jobId: "job-1", attemptCount: 0 }),
    ).toBe("wallie/Plan-Review-session-abc-job-job-1-attempt-0");
  });
});

describe("buildLegacyStageBranchName", () => {
  it("preserves branch names for historical runs", () => {
    expect(buildLegacyStageBranchName("session-abc", "build")).toBe("wallie/build-session-abc");
    expect(buildLegacyStageBranchName("session-abc", "Plan Review")).toBe(
      "wallie/Plan-Review-session-abc",
    );
  });
});
