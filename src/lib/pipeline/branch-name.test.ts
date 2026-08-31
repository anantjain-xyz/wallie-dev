import { describe, expect, it } from "vitest";

import { buildStageBranchName } from "@/lib/pipeline/branch-name";

describe("buildStageBranchName", () => {
  it("matches the Wallie stage checkout branch shape", () => {
    expect(buildStageBranchName("session-abc", "build")).toBe("wallie/build-session-abc");
    expect(buildStageBranchName("session-abc", "Plan Review")).toBe(
      "wallie/Plan-Review-session-abc",
    );
  });
});
