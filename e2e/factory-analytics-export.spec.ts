import { readFile } from "node:fs/promises";

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
  await page.screenshot({ path: info.outputPath(name), animations: "disabled", fullPage: true });
}

test("Analytics downloads both formats from the same authorized frozen cohort", async ({
  page,
  baseURL,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_OUTCOMES_E2E !== "1",
    "Requires a dedicated local Supabase stack.",
  );
  test.setTimeout(90_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const query = new URLSearchParams({
    factory: fixture.factoryId,
    from: fixture.from,
    to: fixture.to,
    compare: "previous",
    environment: "production",
  });
  const analyticsPath = `/w/${fixture.slug}/analytics?${query}`;

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, analyticsPath, {
      baseURL: fixture.app,
      email: fixture.viewerEmail,
    });
    const exports = page.getByRole("region", { name: "Export analytics" });
    await expect(exports).toBeVisible();
    await expect(exports.getByRole("link", { name: "Download JSON" })).toHaveCount(0);
    await exports.getByRole("button", { name: "Create export snapshot" }).click();
    const jsonLink = exports.getByRole("link", { name: "Download JSON" });
    const csvLink = exports.getByRole("link", { name: "Download CSV" });
    await expect(jsonLink).toBeVisible();
    await expect(csvLink).toBeVisible();
    await expect(exports.getByRole("status")).toContainText(/Expires/);
    await capture(page, info, "01-analytics-export-light.png");

    const jsonDownload = page.waitForEvent("download");
    await jsonLink.click();
    const jsonFile = await jsonDownload;
    const jsonHref = await jsonLink.getAttribute("href");
    if (!jsonHref) throw new Error("The JSON export did not provide a download link.");
    const json = await readFile(await jsonFile.path(), "utf8");
    expect(jsonFile.suggestedFilename()).toMatch(/^wallie-analytics-.*\.json$/);
    expect(JSON.parse(json) as unknown).toMatchObject({
      schemaVersion: 1,
      workspaceId: fixture.workspaceId,
      factoryId: fixture.factoryId,
      filters: { comparePrevious: true, deploymentEnvironment: "production" },
      periods: [
        {
          key: "primary",
          rolesVisibility: "redacted",
          summaries: {
            cost: { costs: { delivery: { knownCostUsd: 12.5, ratioState: "partial" } } },
            throughput: { observedMergeCount: 1 },
          },
          evidence: {
            deployment: expect.arrayContaining([
              expect.objectContaining({
                deploymentObservationId: fixture.deploymentObservationId,
                mergeObservationId: fixture.mergeObservationId,
                requestObservationId: fixture.requestObservationId,
              }),
            ]),
          },
        },
        { key: "comparison", summaries: { throughput: { observedMergeCount: 0 } } },
      ],
    });

    const csvDownload = page.waitForEvent("download");
    await csvLink.click();
    const csvFile = await csvDownload;
    const csv = await readFile(await csvFile.path(), "utf8");
    expect(csvFile.suggestedFilename().replace(/\.csv$/, ".json")).toBe(
      jsonFile.suggestedFilename(),
    );
    expect(csv).toContain("snapshot_id,workspace_id,factory_id");
    expect(csv).toContain(fixture.deploymentObservationId);
    expect(csv).toContain(fixture.producingRunId);

    await fixture.observePendingRequest();
    await fixture.drainProjections();
    const repeated = await page.request.get(jsonHref);
    expect(repeated.status()).toBe(200);
    expect(repeated.headers()["cache-control"]).toBe("private, no-store");
    expect(await repeated.text()).toBe(json);
    const sibling = jsonHref.replace(fixture.factoryId, fixture.siblingFactoryId);
    expect((await page.request.get(sibling)).status()).toBe(404);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(page, info, "02-analytics-export-mobile.png");
  } finally {
    await fixture.cleanup();
  }
});
