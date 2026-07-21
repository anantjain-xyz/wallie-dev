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
  sandbox_id: string | null;
}

/**
 * Minimal Supabase query-builder stand-in for the capability-check query. Every
 * filter method returns the same chain object, and the chain resolves (via
 * `then`) to the table's preset rows so `await admin.from(...).select(...)...`
 * works regardless of filter order.
 */
function buildAdminMock(tables: {
  sandbox_capability_checks?: { data?: SandboxRow[]; error?: { message: string } };
}) {
  const eqCalls: Array<[string, unknown]> = [];
  const from = vi.fn((name: string) => {
    const preset = tables[name as keyof typeof tables] ?? { data: [] };
    const result = { data: preset.data ?? [], error: preset.error ?? null };
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "in", "gte", "not"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.eq = vi.fn((column: string, value: unknown) => {
      eqCalls.push([column, value]);
      return chain;
    });
    chain.then = (
      resolve: (value: { data: SandboxRow[]; error: { message: string } | null }) => unknown,
    ) => resolve(result);
    return chain;
  });

  return { admin: { from } as never, eqCalls };
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
    });
  });

  it("does not stop a capability-check sandbox already stopped by the cancel step", async () => {
    mocked.cancelWorkspaceWork.mockResolvedValue(
      cancelResult({ stoppedSandboxIds: ["sbx_shared"] }),
    );
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());
    const { admin } = buildAdminMock({
      sandbox_capability_checks: { data: [{ sandbox_id: "sbx_shared" }] },
    });

    const result = await stopWorkspaceProviderSandboxes(admin, WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual(["sbx_shared"]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
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

  it("returns the cancel result without throwing when loading the connection fails", async () => {
    mocked.cancelWorkspaceWork.mockResolvedValue(
      cancelResult({ canceledRunIds: ["run-1"], stoppedSandboxIds: ["sbx_run"] }),
    );
    mocked.loadVercelSandboxConnection.mockRejectedValue(new Error("db down"));

    const result = await stopWorkspaceProviderSandboxes(buildAdminMock({}).admin, WORKSPACE_ID);

    expect(result.canceledRunIds).toEqual(["run-1"]);
    expect(result.stoppedSandboxIds).toEqual(["sbx_run"]);
    // The run sandbox was stopped inside cancelWorkspaceWork; the failed
    // connection load only blocks capability-check stops.
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
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
