import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod/v4";

import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";
import { expectDropdownValue, openDropdownListbox, selectDropdownOption } from "./helpers/select";

const scorerSeed = z.object({
  runs: z.array(z.object({ runId: z.uuid() })).min(1),
});
const failureSeed = z.object({
  revisions: z.tuple([z.uuid(), z.uuid()]),
  runs: z.array(z.uuid()).length(27),
  storagePaths: z.array(z.string().min(1)).length(26),
});

test.use({ actionTimeout: 15_000 });

async function capture(page: Page, info: TestInfo, name: string, keepFocus = false) {
  await page.evaluate(
    async ({ keepFocus }) => {
      await document.fonts.ready;
      if (!keepFocus && document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
      if (!keepFocus) window.scrollTo({ top: 0, behavior: "instant" });
    },
    { keepFocus },
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const output = process.env.WALLIE_FAILURE_GROUPS_PROOF_DIR;
  if (!output) return;
  await mkdir(output, { recursive: true });
  const path = resolve(output, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled", caret: "hide" });
  await info.attach(name, { path, contentType: "image/png" });
}

test("reviews recurring failures and preserves source evidence across filters, splits and dismissal", async ({
  baseURL,
  browser,
  page,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_FAILURE_GROUPS_E2E !== "1",
    "Requires disposable local Supabase.",
  );
  test.setTimeout(240_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const scopeFields = {
    workspace_id: fixture.workspaceId,
    factory_id: fixture.factoryId,
    owner_id: fixture.ownerId,
    owner_member_id: fixture.ownerMemberId,
    pipeline_id: fixture.pipelineId,
    stage_id: fixture.stageId,
  };
  let storagePaths: readonly string[] = [];
  let workflowError: unknown;
  const groupsPath = `/w/${fixture.slug}/failure-groups?factory=${fixture.factoryId}`;
  const reviewedLabel = "Recurring reconciliation checks";
  const main = page.locator("#main-content");

  try {
    const scores = scorerSeed.parse(
      await fixture.runFixtureFile(
        "factory-score-trends-seed.sql",
        { ...scopeFields, extra_policy_count: "0" },
        60_000,
      ),
    );
    const seeded = failureSeed.parse(
      await fixture.runFixtureFile("factory-failure-groups-seed.sql", scopeFields, 60_000),
    );
    storagePaths = seeded.storagePaths;

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, groupsPath, { baseURL: fixture.app, email: fixture.ownerEmail });
    await expect(page.getByRole("heading", { name: "Failure groups", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /^reconciliation-tests · .+ · / })).toBeVisible();
    await expect(main.getByText("Qualified evidence", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /^Reconciliation quality · .+ · / })).toBeVisible();
    await expect(main.getByText("Missing evidence")).toBeVisible();
    await capture(page, info, "01-failure-groups-desktop");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: /^Workspace navigation:/ }).press("Enter");
    const drawer = page.getByRole("dialog", { name: "Workspace pages" });
    await expect(drawer.getByRole("link", { name: "Failure groups", exact: true })).toBeVisible();
    await capture(page, info, "02a-failure-groups-mobile-navigation", true);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    const symptom = page.getByRole("combobox", { name: "Symptom", exact: true });
    const revision = page.getByRole("combobox", {
      name: "Factory definition revision",
      exact: true,
    });
    await selectDropdownOption(symptom, "validation");
    await symptom.focus();
    await symptom.press("Tab");
    await expect(revision).toBeFocused();
    const revisions = await openDropdownListbox(revision);
    await revisions
      .getByRole("option", { name: /Factory revision · Activation \d+ · .* · Active · / })
      .click();
    await expectDropdownValue(revision, seeded.revisions[1]);
    await page.getByRole("button", { name: "Apply filters", exact: true }).press("Enter");
    await expect(page).toHaveURL(new RegExp(`revision=${seeded.revisions[1]}`));
    await expect(page.getByRole("link", { name: /^reconciliation-tests · / })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Reconciliation quality · / })).toHaveCount(0);
    const unavailableGroup = page.getByRole("link", { name: /^Validation failure · / });
    const missingGroupPath = z.string().parse(await unavailableGroup.getAttribute("href"));
    await unavailableGroup.focus();
    await expect(unavailableGroup).toBeFocused();
    await capture(page, info, "02-filtered-failure-groups-mobile-keyboard", true);
    await unavailableGroup.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Validation failure", exact: true }),
    ).toBeVisible();
    await expect(main.getByText("Evidence unavailable", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: /^Open validation evidence for / })).toHaveCount(0);
    await capture(page, info, "03-missing-evidence-mobile");

    const emptyGroups = new URL(groupsPath, fixture.app);
    emptyGroups.searchParams.set("symptom", "scorer");
    emptyGroups.searchParams.set("revision", seeded.revisions[1]);
    emptyGroups.searchParams.set("disposition", "open");
    await page.goto(emptyGroups.toString(), { waitUntil: "domcontentloaded" });
    await expect(
      page
        .getByRole("region", { name: "Failure groups", exact: true })
        .getByText("No failure groups match these filters.", { exact: true }),
    ).toBeVisible();
    await capture(page, info, "04-empty-filters-mobile");
    await page.getByRole("link", { name: "Clear filters", exact: true }).click();
    await expectDropdownValue(symptom, "");
    await expectDropdownValue(revision, "");
    await expectDropdownValue(
      page.getByRole("combobox", { name: "Review state", exact: true }),
      "",
    );
    await capture(page, info, "04a-cleared-filter-inputs");

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole("button", { name: "Switch to light mode" }).click();
    const scorerGroup = page.getByRole("link", { name: /^Reconciliation quality · / });
    const scorerGroupPath = z.string().parse(await scorerGroup.getAttribute("href"));
    const scorerGroupId = z
      .uuid()
      .parse(new URL(scorerGroupPath, fixture.app).pathname.split("/").at(-1));
    await scorerGroup.click();
    const evaluation = page.getByRole("link", { name: /^Open evaluation for / });
    await expect(evaluation).toHaveAttribute(
      "href",
      new RegExp(`/runs/${scores.runs[0].runId}\\?evaluationAttempt=`),
    );
    const evaluationPath = z.string().parse(await evaluation.getAttribute("href"));
    await page.goto(evaluationPath, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/evaluationAttempt=/);
    await expect(page.getByRole("heading", { name: "Adjudication", exact: true })).toBeVisible();
    await page.goto(scorerGroupPath);

    const dismiss = page.getByRole("button", { name: "Dismiss group", exact: true });
    const confirmation = page.getByRole("alertdialog", { name: "Dismiss this failure group?" });
    await dismiss.click();
    const cancel = confirmation.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toBeFocused();
    await cancel.press("Enter");
    await expect(main.getByText("Open", { exact: true })).toBeVisible();
    await dismiss.click();
    await confirmation.getByRole("button", { name: "Dismiss group", exact: true }).click();
    await expect(main.getByText("Dismissed", { exact: true })).toBeVisible();
    await expect(evaluation).toBeVisible();
    await expect(page.getByRole("button", { name: "Dismiss group" })).toHaveCount(0);
    await capture(page, info, "05-dismissed-group-desktop");
    await page.getByRole("link", { name: "Back to failure groups", exact: true }).click();

    const originalGroup = page.getByRole("link", { name: /^reconciliation-tests · / });
    const originalGroupPath = z.string().parse(await originalGroup.getAttribute("href"));
    await originalGroup.click();
    await expect(page.getByRole("link", { name: /^Open validation evidence for / })).toHaveCount(
      25,
    );
    await expect(
      page.getByRole("link", { name: "Producing configuration", exact: true }),
    ).toHaveCount(25);
    const staleReviewer = await page.context().newPage();
    try {
      await staleReviewer.goto(originalGroupPath);
      await expect(
        staleReviewer.getByRole("heading", { name: "reconciliation-tests", exact: true }),
      ).toBeVisible();
      await page.getByRole("textbox", { name: "Reviewed label" }).fill(reviewedLabel);
      await page.getByRole("button", { name: "Save label", exact: true }).click();
      await expect(page.getByRole("heading", { name: reviewedLabel, exact: true })).toBeVisible();

      await staleReviewer
        .getByRole("textbox", { name: "Reviewed label" })
        .fill("Superseded review");
      await staleReviewer.getByRole("button", { name: "Save label", exact: true }).click();
      await expect(staleReviewer.locator("#main-content").getByRole("alert")).toContainText(
        "Reload it before saving",
      );
      await staleReviewer.getByRole("button", { name: "Reload group", exact: true }).click();
      await expect(
        staleReviewer.getByRole("heading", { name: reviewedLabel, exact: true }),
      ).toBeVisible();
    } finally {
      await staleReviewer.close();
    }
    await capture(page, info, "06-reviewed-group-desktop");

    await main.getByText("Split by run", { exact: true }).press("Enter");
    const splitRuns = page.getByRole("checkbox", {
      name: /^Validation regression .* · Attempt 1$/,
    });
    await expect(splitRuns).toHaveCount(25);
    const firstRun = z.uuid().parse(await splitRuns.first().getAttribute("value"));
    await splitRuns.first().press("Space");
    await expect(splitRuns.first()).toBeChecked();
    await page.getByRole("link", { name: "More runs", exact: true }).click();
    await expect(splitRuns).toHaveCount(1);
    await expect(main.getByText("1 run selected", { exact: true })).toBeVisible();
    await expect(main.getByRole("list", { name: "Selected runs across pages" })).toContainText(
      "Validation regression",
    );
    const secondRun = z.uuid().parse(await splitRuns.first().getAttribute("value"));
    expect(secondRun).not.toBe(firstRun);
    await splitRuns.first().press("Space");
    await expect(main.getByText("2 runs selected", { exact: true })).toBeVisible();
    await capture(page, info, "06a-cross-page-run-selection", true);
    await page.getByRole("link", { name: "First runs page", exact: true }).click();
    await expect(splitRuns).toHaveCount(25);
    await expect(splitRuns.first()).toBeChecked();
    await expect(main.getByText("2 runs selected", { exact: true })).toBeVisible();
    const [splitResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith("/review"),
      ),
      page.getByRole("button", { name: "Split group", exact: true }).click(),
    ]);
    expect(splitResponse.ok()).toBe(true);
    expect(await splitResponse.json()).toMatchObject({
      review: { revision: 2, disposition: "split" },
    });
    await page.goto(originalGroupPath, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("link", { name: "Remaining runs group", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /^Open validation evidence for / })).toHaveCount(
      25,
    );
    await capture(page, info, "07-original-group-after-split");

    const selectedGroupPath = z
      .string()
      .parse(
        await page
          .getByRole("link", { name: "Selected runs group", exact: true })
          .getAttribute("href"),
      );
    await page.goto(selectedGroupPath, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "reconciliation-tests · Selected runs", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /^Open validation evidence for / })).toHaveCount(2);
    await expect(
      page.getByRole("link", { name: "View original group’s proposals" }),
    ).toHaveAttribute(
      "href",
      new RegExp(
        `cohort=${new URL(originalGroupPath, fixture.app).pathname.split("/").at(-1)}(?:&|$)`,
      ),
    );
    for (const run of [firstRun, secondRun]) {
      await expect(main.locator(`a[href$="/runs/${run}?attempt=1"]`)).toHaveText(
        /Validation regression .* · Attempt 1/,
      );
    }
    await capture(page, info, "08-selected-split-group");
    await main
      .getByRole("listitem")
      .filter({ has: main.locator(`a[href$="/runs/${firstRun}?attempt=1"]`) })
      .getByRole("link", { name: /^Open validation evidence for / })
      .click();
    await expect(
      page.getByRole("heading", { name: "Validation evidence", exact: true }),
    ).toBeVisible();
    await expect(main.getByText("reconciliation-tests", { exact: true })).toBeVisible();
    await expect(main.getByText("Failed", { exact: true })).toBeVisible();
    const receiptHref = z
      .string()
      .parse(
        await main
          .getByRole("link", { name: "View technical receipt (JSON)" })
          .getAttribute("href"),
      );
    const receipt = await page.request.get(receiptHref);
    expect(receipt.ok()).toBe(true);
    expect(await receipt.json()).toMatchObject({
      evidence: [
        { run_id: firstRun, records: [{ key: "reconciliation-tests", status: "failed" }] },
      ],
    });
    await capture(page, info, "08a-exact-validation-evidence");

    const reader = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      const readerMain = reader.locator("#main-content");
      await signInViaMagicLink(reader, originalGroupPath, {
        baseURL: fixture.app,
        email: fixture.viewerEmail,
      });
      await expect(reader.getByRole("heading", { name: reviewedLabel, exact: true })).toBeVisible();
      await expect(
        reader.getByRole("link", { name: "Selected runs group", exact: true }),
      ).toBeVisible();
      await reader.goto(missingGroupPath);
      await expect(readerMain.getByText("Evidence unavailable", { exact: false })).toBeVisible();
      await expect(reader.getByRole("button", { name: "Save label", exact: true })).toHaveCount(0);
      await reader.goto(scorerGroupPath);
      await expect(readerMain.getByText("Dismissed", { exact: true })).toBeVisible();
      await expect(reader.getByRole("link", { name: /^Open evaluation for / })).toBeVisible();
      await expect(reader.getByRole("button", { name: "Save label", exact: true })).toHaveCount(0);
      const denied = await reader.request.post(
        `/api/workspaces/${fixture.workspaceId}/factories/${fixture.factoryId}/failure-groups/${scorerGroupId}/review`,
        {
          data: {
            action: "label",
            label: "Viewer edit",
            expectedRevision: 1,
            requestId: "390568f5-438b-480f-bda5-a8e2690b3850",
          },
        },
      );
      expect(denied.status()).toBe(403);
    } finally {
      await reader.close();
    }

    await page.goto(missingGroupPath, { waitUntil: "domcontentloaded" });
    const profile = page.getByRole("link", { name: "Producing configuration", exact: true });
    await expect(profile).toHaveAttribute(
      "href",
      new RegExp(`/runs/${seeded.runs.at(-1)}\\?attempt=2#execution-profile$`),
    );
    const profilePath = new URL(z.string().parse(await profile.getAttribute("href")), fixture.app);
    await page.goto(profilePath.toString(), { waitUntil: "domcontentloaded" });
    const profileSection = page.locator("#execution-profile");
    await expect(profileSection.getByText("Attempt 2", { exact: true })).toBeVisible();
    await expect(
      profileSection.getByRole("heading", { name: "Recorded execution profile", exact: true }),
    ).toBeVisible();
    profilePath.searchParams.set("attempt", "1");
    await page.goto(profilePath.toString(), { waitUntil: "domcontentloaded" });
    await expect(profileSection.getByText("Attempt 1", { exact: true })).toBeVisible();
    await expect(
      profileSection.getByText("This attempt has no recorded execution profile.", { exact: true }),
    ).toBeVisible();
    await profileSection.scrollIntoViewIfNeeded();
    await capture(page, info, "09-historical-attempt-profile-unavailable", true);
  } catch (error) {
    workflowError = error;
    throw error;
  } finally {
    try {
      expect(
        await fixture.runFixtureFile(
          "factory-failure-groups-seed.sql",
          {
            workspace_id: fixture.workspaceId,
            workspace_slug: fixture.slug,
            owner_id: fixture.ownerId,
            viewer_id: fixture.viewerId,
            cleanup_paths: JSON.stringify(storagePaths),
          },
          45_000,
        ),
      ).toEqual({ removed: storagePaths.length });
    } catch (cleanupError) {
      if (workflowError) {
        throw new AggregateError([workflowError, cleanupError], "Browser flow and cleanup failed.");
      }
      throw cleanupError;
    }
  }
});
