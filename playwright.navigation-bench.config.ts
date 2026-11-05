import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

const port = process.env.PLAYWRIGHT_PORT ?? "3100";
const host = process.env.PLAYWRIGHT_HOST ?? "localhost";
const localAppUrl = `http://${host}:${port}`;
const timingLogPath = process.env.WALLIE_TIMING_LOG_PATH ?? "/tmp/wallie-navigation-bench.jsonl";

/** Production-build timings for the five logged-in navigation flows. */
export default defineConfig({
  ...base,
  expect: {
    timeout: 20_000,
  },
  testIgnore: [],
  testMatch: ["**/navigation-bench.benchmark.spec.ts"],
  timeout: 12 * 60 * 1000,
  webServer: {
    command: `pnpm start --hostname ${host} --port ${port}`,
    env: {
      ...process.env,
      NEXT_PUBLIC_APP_URL: localAppUrl,
      WALLIE_DEPLOY_ENV: "preview",
      WALLIE_TIMING_LOG_PATH: timingLogPath,
      WALLIE_TIMING_LOGS: "1",
    },
    reuseExistingServer: false,
    timeout: 60_000,
    url: localAppUrl,
  },
});
