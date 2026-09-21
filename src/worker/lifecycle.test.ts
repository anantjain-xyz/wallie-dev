import { describe, expect, it, vi } from "vitest";

import { createWorkerLifecycle } from "./lifecycle";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const jobs = deferred();
  const auxiliary = deferred();
  const maintenance = deferred();
  const input = {
    stopClaiming: vi.fn(),
    stopMaintenance: vi.fn(),
    stopAuxiliaryWork: vi.fn(() => auxiliary.promise),
    waitForJobs: vi.fn(() => jobs.promise),
    waitForMaintenance: vi.fn(() => maintenance.promise),
  };
  return { auxiliary, input, jobs, lifecycle: createWorkerLifecycle(input), maintenance };
}

describe("createWorkerLifecycle", () => {
  it("closes every intake immediately and waits for jobs, auxiliary release, and maintenance", async () => {
    const { auxiliary, input, jobs, lifecycle, maintenance } = setup();
    expect(lifecycle.getPhase()).toBe("running");
    lifecycle.requestDrain();
    lifecycle.requestDrain();

    expect(lifecycle.getPhase()).toBe("draining");
    expect(input.stopClaiming).toHaveBeenCalledOnce();
    expect(input.stopMaintenance).toHaveBeenCalledOnce();
    expect(input.stopAuxiliaryWork).toHaveBeenCalledOnce();
    jobs.resolve();
    await jobs.promise;
    expect(lifecycle.getPhase()).toBe("draining");
    auxiliary.resolve();
    await auxiliary.promise;
    expect(lifecycle.getPhase()).toBe("draining");
    maintenance.resolve();
    await vi.waitFor(() => expect(lifecycle.getPhase()).toBe("drained"));

    let exited = false;
    const stopped = lifecycle.waitForStop().then(() => {
      exited = true;
    });
    await Promise.resolve();
    expect(exited).toBe(false);
    lifecycle.requestDrain();
    expect(lifecycle.getPhase()).toBe("drained");
    lifecycle.requestStop();
    await stopped;
    expect(lifecycle.getPhase()).toBe("stopping");
    expect(exited).toBe(true);
  });

  it("handles a direct stop and repeated signals using one drain barrier", async () => {
    const { auxiliary, input, jobs, lifecycle, maintenance } = setup();
    lifecycle.requestStop();
    lifecycle.requestStop();
    lifecycle.requestDrain();
    expect(lifecycle.getPhase()).toBe("stopping");
    expect(input.stopClaiming).toHaveBeenCalledOnce();
    expect(input.stopAuxiliaryWork).toHaveBeenCalledOnce();

    let exited = false;
    const stopped = lifecycle.waitForStop().then(() => {
      exited = true;
    });
    jobs.resolve();
    maintenance.resolve();
    await Promise.resolve();
    expect(exited).toBe(false);
    auxiliary.resolve();
    await stopped;
    expect(exited).toBe(true);
    expect(lifecycle.getPhase()).toBe("stopping");
  });

  it("does not report drained when a drain dependency fails", async () => {
    const { input, jobs, auxiliary, maintenance } = setup();
    const failure = new Error("Unable to release auxiliary work");
    const lifecycle = createWorkerLifecycle({
      ...input,
      stopAuxiliaryWork: async () => {
        throw failure;
      },
    });
    lifecycle.requestDrain();
    const stopped = expect(lifecycle.waitForStop()).rejects.toThrow(failure);
    jobs.resolve();
    auxiliary.resolve();
    maintenance.resolve();
    await stopped;
    expect(lifecycle.getPhase()).toBe("draining");
  });
});
