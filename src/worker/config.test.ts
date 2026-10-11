import { afterEach, describe, expect, it } from "vitest";

import { parseWorkerConfig } from "./config";

describe("worker/config", () => {
  afterEach(() => {
    delete process.env.WORKER_MAX_CONCURRENT_JOBS;
    delete process.env.WORKER_CONTROL_SOCKET;
    delete process.env.WORKER_JOB_TIMEOUT_MS;
  });

  it("returns sensible defaults and a generated worker id", () => {
    const config = parseWorkerConfig();
    expect(config.pollIntervalMs).toBe(2_000);
    expect(config.jobTimeoutMs).toBe(1_800_000);
    expect(config.heartbeatIntervalMs).toBe(10_000);
    expect(config.stallSweepIntervalMs).toBe(30_000);
    expect(config.reconcileIntervalMs).toBe(60_000);
    expect(config.sandboxReapIntervalMs).toBe(60_000);
    expect(config.defaultStallTimeoutMs).toBe(900_000);
    expect(config.defaultConcurrencyLimit).toBe(2);
    expect(config.maxConcurrentJobs).toBe(10);
    expect(config.workerId).toMatch(/^worker-/);
    expect(config.controlSocketPath).toBeUndefined();
  });

  it("validates an explicit attempt deadline", () => {
    process.env.WORKER_JOB_TIMEOUT_MS = "120000";
    expect(parseWorkerConfig().jobTimeoutMs).toBe(120000);
    for (const value of ["0", "-1", "1.5", "abc", "1800001"]) {
      process.env.WORKER_JOB_TIMEOUT_MS = value;
      expect(() => parseWorkerConfig()).toThrow();
    }
  });

  it("enables local control only with a valid explicit socket path", () => {
    process.env.WORKER_CONTROL_SOCKET = "/tmp/wallie-worker/control.sock";
    expect(parseWorkerConfig().controlSocketPath).toBe(process.env.WORKER_CONTROL_SOCKET);
    process.env.WORKER_CONTROL_SOCKET = "";
    expect(parseWorkerConfig().controlSocketPath).toBeUndefined();
    for (const value of ["relative.sock", `/${"x".repeat(100)}`]) {
      process.env.WORKER_CONTROL_SOCKET = value;
      expect(() => parseWorkerConfig()).toThrow();
    }
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
