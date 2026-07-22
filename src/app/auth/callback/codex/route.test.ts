import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  cancelCodexDeviceAuthFlow: vi.fn(),
  consumeAuthenticatedCodexDeviceAuthFlow: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  deleteCodexDeviceAuthFlow: vi.fn(),
  encryptSecretValue: vi.fn((value: string) => `encrypted:${value}`),
  getCodexDeviceAuthFlowSnapshot: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  loadRequiredWorkspaceSandboxConnection: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  resolveAuthenticatedSettingsPath: vi.fn(),
}));

const sandboxConnection = {
  credentials: { apiKey: "e2b_secret" },
  provider: "e2b" as const,
  revision: "revision-2",
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

vi.mock("@/lib/secrets/crypto", () => ({
  encryptSecretValue: mocked.encryptSecretValue,
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    resolveAuthenticatedSettingsPath: mocked.resolveAuthenticatedSettingsPath,
  };
});

vi.mock("@/lib/codex/device-auth", () => ({
  cancelCodexDeviceAuthFlow: mocked.cancelCodexDeviceAuthFlow,
  consumeAuthenticatedCodexDeviceAuthFlow: mocked.consumeAuthenticatedCodexDeviceAuthFlow,
  deleteCodexDeviceAuthFlow: mocked.deleteCodexDeviceAuthFlow,
  getCodexDeviceAuthFlowSnapshot: mocked.getCodexDeviceAuthFlowSnapshot,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/sandbox-connections/server", () => ({
  loadRequiredWorkspaceSandboxConnection: mocked.loadRequiredWorkspaceSandboxConnection,
  SandboxConnectionInvalidError: class SandboxConnectionInvalidError extends Error {},
  SandboxConnectionMissingError: class SandboxConnectionMissingError extends Error {},
}));

import { DELETE, GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocked.createSupabaseAdminClient.mockReturnValue({});
  mocked.createSupabaseServerClient.mockResolvedValue({});
  mocked.deleteCodexDeviceAuthFlow.mockResolvedValue(true);
  mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-123" });
  mocked.loadRequiredWorkspaceSandboxConnection.mockResolvedValue({
    connection: sandboxConnection,
    provider: "e2b",
  });
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      workspace: { id: "workspace-123" },
    },
    ok: true,
  });
  mocked.resolveAuthenticatedSettingsPath.mockResolvedValue("/settings/integrations");
});

describe("GET /auth/callback/codex", () => {
  it("returns pending device-flow status for JSON polling", async () => {
    mocked.getCodexDeviceAuthFlowSnapshot.mockResolvedValue({
      error: null,
      expiresAt: "2026-05-19T00:10:00.000Z",
      flowId: "flow-1",
      instructions: null,
      status: "prompted",
      userCode: "ABCD-EFGH",
      verificationUri: "https://chatgpt.com/activate",
    });

    const response = await GET(
      new NextRequest("http://localhost/auth/callback/codex?flowId=flow-1", {
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      flowId: "flow-1",
      status: "prompted",
      userCode: "ABCD-EFGH",
    });
    expect(mocked.consumeAuthenticatedCodexDeviceAuthFlow).not.toHaveBeenCalled();
  });

  it("polls device auth with the active workspace sandbox connection", async () => {
    mocked.getCodexDeviceAuthFlowSnapshot.mockResolvedValue({
      error: null,
      expiresAt: "2026-05-19T00:10:00.000Z",
      flowId: "flow-1",
      instructions: null,
      status: "prompted",
      userCode: "ABCD-EFGH",
      verificationUri: "https://chatgpt.com/activate",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/auth/callback/codex?flowId=flow-1&workspaceId=workspace-123",
        {
          headers: { accept: "application/json" },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith("workspace-123");
    expect(mocked.loadRequiredWorkspaceSandboxConnection).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-123",
    );
    expect(mocked.getCodexDeviceAuthFlowSnapshot).toHaveBeenCalledWith({
      connection: sandboxConnection,
      flowId: "flow-1",
      userId: "user-123",
    });
  });

  it("persists authenticated ChatGPT auth JSON and does not return the secret", async () => {
    mocked.getCodexDeviceAuthFlowSnapshot.mockResolvedValue({
      error: null,
      expiresAt: "2026-05-19T00:10:00.000Z",
      flowId: "flow-1",
      instructions: null,
      status: "authenticated",
      userCode: "ABCD-EFGH",
      verificationUri: "https://chatgpt.com/activate",
    });
    mocked.consumeAuthenticatedCodexDeviceAuthFlow.mockResolvedValue({
      authJson: '{"auth_mode":"chatgpt"}',
      metadata: {
        accountEmail: "person@example.com",
        accountId: "acct-1",
        lastRefresh: "2026-05-19T00:00:00.000Z",
      },
      snapshot: {},
    });
    const single = vi.fn().mockResolvedValue({
      data: {
        account_email: "person@example.com",
        auth_cache_last_refresh: "2026-05-19T00:00:00.000Z",
        credential_type: "chatgpt_auth_json",
        updated_at: "2026-05-19T00:01:00.000Z",
      },
      error: null,
    });
    const upsert = vi.fn(() => ({ select: () => ({ single }) }));
    mocked.createSupabaseAdminClient.mockReturnValue({ from: () => ({ upsert }) });

    const response = await GET(
      new NextRequest("http://localhost/auth/callback/codex?flowId=flow-1", {
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        account_email: "person@example.com",
        account_id: "acct-1",
        auth_cache_last_refresh: "2026-05-19T00:00:00.000Z",
        credential_type: "chatgpt_auth_json",
        encrypted_credential: 'encrypted:{"auth_mode":"chatgpt"}',
        user_id: "user-123",
      }),
      { onConflict: "user_id" },
    );
    expect(mocked.deleteCodexDeviceAuthFlow).toHaveBeenCalledWith({
      flowId: "flow-1",
      userId: "user-123",
    });
    expect(JSON.stringify(await response.json())).not.toContain("auth_mode");
  });

  it("keeps the completed auth flow when credential persistence fails", async () => {
    mocked.getCodexDeviceAuthFlowSnapshot.mockResolvedValue({
      error: null,
      expiresAt: "2026-05-19T00:10:00.000Z",
      flowId: "flow-1",
      instructions: null,
      status: "authenticated",
      userCode: "ABCD-EFGH",
      verificationUri: "https://chatgpt.com/activate",
    });
    mocked.consumeAuthenticatedCodexDeviceAuthFlow.mockResolvedValue({
      authJson: '{"auth_mode":"chatgpt"}',
      metadata: {
        accountEmail: "person@example.com",
        accountId: "acct-1",
        lastRefresh: "2026-05-19T00:00:00.000Z",
      },
      snapshot: {},
    });
    const single = vi.fn().mockResolvedValue({
      data: null,
      error: new Error("permission denied"),
    });
    const upsert = vi.fn(() => ({ select: () => ({ single }) }));
    mocked.createSupabaseAdminClient.mockReturnValue({ from: () => ({ upsert }) });

    const response = await GET(
      new NextRequest("http://localhost/auth/callback/codex?flowId=flow-1", {
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ status: "persist_failed" });
    expect(mocked.deleteCodexDeviceAuthFlow).not.toHaveBeenCalled();
  });

  it("returns state_invalid for missing flows", async () => {
    mocked.getCodexDeviceAuthFlowSnapshot.mockResolvedValue(null);

    const response = await GET(
      new NextRequest("http://localhost/auth/callback/codex?flowId=missing", {
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ status: "state_invalid" });
  });
});

describe("DELETE /auth/callback/codex", () => {
  it("cancels a device-code flow", async () => {
    mocked.cancelCodexDeviceAuthFlow.mockResolvedValue(true);

    const response = await DELETE(
      new NextRequest("http://localhost/auth/callback/codex?flowId=flow-1"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ canceled: true });
    expect(mocked.cancelCodexDeviceAuthFlow).toHaveBeenCalledWith({
      flowId: "flow-1",
      userId: "user-123",
    });
  });

  it("cancels device auth with the active workspace sandbox connection", async () => {
    mocked.cancelCodexDeviceAuthFlow.mockResolvedValue(true);

    const response = await DELETE(
      new NextRequest(
        "http://localhost/auth/callback/codex?flowId=flow-1&workspaceId=workspace-123",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocked.cancelCodexDeviceAuthFlow).toHaveBeenCalledWith({
      connection: sandboxConnection,
      flowId: "flow-1",
      userId: "user-123",
    });
  });
});
