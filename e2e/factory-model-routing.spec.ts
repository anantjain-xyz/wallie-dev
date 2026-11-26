import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod/v4";

import { benchmarkFrontierSchema } from "@/lib/factory-benchmarks/frontier-contracts";
import { routingDraftResponseSchema } from "@/lib/model-routing/draft-contracts";
import { workspaceFactoryDefinitionPath, workspaceRunDetailPath } from "@/lib/routes";

import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";

async function capture(page: Page, section: Locator, info: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await section.screenshot({
    path,
    animations: "disabled",
    caret: "hide",
    style: '[data-shell-header], a[href="#main-content"] { visibility: hidden !important; }',
  });
  await info.attach(name, { path, contentType: "image/png" });
}

test("previews a saved routing policy and displays its historical decision after a rename", async ({
  baseURL,
  browser,
  page,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_BENCHMARKS_E2E !== "1",
    "Requires disposable loopback Supabase.",
  );
  test.setTimeout(300_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const experimentId = randomUUID();
  const admin = createClient(
    z.url().parse(process.env.NEXT_PUBLIC_SUPABASE_URL),
    z.string().min(1).parse(process.env.SUPABASE_SECRET_KEY),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const viewer = await browser.newContext();
  let storagePaths: string[] = [];

  async function readActivations() {
    const { data, error } = await admin
      .from("factory_definition_activations")
      .select("activation_number,revision_id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("factory_id", fixture.factoryId)
      .order("activation_number");
    if (error) throw error;
    return data;
  }

  try {
    const landing = `/w/${fixture.slug}/benchmarks`;
    const reader = await viewer.newPage();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, landing, { baseURL: fixture.app, email: fixture.ownerEmail });
    await signInViaMagicLink(reader, landing, { baseURL: fixture.app, email: fixture.viewerEmail });

    const seeded =
      await test.step("Settle the existing exact benchmark and judge fixture", async () =>
        z
          .object({
            suiteId: z.uuid(),
            suiteRevisionId: z.uuid(),
            accuracyScorerRevisionId: z.uuid(),
            storagePaths: z.array(z.string()).length(25),
          })
          .parse(
            await fixture.runFixtureFile(
              "factory-benchmark-frontier-seed.sql",
              {
                workspace_id: fixture.workspaceId,
                factory_id: fixture.factoryId,
                owner_id: fixture.ownerId,
                pipeline_id: fixture.pipelineId,
                stage_id: fixture.stageId,
                experiment_id: experimentId,
                excluded_run_id: fixture.failedRunId,
              },
              90_000,
            ),
          ));
    storagePaths = seeded.storagePaths;
    const activationBefore = await readActivations();
    expect(activationBefore).toHaveLength(1);
    const benchmarkApi = `/api/workspaces/${fixture.workspaceId}/factories/${fixture.factoryId}/benchmarks/experiments/${experimentId}`;
    const { candidateKey, draft } =
      await test.step("Create a real draft from the qualified candidate", async () => {
        const lookup = await page.request.get(
          `${benchmarkApi}/frontier?scorerRevisionId=${seeded.accuracyScorerRevisionId}`,
        );
        expect(lookup.ok()).toBe(true);
        const frontier = benchmarkFrontierSchema.parse(await lookup.json());
        const recommended = frontier.items.filter(({ isRecommended }) => isRecommended).at(-1);
        if (!recommended) throw new Error("The frontier fixture has no qualified recommendation.");
        const draftResponse = await page.request.post(`${benchmarkApi}/routing-drafts`, {
          data: {
            requestId: randomUUID(),
            candidateKey: recommended.candidateKey,
            scorerRevisionId: seeded.accuracyScorerRevisionId,
            suiteRevisionId: seeded.suiteRevisionId,
            taskClass: { slug: "delivery", name: "Invoice delivery" },
            constraints: {
              qualityFloorBps: 8_000,
              maxMeanCostUsd: 0.1,
              maxLatencyMs: 120_000,
              minResolvedTrials: 2,
              minConfidenceBps: null,
            },
          },
        });
        const body: unknown = await draftResponse.json();
        expect(draftResponse.status(), JSON.stringify(body)).toBe(201);
        return {
          candidateKey: recommended.candidateKey,
          draft: routingDraftResponseSchema.parse(body),
        };
      });

    await test.step("Preview the saved draft by keyboard and verify stale and member requests", async () => {
      await page.goto(workspaceFactoryDefinitionPath(fixture.slug, { factory: fixture.factoryId }));
      const editor = page.getByRole("region", { name: "Model routing" });
      const disclosure = editor.getByRole("button", { name: "Edit Invoice delivery rule" });
      await expect(disclosure).toBeVisible({ timeout: 75_000 });
      await disclosure.focus();
      await expect(disclosure).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(editor.getByRole("spinbutton", { name: "Quality floor (%)" })).toHaveValue("80");
      await capture(page, editor, info, "model-routing-editor-light");
      await editor.getByRole("button", { name: "Hide Invoice delivery rule" }).click();

      const previewEndpoint = `/api/workspaces/${fixture.workspaceId}/factories/${fixture.factoryId}/definition/routing-preview`;
      const previewPayload = {
        expectedActivationNumber: 1,
        draftId: draft.draftId,
        taskClassSlug: "delivery",
      };
      const preview = page.getByRole("region", { name: "Routing preview" });
      const slug = preview.getByRole("combobox", { name: "Task class slug" });
      const previewButton = preview.getByRole("button", { name: "Preview routing" });
      const unmatchedSlug = "unmatched-" + "x".repeat(54);
      await slug.fill(unmatchedSlug);
      await expect(slug).toHaveValue(unmatchedSlug);
      await slug.focus();
      await page.keyboard.press("Tab");
      await expect(previewButton).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(preview.getByText("No task class matches this slug.")).toBeVisible({
        timeout: 75_000,
      });
      await capture(page, preview, info, "model-routing-preview-unmatched-light");

      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await slug.fill("deliv");
      await slug.evaluate((input) => input.scrollIntoView({ block: "center" }));
      const suggestions = page.getByRole("listbox", { name: "Task class suggestions" });
      await expect(
        suggestions.getByRole("option", { name: previewPayload.taskClassSlug, exact: true }),
      ).toBeVisible();
      await slug.press("ArrowDown");
      const screenshot = info.outputPath("model-routing-preview-suggestions-mobile-dark.png");
      await page.screenshot({ path: screenshot, animations: "disabled", caret: "hide" });
      await info.attach("model-routing-preview-suggestions-mobile-dark", {
        path: screenshot,
        contentType: "image/png",
      });
      await slug.press("Enter");
      await expect(slug).toHaveValue(previewPayload.taskClassSlug);
      await expect(slug).toBeFocused();
      await expect(suggestions).toBeHidden();
      const request = page.waitForRequest(
        (request) => request.url().endsWith(previewEndpoint) && request.method() === "POST",
      );
      await previewButton.click();
      expect((await request).postDataJSON()).toEqual(previewPayload);
      await expect(
        preview.getByRole("heading", { name: "Primary configuration selected" }),
      ).toBeVisible({ timeout: 75_000 });
      await capture(page, preview, info, "model-routing-preview-qualified-mobile-dark");

      const stale = await page.request.post(previewEndpoint, {
        data: { ...previewPayload, expectedActivationNumber: 0 },
      });
      expect(stale.status()).toBe(409);
      const denied = await reader.request.post(previewEndpoint, { data: previewPayload });
      expect(denied.status()).toBe(403);
      expect(await readActivations()).toEqual(activationBefore);
    });

    await test.step("Display the original decision after the active class was renamed", async () => {
      const historical = z
        .object({
          runId: z.uuid(),
          policyRevisionId: z.uuid(),
          renamedRevisionId: z.uuid(),
          taskClassName: z.string(),
        })
        .parse(
          await fixture.runFixtureFile("model-routing-inspector-seed.sql", {
            workspace_id: fixture.workspaceId,
            workspace_slug: fixture.slug,
            factory_id: fixture.factoryId,
            owner_id: fixture.ownerId,
            stage_id: fixture.stageId,
            draft_id: draft.draftId,
          }),
        );
      expect(historical.renamedRevisionId).not.toBe(historical.policyRevisionId);
      expect((await readActivations()).at(-1)?.revision_id).toBe(historical.renamedRevisionId);
      const runPath = workspaceRunDetailPath(fixture.slug, historical.runId);
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.getByRole("button", { name: "Switch to light mode", exact: true }).click();
      await page.goto(runPath);
      const inspected = page.locator("#routing-decision");
      await expect(inspected.getByText(historical.taskClassName, { exact: true })).toBeVisible({
        timeout: 75_000,
      });
      await expect(inspected.getByText("Primary configuration", { exact: true })).toBeVisible();
      await expect(inspected.getByText("Shadow only — not applied", { exact: true })).toBeVisible();
      await expect(
        inspected.getByRole("link", { name: "Open recorded policy revision" }),
      ).toHaveAttribute("href", new RegExp(`[?&]revision=${historical.policyRevisionId}(?:&|$)`));
      await expect(
        inspected.getByRole("link", { name: "Open exact comparison configuration" }),
      ).toHaveAttribute("href", new RegExp(`#frontier-configuration-${candidateKey}$`));
      await expect(
        inspected.getByRole("link", { name: "Open frozen suite revision" }),
      ).toHaveAttribute("href", new RegExp(`[?&]revision=${seeded.suiteRevisionId}(?:&|$)`));
      await capture(page, inspected, info, "model-routing-run-inspector");

      await reader.goto(runPath);
      const readerDecision = reader.locator("#routing-decision");
      await expect(readerDecision.getByText(historical.taskClassName, { exact: true })).toBeVisible(
        { timeout: 75_000 },
      );
      await expect(
        readerDecision.getByText(
          "Benchmark proposal details require permission to manage this factory.",
        ),
      ).toBeVisible();
      await expect(
        readerDecision.getByRole("link", { name: "Open exact comparison configuration" }),
      ).toHaveCount(0);
    });
  } finally {
    await viewer.close();
    await test.step("Clean up the disposable workspace", async () => {
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
