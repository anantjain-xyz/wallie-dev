import type { Scheduler } from "./scheduler";

export interface FinishWorkerShutdownInput {
  deregister: () => Promise<void>;
  scheduler: Pick<Scheduler, "waitForIdle">;
  stopTimers: () => void;
  timerTasks: Pick<TimerTaskTracker, "waitForIdle">;
}

export interface TimerTaskTracker {
  run(label: string, task: () => Promise<void>): void;
  waitForIdle(): Promise<void>;
}

type TimerTaskErrorHandler = (label: string, error: unknown) => void;

/** Track fire-and-forget timer callbacks so graceful shutdown can await them. */
export function createTimerTaskTracker(
  onError: TimerTaskErrorHandler = logTimerTaskError,
): TimerTaskTracker {
  const activeTasks = new Set<Promise<void>>();

  function run(label: string, task: () => Promise<void>): void {
    const trackedTask = Promise.resolve()
      .then(task)
      .catch((error) => onError(label, error))
      .finally(() => activeTasks.delete(trackedTask));
    activeTasks.add(trackedTask);
  }

  async function waitForIdle(): Promise<void> {
    await Promise.allSettled([...activeTasks]);
  }

  return { run, waitForIdle };
}

/**
 * Finish a graceful worker shutdown after the scheduler has stopped claiming
 * new jobs. Timers intentionally remain active while jobs drain so the worker
 * continues advertising ownership of its in-flight set.
 */
export async function finishWorkerShutdown(input: FinishWorkerShutdownInput): Promise<void> {
  await input.scheduler.waitForIdle();
  input.stopTimers();
  await input.timerTasks.waitForIdle();
  await input.deregister();
}

function logTimerTaskError(label: string, error: unknown): void {
  console.error(`[worker] ${label} failed`, {
    error: error instanceof Error ? error.message : String(error),
  });
}
