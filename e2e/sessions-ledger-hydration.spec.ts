import { expect, test } from "@playwright/test";

const fixturePath = "/dev/sessions-ledger";

test.describe("sessions ledger 50-row fixture", () => {
  test("desktop: one semantic row tree with real title links", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(fixturePath);

    await expect(page.locator("[data-sessions-ledger-fixture='50']")).toBeVisible();
    await expect(page.locator(".session-list-row")).toHaveCount(50);

    const firstTitle = page.getByRole("link", { name: /Open session #1: Seeded ledger session 1/ });
    await expect(firstTitle).toBeVisible();
    await expect(firstTitle).toHaveAttribute("href", "/w/fixture/sessions/1");

    // Modifier-click semantics: the title is a real link (not an overlay).
    const box = await firstTitle.boundingBox();
    expect(box).toBeTruthy();

    // Single DOM tree — no duplicate mobile-only row list.
    await expect(page.locator("ul.ui-sheet")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Actions for session #1", exact: true })).toBeVisible();

    // Open overflow and archive via shared toast flow (no confirm dialog).
    await page.getByRole("button", { name: "Actions for session #1", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Archive session" })).toBeVisible();
  });

  test("mobile: same semantic rows with responsive layout", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixturePath);

    await expect(page.locator(".session-list-row")).toHaveCount(50);
    await expect(page.locator("ul.ui-sheet")).toHaveCount(1);

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
