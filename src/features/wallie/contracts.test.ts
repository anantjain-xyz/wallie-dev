import { describe, expect, it } from "vitest";

import {
  enqueueAgentRunSchema,
  runHistoryQuerySchema,
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

  it("requires both fields of the stable run-history cursor", () => {
    expect(
      runHistoryQuerySchema.parse({
        createdAt: "2026-07-18T12:00:00.000Z",
        id: "33333333-3333-4333-8333-333333333333",
      }),
    ).toEqual({
      createdAt: "2026-07-18T12:00:00.000Z",
      id: "33333333-3333-4333-8333-333333333333",
    });
    expect(
      runHistoryQuerySchema.parse({
        createdAt: "2026-07-18T12:00:00.000+00:00",
        id: "33333333-3333-4333-8333-333333333333",
      }),
    ).toEqual({
      createdAt: "2026-07-18T12:00:00.000+00:00",
      id: "33333333-3333-4333-8333-333333333333",
    });
    expect(() =>
      runHistoryQuerySchema.parse({ id: "33333333-3333-4333-8333-333333333333" }),
    ).toThrow("Run history cursor requires both createdAt and id.");
  });
});
