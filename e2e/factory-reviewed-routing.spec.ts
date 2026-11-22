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
} from "@/lib/factory-definitions/editor-contracts";
import { routingDraftResponseSchema } from "@/lib/model-routing/draft-contracts";
import { routingOverrideOptionsSchema } from "@/lib/model-routing/operation-contracts";
import { workspaceFactoryDefinitionPath, workspaceRunDetailPath } from "@/lib/routes";

import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";
import { expectDropdownValue, selectDropdownOption } from "./helpers/select";

const overrideReason = "Use the reviewed fallback for this invoice task.";

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
  await target.screenshot({ path, animations: "disabled", caret: "hide" });
  await info.attach(name, { path, contentType: "image/png" });
}

test("activates a reviewed routing draft, audits a one-task override and preserves the old run", async ({
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
  const admin = createClient(
    z.url().parse(process.env.NEXT_PUBLIC_SUPABASE_URL),
    z.string().min(1).parse(process.env.SUPABASE_SECRET_KEY),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const scope = {
    workspace_id: fixture.workspaceId,
    workspace_slug: fixture.slug,
    factory_id: fixture.factoryId,
    owner_id: fixture.ownerId,
    stage_id: fixture.stageId,
  };
  const experimentId = randomUUID();
  const factoryApi = `/api/workspaces/${fixture.workspaceId}/factories/${fixture.factoryId}`;
  const definitionApi = `${factoryApi}/definition`;
  const benchmarkApi = `${factoryApi}/benchmarks/experiments/${experimentId}`;
  const optionsApi = `/api/workspaces/${fixture.workspaceId}/session-repositories`;
  const viewer = await browser.newContext();
  let storagePaths: string[] = [];

  try {
    const seeded = z
      .object({
        suiteRevisionId: z.uuid(),
        accuracyScorerRevisionId: z.uuid(),
        storagePaths: z.array(z.string()).length(25),
      })
      .parse(
        await fixture.runFixtureFile(
          "factory-benchmark-frontier-seed.sql",
          {
            ...scope,
            pipeline_id: fixture.pipelineId,
            experiment_id: experimentId,
            excluded_run_id: fixture.failedRunId,
          },
          90_000,
        ),
      );
    storagePaths = seeded.storagePaths;

    const landing = `/w/${fixture.slug}/benchmarks`;
    const reader = await viewer.newPage();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, landing, { baseURL: fixture.app, email: fixture.ownerEmail });
    await signInViaMagicLink(reader, landing, { baseURL: fixture.app, email: fixture.viewerEmail });

    const frontier = benchmarkFrontierSchema.parse(
      await checkedJson(
        await page.request.get(
          `${benchmarkApi}/frontier?scorerRevisionId=${seeded.accuracyScorerRevisionId}`,
        ),
        200,
      ),
    );
    const [primary, fallback] = frontier.items.filter(({ isRecommended }) => isRecommended);
    if (!primary || !fallback)
      throw new Error("The fixture requires two qualified frontier choices.");

    async function proposeRouting(taskClassName: string) {
      return routingDraftResponseSchema.parse(
        await checkedJson(
          await page.request.post(`${benchmarkApi}/routing-drafts`, {
            data: {
              requestId: randomUUID(),
              candidateKey: primary.candidateKey,
              scorerRevisionId: seeded.accuracyScorerRevisionId,
              suiteRevisionId: seeded.suiteRevisionId,
              taskClass: { slug: "delivery", name: taskClassName },
              constraints: {
                qualityFloorBps: 8_000,
                maxMeanCostUsd: 0.1,
                maxLatencyMs: 120_000,
                minResolvedTrials: 2,
                minConfidenceBps: null,
              },
            },
          }),
          201,
        ),
      );
    }

    const initial = await proposeRouting("Invoice delivery");
    const historical = z
      .object({
        runId: z.uuid(),
        policyRevisionId: z.uuid(),
        renamedRevisionId: z.uuid(),
        taskClassName: z.string(),
      })
      .parse(
        await fixture.runFixtureFile("model-routing-inspector-seed.sql", {
          ...scope,
          draft_id: initial.draftId,
        }),
      );

    const reviewed =
      await test.step("Save the distinct qualified fallback against the current head", async () => {
        const { document: activeDocument } = factoryEditorDocumentResponseSchema.parse(
          await checkedJson(
            await page.request.get(
              `${definitionApi}/editor?revisionId=${historical.renamedRevisionId}`,
            ),
            200,
          ),
        );
        const activeClass = activeDocument.source.modelRouting?.taskClasses.find(
          ({ slug }) => slug === "delivery",
        );
        if (!activeClass) throw new Error("The original routing class identity is unavailable.");
        expect(activeClass.name).not.toBe(historical.taskClassName);
        const proposed = await proposeRouting(activeClass.name);
        const { document } = factoryEditorDocumentResponseSchema.parse(
          await checkedJson(
            await page.request.get(`${definitionApi}/editor?draftId=${proposed.draftId}`),
            200,
          ),
        );
        const policy = document.source.modelRouting;
        const primaryRule = policy?.rules.find(
          ({ id }) => id === document.routingDraftEvidence?.ruleId,
        );
        if (!policy || !primaryRule || !document.routingDraftEvidence)
          throw new Error("The exact draft evidence is unavailable.");
        const { data, error } = await admin
          .from("factory_benchmark_experiment_candidates")
          .select(
            "definition_revision_id, qualification_id, canonical_model_key, harness, worker_runtime",
          )
          .eq("workspace_id", fixture.workspaceId)
          .eq("factory_id", fixture.factoryId)
          .eq("experiment_id", experimentId)
          .eq("candidate_key", fallback.candidateKey)
          .single();
        if (error) throw error;
        expect(data.definition_revision_id).not.toBe(
          primaryRule.configuration.definitionRevisionId,
        );
        const { currentActivation } = factoryEditorHistoryResponseSchema.parse(
          await checkedJson(await page.request.get(definitionApi), 200),
        );
        if (!currentActivation) throw new Error("The disposable factory has no active definition.");
        expect(currentActivation.revisionId).toBe(historical.renamedRevisionId);
        const head = currentActivation.activationNumber;
        const response = z
          .object({ draft: z.object({ id: z.uuid(), canonicalDigest: z.string() }) })
          .parse(
            await checkedJson(
              await page.request.post(definitionApi, {
                data: {
                  action: "draft",
                  expectedActivationNumber: head,
                  expectedDraftId: proposed.draftId,
                  source: {
                    kind: "structured",
                    value: {
                      ...document.source,
                      modelRouting: {
                        ...policy,
                        rules: policy.rules.map((rule) =>
                          rule.id === primaryRule.id
                            ? {
                                ...rule,
                                onUnavailable: {
                                  kind: "fallback",
                                  configuration: {
                                    ...rule.configuration,
                                    definitionRevisionId: data.definition_revision_id,
                                    qualificationId: data.qualification_id,
                                    modelKey: data.canonical_model_key,
                                    harness: data.harness,
                                    workerRuntime: data.worker_runtime,
                                  },
                                },
                              }
                            : rule,
                        ),
                      },
                    },
                  },
                },
              }),
              201,
            ),
          );
        const smoke = z.object({ testId: z.uuid(), repositoryId: z.uuid() }).parse(
          await fixture.runFixtureFile("reviewed-routing-seed.sql", {
            ...scope,
            draft_id: response.draft.id,
          }),
        );
        return { ...response.draft, head, ruleId: primaryRule.id, ...smoke };
      });

    const activated =
      await test.step("Review the evidence and activate through Factory Definition", async () => {
        await page.goto(
          workspaceFactoryDefinitionPath(fixture.slug, { factory: fixture.factoryId }),
        );
        const trigger = page.getByRole("button", { name: "Activate reviewed routing" });
        await expect(trigger).toBeEnabled({ timeout: 75_000 });
        await trigger.focus();
        await page.keyboard.press("Enter");
        const confirmation = page.getByRole("alertdialog", { name: "Activate reviewed routing?" });
        await expect(confirmation.getByText(`#${reviewed.head}`, { exact: true })).toBeVisible();
        await expect(
          confirmation.getByText(reviewed.canonicalDigest, { exact: true }),
        ).toBeVisible();
        await expect(confirmation.getByRole("link", { name: /Exact comparison/ })).toHaveAttribute(
          "href",
          new RegExp(`#frontier-configuration-${primary.candidateKey}$`),
        );
        await expect(
          confirmation.getByRole("link", { name: /Passing configuration test/ }),
        ).toHaveAttribute(
          "href",
          `${workspaceFactoryDefinitionPath(fixture.slug, { draft: reviewed.id, test: reviewed.testId, factory: fixture.factoryId })}#candidate-tests`,
        );
        await capture(page, confirmation, info, "reviewed-routing-activation-light");
        const [response] = await Promise.all([
          page.waitForResponse(
            (entry) =>
              new URL(entry.url()).pathname === definitionApi &&
              entry.request().method() === "POST",
            { timeout: 75_000 },
          ),
          confirmation.getByRole("button", { name: "Activate routing for new sessions" }).click(),
        ]);
        expect(response.request().postDataJSON()).toEqual({
          action: "activate-routing",
          expectedActivationNumber: reviewed.head,
          draftId: reviewed.id,
        });
        const body = z
          .object({ activation: z.object({ activationNumber: z.number(), revisionId: z.uuid() }) })
          .parse(await checkedJson(response, 201));
        expect(body.activation.activationNumber).toBe(reviewed.head + 1);
        await expect(
          page.getByText("Routing active for new sessions", { exact: true }),
        ).toBeVisible({ timeout: 75_000 });

        await checkedJson(
          await page.request.post(definitionApi, { data: response.request().postDataJSON() }),
          409,
        );
        await checkedJson(
          await reader.request.post(definitionApi, { data: response.request().postDataJSON() }),
          403,
        );
        return body.activation;
      });

    const created =
      await test.step("Submit and audit a permissioned one-task override", async () => {
        const options = z.object({ routingOverrideOptions: z.unknown().optional() });
        const ownerOptions = routingOverrideOptionsSchema.parse(
          options.parse(await checkedJson(await page.request.get(optionsApi), 200))
            .routingOverrideOptions,
        );
        expect(ownerOptions.activationNumber).toBe(activated.activationNumber);
        expect(ownerOptions.targets.map(({ target }) => target).sort()).toEqual([
          "primary",
          "rule_fallback",
        ]);
        expect(
          options.parse(await checkedJson(await reader.request.get(optionsApi), 200))
            .routingOverrideOptions,
        ).toBeUndefined();

        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        await page.getByRole("button", { name: "New session", exact: true }).click();
        const dialog = page.getByRole("dialog");
        const choice = dialog.getByRole("combobox", { name: "Configuration for this session" });
        await expectDropdownValue(choice, "", { timeout: 75_000 });
        await dialog
          .getByLabel("Prompt", { exact: true })
          .fill("Prepare the invoice delivery summary.");
        await dialog.getByLabel("Title (optional)").fill("Invoice delivery routing proof");
        await selectDropdownOption(choice, `${reviewed.ruleId}:rule_fallback`);
        const submit = dialog.getByRole("button", { name: "Start session" });
        await expect(submit).toBeDisabled();
        await dialog.getByLabel("Reason for override").fill(overrideReason);
        await capture(
          page,
          dialog.getByRole("group", { name: "Routing override" }),
          info,
          "routing-override-mobile-dark",
        );
        const [response] = await Promise.all([
          page.waitForResponse(
            (entry) =>
              new URL(entry.url()).pathname === "/api/sessions" &&
              entry.request().method() === "POST",
            { timeout: 75_000 },
          ),
          submit.click(),
        ]);
        const payload = response.request().postDataJSON();
        expect(payload.routingOverride).toEqual({
          expectedActivationNumber: activated.activationNumber,
          ruleId: reviewed.ruleId,
          target: "rule_fallback",
          reason: overrideReason,
        });
        const created = z.object({ number: z.number() }).parse(await checkedJson(response, 201));
        await checkedJson(
          await reader.request.post("/api/sessions", {
            data: { ...payload, requestId: randomUUID() },
          }),
          403,
        );
        await checkedJson(
          await page.request.post("/api/sessions", {
            data: {
              ...payload,
              requestId: randomUUID(),
              routingOverride: {
                ...payload.routingOverride,
                expectedActivationNumber: reviewed.head,
              },
            },
          }),
          409,
        );
        return created;
      });

    await test.step("Verify the pinned recommendation, separate override, and historical attempt", async () => {
      const session = await admin
        .from("sessions")
        .select("id")
        .eq("workspace_id", fixture.workspaceId)
        .eq("factory_id", fixture.factoryId)
        .eq("number", created.number)
        .single();
      if (session.error) throw session.error;
      const [admission, override] = await Promise.all([
        admin
          .from("session_factory_admission_inputs")
          .select("activation_number, definition_revision_id, routing_decision")
          .eq("session_id", session.data.id)
          .single(),
        admin
          .from("session_factory_routing_overrides")
          .select("actor_member_id, reason, target, routing_execution")
          .eq("session_id", session.data.id)
          .single(),
      ]);
      if (admission.error) throw admission.error;
      if (override.error) throw override.error;
      expect(admission.data).toMatchObject({
        activation_number: activated.activationNumber,
        definition_revision_id: activated.revisionId,
        routing_decision: {
          mode: "active",
          source: "primary",
          benchmarkCandidateKey: primary.candidateKey,
        },
      });
      expect(override.data).toMatchObject({
        actor_member_id: fixture.ownerMemberId,
        reason: overrideReason,
        target: "rule_fallback",
        routing_execution: { benchmarkCandidateKey: fallback.candidateKey },
      });

      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto(workspaceRunDetailPath(fixture.slug, historical.runId));
      const inspected = page.locator("#routing-decision");
      await expect(inspected.getByText(historical.taskClassName, { exact: true })).toBeVisible({
        timeout: 75_000,
      });
      await expect(inspected.getByText(/Shadow evaluation recorded at admission/)).toBeVisible();
      await expect(
        inspected.getByRole("link", { name: historical.policyRevisionId }),
      ).toHaveAttribute("href", new RegExp(`[?&]revision=${historical.policyRevisionId}(?:&|$)`));
      await expect(
        inspected.getByRole("link", { name: "Open exact comparison configuration" }),
      ).toHaveAttribute("href", new RegExp(`#frontier-configuration-${primary.candidateKey}$`));
      await capture(page, inspected, info, "routing-historical-inspector");
    });
  } finally {
    await viewer.close();
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
  }
});
