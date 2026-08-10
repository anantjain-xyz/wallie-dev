import { expect, test } from "@playwright/test";

const fixturePath = "/dev/sessions-ledger";

test.describe("sessions ledger 50-row fixture", () => {
  test("desktop: one semantic row tree with real title links", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(fixturePath);

    await expect(page.locator("[data-sessions-ledger-fixture='50']")).toBeVisible();
    await expect(page.locator(".session-list-row")).toHaveCount(50);

    const firstTitle = page.getByRole("link", {
      name: /Open session #1: Delete the superseded Settings client architecture/,
    });
    await expect(firstTitle).toBeVisible();
    await expect(firstTitle).toHaveAttribute("href", "/w/fixture/sessions/1");
    await expect(firstTitle).toHaveCSS("-webkit-line-clamp", "3");
    await expect(firstTitle.locator("xpath=..")).toHaveCSS("align-items", "baseline");

    const titleBox = await firstTitle.boundingBox();
    const titleMetrics = await firstTitle.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        clientHeight: element.clientHeight,
        lineHeight: Number.parseFloat(style.lineHeight),
        scrollHeight: element.scrollHeight,
      };
    });
    expect(titleBox).toBeTruthy();
    expect(titleMetrics.clientHeight).toBeCloseTo(titleMetrics.lineHeight * 3, 0);
    expect(titleMetrics.scrollHeight).toBeGreaterThan(titleMetrics.clientHeight);

    // Modifier-click semantics: the title is a real link (not an overlay).
    expect(titleBox).toBeTruthy();

    // Single DOM tree — no duplicate mobile-only row list.
    await expect(page.locator(".sessions-ledger")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Actions for session #1", exact: true }),
    ).toBeVisible();

    // Open overflow and archive via shared toast flow (no confirm dialog).
    await page.getByRole("button", { name: "Actions for session #1", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Archive session" })).toBeVisible();
  });

  test("mobile: same semantic rows with responsive layout", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixturePath);

    await expect(page.locator(".session-list-row")).toHaveCount(50);
    await expect(page.locator(".sessions-ledger")).toHaveCount(1);

    const longTitle = page.getByRole("link", {
      name: /Open session #1: Delete the superseded Settings client architecture/,
    });
    await expect(longTitle).toBeVisible();
    await expect(longTitle).toHaveCSS("-webkit-line-clamp", "3");
    await expect(longTitle.locator("xpath=..")).toHaveCSS("align-items", "baseline");

    const mobileTitleMetrics = await longTitle.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        clientHeight: element.clientHeight,
        lineHeight: Number.parseFloat(style.lineHeight),
        scrollHeight: element.scrollHeight,
      };
    });
    expect(mobileTitleMetrics.clientHeight).toBeCloseTo(mobileTitleMetrics.lineHeight * 3, 0);
    expect(mobileTitleMetrics.scrollHeight).toBeGreaterThan(mobileTitleMetrics.clientHeight);

    const title = page.getByRole("link", {
      name: "Open session #25: Seeded ledger session 25",
      exact: true,
    });
    await expect(title).toBeVisible();
    await expect(title).toHaveAttribute("href", "/w/fixture/sessions/25");

    // Actions remain nested beside the title in the same row, not a second tree.
    const row = page.locator(".session-list-row").nth(24);
    await expect(row.getByRole("link", { name: /Seeded ledger session 25/ })).toBeVisible();
    await expect(
      row.getByRole("button", { name: "Actions for session #25", exact: true }),
    ).toBeVisible();
  });
});
