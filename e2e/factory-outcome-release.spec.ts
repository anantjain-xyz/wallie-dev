import { readFile } from "node:fs/promises";

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod/v4";

import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryOutcomeRelease } from "./helpers/factory-outcome-release";
import { assertFactoryOutcomeExportReconciles } from "./helpers/reconcile-factory-outcome-export";

const windowSchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});
const records = z.array(z.record(z.string(), z.unknown()));
const period = z.object({
  key: z.enum(["primary", "comparison"]),
  window: windowSchema,
  rolesVisibility: z.enum(["full", "redacted"]),
  summaries: z.record(z.string(), z.unknown()),
  evidence: z.object({
    flow: records,
    merge: records,
    deployment: records,
    deliveryCost: records,
    operatingCost: records,
    costMerges: records,
    throughput: records,
    revert: records,
  }),
});
const snapshot = z.object({
  id: z.uuid(),
  schemaVersion: z.literal(1),
  workspaceId: z.uuid(),
  factoryId: z.uuid(),
  filters: windowSchema.extend({
    dimension: z.literal("source"),
    deploymentEnvironment: z.literal("production"),
    comparePrevious: z.literal(true),
  }),
  periods: z.tuple([period, period]),
});

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const percent = new Intl.NumberFormat("en-US", { style: "percent" });
const hours = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function duration(seconds: number) {
  return seconds < 3600 ? `${hours.format(seconds / 60)} min` : `${hours.format(seconds / 3600)} h`;
}

async function screenshot(page: Page, info: TestInfo, name: string) {
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

function analyticsValue(page: Page, section: string, label: string, period = "Current period") {
  return page
    .getByRole("table", { name: `${section} comparison table` })
    .getByRole("link", { name: `${label}, ${period}, table evidence,` });
}

function overviewValue(page: Page, section: string, label: string, period = "Current period") {
  return page
    .getByRole("region", { name: section, exact: true })
    .getByRole("link", { name: `${label}, ${period},` });
}

async function download(page: Page, format: "CSV" | "JSON") {
  const link = page.getByRole("link", { name: `Download ${format}`, exact: true });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  if (!href) throw new Error("Missing snapshot download URL.");
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    link.click({ timeout: 10_000 }),
  ]);
  expect(file.suggestedFilename()).toMatch(
    new RegExp(`^wallie-analytics-[a-f0-9-]+\\.${format.toLowerCase()}$`),
  );
  return { href, bytes: await readFile(await file.path()) };
}

function parseCsv(bytes: Buffer) {
  const [header = "", ...lines] = bytes.toString("utf8").trimEnd().split("\r\n");
  const keys = header.split(",");
  return lines.map((line) => {
    const cells = [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/gu)];
    expect(cells).toHaveLength(keys.length);
    return Object.fromEntries(
      keys.map((key, index) => [key, cells[index]?.[1]?.replaceAll('""', '"')]),
    );
  });
}

function csvRecord(value: string | undefined): unknown {
  if (!value) throw new Error("Missing CSV record.");
  return JSON.parse(value);
}

test.use({ actionTimeout: 15_000 });

test("factory outcome release reconciles the signed-in Overview, Analytics and private snapshots", async ({
  baseURL,
  browser,
  page,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_OUTCOMES_E2E !== "1",
    "Requires a disposable local Supabase stack.",
  );
  test.setTimeout(120_000);
  const fixture = await seedFactoryOutcomeRelease(baseURL);
  const managerContext = await browser.newContext({ baseURL: fixture.app });
  const workspace = `/w/${fixture.slug}`;
  const scope = {
    factory: fixture.factoryId,
    from: fixture.from,
    to: fixture.to,
    compare: "previous",
    dimension: "source",
    environment: "production",
  };
  const search = new URLSearchParams(scope);
  const overview = `${workspace}/overview?${search}`;
  const analytics = `${workspace}/analytics?${search}`;
  const evidence = page.getByRole("region", { name: "Evidence", exact: true });
  const deliveryCost = money.format(fixture.expected.costPerObservedMergeUsd) + " · partial";
  const revertRate = percent.format(fixture.expected.revertRate);
  const mergeLead = duration(fixture.expected.mergeMedianSeconds);
  const deliveryLead = duration(fixture.expected.deploymentMedianSeconds);
  const requestCount = fixture.expected.mergeMeasured + fixture.expected.mergeUnknown;

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
    await expect(page.getByRole("combobox", { name: "Factory", exact: true })).toHaveAttribute(
      "data-value",
      fixture.factoryId,
    );
    await page.getByLabel("From date", { exact: true }).fill(fixture.from);
    await page.getByLabel("To date", { exact: true }).fill(fixture.to);
    await page.getByLabel("Deployment environment", { exact: true }).fill("production");
    await page.getByRole("checkbox", { name: "Compare with previous period" }).check();
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await expect(page.getByRole("link", { name: "Open Analytics" })).toHaveAttribute(
      "href",
      analytics,
    );
    await expect(
      page.getByRole("region", { name: "Projection health" }).getByText("Current", { exact: true }),
    ).toBeVisible();
    await expect(overviewValue(page, "Time to delivery", "Request to merge")).toContainText(
      mergeLead,
    );
    await expect(overviewValue(page, "Time to delivery", "Request to deployment")).toContainText(
      deliveryLead,
    );
    await expect(overviewValue(page, "Cost per merged PR", "Delivery cost")).toContainText(
      deliveryCost,
    );
    await expect(
      overviewValue(page, "Cost per merged PR", "Delivery cost", "Previous period"),
    ).toContainText("No observed merges");
    await expect(
      overviewValue(page, "Pull request throughput", "Observed canonical merges"),
    ).toContainText(String(fixture.expected.observedMergeCount));
    await expect(overviewValue(page, "Revert rate", "Verified revert rate")).toContainText(
      revertRate,
    );
    await screenshot(page, info, "01-outcome-overview-light");

    await page.getByRole("link", { name: "Open Analytics" }).click();
    await expect(
      page.getByRole("heading", { name: "Analytics", exact: true, level: 1 }),
    ).toBeVisible();
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(scope);
    for (const [key, label] of [
      ["queued", "Queued"],
      ["active", "Active"],
      ["blocked", "Blocked"],
      ["review", "Review"],
      ["delivery", "Delivery"],
      ["unknown", "Unknown phase"],
    ] as const) {
      await expect(analyticsValue(page, "Work flow", label)).toContainText(
        duration(fixture.expected.phaseSeconds[key]),
      );
    }
    await expect(analyticsValue(page, "Work flow", "Active")).toContainText("3 segments");
    await expect(analyticsValue(page, "Work flow", "Queued", "Previous period")).toContainText(
      "30 min",
    );
    await expect(analyticsValue(page, "Time to delivery", "Request to merge Minimum")).toHaveText(
      "2 h",
    );
    await expect(analyticsValue(page, "Time to delivery", "Request to merge Median")).toHaveText(
      mergeLead,
    );
    await expect(
      analyticsValue(page, "Time to delivery", "Request to merge 95th percentile"),
    ).toHaveText("5.85 h");
    await expect(analyticsValue(page, "Time to delivery", "Request to merge Maximum")).toHaveText(
      "6 h",
    );
    await expect(
      analyticsValue(page, "Time to delivery", "Request to merge Unknown timing"),
    ).toHaveText(String(fixture.expected.mergeUnknown));
    await expect(
      analyticsValue(page, "Time to delivery", "Request to deployment Median"),
    ).toHaveText(deliveryLead);
    await expect(
      analyticsValue(page, "Time to delivery", "Request to deployment Measured"),
    ).toHaveText(String(fixture.expected.deploymentMeasured));
    await expect(
      analyticsValue(page, "Cost per merged PR", "Delivery cost per observed merge"),
    ).toHaveText(deliveryCost);
    await expect(analyticsValue(page, "Cost per merged PR", "Delivery known cost")).toHaveText(
      money.format(fixture.expected.knownCostUsd),
    );
    await expect(
      analyticsValue(page, "Cost per merged PR", "Delivery Measured attempts"),
    ).toHaveText(String(fixture.expected.measuredAttempts));
    await expect(
      analyticsValue(page, "Cost per merged PR", "Delivery Estimated attempts"),
    ).toHaveText(String(fixture.expected.estimatedAttempts));
    await expect(
      analyticsValue(page, "Cost per merged PR", "Delivery Unavailable attempts"),
    ).toHaveText(String(fixture.expected.unavailableAttempts));
    await expect(
      analyticsValue(page, "Pull request throughput", "Observed canonical merges"),
    ).toHaveText(String(fixture.expected.observedMergeCount));
    await expect(
      analyticsValue(
        page,
        "Pull request throughput",
        "Observed canonical merges",
        "Previous period",
      ),
    ).toHaveText(String(fixture.expected.previousObservedMergeCount));
    await expect(analyticsValue(page, "Revert rate", "Verified revert rate")).toHaveText(
      revertRate,
    );
    await expect(analyticsValue(page, "Revert rate", "Covered mature merges")).toHaveText(
      String(fixture.expected.matureCoveredCount),
    );
    await expect(
      analyticsValue(page, "Revert rate", "Verified reverts among covered merges"),
    ).toHaveText(String(fixture.expected.revertedCoveredCount));
    await expect(analyticsValue(page, "Revert rate", "Ambiguous relationship")).toHaveText(
      String(fixture.expected.ambiguousRevertCount),
    );
    await expect(analyticsValue(page, "Revert rate", "Window still open")).toHaveText(
      String(fixture.expected.immatureRevertCount),
    );
    await screenshot(page, info, "02-outcome-analytics-light");

    await analyticsValue(page, "Work flow", "Queued", "Previous period").press("Enter");
    await expect(evidence.getByRole("link", { name: "Session #72", exact: true })).toBeVisible();
    await expect(evidence.getByRole("link", { name: "Session #71", exact: true })).toHaveCount(0);
    await analyticsValue(page, "Work flow", "Active").press("Enter");
    const intervals = evidence.getByText("Lifecycle observations", { exact: true });
    await expect(intervals).toHaveCount(3);
    for (const interval of await intervals.all()) await interval.click({ timeout: 10_000 });
    for (const runId of [fixture.failedRunId, fixture.estimatedRunId, fixture.producingRunId]) {
      await expect(
        evidence.getByRole("link", { name: `Run ${runId}`, exact: true }).first(),
      ).toHaveAttribute("href", `${workspace}/runs/${runId}`);
    }

    await analyticsValue(page, "Time to delivery", "Request to deployment Median").press("Enter");
    await expect(page).toHaveURL(/[?&]metric=deployment(?:&|#|$)/);
    await expect(page).toHaveURL(/[?&]facet=measured(?:&|#|$)/);
    await expect(evidence).toContainText(fixture.requestObservationId);
    await expect(evidence).toContainText(fixture.mergeObservationId);
    await expect(evidence).toContainText(fixture.deploymentObservationId);
    const delivered = evidence.getByRole("link", {
      name: `Session #${fixture.deliveredSessionNumber}`,
      exact: true,
    });
    await expect(delivered).toHaveAttribute(
      "href",
      `${workspace}/sessions/${fixture.deliveredSessionNumber}`,
    );
    await expect(
      evidence.getByRole("link", { name: `Session #${fixture.unknownSessionNumber}`, exact: true }),
    ).toHaveCount(0);
    await screenshot(page, info, "03-outcome-deployment-evidence");
    await delivered.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/sessions/${fixture.deliveredSessionNumber}$`));
    await expect(
      page.getByText("Ship invoice reconciliation", { exact: true }).first(),
    ).toBeVisible();

    await page.goto(analytics);
    await analyticsValue(page, "Time to delivery", "Request to merge Unknown timing").press(
      "Enter",
    );
    await expect(
      evidence.getByRole("link", { name: `Session #${fixture.unknownSessionNumber}`, exact: true }),
    ).toBeVisible();
    await expect(
      evidence.getByRole("link", {
        name: `Session #${fixture.deliveredSessionNumber}`,
        exact: true,
      }),
    ).toHaveCount(0);

    await analyticsValue(page, "Cost per merged PR", "Delivery Unavailable attempts").press(
      "Enter",
    );
    await expect(
      evidence.getByRole("link", { name: `Run ${fixture.failedRunId}`, exact: true }),
    ).toHaveAttribute("href", `${workspace}/runs/${fixture.failedRunId}`);
    await expect(
      evidence.getByRole("link", { name: `Run ${fixture.producingRunId}`, exact: true }),
    ).toHaveCount(0);

    await expect(analyticsValue(page, "Pull request throughput", "Browser")).toHaveText(
      String(fixture.expected.browserAttributedMerges),
    );
    await expect(analyticsValue(page, "Pull request throughput", "Unknown")).toHaveText(
      String(fixture.expected.unknownSourceMerges),
    );
    await analyticsValue(page, "Pull request throughput", "Browser").press("Enter");
    await expect(
      evidence.getByText("Credential and budget details are restricted to factory managers.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      evidence.getByRole("link", { name: `Run ${fixture.producingRunId}`, exact: true }),
    ).toBeVisible();
    await expect(evidence).toContainText(fixture.mergeObservationId);
    await expect(evidence).toContainText(fixture.browserRequestReceiptId);
    await analyticsValue(page, "Pull request throughput", "Unknown").press("Enter");
    await expect(
      evidence.getByRole("link", { name: `Run ${fixture.producingRunId}`, exact: true }),
    ).toHaveCount(0);
    await expect(evidence.getByRole("link", { name: "Session #81", exact: true })).toBeVisible();

    await page.getByRole("combobox", { name: /^Break down throughput by/u }).selectOption("model");
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await expect(analyticsValue(page, "Pull request throughput", "gpt-5.5")).toHaveText("1");
    await expect(analyticsValue(page, "Pull request throughput", "Unlinked")).toHaveText("3");
    await analyticsValue(page, "Pull request throughput", "gpt-5.5").press("Enter");
    await expect(
      evidence.getByRole("link", { name: `Run ${fixture.producingRunId}`, exact: true }),
    ).toBeVisible();
    await expect(evidence).toContainText(fixture.mergeObservationId);
    await page.getByRole("combobox", { name: /^Break down throughput by/u }).selectOption("person");
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    const requester = `Workspace member ${fixture.ownerMemberId.slice(0, 8)}`;
    await expect(analyticsValue(page, "Pull request throughput", requester)).toHaveText("4");

    await analyticsValue(page, "Revert rate", "Ambiguous relationship").press("Enter");
    await expect(evidence).toContainText(fixture.ambiguousRevertMergeId);
    await expect(evidence).not.toContainText(fixture.verifiedRevertMergeId);
    await screenshot(page, info, "04-outcome-ambiguous-revert");
    await analyticsValue(page, "Revert rate", "Verified reverts among covered merges").press(
      "Enter",
    );
    await expect(evidence).toContainText(fixture.verifiedRevertMergeId);
    await expect(evidence).not.toContainText(fixture.ambiguousRevertMergeId);
    await expect(evidence).toContainText(fixture.revertCoverageId);
    await evidence
      .getByText("Revert relationship observations", { exact: true })
      .click({ timeout: 10_000 });
    await expect(evidence.getByText(fixture.verifiedRelationshipId, { exact: true })).toBeVisible();

    await page.goto(analytics);
    const exports = page.getByRole("region", { name: "Export analytics" });
    await exports.getByRole("button", { name: "Create export snapshot", exact: true }).click();
    const json = await download(page, "JSON");
    const csv = await download(page, "CSV");
    const firstDocument: unknown = JSON.parse(json.bytes.toString("utf8"));
    const first = snapshot.parse(firstDocument);
    assertFactoryOutcomeExportReconciles(firstDocument);
    expect(first).toMatchObject({ workspaceId: fixture.workspaceId, factoryId: fixture.factoryId });
    expect(Date.parse(first.filters.from)).toBe(Date.parse(fixture.from));
    expect(Date.parse(first.filters.to)).toBe(Date.parse(fixture.to));
    const [primary, previous] = first.periods;
    expect(primary.key).toBe("primary");
    expect(previous.key).toBe("comparison");
    expect(Date.parse(previous.window.from)).toBe(Date.parse(fixture.comparisonFrom));
    expect(Date.parse(primary.window.from)).toBe(Date.parse(first.filters.from));
    expect(Date.parse(primary.window.to)).toBe(Date.parse(first.filters.to));
    expect(Date.parse(previous.window.to)).toBe(Date.parse(primary.window.from));
    expect(primary.rolesVisibility).toBe("redacted");
    const inconsistent = structuredClone(first);
    const throughput = z
      .looseObject({ observedMergeCount: z.number() })
      .parse(primary.summaries.throughput);
    inconsistent.periods[0].summaries.throughput = {
      ...throughput,
      observedMergeCount: throughput.observedMergeCount + 1,
    };
    expect(() => assertFactoryOutcomeExportReconciles(inconsistent)).toThrow(/canonical merges/);
    expect(primary.summaries).toMatchObject({
      flow: {
        metricRevisions: { workflow_flow: 1, request_to_merge: 1, request_to_deployment: 1 },
        merge: {
          total: requestCount,
          measured: fixture.expected.mergeMeasured,
          unknown: fixture.expected.mergeUnknown,
          distribution: {
            minSeconds: 7200,
            p50Seconds: fixture.expected.mergeMedianSeconds,
            p95Seconds: 21060,
            maxSeconds: 21600,
          },
        },
        deployment: {
          total: requestCount,
          measured: fixture.expected.deploymentMeasured,
          unknown: requestCount - fixture.expected.deploymentMeasured,
          distribution: { p50Seconds: fixture.expected.deploymentMedianSeconds },
        },
      },
      cost: {
        mergeCohort: { observedMergeCount: fixture.expected.observedMergeCount },
        costs: {
          delivery: {
            metricRevision: 1,
            knownCostUsd: fixture.expected.knownCostUsd,
            knownCostPerObservedMergeUsd: fixture.expected.costPerObservedMergeUsd,
            unavailableAttempts: fixture.expected.unavailableAttempts,
            ratioState: "partial",
          },
        },
      },
      throughput: { metricRevision: 1, observedMergeCount: fixture.expected.observedMergeCount },
      revert: {
        metricRevision: 1,
        coveredMatureCount: fixture.expected.matureCoveredCount,
        revertedCoveredCount: fixture.expected.revertedCoveredCount,
        ambiguousCount: fixture.expected.ambiguousRevertCount,
        immatureCount: fixture.expected.immatureRevertCount,
        revertRate: fixture.expected.revertRate,
      },
    });
    expect(previous.summaries).toMatchObject({
      throughput: { observedMergeCount: fixture.expected.previousObservedMergeCount },
      cost: {
        costs: {
          delivery: { ratioState: "no_observed_merges", knownCostPerObservedMergeUsd: null },
        },
      },
    });
    expect(primary.evidence.deployment).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: fixture.deliveredSessionId,
          status: "measured",
          seconds: fixture.expected.deploymentMedianSeconds,
          requestObservationId: fixture.requestObservationId,
          mergeObservationId: fixture.mergeObservationId,
          deploymentObservationId: fixture.deploymentObservationId,
        }),
      ]),
    );
    expect(
      primary.evidence.deployment.some(
        (row) => row.deploymentObservationId === fixture.unlinkedDeploymentObservationId,
      ),
    ).toBe(false);
    expect(primary.evidence.merge).toContainEqual(
      expect.objectContaining({
        sessionId: fixture.unknownSessionId,
        status: "unknown",
        seconds: null,
      }),
    );
    expect(primary.evidence.deliveryCost).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run_id: fixture.failedRunId,
          cost_state: "unavailable",
          cost_usd: null,
        }),
      ]),
    );
    expect(primary.evidence.revert).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          originalMergeId: fixture.verifiedRevertMergeId,
          hasVerifiedRevert: true,
          status: "covered",
        }),
        expect.objectContaining({
          originalMergeId: fixture.ambiguousRevertMergeId,
          status: "ambiguous",
        }),
      ]),
    );
    expect(
      primary.evidence.throughput.every(
        (row) =>
          row.credentialOwnerMemberId == null &&
          row.credentialOwnerServicePrincipalId == null &&
          row.budgetPayerMemberId == null,
      ),
    ).toBe(true);
    const csvRows = parseCsv(csv.bytes);
    for (const snapshotPeriod of first.periods) {
      const rows = csvRows.filter((row) => row.period === snapshotPeriod.key);
      const csvSummaries = Object.fromEntries(
        rows
          .filter((row) => row.record_type === "summary")
          .map((row) => [row.metric, csvRecord(row.record_json)]),
      );
      expect(csvSummaries).toEqual(snapshotPeriod.summaries);
      for (const [metric, facts] of Object.entries(snapshotPeriod.evidence)) {
        expect(
          rows
            .filter((row) => row.record_type === "observation" && row.metric === metric)
            .map((row) => csvRecord(row.record_json)),
        ).toEqual(facts);
      }
    }
    const csvDeployment = csvRows.find(
      (row) =>
        row.record_type === "observation" &&
        row.metric === "deployment" &&
        row.observation_id === fixture.deploymentObservationId,
    );
    expect(csvDeployment).toMatchObject({
      snapshot_id: first.id,
      workspace_id: fixture.workspaceId,
      factory_id: fixture.factoryId,
      period: "primary",
      from_inclusive: primary.window.from,
      to_exclusive: primary.window.to,
      metric_revision: "1",
      roles_visibility: "redacted",
    });
    expect(Number(csvDeployment?.elapsed_seconds)).toBe(fixture.expected.deploymentMedianSeconds);
    expect(
      csvRows.filter((row) => row.record_type === "summary" && row.metric === "throughput"),
    ).toHaveLength(2);
    for (const href of [json.href, csv.href]) {
      const privateDownload = await page.request.get(href);
      expect(privateDownload.ok()).toBe(true);
      expect(privateDownload.headers()["cache-control"]).toBe("private, no-store");
      expect(privateDownload.headers()["content-disposition"]).toMatch(/^attachment;/);
    }
    await screenshot(page, info, "05-outcome-private-exports");

    const owner = await managerContext.newPage();
    await signInViaMagicLink(owner, analytics, { baseURL: fixture.app, email: fixture.ownerEmail });
    expect((await owner.request.get(json.href)).status()).toBe(404);
    const otherPath = json.href
      .replace(`/workspaces/${fixture.workspaceId}/`, `/workspaces/${fixture.otherWorkspaceId}/`)
      .replace(`/factories/${fixture.factoryId}/`, `/factories/${fixture.otherFactoryId}/`);
    expect((await page.request.get(otherPath)).status()).toBe(404);
    expect((await owner.request.get(otherPath)).status()).toBe(404);
    await page.goto(`/w/${fixture.otherWorkspaceSlug}/analytics`);
    await expect(page.getByRole("region", { name: "Export analytics" })).toHaveCount(0);
    const siblingPath = json.href.replace(
      `/factories/${fixture.factoryId}/`,
      `/factories/${fixture.siblingFactoryId}/`,
    );
    expect((await page.request.get(siblingPath)).status()).toBe(404);
    await page.goto(
      `${workspace}/analytics?${new URLSearchParams({ ...scope, factory: fixture.siblingFactoryId })}`,
    );
    await expect(
      page.getByRole("heading", { name: "Factory unavailable", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Export analytics" })).toHaveCount(0);

    await fixture.observeSiblingPendingRequest();
    await page.goto(overview);
    await expect(
      page.getByRole("region", { name: "Projection health" }).getByText("Current", { exact: true }),
    ).toBeVisible();

    const correction = await fixture.applyLateCorrection();
    await fixture.drainProjections();
    await page.goto(overview);
    await expect(overviewValue(page, "Time to delivery", "Request to merge")).toContainText(
      duration(fixture.expected.correctedMergeMedianSeconds),
    );
    await expect(overviewValue(page, "Time to delivery", "Request to deployment")).toContainText(
      duration(fixture.expected.correctedDeploymentMedianSeconds),
    );
    await expect(
      overviewValue(page, "Pull request throughput", "Observed canonical merges"),
    ).toContainText(String(fixture.expected.observedMergeCount));
    expect(await (await page.request.get(json.href)).body()).toEqual(json.bytes);
    expect(await (await page.request.get(csv.href)).body()).toEqual(csv.bytes);
    await page.getByRole("link", { name: "Open Analytics" }).click();
    await expect(analyticsValue(page, "Work flow", "Delivery")).toContainText(
      duration(fixture.expected.correctedDeliveryPhaseSeconds),
    );
    await analyticsValue(page, "Time to delivery", "Request to deployment Median").press("Enter");
    await expect(evidence).toContainText(correction.mergeObservationId);
    await expect(evidence).toContainText(correction.deploymentObservationId);
    await expect(evidence).not.toContainText(fixture.deploymentObservationId);

    await exports.getByRole("button", { name: "Create export snapshot", exact: true }).click();
    const nextJson = await download(page, "JSON");
    const nextDocument: unknown = JSON.parse(nextJson.bytes.toString("utf8"));
    const next = snapshot.parse(nextDocument);
    assertFactoryOutcomeExportReconciles(nextDocument);
    expect(next.id).not.toBe(first.id);
    expect(next.periods[0].evidence.deployment).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: fixture.deliveredSessionId,
          mergeObservationId: correction.mergeObservationId,
          deploymentObservationId: correction.deploymentObservationId,
          seconds: fixture.expected.correctedDeploymentMedianSeconds,
        }),
      ]),
    );

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
    await expect(overviewValue(page, "Time to delivery", "Request to deployment")).toContainText(
      "5 h",
    );
    await screenshot(page, info, "06-outcome-overview-dark-mobile");
  } finally {
    try {
      await managerContext.close();
    } finally {
      await fixture.cleanup();
    }
  }
});
