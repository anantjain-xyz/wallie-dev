import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod/v4";

import { ERASE_RETAINED_CONTENT_CONFIRMATION } from "../src/lib/run-retention/session-contracts";
import {
  proposalReviewCommandSchema,
  proposalReviewSaveSchema,
} from "../src/lib/factory-proposals/workbench-contracts";
import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";
import { selectDropdownOption } from "./helpers/select";

const sourceSchema = z.object({
  cohortId: z.uuid(),
  diagnosisId: z.uuid(),
  evaluationAttemptId: z.uuid(),
  runId: z.uuid(),
  sessionId: z.uuid(),
  stageId: z.uuid(),
  expectedPromptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  base: z.object({
    activationNumber: z.number().int().positive(),
    revisionId: z.uuid(),
    digest: z.string(),
  }),
});
const proposalResponse = z.object({
  proposal: z.object({
    proposalId: z.uuid(),
    revisionId: z.uuid(),
    revisionNumber: z.number(),
    status: z.enum(["compiled", "invalid"]),
  }),
});

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const directory = process.env.WALLIE_IMPROVEMENTS_PROOF_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled", caret: "hide" });
  await info.attach(name, { path, contentType: "image/png" });
}

test.use({ actionTimeout: 15_000 });

test("reviews exact proposal revisions and preserves discussion after dismissal", async ({
  baseURL,
  browser,
  page,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_IMPROVEMENTS_E2E !== "1",
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
  const workspacePath = `/w/${fixture.slug}`;
  const proposalsEndpoint = `/api/workspaces/${fixture.workspaceId}/factories/${fixture.factoryId}/improvement-proposals`;
  const headers = { origin: fixture.app };
  const rationale = "Make reconciliation checks explicit";
  const invalidRationale = "Reference an unavailable artifact";
  const reviewNote = "Please cite the exact receipt. Keep <b>this detail</b> in the revision.";
  const main = page.locator("#main-content:visible");
  let workflowError: unknown;

  try {
    await fixture.runFixtureFile(
      "factory-score-trends-seed.sql",
      { ...scopeFields, extra_policy_count: "0" },
      60_000,
    );
    const source = sourceSchema.parse(
      await fixture.runFixtureFile("factory-improvement-workbench-seed.sql", scopeFields, 60_000),
    );
    const command = {
      diagnosisId: source.diagnosisId,
      base: source.base,
      rationale,
      expectedBenefit: "Make the expected check easier to verify.",
      regressionRisks: "The additional check may add time to review.",
      edits: [
        {
          kind: "stage_prompt",
          stageId: source.stageId,
          expectedPromptSha256: source.expectedPromptSha256,
          promptTemplateMd: "Prepare the verified change and cite the reconciliation check.",
        },
      ],
    };

    const cohortPath = `${workspacePath}/failure-groups/${source.cohortId}?factory=${fixture.factoryId}`;
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, cohortPath, { baseURL: fixture.app, email: fixture.ownerEmail });
    await expect(page.getByRole("heading", { name: "Reconciliation quality" })).toBeVisible();

    await page.goto(`${workspacePath}/improvements?factory=${fixture.factoryId}`);
    await expect(
      main.getByText(/Improvement proposals come from completed failure diagnoses/),
    ).toBeVisible();
    await expect(
      main.getByRole("link", { name: "View failure groups", exact: true }),
    ).toHaveAttribute("href", `${workspacePath}/failure-groups?factory=${fixture.factoryId}`);
    await page.goto(cohortPath);

    const compiled = await page.request.post(proposalsEndpoint, {
      headers,
      data: { ...command, requestId: randomUUID() },
    });
    const compiledBody = await compiled.json();
    expect(compiled.status(), JSON.stringify(compiledBody)).toBe(201);
    const first = proposalResponse.parse(compiledBody).proposal;
    expect(first.status).toBe("compiled");

    const invalid = await page.request.post(proposalsEndpoint, {
      headers,
      data: {
        ...command,
        requestId: randomUUID(),
        rationale: invalidRationale,
        edits: [{ ...command.edits[0], promptTemplateMd: "{{artifact.previousStages.unknown}}" }],
      },
    });
    const invalidBody = await invalid.json();
    expect(invalid.status(), JSON.stringify(invalidBody)).toBe(201);
    expect(proposalResponse.parse(invalidBody).proposal.status).toBe("invalid");

    await page.getByRole("link", { name: "View proposals for this group", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`cohort=${source.cohortId}`));
    await expect(page.getByRole("heading", { name: "Improvements", exact: true })).toBeVisible();
    await expect(
      main.getByRole("link", { name: "Failure group: Reconciliation quality", exact: true }),
    ).toBeVisible();
    await test.step("updates the review state on selection and preserves the failure group", async () => {
      const filter = main.getByRole("combobox", { name: "Review state", exact: true });
      const listbox = page.getByRole("listbox", { name: "Review state", exact: true });
      const filterUrl = new URL(page.url());

      await expect(filter).toHaveText("All");
      await filter.press("ArrowDown");
      await expect(listbox.getByRole("option")).toHaveText([
        "All",
        "Open",
        "Investigate",
        "Revision requested",
        "Dismissed",
      ]);
      await expect(listbox.getByRole("option", { selected: true })).toHaveText("All");
      await page.keyboard.press("ArrowDown");
      await expect(listbox.getByRole("option", { name: "Open", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(listbox).toHaveCount(0);
      await expect(filter).toBeFocused();
      await expect(filter).toHaveText("All");

      await selectDropdownOption(filter, "dismissed");
      await expect(filter).toHaveText("Dismissed");
      filterUrl.searchParams.set("reviewState", "dismissed");
      await expect(page).toHaveURL(filterUrl.href);
      await expect(
        main.getByRole("heading", { name: "No proposals match this review state" }),
      ).toBeVisible();

      await filter.press("ArrowDown");
      await expect(listbox.getByRole("option", { selected: true })).toHaveText("Dismissed");
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(filter).toBeFocused();
      await expect(filter).toHaveText("Open");
      filterUrl.searchParams.set("reviewState", "open");
      await expect(page).toHaveURL(filterUrl.href);

      await main.getByRole("link", { name: "Clear filters", exact: true }).click();
      await expect(filter).toHaveText("All");
      expect(new URL(page.url()).searchParams.get("cohort")).toBe(source.cohortId);
      await selectDropdownOption(filter, "open");
      await expect(page).toHaveURL(filterUrl.href);
    });
    const proposal = main.getByRole("link", { name: rationale, exact: true });
    await expect(proposal).toBeVisible();
    const firstPath = z.string().parse(await proposal.getAttribute("href"));
    await expect(main.getByText("Invalid candidate", { exact: true })).toBeVisible();
    await capture(page, info, "01-improvements-list-light");

    await main.getByRole("link", { name: invalidRationale, exact: true }).click();
    await expect(main.getByRole("list", { name: "Validation errors" })).toContainText("unknown");
    await expect(
      page.getByRole("link", { name: "Back to improvements", exact: true }),
    ).toHaveAttribute("href", new RegExp(`cohort=${source.cohortId}`));
    await expect(
      page.getByRole("link", { name: "Back to improvements", exact: true }),
    ).toHaveAttribute("href", /reviewState=open/);
    await page.goto(firstPath, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Evidence and attribution" })).toBeVisible();
    await expect(main.getByText("Inconclusive evidence", { exact: true })).toBeVisible();
    await expect(
      main.locator("#benchmark-qualification").getByText("Not run", { exact: true }),
    ).toBeVisible();
    const runLink = main
      .getByRole("list", { name: "Cited run evidence" })
      .getByRole("link", { name: /Session #\d+.*Attempt 1/ });
    await expect(runLink).toHaveAttribute(
      "href",
      `${workspacePath}/runs/${source.runId}?attempt=1`,
    );
    const evaluation = main.getByRole("link", { name: "Open evaluation", exact: true });
    const evaluationPath = z.string().parse(await evaluation.getAttribute("href"));
    expect(evaluationPath).toContain(
      `/runs/${source.runId}?evaluationAttempt=${source.evaluationAttemptId}`,
    );
    await page.goto(evaluationPath, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Adjudication", exact: true })).toBeVisible();
    await page.goto(firstPath, { waitUntil: "domcontentloaded" });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: /^Workspace navigation:/ }).press("Enter");
    const drawer = page.getByRole("dialog", { name: "Workspace pages" });
    await expect(drawer.getByRole("link", { name: "Improvements", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await capture(page, info, "02-improvement-evidence-dark-mobile");

    const diff = main.locator("#candidate-diff:visible");
    await diff.getByText("Delivery", { exact: true }).click();
    await expect(diff.getByText("Active configuration", { exact: true })).toBeVisible();
    await expect(diff.getByText(command.edits[0].promptTemplateMd, { exact: true })).toBeVisible();
    await capture(page, info, "03-improvement-diff-dark-mobile");

    const reviewPath = `${proposalsEndpoint}/${first.proposalId}/review`;
    await page.getByRole("textbox", { name: "Review note" }).fill(reviewNote);
    const [reviewResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === reviewPath && response.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Request revision", exact: true }).press("Enter"),
    ]);
    expect(reviewResponse.status()).toBe(201);
    const saved = await reviewResponse.json();
    const discussion = main.locator("#discussion:visible");
    const note = discussion.getByText(reviewNote, { exact: true });
    await expect(note).toBeVisible();
    await expect(note.locator("b")).toHaveCount(0);
    await expect(main.getByText("Revision requested", { exact: true })).toBeVisible();
    await capture(page, info, "04-revision-request-dark-mobile");

    const replay = await page.request.post(reviewPath, {
      headers,
      data: reviewResponse.request().postDataJSON(),
    });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toMatchObject({ event: saved.event, replay: true });
    await expect(note).toHaveCount(1);

    const unconfirmedNote = "Confirm the exact review after the response is lost.";
    const reviewRequest = (url: string, method: string) =>
      new URL(url).pathname === reviewPath && method === "POST";
    await page.evaluate((path) => {
      const originalFetch = window.fetch;
      window.fetch = async (input, init) => {
        if (input === path && init?.method === "POST") {
          window.fetch = originalFetch;
          await originalFetch.call(window, input, init);
          return Response.json({ error: "Review response unavailable." }, { status: 503 });
        }
        return originalFetch.call(window, input, init);
      };
    }, reviewPath);
    await page.getByRole("textbox", { name: "Review note" }).fill(unconfirmedNote);
    const [committedReview] = await Promise.all([
      page.waitForResponse((response) =>
        reviewRequest(response.url(), response.request().method()),
      ),
      page.getByRole("button", { name: "Add comment", exact: true }).click(),
    ]);
    expect(committedReview.status()).toBe(201);
    const committedCommand = proposalReviewCommandSchema.parse(
      committedReview.request().postDataJSON(),
    );
    await expect(discussion.getByRole("alert")).toContainText("Could not confirm the review", {
      timeout: 55_000,
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    const unconfirmed = discussion.getByText(unconfirmedNote, { exact: true });
    const retryReview = discussion.getByRole("button", { name: "Retry review", exact: true });
    await expect(unconfirmed).toHaveCount(1);
    await expect(retryReview).toBeVisible();
    await expect(discussion.getByRole("button", { name: "Add comment", exact: true })).toHaveCount(
      0,
    );
    await capture(page, info, "06-review-retry-after-reload-dark-mobile");
    const [retriedReview] = await Promise.all([
      page.waitForResponse((response) =>
        reviewRequest(response.url(), response.request().method()),
      ),
      retryReview.press("Enter"),
    ]);
    expect(retriedReview.status()).toBe(200);
    expect(retriedReview.request().postDataJSON()).toEqual(committedCommand);
    expect(proposalReviewSaveSchema.parse(await retriedReview.json())).toMatchObject({
      replay: true,
      event: {
        action: "comment",
        note: unconfirmedNote,
        version: committedCommand.expectedReviewVersion + 1,
      },
    });
    await expect(retryReview).toHaveCount(0);
    await expect(unconfirmed).toHaveCount(1);

    const stale = await page.context().newPage();
    let second: z.infer<typeof proposalResponse>["proposal"];
    try {
      await stale.goto(firstPath, { waitUntil: "domcontentloaded" });
      await expect(
        stale.getByRole("button", { name: "Mark for investigation", exact: true }),
      ).toBeVisible();
      const nextResponse = await page.request.post(proposalsEndpoint, {
        headers,
        data: {
          ...command,
          requestId: randomUUID(),
          proposalId: first.proposalId,
          expectedRevisionId: first.revisionId,
          edits: [
            {
              ...command.edits[0],
              promptTemplateMd: "Cite the reconciliation receipt and its commit.",
            },
          ],
        },
      });
      const nextBody = await nextResponse.json();
      expect(nextResponse.status(), JSON.stringify(nextBody)).toBe(201);
      second = proposalResponse.parse(nextBody).proposal;
      expect(second.revisionNumber).toBe(2);
      await stale
        .getByRole("textbox", { name: "Review note" })
        .fill("This note was written for revision one.");
      await stale.getByRole("button", { name: "Mark for investigation", exact: true }).click();
      await expect(stale.locator("#discussion").getByRole("alert")).toContainText(
        /changed|latest|reload/i,
      );
      await stale.getByRole("button", { name: "Reload review", exact: true }).click();
      await expect(
        stale.getByText("Discussion for an earlier revision.", { exact: true }),
      ).toBeVisible();
      await expect(
        stale.getByRole("button", { name: "Mark for investigation", exact: true }),
      ).toHaveCount(0);
      await expect(
        stale.getByRole("textbox", { name: "Unsubmitted note · Revision 1" }),
      ).toHaveValue("This note was written for revision one.");
      await stale
        .locator("#discussion")
        .getByRole("link", { name: "Open latest revision", exact: true })
        .click();
      await expect(stale.getByRole("textbox", { name: "Review note", exact: true })).toHaveValue(
        "",
      );
      await expect(
        stale.getByRole("textbox", { name: "Unsubmitted note · Revision 1" }),
      ).toHaveValue("This note was written for revision one.");
    } finally {
      await stale.close();
    }

    await page.goto(firstPath, { waitUntil: "domcontentloaded" });
    await main.getByRole("link", { name: "Revision 2", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`revision=${second.revisionId}`));
    await expect(
      discussion.getByText("This revision has no discussion yet.", { exact: true }),
    ).toBeVisible();
    await expect(note).toHaveCount(0);
    await page
      .getByRole("textbox", { name: "Review note" })
      .fill("Retain the evidence and close this proposal.");
    const dismiss = page.getByRole("button", { name: "Dismiss proposal", exact: true });
    await dismiss.press("Enter");
    const dialog = page.getByRole("alertdialog", { name: "Dismiss this revision?" });
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expect(dialog).toContainText("prevents publication of revision 2");
    await capture(page, info, "07-dismiss-confirmation-dark-mobile");
    await page.keyboard.press("Escape");
    await expect(dismiss).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Review note" })).toHaveValue(
      "Retain the evidence and close this proposal.",
    );
    await dismiss.press("Enter");
    await dialog.getByRole("button", { name: "Dismiss revision", exact: true }).press("Enter");
    await expect(
      main
        .getByRole("region", { name: "Proposal summary" })
        .getByText("Dismissed", { exact: true }),
    ).toBeVisible();

    const latestPath = new URL(page.url()).pathname + new URL(page.url()).search;
    await fixture.runFixtureFile(
      "factory-improvement-workbench-seed.sql",
      { ...scopeFields, advance_base: "1" },
      30_000,
    );
    await page.goto(latestPath, { waitUntil: "domcontentloaded" });
    await expect(main.getByText("Stale base", { exact: true })).toBeVisible();

    const archive = await page.request.post(`/api/sessions/${source.sessionId}/archive`);
    expect(archive.ok()).toBe(true);
    const { archivedAt } = z.object({ archivedAt: z.string().min(1) }).parse(await archive.json());
    const erasure = await page.request.delete(
      `/api/sessions/${source.sessionId}/retained-content`,
      {
        headers,
        data: { expectedArchivedAt: archivedAt, confirmation: ERASE_RETAINED_CONTENT_CONFIRMATION },
      },
    );
    expect(erasure.ok()).toBe(true);

    const reader = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      colorScheme: "light",
    });
    try {
      await signInViaMagicLink(reader, latestPath, {
        baseURL: fixture.app,
        email: fixture.viewerEmail,
      });
      const readerMain = reader.locator("#main-content");
      await expect(
        readerMain
          .getByRole("region", { name: "Proposal summary" })
          .getByText("Dismissed", { exact: true }),
      ).toBeVisible();
      await expect(readerMain.getByText("Evidence unavailable", { exact: true })).toBeVisible();
      await expect(readerMain.locator("#benchmark-qualification")).toHaveCount(0);
      await expect(
        readerMain.getByRole("link", { name: "Open evaluation", exact: true }),
      ).toHaveCount(0);
      await expect(
        readerMain.getByText("Retain the evidence and close this proposal.", { exact: true }),
      ).toBeVisible();
      await expect(
        readerMain.getByRole("button", { name: "Add comment", exact: true }),
      ).toHaveCount(0);
      await capture(reader, info, "05-dismissed-improvement-light");
      await readerMain.getByRole("link", { name: "Revision 1", exact: true }).click();
      await expect(readerMain.getByText(reviewNote, { exact: true })).toBeVisible();
      await expect(
        reader
          .locator("#discussion")
          .getByText("This note was written for revision one.", { exact: true }),
      ).toHaveCount(0);
    } finally {
      await reader.close();
    }
  } catch (error) {
    workflowError = error;
    throw error;
  } finally {
    try {
      await fixture.cleanup();
    } catch (cleanupError) {
      if (workflowError) {
        throw new AggregateError([workflowError, cleanupError], "Browser flow and cleanup failed.");
      }
      throw cleanupError;
    }
  }
});
