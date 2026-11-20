import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod/v4";

import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";

test.use({ actionTimeout: 10_000 });

const seed = z.object({
  scorerId: z.uuid(),
  revisions: z.tuple([z.uuid(), z.uuid()]),
  policies: z.tuple([z.uuid(), z.uuid()]),
  runs: z.tuple([
    z.object({ runId: z.uuid(), sessionId: z.uuid(), jobId: z.uuid() }),
    z.object({ runId: z.uuid(), sessionId: z.uuid(), jobId: z.uuid() }),
    z.object({ runId: z.uuid(), sessionId: z.uuid() }),
  ]),
});

async function capture(page: Page, info: TestInfo, name: string, section?: Locator) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  const options = { path, animations: "disabled", caret: "hide" } as const;
  if (section) await section.screenshot(options);
  else await page.screenshot({ ...options, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}

test("a factory reader inspects frozen score coverage and exact run evidence", async ({
  baseURL,
  page,
}, info) => {
  test.skip(process.env.WALLIE_FACTORY_SCORERS_E2E !== "1", "Requires disposable local Supabase.");
  test.setTimeout(120_000);
  const fixture = await seedFactoryAnalytics(baseURL);

  try {
    const data = seed.parse(
      await fixture.runFixtureFile("factory-score-trends-seed.sql", {
        workspace_id: fixture.workspaceId,
        factory_id: fixture.factoryId,
        owner_id: fixture.ownerId,
        owner_member_id: fixture.ownerMemberId,
        pipeline_id: fixture.pipelineId,
        stage_id: fixture.stageId,
      }),
    );
    const from = fixture.to;
    const to = new Date(Date.parse(from) + 86_400_000).toISOString().slice(0, 10);
    const scope = new URLSearchParams({ factory: fixture.factoryId, from, to });
    const base = `/w/${fixture.slug}`;
    const revisionPath = (revision: string, cohort: string) =>
      `${base}/scorers/${data.scorerId}?${new URLSearchParams({ ...Object.fromEntries(scope), revision, cohort })}`;
    const initial = revisionPath(data.revisions[0], data.policies[0]);

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, initial, { baseURL: fixture.app, email: fixture.viewerEmail });
    const trend = page.locator("#scorer-trends:visible");
    const coverage = trend.locator("dl:visible");
    await expect(coverage.getByText("/ 2 sampled", { exact: true })).toBeVisible();
    await expect(coverage.getByText("/ 2 usable", { exact: true })).toBeVisible();
    const table = trend.getByRole("table", { name: "Scorer trend totals" });
    const daily = table.locator("tbody tr").first();
    const total = table.getByRole("row", { name: /^Total/ });
    expect(await daily.getByRole("cell").allTextContents()).toEqual(
      await total.getByRole("cell").allTextContents(),
    );
    await expect(total.getByRole("cell", { name: "4.5", exact: true })).toBeVisible();
    await expect(trend.locator("#scorer-cohort-results")).toContainText("2 matching runs");
    await capture(page, info, "01-scorer-cohort-desktop-light");

    await daily.getByRole("link").click();
    await expect(page).toHaveURL(/scoreSnapshot=/);
    await expect(trend.locator("#scorer-cohort-results")).toContainText("2 matching runs");
    await trend.getByRole("combobox", { name: "Result state" }).selectOption("fail");
    await trend.getByRole("button", { name: "Filter results" }).click();
    await expect(trend.locator("#scorer-cohort-results")).toContainText("1 matching");
    await trend.getByRole("link", { name: "Open run", exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(
        `/runs/${data.runs[0].runId}\\?evaluationAttempt=.+#evaluation-${data.runs[0].jobId}$`,
      ),
    );
    const evaluations = page.locator("#scorer-evaluations");
    await expect(evaluations.getByText("Failed", { exact: true })).toBeVisible();
    await expect(
      evaluations.getByText("The retained checks show a reconciliation regression."),
    ).toBeVisible();
    const evidence = evaluations.getByRole("link", { name: "Open artifact", exact: true });
    await expect(evidence).toHaveAttribute("href", /artifactId=/);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(page, info, "02-scorer-exact-run-mobile-dark");
    await evidence.click();
    await expect(page).toHaveURL(/artifactId=/);
    await expect(
      page
        .getByText("Retained reconciliation checks for the exact commit.", { exact: true })
        .first(),
    ).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole("button", { name: "Switch to light mode" }).click();
    const analytics = `${base}/analytics?${scope}&scorerRevision=${data.revisions[1]}&cohort=${data.policies[1]}`;
    await page.goto(analytics);
    await expect(trend.getByRole("combobox", { name: "Scorer revision" })).toHaveValue(
      data.revisions[1],
    );
    await expect(
      trend.locator("#scorer-cohort-results").getByText("Missing evidence", { exact: true }),
    ).toBeVisible();
    await capture(page, info, "03-analytics-scorer-revision", trend);
    await trend.getByRole("link", { name: "Open run", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${data.runs[2].runId}#scorer-evaluations$`));
    await expect(evaluations.getByText("Missing evidence", { exact: true })).toBeVisible();

    const restricted = await page.request.get(
      `/api/workspaces/${fixture.workspaceId}/factories/${fixture.siblingFactoryId}/evaluations/${data.runs[0].jobId}`,
    );
    expect(restricted.status()).toBe(404);
  } finally {
    await fixture.cleanup();
  }
});
