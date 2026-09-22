import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

let runCommand: (
  command: string,
  args: string[],
  options: { processGroup: boolean; signal: AbortSignal; timeout: number },
) => Promise<string>;
beforeAll(async () => {
  const script = new URL("../../../scripts/publish-aws-image.mjs", import.meta.url).href;
  ({ runCommand } = await import(script));
});

function running(pid: number) {
  try {
    process.kill(pid, 0);
    // A killed orphan may briefly remain as a zombie while the OS reaps it.
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .startsWith("Z");
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("credentialed command process groups", () => {
  it.each(["success", "timeout"])(
    "reports cleanup denial without losing the original %s outcome",
    async (mode) => {
      const kill = process.kill.bind(process);
      let terminated = false;
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid < 0 && signal === "SIGKILL") {
          if (mode === "success" || terminated) {
            throw Object.assign(new Error("already-exited process group"), { code: "EPERM" });
          }
          const result = kill(pid, signal);
          terminated = true;
          return result;
        }
        return kill(pid, signal);
      });
      try {
        await expect(
          runCommand(
            process.execPath,
            ["--eval", mode === "timeout" ? "setInterval(() => {}, 1000)" : ""],
            { processGroup: true, signal: new AbortController().signal, timeout: 1000 },
          ),
        ).rejects.toThrow(mode === "timeout" ? "timeout" : "process-group termination failed");
      } finally {
        killSpy.mockRestore();
      }
    },
  );

  it.each(["abort", "timeout", "success", "output limit"])(
    "stops a harmless child and grandchild after %s",
    async (mode) => {
      const directory = mkdtempSync(join(tmpdir(), "wallie-command-group-"));
      const pidPaths = ["parent", "child", "grandchild"].map((name) => join(directory, name));
      const ready = join(directory, "ready");
      const leaf = `
        const fs = require('node:fs');
        process.on('SIGTERM', () => {});
        fs.writeFileSync(${JSON.stringify(pidPaths[2])}, String(process.pid));
        setInterval(() => {}, 1000);
      `;
      const middle = `
        const fs = require('node:fs');
        process.on('SIGTERM', () => {});
        require('node:child_process').spawn(process.execPath, ['--eval', ${JSON.stringify(leaf)}], {stdio: 'ignore'});
        fs.writeFileSync(${JSON.stringify(pidPaths[1])}, String(process.pid));
        setInterval(() => {}, 1000);
      `;
      const parent = `
        const fs = require('node:fs');
        require('node:child_process').spawn(process.execPath, ['--eval', ${JSON.stringify(middle)}], {stdio: 'ignore'});
        fs.writeFileSync(${JSON.stringify(pidPaths[0])}, String(process.pid));
        const timer = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(pidPaths[2])})) return;
          fs.writeFileSync(${JSON.stringify(ready)}, 'yes');
          clearInterval(timer);
          if (${JSON.stringify(mode)} === 'success') process.exit(0);
          if (${JSON.stringify(mode)} === 'output limit') process.stdout.write('x'.repeat(33 * 1024 * 1024));
        }, 20);
        setInterval(() => {}, 1000);
      `;
      const controller = new AbortController();
      const result = runCommand(process.execPath, ["--eval", parent], {
        processGroup: true,
        signal: controller.signal,
        timeout: mode === "timeout" ? 4000 : 8000,
      }).then(
        (output) => ({ output, error: undefined }),
        (error: Error) => ({ output: undefined, error }),
      );
      try {
        await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 3000 });
        const pids = pidPaths.map((path) => Number(readFileSync(path, "utf8")));
        if (mode === "abort") controller.abort();
        const outcome = await result;
        if (mode === "success") expect(outcome.error).toBeUndefined();
        else expect(outcome.error?.message).toContain(mode === "abort" ? "interrupted" : mode);
        await vi.waitFor(() => expect(pids.filter(running)).toEqual([]), { timeout: 2000 });
      } finally {
        controller.abort();
        try {
          // Check known fixture PIDs so cleanup never signals an already-dead group.
          for (const path of pidPaths.filter(existsSync)) {
            const pid = Number(readFileSync(path, "utf8"));
            if (!running(pid)) continue;
            try {
              process.kill(pid, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
          }
        } finally {
          await result;
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
    12_000,
  );
});
