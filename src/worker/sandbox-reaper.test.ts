import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  stopSandboxById: vi.fn().mockResolvedValue(undefined),
  listRunningSandboxes: vi.fn(),
  loadConnectedVercelSandboxConnections: vi.fn(),
}));

vi.mock("@/lib/sandbox", () => ({
  stopSandboxById: mocked.stopSandboxById,
  listRunningSandboxes: mocked.listRunningSandboxes,
}));

vi.mock("@/lib/vercel-sandbox/server", () => ({
  loadConnectedVercelSandboxConnections: mocked.loadConnectedVercelSandboxConnections,
}));

import { reapOrphanSandboxes } from "./sandbox-reaper";

interface ClaimedRow {
  sandbox_id: string;
  sandbox_provider?: string;
  sandbox_vercel_project_id?: string;
  sandbox_vercel_team_id?: string;
  workspace_id?: string;
}

function buildAdminMock(claimed: ClaimedRow[], opts: { fail?: boolean } = {}) {
  const queries: Array<{ filters: Record<string, unknown>; ids: string[] }> = [];
  return {
    admin: {
      from: (name: string) => {
        if (name !== "agent_runs") throw new Error(`unexpected table: ${name}`);
        const filters = new Map<string, unknown>();
        const chain = {
          eq: (column: string, value: unknown) => {
            filters.set(column, value);
            return chain;
          },
          in: (col: string, ids: string[]) => {
            if (col !== "sandbox_id") {
              return chain;
            }
            return {
              in: async () => {
                queries.push({ filters: Object.fromEntries(filters), ids });
                if (opts.fail) {
                  return { data: null, error: { message: "db down" } };
                }
                return {
                  data: claimed
                    .map((row) => ({
                      sandbox_provider: "vercel",
                      sandbox_vercel_project_id: "prj_123",
                      sandbox_vercel_team_id: "team_123",
                      workspace_id: "workspace-1",
                      ...row,
                    }))
                    .filter(
                      (row) =>
                        ids.includes(row.sandbox_id) &&
                        [...filters].every(
                          ([column, value]) => row[column as keyof ClaimedRow] === value,
                        ),
                    ),
                  error: null,
                };
              },
            };
          },
        };
        return {
          select: () => chain,
        };
      },
    },
    queries,
  };
}

beforeEach(() => {
  mocked.stopSandboxById.mockClear();
  mocked.listRunningSandboxes.mockReset();
  mocked.loadConnectedVercelSandboxConnections.mockResolvedValue([
    {
      credentials: { projectId: "prj_123", teamId: "team_123", token: "vca_secret" },
      preview: { workspaceId: "workspace-1" },
    },
  ]);
});

const TEN_MIN_MS = 10 * 60 * 1000;
const ONE_MIN_MS = 60 * 1000;

describe("reapOrphanSandboxes", () => {
  it("returns early when the provider has no active sandboxes", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([]);
    const { admin } = buildAdminMock([]);
    const result = await reapOrphanSandboxes(admin as never);
    expect(result.activeProviderCount).toBe(0);
    expect(result.reapedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
    expect(mocked.listRunningSandboxes).toHaveBeenCalledWith({
      vercelCredentials: { projectId: "prj_123", teamId: "team_123", token: "vca_secret" },
    });
  });

  it("ignores sandboxes inside the grace window", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "fresh", status: "running", createdAt: Date.now() - ONE_MIN_MS },
    ]);
    const { admin, queries } = buildAdminMock([]);
    const result = await reapOrphanSandboxes(admin as never);
    expect(result.activeProviderCount).toBe(1);
    expect(result.reapedSandboxIds).toEqual([]);
    expect(queries).toHaveLength(0); // never queried the DB
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("stops only orphaned sandboxes; leaves claimed ones running", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "claimed", status: "running", createdAt: Date.now() - TEN_MIN_MS },
      { id: "orphan-1", status: "running", createdAt: Date.now() - TEN_MIN_MS },
      { id: "orphan-2", status: "pending", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock([{ sandbox_id: "claimed" }]);
    const result = await reapOrphanSandboxes(admin as never);
    expect(result.activeProviderCount).toBe(3);
    expect(result.reapedSandboxIds.sort()).toEqual(["orphan-1", "orphan-2"]);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("orphan-1", {
      vercelCredentials: { projectId: "prj_123", teamId: "team_123", token: "vca_secret" },
    });
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("orphan-2", {
      vercelCredentials: { projectId: "prj_123", teamId: "team_123", token: "vca_secret" },
    });
    expect(mocked.stopSandboxById).not.toHaveBeenCalledWith(
      "claimed",
      expect.objectContaining({ vercelCredentials: expect.anything() }),
    );
  });

  it("leaves a sandbox claimed by another workspace in the same Vercel project", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "shared-claimed", status: "running", createdAt: Date.now() - TEN_MIN_MS },
      { id: "orphan", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock([
      {
        sandbox_id: "shared-claimed",
        workspace_id: "workspace-2",
      },
    ]);

    const result = await reapOrphanSandboxes(admin as never);

    expect(result.reapedSandboxIds).toEqual(["orphan"]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalledWith(
      "shared-claimed",
      expect.objectContaining({ vercelCredentials: expect.anything() }),
    );
  });

  it("requires matching Vercel project metadata before treating a sandbox as claimed", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "same-id", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock([
      {
        sandbox_id: "same-id",
        sandbox_vercel_project_id: "prj_other",
        sandbox_vercel_team_id: "team_123",
        workspace_id: "workspace-2",
      },
    ]);

    const result = await reapOrphanSandboxes(admin as never);

    expect(result.reapedSandboxIds).toEqual(["same-id"]);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("same-id", {
      vercelCredentials: { projectId: "prj_123", teamId: "team_123", token: "vca_secret" },
    });
  });

  it("logs and bails out when the DB query for claimed runs fails", async () => {
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "orphan", status: "running", createdAt: Date.now() - TEN_MIN_MS },
    ]);
    const { admin } = buildAdminMock([], { fail: true });
    const result = await reapOrphanSandboxes(admin as never);
    expect(result.reapedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("respects a custom grace window", async () => {
    // Grace = 30s. Sandbox is 60s old → eligible for reaping.
    mocked.listRunningSandboxes.mockResolvedValueOnce([
      { id: "orphan", status: "running", createdAt: Date.now() - 60_000 },
    ]);
    const { admin } = buildAdminMock([]);
    const result = await reapOrphanSandboxes(admin as never, { graceMs: 30_000 });
    expect(result.reapedSandboxIds).toEqual(["orphan"]);
  });
});
