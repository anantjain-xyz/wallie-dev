import { defineConfig, devices } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT ?? "3100";

export default defineConfig({
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  reporter: "list",
  testDir: "./e2e",
  timeout: 45_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm start --port ${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
    url: `http://127.0.0.1:${port}`,
  },
  workers: 1,
});
