import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, remoteBindings: false }),
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
