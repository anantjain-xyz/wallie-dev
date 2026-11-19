import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FactoryMcpToolContext } from "./server";
import { registerFactoryMcpTools } from "./tools";

const { executeRead, executeMutation } = vi.hoisted(() => ({
  executeRead: vi.fn(),
  executeMutation: vi.fn(),
}));
vi.mock("@/lib/factory-read-api/server", () => ({ executeFactoryRead: executeRead }));
vi.mock("@/lib/factory-session-mutations/server", () => ({
  executeFactoryMutation: executeMutation,
}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const factoryId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const stageId = "44444444-4444-4444-8444-444444444444";
const artifactId = "55555555-5555-4555-8555-555555555555";
const runId = "66666666-6666-4666-8666-666666666666";
const idempotencyKey = "77777777-7777-4777-8777-777777777777";
const origin = "https://wallie.example";
const resource = `${origin}/api/v1/workspaces/${workspaceId}/factories/${factoryId}/mcp`;
const workbenchHref = `/w/wallie/sessions/7?artifactId=${artifactId}&artifactVersion=2`;
const reportHttpFailure = vi.fn();
const context = {
  workspaceId,
  factoryId,
  resource,
  authorization: "Bearer fixture",
  signal: new AbortController().signal,
  reportHttpFailure,
} satisfies FactoryMcpToolContext;

const review = {
  stageId,
  stageSlug: "review",
  artifactId,
  artifactVersion: 2,
  reviewRevision: 4,
  runId,
  attemptCount: 1,
  checkpointRunId: runId,
  clarification: null,
  href: workbenchHref,
};
const session = {
  id: sessionId,
  number: 7,
  title: "Review the release",
  status: "awaiting_review",
  archivedAt: null,
  createdAt: "2026-11-19T00:00:00Z",
  updatedAt: "2026-11-19T00:01:00Z",
  currentStageId: stageId,
  currentRunId: runId,
  specificationStageId: null,
  canonicalUrl: "/w/wallie/sessions/7",
  review,
};

function registration() {
  const server = new McpServer({ name: "Wallie fixture", version: "1.0.0" });
  const register = vi.spyOn(server, "registerTool");
  registerFactoryMcpTools(server, context);
  const calls = register.mock.calls;
  return {
    calls,
    get(name: string) {
      const call = calls.find(([registered]) => registered === name);
      if (!call) throw new Error(`Tool ${name} is unavailable.`);
      const [, config, callback] = call;
      return {
        config,
        run: callback as unknown as (args: Record<string, unknown>) => Promise<CallToolResult>,
      };
    },
  };
}

beforeEach(() => vi.resetAllMocks());

describe("factory MCP tool projection", () => {
  it("advertises one named operation per shared command plus a read-only human handoff", () => {
    const tools = registration();
    const names = tools.calls.map(([name]) => name);
    expect(new Set(names).size).toBe(11);
    expect(names).not.toContain("wallie_approve");
    expect(tools.get("wallie_review_handoff").config).toMatchObject({
      annotations: { readOnlyHint: true },
      _meta: { "wallie.dev/requiredScope": "sessions:read" },
    });
    expect(tools.get("wallie_cancel_session").config).toMatchObject({
      annotations: { readOnlyHint: false },
      _meta: { "wallie.dev/requiredScope": "sessions:cancel" },
    });
  });

  it("passes the same raw body and explicit retry key to the scoped mutation contract", async () => {
    const body = {
      title: "Start release",
      prompt: "Prepare release notes",
      agentId: stageId,
      repositoryId: artifactId,
    };
    const receipt = {
      receiptId: idempotencyKey,
      sessionId,
      replayed: true,
      canonicalUrl: "/w/wallie/sessions/7",
    };
    executeMutation.mockResolvedValue(Response.json(receipt));

    const result = await registration()
      .get("wallie_create_session")
      .run({ ...body, idempotencyKey });

    expect(executeMutation).toHaveBeenCalledExactlyOnceWith(
      "create",
      { workspaceId, factoryId },
      idempotencyKey,
      expect.any(Function),
      expect.objectContaining({ surface: "mcp", resource, authorization: context.authorization }),
    );
    await expect(executeMutation.mock.calls[0][3]()).resolves.toEqual({ ok: true, body });
    expect(result.structuredContent).toEqual({
      ...receipt,
      canonicalUrl: `${origin}${receipt.canonicalUrl}`,
    });
  });

  it("returns the exact human approval path and rejects a superseded target", async () => {
    executeRead
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json(session));
    const handoff = registration().get("wallie_review_handoff");

    const exact = await handoff.run({
      sessionId,
      expectedReview: { stageId, artifactId, artifactVersion: 2, reviewRevision: 4 },
    });
    expect(exact.structuredContent).toEqual({
      code: "human_action_required",
      action: "review",
      sessionId,
      review: { ...review, href: `${origin}${workbenchHref}` },
    });
    const stale = await handoff.run({
      sessionId,
      expectedReview: { stageId, artifactId, artifactVersion: 1, reviewRevision: 3 },
    });
    expect(stale).toMatchObject({ isError: true, structuredContent: { code: "stale_intent" } });
    expect(stale.structuredContent).not.toHaveProperty("review");
    expect(executeMutation).not.toHaveBeenCalled();
  });

  it("preserves the shared command limit and retry delay", async () => {
    const error = {
      code: "rate_limited",
      error: "The factory command rate limit was reached.",
      retryAfterSeconds: 5,
    };
    executeRead.mockResolvedValue(Response.json(error, { status: 429 }));

    const result = await registration().get("wallie_list_sessions").run({});

    expect(result).toMatchObject({ isError: true, structuredContent: error });
    expect(reportHttpFailure).toHaveBeenCalledExactlyOnceWith({
      status: 429,
      scope: "sessions:read",
      code: "rate_limited",
      retryAfterSeconds: 5,
    });
  });
});
