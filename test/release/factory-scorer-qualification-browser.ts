import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { createServerClient } from "@supabase/ssr";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";

import { workspaceRunDetailPath, workspaceScorerDetailPath } from "@/lib/routes";
import type { Database } from "@/lib/supabase/database.types";

import type { FactoryScorerBrowserFixture } from "./factory-scorer-runtime-fixture";

type BrowserQualificationOptions = {
  appUrl: string;
  proofDir?: string;
  supabaseUrl: string;
  publishableKey: string;
};

const scorerName = "Qualification artifact review";
const scoredRunTitle = "Publish the scored qualification artifact";
const canceledRunTitle = "Publish while canceling the revised scorer";
const artifactBody = "The exact retained output passed the fixture rubric.";
const explanation = "The retained fixture evidence satisfies the pinned rubric.";

function loopbackOrigin(value: string) {
  const url = new URL(value);
  assert.ok(
    url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/",
    "Scorer browser proof requires a loopback fixture origin.",
  );
  return url.origin;
}

async function signInBrowser(
  context: BrowserContext,
  app: string,
  supabase: string,
  publishableKey: string,
  credentials: FactoryScorerBrowserFixture["owner"],
) {
  const jar = new Map<string, string>();
  const client = createServerClient<Database>(supabase, publishableKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (writes) => writes.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const result = await client.auth.signInWithPassword(credentials);
  assert.ok(
    !result.error && result.data.user && jar.size,
    "The scorer fixture reviewer could not sign in.",
  );
  await context.addCookies(
    [...jar].map(([name, value]) => ({ name, value, url: app, httpOnly: true })),
  );
}

async function capture(page: Page, section: Locator, proofDir: string | undefined, name: string) {
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1),
    "Scorer qualification UI must fit the viewport.",
  );
  if (!proofDir) return;
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await section.screenshot({
    path: join(proofDir, `${name}.png`),
    animations: "disabled",
    caret: "hide",
  });
}

async function followRun({
  page,
  app,
  workspaceSlug,
  results,
  runId,
  jobId,
  attemptId,
}: {
  page: Page;
  app: string;
  workspaceSlug: string;
  results: Locator;
  runId: string;
  jobId: string;
  attemptId: string;
}) {
  const path = workspaceRunDetailPath(workspaceSlug, runId);
  const url = new URL(`${path}?evaluationAttempt=${attemptId}#evaluation-${jobId}`, app);
  const action = results
    .getByRole("link", { name: "Open run", exact: true })
    .and(results.locator(`a[href^="${path}?"]`));
  assert.equal(await action.getAttribute("href"), `${url.pathname}${url.search}${url.hash}`);
  await action.click();
  await page.waitForURL(url.href);
  const receipt = page.locator(`#evaluation-${jobId}:visible`);
  await receipt.waitFor();
  return { url, receipt };
}

export async function runFactoryScorerQualificationBrowser(
  fixture: FactoryScorerBrowserFixture,
  { appUrl, supabaseUrl, publishableKey, proofDir }: BrowserQualificationOptions,
) {
  const app = loopbackOrigin(appUrl);
  const supabase = loopbackOrigin(supabaseUrl);
  if (proofDir) {
    assert.ok(isAbsolute(proofDir), "Scorer browser proof path must be absolute.");
    await mkdir(proofDir, { recursive: true });
  }

  const from = fixture.cohort.from.slice(0, 10);
  const to = fixture.cohort.to.slice(0, 10);
  const fields = { factory: fixture.factoryId, from, to };
  const oldCohort = workspaceScorerDetailPath(fixture.workspaceSlug, fixture.scorerId, {
    ...fields,
    revision: fixture.oldRevisionId,
    cohort: fixture.oldPolicyId,
    scoreSnapshot: fixture.cohort.snapshot,
  });
  const revisedCohort = workspaceScorerDetailPath(fixture.workspaceSlug, fixture.scorerId, {
    ...fields,
    revision: fixture.newRevisionId,
    cohort: fixture.newPolicyId,
  });
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
  });

  try {
    const context = await browser.newContext({
      baseURL: app,
      viewport: { width: 1440, height: 960 },
      reducedMotion: "reduce",
      colorScheme: "light",
    });
    context.setDefaultTimeout(25_000);
    await signInBrowser(context, app, supabase, publishableKey, fixture.owner);
    const page = await context.newPage();
    const trend = page.locator("#scorer-trends:visible");
    const results = trend.getByRole("region", { name: "Cohort results" });
    const table = trend.getByRole("table", { name: "Scorer trend totals" });
    const revisionHeading = (version: number) =>
      page.getByRole("heading", { name: `Revision ${version}`, exact: true });
    const cohortPicker = trend.getByRole("combobox", { name: "Sampling cohort" });

    assert.equal((await page.goto(oldCohort))?.status(), 200);
    await page.getByRole("heading", { name: scorerName, exact: true }).waitFor();
    await revisionHeading(1).waitFor();
    assert.equal(await cohortPicker.inputValue(), fixture.oldPolicyId);
    await page.locator('html[data-theme="light"]').waitFor({ state: "attached" });
    const point = trend.getByRole("link", { name: /1 passed of 1 decided, open cohort results/ });
    const href = await point.getAttribute("href");
    assert(href, "The passing chart point must link to its retained cohort.");
    const pointUrl = new URL(href, app);
    assert.equal(pointUrl.searchParams.get("scoreSnapshot"), fixture.cohort.snapshot);
    const row = table.locator("tbody tr").filter({ has: page.locator(`a[href="${href}"]`) });
    assert.equal(await row.count(), 1, "The day and its table row must open the same cohort.");
    await capture(page, trend, proofDir, "01-scorer-original-cohort-desktop-light");

    await point.click();
    await page.waitForURL(pointUrl.href);
    const original = await followRun({
      page,
      app,
      workspaceSlug: fixture.workspaceSlug,
      results,
      runId: fixture.scoredRunId,
      jobId: fixture.scoredJobId,
      attemptId: fixture.scoredAttemptId,
    });
    await page.getByRole("heading", { name: scoredRunTitle, exact: true }).waitFor();
    await original.receipt.getByText("Passed", { exact: true }).waitFor();
    await original.receipt.getByText(/Score True/).waitFor();
    await original.receipt.getByText(explanation, { exact: true }).waitFor();
    const artifact = original.receipt.getByRole("link", { name: "Open artifact", exact: true });
    const artifactHref = await artifact.getAttribute("href");
    assert(artifactHref, "A scored receipt must link to the retained artifact.");
    const artifactUrl = new URL(artifactHref, app);
    assert.equal(artifactUrl.origin, app);
    assert.equal(artifactUrl.searchParams.get("artifactId"), fixture.scoredArtifactId);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
    await page.locator('html[data-theme="dark"]').waitFor({ state: "attached" });
    await capture(
      page,
      page.locator("#scorer-evaluations:visible"),
      proofDir,
      "02-scorer-original-receipt-mobile-dark",
    );
    await artifact.click();
    await page.waitForURL(artifactUrl.href);
    await page.getByText(artifactBody, { exact: true }).first().waitFor();

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole("button", { name: "Switch to light mode", exact: true }).click();
    assert.equal((await page.goto(revisedCohort))?.status(), 200);
    await revisionHeading(2).waitFor();
    assert.equal(await cohortPicker.inputValue(), fixture.newPolicyId);
    await results.getByText("Canceled", { exact: true }).waitFor();
    await page.locator('html[data-theme="light"]').waitFor({ state: "attached" });
    await capture(page, trend, proofDir, "03-scorer-revised-canceled-cohort-desktop-light");
    const canceled = await followRun({
      page,
      app,
      workspaceSlug: fixture.workspaceSlug,
      results,
      runId: fixture.canceledRunId,
      jobId: fixture.canceledJobId,
      attemptId: fixture.canceledAttemptId,
    });
    await page.getByRole("heading", { name: canceledRunTitle, exact: true }).waitFor();
    await canceled.receipt.getByText("Canceled", { exact: true }).first().waitFor();
    assert.equal(await canceled.receipt.getByText("Passed", { exact: true }).count(), 0);
    assert.equal(
      await canceled.receipt.getByRole("link", { name: "Open artifact", exact: true }).count(),
      0,
    );

    assert.equal((await page.goto(original.url.href))?.status(), 200);
    await original.receipt.getByText("Passed", { exact: true }).waitFor();
    await original.receipt.getByText(explanation, { exact: true }).waitFor();
    assert.equal(await artifact.getAttribute("href"), artifactHref);
  } finally {
    await browser.close();
  }
}
