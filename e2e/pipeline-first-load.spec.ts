import { readFileSync, readdirSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { signIn } from "./helpers/auth";

const workspacePath = "/w/acme-corp";

test("Pipeline filters work while the realtime SDK loads", async ({ browser, page: authPage }) => {
  await signIn(authPage, workspacePath);
  const context = await browser.newContext({
    baseURL: new URL(authPage.url()).origin,
    storageState: await authPage.context().storageState(),
  });
  const page = await context.newPage();
  const sdkChunks = new Set(
    readdirSync(".next/static/chunks").filter(
      (file) =>
        file.endsWith(".js") &&
        readFileSync(`.next/static/chunks/${file}`, "utf8").includes("GoTrueClient"),
    ),
  );
  expect(sdkChunks.size).toBeGreaterThan(0);
  let releaseSdk!: () => void;
  const sdkGate = new Promise<void>((resolve) => {
    releaseSdk = resolve;
  });
  let sdkRequested = false;
  await page.route("**/_next/static/chunks/*.js", async (route) => {
    if (sdkChunks.has(new URL(route.request().url()).pathname.split("/").at(-1)!)) {
      sdkRequested = true;
      await sdkGate;
    }
    await route.continue();
  });

  try {
    await page.goto(workspacePath, { waitUntil: "commit" });
    await expect(page.getByRole("region", { name: "Pipeline board" })).toBeVisible();
    await expect.poll(() => sdkRequested).toBe(true);
    const cards = page.locator("[data-session-id]");
    const initialCount = await cards.count();
    expect(initialCount).toBeGreaterThan(0);
    const search = page.getByRole("searchbox", { name: "Search pipeline sessions" });
    await search.fill("no-matching-session-first-load-proof");
    await expect(cards).toHaveCount(0);
    await search.fill("");
    await expect(cards).toHaveCount(initialCount);
    releaseSdk();

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "GitHub", exact: true })).toBeVisible();
  } finally {
    releaseSdk();
    await context.close();
  }
});
