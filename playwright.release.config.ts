import { defineConfig, devices } from "@playwright/test";

import base from "./playwright.config";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!supabaseUrl || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(supabaseUrl).hostname)) {
  throw new Error(
    "Release checks require NEXT_PUBLIC_SUPABASE_URL for a disposable local Supabase stack.",
  );
}
if (!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || !process.env.SUPABASE_SECRET_KEY) {
  throw new Error(
    "Export the local Supabase publishable and service-role keys before release checks.",
  );
}

/** Browser-engine release checks; provider execution remains a separate rehearsal. */
export default defineConfig({
  ...base,
  testMatch: [
    "responsive-polish.spec.ts",
    "route-recovery.spec.ts",
    "auth-session.spec.ts",
    "invitation-recovery.spec.ts",
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
