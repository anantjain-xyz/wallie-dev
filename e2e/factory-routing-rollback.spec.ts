import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIResponse,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { benchmarkFrontierSchema } from "@/lib/factory-benchmarks/frontier-contracts";
import {
  factoryEditorDocumentResponseSchema,
  factoryEditorHistoryResponseSchema,
  factoryEditorSnapshotResponseSchema,
} from "@/lib/factory-definitions/editor-contracts";
import { routingDecisionSchema } from "@/lib/model-routing/decision-contracts";
import { routingDraftResponseSchema } from "@/lib/model-routing/draft-contracts";
import {
  workspaceAnalyticsPath,
  workspaceBenchmarkComparisonPath,
  workspaceBenchmarkSuitePath,
  workspaceFactoryDefinitionPath,
  workspaceRunDetailPath,
} from "@/lib/routes";
import type { Database } from "@/lib/supabase/database.types";

import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";

const activationSchema = z.object({
  activation: z.object({ revisionId: z.uuid(), activationNumber: z.number().int().positive() }),
});

async function checkedJson(
  response: Pick<APIResponse, "json" | "status">,
  status: number,
): Promise<unknown> {
  const body: unknown = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(status);
  return body;
}

async function capture(page: Page, target: Locator, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await target.screenshot({
    path,
    animations: "disabled",
    caret: "hide",
    style: '[data-shell-header], a[href="#main-content"] { visibility: hidden !important; }',
  });
  await info.attach(name, { path, contentType: "image/png" });
}

test("qualifies an exact benchmark candidate and rolls back its canary while an attempt runs", async ({
  baseURL,
  browser,
  page,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_BENCHMARKS_E2E !== "1",
    "Requires disposable loopback Supabase.",
  );
  test.setTimeout(360_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const admin = createClient<Database>(
    z.url().parse(process.env.NEXT_PUBLIC_SUPABASE_URL),
    z.string().min(1).parse(process.env.SUPABASE_SECRET_KEY),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const scope = {
    workspace_id: fixture.workspaceId,
    workspace_slug: fixture.slug,
    factory_id: fixture.factoryId,
    owner_id: fixture.ownerId,
  };
  const experimentId = randomUUID();
  const factoryApi = `/api/workspaces/${fixture.workspaceId}/factories/${fixture.factoryId}`;
  const definitionApi = `${factoryApi}/definition`;
  const benchmarkApi = `${factoryApi}/benchmarks/experiments/${experimentId}`;
  const draftEndpoint = `${benchmarkApi}/routing-drafts`;
  const settings = workspaceFactoryDefinitionPath(fixture.slug, { factory: fixture.factoryId });
  let storagePaths: string[] = [];
  let failed = false;

  try {
    const seeded = z
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
            ...scope,
            stage_id: fixture.stageId,
            pipeline_id: fixture.pipelineId,
            experiment_id: experimentId,
            excluded_run_id: fixture.failedRunId,
          },
          90_000,
        ),
      );
    storagePaths = seeded.storagePaths;
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, settings, { baseURL: fixture.app, email: fixture.ownerEmail });

    const frontier = benchmarkFrontierSchema.parse(
      await checkedJson(
        await page.request.get(
          `${benchmarkApi}/frontier?scorerRevisionId=${seeded.accuracyScorerRevisionId}`,
        ),
        200,
      ),
    );
    const [baselineConfiguration, candidateConfiguration] = frontier.items.filter(
      ({ isRecommended }) => isRecommended,
    );
    if (!baselineConfiguration || !candidateConfiguration) {
      throw new Error("The rollback fixture requires two exact recommended configurations.");
    }

    const taskClassSource = { slug: "delivery", name: "Invoice delivery" };
    const constraints = {
      qualityFloorBps: 8_000,
      maxMeanCostUsd: 0.1,
      maxLatencyMs: 120_000,
      minResolvedTrials: 2,
      minConfidenceBps: null,
    };
    const candidateRowId = `frontier-configuration-${candidateConfiguration.candidateKey}`;
    const comparisonHref = `${workspaceBenchmarkComparisonPath(
      fixture.slug,
      seeded.suiteId,
      experimentId,
      {
        factory: fixture.factoryId,
        scorerRevisionId: seeded.accuracyScorerRevisionId,
        qualityFloorPercent: constraints.qualityFloorBps / 100,
        minResolvedTrials: constraints.minResolvedTrials,
        routingCandidateKey: candidateConfiguration.candidateKey,
      },
    )}#${candidateRowId}`;
    const suiteHref = workspaceBenchmarkSuitePath(fixture.slug, seeded.suiteId, {
      factory: fixture.factoryId,
      revision: seeded.suiteRevisionId,
    });

    async function activate(
      { draftId, canonicalDigest }: ReturnType<typeof routingDraftResponseSchema.parse>,
      candidateKey: string,
      expectedActivationNumber: number,
      canary: boolean,
    ) {
      await fixture.runFixtureFile("reviewed-routing-seed.sql", { ...scope, draft_id: draftId });

      const { document } = factoryEditorDocumentResponseSchema.parse(
        await checkedJson(
          await page.request.get(`${definitionApi}/editor?draftId=${draftId}`),
          200,
        ),
      );
      const taskClass = document.source.modelRouting?.taskClasses.find(
        ({ slug }) => slug === taskClassSource.slug,
      );
      const evidence = document.routingDraftEvidence;
      if (!taskClass || !evidence)
        throw new Error("The draft did not retain exact routing evidence.");
      expect(evidence).toMatchObject({
        experimentId,
        candidateKey,
        scorerRevisionId: seeded.accuracyScorerRevisionId,
        suite: { revisionId: seeded.suiteRevisionId },
        constraints,
      });
      expect(document.source.modelRouting?.rules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: evidence.ruleId, taskClassId: taskClass.id }),
        ]),
      );
      const { activation } = activationSchema.parse(
        await checkedJson(
          await page.request.post(definitionApi, {
            data: {
              action: "activate-routing",
              expectedActivationNumber,
              draftId,
              ...(canary ? { canary: { taskClassId: taskClass.id, candidateBps: 5_000 } } : {}),
            },
          }),
          201,
        ),
      );
      expect(activation.activationNumber).toBe(expectedActivationNumber + 1);
      return { ...activation, canonicalDigest, ruleId: evidence.ruleId };
    }

    const baselineDraft = routingDraftResponseSchema.parse(
      await checkedJson(
        await page.request.post(draftEndpoint, {
          data: {
            requestId: randomUUID(),
            candidateKey: baselineConfiguration.candidateKey,
            scorerRevisionId: seeded.accuracyScorerRevisionId,
            suiteRevisionId: seeded.suiteRevisionId,
            taskClass: taskClassSource,
            constraints,
          },
        }),
        201,
      ),
    );
    const baseline = await activate(baselineDraft, baselineConfiguration.candidateKey, 1, false);
    const candidateDraft = await test.step("Apply the qualified frozen comparison", async () => {
      await page.goto(comparisonHref);
      const section = page.locator("#cost-quality-frontier");
      const row = section.locator(`#${candidateRowId}`);
      await expect(row.getByText("Recommended", { exact: true })).toBeVisible({ timeout: 75_000 });
      await expect(row.getByText("0%–100% across 5 repeats")).toBeVisible();
      await expect(row.getByText("$0.08–$0.08 across 5 repeats")).toBeVisible();
      await capture(page, section, info, "routing-frozen-comparison-before-review");

      await row.getByRole("button", { name: "Apply to routing" }).click();
      const dialog = page.getByRole("dialog", { name: "Apply to routing" });
      await dialog.getByRole("textbox", { name: "Task class name" }).fill(taskClassSource.name);
      await dialog.getByRole("textbox", { name: "Task class slug" }).fill(taskClassSource.slug);
      await expect(dialog.getByRole("spinbutton", { name: "Quality floor (%)" })).toHaveValue("80");
      await expect(dialog.getByRole("spinbutton", { name: "Minimum resolved trials" })).toHaveValue(
        "2",
      );
      await dialog.getByRole("spinbutton", { name: "Maximum mean cost (USD)" }).fill("0.10");
      await dialog
        .getByRole("spinbutton", { name: "Maximum p95 wall latency (ms)" })
        .fill("120000");
      const [response] = await Promise.all([
        page.waitForResponse(
          (entry) =>
            new URL(entry.url()).pathname === draftEndpoint && entry.request().method() === "POST",
          { timeout: 75_000 },
        ),
        dialog.getByRole("button", { name: "Create routing draft" }).click(),
      ]);
      const saved = routingDraftResponseSchema.parse(await checkedJson(response, 201));
      await expect(dialog.getByRole("status")).toHaveText("Routing draft created.");
      return saved;
    });
    const candidate = await activate(
      candidateDraft,
      candidateConfiguration.candidateKey,
      baseline.activationNumber,
      true,
    );
    const { snapshot } = factoryEditorSnapshotResponseSchema.parse(
      await checkedJson(await page.request.get(`${definitionApi}/editor`), 200),
    );
    const canary = snapshot.routingCanary;
    if (!canary) throw new Error("The reviewed canary activation did not retain its designation.");
    expect(canary.baselineRevisionId).toBe(baseline.revisionId);
    expect(canary.candidateRevisionId).toBe(candidate.revisionId);

    const seededAlert = z
      .object({
        coverage: z.object({ baselineSessions: z.literal(5), candidateSessions: z.literal(5) }),
        evaluation: z.object({
          evaluated: z.number().int().positive(),
          created: z.number().int().positive(),
        }),
        active: z.object({ runId: z.uuid(), sessionId: z.uuid() }),
        alertId: z.uuid(),
      })
      .parse(
        await fixture.runFixtureFile(
          "factory-routing-rollback-seed.sql",
          { ...scope, canary_id: canary.id },
          90_000,
        ),
      );
    const { active, alertId } = seededAlert;

    async function readRunningAttempt() {
      const [run, manifest, admission] = await Promise.all([
        admin
          .from("agent_runs")
          .select("status, started_at, finished_at, model_name, agent_id, agent_prompt_revision_id")
          .eq("workspace_id", fixture.workspaceId)
          .eq("id", active.runId)
          .single(),
        admin
          .from("session_attempt_manifests")
          .select("*")
          .eq("workspace_id", fixture.workspaceId)
          .eq("run_id", active.runId)
          .single(),
        admin
          .from("session_factory_admission_inputs")
          .select("*")
          .eq("workspace_id", fixture.workspaceId)
          .eq("session_id", active.sessionId)
          .single(),
      ]);
      for (const result of [run, manifest, admission]) {
        expect(result.error).toBeNull();
        expect(result.data).not.toBeNull();
      }
      return { run: run.data, manifest: manifest.data, admission: admission.data };
    }
    const before = await readRunningAttempt();
    expect(before.run?.status).toBe("running");
    expect(before.admission).toMatchObject({
      activation_number: candidate.activationNumber,
      definition_revision_id: candidate.revisionId,
      routing_canary_id: canary.id,
      routing_canary_arm: "candidate",
      routing_execution: { benchmarkCandidateKey: candidateConfiguration.candidateKey },
    });
    const decision = routingDecisionSchema.parse(before.admission?.routing_decision);
    expect(decision).toMatchObject({
      mode: "active",
      disposition: "selected",
      source: "primary",
      reason: "qualified",
      taskClassId: canary.taskClassId,
      ruleId: candidate.ruleId,
      policyRevisionId: candidate.revisionId,
      policyDigest: candidate.canonicalDigest,
      benchmarkCandidateKey: candidateConfiguration.candidateKey,
      configuration: { experimentId, scorerRevisionId: seeded.accuracyScorerRevisionId },
    });

    async function inspectRouting() {
      await page.goto(workspaceRunDetailPath(fixture.slug, active.runId));
      const routing = page.locator("#routing-decision");
      await expect(routing.getByText(taskClassSource.name, { exact: true })).toBeVisible({
        timeout: 75_000,
      });
      await expect(routing.getByText(/Reviewed routing recorded at admission/)).toBeVisible();
      await expect(routing.getByText(candidate.ruleId, { exact: true })).toBeVisible();
      await expect(
        routing.getByText(seeded.accuracyScorerRevisionId, { exact: true }),
      ).toBeVisible();
      await expect(routing.getByRole("link", { name: candidate.revisionId })).toBeVisible();
      await expect(
        routing.getByRole("link", { name: "Open exact comparison configuration" }),
      ).toHaveAttribute("href", comparisonHref);
      await expect(
        routing.getByRole("link", { name: "Open frozen suite revision" }),
      ).toHaveAttribute("href", suiteHref);
      return routing;
    }

    await test.step("Inspect the live candidate's admitted rule and frozen evidence", async () => {
      await capture(page, await inspectRouting(), info, "routing-active-candidate-before-rollback");
    });
    const alertHref = `${workspaceAnalyticsPath(fixture.slug, {
      factory: fixture.factoryId,
      routingCanary: canary.id,
      routingAlert: alertId,
    })}#routing-canary`;
    const rollbackHref = `${workspaceFactoryDefinitionPath(fixture.slug, {
      factory: fixture.factoryId,
      revision: baseline.revisionId,
      activation: baseline.activationNumber,
    })}#revision-history`;
    const rollbackCommand = {
      action: "rollback",
      expectedActivationNumber: candidate.activationNumber,
      targetActivationNumber: baseline.activationNumber,
      revisionId: baseline.revisionId,
    };

    await test.step("Deny the exact rollback to an authenticated workspace viewer", async () => {
      const context = await browser.newContext();
      try {
        const viewer = await context.newPage();
        await signInViaMagicLink(viewer, `/w/${fixture.slug}/benchmarks`, {
          baseURL: fixture.app,
          email: fixture.viewerEmail,
        });
        await checkedJson(
          await viewer.request.post(new URL(definitionApi, fixture.app).href, {
            data: rollbackCommand,
          }),
          403,
        );
      } finally {
        await context.close();
      }
    });

    async function inspectRetainedAlert() {
      const evidence = page.getByRole("region", { name: "Retained routing alert evidence" });
      await expect(evidence).toBeVisible({ timeout: 75_000 });
      await expect(evidence.getByText("$0.20 · 5 supporting sessions")).toBeVisible();
      await expect(evidence.getByText("$0.40 · 5 supporting sessions")).toBeVisible();
      await expect(evidence.getByText("At least 25% higher")).toBeVisible();
      await expect(evidence.getByText(candidate.ruleId, { exact: true })).toBeVisible();
      await expect(
        evidence.getByText(seeded.accuracyScorerRevisionId, { exact: true }),
      ).toBeVisible();
      await expect(
        evidence.getByRole("link", { name: "Open exact benchmark configuration" }),
      ).toHaveAttribute("href", comparisonHref);
      await expect(
        evidence.getByRole("link", { name: "Open frozen suite revision" }),
      ).toHaveAttribute("href", suiteHref);
      await expect(evidence.getByRole("link", { name: "Review rollback" })).toHaveAttribute(
        "href",
        rollbackHref,
      );
      return evidence;
    }

    await test.step("Open retained alert evidence from the active canary", async () => {
      await page.goto(settings);
      const link = page.getByRole("link", { name: "Review canary degradation alert" });
      await expect(link).toHaveAttribute("href", alertHref, { timeout: 75_000 });
      await link.click();
      const evidence = await inspectRetainedAlert();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await capture(page, evidence, info, "routing-retained-alert-mobile-dark");
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.getByRole("button", { name: "Switch to light mode", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await evidence.getByRole("link", { name: "Review rollback" }).click();
    });

    await test.step("Confirm exact reviewed rollback with the active attempt unchanged", async () => {
      const trigger = page.getByRole("button", { name: "Roll back to this revision" });
      await expect(trigger).toBeEnabled({ timeout: 75_000 });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("alertdialog", { name: "Activate this revision?" });
      await expect(
        dialog.getByText(`#${candidate.activationNumber}`, { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText(`#${baseline.activationNumber}`, { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByText(baseline.canonicalDigest)).toBeVisible();
      await capture(page, dialog, info, "reviewed-routing-rollback-light");
      const [response] = await Promise.all([
        page.waitForResponse(
          (entry) =>
            new URL(entry.url()).pathname === definitionApi && entry.request().method() === "POST",
          { timeout: 75_000 },
        ),
        dialog.getByRole("button", { name: "Activate revision" }).click(),
      ]);
      expect(response.request().postDataJSON()).toEqual(rollbackCommand);
      const { activation } = activationSchema.parse(await checkedJson(response, 201));
      expect(activation).toMatchObject({
        activationNumber: candidate.activationNumber + 1,
        revisionId: baseline.revisionId,
      });
      expect(await readRunningAttempt()).toEqual(before);
      await expect(page.getByText("Selected revision activated for new sessions.")).toBeVisible({
        timeout: 75_000,
      });
      const history = factoryEditorHistoryResponseSchema.parse(
        await checkedJson(await page.request.get(definitionApi), 200),
      );
      expect(history.currentActivation).toMatchObject(activation);
      expect(history.activations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            activationNumber: baseline.activationNumber,
            revisionId: baseline.revisionId,
          }),
          expect.objectContaining({
            activationNumber: candidate.activationNumber,
            revisionId: candidate.revisionId,
          }),
        ]),
      );

      await capture(page, await inspectRouting(), info, "routing-active-attempt-after-rollback");

      await page.goto(alertHref);
      await inspectRetainedAlert();
      await expect(
        page.locator("#routing-canary").getByRole("link", {
          name: `Activation #${baseline.activationNumber}`,
          exact: true,
        }),
      ).toHaveAttribute("href", rollbackHref);
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
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
    } catch (error) {
      if (!failed) throw error;
      await info.attach("fixture-cleanup-error", {
        body: error instanceof Error ? error.message : String(error),
        contentType: "text/plain",
      });
    }
  }
});
