import { describe, expect, it } from "vitest";

import {
  enqueueAgentRunSchema,
  retryAgentRunParamsSchema,
  retryAgentRunSchema,
} from "@/features/wallie/contracts";

describe("wallie route contracts", () => {
  it("accepts valid enqueue payloads", () => {
    expect(
      enqueueAgentRunSchema.parse({
        sessionId: "11111111-1111-1111-1111-111111111111",
        workspaceId: "22222222-2222-2222-2222-222222222222",
      }),
    ).toEqual({
      sessionId: "11111111-1111-1111-1111-111111111111",
      workspaceId: "22222222-2222-2222-2222-222222222222",
    });
  });

  it("rejects invalid retry payloads", () => {
    expect(() =>
      retryAgentRunSchema.parse({
        workspaceId: "not-a-uuid",
      }),
    ).toThrow("Workspace id is invalid.");
    expect(() =>
      retryAgentRunParamsSchema.parse({
        runId: "not-a-uuid",
      }),
    ).toThrow("Run id is invalid.");
  });
});
