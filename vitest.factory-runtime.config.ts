import { defineConfig } from "vitest/config";

import base from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      "test/release/factory-runtime.node.fixture.ts",
      "test/release/factory-diagnosis.node.fixture.ts",
      "test/release/factory-benchmark-qualification.node.fixture.ts",
      "test/release/connector-conformance.node.fixture.ts",
    ],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
