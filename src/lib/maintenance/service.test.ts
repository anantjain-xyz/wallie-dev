import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  processQueuedAgentJobs: vi.fn(),
  reapOrphanSandboxes: vi.fn(),
  reconcileLinearState: vi.fn(),
  sweepStalledRuns: vi.fn(),
}));

vi.mock("@/lib/wallie/service", () => ({
  processQueuedAgentJobs: mocked.processQueuedAgentJobs,
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
  mocked.processQueuedAgentJobs.mockResolvedValue({
    jobId: "job-next",
    processed: true,
    result: "success",
    runId: "run-next",
  });
}

describe("runMaintenanceTick", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("runs workspace-scoped cleanup, reconciliation, and one queued job", async () => {
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
    expect(mocked.processQueuedAgentJobs).toHaveBeenCalledWith({
      admin,
      signal: expect.any(AbortSignal),
      workspaceId: WORKSPACE_ID,
    });
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
        processedJobIds: ["job-next"],
        result: "success",
        runId: "run-next",
      },
      reconciliation: {
        canceled: 1,
        checked: 3,
        rateLimited: false,
      },
    });
  });

  it("skips queue processing when the time budget is nearly exhausted", async () => {
    setupDefaults();

    const result = await runMaintenanceTick({
      admin: {} as never,
      tickBudgetMs: 1,
      workspaceId: WORKSPACE_ID,
    });

    expect(mocked.processQueuedAgentJobs).not.toHaveBeenCalled();
    expect(result.processing).toEqual({
      processedJobIds: [],
      result: "budget_exhausted",
      runId: null,
    });
  });

  it("aborts in-flight queue processing when the maintenance budget expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    setupDefaults();
    mocked.processQueuedAgentJobs.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                jobId: "job-next",
                processed: true,
                result: "error",
                runId: "run-next",
              }),
            { once: true },
          );
        }),
    );

    const pending = runMaintenanceTick({
      admin: {} as never,
      tickBudgetMs: 60_100,
      workspaceId: WORKSPACE_ID,
    });

    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.processing).toEqual({
      processedJobIds: ["job-next"],
      result: "error",
      runId: "run-next",
    });
  });
});
