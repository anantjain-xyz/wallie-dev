import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  cancelWorkspaceWork: vi.fn(),
  loadVercelSandboxConnection: vi.fn(),
  stopSandboxById: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/pipeline/cancel", () => ({
  cancelWorkspaceWork: mocked.cancelWorkspaceWork,
}));

vi.mock("@/lib/sandbox", () => ({
  stopSandboxById: mocked.stopSandboxById,
}));
vi.mock("@/lib/sandbox-connections/cleanup-receipts", () => ({
  hasSandboxCleanupReceipt: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/sandbox-connections/server", () => ({
  loadWorkspaceSandboxConnection: (admin: unknown, workspaceId: string, provider: string) =>
    provider === "vercel"
      ? mocked.loadVercelSandboxConnection(admin, workspaceId)
      : Promise.resolve(null),
  providerLabel: (provider: string) => provider,
}));

import { stopWorkspaceProviderSandboxes } from "./teardown";

const WORKSPACE_ID = "workspace-1";
const CREDENTIALS = { projectId: "prj_123", teamId: "team_123", token: "tok_secret" };

interface SandboxRow {
  id?: string;
  sandbox_id: string | null;
}

/**
 * Minimal Supabase query-builder stand-in for the capability-check query. Every
 * filter method returns the same chain object, and the chain resolves (via
 * `then`) to the table's preset rows so `await admin.from(...).select(...)...`
 * works regardless of filter order.
 */
function buildAdminMock(tables: {
  codex_device_auth_flows?: { data?: SandboxRow[]; error?: { message: string } };
  sandbox_capability_checks?: { data?: SandboxRow[]; error?: { message: string } };
}) {
  const eqCalls: Array<[string, unknown]> = [];
  const inCalls: Array<[string, unknown]> = [];
  const from = vi.fn((name: string) => {
    const preset = tables[name as keyof typeof tables] ?? { data: [] };
    const rows = (preset.data ?? []).map((row, index) => ({
      id: String(index).padStart(6, "0"),
      sandbox_connection_revision: "revision-1",
      ...row,
    }));
    let afterId = "";
    let pageSize = 100;
    let provider = "vercel";
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "not", "order"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.gt = vi.fn((_column: string, value: string) => {
      afterId = value;
      return chain;
    });
    chain.limit = vi.fn((value: number) => {
      pageSize = value;
      return chain;
    });
    chain.in = vi.fn((column: string, value: unknown) => {
      inCalls.push([column, value]);
      return chain;
    });
    chain.eq = vi.fn((column: string, value: unknown) => {
      eqCalls.push([column, value]);
      if (column === "sandbox_provider") provider = String(value);
      return chain;
    });
    chain.then = (
      resolve: (value: { data: SandboxRow[]; error: { message: string } | null }) => unknown,
    ) =>
      resolve({
        data:
          provider === "vercel" ? rows.filter((row) => row.id > afterId).slice(0, pageSize) : [],
        error: preset.error ?? null,
      });
    return chain;
  });

  return { admin: { from } as never, eqCalls, inCalls };
}

function connection() {
  return {
    connection: { credentials: CREDENTIALS, provider: "vercel", revision: "revision-1" },
    preview: {},
  };
}

function cancelResult(
  overrides: {
    canceledJobIds?: string[];
    canceledRunIds?: string[];
    stoppedSandboxIds?: string[];
  } = {},
) {
  return {
    canceledJobIds: overrides.canceledJobIds ?? [],
    canceledRunIds: overrides.canceledRunIds ?? [],
    stoppedSandboxIds: overrides.stoppedSandboxIds ?? [],
  };
}

describe("stopWorkspaceProviderSandboxes", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("stops every capability and auth owner across multiple database pages", async () => {
    mocked.cancelWorkspaceWork.mockResolvedValue(cancelResult());
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());
    const { admin } = buildAdminMock({
      sandbox_capability_checks: {
        data: Array.from({ length: 205 }, (_, index) => ({ sandbox_id: `check-${index}` })),
      },
      codex_device_auth_flows: {
        data: Array.from({ length: 205 }, (_, index) => ({ sandbox_id: `auth-${index}` })),
      },
    });
    const result = await stopWorkspaceProviderSandboxes(admin, WORKSPACE_ID);
    expect(result.stoppedSandboxIds).toHaveLength(410);
    expect(result.stoppedSandboxIds).toContain("check-204");
    expect(result.stoppedSandboxIds).toContain("auth-204");
    expect(new Set(mocked.stopSandboxById.mock.calls.map(([id]) => id)).size).toBe(410);
  });

  it("cancels the workspace's jobs and runs before snapshotting sandboxes", async () => {
    mocked.cancelWorkspaceWork.mockResolvedValue(
      cancelResult({ canceledJobIds: ["job-1"], canceledRunIds: ["run-1"] }),
    );
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());

    const result = await stopWorkspaceProviderSandboxes(buildAdminMock({}).admin, WORKSPACE_ID);

    expect(mocked.cancelWorkspaceWork).toHaveBeenCalledWith(expect.anything(), {
      reason: "Workspace deleted.",
      workspaceId: WORKSPACE_ID,
    });
    expect(result.canceledJobIds).toEqual(["job-1"]);
    expect(result.canceledRunIds).toEqual(["run-1"]);
  });

  it("merges sandboxes stopped by the cancel step with capability-check sandboxes", async () => {
    mocked.cancelWorkspaceWork.mockResolvedValue(
      cancelResult({ canceledRunIds: ["run-1"], stoppedSandboxIds: ["sbx_run_1"] }),
    );
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());
    const { admin } = buildAdminMock({
      sandbox_capability_checks: { data: [{ sandbox_id: "sbx_check_1" }] },
    });

    const result = await stopWorkspaceProviderSandboxes(admin, WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual(["sbx_run_1", "sbx_check_1"]);
    // The run sandbox was already stopped inside cancelWorkspaceWork; only the
    // capability-check sandbox is stopped here.
    expect(mocked.stopSandboxById).toHaveBeenCalledTimes(1);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sbx_check_1", {
      connection: { credentials: CREDENTIALS, provider: "vercel", revision: "revision-1" },
      throwOnError: true,
    });
  });

  it("stops active device-auth sandboxes before their ownership rows are cascaded", async () => {
    mocked.cancelWorkspaceWork.mockResolvedValue(cancelResult());
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());
    const { admin, inCalls } = buildAdminMock({
      codex_device_auth_flows: {
        data: [{ sandbox_id: "sbx_auth_1" }, { sandbox_id: "provisioning:flow-reservation" }],
      },
    });

    const result = await stopWorkspaceProviderSandboxes(admin, WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual(["sbx_auth_1"]);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sbx_auth_1", {
      connection: { credentials: CREDENTIALS, provider: "vercel", revision: "revision-1" },
      throwOnError: true,
    });
    expect(inCalls).toEqual([]);
  });

  it("verifies independent ownership even when cancellation returned the same bare sandbox ID", async () => {
    mocked.cancelWorkspaceWork.mockResolvedValue(
      cancelResult({ stoppedSandboxIds: ["sbx_shared"] }),
    );
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());
    const { admin } = buildAdminMock({
      sandbox_capability_checks: { data: [{ sandbox_id: "sbx_shared" }] },
    });

    const result = await stopWorkspaceProviderSandboxes(admin, WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual(["sbx_shared"]);
    expect(mocked.stopSandboxById).toHaveBeenCalledExactlyOnceWith("sbx_shared", {
      connection: { credentials: CREDENTIALS, provider: "vercel", revision: "revision-1" },
      throwOnError: true,
    });
  });

  it("still cancels work but stops no sandboxes when the workspace has no connection", async () => {
    mocked.cancelWorkspaceWork.mockResolvedValue(cancelResult({ canceledJobIds: ["job-1"] }));
    mocked.loadVercelSandboxConnection.mockResolvedValue(null);

    const result = await stopWorkspaceProviderSandboxes(buildAdminMock({}).admin, WORKSPACE_ID);

    expect(mocked.cancelWorkspaceWork).toHaveBeenCalled();
    expect(result.canceledJobIds).toEqual(["job-1"]);
    expect(result.stoppedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("does nothing extra when there are no capability checks to stop", async () => {
    mocked.cancelWorkspaceWork.mockResolvedValue(cancelResult());
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());

    const result = await stopWorkspaceProviderSandboxes(buildAdminMock({}).admin, WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("ignores null capability-check sandbox ids", async () => {
    mocked.cancelWorkspaceWork.mockResolvedValue(cancelResult());
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());
    const { admin } = buildAdminMock({
      sandbox_capability_checks: { data: [{ sandbox_id: null }, { sandbox_id: "sbx_ok" }] },
    });

    const result = await stopWorkspaceProviderSandboxes(admin, WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual(["sbx_ok"]);
  });

  it("blocks deletion when loading a provider connection fails", async () => {
    mocked.cancelWorkspaceWork.mockResolvedValue(cancelResult());
    mocked.loadVercelSandboxConnection.mockRejectedValue(new Error("db down"));
    await expect(
      stopWorkspaceProviderSandboxes(buildAdminMock({}).admin, WORKSPACE_ID),
    ).rejects.toThrow("db down");
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it.each(["sandbox_capability_checks", "codex_device_auth_flows"] as const)(
    "blocks deletion when %s ownership lookup fails",
    async (table) => {
      mocked.cancelWorkspaceWork.mockResolvedValue(cancelResult());
      mocked.loadVercelSandboxConnection.mockResolvedValue(connection());
      await expect(
        stopWorkspaceProviderSandboxes(
          buildAdminMock({ [table]: { error: { message: "lookup failed" } } }).admin,
          WORKSPACE_ID,
        ),
      ).rejects.toEqual({ message: "lookup failed" });
    },
  );

  it("blocks deletion when run cleanup or a capability sandbox stop fails", async () => {
    mocked.cancelWorkspaceWork.mockRejectedValueOnce(new Error("run cleanup failed"));
    await expect(
      stopWorkspaceProviderSandboxes(buildAdminMock({}).admin, WORKSPACE_ID),
    ).rejects.toThrow("run cleanup failed");
    mocked.cancelWorkspaceWork.mockResolvedValue(cancelResult());
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());
    mocked.stopSandboxById.mockRejectedValueOnce(new Error("stop failed"));
    await expect(
      stopWorkspaceProviderSandboxes(
        buildAdminMock({ sandbox_capability_checks: { data: [{ sandbox_id: "sbx_check" }] } })
          .admin,
        WORKSPACE_ID,
      ),
    ).rejects.toThrow("stop failed");
  });

  it("still stops capability-check sandboxes after the cancel step ran", async () => {
    mocked.cancelWorkspaceWork.mockResolvedValue(cancelResult());
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());
    const { admin } = buildAdminMock({
      sandbox_capability_checks: { data: [{ sandbox_id: "sbx_check" }] },
    });

    const result = await stopWorkspaceProviderSandboxes(admin, WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual(["sbx_check"]);
  });

  it("snapshots capability checks by sandbox id without constraining status", async () => {
    mocked.cancelWorkspaceWork.mockResolvedValue(cancelResult());
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());
    // A check that wrote `success`/`error` before its `finally` stopped the
    // sandbox still owns a live sandbox; the snapshot must catch it, so it must
    // NOT filter on status === "running".
    const { admin, eqCalls } = buildAdminMock({
      sandbox_capability_checks: { data: [{ sandbox_id: "sbx_finished_check" }] },
    });

    const result = await stopWorkspaceProviderSandboxes(admin, WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual(["sbx_finished_check"]);
    expect(eqCalls).not.toContainEqual(["status", "running"]);
  });
});
