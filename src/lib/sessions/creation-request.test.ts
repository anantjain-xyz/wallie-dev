import { describe, expect, it } from "vitest";

import { fingerprintSessionCreation } from "./creation-request";

const input = { promptMd: "Build a search box.", workspaceId: "workspace-1" };

describe("session creation fingerprint", () => {
  it("normalizes input and excludes the request identity", () => {
    expect(fingerprintSessionCreation(input)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      fingerprintSessionCreation({
        ...input,
        requestId: "another-request",
        promptMd: ` ${input.promptMd} `,
        attachmentIds: [],
      }),
    ).toBe(fingerprintSessionCreation(input));
  });

  it.each([
    { promptMd: "Different work" },
    { title: "Explicit title" },
    { workspaceId: "another-workspace" },
    { githubRepositoryId: "another-repository" },
    { selectedStageIds: ["stage-1"] },
    { attachmentIds: ["image-1"] },
    { linearIssueUrl: "https://linear.app/acme/issue/ABC-123/example" },
  ])("distinguishes changed user intent: %j", (change) => {
    expect(fingerprintSessionCreation({ ...input, ...change })).not.toBe(
      fingerprintSessionCreation(input),
    );
  });
});
