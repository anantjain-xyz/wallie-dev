import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerConfig } from "./config";
import type { ClaimNextResult } from "./loop";

const mocked = vi.hoisted(() => ({
  claimNextJob: vi.fn(),
  runClaimedJob: vi.fn(),
  sendHeartbeat: vi.fn(),
}));

vi.mock("./loop", () => ({
  claimNextJob: mocked.claimNextJob,
  runClaimedJob: mocked.runClaimedJob,
}));

vi.mock("./heartbeat", () => ({
  sendHeartbeat: mocked.sendHeartbeat,
}));

import { createScheduler } from "./scheduler";

const config: WorkerConfig = {
  defaultConcurrencyLimit: 2,
  defaultStallTimeoutMs: 900_000,
  heartbeatIntervalMs: 10_000,
  maxConcurrentJobs: 3,
  pollIntervalMs: 2_000,
  reconcileIntervalMs: 60_000,
  sandboxReapIntervalMs: 60_000,
  stallSweepIntervalMs: 30_000,
  workerId: "worker-test",
};

const admin = {} as never;

function job(id: string): ClaimNextResult {
  return { job: { id, workspace_id: "ws-1" } as never, outcome: "claimed" };
}

describe("createScheduler", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not claim when already shutting down", async () => {
    const scheduler = createScheduler(admin, config, { isShuttingDown: () => true });

    await scheduler.run();

    expect(mocked.claimNextJob).not.toHaveBeenCalled();
  });

  it("never exceeds maxConcurrentJobs and reports the full in-flight set", async () => {
    let claimCount = 0;
    mocked.claimNextJob.mockImplementation(async () => job(`job-${++claimCount}`));
    // Jobs stay in flight so capacity fills up.
    mocked.runClaimedJob.mockReturnValue(new Promise<void>(() => {}));
    mocked.sendHeartbeat.mockResolvedValue(undefined);

    const scheduler = createScheduler(admin, config, {
      // Stop once the cap's worth of jobs have been claimed.
      isShuttingDown: () => claimCount >= config.maxConcurrentJobs,
      delay: async () => {},
    });

    await scheduler.run();

    // Filled exactly to the cap — no 4th claim while 3 are in flight.
    expect(mocked.claimNextJob).toHaveBeenCalledTimes(3);
    expect(scheduler.getActiveJobIds()).toEqual(["job-1", "job-2", "job-3"]);
    expect(mocked.sendHeartbeat).toHaveBeenLastCalledWith(admin, "worker-test", [
      "job-1",
      "job-2",
      "job-3",
    ]);
  });

  it("waits on the poll interval when there is no work", async () => {
    mocked.claimNextJob.mockResolvedValue({ outcome: "idle" });
    let shuttingDown = false;
    const delay = vi.fn(async () => {
      shuttingDown = true;
    });

    const scheduler = createScheduler(admin, config, {
      isShuttingDown: () => shuttingDown,
      delay,
    });

    await scheduler.run();

    expect(mocked.runClaimedJob).not.toHaveBeenCalled();
    expect(delay).toHaveBeenCalledWith(config.pollIntervalMs);
  });

  it("isolates a failing job and keeps claiming its siblings", async () => {
    const claims: ClaimNextResult[] = [job("job-1"), job("job-2"), { outcome: "idle" }];
    mocked.claimNextJob.mockImplementation(async () => claims.shift() ?? { outcome: "idle" });
    mocked.runClaimedJob.mockImplementation((_admin: never, j: { id: string }) =>
      j.id === "job-1" ? Promise.reject(new Error("boom")) : Promise.resolve(),
    );
    mocked.sendHeartbeat.mockResolvedValue(undefined);

    let shuttingDown = false;
    const scheduler = createScheduler(admin, config, {
      isShuttingDown: () => shuttingDown,
      // Shut down after the first wait phase so the loop is bounded.
      delay: async () => {
        shuttingDown = true;
      },
    });

    await expect(scheduler.run()).resolves.toBeUndefined();

    const ranIds = mocked.runClaimedJob.mock.calls.map((call) => call[1].id);
    expect(ranIds).toContain("job-1");
    expect(ranIds).toContain("job-2");
  });

  it("backs off when the claim RPC reports an error", async () => {
    mocked.claimNextJob.mockResolvedValue({ outcome: "error" });
    let shuttingDown = false;
    const delay = vi.fn(async () => {
      shuttingDown = true;
    });

    const scheduler = createScheduler(admin, config, {
      isShuttingDown: () => shuttingDown,
      delay,
    });

    await scheduler.run();

    expect(delay).toHaveBeenCalledWith(config.pollIntervalMs * 2);
    expect(mocked.runClaimedJob).not.toHaveBeenCalled();
  });
});
