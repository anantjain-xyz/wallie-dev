import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LINEAR_ROUTING_CONFIG } from "@/lib/linear-routing/contracts";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  saveLinearRoutingConfig: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/linear-routing/server", () => ({
  saveLinearRoutingConfig: mocked.saveLinearRoutingConfig,
}));

import * as linearRoutingRoute from "./route";
import { PUT } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function requestWith(body: unknown) {
  return new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}/linear-routing`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

function routeContext() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

function grantAccess() {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      currentMember: { id: "member-1", is_active: true, kind: "human", role: "owner" },
      supabase: {},
      user: { id: "user-1" },
      workspace: { id: WORKSPACE_ID, name: "Wallie", slug: "wallie" },
    },
    ok: true,
  });
}

describe("PUT /api/workspaces/[workspaceId]/linear-routing", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exposes only the PUT mutation handler", () => {
    expect(Object.keys(linearRoutingRoute).sort()).toEqual(["PUT"]);
  });

  it("saves routing against the revision shown to the manager", async () => {
    grantAccess();
    const admin = {};
    const config = { ...DEFAULT_LINEAR_ROUTING_CONFIG, expectedFactoryRevisionId: null };
    mocked.createSupabaseAdminClient.mockReturnValue(admin);
    mocked.saveLinearRoutingConfig.mockResolvedValue(DEFAULT_LINEAR_ROUTING_CONFIG);

    const response = await PUT(requestWith(config), routeContext());

    expect(response.status).toBe(200);
    expect(mocked.saveLinearRoutingConfig).toHaveBeenCalledWith({
      actorUserId: "user-1",
      admin,
      config,
      workspaceId: WORKSPACE_ID,
    });
  });

  it.each([
    ["PT422", 400],
    ["PT409", 409],
    ["42501", 403],
  ])("maps routing save error %s to HTTP %d", async (code, status) => {
    grantAccess();
    mocked.createSupabaseAdminClient.mockReturnValue({});
    mocked.saveLinearRoutingConfig.mockRejectedValue({ code });

    const response = await PUT(requestWith(DEFAULT_LINEAR_ROUTING_CONFIG), routeContext());

    expect(response.status).toBe(status);
  });
});
