import { describe, expect, it } from "vitest";

import { createSessionPayloadSchema, normalizeCreateSessionPayload } from "./create";
import { extractLinearIssueId } from "./linear-issue-url";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const STAGE_ID = "33333333-3333-4333-8333-333333333333";

describe("createSessionPayloadSchema", () => {
  it("accepts either a prompt or a Linear issue URL", () => {
    expect(
      createSessionPayloadSchema.safeParse({ promptMd: "Build it", workspaceId: WORKSPACE_ID })
        .success,
    ).toBe(true);
    expect(
      createSessionPayloadSchema.safeParse({
        linearIssueUrl: "https://linear.app/acme/issue/TEAM-42/build-it",
        workspaceId: WORKSPACE_ID,
      }).success,
    ).toBe(true);
  });

  it("rejects a payload without either work source", () => {
    const result = createSessionPayloadSchema.safeParse({
      linearIssueUrl: "  ",
      promptMd: "  ",
      workspaceId: WORKSPACE_ID,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Enter a Linear issue URL or a prompt.");
  });

  it("rejects URLs that do not identify an issue on Linear", () => {
    const result = createSessionPayloadSchema.safeParse({
      linearIssueUrl: "https://linear.app/acme/settings",
      promptMd: "Additional context",
      workspaceId: WORKSPACE_ID,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Linear issue URL is invalid.");
  });

  it("requires a nonempty unique stage selection when one is provided", () => {
    expect(
      createSessionPayloadSchema.safeParse({
        promptMd: "Build it",
        selectedStageIds: [],
        workspaceId: WORKSPACE_ID,
      }).success,
    ).toBe(false);
    expect(
      createSessionPayloadSchema.safeParse({
        promptMd: "Build it",
        selectedStageIds: [STAGE_ID, STAGE_ID],
        workspaceId: WORKSPACE_ID,
      }).success,
    ).toBe(false);
    expect(
      createSessionPayloadSchema.safeParse({
        promptMd: "Build it",
        selectedStageIds: [STAGE_ID],
        workspaceId: WORKSPACE_ID,
      }).success,
    ).toBe(true);
  });
});

describe("normalizeCreateSessionPayload", () => {
  it("keeps an empty prompt when a Linear issue is the work source", () => {
    const parsed = createSessionPayloadSchema.parse({
      linearIssueUrl: " https://linear.app/acme/issue/team-42/build-it ",
      selectedStageIds: [STAGE_ID],
      workspaceId: WORKSPACE_ID,
    });

    expect(normalizeCreateSessionPayload(parsed)).toMatchObject({
      linearIssueId: "TEAM-42",
      linearIssueUrl: "https://linear.app/acme/issue/team-42/build-it",
      promptMd: "",
      selectedStageIds: [STAGE_ID],
    });
  });
});

describe("extractLinearIssueId", () => {
  it("accepts Linear and custom Linear hosts", () => {
    expect(extractLinearIssueId("https://linear.app/acme/issue/TEAM-42/title")).toBe("TEAM-42");
    expect(extractLinearIssueId("https://custom.linear.app/acme/issue/team-42/title")).toBe(
      "TEAM-42",
    );
  });

  it("rejects lookalike hosts and non-issue paths", () => {
    expect(extractLinearIssueId("https://linear.app.example.com/acme/issue/TEAM-42")).toBeNull();
    expect(extractLinearIssueId("https://linear.app/acme/settings")).toBeNull();
  });
});
