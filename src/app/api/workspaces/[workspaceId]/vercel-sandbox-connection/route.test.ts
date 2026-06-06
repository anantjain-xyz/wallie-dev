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

vi.mock("@/lib/vercel-sandbox/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/vercel-sandbox/server")>(
    "@/lib/vercel-sandbox/server",
  );

  return {
    ...actual,
    loadVercelSandboxConnection: mocked.loadVercelSandboxConnection,
    loadVercelSandboxConnectionPreview: mocked.loadVercelSandboxConnectionPreview,
    saveVercelSandboxConnection: mocked.saveVercelSandboxConnection,
    validateVercelSandboxCredentials: mocked.validateVercelSandboxCredentials,
  };
});

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

function adminMock(
  options: {
    activeCheck?: boolean;
    activeJob?: boolean;
    activeJobIds?: string[];
    activeRun?: boolean;
    mutationLockBusy?: boolean;
    sandboxCheckRows?: SandboxCheckRow[];
    sandboxRunRows?: SandboxRunRow[];
  } = {},
) {
  const deletedWorkspaceIds: string[] = [];
  const mutationLockWorkspaceIds: string[] = [];
  const releasedMutationLockWorkspaceIds: string[] = [];
  const mock = {
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

      if (table === "agent_jobs") {
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
                data: options.activeJob ? { id: "job-1" } : null,
                error: null,
              }),
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
              limit: () => builder,
              maybeSingle: async () => ({
                data: options.activeCheck ? { id: "check-1" } : null,
                error: null,
              }),
              then: (resolve: (value: { data: SandboxCheckRow[]; error: null }) => void) => {
                const sandboxIds = filters.get("sandbox_id");
                const rows = (options.sandboxCheckRows ?? [])
                  .map((row) => ({
                    checked_at: new Date().toISOString(),
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
            eq: async (_column: string, value: string) => {
              deletedWorkspaceIds.push(value);
              return { error: null };
            },
          }),
        };
      }

      if (table === "workspace_vercel_sandbox_connection_mutations") {
        return {
          delete: () => {
            const filters = new Map<string, unknown>();
            const builder = {
              eq: (column: string, value: string) => {
                filters.set(column, value);
                if (column === "lock_id") {
                  releasedMutationLockWorkspaceIds.push(String(filters.get("workspace_id")));
                  return Promise.resolve({ error: null });
                }
                return builder;
              },
            };
            return builder;
          },
        };
      }

      throw new Error(`unexpected table: ${table}`);
    }),
    deletedWorkspaceIds,
    mutationLockWorkspaceIds,
    releasedMutationLockWorkspaceIds,
    rpc: vi.fn(async (fn: string, args: { target_workspace_id: string }) => {
      if (fn !== "begin_vercel_sandbox_connection_mutation") {
        throw new Error(`unexpected rpc: ${fn}`);
      }
      if (options.mutationLockBusy) {
        return { data: "locked", error: null };
      }
      if (options.activeRun || options.activeJob || options.activeCheck) {
        return { data: "active", error: null };
      }
      mutationLockWorkspaceIds.push(args.target_workspace_id);
      return { data: "33333333-3333-4333-8333-333333333333", error: null };
    }),
  };
  return mock;
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
    const admin = adminMock();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(admin);

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
    expect(admin.mutationLockWorkspaceIds).toEqual([workspaceId]);
    expect(admin.releasedMutationLockWorkspaceIds).toEqual([workspaceId]);
  });

  it("cleans old project sandboxes before saving a changed Vercel project", async () => {
    mockAccess();
    const oldCredentials = {
      projectId: "prj_old",
      teamId: "team_old",
      token: "vca_old",
    };
    const nextCredentials = {
      projectId: "prj_next",
      teamId: "team_next",
      token: "vca_next",
    };
    mocked.loadVercelSandboxConnection.mockResolvedValueOnce({
      credentials: oldCredentials,
      preview: {
        ...preview,
        projectId: oldCredentials.projectId,
        teamId: oldCredentials.teamId,
      },
    });
    mocked.createSupabaseAdminClient.mockReturnValueOnce(
      adminMock({
        sandboxRunRows: [
          {
            sandbox_id: "old-terminal",
            sandbox_vercel_project_id: oldCredentials.projectId,
            sandbox_vercel_team_id: oldCredentials.teamId,
            status: "error",
            workspace_id: workspaceId,
          },
        ],
      }),
    );
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { createdAt: Date.now() - 60_000, id: "old-terminal", status: "running" },
    ]);

    const response = await PUT(jsonRequest("PUT", nextCredentials), routeContext());

    expect(response.status).toBe(200);
    expect(mocked.listRunningSandboxes).toHaveBeenCalledWith({
      throwOnError: true,
      vercelCredentials: oldCredentials,
    });
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("old-terminal", {
      throwOnError: true,
      vercelCredentials: oldCredentials,
    });
    expect(mocked.saveVercelSandboxConnection).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: nextCredentials }),
    );
  });

  it("keeps the old connection when changed-project cleanup fails before save", async () => {
    mockAccess();
    const oldCredentials = {
      projectId: "prj_old",
      teamId: "team_old",
      token: "vca_old",
    };
    const nextCredentials = {
      projectId: "prj_next",
      teamId: "team_next",
      token: "vca_next",
    };
    mocked.loadVercelSandboxConnection.mockResolvedValueOnce({
      credentials: oldCredentials,
      preview: {
        ...preview,
        projectId: oldCredentials.projectId,
        teamId: oldCredentials.teamId,
      },
    });
    mocked.listRunningSandboxes.mockRejectedValueOnce(new Error("old Vercel list failed"));

    await expect(PUT(jsonRequest("PUT", nextCredentials), routeContext())).rejects.toThrow(
      "old Vercel list failed",
    );

    expect(mocked.saveVercelSandboxConnection).not.toHaveBeenCalled();
  });

  it("blocks connection updates while runs are active", async () => {
    mockAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(adminMock({ activeRun: true }));

    const response = await PUT(jsonRequest("PUT", credentials), routeContext());

    expect(response.status).toBe(409);
    expect(mocked.validateVercelSandboxCredentials).not.toHaveBeenCalled();
    expect(mocked.saveVercelSandboxConnection).not.toHaveBeenCalled();
  });

  it("blocks connection updates while capability checks are active", async () => {
    mockAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(adminMock({ activeCheck: true }));

    const response = await PUT(jsonRequest("PUT", credentials), routeContext());

    expect(response.status).toBe(409);
    expect(mocked.validateVercelSandboxCredentials).not.toHaveBeenCalled();
    expect(mocked.saveVercelSandboxConnection).not.toHaveBeenCalled();
  });

  it("blocks connection updates while another connection change holds the workspace lock", async () => {
    mockAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(adminMock({ mutationLockBusy: true }));

    const response = await PUT(jsonRequest("PUT", credentials), routeContext());

    await expect(response.json()).resolves.toEqual({
      error: "Vercel Sandbox connection update is already in progress. Try again shortly.",
    });
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

  it("blocks disconnect while capability checks are active", async () => {
    mockAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(adminMock({ activeCheck: true }));

    const response = await DELETE(new Request("http://localhost"), routeContext());

    expect(response.status).toBe(409);
    expect(mocked.loadVercelSandboxConnection).not.toHaveBeenCalled();
  });

  it("blocks disconnect while jobs are active", async () => {
    mockAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(adminMock({ activeJob: true }));

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
    expect(mocked.listRunningSandboxes).toHaveBeenCalledWith({
      throwOnError: true,
      vercelCredentials: credentials,
    });
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sandbox-1", {
      throwOnError: true,
      vercelCredentials: credentials,
    });
  });

  it("does not stop unknown or active shared-project sandboxes on disconnect", async () => {
    mockAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(
      adminMock({
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
        sandboxCheckRows: [
          {
            sandbox_id: "capability-terminal",
            status: "error",
            workspace_id: workspaceId,
          },
          {
            sandbox_id: "capability-running",
            status: "running",
            workspace_id: workspaceId,
          },
          {
            checked_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
            sandbox_id: "capability-stale",
            status: "running",
            workspace_id: workspaceId,
          },
        ],
        activeJobIds: ["job-post-run"],
      }),
    );
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { createdAt: Date.now() - 60_000, id: "owned-terminal", status: "running" },
      { createdAt: Date.now() - 60_000, id: "owned-but-active-elsewhere", status: "running" },
      { createdAt: Date.now() - 60_000, id: "owned-post-run", status: "running" },
      { createdAt: Date.now() - 60_000, id: "capability-terminal", status: "running" },
      { createdAt: Date.now() - 60_000, id: "capability-running", status: "running" },
      { createdAt: Date.now() - 60_000, id: "capability-stale", status: "running" },
      { createdAt: Date.now() - 60_000, id: "other-active", status: "running" },
      { createdAt: Date.now() - 60_000, id: "unknown", status: "running" },
    ]);

    const response = await DELETE(new Request("http://localhost"), routeContext());

    await expect(response.json()).resolves.toEqual({ connection: null });
    expect(response.status).toBe(200);
    expect(mocked.stopSandboxById).toHaveBeenCalledTimes(3);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("owned-terminal", {
      throwOnError: true,
      vercelCredentials: credentials,
    });
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("capability-terminal", {
      throwOnError: true,
      vercelCredentials: credentials,
    });
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("capability-stale", {
      throwOnError: true,
      vercelCredentials: credentials,
    });
  });

  it("keeps the connection row when provider cleanup fails", async () => {
    mockAccess();
    const admin = adminMock();
    mocked.createSupabaseAdminClient.mockReturnValueOnce(admin);
    mocked.listRunningSandboxes.mockRejectedValueOnce(new Error("Vercel list failed"));

    await expect(DELETE(new Request("http://localhost"), routeContext())).rejects.toThrow(
      "Vercel list failed",
    );

    expect(mocked.listRunningSandboxes).toHaveBeenCalledWith({
      throwOnError: true,
      vercelCredentials: credentials,
    });
    expect(admin.deletedWorkspaceIds).toEqual([]);
    expect(admin.releasedMutationLockWorkspaceIds).toEqual([workspaceId]);
  });
});
