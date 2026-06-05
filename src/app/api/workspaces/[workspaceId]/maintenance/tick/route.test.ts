import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  enforceRateLimit: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  runMaintenanceTick: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: mocked.enforceRateLimit,
}));

vi.mock("@/lib/maintenance/service", () => ({
  runMaintenanceTick: mocked.runMaintenanceTick,
}));

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function routeContext() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

function request() {
  return new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}/maintenance/tick`, {
    method: "POST",
  });
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

function maintenanceResult() {
  return {
    cleanup: {
      activeProviderSandboxCount: 2,
      reapedSandboxIds: ["sandbox-orphan"],
      retriedJobIds: ["job-retry"],
      stalledRunIds: ["run-stalled"],
      stoppedSandboxIds: ["sandbox-stalled"],
      terminalErroredJobIds: [],
    },
    processing: {
      processedJobIds: [],
      result: "delegated",
      runId: null,
    },
    reconciliation: {
      canceled: 1,
      checked: 3,
      rateLimited: false,
    },
  } as const;
}

describe("POST /api/workspaces/[workspaceId]/maintenance/tick", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["unauthenticated", "Sign in before managing workspace settings.", 401],
    ["non-member", "Workspace not found.", 404],
    ["non-admin", "Workspace admin access is required for this action.", 403],
  ])("rejects %s callers", async (_label, error, status) => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({ error, ok: false, status });

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(WORKSPACE_ID, {
      requireManager: true,
    });
    expect(mocked.runMaintenanceTick).not.toHaveBeenCalled();
  });

  it("enforces the maintenance rate limit", async () => {
    grantAccess();
    const rateLimitResponse = Response.json(
      { error: "Rate limit exceeded. Please retry later.", retryAfterSeconds: 30 },
      { status: 429 },
    );
    mocked.enforceRateLimit.mockResolvedValue({
      response: rateLimitResponse,
      result: {
        limit: 3,
        remaining: 0,
        resetMs: Date.now() + 30_000,
        retryAfterSeconds: 30,
        success: false,
      },
    });

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(429);
    expect(mocked.enforceRateLimit).toHaveBeenCalledWith("maintenance", `${WORKSPACE_ID}:user-1`);
    expect(mocked.runMaintenanceTick).not.toHaveBeenCalled();
  });

  it("runs a workspace-scoped maintenance tick and returns the summary", async () => {
    grantAccess();
    const admin = {};
    const result = maintenanceResult();
    mocked.createSupabaseAdminClient.mockReturnValue(admin);
    mocked.enforceRateLimit.mockResolvedValue({
      response: null,
      result: {
        limit: 3,
        remaining: 2,
        resetMs: Date.now() + 60_000,
        retryAfterSeconds: 0,
        success: true,
      },
    });
    mocked.runMaintenanceTick.mockResolvedValue(result);

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(result);
    expect(mocked.runMaintenanceTick).toHaveBeenCalledWith({
      admin,
      workspaceId: WORKSPACE_ID,
    });
  });
});
