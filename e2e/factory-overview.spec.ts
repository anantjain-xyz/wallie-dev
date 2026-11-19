import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ animations: "disabled", caret: "hide", fullPage: true, path });
  await info.attach(name, { contentType: "image/png", path });
}

test("Overview matches Analytics, keeps projection controls scoped, and exposes stale health", async ({
  baseURL,
  browser,
  page,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_OUTCOMES_E2E !== "1",
    "Requires a dedicated local Supabase stack.",
  );
  test.setTimeout(120_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const manager = await browser.newContext({ baseURL: fixture.app });
  const workspace = `/w/${fixture.slug}`;
  const scope = {
    factory: fixture.factoryId,
    from: fixture.from,
    to: fixture.to,
    compare: "previous",
    dimension: "source",
    environment: "production",
  };
  const query = new URLSearchParams(scope);
  const overview = `${workspace}/overview?${query}`;
  const analytics = `${workspace}/analytics?${query}`;
  const control = `/api/workspaces/${fixture.workspaceId}/factories/${fixture.factoryId}/projection-control`;
  const view = page.getByRole("heading", { name: "Overview", exact: true });
  const health = page.getByRole("region", { name: "Projection health" });
  const clock = page.getByRole("region", { name: "Time to delivery" });
  const outcome = page.getByRole("region", { name: "Cost per merged PR" });
  const active = page
    .getByRole("region", { name: "Work flow" })
    .getByRole("link", { name: /^Active, Current period/ });

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, `${workspace}/sessions?factory=${fixture.factoryId}`, {
      baseURL: fixture.app,
      email: fixture.viewerEmail,
    });
    await page
      .getByRole("navigation", { name: "Workspace navigation" })
      .getByRole("link", { name: "Overview", exact: true })
      .click();
    await expect(view).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Factory", exact: true })).toHaveValue(
      fixture.factoryId,
    );
    await page.getByLabel("From date", { exact: true }).fill(fixture.from);
    await page.getByLabel("To date", { exact: true }).fill(fixture.to);
    await page.getByLabel("Deployment environment", { exact: true }).fill("production");
    await page.getByRole("checkbox", { name: "Compare with previous period" }).check();
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await expect(page).toHaveURL(/[?&]compare=previous(?:&|$)/);
    await expect(view).toBeVisible();
    await expect(health.getByText("Current", { exact: true })).toBeVisible();
    await expect(health.getByText("Lifecycle capture began", { exact: true })).toBeVisible();
    await expect(health.getByRole("button", { name: "Pause projection" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open Inbox" })).toHaveAttribute(
      "href",
      `${workspace}/inbox?factory=${fixture.factoryId}`,
    );
    await expect(page.getByRole("link", { name: "View sessions" })).toHaveAttribute(
      "href",
      `${workspace}/sessions?factory=${fixture.factoryId}`,
    );
    await expect(page.getByRole("link", { name: "Open Analytics" })).toHaveAttribute(
      "href",
      analytics,
    );
    await expect(
      clock.getByRole("link", { name: /^Request to merge, Current period, 3 h/ }),
    ).toBeVisible();
    const production = clock.getByRole("link", {
      name: /^Request to deployment, Current period, 4 h/,
    });
    await expect(production).toBeVisible();
    await expect(outcome).toContainText("$12.50 · partial");
    await expect(outcome).toContainText("No observed merges");
    await expect(
      page
        .getByRole("region", { name: "Pull request throughput" })
        .getByRole("link", { name: /^Observed canonical merges, Current period, 1$/ }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Revert rate" })).toContainText(
      "No covered mature merges",
    );
    const activeHref = await active.getAttribute("href");
    expect(activeHref).toBe(
      `${analytics}&metric=flow&facet=active&period=primary#analytics-evidence`,
    );
    await capture(page, info, "01-overview-light");

    await production.click({ timeout: 10_000 });
    await expect(page).toHaveURL(/[?&]facet=measured(?:&|#|$)/);
    const evidence = page.getByRole("region", { name: "Evidence", exact: true });
    await expect(evidence).toContainText(fixture.deploymentObservationId);
    await expect(
      page.getByRole("table", { name: "Time to delivery comparison table" }),
    ).toContainText("4 h");
    await expect(
      page.getByRole("table", { name: "Cost per merged PR comparison table" }),
    ).toContainText("$12.50 · partial");

    expect((await page.request.post(control, { data: { action: "pause" } })).status()).toBe(404);
    const restricted = new URLSearchParams({ ...scope, factory: fixture.siblingFactoryId });
    await page.goto(`${workspace}/overview?${restricted}`);
    await expect(page.getByRole("heading", { name: "Factory unavailable" })).toBeVisible();
    await expect(health).toHaveCount(0);
    await expect(page.getByText("Restricted outcome canary", { exact: true })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(overview);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const menu = page.getByRole("button", { name: "Workspace navigation: Overview" });
    await menu.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Workspace pages" });
    await expect(drawer.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await capture(page, info, "02-overview-mobile-dark");

    const owner = await manager.newPage();
    await signInViaMagicLink(owner, overview, { baseURL: fixture.app, email: fixture.ownerEmail });
    const ownerHealth = owner.getByRole("region", { name: "Projection health" });
    const ownerClock = owner.getByRole("region", { name: "Time to delivery" });
    await fixture.observePendingRequest();
    await owner.reload();
    await expect(ownerHealth.getByText("Updating", { exact: true })).toBeVisible();
    await expect(ownerClock).toContainText("The previous snapshot may be stale");
    await expect(ownerClock.getByRole("link")).toHaveCount(0);
    await owner.getByRole("button", { name: "Pause projection" }).click();
    await expect(ownerHealth.getByText("Paused", { exact: true })).toBeVisible();
    await expect(ownerClock).toContainText("Data unavailable. Projection paused.");
    await owner.getByRole("button", { name: "Rebuild projection" }).click();
    await expect(
      ownerHealth.getByText("The queued rebuild starts after the projection resumes."),
    ).toBeVisible();
    await expect(owner.getByRole("region", { name: "Cost per merged PR" })).toContainText(
      "$12.50 · partial",
    );
    await capture(owner, info, "03-overview-paused");

    await owner.getByRole("button", { name: "Resume projection" }).click();
    await expect(ownerHealth.getByText("Paused", { exact: true })).toHaveCount(0);
    await fixture.drainProjections();
    await owner.reload();
    await expect(ownerHealth.getByText("Completed", { exact: true })).toBeVisible();
    await expect(
      ownerClock.getByRole("link", { name: /^Request to deployment, Current period, 4 h/ }),
    ).toBeVisible();
    await fixture.markProjectionFailed();
    await owner.reload();
    await expect(ownerHealth.getByText("Failed", { exact: true })).toBeVisible();
    await expect(ownerClock).toContainText("Data unavailable. Projection failed.");
    await expect(ownerClock.getByRole("link")).toHaveCount(0);
    await expect(owner.getByRole("link", { name: "View sessions" })).toHaveAttribute(
      "href",
      `${workspace}/sessions?factory=${fixture.factoryId}`,
    );
    await capture(owner, info, "04-overview-failed");
  } finally {
    try {
      await manager.close();
    } finally {
      await fixture.cleanup();
    }
  }
});
