import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  rpc: vi.fn(),
  abortSignal: vi.fn(),
}));
vi.mock("@/lib/factories/route-context", () => ({
  factoryResponseHeaders: { "Cache-Control": "private, no-store" },
  resolveFactoryRouteContext: mocks.resolveContext,
}));

import { POST } from "./route";

const workspaceId = "59900000-0000-4000-8000-000000000001";
const factoryId = "59900000-0000-4000-8000-000000000002";
const now = "2026-11-19T12:00:00Z";
const health = {
  status: "paused",
  canManage: true,
  paused: true,
  pausedAt: now,
  oldestPendingAt: null,
  lagSeconds: null,
  lastAttemptAt: now,
  lastSuccessAt: now,
  sourceSnapshotAt: now,
  failedAt: null,
  retryAfter: null,
  failedAttempts: 0,
  rebuild: { state: "idle", requestedAt: null, completedAt: null },
  evaluatedAt: now,
};

function request(body: unknown, query = "", contentType = "application/json") {
  return POST(
    new Request(
      `https://wallie.dev/api/workspaces/${workspaceId}/factories/${factoryId}/projection-control${query}`,
      { method: "POST", headers: { "Content-Type": contentType }, body: JSON.stringify(body) },
    ),
    { params: Promise.resolve({ workspaceId, factoryId }) },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveContext.mockResolvedValue({
    ok: true,
    workspaceId,
    factoryId,
    access: { supabase: { rpc: mocks.rpc } },
  });
  mocks.rpc.mockReturnValue({ abortSignal: mocks.abortSignal });
  mocks.abortSignal.mockResolvedValue({
    data: { ...health, private: "not part of the receipt" },
    error: null,
  });
});

it.each(["pause", "resume", "rebuild"])("runs %s through the user's scoped RPC", async (action) => {
  const response = await request({ action });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual(health);
  expect(mocks.rpc).toHaveBeenCalledWith("control_factory_flow_projection", {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_action: action,
  });
  expect(mocks.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
});

it("fails closed before dispatch for unsupported arguments", async () => {
  expect((await request({ action: "stop-sessions" })).status).toBe(400);
  expect((await request({ action: "pause", factoryId })).status).toBe(400);
  expect((await request({ action: "pause" }, "?bypass=true")).status).toBe(400);
  expect((await request({ action: "pause" }, "", "text/plain")).status).toBe(415);
  expect((await request({ action: "pause", padding: "a".repeat(1024) })).status).toBe(413);
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("preserves workspace access and database manager denials", async () => {
  mocks.resolveContext.mockResolvedValueOnce({
    ok: false,
    response: new Response(null, { status: 401 }),
  });
  expect((await request({ action: "pause" })).status).toBe(401);
  expect(mocks.rpc).not.toHaveBeenCalled();

  mocks.abortSignal.mockResolvedValueOnce({ data: null, error: { code: "PT404" } });
  const response = await request({ action: "rebuild" });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Projection controls are unavailable." });
});

it("reports malformed receipts and projection errors without exposing raw details", async () => {
  mocks.abortSignal.mockResolvedValueOnce({ data: { ...health, status: "retired" }, error: null });
  expect((await request({ action: "pause" })).status).toBe(503);
  mocks.abortSignal.mockResolvedValueOnce({
    data: null,
    error: { code: "XX000", message: "db trace" },
  });
  const response = await request({ action: "pause" });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("db trace");
});
