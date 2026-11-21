import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import {
  benchmarkComparisonExportManifestSchema,
  benchmarkComparisonExportPageSchema,
  benchmarkComparisonSchema,
} from "@/lib/factory-benchmarks/comparison-contracts";
import { signInViaMagicLink } from "./helpers/auth";
import { checked, seedBenchmarkResults } from "./helpers/factory-benchmark-results";

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
  await page.screenshot({ path, fullPage: true, animations: "disabled", caret: "hide" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function downloadJson(page: Page, link: Locator) {
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  return readFile(await download.path(), "utf8");
}

test("comparison pages and immutable exports reconcile every frozen trial", async ({
  baseURL,
  page,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_BENCHMARKS_E2E !== "1",
    "Requires a disposable loopback Supabase project.",
  );
  test.setTimeout(120_000);
  const fixture = await seedBenchmarkResults(baseURL);
  const { admin, saved, experimentId, sourceId, candidateId, sourceModel, candidateModel } =
    fixture;
  try {
    const suitePath = `/w/${fixture.slug}/benchmarks/${saved.suiteId}?factory=${fixture.factoryId}&revision=${saved.suiteRevisionId}`;
    const endpoint = `/api/workspaces/${fixture.workspaceId}/factories/${fixture.factoryId}/benchmarks/experiments/${experimentId}`;
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, suitePath, { baseURL: fixture.app, email: fixture.ownerEmail });
    const savedComparison = page
      .locator("#frozen-comparisons")
      .getByRole("link", { name: /^Comparison from / });
    await expect(savedComparison).toHaveCount(1);
    await savedComparison.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Comparison results" })).toBeVisible();
    await expect(
      page.getByText("Invoice benchmark snapshot · Revision 1", { exact: true }),
    ).toBeVisible();

    const configurations = page.getByRole("table", { name: "Configuration results" });
    await expect(configurations.getByRole("row")).toHaveCount(3);
    await expect(configurations.getByText(sourceModel, { exact: true })).toBeVisible();
    await expect(configurations.getByText(candidateModel, { exact: true })).toBeVisible();
    await expect(configurations.getByText("1 passed / 20 eligible", { exact: true })).toBeVisible();
    const timingLabels = await configurations.getByText(/observed timings?/).allTextContents();
    const observed = timingLabels.reduce(
      (total, label) => total + Number(label.match(/^\s*(\d+) observed timings?$/)?.[1] ?? 0),
      0,
    );
    expect(observed).toBe(3);

    const summary = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Comparison summary", exact: true }),
    });
    for (const [label, count] of [
      ["Planned", 80],
      ["Finished", 4],
      ["Pending", 36],
      ["Excluded", 40],
      ["Completed", 1],
      ["Failed", 1],
      ["Timed out", 1],
      ["Canceled", 1],
    ] as const) {
      await expect(
        summary
          .locator("dt")
          .filter({ hasText: new RegExp(`^${label}$`) })
          .locator("+ dd"),
      ).toHaveText(String(count));
    }
    await expect(summary.getByText("$0.50 known spend")).toBeVisible();
    await expect(summary.getByText(/trials have unavailable cost/)).toBeVisible();
    const frozenRevisions = summary.getByText("Frozen revisions", { exact: true });
    await frozenRevisions.focus();
    await page.keyboard.press("Enter");
    await expect(summary.getByText(saved.suiteRevisionId, { exact: true })).toBeVisible();
    await expect(summary.getByText(saved.scorerRevisionId, { exact: false })).toBeVisible();
    await page.keyboard.press("Enter");

    const table = page.getByRole("table", { name: "Frozen trials" });
    const pins = table.getByText("Trial pins", { exact: true }).first();
    await pins.focus();
    await page.keyboard.press("Enter");
    await expect(table.getByText("Trial ID", { exact: true }).first()).toBeVisible();
    await page.keyboard.press("Enter");
    await summary.getByText("Spend breakdown", { exact: true }).click();
    await frozenRevisions.click();
    await expect(summary.getByText("$0.20 measured (1)", { exact: false })).toBeVisible();
    await expect(summary.getByText("$0.30 estimated (1)", { exact: false })).toBeVisible();
    await capture(page, info, "benchmark-comparison-results-desktop");

    const shownIds: string[] = [];
    let afterTrialId: string | undefined;
    for (let index = 0; index < 4; index += 1) {
      const query = new URLSearchParams({ limit: "24" });
      if (afterTrialId) query.set("afterTrialId", afterTrialId);
      const response = await page.request.get(`${endpoint}/comparison?${query}`);
      expect(response.ok(), await response.text()).toBeTruthy();
      const report = benchmarkComparisonSchema.parse(await response.json());
      const rows = table.locator("tbody tr");
      await expect(rows).toHaveCount(report.trialRows.length);
      const ids = await rows.evaluateAll((elements) =>
        elements.map((row) => row.querySelector("th dl dd")?.textContent ?? ""),
      );
      expect(ids).toEqual(report.trialRows.map(({ trialId }) => trialId));
      shownIds.push(...ids);
      const next = page.getByRole("link", { name: "Next trials", exact: true });
      if (report.nextCursor) {
        const cursor = report.nextCursor.trialId;
        await next.focus();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL((url) => url.searchParams.get("afterTrialId") === cursor);
        await expect(rows.first().locator("th dl dd").first()).not.toHaveText(ids[0]);
        afterTrialId = cursor;
      } else {
        expect(index).toBe(3);
        await expect(next).toHaveCount(0);
      }
    }
    expect(shownIds).toHaveLength(80);
    expect(new Set(shownIds).size).toBe(80);

    const exports = page.locator("#result-exports");
    await page.getByRole("link", { name: "Result exports", exact: true }).click();
    const create = exports.getByRole("button", { name: "Create result export" });
    await create.focus();
    await page.keyboard.press("Enter");
    await expect(exports.getByRole("status")).toHaveText("Result export ready to download.");
    const manifestLink = exports.getByRole("link", { name: /^Download result manifest/ });
    const manifestHref = await manifestLink.getAttribute("href");
    if (!manifestHref) throw new Error("The immutable result manifest link is missing.");
    const manifestBody = await downloadJson(page, manifestLink);
    const manifest = benchmarkComparisonExportManifestSchema.parse(JSON.parse(manifestBody));
    expect(manifest.trialIds).toEqual(shownIds);
    expect(manifest.summary).toMatchObject({
      experimentId,
      suite: { name: "Invoice benchmark snapshot", revisionId: saved.suiteRevisionId },
      repetitions: 20,
      counts: { planned: 80, eligible: 40, excluded: 40, terminal: 4 },
      candidateCount: 2,
      scorers: [{ id: saved.scorerRevisionId, revisionNumber: 1 }],
    });
    const showParts = exports.getByText("Trial rows · 3 parts", { exact: true });
    await showParts.focus();
    await page.keyboard.press("Enter");
    const partIds: string[] = [];
    for (const part of manifest.pages) {
      const body = await downloadJson(
        page,
        exports.getByRole("link", { name: `Download trial part ${part.ordinal}`, exact: true }),
      );
      expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(part.sha256);
      expect(Buffer.byteLength(body, "utf8")).toBe(part.sizeBytes);
      const parsed = benchmarkComparisonExportPageSchema.parse(JSON.parse(body));
      if (parsed.kind !== "trials") throw new Error("The trial export part had the wrong kind.");
      partIds.push(...parsed.trialRows.map(({ trialId }) => trialId));
    }
    expect(partIds).toEqual(manifest.trialIds);

    await exports.getByText("Configuration rows · 1 part", { exact: true }).click();
    const candidateIds: string[] = [];
    for (const part of manifest.candidatePages) {
      const body = await downloadJson(
        page,
        exports.getByRole("link", {
          name: `Download configuration part ${part.ordinal}`,
          exact: true,
        }),
      );
      expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(part.sha256);
      expect(Buffer.byteLength(body, "utf8")).toBe(part.sizeBytes);
      const parsed = benchmarkComparisonExportPageSchema.parse(JSON.parse(body));
      if (parsed.kind !== "candidates")
        throw new Error("The configuration export part had the wrong kind.");
      candidateIds.push(
        ...parsed.candidates.map(({ definitionRevisionId }) => definitionRevisionId),
      );
    }
    expect(candidateIds.sort()).toEqual([sourceId, candidateId].sort());

    checked(
      await admin.rpc("save_factory_benchmark_suite_revision", {
        p_workspace_id: fixture.workspaceId,
        p_factory_id: fixture.factoryId,
        p_actor_user_id: fixture.ownerId,
        p_name: "Renamed invoice suite",
        p_purpose: "regression",
        p_suite_id: saved.suiteId,
        p_expected_revision_id: saved.suiteRevisionId,
        p_task_revision_ids: saved.taskRevisionIds,
      }),
    );
    const repeated = await page.request.get(manifestHref);
    expect(repeated.headers()["cache-control"]).toBe("private, no-store");
    expect(await repeated.text()).toBe(manifestBody);
    const sibling = manifestHref.replace(fixture.factoryId, fixture.siblingFactoryId);
    expect((await page.request.get(sibling)).status()).toBe(404);
    await page.reload();
    await expect(manifestLink).toBeVisible();
    await expect(
      page.getByText("Invoice benchmark snapshot · Revision 1", { exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, info, "benchmark-comparison-results-mobile-dark");
  } finally {
    await fixture.cleanup();
  }
});
