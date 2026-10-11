import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxConnection } from "@/lib/sandbox/types";

const mocked = vi.hoisted(() => ({
  loadWorkspaceSandboxConnection: vi.fn(),
  stopSandboxById: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/sandbox", () => ({ stopSandboxById: mocked.stopSandboxById }));
vi.mock("@/lib/sandbox-connections/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sandbox-connections/server")>()),
  loadWorkspaceSandboxConnection: mocked.loadWorkspaceSandboxConnection,
  providerLabel: (provider: string) => provider,
}));

import { resumeWorkspaceDeletion } from "@/lib/workspaces/deletion";
import { confirmConnectionSandboxCleanup, hasSandboxCleanupReceipt } from "./cleanup-receipts";

const workspaceId = "workspace-1";
const connection: SandboxConnection = {
  provider: "e2b",
  revision: "revision-1",
  credentials: { apiKey: "fixture" },
};
type Row = Record<string, unknown>;

function fixture() {
  const owner = (id: string, sandboxId: string) => ({
    id,
    sandbox_id: sandboxId,
    sandbox_provider: "e2b",
    sandbox_connection_revision: "revision-1",
    workspace_id: workspaceId,
  });
  const tables: Record<string, Row[]> = {
    workspaces: [{ id: workspaceId, deletion_requested_at: "2026-10-10T00:00:00Z" }],
    sessions: [],
    agent_runs: [
      {
        ...owner("run-1", "run-sandbox"),
        status: "success",
        agent_job_id: "job-1",
        "job.workspace_id": workspaceId,
        "job.status": "success",
      },
    ],
    sandbox_capability_checks: [owner("check-1", "check-sandbox")],
    codex_device_auth_flows: [owner("auth-1", "auth-sandbox")],
    workspace_resource_operations: [],
    workspace_sandbox_cleanup_receipts: [],
  };
  const state = { receiptWriteError: false };
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let limit = Infinity;
    const rows = () =>
      tables[table]!.filter((row) => filters.every((filter) => filter(row)))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .slice(0, limit);
    const query = {
      select: () => query,
      order: () => query,
      limit: (value: number) => {
        limit = value;
        return query;
      },
      eq: (key: string, value: unknown) => {
        filters.push((row) => row[key] === value);
        return query;
      },
      is: (key: string, value: unknown) => {
        filters.push((row) => row[key] === value);
        return query;
      },
      not: (key: string, _operator: string, value: unknown) => {
        filters.push((row) => row[key] !== value);
        return query;
      },
      in: (key: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[key]));
        return query;
      },
      gt: (key: string, value: string) => {
        filters.push((row) => String(row[key]) > value);
        return query;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      upsert: async (value: Row) => {
        if (state.receiptWriteError) return { error: new Error("Receipt unavailable") };
        tables[table]!.push(value);
        return { error: null };
      },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve),
    };
    return query;
  };
  const rpc = vi.fn(async (name: string) => {
    if (name !== "finish_workspace_deletion") throw new Error(`Unexpected RPC ${name}`);
    tables.workspaces = [];
    return { data: true, error: null };
  });
  const storage = { from: () => ({ list: async () => ({ data: [], error: null }) }) };
  return { admin: { from, rpc, storage } as never, tables, state, rpc };
}

describe("verified sandbox cleanup receipts", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("refuses disconnect receipts while failed source owns the sandbox", async () => {
    const f = fixture();
    f.tables.agent_runs![0]!.source_recovery_required = true;
    f.tables.agent_runs![0]!.status = "error";
    await expect(
      confirmConnectionSandboxCleanup({ admin: f.admin, connection, workspaceId }),
    ).rejects.toThrow("Cannot change this sandbox connection while related Wallie work is active.");
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
    expect(f.tables.workspace_sandbox_cleanup_receipts).toEqual([]);
  });

  it("still honors explicit workspace deletion for retained source", async () => {
    const f = fixture();
    f.tables.agent_runs![0]!.source_recovery_required = true;
    f.tables.agent_runs![0]!.status = "error";
    mocked.loadWorkspaceSandboxConnection.mockImplementation(
      async (_admin, _workspaceId, provider) => (provider === "e2b" ? { connection } : null),
    );
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(true);
    expect(mocked.stopSandboxById.mock.calls).toEqual([
      ["run-sandbox", { connection, throwOnError: true }],
      ["check-sandbox", { connection, throwOnError: true }],
      ["auth-sandbox", { connection, throwOnError: true }],
    ]);
    expect(f.tables.workspaces).toEqual([]);
  });

  it("deletes after a clean disconnect while retaining historical run, probe, and auth IDs", async () => {
    const f = fixture();
    await confirmConnectionSandboxCleanup({ admin: f.admin, connection, workspaceId });
    expect(mocked.stopSandboxById.mock.calls).toEqual([
      ["run-sandbox", { connection, throwOnError: true }],
      ["check-sandbox", { connection, throwOnError: true }],
      ["auth-sandbox", { connection, throwOnError: true }],
    ]);
    expect(f.tables.workspace_sandbox_cleanup_receipts).toEqual(
      ["run-sandbox", "check-sandbox", "auth-sandbox"].map((sandboxId) => ({
        workspace_id: workspaceId,
        provider: "e2b",
        connection_revision: "revision-1",
        sandbox_id: sandboxId,
      })),
    );
    expect(f.tables.agent_runs![0]!.sandbox_id).toBe("run-sandbox");
    expect(f.tables.sandbox_capability_checks![0]!.sandbox_id).toBe("check-sandbox");
    expect(f.tables.codex_device_auth_flows![0]!.sandbox_id).toBe("auth-sandbox");
    mocked.loadWorkspaceSandboxConnection.mockResolvedValue(null);
    mocked.stopSandboxById.mockClear();
    expect(await resumeWorkspaceDeletion(f.admin, workspaceId)).toBe(true);
    expect(f.tables.workspaces).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("checks every recorded page and skips only matching completed stops", async () => {
    const f = fixture();
    f.tables.agent_runs = Array.from({ length: 205 }, (_, index) => ({
      ...f.tables.agent_runs![0],
      id: `run-${String(index).padStart(3, "0")}`,
      sandbox_id: `sandbox-${index}`,
    }));
    await confirmConnectionSandboxCleanup({ admin: f.admin, connection, workspaceId });
    expect(f.tables.workspace_sandbox_cleanup_receipts).toHaveLength(207);
    expect(f.tables.workspace_sandbox_cleanup_receipts![204]!.sandbox_id).toBe("sandbox-204");
    mocked.stopSandboxById.mockClear();
    await confirmConnectionSandboxCleanup({ admin: f.admin, connection, workspaceId });
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
    expect(f.tables.workspace_sandbox_cleanup_receipts).toHaveLength(207);
  });

  it("does not retire another provider's sandbox because its ID matches a cleaned run", async () => {
    const f = fixture();
    await confirmConnectionSandboxCleanup({ admin: f.admin, connection, workspaceId });
    f.tables.sandbox_capability_checks!.push({
      id: "check-other-provider",
      sandbox_id: "run-sandbox",
      sandbox_provider: "daytona",
      sandbox_connection_revision: "revision-2",
      workspace_id: workspaceId,
    });
    mocked.loadWorkspaceSandboxConnection.mockResolvedValue(null);
    await expect(resumeWorkspaceDeletion(f.admin, workspaceId)).rejects.toThrow(
      "Workspace sandbox cleanup credentials are unavailable.",
    );
    expect(f.tables.workspaces).toHaveLength(1);
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it.each(["connectionRevision", "provider", "sandboxId", "workspaceId"] as const)(
    "does not accept a receipt for a different %s",
    async (key) => {
      const f = fixture();
      await confirmConnectionSandboxCleanup({ admin: f.admin, connection, workspaceId });
      const owner = {
        connectionRevision: "revision-1",
        provider: "e2b",
        sandboxId: "run-sandbox",
        workspaceId,
      };
      expect(await hasSandboxCleanupReceipt(f.admin, { ...owner, [key]: "different" })).toBe(false);
    },
  );

  it("keeps deletion pending for legacy ownership without a receipt or credentials", async () => {
    const f = fixture();
    mocked.loadWorkspaceSandboxConnection.mockResolvedValue(null);
    await expect(resumeWorkspaceDeletion(f.admin, workspaceId)).rejects.toThrow(
      "Workspace sandbox cleanup credentials are unavailable.",
    );
    expect(f.tables.workspaces).toHaveLength(1);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.tables.workspace_sandbox_cleanup_receipts).toEqual([]);
  });

  it("never records a receipt after a failed provider stop", async () => {
    const f = fixture();
    mocked.stopSandboxById.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(
      confirmConnectionSandboxCleanup({ admin: f.admin, connection, workspaceId }),
    ).rejects.toThrow("Provider unavailable");
    expect(f.tables.workspace_sandbox_cleanup_receipts).toEqual([]);
    expect(f.tables.agent_runs![0]!.sandbox_id).toBe("run-sandbox");
  });

  it("reports an unpersisted stop so disconnect retains credentials for retry", async () => {
    const f = fixture();
    f.state.receiptWriteError = true;
    await expect(
      confirmConnectionSandboxCleanup({ admin: f.admin, connection, workspaceId }),
    ).rejects.toThrow("Receipt unavailable");
    expect(f.tables.workspace_sandbox_cleanup_receipts).toEqual([]);
    f.state.receiptWriteError = false;
    await confirmConnectionSandboxCleanup({ admin: f.admin, connection, workspaceId });
    expect(f.tables.workspace_sandbox_cleanup_receipts).toHaveLength(3);
    expect(mocked.stopSandboxById.mock.calls.map(([id]) => id)).toEqual([
      "run-sandbox",
      "run-sandbox",
      "check-sandbox",
      "auth-sandbox",
    ]);
  });
});
