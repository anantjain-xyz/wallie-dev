import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAccess: vi.fn(),
  adminClient: vi.fn(),
  load: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.requireAccess }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.adminClient }));
vi.mock("@/lib/factory-definitions/settings", () => ({
  loadFactorySettings: mocks.load,
  mutateFactorySettings: mocks.mutate,
}));

import { GET, POST } from "./route";

const workspaceId = "54200000-0006-4000-8000-000000000001";
const actorUserId = "54200000-0006-4000-8000-000000000002";
const draftId = "54200000-0006-4000-8000-000000000003";
const scopedClient = { scope: "user" };
const adminClient = { scope: "service" };
const context = { params: Promise.resolve({ workspaceId }) };
const routeUrl = "http://localhost/api/workspaces/" + workspaceId + "/factory-definition/settings";

function authorize(role: "member" | "admin") {
  mocks.requireAccess.mockResolvedValue({
    ok: true,
    context: {
      currentMember: { role },
      workspace: { id: workspaceId },
      supabase: scopedClient,
      user: { id: actorUserId },
    },
  });
}

function post(body: unknown) {
  return POST(new Request(routeUrl, { method: "POST", body: JSON.stringify(body) }), context);
}

beforeEach(() => vi.resetAllMocks());

it.each([
  ["member", false],
  ["admin", true],
] as const)(
  "loads Settings through the %s session and preserves the draft access boundary",
  async (role, includeDraft) => {
    authorize(role);
    mocks.load.mockResolvedValue(null);
    const response = await GET(new Request(routeUrl), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ snapshot: null });
    expect(mocks.load).toHaveBeenCalledWith(scopedClient, workspaceId, includeDraft);
    expect(mocks.adminClient).not.toHaveBeenCalled();
  },
);

it("passes the displayed revision through and reports a publication conflict", async () => {
  authorize("admin");
  mocks.adminClient.mockReturnValue(adminClient);
  mocks.mutate.mockResolvedValue({ ok: false, status: 409, error: "The factory draft changed." });
  const command = { action: "publish", expectedActivationNumber: 2, draftId };
  const response = await post(command);
  expect(mocks.requireAccess).toHaveBeenCalledWith(workspaceId, { requireManager: true });
  expect(mocks.mutate).toHaveBeenCalledWith({
    client: adminClient,
    workspaceId,
    actorUserId,
    command,
  });
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({ error: "The factory draft changed." });
});

it("rejects a save without the displayed draft token before obtaining the service client", async () => {
  authorize("admin");
  const response = await post({
    action: "save",
    expectedActivationNumber: 0,
    patch: { kind: "sandbox-provider", provider: "vercel" },
  });
  expect(response.status).toBe(400);
  expect(mocks.adminClient).not.toHaveBeenCalled();
  expect(mocks.mutate).not.toHaveBeenCalled();
});
