import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig, devices } from "@playwright/test";

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

const port = process.env.PLAYWRIGHT_PORT ?? "3100";
const host = process.env.PLAYWRIGHT_HOST ?? "localhost";
const listenHost = process.env.PLAYWRIGHT_LISTEN_HOST ?? host;
const localAppUrl = `http://${host}:${port}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      // Baselines are authored in the Playwright Linux container used by CI.
      // Local macOS runs may differ slightly in font rasterization; keep the
      // threshold tight enough to catch layout/theme regressions.
      maxDiffPixelRatio: 0.04,
      threshold: 0.2,
    },
  },
  forbidOnly: isCI,
  fullyParallel: false,
  reporter: isCI ? [["list"], ["github"]] : "list",
  retries: isCI ? 1 : 0,
  testDir: "./e2e",
  timeout: 60_000,
  // Platform-scoped baselines: CI (linux) is the source of truth; darwin may also
  // commit snapshots for local flake/prove runs without fighting font rasterization.
  snapshotPathTemplate: "{testDir}/{testFileDir}/{testFileName}-snapshots/{platform}/{arg}{ext}",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: localAppUrl,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    // Bind the listen address separately from the Playwright baseURL host so Docker
    // clients can reach a host-published server via host.docker.internal.
    command: `pnpm start --hostname ${listenHost} --port ${port}`,
    env: {
      ...process.env,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? localAppUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
      WALLIE_SANDBOX_IMPL: process.env.WALLIE_SANDBOX_IMPL ?? "fake",
    },
    reuseExistingServer: !isCI || process.env.PLAYWRIGHT_REUSE_SERVER === "1",
    timeout: 120_000,
    url: localAppUrl,
  },
  workers: 1,
});
