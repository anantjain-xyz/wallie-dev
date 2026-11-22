import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "factory-improvement-loop-qualification.spec.ts",
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.PLAYWRIGHT_BASE_URL,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
