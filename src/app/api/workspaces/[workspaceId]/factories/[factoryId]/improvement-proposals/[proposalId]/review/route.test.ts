import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  resolveScope: vi.fn(),
  sameOrigin: vi.fn(),
  rateLimit: vi.fn(),
  admin: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/factories/route-context", () => ({
  factoryResponseHeaders: { "Cache-Control": "private, no-store" },
  resolveFactoryRouteContext: mocks.resolveScope,
}));
vi.mock("@/lib/factory-oauth/browser-auth", () => ({
  isSameOriginFactoryOAuthPost: mocks.sameOrigin,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/lib/factory-proposals/workbench", () => ({ saveImprovementReview: mocks.save }));

const id = (slot: number) => `63700000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const scope = { workspaceId: id(1), factoryId: id(2), proposalId: id(3) };
const actorId = id(4);
const command = {
  proposalRevisionId: id(5),
  expectedReviewVersion: 2,
  requestId: id(6),
  action: "revise",
  note: "Show the checks that failed.",
};
const saved = {
  event: { id: id(7), version: 3, action: "revise", note: command.note },
  replay: false,
};

function request(value: unknown = command) {
  return new Request("https://wallie.test/improvement-review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

describe("improvement proposal review route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.sameOrigin.mockReturnValue(true);
    mocks.resolveScope.mockResolvedValue({
      ok: true,
      ...scope,
      access: { workspace: { id: scope.workspaceId }, user: { id: actorId } },
    });
    mocks.rateLimit.mockResolvedValue({ response: null });
    mocks.admin.mockReturnValue("admin-fixture");
    mocks.save.mockResolvedValue(saved);
  });

  it("passes the signed-in actor and exact revision to the review save", async () => {
    const post = request();
    const response = await POST(post, { params: Promise.resolve(scope) });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(saved);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.save).toHaveBeenCalledWith(
      "admin-fixture",
      expect.objectContaining({
        workspaceId: scope.workspaceId,
        factoryId: scope.factoryId,
      }),
      actorId,
      scope.proposalId,
      command,
      post.signal,
    );
  });

  it("returns the existing event for replay without turning it into a new decision", async () => {
    mocks.save.mockResolvedValue({ ...saved, replay: true });
    const response = await POST(request(), { params: Promise.resolve(scope) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...saved, replay: true });
  });

  it("reports stale revision or review version as a conflict", async () => {
    mocks.save.mockRejectedValue({ code: "PT409" });
    const response = await POST(request(), { params: Promise.resolve(scope) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The proposal revision or discussion changed. Reload before reviewing.",
    });
  });

  it("rejects cross-origin or invalid review fields before creating privileged clients", async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    expect((await POST(request(), { params: Promise.resolve(scope) })).status).toBe(403);
    expect(mocks.resolveScope).not.toHaveBeenCalled();
    expect(
      (
        await POST(request({ ...command, action: "comment", note: "  " }), {
          params: Promise.resolve(scope),
        })
      ).status,
    ).toBe(400);
    expect(
      (await POST(request({ ...command, actorUserId: id(8) }), { params: Promise.resolve(scope) }))
        .status,
    ).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("returns the rate limit without reading a review request or opening the admin client", async () => {
    mocks.rateLimit.mockResolvedValue({ response: new Response(null, { status: 429 }) });
    const post = request();
    expect((await POST(post, { params: Promise.resolve(scope) })).status).toBe(429);
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      "improvementProposals",
      `${scope.workspaceId}:${actorId}`,
    );
    expect(post.bodyUsed).toBe(false);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});
