import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers/auth";

declare global {
  interface Window {
    interactionAnimations: number;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.interactionAnimations = 0;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (...args: Parameters<typeof original>) {
      window.interactionAnimations++;
      return original.apply(this, args);
    };
  });
  await signIn(page);
  await page.goto("/dev/interaction-motion");
});

for (const mobile of [false, true]) {
  test(`semantic changes animate without replaying on refresh (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => window.interactionAnimations)).toBe(0);
    const ready = page.getByRole("button", { name: "Ready for review", exact: true });
    await ready.click();
    await expect(page.getByText("Build · Ready for your review")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.interactionAnimations)).toBe(2);
    await expect(ready).toBeFocused();
    await page.getByRole("button", { name: "Refresh snapshot" }).click();
    await expect(page.getByText("Snapshot refreshes: 1")).toBeVisible();
    expect(await page.evaluate(() => window.interactionAnimations)).toBe(2);
    await page.getByRole("tab", { name: "Raw", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.interactionAnimations)).toBe(3);
    await page.getByRole("button", { name: "New artifact version" }).click();
    await expect(page.locator("pre")).toContainText("Version 2");
    await expect.poll(() => page.evaluate(() => window.interactionAnimations)).toBe(4);
    await page.getByRole("button", { name: "Complete session" }).click();
    await expect(page.getByRole("heading", { name: "Session complete" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.interactionAnimations)).toBe(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.locator("main").evaluate(async (main) => {
      await Promise.all(
        main
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await mkdir(".wallie/screenshots", { recursive: true });
    await page.screenshot({
      path: `.wallie/screenshots/interaction-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
  });
}

test("copy feedback waits for success, stays local, and exposes failures", async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
  });
  await page.getByRole("tab", { name: "Raw", exact: true }).click();
  const copy = page.getByRole("button", { name: "Copy Markdown", exact: true });
  const width = (await copy.boundingBox())?.width;
  await copy.click();
  const copied = page.getByRole("button", { name: "Copied", exact: true });
  await expect(copied).toBeVisible();
  await expect(copied).toBeFocused();
  expect((await copied.boundingBox())?.width).toBe(width);
  await page.screenshot({ path: ".wallie/screenshots/artifact-copied.png", fullPage: true });
  await expect(copy).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });
  await copy.click();
  await expect(page.getByText("Could not copy Markdown.")).toBeVisible();
  await expect(copy).toBeEnabled();
  await expect(copied).toHaveCount(0);
});

test("dialog exits finish and return focus; both reduced-motion preferences suppress entrances", async ({
  page,
}) => {
  const trigger = page.getByRole("button", { name: "Open dialog" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Interaction preview" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Ready for review", exact: true }).click();
  await expect(page.getByText("Build · Ready for your review")).toBeVisible();
  expect(await page.evaluate(() => window.interactionAnimations)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "reduce";
  });
  await page.getByRole("button", { name: "Complete session" }).click();
  await expect(page.getByRole("heading", { name: "Session complete" })).toBeVisible();
  expect(await page.evaluate(() => window.interactionAnimations)).toBe(0);
});

test("a failed archive restores its row with feedback and an entrance", async ({ page }) => {
  await page.goto("/w/acme-corp/sessions");
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sessions/*/archive", async (route) => {
    await responseGate;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      json: { error: "Archive unavailable" },
    });
  });
  try {
    const trigger = page.getByRole("button", { name: "Actions for session #1", exact: true });
    await trigger.click();
    await page.getByRole("menuitem", { name: "Archive session" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Archive session", exact: true })
      .click();
    await expect(trigger).toHaveCount(0);
    await page.evaluate(() => {
      window.interactionAnimations = 0;
    });
    release();
    await expect(trigger).toBeVisible();
    await expect(page.getByText("Archive unavailable", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.interactionAnimations)).toBe(1);
    await page.screenshot({ path: ".wallie/screenshots/archive-restored.png", fullPage: true });
  } finally {
    release();
  }
});

test("historical selection animates the loaded artifact across Versions unmounts", async ({
  page,
}) => {
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sessions/preview/artifacts?*", async (route) => {
    const version = new URL(route.request().url()).searchParams.get("version");
    if (version) {
      await responseGate;
      await route.fulfill({
        json: {
          artifact: {
            createdAt: "2026-09-06T12:00:00Z",
            stageSlug: "build",
            version: 1,
            payload: "# Historical artifact",
            sanitizedHtml: "<h2>Historical artifact</h2>",
          },
        },
      });
    } else {
      await route.fulfill({
        json: {
          artifacts: [2, 1].map((value) => ({
            attempt: value,
            authorLabel: "Codex",
            changesRequested: false,
            createdAt: "2026-09-06T12:00:00Z",
            stageSlug: "build",
            version: value,
          })),
        },
      });
    }
  });
  try {
    await page.getByRole("button", { name: "New artifact version" }).click();
    await expect.poll(() => page.evaluate(() => window.interactionAnimations)).toBe(1);
    await page.getByRole("tab", { name: "Versions", exact: true }).click();
    await page.getByRole("button", { name: /Version 1/ }).click();
    await expect(page.getByRole("tab", { name: "Rendered", exact: true })).toBeFocused();
    expect(await page.evaluate(() => window.interactionAnimations)).toBe(1);
    release();
    await expect(page.getByRole("heading", { name: "Historical artifact" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.interactionAnimations)).toBe(2);
    await page.getByRole("tab", { name: "Versions", exact: true }).click();
    await page.getByRole("button", { name: /Version 2/ }).click();
    await expect.poll(() => page.evaluate(() => window.interactionAnimations)).toBe(3);
    await page.getByRole("tab", { name: "Versions", exact: true }).click();
    await page.getByRole("button", { name: /Version 1/ }).click();
    await expect(page.getByRole("heading", { name: "Historical artifact" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.interactionAnimations)).toBe(4);
  } finally {
    release();
  }
});
