import { defineConfig } from "vitest/config";

import base from "./vitest.config";

// Explicit release gate: ordinary `pnpm test` remains independent of local DBs.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["test/release/**/*.fixture.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    pool: "forks",
    testTimeout: 180_000,
    hookTimeout: 60_000,
    env: { WALLIE_SANDBOX_IMPL: "fake" },
  },
});
