import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  reapOrphanSandboxes: vi.fn(),
  reconcileLinearState: vi.fn(),
  sweepStalledRuns: vi.fn(),
}));

vi.mock("@/worker/reconciler", () => ({
  reconcileLinearState: mocked.reconcileLinearState,
}));

vi.mock("@/worker/sandbox-reaper", () => ({
  reapOrphanSandboxes: mocked.reapOrphanSandboxes,
}));

vi.mock("@/worker/stall-detector", () => ({
  sweepStalledRuns: mocked.sweepStalledRuns,
}));

import { runMaintenanceTick } from "./service";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function setupDefaults() {
  mocked.sweepStalledRuns.mockResolvedValue({
    retriedJobIds: ["job-retry"],
    stalledJobIds: [],
    stalledRunIds: ["run-stalled"],
    stoppedSandboxIds: ["sandbox-stalled"],
  });
  mocked.reapOrphanSandboxes.mockResolvedValue({
    activeProviderCount: 2,
    reapedSandboxIds: ["sandbox-orphan"],
  });
  mocked.reconcileLinearState.mockResolvedValue({
    canceled: 1,
    checked: 3,
    rateLimited: false,
  });
}

describe("runMaintenanceTick", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("runs workspace-scoped cleanup and reconciliation while delegating queue processing", async () => {
    setupDefaults();
    const admin = {};

    const result = await runMaintenanceTick({
      admin: admin as never,
      workspaceId: WORKSPACE_ID,
    });

    expect(mocked.sweepStalledRuns).toHaveBeenCalledWith(admin, 900_000, {
      workspaceId: WORKSPACE_ID,
    });
    expect(mocked.reconcileLinearState).toHaveBeenCalledWith(admin, {
      workspaceId: WORKSPACE_ID,
    });
    expect(mocked.reapOrphanSandboxes).toHaveBeenCalledWith(admin);
    expect(result).toEqual({
      cleanup: {
        activeProviderSandboxCount: 2,
        reapedSandboxIds: ["sandbox-orphan"],
        retriedJobIds: ["job-retry"],
        stalledRunIds: ["run-stalled"],
        stoppedSandboxIds: ["sandbox-stalled"],
        terminalErroredJobIds: [],
      },
      processing: {
        processedJobIds: [],
        result: "delegated",
        runId: null,
      },
      reconciliation: {
        canceled: 1,
        checked: 3,
        rateLimited: false,
      },
    });
  });

  it("does not process queued jobs even when a tick budget is provided", async () => {
    setupDefaults();

    const result = await runMaintenanceTick({
      admin: {} as never,
      tickBudgetMs: 1,
      workspaceId: WORKSPACE_ID,
    });

    expect(result.processing).toEqual({
      processedJobIds: [],
      result: "delegated",
      runId: null,
    });
  });
});
