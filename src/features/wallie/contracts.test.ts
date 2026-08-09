import { describe, expect, it } from "vitest";

import {
  runHistoryQuerySchema,
  retryAgentRunParamsSchema,
  retryAgentRunSchema,
} from "@/features/wallie/contracts";

describe("wallie route contracts", () => {
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
