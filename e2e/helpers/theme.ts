import { expect, type Page } from "@playwright/test";

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const REGRESSION_VIEWPORTS = [
  { height: 844, name: "mobile", width: 390 },
  { height: 1000, name: "desktop", width: 1440 },
] as const;

export async function applyTheme(page: Page, theme: Theme) {
  await page.evaluate((nextTheme) => {
    window.localStorage.setItem("wallie-theme", nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, theme);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

export async function settleForScreenshot(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "reduce";
  });
  const main = page.locator("#main-content, main, [data-testid='status-fixtures'], body").first();
  await expect(page.locator("body")).toBeVisible();
  // Prefer the app main landmark when present; fixture labs may omit it.
  const hasMain = await page.locator("#main-content, main").count();
  if (hasMain > 0) {
    await expect(page.locator("#main-content, main").first()).toBeVisible();
  } else {
    await expect(main).toBeVisible();
  }
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(150);
}
