import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

const nativeHistoryFixture = process.env.WALLIE_NATIVE_HISTORY_FIXTURE;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      ...(nativeHistoryFixture
        ? {
            miniflare: {
              bindings: {
                WALLIE_NATIVE_HISTORY_FIXTURE: nativeHistoryFixture,
                WALLIE_ORDERED_RUN_CAPTURE_ENABLED: "true",
                WALLIE_WORKER_DISPATCH_ENABLED: "false",
                WALLIE_WORKER_AUTH_ENABLED: "false",
              },
            },
          }
        : {}),
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./server-only.ts", import.meta.url)),
      undici: fileURLToPath(new URL("./undici.mjs", import.meta.url)),
      "@vercel/oidc": fileURLToPath(new URL("./vercel-oidc.mjs", import.meta.url)),
      "isomorphic-ws": fileURLToPath(new URL("./websocket.ts", import.meta.url)),
    },
  },
  test: {
    include: ["cloudflare/tests/**/*.test.ts"],
    globals: true,
  },
});
