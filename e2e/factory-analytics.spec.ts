import { randomUUID } from "node:crypto";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ animations: "disabled", caret: "hide", fullPage: true, path });
  await info.attach(name, { contentType: "image/png", path });
}

function waitForAnalytics(page: Page) {
  return expect(
    page.getByRole("heading", { level: 1, name: "Analytics", exact: true }),
  ).toBeVisible();
}

test("Analytics reconciles authorized comparison periods and opens exact source evidence", async ({
  page,
  browser,
  baseURL,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_OUTCOMES_E2E !== "1",
    "Requires a dedicated local Supabase stack.",
  );
  test.setTimeout(120_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const owner = await browser.newContext({ baseURL: fixture.app });
  const workspacePath = `/w/${fixture.slug}`;
  const analyticsPath = `${workspacePath}/analytics`;
  const analyticsFilter = new URLSearchParams({
    factory: fixture.factoryId,
    from: fixture.from,
    to: fixture.to,
    compare: "previous",
    dimension: "source",
    environment: "production",
  });
  const comparison = `${analyticsPath}?${analyticsFilter}`;
  const evidence = page.getByRole("region", { name: "Evidence", exact: true });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, `${workspacePath}/sessions?factory=${fixture.factoryId}`, {
      baseURL: fixture.app,
      email: fixture.viewerEmail,
    });
    await page.getByRole("link", { name: "Analytics", exact: true }).click();
    await waitForAnalytics(page);

    await page.getByRole("combobox", { name: "Factory", exact: true }).click();
    await page
      .getByRole("listbox", { name: "Factory", exact: true })
      .locator(`[role="option"][data-value="${fixture.factoryId}"]`)
      .click();
    await expect(page).toHaveURL(new RegExp(`[?&]factory=${fixture.factoryId}(?:&|$)`));
    await page.getByLabel("From date", { exact: true }).fill(fixture.from);
    await page.getByLabel("To date", { exact: true }).fill(fixture.to);
    await page.getByLabel("Deployment environment", { exact: true }).fill("production");
    await page.getByRole("checkbox", { name: "Compare with previous period" }).check();
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await expect(page).toHaveURL(/[?&]compare=previous(?:&|$)/);
    await expect(page).toHaveURL(/[?&]environment=production(?:&|$)/);
    await expect(page.getByLabel("From date", { exact: true })).toHaveValue(fixture.from);
    await expect(page.getByLabel("To date", { exact: true })).toHaveValue(fixture.to);
    const formatDate = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
    await expect(
      page.getByText(
        new RegExp(`Previous period ${formatDate.format(new Date(fixture.comparisonFrom))}`, "u"),
      ),
    ).toBeVisible();

    for (const section of [
      "Work flow",
      "Time to delivery",
      "Cost per merged PR",
      "Pull request throughput",
      "Revert rate",
    ]) {
      await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
      await expect(page.getByRole("figure", { name: `${section} chart` })).toBeVisible();
      await expect(page.getByRole("table", { name: `${section} comparison table` })).toBeVisible();
    }
    const cost = page.getByRole("table", { name: "Cost per merged PR comparison table" });
    await expect(cost).toContainText(/\$12\.50/);
    await expect(cost).toContainText(/partial/i);
    await expect(cost).toContainText(/no observed merges/i);
    const delivery = page.getByRole("table", { name: "Time to delivery comparison table" });
    await expect(delivery.getByText("3 h", { exact: true })).toHaveCount(4);
    await expect(delivery.getByText("4 h", { exact: true })).toHaveCount(4);
    const revert = page.getByRole("table", { name: "Revert rate comparison table" });
    await expect(
      revert
        .getByRole("row", { name: /Window still open/ })
        .getByRole("cell")
        .first(),
    ).toHaveText("1");
    await expect(page.getByText("Restricted outcome canary", { exact: true })).toHaveCount(0);
    await capture(page, info, "01-analytics-light");

    const activeChart = page
      .getByRole("figure", { name: "Work flow chart" })
      .getByRole("link", { name: /^Active, Current period, .*evidence/ });
    const activeTable = page.getByRole("link", {
      name: /^Active, Current period, .*table evidence/,
    });
    const activeHref = await activeTable.getAttribute("href");
    expect(activeHref).toContain("facet=active");
    await expect(activeChart).toHaveAttribute("href", activeHref ?? "");
    await activeTable.click();
    await expect(page).toHaveURL(/[?&]metric=flow(?:&|#|$)/);
    await expect(page).toHaveURL(/[?&]facet=active(?:&|#|$)/);
    await expect(
      evidence.getByRole("link", { name: `Session #${fixture.deliveredSessionNumber}` }).first(),
    ).toHaveAttribute("href", `${workspacePath}/sessions/${fixture.deliveredSessionNumber}`);
    await expect(evidence.getByRole("link", { name: "Session #72", exact: true })).toHaveCount(0);

    await page
      .getByRole("link", {
        name: /^Request to deployment Median, Current period, .*table evidence/,
      })
      .click();
    await expect(page).toHaveURL(/[?&]metric=deployment(?:&|#|$)/);
    await expect(page).toHaveURL(/[?&]facet=measured(?:&|#|$)/);
    await expect(evidence).toContainText(fixture.requestObservationId);
    await expect(evidence).toContainText(fixture.mergeObservationId);
    await expect(evidence).toContainText(fixture.deploymentObservationId);
    await expect(
      evidence.getByRole("link", { name: `Session #${fixture.deliveredSessionNumber}` }),
    ).toHaveAttribute("href", `${workspacePath}/sessions/${fixture.deliveredSessionNumber}`);
    await capture(page, info, "02-analytics-deployment-evidence");

    await page.goto(`${comparison}&metric=delivery-cost`);
    await expect(
      evidence.locator(`a[href="${workspacePath}/runs/${fixture.producingRunId}"]`),
    ).toBeVisible();
    await expect(
      evidence.locator(`a[href="${workspacePath}/runs/${fixture.failedRunId}"]`),
    ).toBeVisible();

    const throughputPath = `${comparison}&metric=throughput`;
    await page.goto(throughputPath);
    const privateRoles = "Credential and budget details are restricted to factory managers.";
    await expect(evidence.getByText(privateRoles, { exact: true })).toBeVisible();

    await fixture.observePendingRequest();
    await page.goto(comparison);
    await expect(page.getByText(/Updating · snapshot may be stale/u).first()).toBeVisible();
    await capture(page, info, "05-analytics-updating");
    await fixture.drainProjections();
    await page.reload();
    await expect(page.getByText(/Updating · snapshot may be stale/u)).toHaveCount(0);

    const restrictedFilter = new URLSearchParams(analyticsFilter);
    restrictedFilter.set("factory", fixture.siblingFactoryId);
    await page.goto(`${analyticsPath}?${restrictedFilter}&metric=deployment&facet=measured`);
    await expect(
      page.getByRole("heading", { name: "Factory unavailable", exact: true }),
    ).toBeVisible();
    await expect(evidence).toHaveCount(0);
    await expect(page.getByText(fixture.deploymentObservationId, { exact: false })).toHaveCount(0);
    await expect(page.getByText("Restricted outcome canary", { exact: true })).toHaveCount(0);

    const ownerPage = await owner.newPage();
    await signInViaMagicLink(ownerPage, throughputPath, {
      baseURL: fixture.app,
      email: fixture.ownerEmail,
    });
    await waitForAnalytics(ownerPage);
    await expect(ownerPage.getByRole("table", { name: "Contributing evidence" })).toBeVisible();
    await expect(ownerPage.getByText(privateRoles, { exact: true })).toHaveCount(0);
    const correctionPath = `/api/workspaces/${fixture.workspaceId}/factories/${fixture.factoryId}/outcome-reverts`;
    const change = {
      action: "relationship",
      status: "candidate",
      originalMergeId: fixture.mergeId,
      revertPrNumber: 315,
      requestId: randomUUID(),
      expectedRevision: 0,
    };
    const forbidden = await page.request.post(correctionPath, { data: change });
    expect(forbidden.status()).toBe(403);
    const allowed = await ownerPage.request.post(correctionPath, { data: change });
    expect(allowed.status()).toBe(200);
    expect(await allowed.json()).toMatchObject({
      originalMergeId: fixture.mergeId,
      status: "candidate",
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(comparison);
    await waitForAnalytics(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(page, info, "03-analytics-mobile-dark");
    const menu = page.getByRole("button", { name: "Workspace navigation: Analytics" });
    await menu.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Workspace pages" });
    await expect(drawer.getByRole("link", { name: "Analytics", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await activeChart.press("Enter");
    await expect(
      evidence.getByRole("link", { name: `Session #${fixture.deliveredSessionNumber}` }).first(),
    ).toBeVisible();
    await capture(page, info, "04-analytics-mobile-evidence");
  } finally {
    await owner.close();
    await fixture.cleanup();
  }
});
