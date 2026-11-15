import { access, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type Observation =
  | { file: "run-update" }
  | { file: "run-ready.json" | "run-complete.json"; body: Record<string, unknown> };

type BrowserMarker = "browser-offline" | "browser-closed" | "browser-verified";

export function browserHistoryHandshake() {
  const directory = process.env.WALLIE_RUN_HISTORY_BROWSER_HANDSHAKE_DIR;
  if (!directory) return null;

  return {
    async record(observation: Observation) {
      const target = join(directory, observation.file);
      const temporary = target + ".tmp";
      await writeFile(temporary, "body" in observation ? JSON.stringify(observation.body) : "", {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, target);
    },
    async waitFor(marker: BrowserMarker) {
      const target = join(directory, marker);
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        try {
          await access(join(directory, "browser-aborted"));
          throw new Error("The browser aborted the durable-history fixture.");
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }
        try {
          await access(target);
          return;
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }
        await delay(100);
      }
      throw new Error(`Browser history fixture timed out waiting for ${marker}.`);
    },
  };
}
