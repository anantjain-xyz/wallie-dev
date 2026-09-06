import { expect, test } from "@playwright/test";

import { signIn } from "./helpers/auth";

test("invalid invitation preserves sign-in destination and offers a usable return", async ({
  page,
}, testInfo) => {
  const invitationPath = `/invite/release-check-${crypto.randomUUID()}`;
  await page.goto(invitationPath);
  await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(invitationPath)}$`));
  await signIn(page);

  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const response = await page.goto(invitationPath);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Invitation not found");
    await expect(
      page.getByRole("button", { name: "Sign out and try another account" }),
    ).toHaveCount(0);
    const returnLink = page.getByRole("link", { name: "Back to Wallie" });
    await expect(returnLink).toBeVisible();
    expect((await returnLink.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: testInfo.outputPath(`invitation-${width}.png`), fullPage: true });
  }

  await page.getByRole("link", { name: "Back to Wallie" }).click();
  await expect(page).toHaveURL(/\/w\/acme-corp$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pipeline");
});
