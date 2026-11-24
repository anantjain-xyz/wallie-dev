import { setImmediate } from "node:timers/promises";

import type { TimerTaskTracker } from "./shutdown";

type SlackInboxMaintenance = {
  label?: string;
  drainBatch: () => Promise<boolean>;
  isShuttingDown: () => boolean;
  timerTasks: Pick<TimerTaskTracker, "run">;
};

export function createSlackInboxMaintenance({
  label = "Slack connector inbox",
  drainBatch,
  isShuttingDown,
  timerTasks,
}: SlackInboxMaintenance) {
  let running = false;

  return function drainSlackInbox() {
    if (running || isShuttingDown()) return;
    running = true;

    timerTasks.run(label, async () => {
      try {
        while (!isShuttingDown() && (await drainBatch())) {
          await setImmediate();
        }
      } finally {
        running = false;
      }
    });
  };
}
