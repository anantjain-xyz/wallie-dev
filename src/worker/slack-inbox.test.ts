import { describe, expect, it, vi } from "vitest";

import { createTimerTaskTracker } from "./shutdown";
import { createSlackInboxMaintenance } from "./slack-inbox";

describe("Slack inbox maintenance", () => {
  it("continues a full sweep promptly and ignores overlapping timer ticks", async () => {
    const started = Promise.withResolvers<void>();
    const activeBatch = Promise.withResolvers<boolean>();
    const drainBatch = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    drainBatch.mockImplementationOnce(() => {
      started.resolve();
      return activeBatch.promise;
    });
    const timerTasks = createTimerTaskTracker();
    const drain = createSlackInboxMaintenance({
      drainBatch,
      isShuttingDown: () => false,
      timerTasks,
    });

    drain();
    await started.promise;
    drain();
    expect(drainBatch).toHaveBeenCalledTimes(1);

    activeBatch.resolve(true);
    await timerTasks.waitForIdle();
    expect(drainBatch).toHaveBeenCalledTimes(2);
  });

  it("waits for an active batch during shutdown and skips the next claim", async () => {
    const started = Promise.withResolvers<void>();
    const activeBatch = Promise.withResolvers<boolean>();
    const drainBatch = vi.fn(() => {
      started.resolve();
      return activeBatch.promise;
    });
    let shuttingDown = false;
    const timerTasks = createTimerTaskTracker();
    const drain = createSlackInboxMaintenance({
      drainBatch,
      isShuttingDown: () => shuttingDown,
      timerTasks,
    });

    drain();
    await started.promise;
    shuttingDown = true;
    const idle = vi.fn();
    const waitingForIdle = timerTasks.waitForIdle().then(idle);
    await Promise.resolve();
    expect(idle).not.toHaveBeenCalled();

    activeBatch.resolve(true);
    await waitingForIdle;
    drain();
    expect(idle).toHaveBeenCalledOnce();
    expect(drainBatch).toHaveBeenCalledOnce();
  });

  it("allows the next timer tick after a batch fails", async () => {
    const error = new Error("claim failed");
    const onError = vi.fn();
    const drainBatch = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    drainBatch.mockRejectedValueOnce(error);
    const timerTasks = createTimerTaskTracker(onError);
    const drain = createSlackInboxMaintenance({
      drainBatch,
      isShuttingDown: () => false,
      timerTasks,
    });

    drain();
    await timerTasks.waitForIdle();
    drain();
    await timerTasks.waitForIdle();

    expect(onError).toHaveBeenCalledExactlyOnceWith("Slack connector inbox", error);
    expect(drainBatch).toHaveBeenCalledTimes(2);
  });
});
