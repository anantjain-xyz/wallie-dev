import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  // Keep recovery reads transiently unavailable while the real detail UI uses
  // controlled execution snapshots. No authentication or shared data is required.
  await page.route("**/api/sessions/stage-startup-proof/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
});

async function capture(page: Page, name: string) {
  await mkdir(".wallie/screenshots/stage-startup", { recursive: true });
  await page.screenshot({ path: `.wallie/screenshots/stage-startup/${name}.png`, fullPage: true });
}

for (const mobile of [false, true]) {
  const viewport = mobile ? "mobile" : "desktop";
  test(`stage startup keeps its ordinal through a controlled rerun (${viewport})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dev/stage-startup");
    await page.getByRole("link", { name: "Open session 1" }).click();
    const stages = page.getByRole("navigation", { name: "Pipeline stages" });
    await expect(
      stages.getByRole("button", { name: "Plan: Not running", exact: true }),
    ).toBeVisible();
    await capture(page, `stopped-${viewport}`);
    await page.getByRole("button", { name: "Queue Plan rerun", exact: true }).click();
    for (const [action, label, name] of [
      [null, "Queued", "queued"],
      ["Worker pickup", "Starting", "starting"],
      ["Start agent", "In progress", "running"],
      ["Ready for review", "Awaiting review", "review"],
    ] as const) {
      if (action) await page.getByRole("button", { name: action, exact: true }).click();
      const current = stages.getByRole("button", { name: `Plan: ${label}`, exact: true });
      await expect(current).toBeVisible();
      await expect(current).toHaveAttribute("aria-current", "step");
      await expect(current.locator('span[aria-hidden="true"]').first()).toHaveText("1");
      await expect(stages.getByText("Not running", { exact: true })).toHaveCount(0);
      await expect(stages.getByText("Failed", { exact: true })).toHaveCount(0);
      await capture(page, `${name}-${viewport}`);
    }
    await stages.getByRole("button", { name: "Build: Upcoming", exact: true }).click();
    await expect(
      stages.getByRole("button", { name: "Build: Upcoming", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      stages.getByRole("button", { name: "Plan: Awaiting review", exact: true }),
    ).toHaveAttribute("aria-current", "step");
    await capture(page, `upcoming-empty-${viewport}`);
    await page.getByRole("button", { name: "Fail run", exact: true }).click();
    const failed = stages.getByRole("button", { name: "Plan: Failed", exact: true });
    await expect(failed).toBeVisible();
    await expect(failed.locator('span[aria-hidden="true"]').first()).toHaveText("!");
    await failed.click();
    await expect(failed).toHaveAttribute("aria-pressed", "true");
    await capture(page, `failure-${viewport}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test(`initial queued HTML survives delayed activity, hydration, and reload (${viewport})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const url = "/dev/stage-startup?open=1&state=loading";
    const response = await page.request.get(url);
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toContain('aria-label="Plan: Queued"');
    expect(html).not.toContain('aria-label="Plan: Not running"');
    await page.goto(url);
    const current = page.getByRole("button", { name: "Plan: Queued", exact: true });
    await expect(current).toBeVisible();
    await expect(current.locator('span[aria-hidden="true"]').first()).toHaveText("1");
    await expect(page.getByText("Loading run history…", { exact: true })).toBeVisible();
    await capture(page, `loading-${viewport}`);
    await page.reload();
    await expect(current).toBeVisible();
    await page.getByRole("button", { name: "Worker pickup", exact: true }).click();
    await expect(page.getByRole("button", { name: "Plan: Starting", exact: true })).toBeVisible();
  });
}
