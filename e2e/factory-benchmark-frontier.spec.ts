import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod/v4";

import { benchmarkFrontierSchema } from "@/lib/factory-benchmarks/frontier-contracts";
import { routingDraftResponseSchema } from "@/lib/model-routing/draft-contracts";

import { signInViaMagicLink } from "./helpers/auth";
import { selectDropdownOption } from "./helpers/select";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";

async function capture(page: Page, section: Locator, info: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await section.screenshot({
    path,
    animations: "disabled",
    caret: "hide",
    // Global navigation can overlay the plot in a focused section capture.
    style: '[data-shell-header], a[href="#main-content"] { visibility: hidden !important; }',
  });
  await info.attach(name, { path, contentType: "image/png" });
}

async function captureRoutingFlow(page: Page, info: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled", caret: "hide" });
  await info.attach(name, { path, contentType: "image/png" });
}

test("the frozen frontier explains comparable measured cost, repeats and exclusions", async ({
  baseURL,
  browser,
  page,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_BENCHMARKS_E2E !== "1",
    "Requires a disposable loopback Supabase project.",
  );
  test.setTimeout(240_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const experimentId = randomUUID();
  const admin = createClient(
    z.url().parse(process.env.NEXT_PUBLIC_SUPABASE_URL),
    z.string().min(1).parse(process.env.SUPABASE_SECRET_KEY),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  let storagePaths: string[] = [];
  const viewer = await browser.newContext();

  try {
    const benchmarks = `/w/${fixture.slug}/benchmarks`;
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    const reader = await viewer.newPage();
    await signInViaMagicLink(page, benchmarks, { baseURL: fixture.app, email: fixture.ownerEmail });
    await signInViaMagicLink(reader, benchmarks, {
      baseURL: fixture.app,
      email: fixture.viewerEmail,
    });
    const seeded = z
      .object({
        suiteId: z.uuid(),
        suiteRevisionId: z.uuid(),
        accuracyScorerRevisionId: z.uuid(),
        validationScorerRevisionId: z.uuid(),
        storagePaths: z.array(z.string()).length(25),
      })
      .parse(
        await test.step("Settle exact local benchmark and judge receipts", () =>
          fixture.runFixtureFile("factory-benchmark-frontier-seed.sql", {
            workspace_id: fixture.workspaceId,
            factory_id: fixture.factoryId,
            owner_id: fixture.ownerId,
            pipeline_id: fixture.pipelineId,
            stage_id: fixture.stageId,
            experiment_id: experimentId,
            excluded_run_id: fixture.failedRunId,
          })),
      );
    storagePaths = seeded.storagePaths;
    const comparisonPath = `${benchmarks}/${seeded.suiteId}/comparisons/${experimentId}?factory=${fixture.factoryId}&scorerRevisionId=${seeded.accuracyScorerRevisionId}`;
    const endpoint = `/api/workspaces/${fixture.workspaceId}/factories/${fixture.factoryId}/benchmarks/experiments/${experimentId}/frontier?scorerRevisionId=${seeded.accuracyScorerRevisionId}`;
    await page.goto(comparisonPath);

    const section = page.locator("#cost-quality-frontier");
    await expect(section.getByRole("heading", { name: "Cost and quality frontier" })).toBeVisible();
    const response = await page.request.get(endpoint);
    expect(response.ok()).toBe(true);
    const frontier = benchmarkFrontierSchema.parse(await response.json());
    expect(frontier.policy).toMatchObject({ qualityFloorBps: 8000, minimumResolved: 2 });
    expect(frontier.items.length).toBe(frontier.candidateCount);
    expect(frontier.cohort.plannedTrialCount).toBe(
      frontier.cohort.eligibleTrialCount + frontier.cohort.excludedTrialCount,
    );
    expect(frontier.cohort).toMatchObject({
      plannedTrialCount: 50,
      eligibleTrialCount: 25,
      excludedTrialCount: 25,
      eligibleSlotCount: 5,
    });
    expect(frontier.recommendation).toMatchObject({
      status: "tied",
      candidateCount: 2,
      meanCostUsd: "0.08",
      passRateBps: 8000,
    });
    expect(frontier.frontierCount).toBe(3);

    const table = section.getByRole("table", { name: "Frontier configuration results" });
    const chart = section.getByRole("figure", { name: "Measured cost and pass rate" });
    await expect(table.getByRole("row")).toHaveCount(frontier.candidateCount + 1);
    const recommended = frontier.items.find((item) => item.isRecommended);
    const dominated = frontier.items.find((item) => item.status === "dominated");
    const unknown = frontier.items.find((item) => item.exclusions.includes("unavailable_cost"));
    expect(recommended).toBeDefined();
    expect(dominated).toBeDefined();
    expect(unknown).toBeDefined();
    if (!recommended || !dominated || !unknown) throw new Error("Incomplete frontier fixture.");

    const winnerRowId = `frontier-configuration-${recommended.candidateKey}`;
    const winnerRow = table.locator(`#${winnerRowId}`);
    const dominatedRow = table.locator(`#frontier-configuration-${dominated.candidateKey}`);
    const unknownRow = table.locator(`#frontier-configuration-${unknown.candidateKey}`);
    await expect(winnerRow.getByText("Recommended", { exact: true })).toBeVisible();
    await expect(winnerRow.getByText("0%–100% across 5 repeats")).toBeVisible();
    await expect(winnerRow.getByText("$0.08–$0.08 across 5 repeats")).toBeVisible();
    await expect(dominatedRow.getByText(/^Dominated by /)).toBeVisible();
    await expect(unknownRow.getByText("Mean cost unavailable")).toBeVisible();
    await expect(
      unknownRow.getByText("Measured cost is unavailable for one or more trials"),
    ).toBeVisible();
    await expect(
      chart.locator(`[href="#frontier-configuration-${unknown.candidateKey}"]`),
    ).toHaveCount(0);
    const winnerPoint = chart.locator(`[href="#${winnerRowId}"]`);
    await expect(winnerPoint).toHaveAccessibleName(/per trial, .+ pass rate, Recommended/);
    await winnerPoint.focus();
    await expect(winnerPoint).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(winnerRow).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`#${winnerRowId}$`));
    await capture(page, section, info, "benchmark-frontier-desktop-light");

    const pagedResponse = await page.request.get(`${endpoint}&limit=1`);
    expect(pagedResponse.ok()).toBe(true);
    const firstPage = benchmarkFrontierSchema.parse(await pagedResponse.json());
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.recommendation).toEqual(frontier.recommendation);
    expect(firstPage.nextCursor).not.toBeNull();
    if (!firstPage.nextCursor) throw new Error("Missing frontier cursor fixture.");
    const paginated = new URL(comparisonPath, fixture.app);
    paginated.searchParams.set("afterFrontierCandidateKey", firstPage.nextCursor.candidateKey);
    paginated.searchParams.set("afterCandidateKey", firstPage.nextCursor.candidateKey);
    await page.goto(paginated.href);
    await expect(table.getByRole("row")).toHaveCount(frontier.candidateCount);
    await expect(
      section.getByRole("link", { name: "First frontier configurations" }),
    ).toBeVisible();

    await section.getByRole("spinbutton", { name: "Quality floor (%)" }).fill("83.34");
    const apply = section.getByRole("button", { name: "Apply constraints" });
    await apply.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.searchParams.get("qualityFloorPercent") === "83.34");
    await expect(
      section.getByRole("heading", { name: "Recommended configuration", exact: true }),
    ).toBeVisible();
    await expect(section.getByText(/\$0\.15 per trial · 100% pass rate\./)).toBeVisible();

    const scorer = section.getByRole("combobox", { name: "Frozen scorer" });
    await selectDropdownOption(scorer, seeded.validationScorerRevisionId);
    await apply.click();
    await page.waitForURL(
      (url) => url.searchParams.get("scorerRevisionId") === seeded.validationScorerRevisionId,
    );
    await expect(
      section.getByRole("heading", { name: "Equally recommended configurations" }),
    ).toBeVisible();
    await expect(section.getByText(/\$0\.08 per trial · 100% pass rate\./)).toBeVisible();

    await section.getByRole("spinbutton", { name: "Minimum resolved trials" }).fill("6");
    await apply.click();
    await page.waitForURL((url) => url.searchParams.get("minResolvedTrials") === "6");
    await expect(section.getByRole("heading", { name: "No recommendation" })).toBeVisible();
    await expect(section.getByText("Fewer resolved trials than required").first()).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(frontier.candidateCount + 1);
    const filtered = new URL(page.url());
    expect(filtered.searchParams.has("afterFrontierCandidateKey")).toBe(false);
    expect(filtered.searchParams.get("afterCandidateKey")).toBe(firstPage.nextCursor.candidateKey);
    expect(filtered.searchParams.get("qualityFloorPercent")).toBe("83.34");
    expect(filtered.searchParams.get("scorerRevisionId")).toBe(seeded.validationScorerRevisionId);
    await page.reload();
    await expect(section.getByRole("spinbutton", { name: "Quality floor (%)" })).toHaveValue(
      "83.34",
    );
    await expect(section.getByRole("heading", { name: "No recommendation" })).toBeVisible();

    await page.goto(comparisonPath);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(winnerRow).toBeVisible();
    await capture(page, section, info, "benchmark-frontier-mobile-dark");

    await test.step("Create a reviewed draft from exact measured evidence", async () => {
      const routingEndpoint = endpoint.replace(/frontier\?.*$/, "routing-drafts");
      const readActivation = async () => {
        const { data, error } = await admin
          .from("factory_definition_activations")
          .select("activation_number,revision_id")
          .eq("workspace_id", fixture.workspaceId)
          .eq("factory_id", fixture.factoryId)
          .order("activation_number");
        if (error) throw error;
        return data;
      };
      const activeBefore = await readActivation();
      expect(activeBefore).toHaveLength(1);
      const routingCandidate = frontier.items.filter((candidate) => candidate.isRecommended).at(-1);
      if (!routingCandidate || routingCandidate.position !== frontier.candidateCount) {
        throw new Error(
          "The routing fixture needs a qualified candidate at the final frontier position.",
        );
      }
      const routingRowId = `frontier-configuration-${routingCandidate.candidateKey}`;
      const routingRow = table.locator(`#${routingRowId}`);
      const applyRouting = routingRow.getByRole("button", { name: "Apply to routing" });
      await expect(applyRouting).toBeVisible();
      await expect(unknownRow.getByRole("button", { name: "Apply to routing" })).toHaveCount(0);
      await applyRouting.click();
      const dialog = page.getByRole("dialog", { name: "Apply to routing" });
      await expect(dialog).toBeVisible();
      await captureRoutingFlow(page, info, "apply-routing-mobile-dark");
      await page.setViewportSize({ width: 1440, height: 960 });
      await dialog.getByRole("textbox", { name: "Task class name" }).fill("Invoice delivery");
      await dialog.getByRole("textbox", { name: "Task class slug" }).fill("delivery");
      await dialog.getByRole("spinbutton", { name: "Maximum mean cost (USD)" }).fill("0.10");
      await dialog
        .getByRole("spinbutton", { name: "Maximum p95 wall latency (ms)" })
        .fill("120000");
      const floor = dialog.getByRole("spinbutton", { name: "Quality floor (%)" });
      const createDraft = dialog.getByRole("button", { name: "Create routing draft" });
      await expect(floor).toHaveValue("80");
      await floor.fill("100");
      await createDraft.click();
      await expect(dialog.getByRole("alert")).toHaveText(/below the selected quality floor/i);
      await captureRoutingFlow(page, info, "apply-routing-below-quality-floor");
      await floor.fill("80");
      const savedResponse = page.waitForResponse(
        (result) =>
          new URL(result.url()).pathname === routingEndpoint &&
          result.request().method() === "POST",
      );
      await createDraft.click();
      const saved = await savedResponse;
      const savedBody: unknown = await saved.json();
      expect(saved.status(), JSON.stringify(savedBody)).toBe(201);
      await expect(dialog.getByRole("status")).toHaveText("Routing draft created.");
      const draft = routingDraftResponseSchema.parse(savedBody);
      expect(await readActivation()).toEqual(activeBefore);

      const directRequest = {
        requestId: randomUUID(),
        candidateKey: routingCandidate.candidateKey,
        scorerRevisionId: seeded.accuracyScorerRevisionId,
        suiteRevisionId: seeded.suiteRevisionId,
        taskClass: { slug: "delivery", name: "Invoice delivery" },
        constraints: {
          qualityFloorBps: 8000,
          maxMeanCostUsd: 0.1,
          maxLatencyMs: 120_000,
          minResolvedTrials: 2,
          minConfidenceBps: null,
        },
      };
      const unavailable = await page.request.post(routingEndpoint, {
        data: { ...directRequest, candidateKey: unknown.candidateKey },
      });
      expect(unavailable.status()).toBe(422);
      expect(await unavailable.json()).toMatchObject({
        error: expect.stringMatching(/measured cost/i),
      });
      const stale = await page.request.post(routingEndpoint, {
        data: { ...directRequest, requestId: randomUUID(), suiteRevisionId: randomUUID() },
      });
      expect(stale.status()).toBe(409);
      expect(await stale.json()).toMatchObject({
        error: expect.stringMatching(/suite revision changed/i),
      });
      const denied = await reader.request.post(routingEndpoint, {
        data: { ...directRequest, requestId: randomUUID() },
      });
      expect(denied.status()).toBe(403);
      expect(await readActivation()).toEqual(activeBefore);

      await dialog.getByRole("link", { name: "Open routing draft" }).click();
      await expect(page).toHaveURL(new RegExp(`[?&]draft=${draft.draftId}(?:&|$)`));
      const workingDraftUrl = new URL(page.url());
      workingDraftUrl.searchParams.delete("draft");
      workingDraftUrl.hash = "";
      await expect(page.getByRole("heading", { name: "Routing draft evidence" })).toBeVisible({
        timeout: 75_000,
      });
      const evidenceLink = page.getByRole("link", { name: "Open exact comparison configuration" });
      const suiteLink = page.getByRole("link", { name: "Open frozen suite revision" });
      const evidenceUrl = new URL((await evidenceLink.getAttribute("href")) ?? "", fixture.app);
      expect(evidenceUrl.pathname).toContain(`/comparisons/${experimentId}`);
      expect(evidenceUrl.searchParams.get("scorerRevisionId")).toBe(
        seeded.accuracyScorerRevisionId,
      );
      expect(evidenceUrl.searchParams.get("routingCandidateKey")).toBe(
        routingCandidate.candidateKey,
      );
      expect(evidenceUrl.hash).toBe(`#${routingRowId}`);
      const suiteUrl = new URL((await suiteLink.getAttribute("href")) ?? "", fixture.app);
      expect(suiteUrl.pathname).toBe(`${benchmarks}/${seeded.suiteId}`);
      expect(suiteUrl.searchParams.get("revision")).toBe(seeded.suiteRevisionId);
      await page.getByRole("button", { name: "Switch to light mode", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await captureRoutingFlow(page, info, "routing-draft-exact-evidence");
      await evidenceLink.click();
      await expect(routingRow).toBeVisible({ timeout: 75_000 });
      await expect(table.getByRole("row")).toHaveCount(2);
      await expect(page).toHaveURL(new RegExp(`#${routingRowId}$`));

      await page.goto(workingDraftUrl.href);
      await expect(page.getByRole("heading", { name: "Routing draft evidence" })).toBeVisible({
        timeout: 75_000,
      });
      await expect(evidenceLink).toHaveAttribute(
        "href",
        evidenceUrl.pathname + evidenceUrl.search + evidenceUrl.hash,
      );
      await captureRoutingFlow(page, info, "routing-draft-working-editor");
    });

    expect(
      (
        await page.request.get(endpoint.replace(fixture.factoryId, fixture.siblingFactoryId))
      ).status(),
    ).toBe(404);
    expect((await reader.request.get(endpoint)).status()).toBe(403);
  } finally {
    await viewer.close();
    await test.step("Clean up the loopback workspace", async () => {
      if (storagePaths.length) {
        expect(
          await fixture.runFixtureFile("factory-benchmark-frontier-seed.sql", {
            workspace_id: fixture.workspaceId,
            workspace_slug: fixture.slug,
            cleanup_paths: JSON.stringify(storagePaths),
          }),
        ).toEqual({ removed: storagePaths.length });
      }
      await fixture.cleanup();
    });
  }
});
