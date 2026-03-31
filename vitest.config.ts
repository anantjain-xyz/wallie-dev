import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStubPath = fileURLToPath(
  new URL("./test/server-only-stub.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      "@": srcPath,
      "server-only": serverOnlyStubPath,
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
