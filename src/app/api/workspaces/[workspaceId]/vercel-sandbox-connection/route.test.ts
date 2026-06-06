import { describe, expect, it, vi, beforeEach } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  loadVercelSandboxConnection: vi.fn(),
  loadVercelSandboxConnectionPreview: vi.fn(),
  listRunningSandboxes: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  saveVercelSandboxConnection: vi.fn(),
  stopSandboxById: vi.fn(),
  validateVercelSandboxCredentials: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/vercel-sandbox/server", () => ({
  loadVercelSandboxConnection: mocked.loadVercelSandboxConnection,
  loadVercelSandboxConnectionPreview: mocked.loadVercelSandboxConnectionPreview,
  saveVercelSandboxConnection: mocked.saveVercelSandboxConnection,
  validateVercelSandboxCredentials: mocked.validateVercelSandboxCredentials,
}));

vi.mock("@/lib/sandbox", () => ({
  listRunningSandboxes: mocked.listRunningSandboxes,
  stopSandboxById: mocked.stopSandboxById,
}));

import { DELETE, GET, PUT } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const preview = {
  lastValidatedAt: "2026-06-06T18:00:00.000Z",
  lastValidationError: null,
  projectId: "prj_123",
  projectName: "wallie-sandboxes",
  status: "connected" as const,
  teamId: "team_123",
  tokenPreview: "vca_...123",
  updatedAt: "2026-06-06T18:00:00.000Z",
  workspaceId,
};
const credentials = {
  projectId: "prj_123",
  teamId: "team_123",
  token: "vca_secret",
};

function routeContext() {
  return { params: Promise.resolve({ workspaceId }) };
}

function jsonRequest(method: string, body: unknown) {
  return new Request(`http://localhost/api/workspaces/${workspaceId}/vercel-sandbox-connection`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

function mockAccess(ok = true) {
  mocked.requireWorkspaceAccessById.mockResolvedValue(
    ok
      ? {
          context: {
            currentMember: { id: memberId, kind: "human", role: "owner" },
            user: { id: "user-1" },
            workspace: { id: workspaceId, name: "Acme", slug: "acme" },
          },
          ok: true,
        }
      : {
          error: "Workspace admin access is required for this action.",
          ok: false,
          status: 403,
        },
  );
}

type SandboxRunRow = {
  sandbox_id: string | null;
  sandbox_provider?: string | null;
  sandbox_vercel_project_id?: string | null;
  sandbox_vercel_team_id?: string | null;
  status: string;
  workspace_id: string;
};

function adminMock(options: { activeRun?: boolean; sandboxRunRows?: SandboxRunRow[] } = {}) {
  return {
    from: vi.fn((table: string) => {
      if (table === "agent_runs") {
        return {
          select: () => {
            const filters = new Map<string, unknown>();
            const builder = {
              eq: (column: string, value: unknown) => {
                filters.set(column, value);
                return builder;
              },
              in: (column: string, value: unknown) => {
                filters.set(column, value);
                return builder;
              },
              limit: () => builder,
              maybeSingle: async () => ({
                data: options.activeRun ? { id: "run-1" } : null,
                error: null,
              }),
              then: (resolve: (value: { data: SandboxRunRow[]; error: null }) => void) => {
                const sandboxIds = filters.get("sandbox_id");
                const rows = (options.sandboxRunRows ?? [])
                  .map((row) => ({
                    sandbox_provider: "vercel",
                    sandbox_vercel_project_id: credentials.projectId,
                    sandbox_vercel_team_id: credentials.teamId,
                    ...row,
                  }))
                  .filter(
                    (row) =>
                      row.sandbox_provider === filters.get("sandbox_provider") &&
                      row.sandbox_vercel_team_id === filters.get("sandbox_vercel_team_id") &&
                      row.sandbox_vercel_project_id === filters.get("sandbox_vercel_project_id") &&
                      (Array.isArray(sandboxIds) ? sandboxIds.includes(row.sandbox_id) : true),
                  );
                resolve({ data: rows, error: null });
              },
            };
            return builder;
          },
        };
      }

      if (table === "workspace_vercel_sandbox_connections") {
        return {
          delete: () => ({
            eq: async () => ({ error: null }),
          }),
        };
      }

      throw new Error(`unexpected table: ${table}`);
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.createSupabaseAdminClient.mockReturnValue(adminMock());
  mocked.loadVercelSandboxConnectionPreview.mockResolvedValue(preview);
  mocked.loadVercelSandboxConnection.mockResolvedValue({ credentials, preview });
  mocked.listRunningSandboxes.mockResolvedValue([]);
  mocked.stopSandboxById.mockResolvedValue(undefined);
  mocked.validateVercelSandboxCredentials.mockResolvedValue({
    ok: true,
    projectName: "wallie-sandboxes",
  });
  mocked.saveVercelSandboxConnection.mockResolvedValue(preview);
});

describe("/api/workspaces/[workspaceId]/vercel-sandbox-connection", () => {
  it("returns preview-only connection data", async () => {
    mockAccess();

    const response = await GET(new Request("http://localhost"), routeContext());

    await expect(response.json()).resolves.toEqual({ connection: preview });
    expect(response.status).toBe(200);
    expect(mocked.loadVercelSandboxConnectionPreview).toHaveBeenCalledWith(
      expect.anything(),
      workspaceId,
    );
  });

  it("requires manager access to save", async () => {
    mockAccess(false);

    const response = await PUT(jsonRequest("PUT", credentials), routeContext());

    expect(response.status).toBe(403);
    expect(mocked.validateVercelSandboxCredentials).not.toHaveBeenCalled();
  });

  it("rejects invalid save payloads", async () => {
    mockAccess();

    const response = await PUT(jsonRequest("PUT", { token: "" }), routeContext());

    expect(response.status).toBe(400);
    expect(mocked.validateVercelSandboxCredentials).not.toHaveBeenCalled();
  });

  it("returns validation failures without saving", async () => {
    mockAccess();
    mocked.validateVercelSandboxCredentials.mockResolvedValueOnce({
      error: "Vercel rejected the token.",
      ok: false,
    });

    const response = await PUT(jsonRequest("PUT", credentials), routeContext());

    await expect(response.json()).resolves.toEqual({ error: "Vercel rejected the token." });
    expect(response.status).toBe(400);
    expect(mocked.saveVercelSandboxConnection).not.toHaveBeenCalled();
  });

  it("validates and saves a Vercel connection", async () => {
    mockAccess();

    const response = await PUT(jsonRequest("PUT", credentials), routeContext());

    await expect(response.json()).resolves.toEqual({ connection: preview });
    expect(response.status).toBe(200);
    expect(mocked.saveVercelSandboxConnection).toHaveBeenCalledWith({
      admin: expect.anything(),
      credentials,
      createdByMemberId: memberId,
      projectName: "wallie-sandboxes",
      workspaceId,
    });
  });

  it("blocks connection updates while runs are active", async () => {
    mockAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(adminMock({ activeRun: true }));

    const response = await PUT(jsonRequest("PUT", credentials), routeContext());

    expect(response.status).toBe(409);
    expect(mocked.validateVercelSandboxCredentials).not.toHaveBeenCalled();
    expect(mocked.saveVercelSandboxConnection).not.toHaveBeenCalled();
  });

  it("blocks disconnect while runs are active", async () => {
    mockAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(adminMock({ activeRun: true }));

    const response = await DELETE(new Request("http://localhost"), routeContext());

    expect(response.status).toBe(409);
    expect(mocked.loadVercelSandboxConnection).not.toHaveBeenCalled();
  });

  it("stops project sandboxes before disconnecting", async () => {
    mockAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(
      adminMock({
        sandboxRunRows: [
          {
            sandbox_id: "sandbox-1",
            status: "error",
            workspace_id: workspaceId,
          },
        ],
      }),
    );
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { createdAt: Date.now() - 60_000, id: "sandbox-1", status: "running" },
    ]);

    const response = await DELETE(new Request("http://localhost"), routeContext());

    await expect(response.json()).resolves.toEqual({ connection: null });
    expect(response.status).toBe(200);
    expect(mocked.listRunningSandboxes).toHaveBeenCalledWith({ vercelCredentials: credentials });
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sandbox-1", {
      vercelCredentials: credentials,
    });
  });

  it("does not stop unknown or active shared-project sandboxes on disconnect", async () => {
    mockAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(
      adminMock({
        sandboxRunRows: [
          {
            sandbox_id: "owned-terminal",
            status: "error",
            workspace_id: workspaceId,
          },
          {
            sandbox_id: "owned-but-active-elsewhere",
            status: "error",
            workspace_id: workspaceId,
          },
          {
            sandbox_id: "owned-but-active-elsewhere",
            status: "running",
            workspace_id: "33333333-3333-4333-8333-333333333333",
          },
          {
            sandbox_id: "other-active",
            status: "running",
            workspace_id: "33333333-3333-4333-8333-333333333333",
          },
        ],
      }),
    );
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { createdAt: Date.now() - 60_000, id: "owned-terminal", status: "running" },
      { createdAt: Date.now() - 60_000, id: "owned-but-active-elsewhere", status: "running" },
      { createdAt: Date.now() - 60_000, id: "other-active", status: "running" },
      { createdAt: Date.now() - 60_000, id: "unknown", status: "running" },
    ]);

    const response = await DELETE(new Request("http://localhost"), routeContext());

    await expect(response.json()).resolves.toEqual({ connection: null });
    expect(response.status).toBe(200);
    expect(mocked.stopSandboxById).toHaveBeenCalledTimes(1);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("owned-terminal", {
      vercelCredentials: credentials,
    });
  });
});
