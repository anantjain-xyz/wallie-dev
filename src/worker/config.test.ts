import { describe, expect, it } from "vitest";

import { parseWorkerConfig } from "./config";

describe("worker/config", () => {
  it("returns defaults when no env vars are set", () => {
    const config = parseWorkerConfig({});
    expect(config.pollIntervalMs).toBe(2_000);
    expect(config.heartbeatIntervalMs).toBe(10_000);
    expect(config.stallSweepIntervalMs).toBe(30_000);
    expect(config.reconcileIntervalMs).toBe(60_000);
    expect(config.sandboxReapIntervalMs).toBe(60_000);
    expect(config.defaultStallTimeoutMs).toBe(300_000);
    expect(config.defaultConcurrencyLimit).toBe(2);
    expect(config.workerId).toMatch(/^worker-/);
  });

  it("reads values from env vars", () => {
    const config = parseWorkerConfig({
      WALLIE_WORKER_POLL_INTERVAL_MS: "5000",
      WALLIE_WORKER_HEARTBEAT_INTERVAL_MS: "15000",
      WALLIE_WORKER_STALL_SWEEP_INTERVAL_MS: "60000",
      WALLIE_WORKER_RECONCILE_INTERVAL_MS: "120000",
      WALLIE_WORKER_SANDBOX_REAP_INTERVAL_MS: "90000",
      WALLIE_WORKER_DEFAULT_STALL_TIMEOUT_MS: "600000",
      WALLIE_WORKER_DEFAULT_CONCURRENCY_LIMIT: "5",
      WALLIE_WORKER_ID: "my-worker",
    });
    expect(config.pollIntervalMs).toBe(5_000);
    expect(config.heartbeatIntervalMs).toBe(15_000);
    expect(config.stallSweepIntervalMs).toBe(60_000);
    expect(config.reconcileIntervalMs).toBe(120_000);
    expect(config.sandboxReapIntervalMs).toBe(90_000);
    expect(config.defaultStallTimeoutMs).toBe(600_000);
    expect(config.defaultConcurrencyLimit).toBe(5);
    expect(config.workerId).toBe("my-worker");
  });

  it("ignores empty string env vars and uses defaults", () => {
    const config = parseWorkerConfig({
      WALLIE_WORKER_POLL_INTERVAL_MS: "",
      WALLIE_WORKER_ID: "w1",
    });
    expect(config.pollIntervalMs).toBe(2_000);
  });

  it("rejects poll interval below minimum", () => {
    expect(() =>
      parseWorkerConfig({
        WALLIE_WORKER_POLL_INTERVAL_MS: "100",
      }),
    ).toThrow();
  });
});
