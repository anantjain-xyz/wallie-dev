import { randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { benchmarkEvaluationPageSchema } from "@/lib/factory-benchmarks/evaluation-outcomes-contracts";
import {
  benchmarkAxisSnapshotSchema,
  freezeBenchmarkAxesRequestSchema,
} from "@/lib/factory-benchmarks/experiment-axes-contracts";
import { compiledFactoryDefinitionSchema } from "@/lib/factory-definitions/schema";
import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import type { FactoryScorerDefinition } from "@/lib/factory-scorers/contracts";
import type { Database } from "@/lib/supabase/database.types";
import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";
import { expectDropdownValue, selectDropdownOption } from "./helpers/select";

const upstreamModel = "openai/gpt-4.1-2025-04-14";
const nativeCodexModel = "gpt-4.1-2025-04-14";

function checked<T>(result: { data: T | null; error: unknown }): T {
  if (result.data === null) throw result.error ?? new Error("Missing fixture data.");
  return result.data;
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled", caret: "hide" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function selectCandidate(
  card: Locator,
  input: { definitionId: string; harness: "codex" | "opencode" },
) {
  await selectDropdownOption(
    card.getByRole("combobox", { name: "Model", exact: true }),
    upstreamModel,
  );
  await selectDropdownOption(
    card.getByRole("combobox", { name: "Harness", exact: true }),
    input.harness,
  );
  await selectDropdownOption(
    card.getByRole("combobox", { name: "Worker runtime", exact: true }),
    "node",
  );
  await selectDropdownOption(
    card.getByRole("combobox", { name: "Factory revision", exact: true }),
    input.definitionId,
  );
}

test("a manager holds the model fixed across harnesses and freezes exact factory revisions", async ({
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
  const scope = {
    p_workspace_id: fixture.workspaceId,
    p_factory_id: fixture.factoryId,
    p_actor_user_id: fixture.ownerId,
  };

  try {
    const repository = await admin
      .from("github_repositories")
      .select("id")
      .eq("workspace_id", fixture.workspaceId)
      .eq("factory_id", fixture.factoryId)
      .single();
    if (repository.error) throw repository.error;
    const repositoryId = repository.data.id;
    const [baselineId, candidateId, revokedSkillDefinitionId, codexId, opencodeId] = Array.from(
      { length: 5 },
      randomUUID,
    );
    const skill = checked(
      await admin.rpc("create_factory_skill", {
        ...scope,
        p_name: "Invoice review checklist",
        p_slug: "invoice-review-checklist",
        p_content_md: "Verify that the invoice totals match the saved records.",
      }),
    );
    function definition(promptTemplateMd: string, skillIds: string[] = []) {
      const bundle = compiledFactoryDefinitionSchema.parse({
        schemaVersion: 1,
        kind: "serial",
        pipelineId: fixture.pipelineId,
        repositoryId,
        sandboxProvider: "vercel",
        agent: {
          provider: "codex",
          model: nativeCodexModel,
          effort: null,
          concurrencyLimit: 1,
          stallTimeoutMs: 120_000,
          maxRetries: 1,
          maxTurns: 5,
        },
        executionPolicyRevisionId: null,
        deliveryPolicyRevisionId: null,
        skillIds,
        toolIds: [],
        operatingRulesMd: "",
        operatingRuleStageIds: [],
        stages: [
          {
            id: fixture.stageId,
            slug: "delivery",
            name: "Delivery",
            description: "",
            promptTemplateMd,
            anyoneCanApprove: false,
            approverMemberIds: [],
            previousStageIds: [],
          },
        ],
      });
      return serializeFactoryDefinition(bundle);
    }
    const baselinePrompt = "Reconcile the invoice and verify the saved totals.";
    const baselineDefinition = definition(baselinePrompt);
    const candidateDefinition = definition("Reconcile the invoice and verify the retry audit.");
    const revokedSkillDefinition = definition(baselinePrompt, [skill.id]);
    const { connectionRevision } = z
      .object({
        definitions: z.literal(3),
        qualifications: z.literal(2),
        connectionRevision: z.uuid(),
      })
      .parse(
        await fixture.runFixtureFile("factory-benchmark-comparison-seed.sql", {
          workspace_id: fixture.workspaceId,
          factory_id: fixture.factoryId,
          owner_id: fixture.ownerId,
          repository_id: repositoryId,
          baseline_id: baselineId,
          baseline_json: baselineDefinition.definitionJson,
          baseline_digest: baselineDefinition.canonicalDigest,
          candidate_id: candidateId,
          candidate_json: candidateDefinition.definitionJson,
          candidate_digest: candidateDefinition.canonicalDigest,
          revoked_skill_definition_id: revokedSkillDefinitionId,
          revoked_skill_definition_json: revokedSkillDefinition.definitionJson,
          revoked_skill_definition_digest: revokedSkillDefinition.canonicalDigest,
          codex_id: codexId,
          opencode_id: opencodeId,
        }),
      );
    checked(
      await admin.rpc("revoke_factory_skill_revision", {
        ...scope,
        p_skill_id: skill.skill_id,
        p_revision_id: skill.id,
      }),
    );

    const [eligibleResult, ineligibleResult, policyResult] = await Promise.all([
      admin.rpc("create_factory_benchmark_task", {
        ...scope,
        p_source_run_id: fixture.producingRunId,
        p_name: "Verify duplicate invoice reconciliation",
        p_acceptance_criteria: "A retry preserves the original invoice totals.",
        p_tags: ["invoice"],
        p_replay_eligibility: "eligible",
      }),
      admin.rpc("create_factory_benchmark_task", {
        ...scope,
        p_source_run_id: fixture.failedRunId,
        p_name: "Verify notification recovery",
        p_acceptance_criteria: "A failed notification is recorded for retry.",
        p_tags: ["notification"],
        p_replay_eligibility: "ineligible",
        p_eligibility_reason: "The original notification inputs were not retained.",
      }),
      admin.rpc("publish_factory_benchmark_replay_policy", { ...scope, p_profile: "blocked" }),
    ]);
    const eligible = checked(eligibleResult);
    const ineligible = checked(ineligibleResult);
    const policy = checked(policyResult);
    const scoringDefinition = {
      schemaVersion: 1,
      rubric: "Verify that invoice totals reconcile after a duplicate import.",
      requiredEvidence: ["artifact"],
      scoring: { kind: "boolean", passValue: true },
    } satisfies FactoryScorerDefinition;
    const earlierScorer = checked(
      await admin.rpc("create_factory_scorer", {
        ...scope,
        p_name: "Invoice accuracy",
        p_slug: "invoice-accuracy",
        p_definition: scoringDefinition,
      }),
    );
    const latestScorer = checked(
      await admin.rpc("save_factory_scorer_revision", {
        ...scope,
        p_scorer_id: earlierScorer.scorer_id,
        p_expected_revision: earlierScorer.revision_number,
        p_definition: { ...scoringDefinition, rubric: "Verify totals and original line items." },
      }),
    );
    const auditScorer = checked(
      await admin.rpc("create_factory_scorer", {
        ...scope,
        p_name: "Retry audit evidence",
        p_slug: "retry-audit-evidence",
        p_definition: {
          ...scoringDefinition,
          rubric: "Verify that the retry recorded an audit entry.",
        },
      }),
    );
    const saved = checked(
      await admin.rpc("save_factory_benchmark_suite_revision", {
        ...scope,
        p_name: "Invoice reconciliation regression",
        p_purpose: "regression",
        p_task_revision_ids: [eligible.id, ineligible.id],
      }),
    );
    checked(
      await admin.rpc("save_factory_benchmark_suite_revision", {
        ...scope,
        p_name: saved.name,
        p_purpose: "regression",
        p_suite_id: saved.suite_id,
        p_expected_revision_id: saved.id,
        p_task_revision_ids: [eligible.id],
      }),
    );
    const suitePath = `/w/${fixture.slug}/benchmarks/${saved.suite_id}?factory=${fixture.factoryId}&revision=${saved.id}`;
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, suitePath, { baseURL: fixture.app, email: fixture.ownerEmail });
    await page.getByRole("link", { name: "Compare configurations", exact: true }).click();
    const region = page.locator("#compare-configurations");
    const form = region.getByRole("form", { name: "Benchmark comparison" });
    const baseline = form.getByRole("group", { name: "Baseline" });
    const candidate = form.getByRole("group", { name: "Candidate" });
    const freeze = form.getByRole("button", { name: "Freeze comparison", exact: true });
    await expect(form.getByText("Suite revision 1 · 2 tasks", { exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("revision")).toBe(saved.id);
    expect(new URL(page.url()).searchParams.get("factory")).toBe(fixture.factoryId);

    await selectCandidate(baseline, { definitionId: baselineId, harness: "codex" });
    await selectCandidate(candidate, { definitionId: baselineId, harness: "opencode" });
    await selectDropdownOption(
      form.getByRole("combobox", { name: "Replay policy revision" }),
      policy.id,
    );
    await expect(freeze).toBeEnabled();
    await baseline.getByText("Exact configuration pins", { exact: true }).click();
    const candidatePins = candidate.getByText("Exact configuration pins", { exact: true });
    await candidatePins.focus();
    await page.keyboard.press("Enter");
    await expect(baseline.getByText("Codex 0.88.0", { exact: true })).toBeVisible();
    await expect(candidate.getByText("OpenCode 1.2.27", { exact: true })).toBeVisible();
    await expect(baseline.getByText(baselineDefinition.canonicalDigest)).toBeVisible();
    await expect(candidate.getByText(baselineDefinition.canonicalDigest)).toBeVisible();
    await screenshot(page, info, "01-benchmark-same-model-across-harnesses-desktop-light");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const runtime = candidate.getByRole("combobox", { name: "Worker runtime", exact: true });
    await selectDropdownOption(runtime, "workerd");
    await expect(candidate.getByText(/no qualified OpenCode toolchain/i)).toBeVisible();
    await expectDropdownValue(
      candidate.getByRole("combobox", { name: "Harness", exact: true }),
      "opencode",
    );
    await expectDropdownValue(
      candidate.getByRole("combobox", { name: "Model", exact: true }),
      upstreamModel,
    );
    await expectDropdownValue(
      candidate.getByRole("combobox", { name: "Factory revision", exact: true }),
      baselineId,
    );
    await expectDropdownValue(runtime, "workerd");
    await expect(freeze).toBeDisabled();
    await baseline.getByText("Exact configuration pins", { exact: true }).click();
    await screenshot(page, info, "02-benchmark-unsupported-runtime-mobile-dark");
    await selectDropdownOption(runtime, "node");
    await expect(freeze).toBeEnabled();

    const candidateRevision = candidate.getByRole("combobox", { name: "Factory revision" });
    await selectDropdownOption(candidateRevision, revokedSkillDefinitionId);
    await expect(
      candidate.getByText(
        "A selected skill revision is missing, revoked, or unavailable in this factory.",
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    await expectDropdownValue(candidateRevision, revokedSkillDefinitionId);
    await expectDropdownValue(runtime, "node");
    await expect(freeze).toBeDisabled();
    const beforeFreeze = await admin
      .from("factory_benchmark_experiments")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", fixture.workspaceId);
    if (beforeFreeze.error) throw beforeFreeze.error;
    expect(beforeFreeze.count).toBe(0);
    await screenshot(page, info, "04-benchmark-revoked-skill-mobile-dark");

    await selectDropdownOption(candidateRevision, candidateId);
    const multiAxisNote = form.getByText("Results describe the combined configuration change.");
    await expect(multiAxisNote).toBeVisible();
    await selectDropdownOption(candidateRevision, baselineId);
    await expect(multiAxisNote).toBeHidden();

    async function freezeAndRead() {
      const [result] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith("/benchmarks/experiment-axes") &&
            response.request().method() === "POST",
        ),
        freeze.click(),
      ]);
      const body = await result.text();
      expect(result.ok(), body).toBeTruthy();
      const receipt = benchmarkAxisSnapshotSchema.parse(JSON.parse(body));
      const command = freezeBenchmarkAxesRequestSchema.parse(result.request().postDataJSON());
      await expect(form.getByText("Comparison frozen", { exact: true })).toBeVisible();
      await expect(
        form.getByText("12 planned · 6 eligible · 6 ineligible", { exact: true }),
      ).toBeVisible();
      expect(receipt).toMatchObject({
        suiteRevisionId: saved.id,
        candidateCount: 2,
        taskCount: 2,
        repetitions: 3,
        materializedTrialCount: 12,
      });
      const [candidates, trials] = await Promise.all([
        admin
          .from("factory_benchmark_experiment_candidates")
          .select(
            "candidate_key,comparison_position,definition_revision_id,definition_digest,canonical_model_key,harness,model,worker_runtime,sandbox_provider,sandbox_connection_revision,qualification_id,toolchain,toolchain_digest",
          )
          .eq("experiment_id", receipt.experimentId),
        admin
          .from("factory_benchmark_experiment_trials")
          .select("candidate_key,task_revision_id,repetition")
          .eq("experiment_id", receipt.experimentId),
      ]);
      const pairs = checked(candidates);
      const plan = checked(trials);
      expect(pairs).toHaveLength(2);
      expect(plan).toHaveLength(12);
      for (const pair of pairs) {
        expect(pair).toMatchObject({
          canonical_model_key: upstreamModel,
          sandbox_provider: "vercel",
          sandbox_connection_revision: connectionRevision,
          toolchain_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(
          plan
            .filter(({ candidate_key }) => candidate_key === pair.candidate_key)
            .map(({ task_revision_id, repetition }) => [task_revision_id, repetition]),
        ).toEqual(
          expect.arrayContaining(
            [eligible.id, ineligible.id].flatMap((task) =>
              [1, 2, 3].map((repetition) => [task, repetition]),
            ),
          ),
        );
      }
      return { pairs, receipt, command, endpoint: result.url() };
    }

    const { pairs: sameRevision, receipt: unscoredReceipt } = await freezeAndRead();
    expect(unscoredReceipt.evaluation).toBeUndefined();
    expect(sameRevision).toEqual(
      expect.arrayContaining(
        [
          {
            position: 1,
            harness: "codex",
            model: nativeCodexModel,
            qualification: codexId,
            toolchain: "Codex 0.88.0",
          },
          {
            position: 2,
            harness: "opencode",
            model: upstreamModel,
            qualification: opencodeId,
            toolchain: "OpenCode 1.2.27",
          },
        ].map(({ position, harness, model, qualification, toolchain }) =>
          expect.objectContaining({
            comparison_position: position,
            definition_revision_id: baselineId,
            definition_digest: baselineDefinition.canonicalDigest,
            harness,
            model,
            qualification_id: qualification,
            toolchain,
            worker_runtime: "node",
          }),
        ),
      ),
    );

    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await baseline.getByText("Exact configuration pins", { exact: true }).click();
    await selectDropdownOption(
      candidate.getByRole("combobox", { name: "Harness", exact: true }),
      "codex",
    );
    await expect(
      form.getByText("Choose a different configuration for the candidate."),
    ).toBeVisible();
    await expect(freeze).toBeDisabled();
    await selectDropdownOption(
      candidate.getByRole("combobox", { name: "Factory revision", exact: true }),
      candidateId,
    );
    if (!(await candidatePins.evaluate((summary) => summary.closest("details")?.open))) {
      await candidatePins.click();
    }
    await expect(candidate.getByText(candidateDefinition.canonicalDigest)).toBeVisible();
    await form.getByText("Scoring (optional)", { exact: true }).click();
    const currentScorerOption = form.getByRole("checkbox", {
      name: "Invoice accuracy · Revision 2",
      exact: true,
    });
    await form.getByRole("checkbox", { name: "Retry audit evidence · Revision 1" }).check();
    await form.getByRole("checkbox", { name: "Invoice accuracy · Revision 1" }).check();
    await expect(currentScorerOption).not.toBeChecked();
    const budget = form.getByRole("spinbutton", { name: "Evaluation budget (USD)" });
    await budget.fill("12.345678");
    await budget.blur();
    await screenshot(page, info, "05-benchmark-scoring-selection-desktop-light");

    const { pairs: differentRevisions, receipt, command, endpoint } = await freezeAndRead();
    expect(differentRevisions).toEqual(
      expect.arrayContaining(
        [
          { position: 1, id: baselineId, digest: baselineDefinition.canonicalDigest },
          { position: 2, id: candidateId, digest: candidateDefinition.canonicalDigest },
        ].map(({ position, id, digest }) =>
          expect.objectContaining({
            comparison_position: position,
            definition_revision_id: id,
            definition_digest: digest,
            harness: "codex",
            worker_runtime: "node",
          }),
        ),
      ),
    );
    await screenshot(page, info, "03-benchmark-exact-revisions-frozen-desktop-light");
    const frozenPlan = {
      scorerRevisionIds: [earlierScorer.id, auditScorer.id].sort(),
      budgetLimitUsd: 12.345678,
    };
    expect(receipt.evaluation).toEqual(frozenPlan);
    const frozenScorers = form.getByRole("list", { name: "Frozen scorer revisions" });
    await expect(frozenScorers.getByText("Invoice accuracy · Revision 1")).toBeVisible();
    await expect(frozenScorers.getByText("Retry audit evidence · Revision 1")).toBeVisible();
    await expect(frozenScorers.getByText("Invoice accuracy · Revision 2")).toHaveCount(0);
    await expect(form.getByText("Evaluation budget $12.345678")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await baseline.getByText("Exact configuration pins", { exact: true }).click();
    await candidatePins.click();
    await form.getByText("Scoring · 2 selected", { exact: true }).click();
    await screenshot(page, info, "06-benchmark-frozen-scoring-mobile-dark");

    const evaluationUrl = new URL(
      `experiments/${receipt.experimentId}/evaluation?limit=1`,
      endpoint,
    );
    const evaluationResponse = await page.request.get(evaluationUrl.toString());
    const evaluationBody = await evaluationResponse.text();
    expect(evaluationResponse.ok(), evaluationBody).toBeTruthy();
    const evaluationPage = benchmarkEvaluationPageSchema.parse(JSON.parse(evaluationBody));
    const emptySpend = { spentUsd: 0, reservedUsd: 0, unavailableCount: 0 };
    expect(evaluationPage).toMatchObject({
      experimentId: receipt.experimentId,
      evaluation: frozenPlan,
      eligibleTrialCount: receipt.eligibleTrialCount,
      denominator: receipt.eligibleTrialCount * 2,
      scheduleState: "unconfigured",
      spend: { execution: emptySpend, evaluation: emptySpend, combined: emptySpend },
    });
    expect(evaluationPage.cells).toHaveLength(1);
    const [firstCell] = evaluationPage.cells;
    expect(firstCell).toMatchObject({
      status: "pending",
      reason: "schedule_unconfigured",
      evaluationJobId: null,
      attemptId: null,
      score: null,
    });
    expect(frozenPlan.scorerRevisionIds).toContain(firstCell.scorerRevisionId);
    expect(evaluationPage.nextCursor).toEqual({
      trialId: firstCell.trialId,
      scorerRevisionId: firstCell.scorerRevisionId,
    });

    const [planRow, dimensions] = await Promise.all([
      admin
        .from("factory_benchmark_evaluation_plans")
        .select("budget_limit_usd")
        .eq("workspace_id", fixture.workspaceId)
        .eq("factory_id", fixture.factoryId)
        .eq("experiment_id", receipt.experimentId)
        .single(),
      admin
        .from("factory_benchmark_evaluation_dimensions")
        .select("scorer_revision_id")
        .eq("workspace_id", fixture.workspaceId)
        .eq("factory_id", fixture.factoryId)
        .eq("experiment_id", receipt.experimentId)
        .order("scorer_revision_id"),
    ]);
    if (planRow.error) throw planRow.error;
    expect(planRow.data.budget_limit_usd).toBe(frozenPlan.budgetLimitUsd);
    expect(checked(dimensions).map(({ scorer_revision_id }) => scorer_revision_id)).toEqual(
      frozenPlan.scorerRevisionIds,
    );
    checked(
      await admin.rpc("save_factory_scorer_revision", {
        ...scope,
        p_scorer_id: earlierScorer.scorer_id,
        p_expected_revision: latestScorer.revision_number,
        p_definition: { ...scoringDefinition, rubric: "Verify totals against the audit history." },
      }),
    );
    const retry = await page.request.post(endpoint, {
      data: {
        ...command,
        evaluation: {
          ...frozenPlan,
          scorerRevisionIds: [...frozenPlan.scorerRevisionIds].reverse(),
        },
      },
    });
    const retryBody = await retry.text();
    expect(retry.ok(), retryBody).toBeTruthy();
    expect(benchmarkAxisSnapshotSchema.parse(JSON.parse(retryBody))).toEqual(receipt);
    const changedBudget = await page.request.post(endpoint, {
      data: { ...command, evaluation: { ...frozenPlan, budgetLimitUsd: 13 } },
    });
    expect(changedBudget.status()).toBe(409);
    const unscoredRetry = await page.request.post(endpoint, {
      data: { ...command, evaluation: undefined },
    });
    expect(unscoredRetry.status()).toBe(409);
  } finally {
    await fixture.cleanup();
  }
});
