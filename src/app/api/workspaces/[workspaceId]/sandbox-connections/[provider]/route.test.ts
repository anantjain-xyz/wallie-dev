import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  acquireSandboxConnectionMutationLock: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  loadWorkspaceSandboxConnection: vi.fn(),
  loadWorkspaceSandboxSettings: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  saveDaytonaSandboxConnection: vi.fn(),
  stopWorkspaceOwnedSandboxes: vi.fn(),
  stopVercelWorkspaceOwnedSandboxes: vi.fn(),
  validateDaytonaSandboxCredentials: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/sandbox-connections/cleanup", () => ({
  stopVercelWorkspaceOwnedSandboxes: mocked.stopVercelWorkspaceOwnedSandboxes,
}));

vi.mock("@/lib/sandbox-connections/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sandbox-connections/server")>(
    "@/lib/sandbox-connections/server",
  );
  return {
    ...actual,
    acquireSandboxConnectionMutationLock: mocked.acquireSandboxConnectionMutationLock,
    loadWorkspaceSandboxConnection: mocked.loadWorkspaceSandboxConnection,
    loadWorkspaceSandboxSettings: mocked.loadWorkspaceSandboxSettings,
    saveDaytonaSandboxConnection: mocked.saveDaytonaSandboxConnection,
    stopWorkspaceOwnedSandboxes: mocked.stopWorkspaceOwnedSandboxes,
    validateDaytonaSandboxCredentials: mocked.validateDaytonaSandboxCredentials,
  };
});

import { SandboxConnectionInvalidError } from "@/lib/sandbox-connections/server";
import { DELETE, PUT } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const connection = {
  credentials: { projectId: "project-1", teamId: "team-1", token: "secret" },
  provider: "vercel" as const,
  revision: "revision-1",
};

function context(provider: string) {
  return { params: Promise.resolve({ provider, workspaceId }) };
}

describe("DELETE /api/workspaces/[workspaceId]/sandbox-connections/[provider]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const eq = vi.fn().mockResolvedValue({ error: null });
    const deleteRow = vi.fn(() => ({ eq }));
    mocked.createSupabaseAdminClient.mockReturnValue({
      from: vi.fn(() => ({ delete: deleteRow })),
    });
    mocked.acquireSandboxConnectionMutationLock.mockResolvedValue(vi.fn());
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      context: {
        currentMember: { id: "member-1", role: "owner" },
        workspace: { id: workspaceId },
      },
      ok: true,
    });
    mocked.loadWorkspaceSandboxConnection.mockResolvedValue({ connection });
    mocked.loadWorkspaceSandboxSettings.mockResolvedValue({
      activeProvider: "e2b",
      revision: 2,
      updatedAt: null,
    });
    mocked.validateDaytonaSandboxCredentials.mockResolvedValue({
      credentials: {
        apiKey: "daytona-secret",
        apiUrl: "https://app.daytona.io/api",
      },
      ok: true,
    });
    mocked.saveDaytonaSandboxConnection.mockResolvedValue({
      apiKeyPreview: "daytona_…cret",
      apiUrl: "https://app.daytona.io/api",
      connectionRevision: "revision-daytona",
      lastValidatedAt: "2026-07-22T00:00:00.000Z",
      lastValidationError: null,
      status: "connected",
      target: null,
      updatedAt: "2026-07-22T00:00:00.000Z",
      workspaceId,
    });
  });

  it("rejects deleting the active provider before loading or deleting its connection", async () => {
    mocked.loadWorkspaceSandboxSettings.mockResolvedValueOnce({
      activeProvider: "vercel",
      revision: 2,
      updatedAt: null,
    });

    const response = await DELETE(new Request("http://localhost"), context("vercel"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Switch to another sandbox provider before disconnecting Vercel Sandbox.",
    });
    expect(mocked.loadWorkspaceSandboxConnection).not.toHaveBeenCalled();
    expect(mocked.createSupabaseAdminClient.mock.results[0]?.value.from).not.toHaveBeenCalled();
  });

  it("uses the conservative Vercel cleanup path before deleting an inactive connection", async () => {
    const admin = mocked.createSupabaseAdminClient();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(admin);

    const response = await DELETE(new Request("http://localhost"), context("vercel"));

    expect(response.status).toBe(200);
    expect(mocked.stopVercelWorkspaceOwnedSandboxes).toHaveBeenCalledWith({
      admin,
      connection,
      workspaceId,
    });
    expect(admin.from).toHaveBeenCalledWith("workspace_vercel_sandbox_connections");
  });

  it("allows replacing a Daytona connection rejected by the current URL policy", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocked.loadWorkspaceSandboxConnection.mockRejectedValueOnce(
      new SandboxConnectionInvalidError(
        "daytona",
        "Daytona API URL is not allowed by this Wallie deployment.",
      ),
    );

    const response = await PUT(
      new Request("http://localhost", {
        body: JSON.stringify({
          apiKey: "daytona-secret",
          apiUrl: "https://app.daytona.io/api",
        }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      }),
      context("daytona"),
    );

    expect(response.status).toBe(200);
    expect(mocked.stopWorkspaceOwnedSandboxes).not.toHaveBeenCalled();
    expect(mocked.saveDaytonaSandboxConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        apiUrl: "https://app.daytona.io/api",
        workspaceId,
      }),
    );
    expect(warning).toHaveBeenCalledWith(
      "[sandbox-connection] skipping cleanup for policy-rejected Daytona endpoint",
      expect.objectContaining({ workspaceId }),
    );
    warning.mockRestore();
  });

  it("allows deleting an inactive Daytona connection rejected by URL policy", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const admin = mocked.createSupabaseAdminClient();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(admin);
    mocked.loadWorkspaceSandboxConnection.mockRejectedValueOnce(
      new SandboxConnectionInvalidError(
        "daytona",
        "Daytona API URL is not allowed by this Wallie deployment.",
      ),
    );

    const response = await DELETE(new Request("http://localhost"), context("daytona"));

    expect(response.status).toBe(200);
    expect(mocked.stopWorkspaceOwnedSandboxes).not.toHaveBeenCalled();
    expect(admin.from).toHaveBeenCalledWith("workspace_daytona_sandbox_connections");
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });
});
