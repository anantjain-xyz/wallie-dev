import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

const nativeHistoryFixture = process.env.WALLIE_NATIVE_HISTORY_FIXTURE;
const factoryRuntimeFixture = process.env.WALLIE_FACTORY_RUNTIME_FIXTURE;
const factoryOutcomeFixture = process.env.WALLIE_FACTORY_OUTCOME_RUNTIME_FIXTURE;
const factoryAutomationFixture = process.env.WALLIE_FACTORY_AUTOMATION_RUNTIME_FIXTURE;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      ...(nativeHistoryFixture ||
      factoryRuntimeFixture ||
      factoryOutcomeFixture ||
      factoryAutomationFixture
        ? {
            miniflare: {
              bindings: {
                ...(nativeHistoryFixture && {
                  WALLIE_NATIVE_HISTORY_FIXTURE: nativeHistoryFixture,
                }),
                ...(factoryRuntimeFixture && {
                  WALLIE_FACTORY_RUNTIME_FIXTURE: factoryRuntimeFixture,
                }),
                ...(factoryOutcomeFixture && {
                  WALLIE_FACTORY_OUTCOME_RUNTIME_FIXTURE: factoryOutcomeFixture,
                }),
                ...(factoryAutomationFixture && {
                  WALLIE_FACTORY_AUTOMATION_RUNTIME_FIXTURE: factoryAutomationFixture,
                }),
                ...((factoryRuntimeFixture ||
                  factoryOutcomeFixture ||
                  factoryAutomationFixture) && {
                  WALLIE_ENCRYPTION_KEY: process.env.WALLIE_ENCRYPTION_KEY,
                  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
                  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
                    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
                  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
                }),
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
