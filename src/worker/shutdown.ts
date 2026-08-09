import type { Scheduler } from "./scheduler";

export interface FinishWorkerShutdownInput {
  deregister: () => Promise<void>;
  scheduler: Pick<Scheduler, "waitForIdle">;
  stopTimers: () => void;
}

/**
 * Finish a graceful worker shutdown after the scheduler has stopped claiming
 * new jobs. Timers intentionally remain active while jobs drain so the worker
 * continues advertising ownership of its in-flight set.
 */
export async function finishWorkerShutdown(input: FinishWorkerShutdownInput): Promise<void> {
  await input.scheduler.waitForIdle();
  input.stopTimers();
  await input.deregister();
}
