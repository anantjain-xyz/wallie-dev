import { randomUUID } from "node:crypto";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod/v4";

import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";

const governanceSeed = z.object({
  scorerId: z.uuid(),
  revisions: z.tuple([z.uuid(), z.uuid()]),
  runs: z.array(z.object({ runId: z.uuid() })).min(1),
});

test.use({ actionTimeout: 10_000 });

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

test("a factory operator disputes a verdict, creates a calibration set, and requests an exact rerun", async ({
  baseURL,
  browser,
  page,
}, info) => {
  test.skip(process.env.WALLIE_FACTORY_SCORERS_E2E !== "1", "Requires disposable local Supabase.");
  test.setTimeout(120_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const note = "The retained checks exercise the expected reconciliation behavior.";
  const calibrationName = "Invoice reconciliation calibration";
  const revisedCalibrationName = "Invoice reconciliation review set";

  try {
    const data = governanceSeed.parse(
      await fixture.runFixtureFile("factory-score-trends-seed.sql", {
        workspace_id: fixture.workspaceId,
        factory_id: fixture.factoryId,
        owner_id: fixture.ownerId,
        owner_member_id: fixture.ownerMemberId,
        pipeline_id: fixture.pipelineId,
        stage_id: fixture.stageId,
        extra_policy_count: "0",
      }),
    );
    const base = `/w/${fixture.slug}`;
    const scorer = `${base}/scorers/${data.scorerId}?factory=${fixture.factoryId}`;
    const run = `${base}/runs/${data.runs[0].runId}`;

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, scorer, { baseURL: fixture.app, email: fixture.ownerEmail });
    await expect(page.getByRole("heading", { name: "Scorer health" })).toBeVisible();
    await page.getByRole("checkbox", { name: "Validation report", exact: true }).uncheck();
    await page
      .getByRole("textbox", { name: "Rubric", exact: true })
      .fill(
        "Score the retained artifact against the reconciliation behavior after reviewer calibration.",
      );
    await page.getByRole("button", { name: "Publish revision", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Revision 3", exact: true })).toBeVisible();
    const revision = z.uuid().parse(new URL(page.url()).searchParams.get("revision"));

    await page.goto(run);
    await page.getByRole("link", { name: "Review evaluation", exact: true }).click();
    await expect(page).toHaveURL(/evaluationAttempt=/);
    const attemptId = z.uuid().parse(new URL(page.url()).searchParams.get("evaluationAttempt"));
    await expect(page.getByRole("heading", { name: "Adjudication", exact: true })).toBeVisible();
    await page
      .getByRole("combobox", { name: "Adjudication outcome" })
      .selectOption({ label: "Dispute verdict" });
    await page.getByRole("combobox", { name: "Expected outcome" }).selectOption({ label: "Pass" });
    await page.getByRole("textbox", { name: "Adjudication note" }).fill(note);
    await page.getByRole("button", { name: "Save adjudication", exact: true }).click();
    await expect(page.getByText(note, { exact: true })).toBeVisible();
    const evaluations = page.locator("#scorer-evaluations");
    await expect(evaluations.getByText("Failed", { exact: true }).first()).toBeVisible();

    await page.getByRole("combobox", { name: "Target rubric revision" }).selectOption(revision);
    await page.getByRole("button", { name: "Queue re-evaluation", exact: true }).click();
    await expect(page.getByText("Re-evaluation queued.", { exact: true })).toBeVisible();
    await expect(evaluations.getByText("Failed", { exact: true }).first()).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(page, info, "01-adjudication-and-rerun-mobile-dark");

    const attemptApi = `/api/workspaces/${fixture.workspaceId}/factories/${fixture.factoryId}/evaluation-attempts/${attemptId}`;
    const newerCases = await Promise.all(
      Array.from({ length: 41 }, (_, index) =>
        page.request.post(attemptApi, {
          data: {
            action: "adjudicate",
            adjudicationId: randomUUID(),
            disposition: "confirmed",
            note: `Newer calibration case ${index + 1}`,
          },
        }),
      ),
    );
    expect(newerCases.every((response) => response.ok())).toBe(true);

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await page.goto(`${scorer}&revision=${revision}`);
    const name = page.getByRole("textbox", { name: "Calibration set name" });
    const firstCase = page.getByRole("checkbox", { name: new RegExp(note) });
    await name.fill(calibrationName);
    await expect(firstCase).toHaveCount(0);
    await page.getByRole("button", { name: "Load older calibration cases", exact: true }).click();
    await expect(name).toHaveValue(calibrationName);
    await firstCase.check();
    await page.getByRole("button", { name: "Publish calibration set", exact: true }).click();
    await page.getByRole("link", { name: calibrationName, exact: true }).click();
    const historical = new URL(page.url());
    historical.searchParams.set("revision", data.revisions[0]);
    await page.goto(historical.toString());
    await name.fill(revisedCalibrationName);
    await page.getByRole("button", { name: "Publish next version", exact: true }).click();
    const history = page.getByRole("list", { name: "Calibration version history" });
    await expect(history.getByText(revisedCalibrationName, { exact: true })).toBeVisible();
    await expect(history.getByText(calibrationName, { exact: true })).toBeVisible();
    const pins = history.getByRole("link", { name: "Pinned rubric · Revision 3", exact: true });
    await expect(pins).toHaveCount(2);
    for (const pin of await pins.all())
      await expect(pin).toHaveAttribute("href", new RegExp(`revision=${revision}`));
    await page.getByRole("button", { name: "Pause scorer", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume scorer", exact: true })).toBeVisible();
    const health = page.locator("#scorer-health");
    await expect(health.getByText("Evaluator errors / settled")).toBeVisible();
    await expect(health.getByText("0 / 3 (0%)", { exact: true })).toBeVisible();
    await capture(page, info, "02-scorer-health-and-calibration-desktop-light");
    await page.getByRole("button", { name: "Resume scorer", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause scorer", exact: true })).toBeVisible();

    const reader = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    try {
      await signInViaMagicLink(reader, scorer, {
        baseURL: fixture.app,
        email: fixture.viewerEmail,
      });
      await expect(reader.getByText(revisedCalibrationName, { exact: true }).first()).toBeVisible();
      await expect(reader.getByRole("button", { name: "Pause scorer", exact: true })).toHaveCount(
        0,
      );
      await expect(reader.getByRole("button", { name: "Publish calibration set" })).toHaveCount(0);
    } finally {
      await reader.close();
    }
  } finally {
    await fixture.cleanup();
  }
});
