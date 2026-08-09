import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  acquireSandboxConnectionMutationLock: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  listRunningSandboxes: vi.fn(),
  loadWorkspaceSandboxConnection: vi.fn(),
  loadWorkspaceSandboxOverview: vi.fn(),
  loadWorkspaceSandboxSettings: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  saveDaytonaSandboxConnection: vi.fn(),
  saveVercelSandboxConnection: vi.fn(),
  stopSandboxById: vi.fn(),
  stopWorkspaceOwnedSandboxes: vi.fn(),
  validateDaytonaSandboxCredentials: vi.fn(),
  validateE2BSandboxCredentials: vi.fn(),
  validateVercelSandboxCredentials: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/sandbox", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sandbox")>("@/lib/sandbox");
  return {
    ...actual,
    listRunningSandboxes: mocked.listRunningSandboxes,
    stopSandboxById: mocked.stopSandboxById,
  };
});

vi.mock("@/lib/sandbox-connections/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sandbox-connections/server")>(
    "@/lib/sandbox-connections/server",
  );
  return {
    ...actual,
    acquireSandboxConnectionMutationLock: mocked.acquireSandboxConnectionMutationLock,
    loadWorkspaceSandboxConnection: mocked.loadWorkspaceSandboxConnection,
    loadWorkspaceSandboxOverview: mocked.loadWorkspaceSandboxOverview,
    loadWorkspaceSandboxSettings: mocked.loadWorkspaceSandboxSettings,
    saveDaytonaSandboxConnection: mocked.saveDaytonaSandboxConnection,
    stopWorkspaceOwnedSandboxes: mocked.stopWorkspaceOwnedSandboxes,
    validateDaytonaSandboxCredentials: mocked.validateDaytonaSandboxCredentials,
    validateE2BSandboxCredentials: mocked.validateE2BSandboxCredentials,
    validateVercelSandboxCredentials: mocked.validateVercelSandboxCredentials,
  };
});

vi.mock("@/lib/vercel-sandbox/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/vercel-sandbox/server")>(
    "@/lib/vercel-sandbox/server",
  );
  return {
    ...actual,
    saveVercelSandboxConnection: mocked.saveVercelSandboxConnection,
  };
});

import {
  SandboxConnectionActiveWorkError,
  SandboxConnectionInvalidError,
  SandboxConnectionMutationInProgressError,
} from "@/lib/sandbox-connections/server";
import { DELETE, GET, PUT } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const connection = {
  credentials: { projectId: "project-1", teamId: "team-1", token: "secret" },
  provider: "vercel" as const,
  revision: "revision-1",
};
const vercelPreview = {
  connectionRevision: "revision-2",
  lastValidatedAt: "2026-07-28T00:00:00.000Z",
  lastValidationError: null,
  projectId: connection.credentials.projectId,
  projectName: "wallie-sandboxes",
  status: "connected" as const,
  teamId: connection.credentials.teamId,
  tokenPreview: "secr…cret",
  updatedAt: "2026-07-28T00:00:00.000Z",
  workspaceId,
};

type SandboxRunRow = {
  agent_job_id?: string | null;
  sandbox_id: string | null;
  sandbox_provider?: string | null;
  sandbox_vercel_project_id?: string | null;
  sandbox_vercel_team_id?: string | null;
  status: string;
  workspace_id: string;
};

type SandboxCheckRow = {
  checked_at?: string;
  sandbox_id: string | null;
  sandbox_provider?: string | null;
  sandbox_vercel_project_id?: string | null;
  sandbox_vercel_team_id?: string | null;
  status: string;
  workspace_id: string;
};

function context(provider: string) {
  return { params: Promise.resolve({ provider, workspaceId }) };
}

function jsonRequest(provider: string, method: "PUT", body: unknown) {
  return new Request(
    `http://localhost/api/workspaces/${workspaceId}/sandbox-connections/${provider}`,
    {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method,
    },
  );
}

function mockAccess(ok = true) {
  mocked.requireWorkspaceAccessById.mockResolvedValue(
    ok
      ? {
          context: {
            currentMember: { id: memberId, role: "owner" },
            workspace: { id: workspaceId },
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

function adminMock(
  options: {
    activeJobIds?: string[];
    sandboxCheckRows?: SandboxCheckRow[];
    sandboxRunRows?: SandboxRunRow[];
  } = {},
) {
  const deletedTables: string[] = [];
  const deletedWorkspaceIds: string[] = [];
  const admin = {
    deletedTables,
    deletedWorkspaceIds,
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
              then: (resolve: (value: { data: SandboxRunRow[]; error: null }) => void) => {
                const sandboxIds = filters.get("sandbox_id");
                const rows = (options.sandboxRunRows ?? [])
                  .map((row) => ({
                    sandbox_provider: "vercel",
                    sandbox_vercel_project_id: connection.credentials.projectId,
                    sandbox_vercel_team_id: connection.credentials.teamId,
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

      if (table === "sandbox_capability_checks") {
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
              then: (resolve: (value: { data: SandboxCheckRow[]; error: null }) => void) => {
                const sandboxIds = filters.get("sandbox_id");
                const rows = (options.sandboxCheckRows ?? [])
                  .map((row) => ({
                    checked_at: new Date().toISOString(),
                    sandbox_provider: "vercel",
                    sandbox_vercel_project_id: connection.credentials.projectId,
                    sandbox_vercel_team_id: connection.credentials.teamId,
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

      if (table === "agent_jobs") {
        return {
          select: () => {
            const filters = new Map<string, unknown>();
            const builder = {
              in: (column: string, value: unknown) => {
                filters.set(column, value);
                return builder;
              },
              then: (resolve: (value: { data: Array<{ id: string }>; error: null }) => void) => {
                const jobIds = filters.get("id");
                const activeJobIds = new Set(options.activeJobIds ?? []);
                resolve({
                  data: Array.isArray(jobIds)
                    ? jobIds
                        .filter((jobId): jobId is string => activeJobIds.has(String(jobId)))
                        .map((id) => ({ id }))
                    : [],
                  error: null,
                });
              },
            };
            return builder;
          },
        };
      }

      return {
        delete: () => ({
          eq: async (_column: string, value: string) => {
            deletedTables.push(table);
            deletedWorkspaceIds.push(value);
            return { error: null };
          },
        }),
      };
    }),
  };
  return admin;
}

let releaseMutationLock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  const admin = adminMock();
  mocked.createSupabaseAdminClient.mockReturnValue(admin);
  releaseMutationLock = vi.fn().mockResolvedValue(undefined);
  mocked.acquireSandboxConnectionMutationLock.mockResolvedValue(releaseMutationLock);
  mockAccess();
  mocked.loadWorkspaceSandboxConnection.mockResolvedValue({ connection, preview: vercelPreview });
  mocked.loadWorkspaceSandboxOverview.mockResolvedValue({
    activeProvider: "e2b",
    connections: { daytona: null, e2b: null, vercel: vercelPreview },
    enabledProviders: ["vercel", "e2b", "daytona"],
    revision: 2,
    updatedAt: null,
  });
  mocked.loadWorkspaceSandboxSettings.mockResolvedValue({
    activeProvider: "e2b",
    revision: 2,
    updatedAt: null,
  });
  mocked.listRunningSandboxes.mockResolvedValue([]);
  mocked.stopSandboxById.mockResolvedValue(undefined);
  mocked.validateDaytonaSandboxCredentials.mockResolvedValue({
    credentials: {
      apiKey: "daytona-secret",
      apiUrl: "https://app.daytona.io/api",
    },
    ok: true,
  });
  mocked.validateE2BSandboxCredentials.mockResolvedValue({ ok: true });
  mocked.validateVercelSandboxCredentials.mockResolvedValue({
    ok: true,
    projectName: vercelPreview.projectName,
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
  mocked.saveVercelSandboxConnection.mockResolvedValue(vercelPreview);
});

describe("/api/workspaces/[workspaceId]/sandbox-connections/[provider]", () => {
  it("returns preview-only Vercel connection data", async () => {
    const response = await GET(new Request("http://localhost"), context("vercel"));

    await expect(response.json()).resolves.toEqual({ connection: vercelPreview });
    expect(response.status).toBe(200);
    expect(mocked.loadWorkspaceSandboxOverview).toHaveBeenCalledWith(
      expect.anything(),
      workspaceId,
    );
  });

  it("requires manager access to save a Vercel connection", async () => {
    mockAccess(false);

    const response = await PUT(
      jsonRequest("vercel", "PUT", connection.credentials),
      context("vercel"),
    );

    expect(response.status).toBe(403);
    expect(mocked.acquireSandboxConnectionMutationLock).not.toHaveBeenCalled();
    expect(mocked.validateVercelSandboxCredentials).not.toHaveBeenCalled();
  });

  it("rejects invalid Vercel save payloads", async () => {
    const response = await PUT(jsonRequest("vercel", "PUT", { token: "" }), context("vercel"));

    expect(response.status).toBe(400);
    expect(mocked.validateVercelSandboxCredentials).not.toHaveBeenCalled();
    expect(mocked.saveVercelSandboxConnection).not.toHaveBeenCalled();
    expect(releaseMutationLock).toHaveBeenCalledOnce();
  });

  it("returns Vercel validation failures without saving", async () => {
    mocked.validateVercelSandboxCredentials.mockResolvedValueOnce({
      error: "Vercel rejected the token.",
      ok: false,
    });

    const response = await PUT(
      jsonRequest("vercel", "PUT", connection.credentials),
      context("vercel"),
    );

    await expect(response.json()).resolves.toEqual({ error: "Vercel rejected the token." });
    expect(response.status).toBe(400);
    expect(mocked.saveVercelSandboxConnection).not.toHaveBeenCalled();
  });

  it("returns the canonical Vercel validation deadline without saving", async () => {
    const deadline =
      "Vercel Sandbox validate exceeded its 15000ms provider-contract deadline (semantic owner: bounded provider remote operations).";
    mocked.validateVercelSandboxCredentials.mockResolvedValueOnce({ error: deadline, ok: false });

    const response = await PUT(
      jsonRequest("vercel", "PUT", connection.credentials),
      context("vercel"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: deadline });
    expect(mocked.saveVercelSandboxConnection).not.toHaveBeenCalled();
  });

  it("validates and saves a Vercel connection under the provider-neutral lock", async () => {
    const admin = adminMock();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(admin);

    const response = await PUT(
      jsonRequest("vercel", "PUT", connection.credentials),
      context("vercel"),
    );

    await expect(response.json()).resolves.toEqual({ connection: vercelPreview });
    expect(response.status).toBe(200);
    expect(mocked.acquireSandboxConnectionMutationLock).toHaveBeenCalledWith(
      admin,
      workspaceId,
      "vercel",
    );
    expect(mocked.validateVercelSandboxCredentials).toHaveBeenCalledWith(connection.credentials);
    expect(mocked.saveVercelSandboxConnection).toHaveBeenCalledWith({
      admin,
      credentials: connection.credentials,
      createdByMemberId: memberId,
      projectName: vercelPreview.projectName,
      workspaceId,
    });
    expect(releaseMutationLock).toHaveBeenCalledOnce();
  });

  it("cleans previous Vercel project sandboxes before rotating a connection", async () => {
    const admin = adminMock({
      sandboxRunRows: [{ sandbox_id: "old-terminal", status: "error", workspace_id: workspaceId }],
    });
    mocked.createSupabaseAdminClient.mockReturnValueOnce(admin);
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { createdAt: Date.now() - 60_000, id: "old-terminal", status: "running" },
    ]);
    const nextCredentials = { projectId: "project-2", teamId: "team-2", token: "next-secret" };

    const response = await PUT(jsonRequest("vercel", "PUT", nextCredentials), context("vercel"));

    expect(response.status).toBe(200);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("old-terminal", {
      connection,
      throwOnError: true,
    });
    expect(mocked.stopSandboxById.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.saveVercelSandboxConnection.mock.invocationCallOrder[0]!,
    );
    expect(mocked.saveVercelSandboxConnection).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: nextCredentials }),
    );
  });

  it("keeps the old Vercel connection when rotation cleanup fails", async () => {
    mocked.listRunningSandboxes.mockRejectedValueOnce(new Error("old Vercel list failed"));

    await expect(
      PUT(jsonRequest("vercel", "PUT", connection.credentials), context("vercel")),
    ).rejects.toThrow("old Vercel list failed");

    expect(mocked.saveVercelSandboxConnection).not.toHaveBeenCalled();
    expect(releaseMutationLock).toHaveBeenCalledOnce();
  });

  it.each(["runs", "capability checks"])("blocks Vercel updates while %s are active", async () => {
    mocked.acquireSandboxConnectionMutationLock.mockRejectedValueOnce(
      new SandboxConnectionActiveWorkError(),
    );

    const response = await PUT(
      jsonRequest("vercel", "PUT", connection.credentials),
      context("vercel"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Cannot change this sandbox connection while related Wallie work is active.",
    });
    expect(mocked.validateVercelSandboxCredentials).not.toHaveBeenCalled();
    expect(mocked.saveVercelSandboxConnection).not.toHaveBeenCalled();
  });

  it("blocks Vercel updates while another connection mutation holds the lock", async () => {
    mocked.acquireSandboxConnectionMutationLock.mockRejectedValueOnce(
      new SandboxConnectionMutationInProgressError(),
    );

    const response = await PUT(
      jsonRequest("vercel", "PUT", connection.credentials),
      context("vercel"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Sandbox connection update is already in progress. Try again shortly.",
    });
    expect(mocked.validateVercelSandboxCredentials).not.toHaveBeenCalled();
  });

  it.each(["runs", "capability checks", "jobs"])(
    "blocks Vercel disconnect while %s are active",
    async () => {
      mocked.acquireSandboxConnectionMutationLock.mockRejectedValueOnce(
        new SandboxConnectionActiveWorkError(),
      );

      const response = await DELETE(new Request("http://localhost"), context("vercel"));

      expect(response.status).toBe(409);
      expect(mocked.loadWorkspaceSandboxConnection).not.toHaveBeenCalled();
    },
  );

  it("blocks disconnect while Vercel is the active provider", async () => {
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
    expect(releaseMutationLock).toHaveBeenCalledOnce();
  });

  it("stops owned project sandboxes before disconnecting Vercel", async () => {
    const admin = adminMock({
      sandboxRunRows: [{ sandbox_id: "sandbox-1", status: "error", workspace_id: workspaceId }],
    });
    mocked.createSupabaseAdminClient.mockReturnValueOnce(admin);
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { createdAt: Date.now() - 60_000, id: "sandbox-1", status: "running" },
    ]);

    const response = await DELETE(new Request("http://localhost"), context("vercel"));

    await expect(response.json()).resolves.toEqual({ connection: null });
    expect(response.status).toBe(200);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sandbox-1", {
      connection,
      throwOnError: true,
    });
    expect(admin.deletedTables).toEqual(["workspace_vercel_sandbox_connections"]);
    expect(admin.deletedWorkspaceIds).toEqual([workspaceId]);
    expect(mocked.stopSandboxById.mock.invocationCallOrder[0]).toBeLessThan(
      admin.from.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("does not stop unknown or active shared-project sandboxes on disconnect", async () => {
    const admin = adminMock({
      activeJobIds: ["job-post-run"],
      sandboxCheckRows: [
        { sandbox_id: "capability-terminal", status: "error", workspace_id: workspaceId },
        { sandbox_id: "capability-running", status: "running", workspace_id: workspaceId },
        {
          checked_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
          sandbox_id: "capability-stale",
          status: "running",
          workspace_id: workspaceId,
        },
      ],
      sandboxRunRows: [
        {
          agent_job_id: "job-terminal",
          sandbox_id: "owned-terminal",
          status: "error",
          workspace_id: workspaceId,
        },
        {
          agent_job_id: "job-finished-here-active-elsewhere",
          sandbox_id: "owned-but-active-elsewhere",
          status: "error",
          workspace_id: workspaceId,
        },
        {
          agent_job_id: "job-active-elsewhere",
          sandbox_id: "owned-but-active-elsewhere",
          status: "running",
          workspace_id: "33333333-3333-4333-8333-333333333333",
        },
        {
          agent_job_id: "job-other-active",
          sandbox_id: "other-active",
          status: "running",
          workspace_id: "33333333-3333-4333-8333-333333333333",
        },
        {
          agent_job_id: "job-post-run",
          sandbox_id: "owned-post-run",
          status: "success",
          workspace_id: workspaceId,
        },
      ],
    });
    mocked.createSupabaseAdminClient.mockReturnValueOnce(admin);
    mocked.listRunningSandboxes.mockResolvedValueOnce(
      [
        "owned-terminal",
        "owned-but-active-elsewhere",
        "owned-post-run",
        "capability-terminal",
        "capability-running",
        "capability-stale",
        "other-active",
        "unknown",
      ].map((id) => ({ createdAt: Date.now() - 60_000, id, status: "running" })),
    );

    const response = await DELETE(new Request("http://localhost"), context("vercel"));

    expect(response.status).toBe(200);
    expect(mocked.stopSandboxById).toHaveBeenCalledTimes(3);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("owned-terminal", {
      connection,
      throwOnError: true,
    });
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("capability-terminal", {
      connection,
      throwOnError: true,
    });
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("capability-stale", {
      connection,
      throwOnError: true,
    });
  });

  it("keeps the Vercel connection row when disconnect cleanup fails", async () => {
    const admin = adminMock();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(admin);
    mocked.listRunningSandboxes.mockRejectedValueOnce(new Error("Vercel list failed"));

    await expect(DELETE(new Request("http://localhost"), context("vercel"))).rejects.toThrow(
      "Vercel list failed",
    );

    expect(admin.deletedTables).toEqual([]);
    expect(releaseMutationLock).toHaveBeenCalledOnce();
  });

  it("returns an E2B validation timeout as an invalid-connection response", async () => {
    mocked.validateE2BSandboxCredentials.mockResolvedValueOnce({
      error:
        "E2B validate exceeded its 15000ms provider-contract deadline (semantic owner: bounded provider remote operations).",
      ok: false,
    });

    const response = await PUT(jsonRequest("e2b", "PUT", { apiKey: "e2b-secret" }), context("e2b"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "E2B validate exceeded its 15000ms provider-contract deadline (semantic owner: bounded provider remote operations).",
    });
    expect(mocked.stopWorkspaceOwnedSandboxes).not.toHaveBeenCalled();
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
      jsonRequest("daytona", "PUT", {
        apiKey: "daytona-secret",
        apiUrl: "https://app.daytona.io/api",
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
    const admin = adminMock();
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
    expect(admin.deletedTables).toEqual(["workspace_daytona_sandbox_connections"]);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });
});
