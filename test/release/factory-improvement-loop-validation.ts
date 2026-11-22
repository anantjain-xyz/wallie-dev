import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { benchmarkCaptureResultSchema } from "@/lib/factory-benchmarks/capture-contracts";
import { replaySha256 } from "@/lib/factory-benchmarks/replay-contracts";
import { readFactoryJudgeProfile } from "@/lib/factory-evaluations/judge-profile-controls";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import { factoryImprovementValidationCommandSchema } from "@/lib/factory-proposals/validation-contracts";
import {
  readFactoryImprovementValidation,
  startFactoryImprovementValidation,
} from "@/lib/factory-proposals/validation-server";
import { SOURCE_CHECKPOINT_REF } from "@/lib/pipeline/source-checkpoint";
import { fingerprintRunContextInput } from "@/lib/run-context/packing";
import { encryptSecretValue } from "@/lib/secrets/crypto";

import { receipt } from "./factory-benchmark-qualification";
import { gitInFixture } from "./factory-benchmark-qualification-inputs";
import {
  improvementQualificationDatabaseEnvironment,
  loopbackQualificationUrl,
  type ImprovementLoopContext,
  type ImprovementLoopSource,
  type ImprovementLoopValidation,
} from "./factory-improvement-loop-contract";
import {
  improvementLoopFixtureCostUsd,
  improvementLoopFixtureJudge,
  improvementLoopFixtureToolchain,
  improvementLoopReplayWitness,
  type ImprovementLoopReplayWitness,
} from "./factory-improvement-loop-replay-contract";

const acceptanceCriteria = "Retain the requested change and create acceptance-marker.txt.";
const scenarios = [
  "The saved result passed despite a missing marker on a newly created file.",
  "The saved result passed after updating the report but skipped the required marker.",
  "Preserve existing report headings when preparing a standard completed run.",
  "Keep the summary short when completing a normal reproducibility check.",
];

function localSql(context: ImprovementLoopContext, file: URL, values: Record<string, string> = {}) {
  return execFileSync(
    "psql",
    [
      "-XqAt",
      "--set=ON_ERROR_STOP=1",
      ...Object.entries(values).map(([key, value]) => `--set=${key}=${value}`),
      "--file",
      fileURLToPath(file),
    ],
    {
      encoding: "utf8",
      env: improvementQualificationDatabaseEnvironment(context.dbUrl),
      timeout: 90_000,
    },
  );
}

function verifyValidationRejections(context: ImprovementLoopContext) {
  const evidence = localSql(
    context,
    new URL("./factory-improvement-loop-rejections.psql", import.meta.url),
  );
  assert(evidence.includes("holdout-regression-rejected"));
  assert(evidence.includes("stale-base-and-altered-candidate-rejected"));
}

function prepareReplaySource(directory: string, runId: string, scenario: string, index: number) {
  const title = `Improvement fixture: ${scenario}`;
  const prompt = `${scenario} ${acceptanceCriteria}`;
  const path = join(directory, `source-${index + 1}`);
  mkdirSync(path);
  gitInFixture(path, "init", "-q");
  writeFileSync(join(path, "README.md"), `Qualification input ${index + 1}\n${scenario}\n`);
  gitInFixture(path, "add", "README.md");
  gitInFixture(path, "commit", "-qm", "Retain captured fixture input");
  const inputSha = gitInFixture(path, "rev-parse", "HEAD");
  const inputTree = gitInFixture(path, "rev-parse", "HEAD^{tree}");
  const inputRef = `refs/heads/improvement-loop-${runId}-${index + 1}`;
  gitInFixture(path, "update-ref", inputRef, inputSha);

  const outputs = [index >= 2, true].map((pass, position) => {
    gitInFixture(path, "reset", "--hard", inputSha);
    writeFileSync(
      join(path, "result.txt"),
      `Fixture arm ${position + 1} for input ${index + 1}.\n`,
    );
    if (pass) writeFileSync(join(path, "acceptance-marker.txt"), "Accepted fixture result.\n");
    gitInFixture(path, "add", ".");
    gitInFixture(path, "commit", "-qm", "Produce synthetic replay output");
    const outputSha = gitInFixture(path, "rev-parse", "HEAD");
    const outputTree = gitInFixture(path, "rev-parse", "HEAD^{tree}");
    const bundlePath = join(directory, `result-${index + 1}-${position + 1}.bundle`);
    gitInFixture(path, "update-ref", SOURCE_CHECKPOINT_REF, outputSha);
    gitInFixture(path, "bundle", "create", bundlePath, SOURCE_CHECKPOINT_REF, `^${inputSha}`);
    return {
      pass,
      outputSha,
      outputTree,
      bundle: readFileSync(bundlePath).toString("base64"),
      diff: gitInFixture(path, "diff", "--no-ext-diff", inputSha, outputSha) + "\n",
    };
  });

  const required = [
    { key: "session/title", ...fingerprintRunContextInput(title) },
    { key: "session/prompt", ...fingerprintRunContextInput(prompt) },
  ];
  const used = required.reduce((sum, entry) => sum + entry.utf8Bytes, 0);
  return {
    input: {
      slot: index + 1,
      session_id: randomUUID(),
      job_id: randomUUID(),
      run_id: randomUUID(),
      title,
      prompt,
      input_ref: inputRef,
      checkout_sha: inputSha,
      context_manifest: {
        version: 1,
        required,
        documents: [],
        conversation: { throughSequence: 0, olderOmitted: 0, messages: [] },
        budget: {
          maxUtf8Bytes: 131072,
          maxEstimatedTokens: 32768,
          usedUtf8Bytes: used,
          estimatedTokens: used,
        },
      },
    },
    replay: { prompt, inputRef, inputSha, inputTree, outputs },
  };
}

async function captureReplaySuite(
  context: ImprovementLoopContext,
  source: ImprovementLoopSource,
  purpose: "regression" | "holdout",
  inputs: ReturnType<typeof prepareReplaySource>[],
) {
  const suiteId = randomUUID();
  let suiteRevisionId: string | undefined;
  const tasks: ImprovementLoopReplayWitness["tasks"] = [];
  for (const { input, replay } of inputs) {
    const captured = benchmarkCaptureResultSchema.parse(
      await receipt(
        context.admin.rpc("capture_factory_benchmark_run", {
          p_workspace_id: source.workspaceId,
          p_factory_id: source.factoryId,
          p_actor_user_id: source.actorUserId,
          p_source_run_id: input.run_id,
          p_acceptance_criteria: acceptanceCriteria,
          p_task_name: input.title,
          p_replay_eligibility: "eligible",
          p_suite_id: suiteId,
          ...(suiteRevisionId
            ? { p_expected_revision_id: suiteRevisionId }
            : {
                p_new_suite_name: `Improvement loop ${purpose}`,
                p_new_suite_purpose: purpose,
              }),
        }),
      ),
    );
    suiteRevisionId = captured.suiteRevisionId;
    tasks.push({ taskRevisionId: captured.taskRevisionId, ...replay });
  }
  assert(suiteRevisionId);
  return { suiteRevisionId, tasks };
}

async function runNativeReplay(
  context: ImprovementLoopContext,
  witness: ImprovementLoopReplayWitness,
  directory: string,
) {
  const encryptionKey = process.env.WALLIE_ENCRYPTION_KEY;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  assert(encryptionKey && serviceKey, "Local qualification runtime credentials are unavailable.");
  const runtime = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "cloudflare/tests/factory-improvement-loop-validation.fixture.test.ts",
      "--config",
      "cloudflare/vitest.config.mts",
      "--testTimeout=180000",
    ],
    {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        TMPDIR: directory,
        XDG_CONFIG_HOME: directory,
        WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
        WRANGLER_SEND_METRICS: "false",
        WALLIE_ENCRYPTION_KEY: encryptionKey,
        NEXT_PUBLIC_SUPABASE_URL: context.apiUrl,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: context.anonymousKey,
        SUPABASE_SECRET_KEY: serviceKey,
        WALLIE_FACTORY_RUNTIME_FIXTURE: JSON.stringify({
          url: context.apiUrl,
          serviceKey,
          publishableKey: context.anonymousKey,
          improvementLoopWitness: witness,
        }),
      },
      stdio: "inherit",
      timeout: 240_000,
    },
  );
  const status = await new Promise<number | null>((resolve, reject) => {
    runtime.once("error", reject);
    runtime.once("close", resolve);
  });
  assert.equal(status, 0, "Native Workerd benchmark qualification failed.");
}

export async function qualifyImprovementLoopValidation(
  context: ImprovementLoopContext,
  source: ImprovementLoopSource,
): Promise<ImprovementLoopValidation> {
  loopbackQualificationUrl(context.apiUrl, ["http:"]);
  verifyValidationRejections(context);
  const { admin } = context;
  const definition = readVerifiedFactoryDefinition(
    source.baseline.definitionJson,
    source.baseline.digest,
  );
  assert(definition?.agent.provider === "codex" && definition.sandboxProvider === "vercel");
  assert.equal(replaySha256(source.candidate.definitionJson), source.candidate.digest);
  assert.notEqual(source.baseline.digest, source.candidate.digest);
  const args = {
    p_workspace_id: source.workspaceId,
    p_factory_id: source.factoryId,
    p_actor_user_id: source.actorUserId,
  };
  const repository = await receipt(
    admin
      .from("github_repositories")
      .select("repo_id")
      .eq("workspace_id", source.workspaceId)
      .eq("factory_id", source.factoryId)
      .eq("id", definition.repositoryId)
      .single(),
  );
  const sandbox = await receipt(
    admin
      .from("workspace_vercel_sandbox_connections")
      .select("connection_revision,team_id,project_id")
      .eq("workspace_id", source.workspaceId)
      .eq("status", "connected")
      .single(),
  );
  const profile = await readFactoryJudgeProfile(admin, source);
  assert(profile?.enabled);
  assert.equal(profile.modelId, improvementLoopFixtureJudge.model);
  assert.equal(profile.providerRoute, improvementLoopFixtureJudge.provider);

  const qualificationName = "sbx_wallie_m10_fixture_capability";
  const savedQualification = await admin
    .from("sandbox_capability_checks")
    .select("id")
    .eq("workspace_id", source.workspaceId)
    .eq("github_repository_id", definition.repositoryId)
    .eq("sandbox_id", qualificationName)
    .eq("sandbox_connection_revision", sandbox.connection_revision)
    .maybeSingle();
  assert(!savedQualification.error, savedQualification.error?.message);
  const qualification =
    savedQualification.data ??
    (await receipt(
      admin
        .from("sandbox_capability_checks")
        .insert({
          workspace_id: source.workspaceId,
          github_repository_id: definition.repositoryId,
          agent_provider: "codex",
          agent_model: definition.agent.model,
          sandbox_provider: "vercel",
          sandbox_id: qualificationName,
          sandbox_connection_revision: sandbox.connection_revision,
          sandbox_vercel_team_id: sandbox.team_id,
          sandbox_vercel_project_id: sandbox.project_id,
          status: "success",
          capabilities: Object.fromEntries(
            [
              "agentCli",
              "git",
              "node",
              "packageManager",
              "playwrightPackage",
              "chromium",
              "screenshotSmoke",
              "codexExternalSandbox",
            ].map((key) => [
              key,
              { ok: true, detail: `codex-cli ${improvementLoopFixtureToolchain.codex.cliVersion}` },
            ]),
          ),
        })
        .select("id")
        .single(),
    ));
  const savedPolicy = await admin
    .from("factory_benchmark_replay_policy_revisions")
    .select("id,profile")
    .eq("workspace_id", source.workspaceId)
    .eq("factory_id", source.factoryId)
    .order("revision_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  assert(!savedPolicy.error, savedPolicy.error?.message);
  const policy =
    savedPolicy.data ??
    (await receipt(
      admin.rpc("publish_factory_benchmark_replay_policy", { ...args, p_profile: "blocked" }),
    ));
  assert.equal(policy.profile, "blocked");
  const currentInference = await admin.rpc("read_factory_benchmark_inference_connection", args);
  assert(!currentInference.error, currentInference.error?.message);
  const inference = z
    .object({
      id: z.string().uuid(),
      sandboxConnectionRevision: z.string().uuid(),
      profile: z.unknown(),
    })
    .parse(
      currentInference.data ??
        (await receipt(
          admin.rpc("configure_factory_benchmark_inference_connection", {
            ...args,
            p_encrypted_api_key: encryptSecretValue("wallie-m10-synthetic-inference"),
            p_profile: improvementLoopFixtureToolchain,
          }),
        )),
    );
  assert.equal(inference.sandboxConnectionRevision, sandbox.connection_revision);
  assert.deepEqual(inference.profile, improvementLoopFixtureToolchain);
  const scorerSlug = "improvement-loop-fixture-scorer";
  const existingScorer = await admin
    .from("factory_scorers")
    .select("id")
    .eq("workspace_id", source.workspaceId)
    .eq("factory_id", source.factoryId)
    .eq("slug", scorerSlug)
    .maybeSingle();
  assert(!existingScorer.error, existingScorer.error?.message);
  const scorer = existingScorer.data
    ? await receipt(
        admin
          .from("factory_scorer_revisions")
          .select("id")
          .eq("workspace_id", source.workspaceId)
          .eq("factory_id", source.factoryId)
          .eq("scorer_id", existingScorer.data.id)
          .eq("revision_number", 1)
          .single(),
      )
    : await receipt(
        admin.rpc("create_factory_scorer", {
          ...args,
          p_name: "Improvement loop fixture scorer",
          p_slug: scorerSlug,
          p_definition: {
            schemaVersion: 1,
            rubric:
              "Verify the retained synthetic artifact reports the requested change and acceptance marker.",
            requiredEvidence: ["artifact", "validation_report"],
            scoring: { kind: "boolean", passValue: true },
          },
        }),
      );

  const outputRoot = fileURLToPath(new URL("../../.wallie", import.meta.url));
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(outputRoot, "m10-benchmark-"));
  try {
    const inputs = scenarios.map((scenario, index) =>
      prepareReplaySource(directory, context.runId, scenario, index),
    );
    localSql(context, new URL("./factory-improvement-loop-validation.psql", import.meta.url), {
      workspace_id: source.workspaceId,
      workspace_slug: source.workspaceSlug,
      factory_id: source.factoryId,
      actor_id: source.actorUserId,
      activation_number: String(source.baseline.activationNumber),
      baseline_id: source.baseline.revisionId,
      baseline_digest: source.baseline.digest,
      inputs: JSON.stringify(inputs.map(({ input }) => input)),
    });
    const targeted = await captureReplaySuite(context, source, "regression", inputs.slice(0, 2));
    const holdout = await captureReplaySuite(context, source, "holdout", inputs.slice(2));
    const overlappingTasks = [targeted.tasks[0], holdout.tasks[0]];
    const overlap = await receipt(
      admin.rpc("save_factory_benchmark_suite_revision", {
        ...args,
        p_name: "Rejected overlapping holdout",
        p_purpose: "holdout",
        p_task_revision_ids: overlappingTasks.map(({ taskRevisionId }) => taskRevisionId),
      }),
    );
    const scope = { ...source, client: admin, signal: AbortSignal.timeout(240_000) };
    const command = factoryImprovementValidationCommandSchema.parse({
      requestId: randomUUID(),
      targetedSuiteRevisionId: targeted.suiteRevisionId,
      holdoutSuiteRevisionId: holdout.suiteRevisionId,
      policyRevisionId: policy.id,
      scorerRevisionId: scorer.id,
      candidates: [source.baseline, source.candidate].map(({ revisionId }) => ({
        definitionRevisionId: revisionId,
        qualificationId: qualification.id,
        workerRuntime: "workerd",
      })),
      execution: {
        repetitions: 1,
        seed: 642,
        timeoutMs: 120_000,
        inferenceConnectionRevision: inference.id,
        executionReserveUsd: improvementLoopFixtureCostUsd * 2,
        evaluationReserveUsd: 0.1,
        evaluationBudgetLimitUsd: 2,
        targetedBudgetLimitUsd: 3,
        holdoutBudgetLimitUsd: 3,
        factoryConcurrencyLimit: 1,
        maxAdmittedTrials: 4,
      },
      thresholds: {
        minimumIndependentTasks: 2,
        minimumCoverageBps: 10000,
        minimumCandidatePassRateBps: 10000,
        maxPassRateDropBps: 0,
        maxMeanCostIncreaseBps: 0,
        maxP95LatencyIncreaseBps: 100000,
      },
    });
    await assert.rejects(
      startFactoryImprovementValidation(scope, {
        ...command,
        requestId: randomUUID(),
        holdoutSuiteRevisionId: overlap.id,
      }),
      { code: "PT422", message: /distinct source sessions/ },
    );
    assert.equal(await readFactoryImprovementValidation(scope), null);
    const { validation, replay } = await startFactoryImprovementValidation(scope, command);
    assert.equal(replay, false);
    assert.equal(validation.status, "inconclusive");
    assert.equal(validation.targeted.plannedPairs, 2);
    assert.equal(validation.holdout.plannedPairs, 2);
    assert.notEqual(validation.targeted.experimentId, validation.holdout.experimentId);
    await runNativeReplay(
      context,
      improvementLoopReplayWitness.parse({
        ...source,
        baselineRevisionId: source.baseline.revisionId,
        candidateRevisionId: source.candidate.revisionId,
        targetedExperimentId: validation.targeted.experimentId,
        holdoutExperimentId: validation.holdout.experimentId,
        upstreamModel: definition.agent.model,
        repositoryNumber: repository.repo_id,
        tasks: [...targeted.tasks, ...holdout.tasks],
      }),
      directory,
    );

    const result = await readFactoryImprovementValidation(scope);
    assert(result);
    assert.equal(result.status, "qualified", JSON.stringify(result));
    assert.equal(result.id, validation.id);
    assert.equal(result.targeted.baseline.passes, 0);
    assert.equal(result.targeted.candidate.passes, 2);
    assert.equal(result.holdout.baseline.passes, 2);
    assert.equal(result.holdout.candidate.passes, 2);
    const paidFixtureMean = improvementLoopFixtureCostUsd + improvementLoopFixtureJudge.costUsd;
    for (const split of [result.targeted, result.holdout]) {
      assert.equal(split.resolvedPairs, 2);
      assert.equal(split.independentTasks, 2);
      assert.equal(split.baseline.meanCostUsd, paidFixtureMean);
      assert.equal(split.candidate.meanCostUsd, paidFixtureMean);
    }
    return {
      validationId: result.id,
      targetedExperimentId: result.targeted.experimentId,
      holdoutExperimentId: result.holdout.experimentId,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
