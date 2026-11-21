import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";

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

import { benchmarkAxisSnapshotSchema } from "@/lib/factory-benchmarks/experiment-axes-contracts";
import { compiledFactoryDefinitionSchema } from "@/lib/factory-definitions/schema";
import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import type { Database } from "@/lib/supabase/database.types";
import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";

const nativeModel = "gpt-4.1-2025-04-14";
const canonicalModel = `openai/${nativeModel}`;
const runnerRevision = "openai-responses-v1";
const fakeApiKey = "sk-synthetic-live-browser-fixture";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const cli = z.strictObject({ cliVersion: z.string(), cliDigest: digest });
const connectionReceipt = z.strictObject({
  connection: z.strictObject({
    id: z.uuid(),
    sandboxConnectionRevision: z.uuid(),
    createdAt: z.iso.datetime({ offset: true }),
    profile: z.strictObject({
      image: z.string(),
      codex: cli,
      opencode: cli,
    }),
  }),
});

async function readResponse(response: APIResponse, status: number) {
  const text = await response.text();
  expect(response.status(), text).toBe(status);
  return JSON.parse(text) as unknown;
}

function checked<T>(result: { data: T; error: unknown }): NonNullable<T> {
  if (result.data == null) throw result.error ?? new Error("Missing fixture data.");
  return result.data;
}

async function seedLiveReplay(fields: Record<string, string>) {
  const database = new URL(z.url().parse(process.env.WALLIE_FACTORY_ANALYTICS_DATABASE_URL));
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
    database.protocol !== "postgresql:" ||
    !database.port ||
    database.pathname !== "/postgres" ||
    database.search ||
    database.hash
  ) {
    throw new Error("Benchmark browser fixtures require a disposable loopback database.");
  }
  const { stdout } = await promisify(execFile)(
    "psql",
    [
      "-XqAt",
      "--no-password",
      `--host=${database.hostname.replace(/^\[|\]$/g, "")}`,
      `--port=${database.port}`,
      `--username=${decodeURIComponent(database.username)}`,
      "--dbname=postgres",
      "--set=ON_ERROR_STOP=1",
      ...Object.entries(fields).map(([key, value]) => `--set=${key}=${value}`),
      "--file",
      resolve(__dirname, "helpers/factory-benchmark-live-seed.sql"),
    ],
    {
      timeout: 20_000,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        PGPASSWORD: decodeURIComponent(database.password),
      },
    },
  );
  return z
    .object({
      suiteId: z.uuid(),
      suiteRevisionId: z.uuid(),
      taskRevisionId: z.uuid(),
      policyRevisionId: z.uuid(),
    })
    .parse(JSON.parse(stdout.trim()));
}

async function selectWorkerd(card: Locator, harness: "codex" | "opencode", definitionId: string) {
  await card.getByRole("combobox", { name: "Model", exact: true }).selectOption(canonicalModel);
  await card.getByRole("combobox", { name: "Harness", exact: true }).selectOption(harness);
  const runtime = card.getByRole("combobox", { name: "Worker runtime", exact: true });
  await runtime.selectOption("workerd");
  await expect(runtime).toHaveValue("workerd");
  await card
    .getByRole("combobox", { name: "Factory revision", exact: true })
    .selectOption(definitionId);
  await card.getByText("Exact configuration pins", { exact: true }).click();
}

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled", caret: "hide" });
  await info.attach(name, { path, contentType: "image/png" });
}

test("a manager freezes both Workerd harness pins and configures a live schedule", async ({
  baseURL,
  page,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_LIVE_BENCHMARKS_E2E !== "1",
    "Requires disposable local Supabase and a synthetic managed image profile.",
  );
  test.setTimeout(90_000);
  if (
    process.env.WALLIE_SANDBOX_IMPL !== "fake" ||
    process.env.WALLIE_WORKER_WAKE_URL !== "" ||
    process.env.WALLIE_WORKER_WAKE_SECRET !== ""
  ) {
    throw new Error("Set the fake sandbox and explicitly disable remote worker wake.");
  }
  const fixture = await seedFactoryAnalytics(baseURL);
  const admin = createClient<Database>(
    z.url().parse(process.env.NEXT_PUBLIC_SUPABASE_URL),
    z.string().min(1).parse(process.env.SUPABASE_SECRET_KEY),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { workspaceId, factoryId } = fixture;

  try {
    const repository = checked(
      await admin
        .from("github_repositories")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .single(),
    );
    const definitionId = randomUUID();
    const sandboxRevision = randomUUID();
    const codexId = randomUUID();
    const opencodeId = randomUUID();
    const definition = serializeFactoryDefinition(
      compiledFactoryDefinitionSchema.parse({
        schemaVersion: 1,
        kind: "serial",
        pipelineId: fixture.pipelineId,
        repositoryId: repository.id,
        sandboxProvider: "vercel",
        agent: {
          provider: "codex",
          model: nativeModel,
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
            promptTemplateMd: "Reconcile the invoice and verify the saved totals.",
            anyoneCanApprove: false,
            approverMemberIds: [],
            previousStageIds: [],
          },
        ],
      }),
    );
    const suite = await seedLiveReplay({
      workspace_id: workspaceId,
      factory_id: factoryId,
      owner_id: fixture.ownerId,
      repository_id: repository.id,
      source_run_id: fixture.producingRunId,
      sandbox_revision: sandboxRevision,
      definition_id: definitionId,
      definition_json: definition.definitionJson,
      definition_digest: definition.canonicalDigest,
      codex_id: codexId,
      opencode_id: opencodeId,
    });
    const suitePath = `/w/${fixture.slug}/benchmarks/${suite.suiteId}?factory=${factoryId}&revision=${suite.suiteRevisionId}`;
    const endpoint = `/api/workspaces/${workspaceId}/factories/${factoryId}/benchmarks`;

    await page.setViewportSize({ width: 1440, height: 1024 });
    await signInViaMagicLink(page, suitePath, { baseURL: fixture.app, email: fixture.ownerEmail });

    const connectionEndpoint = `${endpoint}/inference-connection`;
    const created = connectionReceipt.parse(
      await readResponse(
        await page.request.post(connectionEndpoint, {
          data: { action: "connect", apiKey: fakeApiKey },
        }),
        201,
      ),
    );
    expect(created.connection).toMatchObject({
      sandboxConnectionRevision: sandboxRevision,
      profile: {
        image: expect.stringMatching(/^vcr\.vercel\.com\/.*@sha256:[a-f0-9]{64}$/),
        codex: { cliVersion: "0.88.0" },
        opencode: { cliVersion: "1.2.27" },
      },
    });
    expect(await readResponse(await page.request.get(connectionEndpoint), 200)).toEqual(created);
    const otherConnection = await page.request.get(
      `/api/workspaces/${workspaceId}/factories/${fixture.siblingFactoryId}/benchmarks/inference-connection`,
    );
    expect(await readResponse(otherConnection, 200)).toEqual({ connection: null });

    await page.getByRole("link", { name: "Compare configurations", exact: true }).click();
    const form = page.getByRole("form", { name: "Benchmark comparison" });
    const baseline = form.getByRole("group", { name: "Baseline" });
    const candidate = form.getByRole("group", { name: "Candidate" });
    await selectWorkerd(baseline, "codex", definitionId);
    await selectWorkerd(candidate, "opencode", definitionId);
    for (const [card, name, qualification] of [
      [baseline, "Codex 0.88.0", codexId],
      [candidate, "OpenCode 1.2.27", opencodeId],
    ] as const) {
      await expect(
        card.getByText(`Capability check passed · ${name}`, { exact: true }),
      ).toBeVisible();
      await expect(card.getByText(qualification, { exact: true })).toBeVisible();
      await expect(card.getByText(definition.canonicalDigest, { exact: true })).toBeVisible();
    }
    const policy = form.getByRole("combobox", { name: "Replay policy revision" });
    await policy.selectOption(suite.policyRevisionId);
    await expect(policy.locator("option:checked")).toHaveText(/blocked/i);
    await form.getByRole("spinbutton", { name: "Repetitions" }).fill("1");
    const freeze = form.getByRole("button", { name: "Freeze comparison", exact: true });
    await expect(freeze).toBeEnabled();
    await capture(page, info, "benchmark-live-workerd-pins");

    const [freezeResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`${endpoint}/experiment-axes`) &&
          response.request().method() === "POST",
      ),
      freeze.click(),
    ]);
    const freezeBody = await freezeResponse.text();
    expect(freezeResponse.ok(), freezeBody).toBeTruthy();
    const frozen = benchmarkAxisSnapshotSchema.parse(JSON.parse(freezeBody));
    expect(frozen).toMatchObject({
      suiteRevisionId: suite.suiteRevisionId,
      policyRevisionId: suite.policyRevisionId,
      candidateCount: 2,
      taskCount: 1,
      repetitions: 1,
      materializedTrialCount: 2,
      eligibleTrialCount: 2,
    });
    await expect(form.getByText("Comparison frozen", { exact: true })).toBeVisible();
    await expect(
      form.getByText("2 planned · 2 eligible · 0 ineligible", { exact: true }),
    ).toBeVisible();
    await capture(page, info, "benchmark-live-workerd-frozen");

    const candidates = checked(
      await admin
        .from("factory_benchmark_experiment_candidates")
        .select(
          "candidate_key,comparison_position,definition_revision_id,definition_digest,canonical_model_key,harness,model,worker_runtime,sandbox_connection_revision,qualification_id,toolchain_digest,live_inference_connection_revision",
        )
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .eq("experiment_id", frozen.experimentId)
        .order("comparison_position"),
    );
    expect(candidates).toHaveLength(2);
    for (const [index, harness, model, qualification] of [
      [0, "codex", nativeModel, codexId],
      [1, "opencode", canonicalModel, opencodeId],
    ] as const) {
      expect(candidates[index]).toMatchObject({
        comparison_position: index + 1,
        definition_revision_id: definitionId,
        definition_digest: definition.canonicalDigest,
        canonical_model_key: canonicalModel,
        harness,
        model,
        worker_runtime: "workerd",
        sandbox_connection_revision: sandboxRevision,
        qualification_id: qualification,
        toolchain_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        live_inference_connection_revision: created.connection.id,
      });
    }
    const [codexDigest, opencodeDigest] = candidates.map(({ toolchain_digest }) =>
      digest.parse(toolchain_digest),
    );
    expect(codexDigest).not.toBe(opencodeDigest);
    await expect(baseline.getByText(codexDigest, { exact: true })).toBeVisible();
    await expect(candidate.getByText(opencodeDigest, { exact: true })).toBeVisible();

    const planned = checked(
      await admin
        .from("factory_benchmark_experiment_trials")
        .select("candidate_key,task_revision_id,repetition,replay_eligibility")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .eq("experiment_id", frozen.experimentId)
        .order("candidate_key"),
    );
    expect(planned).toEqual(
      candidates
        .map(({ candidate_key }) => candidate_key)
        .sort()
        .map((candidate_key) => ({
          candidate_key,
          task_revision_id: suite.taskRevisionId,
          repetition: 1,
          replay_eligibility: "eligible",
        })),
    );

    const scheduleEndpoint = `${endpoint}/experiments/${frozen.experimentId}/schedule`;
    const schedule = await readResponse(
      await page.request.post(scheduleEndpoint, {
        data: {
          action: "configure",
          runnerRevision,
          inferenceConnectionRevision: created.connection.id,
          executionReserveUsd: 0.5,
          evaluationReserveUsd: 0,
          budgetLimitUsd: 1,
          factoryConcurrencyLimit: 1,
          maxAdmittedTrials: 2,
        },
      }),
      200,
    );
    expect(schedule).toMatchObject({
      experimentId: frozen.experimentId,
      state: "active",
      runnerRevision,
      sandboxConnectionRevision: sandboxRevision,
      plannedTrialCount: 2,
      eligibleTrialCount: 2,
      admittedTrialCount: 0,
      executionSpentUsd: 0,
      reservedUsd: 0,
    });
    expect(await readResponse(await page.request.get(scheduleEndpoint), 200)).toEqual(schedule);
  } finally {
    await fixture.cleanup();
  }
});
