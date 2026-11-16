import { beforeEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  admin: vi.fn(),
  after: vi.fn(),
  cancel: vi.fn(),
  history: vi.fn(),
  requireManager: vi.fn(),
  start: vi.fn(),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mocked.after,
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocked.admin }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocked.requireManager }));
vi.mock("@/lib/factory-definitions/candidate-smoke", () => ({
  cancelFactoryDefinitionSmokeTest: mocked.cancel,
  listFactoryDefinitionSmokeTests: mocked.history,
  startFactoryDefinitionSmokeTest: mocked.start,
}));

import { DELETE } from "./[testId]/route";
import { GET, POST } from "./route";

const workspaceId = "54700000-0000-4000-8000-000000000001";
const userId = "54700000-0000-4000-8000-000000000002";
const targetId = "54700000-0000-4000-8000-000000000003";
const testId = "54700000-0000-4000-8000-000000000004";
const digest = "a".repeat(64);
const target = { kind: "draft", id: targetId };
const command = { target, expectedDigest: digest, expectedActivationNumber: 2 };
const url = `http://localhost/api/workspaces/${workspaceId}/factory-definition/candidate-tests`;
const context = { params: Promise.resolve({ workspaceId }) };
const admin = {};
const client = {};

beforeEach(() => {
  vi.resetAllMocks();
  mocked.admin.mockReturnValue(admin);
  mocked.requireManager.mockResolvedValue({
    ok: true,
    context: { supabase: client, user: { id: userId }, workspace: { id: workspaceId } },
  });
});

function post(body: unknown) {
  return POST(new Request(url, { method: "POST", body: JSON.stringify(body) }), context);
}

it("reads receipt history through the workspace RLS client using exact candidate identity", async () => {
  mocked.history.mockResolvedValue({ ok: true, tests: [] });
  const query = new URLSearchParams({ targetKind: "draft", targetId, digest });
  const response = await GET(new Request(`${url}?${query}`), context);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(mocked.requireManager).toHaveBeenCalledWith(workspaceId, { requireManager: true });
  expect(mocked.history).toHaveBeenCalledWith({ client, workspaceId, target, digest });
  expect(mocked.admin).not.toHaveBeenCalled();
  expect(await response.json()).toEqual({ tests: [] });
});

it("queues only an authorized reservation with an active runtime callback", async () => {
  const run = vi.fn();
  const test = { id: testId, status: "running" };
  mocked.start.mockResolvedValueOnce({ ok: true, test, run });
  const accepted = await post(command);
  expect(accepted.status).toBe(202);
  expect(mocked.start).toHaveBeenCalledWith({ admin, workspaceId, actorUserId: userId, command });
  expect(mocked.after).toHaveBeenCalledWith(run);
  expect(run).not.toHaveBeenCalled();
  expect(await accepted.json()).toEqual({ test });

  mocked.start.mockResolvedValueOnce({
    ok: true,
    test: { id: testId, status: "blocked" },
    run: null,
  });
  expect((await post(command)).status).toBe(201);
  expect(mocked.after).toHaveBeenCalledTimes(1);
});

it("rejects caller-injected authority and leaves an unauthorized body untouched", async () => {
  expect((await post({ ...command, actorUserId: userId })).status).toBe(400);
  mocked.requireManager.mockResolvedValue({ ok: false, status: 403, error: "Access denied." });
  const request = new Request(url, { method: "POST", body: "invalid" });
  expect((await POST(request, context)).status).toBe(403);
  expect(request.bodyUsed).toBe(false);
  expect(mocked.admin).not.toHaveBeenCalled();
  expect(mocked.start).not.toHaveBeenCalled();
  expect(mocked.after).not.toHaveBeenCalled();
});

it("cancels only the exact test ID and digest through the manager boundary", async () => {
  const test = { id: testId, status: "canceled" };
  mocked.cancel.mockResolvedValue({ ok: true, test });
  const item = { params: Promise.resolve({ workspaceId, testId }) };
  const response = await DELETE(
    new Request(`${url}/${testId}?digest=${digest}`, { method: "DELETE" }),
    item,
  );
  expect(response.status).toBe(200);
  expect(mocked.requireManager).toHaveBeenCalledWith(workspaceId, { requireManager: true });
  expect(mocked.cancel).toHaveBeenCalledWith({
    admin,
    workspaceId,
    actorUserId: userId,
    testId,
    digest,
  });
  expect(await response.json()).toEqual({ test });
});
