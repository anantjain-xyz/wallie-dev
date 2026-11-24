import { setImmediate } from "node:timers/promises";

import type { TimerTaskTracker } from "./shutdown";

type SlackInboxMaintenance = {
  drainBatch: () => Promise<boolean>;
  isShuttingDown: () => boolean;
  timerTasks: Pick<TimerTaskTracker, "run">;
};

export function createSlackInboxMaintenance({
  drainBatch,
  isShuttingDown,
  timerTasks,
}: SlackInboxMaintenance) {
  let running = false;

  return function drainSlackInbox() {
    if (running || isShuttingDown()) return;
    running = true;

    timerTasks.run("Slack connector inbox", async () => {
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
