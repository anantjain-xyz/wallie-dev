import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("sandbox repository token worker imports", () => {
  it("loads the real helper and ESM-only Octokit with the worker's tsx runtime", () => {
    // Vitest's module loader and Octokit mocks do not exercise the worker's
    // CommonJS resolution. Use the production preloads in a fresh process.
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/install-crash-handlers.mjs",
        "--import",
        "./scripts/register-server-only.mjs",
        "--import",
        "tsx",
        "--eval",
        `
            (async () => {
              const assert = require("node:assert/strict");
              const { mintSandboxRepositoryToken } = require("./src/features/github/sandbox-token.ts");
              assert.equal(typeof mintSandboxRepositoryToken, "function");
              const { App } = await import("@octokit/app");
              assert.equal(typeof App, "function");
              console.log("worker imports ready");
            })().catch((error) => {
              console.error(error.code || error.name, error.message);
              process.exitCode = 1;
            });
          `,
      ],
      {
        cwd: root,
        encoding: "utf8",
        // Do not inherit credentials, NODE_OPTIONS, or local environment files.
        env: { NODE_ENV: "test" },
        timeout: 10_000,
        killSignal: "SIGKILL",
      },
    );

    expect(result.error?.message).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("worker imports ready");
  }, 15_000);
});
