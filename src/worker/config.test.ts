import { afterEach, describe, expect, it } from "vitest";

import { parseWorkerConfig } from "./config";

describe("worker/config", () => {
  afterEach(() => {
    delete process.env.WORKER_MAX_CONCURRENT_JOBS;
  });

  it("returns sensible defaults and a generated worker id", () => {
    const config = parseWorkerConfig();
    expect(config.pollIntervalMs).toBe(2_000);
    expect(config.heartbeatIntervalMs).toBe(10_000);
    expect(config.stallSweepIntervalMs).toBe(30_000);
    expect(config.reconcileIntervalMs).toBe(60_000);
    expect(config.sandboxReapIntervalMs).toBe(60_000);
    expect(config.defaultStallTimeoutMs).toBe(900_000);
    expect(config.defaultConcurrencyLimit).toBe(2);
    expect(config.maxConcurrentJobs).toBe(10);
    expect(config.workerId).toMatch(/^worker-/);
  });

  it("honors WORKER_MAX_CONCURRENT_JOBS when it is a positive integer", () => {
    process.env.WORKER_MAX_CONCURRENT_JOBS = "4";
    expect(parseWorkerConfig().maxConcurrentJobs).toBe(4);
  });

  it("falls back to the default when WORKER_MAX_CONCURRENT_JOBS is invalid", () => {
    for (const value of ["0", "-3", "abc", "2.5", ""]) {
      process.env.WORKER_MAX_CONCURRENT_JOBS = value;
      expect(parseWorkerConfig().maxConcurrentJobs).toBe(10);
    }
  });
});
