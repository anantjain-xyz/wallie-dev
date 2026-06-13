import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loadVercelSandboxConnection: vi.fn(),
  stopSandboxById: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/sandbox", () => ({
  stopSandboxById: mocked.stopSandboxById,
}));

vi.mock("@/lib/vercel-sandbox/server", () => ({
  loadVercelSandboxConnection: mocked.loadVercelSandboxConnection,
}));

import { stopWorkspaceProviderSandboxes } from "./teardown";

const WORKSPACE_ID = "workspace-1";
const CREDENTIALS = { projectId: "prj_123", teamId: "team_123", token: "tok_secret" };

interface SandboxRow {
  sandbox_id: string | null;
}

/**
 * Minimal Supabase query-builder stand-in. Every filter method returns the same
 * chain object, and the chain resolves (via `then`) to the table's preset rows
 * so `await admin.from(...).select(...)...` works regardless of filter order.
 */
function buildAdminMock(tables: {
  agent_runs?: { data?: SandboxRow[]; error?: { message: string } };
  sandbox_capability_checks?: { data?: SandboxRow[]; error?: { message: string } };
}) {
  const from = vi.fn((name: string) => {
    const preset = tables[name as keyof typeof tables] ?? { data: [] };
    const result = { data: preset.data ?? [], error: preset.error ?? null };
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "gte", "not"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.then = (
      resolve: (value: { data: SandboxRow[]; error: { message: string } | null }) => unknown,
    ) => resolve(result);
    return chain;
  });

  return { from } as never;
}

function connection() {
  return { credentials: CREDENTIALS, preview: {} };
}

describe("stopWorkspaceProviderSandboxes", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("stops sandboxes owned by active runs and capability checks", async () => {
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());
    const admin = buildAdminMock({
      agent_runs: { data: [{ sandbox_id: "sbx_run_1" }, { sandbox_id: "sbx_run_2" }] },
      sandbox_capability_checks: { data: [{ sandbox_id: "sbx_check_1" }] },
    });

    const result = await stopWorkspaceProviderSandboxes(admin, WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual(["sbx_run_1", "sbx_run_2", "sbx_check_1"]);
    expect(mocked.stopSandboxById).toHaveBeenCalledTimes(3);
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sbx_run_1", {
      vercelCredentials: CREDENTIALS,
    });
    expect(mocked.stopSandboxById).toHaveBeenCalledWith("sbx_check_1", {
      vercelCredentials: CREDENTIALS,
    });
  });

  it("deduplicates a sandbox id shared by a run and a capability check", async () => {
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());
    const admin = buildAdminMock({
      agent_runs: { data: [{ sandbox_id: "sbx_shared" }] },
      sandbox_capability_checks: { data: [{ sandbox_id: "sbx_shared" }] },
    });

    const result = await stopWorkspaceProviderSandboxes(admin, WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual(["sbx_shared"]);
    expect(mocked.stopSandboxById).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the workspace has no Vercel connection", async () => {
    mocked.loadVercelSandboxConnection.mockResolvedValue(null);

    const result = await stopWorkspaceProviderSandboxes(buildAdminMock({}), WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("does nothing when there are no active runs or checks", async () => {
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());

    const result = await stopWorkspaceProviderSandboxes(buildAdminMock({}), WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("ignores null sandbox ids", async () => {
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());
    const admin = buildAdminMock({
      agent_runs: { data: [{ sandbox_id: null }, { sandbox_id: "sbx_ok" }] },
    });

    const result = await stopWorkspaceProviderSandboxes(admin, WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual(["sbx_ok"]);
  });

  it("returns without throwing when loading the connection fails", async () => {
    mocked.loadVercelSandboxConnection.mockRejectedValue(new Error("db down"));

    const result = await stopWorkspaceProviderSandboxes(buildAdminMock({}), WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual([]);
    expect(mocked.stopSandboxById).not.toHaveBeenCalled();
  });

  it("still stops capability-check sandboxes when the runs query errors", async () => {
    mocked.loadVercelSandboxConnection.mockResolvedValue(connection());
    const admin = buildAdminMock({
      agent_runs: { error: { message: "boom" } },
      sandbox_capability_checks: { data: [{ sandbox_id: "sbx_check" }] },
    });

    const result = await stopWorkspaceProviderSandboxes(admin, WORKSPACE_ID);

    expect(result.stoppedSandboxIds).toEqual(["sbx_check"]);
  });
});
