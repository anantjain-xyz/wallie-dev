import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

const { access, rpc, selectFactory } = vi.hoisted(() => ({
  access: vi.fn(),
  rpc: vi.fn(),
  selectFactory: vi.fn(),
}));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc }) }));
vi.mock("@/lib/factory-definitions/storage", () => ({ selectFactory }));

const workspaceId = "b2700000-0000-4000-8000-000000000001";
const factoryId = "b2700000-0000-4000-8000-000000000002";
const userId = "b2700000-0000-4000-8000-000000000003";
const repositoryId = "b2700000-0000-4000-8000-000000000004";
const draftId = "b2700000-0000-4000-8000-000000000005";
const assignedId = "b2700000-0000-4000-8000-000000000006";
const context = { params: Promise.resolve({ workspaceId, factoryId }) };
const url = `https://wallie.example.test/api/workspaces/${workspaceId}/factories/${factoryId}/definition/setup`;
const command = {
  action: "assign-repository",
  repositoryId,
  expectedActivationNumber: 3,
  expectedDraftId: draftId,
};

function post(body: unknown) {
  return POST(new Request(url, { method: "POST", body: JSON.stringify(body) }), context);
}

beforeEach(() => {
  vi.resetAllMocks();
  access.mockResolvedValue({
    ok: true,
    context: { user: { id: userId }, workspace: { id: workspaceId }, supabase: { rpc } },
  });
  selectFactory.mockResolvedValue({ data: { id: factoryId, is_default: false }, error: null });
});

describe("browser factory setup endpoint", () => {
  it("does not read or write provisioning scope for ordinary workspace members", async () => {
    access.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Workspace admin access is required.",
    });
    expect((await GET(new Request(url), context)).status).toBe(403);
    expect((await post(command)).status).toBe(403);
    expect(access).toHaveBeenCalledWith(workspaceId, { requireManager: true });
    expect(selectFactory).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns only safe repository choices for the selected factory", async () => {
    rpc.mockResolvedValue({
      data: [{ id: repositoryId, full_name: "fixture/docs", repo_id: 17 }],
      error: null,
    });
    const response = await GET(new Request(url), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      repositories: [{ id: repositoryId, fullName: "fixture/docs" }],
    });
    expect(rpc).toHaveBeenCalledWith("list_factory_setup_repositories", {
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
    });
  });

  it("uses the authenticated actor, selected scope, and expected configuration", async () => {
    expect((await post({ ...command, actorUserId: userId })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: assignedId, error: null });
    const response = await post(command);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: assignedId });
    expect(rpc).toHaveBeenCalledWith("provision_factory_serial_setup", {
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_actor_user_id: userId,
      p_expected_activation_number: 3,
      p_expected_draft_id: draftId,
      p_repository_id: repositoryId,
    });
  });

  it.each([
    ["P0002", 404, "This repository is no longer available to assign."],
    ["PT409", 409, "The factory draft changed. Reload before continuing setup."],
    ["PT422", 422, "Assign a connected repository before creating a pipeline."],
  ])("returns a precise error for %s", async (code, status, message) => {
    rpc.mockResolvedValue({ data: null, error: { code, message } });
    const response = await post(command);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
  });
});
