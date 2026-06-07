import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  loadRequiredVercelSandboxConnection: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  resolveAuthenticatedSettingsPath: vi.fn(),
  startCodexDeviceAuthFlow: vi.fn(),
  VercelSandboxConnectionInvalidError: class VercelSandboxConnectionInvalidError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "VercelSandboxConnectionInvalidError";
    }
  },
  VercelSandboxConnectionMissingError: class VercelSandboxConnectionMissingError extends Error {
    constructor() {
      super("Connect a Vercel Sandbox account before starting Wallie runs.");
      this.name = "VercelSandboxConnectionMissingError";
    }
  },
}));

const vercelCredentials = {
  projectId: "prj_123",
  teamId: "team_123",
  token: "vca_secret",
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    resolveAuthenticatedSettingsPath: mocked.resolveAuthenticatedSettingsPath,
  };
});

vi.mock("@/lib/codex/device-auth", () => ({
  startCodexDeviceAuthFlow: mocked.startCodexDeviceAuthFlow,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/vercel-sandbox/server", () => ({
  loadRequiredVercelSandboxConnection: mocked.loadRequiredVercelSandboxConnection,
  VercelSandboxConnectionInvalidError: mocked.VercelSandboxConnectionInvalidError,
  VercelSandboxConnectionMissingError: mocked.VercelSandboxConnectionMissingError,
}));

import { GET } from "@/app/auth/codex/route";

describe("GET /auth/codex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.createSupabaseAdminClient.mockReturnValue({});
    mocked.createSupabaseServerClient.mockResolvedValue({});
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-123" });
    mocked.loadRequiredVercelSandboxConnection.mockResolvedValue({
      credentials: vercelCredentials,
      preview: {
        projectId: "prj_123",
        status: "connected",
        teamId: "team_123",
      },
    });
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      context: {
        workspace: { id: "workspace-123" },
      },
      ok: true,
    });
    mocked.resolveAuthenticatedSettingsPath.mockResolvedValue("/settings/integrations");
    mocked.startCodexDeviceAuthFlow.mockResolvedValue({
      error: null,
      expiresAt: "2026-05-19T00:10:00.000Z",
      flowId: "flow-1",
      instructions: "Open https://chatgpt.com/activate and enter ABCD-EFGH",
      status: "prompted",
      userCode: "ABCD-EFGH",
      verificationUri: "https://chatgpt.com/activate",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects direct authenticated navigation back to settings with a device-flow flash", async () => {
    const response = await GET(new NextRequest("https://wallie.dev/auth/codex"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://wallie.dev/settings/integrations?codex_connect=chatgpt_device_required",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocked.startCodexDeviceAuthFlow).not.toHaveBeenCalled();
  });

  it("starts a device-code flow for authenticated JSON requests", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost:3000/auth/codex?next=/w/acme/onboarding?step=runtime&workspaceId=workspace-123",
        {
          headers: { accept: "application/json" },
        },
      ),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      flowId: "flow-1",
      status: "prompted",
      userCode: "ABCD-EFGH",
    });
    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith("workspace-123");
    expect(mocked.loadRequiredVercelSandboxConnection).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-123",
    );
    expect(mocked.startCodexDeviceAuthFlow).toHaveBeenCalledWith({
      userId: "user-123",
      vercelCredentials,
    });
  });

  it("blocks device-code flow when the workspace Vercel connection is missing", async () => {
    mocked.loadRequiredVercelSandboxConnection.mockRejectedValueOnce(
      new mocked.VercelSandboxConnectionMissingError(),
    );

    const response = await GET(
      new NextRequest("http://localhost:3000/auth/codex?workspaceId=workspace-123", {
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Connect a Vercel Sandbox account before starting Wallie runs.",
    });
    expect(mocked.startCodexDeviceAuthFlow).not.toHaveBeenCalled();
  });

  it("blocks device-code flow when the workspace Vercel connection is invalid", async () => {
    mocked.loadRequiredVercelSandboxConnection.mockRejectedValueOnce(
      new mocked.VercelSandboxConnectionInvalidError(
        "Saved Vercel Sandbox connection is not valid. Reconnect it in workspace settings.",
      ),
    );

    const response = await GET(
      new NextRequest("http://localhost:3000/auth/codex?workspaceId=workspace-123", {
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Saved Vercel Sandbox connection is not valid. Reconnect it in workspace settings.",
    });
    expect(mocked.startCodexDeviceAuthFlow).not.toHaveBeenCalled();
  });

  it("returns workspace access failures before starting a device-code flow", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValueOnce({
      error: "Workspace not found.",
      ok: false,
      status: 404,
    });

    const response = await GET(
      new NextRequest("http://localhost:3000/auth/codex?workspaceId=workspace-404", {
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Workspace not found." });
    expect(mocked.loadRequiredVercelSandboxConnection).not.toHaveBeenCalled();
    expect(mocked.startCodexDeviceAuthFlow).not.toHaveBeenCalled();
  });

  it("sends unauthenticated users through login", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    const response = await GET(new NextRequest("http://localhost:3000/auth/codex?next=/settings"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("returns 401 for unauthenticated JSON requests", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    const response = await GET(
      new NextRequest("http://localhost:3000/auth/codex?next=/settings", {
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });
});
