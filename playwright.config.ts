import { defineConfig, devices } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT ?? "3100";
const host = process.env.PLAYWRIGHT_HOST ?? "localhost";
const localAppUrl = `http://${host}:${port}`;

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
    baseURL: localAppUrl,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm start --hostname ${host} --port ${port}`,
    env: {
      ...process.env,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? localAppUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "playwright-local-key",
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
    },
    reuseExistingServer: false,
    timeout: 30_000,
    url: localAppUrl,
  },
  workers: 1,
});
