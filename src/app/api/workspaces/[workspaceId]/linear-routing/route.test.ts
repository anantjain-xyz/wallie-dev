import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LINEAR_ROUTING_CONFIG } from "@/lib/linear-routing/contracts";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  upsertLinearRoutingConfig: vi.fn(),
  validateLinearRoutingStages: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/linear-routing/server", () => ({
  loadLinearRoutingConfig: vi.fn(),
  upsertLinearRoutingConfig: mocked.upsertLinearRoutingConfig,
  validateLinearRoutingStages: mocked.validateLinearRoutingStages,
}));

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

  it("validates stages before saving routing config", async () => {
    grantAccess();
    const admin = {};
    mocked.createSupabaseAdminClient.mockReturnValue(admin);
    mocked.validateLinearRoutingStages.mockResolvedValue({ ok: true });
    mocked.upsertLinearRoutingConfig.mockResolvedValue(DEFAULT_LINEAR_ROUTING_CONFIG);

    const response = await PUT(requestWith(DEFAULT_LINEAR_ROUTING_CONFIG), routeContext());

    expect(response.status).toBe(200);
    expect(mocked.validateLinearRoutingStages).toHaveBeenCalledWith({
      admin,
      config: DEFAULT_LINEAR_ROUTING_CONFIG,
      workspaceId: WORKSPACE_ID,
    });
    expect(mocked.upsertLinearRoutingConfig).toHaveBeenCalledWith({
      admin,
      config: DEFAULT_LINEAR_ROUTING_CONFIG,
      workspaceId: WORKSPACE_ID,
    });
  });

  it("rejects unknown routing stage slugs", async () => {
    grantAccess();
    mocked.createSupabaseAdminClient.mockReturnValue({});
    mocked.validateLinearRoutingStages.mockResolvedValue({
      error: "Unknown pipeline stage slug: ship",
      ok: false,
    });

    const response = await PUT(
      requestWith({ ...DEFAULT_LINEAR_ROUTING_CONFIG, landStageSlug: "ship" }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Unknown pipeline stage slug: ship",
    });
    expect(mocked.upsertLinearRoutingConfig).not.toHaveBeenCalled();
  });
});
