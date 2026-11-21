import { randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { benchmarkAxisSnapshotSchema } from "@/lib/factory-benchmarks/experiment-axes-contracts";
import { compiledFactoryDefinitionSchema } from "@/lib/factory-definitions/schema";
import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import type { Database } from "@/lib/supabase/database.types";
import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";

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
  await card.getByRole("combobox", { name: "Model", exact: true }).selectOption(upstreamModel);
  await card.getByRole("combobox", { name: "Harness", exact: true }).selectOption(input.harness);
  await card.getByRole("combobox", { name: "Worker runtime", exact: true }).selectOption("node");
  await card
    .getByRole("combobox", { name: "Factory revision", exact: true })
    .selectOption(input.definitionId);
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
    const [baselineId, candidateId, codexId, opencodeId] = Array.from({ length: 4 }, randomUUID);
    function definition(promptTemplateMd: string) {
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
        skillIds: [],
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
    const baselineDefinition = definition("Reconcile the invoice and verify the saved totals.");
    const candidateDefinition = definition("Reconcile the invoice and verify the retry audit.");
    const { connectionRevision } = z
      .object({
        definitions: z.literal(2),
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
          codex_id: codexId,
          opencode_id: opencodeId,
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
    await form.getByRole("combobox", { name: "Replay policy revision" }).selectOption(policy.id);
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
    await runtime.selectOption("workerd");
    await expect(candidate.getByText(/no qualified OpenCode toolchain/i)).toBeVisible();
    await expect(candidate.getByRole("combobox", { name: "Harness", exact: true })).toHaveValue(
      "opencode",
    );
    await expect(candidate.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(
      upstreamModel,
    );
    await expect(
      candidate.getByRole("combobox", { name: "Factory revision", exact: true }),
    ).toHaveValue(baselineId);
    await expect(runtime).toHaveValue("workerd");
    await expect(freeze).toBeDisabled();
    const beforeFreeze = await admin
      .from("factory_benchmark_experiments")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", fixture.workspaceId);
    if (beforeFreeze.error) throw beforeFreeze.error;
    expect(beforeFreeze.count).toBe(0);
    await baseline.getByText("Exact configuration pins", { exact: true }).click();
    await screenshot(page, info, "02-benchmark-unsupported-runtime-mobile-dark");
    await runtime.selectOption("node");
    const candidateRevision = candidate.getByRole("combobox", { name: "Factory revision" });
    await candidateRevision.selectOption(candidateId);
    const multiAxisNote = form.getByText("Results describe the combined configuration change.");
    await expect(multiAxisNote).toBeVisible();
    await candidateRevision.selectOption(baselineId);
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
      return pairs;
    }

    const sameRevision = await freezeAndRead();
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
    await candidate.getByRole("combobox", { name: "Harness", exact: true }).selectOption("codex");
    await expect(
      form.getByText("Choose a different configuration for the candidate."),
    ).toBeVisible();
    await expect(freeze).toBeDisabled();
    await candidate
      .getByRole("combobox", { name: "Factory revision", exact: true })
      .selectOption(candidateId);
    if (!(await candidatePins.evaluate((summary) => summary.closest("details")?.open))) {
      await candidatePins.click();
    }
    await expect(candidate.getByText(candidateDefinition.canonicalDigest)).toBeVisible();
    const differentRevisions = await freezeAndRead();
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
  } finally {
    await fixture.cleanup();
  }
});
