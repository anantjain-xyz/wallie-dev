import { expect, test, type Page } from "@playwright/test";

import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";

async function expectReflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
}

async function confirmProjection(page: Page, label: string) {
  await page
    .getByRole("region", { name: "Reporting health" })
    .getByRole("button", { name: label })
    .click();
  await page
    .getByRole("alertdialog", { name: label + "?" })
    .getByRole("button", { name: label })
    .click();
}

test("legacy Overview bookmarks join the same scoped Analytics destination", async ({
  baseURL,
  page,
}) => {
  test.skip(process.env.WALLIE_FACTORY_OUTCOMES_E2E !== "1", "Requires local Supabase.");
  test.setTimeout(120_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const workspace = `/w/${fixture.slug}`;
  const scope = {
    factory: fixture.factoryId,
    from: fixture.from,
    to: fixture.to,
    compare: "previous",
    dimension: "source",
    environment: "production",
  };
  const overview = `${workspace}/overview?${new URLSearchParams(scope)}`;
  const analytics = `${workspace}/analytics?${new URLSearchParams(scope)}`;
  const outcomes = page.getByRole("region", { name: "Factory outcomes" });
  const health = page.getByRole("region", { name: "Reporting health" });
  const factory = page.getByRole("combobox", { name: "Factory", exact: true });

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, `${workspace}/sessions?factory=${fixture.factoryId}`, {
      baseURL: fixture.app,
      email: fixture.viewerEmail,
    });
    const sidebar = page.getByRole("navigation", { name: "Workspace navigation" });
    await expect(sidebar.getByRole("link", { name: "Overview", exact: true })).toHaveCount(0);
    await sidebar.getByRole("link", { name: "Analytics", exact: true }).click();
    await expect(outcomes).toBeVisible();
    await expect(factory).toHaveAttribute("data-value", fixture.factoryId);

    await page.goto(overview + "#overview-filters");
    await expect(page).toHaveURL(analytics + "#overview-filters");
    await expect(page.getByLabel("From date (UTC)")).toBeVisible();
    await expect(page.getByLabel("From date (UTC)")).toHaveValue(fixture.from);
    await expect(page.getByLabel("To date (UTC, exclusive)")).toHaveValue(fixture.to);
    await expect(
      page.getByRole("checkbox", { name: "Compare with previous period" }),
    ).toBeChecked();

    await page.goto(overview + "#overview-analytics");
    await expect(page).toHaveURL(analytics + "#overview-analytics");
    await expect(page.getByRole("heading", { name: "Factory outcomes" })).toBeInViewport();
    await expect(factory).toHaveAttribute("data-value", fixture.factoryId);
    await expect(outcomes.getByText("Flow and delivery current", { exact: true })).toBeVisible();
    await expect(outcomes).toContainText("Partial merge coverage");
    await expect(outcomes).toContainText("No covered mature merges");
    const summaryLink = outcomes.getByRole("link", { name: "PR throughput" });
    await summaryLink.press("Enter");
    await expect(page).toHaveURL(analytics + "#throughput");
    await expect(page.getByRole("region", { name: "Pull request throughput" })).toBeFocused();

    await health.locator("details").first().locator(":scope > summary").press("Enter");
    await expect(health.getByText("Lifecycle capture began", { exact: true })).toBeVisible();
    await expect(health.getByText("Advanced", { exact: true })).toHaveCount(0);
    await expect(health.getByRole("button", { name: "Pause projection" })).toHaveCount(0);
    const control = `/api/workspaces/${fixture.workspaceId}/factories/${fixture.factoryId}/projection-control`;
    expect((await page.request.post(control, { data: { action: "pause" } })).status()).toBe(404);
    await expect(page.getByRole("region", { name: "Routing canary" })).toHaveCount(0);

    const deployment = page.getByRole("region", { name: "Time to delivery" });
    await deployment
      .getByRole("link", { name: /^Request to deployment Median, Current period/ })
      .click();
    const evidence = page.getByRole("region", { name: "Evidence", exact: true });
    await expect(evidence).toContainText(fixture.deploymentObservationId);
    await evidence.getByRole("link", { name: "Close evidence" }).press("Enter");
    await expect(page).toHaveURL(analytics + "#time-to-delivery");

    for (const request of [
      new URLSearchParams({ ...scope, factory: fixture.siblingFactoryId }),
      new URLSearchParams({ ...scope, factory: "all" }),
      new URLSearchParams([...new URLSearchParams(scope), ["factory", fixture.siblingFactoryId]]),
    ]) {
      await page.goto(`${workspace}/overview?${request}`);
      await expect(page.getByRole("heading", { name: "Factory unavailable" })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe(workspace + "/analytics");
      await expect(factory).toHaveAttribute("data-value", "unavailable");
      await expect(outcomes).toHaveCount(0);
      await expect(health).toHaveCount(0);
      await expect(page.getByText("Restricted delivery", { exact: true })).toHaveCount(0);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    const invalid = new URLSearchParams({ ...scope, to: fixture.from, environment: "Production" });
    await page.goto(`${workspace}/overview?${invalid}#overview-filters`);
    await expect(page.getByRole("alert").filter({ hasText: /Overview bookmark/ })).toBeVisible();
    await expect(factory).toHaveAttribute("data-value", fixture.factoryId);
    await expect(outcomes).toHaveCount(0);
    const reset = page.getByRole("link", { name: "Reset reporting filters" });
    await expect(reset).toHaveAttribute(
      "href",
      `${workspace}/analytics?factory=${fixture.factoryId}`,
    );
    await reset.click();
    await expect(outcomes).toBeVisible();
    await expect(factory).toHaveAttribute("data-value", fixture.factoryId);
    await page.goto(overview);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const menu = page.getByRole("button", { name: "Workspace navigation: Analytics" });
    await menu.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Workspace pages" });
    await expect(drawer.getByRole("link", { name: "Overview", exact: true })).toHaveCount(0);
    await expect(drawer.getByRole("link", { name: "Analytics", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await expectReflow(page);
    await page.setViewportSize({ width: 320, height: 760 });
    await expectReflow(page);
  } finally {
    await fixture.cleanup();
  }
});

test("Reporting health keeps projection actions scoped through stale, paused, and archived states", async ({
  baseURL,
  browser,
  page,
}) => {
  test.skip(process.env.WALLIE_FACTORY_OUTCOMES_E2E !== "1", "Requires local Supabase.");
  test.setTimeout(120_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const delegated = await browser.newContext({ baseURL: fixture.app });
  const analytics = `/w/${fixture.slug}/analytics?${new URLSearchParams({
    factory: fixture.factoryId,
    from: fixture.from,
    to: fixture.to,
    compare: "previous",
    dimension: "source",
    environment: "production",
  })}`;
  const health = page.getByRole("region", { name: "Reporting health" });
  const outcomes = page.getByRole("region", { name: "Factory outcomes" });
  const flow = page.getByRole("region", { name: "Work flow" });

  try {
    await signInViaMagicLink(page, analytics, { baseURL: fixture.app, email: fixture.ownerEmail });
    await fixture.observePendingRequest();
    await page.reload();
    await expect(outcomes.getByText("Flow and delivery delayed", { exact: true })).toBeVisible();
    await expect(outcomes).toContainText("Sessions and outcome capture continue.");
    await expect(health.getByText("Updating", { exact: true })).toBeVisible();
    await expect(flow).toContainText("Updating · snapshot may be stale");
    await health.locator("details").first().locator(":scope > summary").press("Enter");
    const pause = health.getByRole("button", { name: "Pause projection" });
    await expect(pause).toHaveCount(0);
    await health
      .locator("summary")
      .filter({ hasText: /^Advanced$/ })
      .press("Enter");
    await expect(pause).toBeVisible();
    await pause.press("Enter");
    const dialog = page.getByRole("alertdialog", { name: "Pause projection?" });
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(pause).toBeFocused();
    await expect(health.getByText("Updating", { exact: true })).toBeVisible();

    await confirmProjection(page, "Pause projection");
    await expect(health.getByText("Paused", { exact: true })).toBeVisible();
    await expect(outcomes).toContainText("Projection paused");
    await expect(flow).toContainText("Paused · snapshot may be stale");
    await confirmProjection(page, "Rebuild projection");
    await expect(health).toContainText("The queued rebuild starts after the projection resumes.");
    await expect(page.getByRole("region", { name: "Cost per merged PR" })).toContainText(
      "$12.50 · partial",
    );
    await confirmProjection(page, "Resume projection");
    await expect(health.getByText("Paused", { exact: true })).toHaveCount(0);
    await fixture.drainProjections();
    await page.reload();
    await health.locator("details").first().locator(":scope > summary").press("Enter");
    await expect(health.getByText("Completed", { exact: true })).toBeVisible();
    await expect(outcomes.getByText("Flow and delivery current", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Time to delivery" })).toContainText("4 h");

    await fixture.markProjectionFailed();
    await page.reload();
    await expect(health.getByText("Failed", { exact: true })).toBeVisible();
    await expect(outcomes).toContainText("Projection update failed");

    await fixture.grantViewerManager();
    const manager = await delegated.newPage();
    await signInViaMagicLink(manager, analytics, {
      baseURL: fixture.app,
      email: fixture.viewerEmail,
    });
    const managerHealth = manager.getByRole("region", { name: "Reporting health" });
    await managerHealth.locator("details").first().locator(":scope > summary").press("Enter");
    await managerHealth
      .locator("summary")
      .filter({ hasText: /^Advanced$/ })
      .press("Enter");
    await expect(managerHealth.getByRole("button", { name: "Pause projection" })).toBeVisible();
    await confirmProjection(manager, "Pause projection");
    await expect(managerHealth.getByText("Paused", { exact: true })).toBeVisible();
    await confirmProjection(manager, "Resume projection");
    await expect(managerHealth.getByText("Paused", { exact: true })).toHaveCount(0);

    await fixture.archiveFactory();
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Factory", exact: true })).toContainText(
      "(archived)",
    );
    await expect(outcomes).toBeVisible();
    await health.locator("details").first().locator(":scope > summary").press("Enter");
    await health
      .locator("summary")
      .filter({ hasText: /^Advanced$/ })
      .press("Enter");
    await expect(health.getByRole("button", { name: "Pause projection" })).toBeVisible();
  } finally {
    await delegated.close();
    await fixture.cleanup();
  }
});
