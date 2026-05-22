import { describe, expect, it } from "vitest";

import { parseWorkerConfig } from "./config";

describe("worker/config", () => {
  it("returns sensible defaults and a generated worker id", () => {
    const config = parseWorkerConfig();
    expect(config.pollIntervalMs).toBe(2_000);
    expect(config.heartbeatIntervalMs).toBe(10_000);
    expect(config.stallSweepIntervalMs).toBe(30_000);
    expect(config.reconcileIntervalMs).toBe(60_000);
    expect(config.sandboxReapIntervalMs).toBe(60_000);
    expect(config.defaultStallTimeoutMs).toBe(900_000);
    expect(config.defaultConcurrencyLimit).toBe(2);
    expect(config.workerId).toMatch(/^worker-/);
  });
});
