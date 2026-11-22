import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import type { Database } from "@/lib/supabase/database.types";
import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";
import { selectDropdownOption } from "./helpers/select";

async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled", caret: "hide" });
  await info.attach(name, { path, contentType: "image/png" });
}

test("a factory manager curates distinct suites and preserves the earlier task criteria", async ({
  baseURL,
  page,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_BENCHMARKS_E2E !== "1",
    "Requires disposable local Supabase.",
  );
  test.setTimeout(90_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const admin = createClient<Database>(
    z.url().parse(process.env.NEXT_PUBLIC_SUPABASE_URL),
    z.string().min(1).parse(process.env.SUPABASE_SECRET_KEY),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const listPath = `/w/${fixture.slug}/benchmarks?factory=${fixture.factoryId}`;
  const originalCriteria = "Check the saved invoice after a duplicate import.";
  const revisedCriteria = "Check the saved invoice and the retry audit record.";
  const imageReason = "The original session image inputs do not have a retained integrity receipt.";

  try {
    const [review, triage] = await Promise.all([
      admin.rpc("create_factory_benchmark_task", {
        p_workspace_id: fixture.workspaceId,
        p_factory_id: fixture.factoryId,
        p_actor_user_id: fixture.ownerId,
        p_source_run_id: fixture.producingRunId,
        p_name: "Invoice UI task",
        p_acceptance_criteria: originalCriteria,
        p_tags: ["ui", "invoice"],
        p_replay_eligibility: "eligible",
      }),
      admin.rpc("create_factory_benchmark_task", {
        p_workspace_id: fixture.workspaceId,
        p_factory_id: fixture.factoryId,
        p_actor_user_id: fixture.ownerId,
        p_source_run_id: fixture.failedRunId,
        p_name: "Invoice triage task",
        p_acceptance_criteria: "Identify why the invoice was rejected.",
        p_tags: ["triage"],
        p_replay_eligibility: "ineligible",
        p_eligibility_reason: imageReason,
      }),
    ]);
    if (review.error) throw review.error;
    if (triage.error) throw triage.error;

    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, listPath, { baseURL: fixture.app, email: fixture.ownerEmail });
    await expect(page.getByRole("heading", { name: "Benchmarks", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Benchmarks", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      page.getByText("No benchmark suites in this factory yet.", { exact: true }),
    ).toBeVisible();
    await screenshot(page, info, "01-benchmarks-empty-desktop-light");

    const regression = "Invoice UI regression";
    const holdout = "Invoice triage holdout";
    await page.getByRole("link", { name: "New suite", exact: true }).click();
    await page.getByRole("textbox", { name: "Suite name", exact: true }).fill(regression);
    await page.getByText("Review Invoice UI task", { exact: true }).click();
    await expect(page.getByText(originalCriteria, { exact: true })).toBeVisible();
    const include = page.getByRole("checkbox", { name: "Include Invoice UI task", exact: true });
    await include.focus();
    await page.keyboard.press("Space");
    await expect(include).toBeChecked();
    await screenshot(page, info, "02-benchmark-explicit-curation-desktop-light");
    await page.getByRole("button", { name: "Save suite", exact: true }).click();
    await expect(page.getByRole("heading", { name: regression, exact: true })).toBeVisible();
    const suitePath = page.url();
    const previousSuiteRevisionId = z.uuid().parse(new URL(suitePath).searchParams.get("revision"));

    await page.goto(listPath);
    await page.getByRole("link", { name: "New suite", exact: true }).click();
    await page.getByRole("textbox", { name: "Suite name", exact: true }).fill(holdout);
    await selectDropdownOption(page.getByRole("combobox", { name: "Suite purpose", exact: true }), {
      label: "Holdout",
    });
    await page.getByRole("radio", { name: "Match tags", exact: true }).check();
    await page.getByRole("textbox", { name: "Selection tags", exact: true }).fill("triage");
    await page.getByRole("button", { name: "Save suite", exact: true }).click();
    await expect(page.getByRole("heading", { name: holdout, exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const triageDetails = page.getByText("Task details", { exact: true });
    await triageDetails.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(imageReason, { exact: true })).toBeVisible();
    await screenshot(page, info, "03-benchmark-ineligible-holdout-mobile-dark");

    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.goto(listPath);
    await page.getByRole("link", { name: regression, exact: true }).click();
    await page.getByText("Task details", { exact: true }).click();
    await expect(page.getByText(originalCriteria, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit task", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Acceptance criteria", exact: true })
      .fill(revisedCriteria);
    await page.getByRole("button", { name: "Save task revision", exact: true }).click();

    await expect(page.getByText("Task revision 2 saved.", { exact: true })).toBeVisible();
    const updatedTask = await admin
      .from("factory_benchmark_task_revisions")
      .select("id,acceptance_criteria")
      .eq("task_id", review.data.task_id)
      .eq("revision_number", 2)
      .single();
    if (updatedTask.error) throw updatedTask.error;
    expect(updatedTask.data.acceptance_criteria).toBe(revisedCriteria);

    await page.getByRole("link", { name: "Edit suite", exact: true }).click();
    await page
      .getByRole("button", { name: "Use revision 2 for Invoice UI task", exact: true })
      .click();
    await page.getByRole("button", { name: "Save suite", exact: true }).click();
    await expect(page).toHaveURL(/revision=[\da-f-]{36}/);
    expect(new URL(page.url()).searchParams.get("revision")).not.toBe(previousSuiteRevisionId);
    const updatedDetails = page.getByText("Task details", { exact: true });
    if (await updatedDetails.evaluate((summary) => !summary.closest("details")?.open)) {
      await updatedDetails.click();
    }
    await expect(page.getByText(revisedCriteria, { exact: true })).toBeVisible();

    await page.goto(suitePath);
    await page.getByText("Task details", { exact: true }).click();
    await expect(page.getByText(originalCriteria, { exact: true })).toBeVisible();
    await expect(page.getByText(revisedCriteria, { exact: true })).toHaveCount(0);

    const pinned = await admin
      .from("factory_benchmark_suite_members")
      .select("task_revision_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("suite_revision_id", previousSuiteRevisionId)
      .eq("task_id", review.data.task_id)
      .single();
    if (pinned.error) throw pinned.error;
    expect(pinned.data.task_revision_id).toBe(review.data.id);
  } finally {
    await fixture.cleanup();
  }
});
