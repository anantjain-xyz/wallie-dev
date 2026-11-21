import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { it, vi } from "vitest";
import { z } from "zod/v4";

import {
  loadBenchmarkCapturePreview,
  resolveBenchmarkCapture,
  saveBenchmarkCapture,
} from "@/lib/factory-benchmarks/capture";
import {
  createBenchmarkComparisonExport,
  readBenchmarkComparisonExport,
} from "@/lib/factory-benchmarks/comparison";
import { benchmarkComparisonExportManifestSchema } from "@/lib/factory-benchmarks/comparison-contracts";
import { openBenchmarkReplayPolicy } from "@/lib/factory-benchmarks/replay-policy";
import { replaySha256 } from "@/lib/factory-benchmarks/replay-contracts";
import { requestBenchmarkSchedule } from "@/lib/factory-benchmarks/schedule";
import { reconcileBenchmarkSchedules } from "@/lib/factory-benchmarks/schedule-maintenance";
import { readBenchmarkTrialEvidence } from "@/lib/factory-benchmarks/trial-evidence";
import { loadRequiredWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";
import { saveVercelSandboxConnection } from "@/lib/vercel-sandbox/server";
import { parseWorkerConfig } from "@/worker/config";
import { claimNextJob, runClaimedJob } from "@/worker/loop";
import { sweepStalledRuns } from "@/worker/stall-detector";

import {
  allowQualificationFetch,
  controlQualification,
  createQualificationClients,
  parseQualificationWitness,
  qualificationAcceptance,
  qualificationPrompt,
  qualificationReserveUsd,
  qualificationSuite,
  readTrialReport,
  receipt,
  reconcileAndReserve,
  rpcScope,
  scheduleScope,
  trialRow,
  type QualificationScope,
  type QualificationWitness,
} from "./factory-benchmark-qualification";
import {
  archiveQualificationSource,
  authenticatedQualificationViewer,
  gitInFixture,
  openSyntheticReplaySandbox,
  runQualificationSql,
  seedQualificationSource,
} from "./factory-benchmark-qualification-inputs";

const hosted = vi.hoisted(() => ({ open: vi.fn(), seal: vi.fn(), stop: vi.fn() }));
vi.mock("@/lib/sandbox", async (original) => ({
  ...(await original<typeof import("@/lib/sandbox")>()),
  createBenchmarkReplaySandbox: hosted.open,
  sealBenchmarkReplaySandbox: hosted.seal,
  stopSandboxById: hosted.stop,
}));
vi.mock("@/features/github/sandbox-token", () => ({
  mintSandboxRepositoryToken: async () => "",
}));

const witnessPath = process.env.WALLIE_M08_WITNESS_PATH;
const abandonedClaimSchema = z.object({ trialId: z.uuid(), jobId: z.uuid() });
const workerConfig = { ...parseWorkerConfig(), defaultConcurrencyLimit: 4 };

it.skipIf(process.env.WALLIE_M08_PHASE !== "prepare")(
  "captures archived inputs, freezes a repeated matrix, and publishes one real private Node result",
  async () => {
    assert(witnessPath);
    const password = process.env.WALLIE_M08_FIXTURE_PASSWORD;
    assert(password);
    const { config, admin } = createQualificationClients(
      process.env.WALLIE_FACTORY_RUNTIME_FIXTURE,
    );
    const directory = dirname(witnessPath);
    const archive = await archiveQualificationSource(directory);
    const refsBefore = gitInFixture(archive.origin, "show-ref");
    const seed = await seedQualificationSource({
      admin,
      archivedCommit: archive.archivedCommit,
      password,
    });
    const viewer = authenticatedQualificationViewer({
      url: config.url,
      publishableKey: config.publishableKey,
      userId: seed.actorUserId,
    });
    const workspace = await receipt(
      viewer
        .from("workspaces")
        .select("id,slug,name,avatar_path")
        .eq("id", seed.workspaceId)
        .single(),
    );
    const currentMember = await receipt(
      viewer
        .from("workspace_members")
        .select("id,role,kind,is_active")
        .eq("id", seed.memberId)
        .single(),
    );
    const access = { supabase: viewer, workspace, currentMember, user: { id: seed.actorUserId } };
    vi.stubGlobal(
      "fetch",
      allowQualificationFetch(config.url, globalThis.fetch, archive.archivedCommit),
    );

    try {
      const source = await resolveBenchmarkCapture(access, seed.sourceRunId);
      const original = await loadBenchmarkCapturePreview(source);
      assert.deepEqual(original.source.eligibility, { status: "eligible", reasons: [] });
      assert.equal(original.source.checkoutSha, archive.archivedCommit);
      const captured = await saveBenchmarkCapture(source, {
        acceptanceCriteria: qualificationAcceptance,
        suite: { id: randomUUID(), kind: "new", name: qualificationSuite, purpose: "regression" },
      });
      const missing = await resolveBenchmarkCapture(access, seed.missingRunId);
      const missingPreview = await loadBenchmarkCapturePreview(missing);
      assert.equal(missingPreview.source.eligibility.status, "ineligible");
      const frozenSuite = await saveBenchmarkCapture(missing, {
        acceptanceCriteria: qualificationAcceptance,
        suite: { kind: "existing", id: captured.suiteId, revisionId: captured.suiteRevisionId },
      });
      const retry = await saveBenchmarkCapture(missing, {
        expectedTaskRevisionId: frozenSuite.taskRevisionId,
        suite: { kind: "existing", id: captured.suiteId, revisionId: frozenSuite.suiteRevisionId },
      });
      assert.equal(retry.suiteRevisionId, frozenSuite.suiteRevisionId);
      assert.equal(retry.taskId, frozenSuite.taskId);

      await saveVercelSandboxConnection({
        admin,
        credentials: { token: "fixture", teamId: "team_fixture", projectId: "prj_fixture" },
        workspaceId: seed.workspaceId,
        createdByMemberId: seed.memberId,
        projectName: "Local benchmark qualification",
      });
      const { connection } = await loadRequiredWorkspaceSandboxConnection(
        admin,
        seed.workspaceId,
        "vercel",
      );
      const scope: QualificationScope = {
        workspaceId: seed.workspaceId,
        factoryId: seed.factoryId,
        actorUserId: seed.actorUserId,
        experimentId: randomUUID(),
      };
      const fixtureKey = replaySha256("Read three saved lines");
      const [fixture] = await receipt(
        admin.rpc("publish_factory_benchmark_replay_fixture", {
          ...rpcScope(scope),
          p_operation: "tool_read",
          p_fixture_key: fixtureKey,
          p_response_json: JSON.stringify({
            version: 1,
            operation: "count_utf8_lines",
            promptSha256: replaySha256(qualificationPrompt),
            checkoutSha: archive.archivedCommit,
            sourcePath: "README.md",
            expectedLineCount: 3,
          }),
        }),
      );
      assert(fixture);
      const policy = await receipt(
        admin.rpc("publish_factory_benchmark_replay_policy", {
          ...rpcScope(scope),
          p_profile: "recorded_fixtures",
          p_fixture_revision_ids: [fixture.id],
        }),
      );
      await receipt(
        admin.rpc("freeze_factory_benchmark_experiment", {
          ...rpcScope(scope),
          p_experiment_id: scope.experimentId,
          p_suite_revision_id: frozenSuite.suiteRevisionId,
          p_policy_revision_id: policy.id,
          p_candidates: [seed.definition, seed.candidate].map(({ id, bytes }) => ({
            definitionRevisionId: id,
            definitionDigest: replaySha256(bytes),
            harness: "codex",
            model: "gpt-5.5",
            sandboxProvider: "vercel",
            workerRuntime: "node",
          })),
          p_repetitions: 2,
          p_seed: 624,
          p_timeout_ms: 120_000,
        }),
      );
      const initial = await readTrialReport(admin, scope);
      assert.equal(initial.counts.planned, 8);
      assert.equal(initial.counts.eligible, 4);
      assert.equal(initial.counts.excluded, 4);
      assert(
        initial.trialRows
          .filter((row) => row.status === "excluded")
          .every((row) => row.eligibilityReason),
      );
      writeFileSync(join(directory, "original-comparison.json"), JSON.stringify(initial), {
        mode: 0o600,
      });
      await requestBenchmarkSchedule(scheduleScope(admin, scope), {
        action: "configure",
        runnerRevision: "recorded-fixture-v1",
        sandboxConnectionRevision: connection.revision,
        taskFixtures: [{ taskRevisionId: captured.taskRevisionId, fixtureKey }],
        executionReserveUsd: qualificationReserveUsd,
        evaluationReserveUsd: 0,
        budgetLimitUsd: qualificationReserveUsd * 4,
        factoryConcurrencyLimit: 1,
        maxAdmittedTrials: 4,
      });
      const first = await reconcileAndReserve(admin, scope);
      await controlQualification(admin, scope, "pause");
      await reconcileBenchmarkSchedules(admin);
      assert.equal((await controlQualification(admin, scope, "read")).admittedTrialCount, 1);
      assert.equal((await claimNextJob(admin, workerConfig)).outcome, "idle");
      await controlQualification(admin, scope, "resume");
      const claim = await claimNextJob(admin, workerConfig);
      assert(claim.outcome === "claimed");
      assert.equal(claim.job.id, first.job_id);

      const sandbox = openSyntheticReplaySandbox(archive.origin);
      hosted.open.mockImplementationOnce(
        async (
          request: Parameters<typeof import("@/lib/sandbox").createBenchmarkReplaySandbox>[0],
        ) => {
          const active = await readTrialReport(admin, scope);
          assert.equal(active.counts.running, 1);
          const edit = await receipt(
            admin.rpc("save_factory_benchmark_task_revision", {
              ...rpcScope(scope),
              p_task_id: captured.taskId,
              p_expected_revision_id: captured.taskRevisionId,
              p_name: "Edited task in the live suite",
              p_acceptance_criteria: "New criteria that belong to the next comparison.",
              p_tags: ["edited"],
              p_replay_eligibility: "eligible",
            }),
          );
          const edited = await receipt(
            admin.rpc("save_factory_benchmark_suite_revision", {
              ...rpcScope(scope),
              p_suite_id: captured.suiteId,
              p_expected_revision_id: frozenSuite.suiteRevisionId,
              p_name: "Edited live suite",
              p_purpose: "regression",
              p_task_revision_ids: [edit.id],
            }),
          );
          assert.notEqual(edited.id, frozenSuite.suiteRevisionId);
          await request.onSandboxCreated?.({ sandboxId: sandbox.id, provider: "vercel" });
          return sandbox;
        },
      );
      hosted.seal.mockImplementationOnce(async () => {
        assert.equal(gitInFixture(sandbox.repoPath, "remote"), "");
      });
      hosted.stop.mockImplementationOnce(async () => sandbox.stop());
      try {
        await runClaimedJob(admin, claim.job, { timeoutMs: 90_000, workerRuntime: "node" });
      } finally {
        await sandbox.stop();
      }
      const completed = await trialRow(admin, first.trial_id);
      assert.equal(
        completed.status,
        "success",
        JSON.stringify({
          failure: completed.failure_code,
          sandboxCommands: sandbox.calls.map(
            ({ cmd, args }) => cmd + (cmd === "git" ? " " + args[0] : ""),
          ),
        }),
      );
      const result = await receipt(
        admin
          .from("factory_benchmark_trial_results")
          .select("input_commit_sha,input_tree_sha,output_commit_sha")
          .eq("trial_id", first.trial_id)
          .single(),
      );
      assert.equal(result.input_commit_sha, archive.archivedCommit);
      assert.equal(result.input_tree_sha, archive.archivedTree);
      assert.notEqual(result.output_commit_sha, archive.archivedCommit);
      const replay = await receipt(
        admin
          .from("factory_benchmark_replay_executions")
          .select("restoration_receipt_sha256")
          .eq("id", first.trial_id)
          .single(),
      );
      const broker = await openBenchmarkReplayPolicy({
        admin,
        ...scope,
        taskRevisionId: captured.taskRevisionId,
        executionId: first.trial_id,
        policyRevisionId: policy.id,
        expectedPolicyDigest: policy.policy_digest,
        restorationReceiptSha256: replay.restoration_receipt_sha256,
      });
      for (const operation of ["git_write", "chat_write", "issue_write", "deployment_write"]) {
        const denial = await broker.invoke({ operation });
        assert.equal(denial.receipt.decision, "denied");
        assert.equal(denial.response, undefined);
      }
      assert.equal(gitInFixture(archive.origin, "show-ref"), refsBefore);
      const next = await reconcileAndReserve(admin, scope);
      assert.notEqual(next.trial_id, first.trial_id);
      const witness: QualificationWitness = {
        ...scope,
        sourceRunId: seed.sourceRunId,
        ownerEmail: seed.ownerEmail,
        workspaceSlug: workspace.slug,
        siblingFactoryId: seed.siblingFactoryId,
        taskId: captured.taskId,
        taskRevisionId: captured.taskRevisionId,
        suiteId: captured.suiteId,
        suiteRevisionId: frozenSuite.suiteRevisionId,
        archivedCommit: archive.archivedCommit,
        archivedTree: archive.archivedTree,
        frozenTrialIds: initial.trialRows.map((row) => row.trialId),
        nodeTrialId: first.trial_id,
        nativeTrialId: next.trial_id,
      };
      writeFileSync(witnessPath, JSON.stringify(witness), { mode: 0o600 });
    } finally {
      vi.unstubAllGlobals();
    }
  },
  150_000,
);

it.skipIf(process.env.WALLIE_M08_PHASE !== "abandon")(
  "leaves a started claim behind when the first worker exits",
  async () => {
    assert(witnessPath);
    const witness = parseQualificationWitness(readFileSync(witnessPath, "utf8"));
    const { admin } = createQualificationClients(process.env.WALLIE_FACTORY_RUNTIME_FIXTURE);
    const native = await trialRow(admin, witness.nativeTrialId);
    assert.equal(native.status, "error");
    assert.equal(native.failure_code, "replay_unavailable");
    const interrupted = await reconcileAndReserve(admin, witness);
    const claim = await claimNextJob(admin, workerConfig);
    assert(claim.outcome === "claimed");
    assert.equal(claim.job.id, interrupted.job_id);
    const start = await receipt(
      admin.rpc("start_factory_benchmark_trial", {
        p_job_id: interrupted.job_id,
        p_attempt_count: claim.job.attempt_count,
      }),
    );
    assert.equal(start.run_id, interrupted.run_id);
    // Simulate a process that exited after it stored its start receipt.
    const aged = await admin
      .from("agent_runs")
      .update({ last_activity_at: "2000-01-01T00:00:00Z" })
      .eq("id", interrupted.run_id);
    assert.equal(aged.error, null);
    writeFileSync(
      join(dirname(witnessPath), "abandoned-claim.json"),
      JSON.stringify({ trialId: interrupted.trial_id, jobId: interrupted.job_id }),
      { mode: 0o600 },
    );
  },
  30_000,
);

it.skipIf(process.env.WALLIE_M08_PHASE !== "recover")(
  "reconciles a lost attempt after restart and reads the retained comparison evidence",
  async () => {
    assert(witnessPath);
    const witness = parseQualificationWitness(readFileSync(witnessPath, "utf8"));
    const { admin } = createQualificationClients(process.env.WALLIE_FACTORY_RUNTIME_FIXTURE);
    const interrupted = abandonedClaimSchema.parse(
      JSON.parse(readFileSync(join(dirname(witnessPath), "abandoned-claim.json"), "utf8")),
    );
    assert.equal((await trialRow(admin, interrupted.trialId)).status, "running");
    const recovery = await sweepStalledRuns(admin, 30_000, { workspaceId: witness.workspaceId });
    assert(recovery.stalledJobIds.includes(interrupted.jobId));
    assert.deepEqual(recovery.retriedJobIds, []);
    const lost = await trialRow(admin, interrupted.trialId);
    assert.equal(lost.failure_code, "attempt_lost");

    const last = await reconcileAndReserve(admin, witness);
    assert.notEqual(last.trial_id, interrupted.trialId);
    const canceled = await controlQualification(admin, witness, "cancel");
    assert.equal(canceled.state, "canceled");
    await reconcileBenchmarkSchedules(admin);
    await reconcileBenchmarkSchedules(admin);
    const report = await readTrialReport(admin, witness);
    assert.deepEqual(
      report.trialRows.map((row) => row.trialId),
      witness.frozenTrialIds,
    );
    assert.equal(report.suite.revisionId, witness.suiteRevisionId);
    assert.deepEqual(report.counts, {
      planned: 8,
      eligible: 4,
      excluded: 4,
      admitted: 4,
      started: 3,
      pending: 0,
      running: 0,
      succeeded: 1,
      failed: 2,
      timedOut: 0,
      canceled: 1,
      unavailable: 0,
      terminal: 4,
    });
    assert.equal(report.spend.execution.knownUsd, "0");
    assert.equal(report.spend.execution.unavailableAttemptCount, 3);
    assert.equal(report.spend.execution.neverStartedAttemptCount, 1);
    assert.equal(Number(report.spend.execution.unavailableHoldUsd), 3 * qualificationReserveUsd);
    assert.equal(report.spend.costUnavailableTrialCount, 3);

    const evidence = await readBenchmarkTrialEvidence({
      ...scheduleScope(admin, witness),
      trialId: witness.nodeTrialId,
    });
    assert.equal(evidence.task.acceptanceCriteria, qualificationAcceptance);
    assert.equal(evidence.output.inputCommitSha, witness.archivedCommit);
    assert.equal(evidence.output.inputTreeSha, witness.archivedTree);
    assert.equal(evidence.output.validation?.status, "passed");
    assert.equal(evidence.diff.availability, "available");
    assert(evidence.diff.patch?.includes(".wallie-benchmark-result.json"));

    const sideEffects = runQualificationSql(
      `
        with trials as (
          select session_id from public.factory_benchmark_trials
          where id in (
            select trial_id from public.factory_benchmark_schedule_trials where experiment_id = :'experiment'
          )
        )
        select json_build_array(
          (select count(*) from public.session_pull_requests join trials using (session_id)),
          (select count(*) from public.session_source_deliveries join trials using (session_id)),
          (select count(*) from internal.factory_outbound_events join trials using (session_id)),
          (select count(*) from internal.factory_outcome_observations join trials using (session_id))
        );
      `,
      { experiment: witness.experimentId },
    );
    assert.deepEqual(JSON.parse(sideEffects), [0, 0, 0, 0]);

    const exportDir = join(dirname(witnessPath), "export");
    mkdirSync(exportDir, { mode: 0o700 });
    const scope = scheduleScope(admin, witness);
    const exported = await createBenchmarkComparisonExport(scope, randomUUID());
    const body = await readBenchmarkComparisonExport(scope, exported.exportId);
    const manifest = benchmarkComparisonExportManifestSchema.parse(JSON.parse(body));
    assert.deepEqual(manifest.trialIds, witness.frozenTrialIds);
    writeFileSync(join(exportDir, `benchmark-${manifest.exportId}-manifest.json`), body, {
      mode: 0o600,
    });
    for (const [kind, pages, prefix] of [
      ["trials", manifest.pages, "part"],
      ["candidates", manifest.candidatePages, "candidate-part"],
    ] as const) {
      for (const page of pages) {
        const bytes = await readBenchmarkComparisonExport(scope, exported.exportId, {
          kind,
          ordinal: page.ordinal,
        });
        assert.equal(replaySha256(bytes), page.sha256);
        writeFileSync(
          join(exportDir, `benchmark-${manifest.exportId}-${prefix}-${page.ordinal}.json`),
          bytes,
          {
            mode: 0o600,
          },
        );
      }
    }
    assert.equal(await readBenchmarkComparisonExport(scope, exported.exportId), body);
    await assert.rejects(
      () =>
        readBenchmarkComparisonExport(
          { ...scope, factoryId: witness.siblingFactoryId },
          exported.exportId,
        ),
      { status: 404 },
    );
  },
  60_000,
);

it.skipIf(process.env.WALLIE_M08_PHASE !== "browser")(
  "views the settled local comparison and downloads its report through the signed-in app",
  async () => {
    assert(witnessPath);
    const witness = parseQualificationWitness(readFileSync(witnessPath, "utf8"));
    const { config } = createQualificationClients(process.env.WALLIE_FACTORY_RUNTIME_FIXTURE);
    const { browseBenchmarkQualification } =
      await import("./factory-benchmark-qualification-browser");
    const { NEXT_PUBLIC_APP_URL, WALLIE_M08_FIXTURE_PASSWORD } = process.env;
    assert(NEXT_PUBLIC_APP_URL && WALLIE_M08_FIXTURE_PASSWORD);
    await browseBenchmarkQualification({
      witness,
      appUrl: NEXT_PUBLIC_APP_URL,
      supabaseUrl: config.url,
      publishableKey: config.publishableKey,
      password: WALLIE_M08_FIXTURE_PASSWORD,
      workspaceSlug: witness.workspaceSlug,
      proofDir: join(dirname(witnessPath), "browser"),
    });
  },
  160_000,
);
