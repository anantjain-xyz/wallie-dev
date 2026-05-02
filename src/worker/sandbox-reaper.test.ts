import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  stopSandboxById: vi.fn().mockResolvedValue(undefined),
  listRunningSandboxes: vi.fn(),
}));

vi.mock("@/lib/sandbox", () => ({
  stopSandboxById: mocked.stopSandboxById,
  listRunningSandboxes: mocked.listRunningSandboxes,
}));

import { reapOrphanSandboxes } from "./sandbox-reaper";

interface ClaimedRow {
  sandbox_id: string;
}

function buildAdminMock(claimed: ClaimedRow[], opts: { fail?: boolean } = {}) {
  const queries: Array<{ ids: string[] }> = [];
  return {
    admin: {
      from: (name: string) => {
        if (name !== "agent_runs") throw new Error(`unexpected table: ${name}`);
        return {
          select: () => ({
            in: (_col: string, ids: string[]) => ({
              in: async () => {
                queries.push({ ids });
                if (opts.fail) {
                  return { data: null, error: { message: "db down" } };
                }
                return {
                  data: claimed.filter((r) => ids.includes(r.sandbox_id)),
                  error: null,
                };
              },
            }),
          }),
        };
      },
    },
    queries,
  };
}

beforeEach(() => {
  mocked.stopSandboxById.mockClear();
  mocked.listRunningSandboxes.mockReset();
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
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("orphan-1");
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("orphan-2");
    expect(mocked.stopSandboxById).not.toHaveBeenCalledWith("claimed");
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
