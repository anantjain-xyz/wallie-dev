import { defineConfig } from "vitest/config";

import base from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["test/release/factory-runtime.node.fixture.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
