import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import type { Database } from "@/lib/supabase/database.types";
import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";
import { selectDropdownOption } from "./helpers/select";

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled", caret: "hide" });
  await info.attach(name, { path, contentType: "image/png" });
}

test("a factory operator captures a historical run with explicit missing replay inputs", async ({
  baseURL,
  browser,
  page,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_BENCHMARKS_E2E !== "1",
    "Requires disposable local Supabase.",
  );
  test.setTimeout(90_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const runPath = `/w/${fixture.slug}/runs/${fixture.producingRunId}`;
  const suiteName = "Invoice regression suite";
  const criteria = "Reconcile each invoice exactly once after a duplicate import.";

  try {
    await page.setViewportSize({ width: 1440, height: 1120 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, runPath, { baseURL: fixture.app, email: fixture.ownerEmail });
    await expect(page).toHaveURL(new RegExp(`/runs/${fixture.producingRunId}$`));

    const openCapture = page.getByRole("button", { name: "Add to benchmark", exact: true });
    const dialog = page.getByRole("dialog", { name: "Add to benchmark", exact: true });
    const acceptance = dialog.getByRole("textbox", { name: "Acceptance criteria", exact: true });
    const submit = dialog.getByRole("button", { name: "Save to benchmark", exact: true });
    const suite = dialog.getByRole("combobox", { name: "Suite", exact: true });
    await openCapture.focus();
    await page.keyboard.press("Enter");
    const preview = dialog.getByRole("region", { name: "Snapshot preview", exact: true });
    await expect(preview.getByRole("heading", { name: "Snapshot preview" })).toBeVisible();
    await expect(
      preview.getByText(/^Historical run · #\d+ Ship invoice reconciliation · /),
    ).toBeVisible();
    await expect(preview.getByText(fixture.producingRunId, { exact: true })).toBeVisible();
    await expect(preview.getByText("Ineligible for replay", { exact: true })).toBeVisible();
    await expect(
      preview.getByText("The original attempt inputs were not retained.", { exact: true }),
    ).toBeVisible();
    await expect(
      preview
        .getByRole("term")
        .filter({ hasText: "Retained ref" })
        .locator("..")
        .getByText("Not recorded", { exact: true }),
    ).toBeVisible();
    await preview.getByText("Original prompt", { exact: true }).click();
    await expect(preview.getByText("Original prompt unavailable.", { exact: true })).toBeVisible();

    await selectDropdownOption(suite, { label: "New suite" });
    await dialog.getByRole("textbox", { name: "Suite name", exact: true }).fill(suiteName);
    await selectDropdownOption(
      dialog.getByRole("combobox", { name: "Suite purpose", exact: true }),
      { label: "Regression" },
    );
    await submit.click();
    await expect(acceptance).toBeFocused();
    expect(
      await acceptance.evaluate(
        (element) => element instanceof HTMLTextAreaElement && element.validity.valueMissing,
      ),
    ).toBe(true);
    await expect(page.getByText("Run added to the benchmark suite.")).toHaveCount(0);

    await acceptance.fill(criteria);
    await capture(page, info, "01-benchmark-snapshot-preview-desktop-light");
    await submit.click();
    await expect(
      page.getByText("Run added to the benchmark suite.", { exact: true }),
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await openCapture.click();
    await selectDropdownOption(suite, { label: suiteName });
    await expect(acceptance).toHaveValue(criteria);
    await submit.click();
    await expect(
      page.getByText("This run is already in the benchmark suite.", { exact: true }),
    ).toBeVisible();
    await capture(page, info, "02-benchmark-already-captured-mobile-dark");

    const admin = createClient<Database>(
      z.string().url().parse(process.env.NEXT_PUBLIC_SUPABASE_URL),
      z.string().min(1).parse(process.env.SUPABASE_SECRET_KEY),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const [task, suiteRevision] = await Promise.all([
      admin
        .from("factory_benchmark_tasks")
        .select("id,source_session_id")
        .eq("workspace_id", fixture.workspaceId)
        .eq("factory_id", fixture.factoryId)
        .eq("source_run_id", fixture.producingRunId)
        .single(),
      admin
        .from("factory_benchmark_suite_revisions")
        .select("id,revision_number,purpose")
        .eq("workspace_id", fixture.workspaceId)
        .eq("factory_id", fixture.factoryId)
        .eq("name", suiteName)
        .single(),
    ]);
    if (task.error) throw task.error;
    if (suiteRevision.error) throw suiteRevision.error;
    expect(task.data.source_session_id).toBe(fixture.deliveredSessionId);
    expect(suiteRevision.data).toMatchObject({ revision_number: 1, purpose: "regression" });

    const [taskRevision, suiteMember] = await Promise.all([
      admin
        .from("factory_benchmark_task_revisions")
        .select("id,acceptance_criteria,replay_eligibility,eligibility_reason")
        .eq("task_id", task.data.id)
        .single(),
      admin
        .from("factory_benchmark_suite_members")
        .select("task_id,task_revision_id")
        .eq("suite_revision_id", suiteRevision.data.id)
        .single(),
    ]);
    if (taskRevision.error) throw taskRevision.error;
    if (suiteMember.error) throw suiteMember.error;
    expect(taskRevision.data).toMatchObject({
      acceptance_criteria: criteria,
      replay_eligibility: "ineligible",
    });
    expect(taskRevision.data.eligibility_reason).toMatch(
      /not retained|missing|unavailable|not captured/i,
    );
    expect(suiteMember.data).toEqual({
      task_id: task.data.id,
      task_revision_id: taskRevision.data.id,
    });

    const viewer = await browser.newPage();
    try {
      await signInViaMagicLink(viewer, runPath, {
        baseURL: fixture.app,
        email: fixture.viewerEmail,
      });
      await expect(viewer).toHaveURL(new RegExp(`/runs/${fixture.producingRunId}$`));
      await expect(
        viewer.getByRole("heading", { name: "Ship invoice reconciliation" }),
      ).toBeVisible();
      await expect(
        viewer.getByRole("button", { name: "Add to benchmark", exact: true }),
      ).toHaveCount(0);
      const denied = await viewer.request.get(
        `${fixture.app}/api/workspaces/${fixture.workspaceId}/runs/${fixture.producingRunId}/benchmark`,
      );
      expect(denied.status()).toBe(403);
      expect(await denied.json()).toEqual({ error: expect.stringMatching(/permission|manage/i) });
    } finally {
      await viewer.close();
    }
  } finally {
    await fixture.cleanup();
  }
});
