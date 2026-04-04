import { describe, expect, it } from "vitest";

import { buildStubBranchName, buildStubProjectArtifacts } from "@/lib/wallie/executor";

describe("wallie stub executor helpers", () => {
  it("builds deterministic project artifacts", () => {
    const artifacts = buildStubProjectArtifacts({
      issue: {
        createdAt: "2026-03-30T12:00:00.000Z",
        descriptionMd: "Need the control plane to be visible on the issue.",
        number: 42,
        title: "Make Wallie queueing observable",
      },
      runCreatedAt: "2026-03-31T08:15:00.000Z",
    });

    expect(artifacts.designMd).toContain("# Wallie Stub Design");
    expect(artifacts.designMd).toContain("Make Wallie queueing observable");
    expect(artifacts.planMd).toContain("# Wallie Stub Plan");
    expect(artifacts.planMd).toContain("issue #42");
  });

  it("builds a stable branch name", () => {
    expect(buildStubBranchName(7)).toBe("wallie/issue-7");
  });
});
