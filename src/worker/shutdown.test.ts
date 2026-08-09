import { describe, expect, it, vi } from "vitest";

import { createTimerTaskTracker, finishWorkerShutdown } from "./shutdown";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("finishWorkerShutdown", () => {
  it("keeps registration active until jobs and running timer tasks drain", async () => {
    const schedulerIdle = deferred();
    const timerTasksIdle = deferred();
    const order: string[] = [];
    const stopTimers = vi.fn(() => order.push("timers"));
    const deregister = vi.fn(async () => {
      order.push("deregister");
    });

    const shutdown = finishWorkerShutdown({
      deregister,
      scheduler: { waitForIdle: () => schedulerIdle.promise },
      stopTimers,
      timerTasks: { waitForIdle: () => timerTasksIdle.promise },
    });

    await Promise.resolve();
    expect(stopTimers).not.toHaveBeenCalled();
    expect(deregister).not.toHaveBeenCalled();

    schedulerIdle.resolve();
    await schedulerIdle.promise;
    await Promise.resolve();
    expect(stopTimers).toHaveBeenCalledOnce();
    expect(deregister).not.toHaveBeenCalled();

    timerTasksIdle.resolve();
    await shutdown;

    expect(order).toEqual(["timers", "deregister"]);
  });
});

describe("createTimerTaskTracker", () => {
  it("waits for callbacks already running when timers are stopped", async () => {
    const task = deferred();
    const tracker = createTimerTaskTracker();
    tracker.run("sandbox reap", () => task.promise);

    let idle = false;
    const waiting = tracker.waitForIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    task.resolve();
    await waiting;
    expect(idle).toBe(true);
  });

  it("reports callback failures without rejecting shutdown", async () => {
    const onError = vi.fn();
    const tracker = createTimerTaskTracker(onError);
    const error = new Error("provider timeout");

    tracker.run("sandbox reap", async () => {
      throw error;
    });
    await expect(tracker.waitForIdle()).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith("sandbox reap", error);
  });
});
