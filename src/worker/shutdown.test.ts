import { describe, expect, it, vi } from "vitest";

import { finishWorkerShutdown } from "./shutdown";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("finishWorkerShutdown", () => {
  it("keeps timers and registration active until the scheduler drains", async () => {
    const idle = deferred();
    const order: string[] = [];
    const stopTimers = vi.fn(() => order.push("timers"));
    const deregister = vi.fn(async () => {
      order.push("deregister");
    });

    const shutdown = finishWorkerShutdown({
      deregister,
      scheduler: { waitForIdle: () => idle.promise },
      stopTimers,
    });

    await Promise.resolve();
    expect(stopTimers).not.toHaveBeenCalled();
    expect(deregister).not.toHaveBeenCalled();

    idle.resolve();
    await shutdown;

    expect(order).toEqual(["timers", "deregister"]);
  });
});
