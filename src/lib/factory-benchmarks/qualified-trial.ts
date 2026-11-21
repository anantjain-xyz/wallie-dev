import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createAgentRunner, type AgentRunner } from "@/lib/agent-runner";
import { BENCHMARK_REPLAY_API_PLACEHOLDER } from "@/lib/agent-runner/benchmark-replay";
import type { AgentEffort } from "@/lib/agent-config/contracts";
import type { AttemptWorkerRuntime } from "@/lib/pipeline/attempt-manifest";
import {
  captureSourceCheckpoint,
  SOURCE_CHECKPOINT_BUCKET,
} from "@/lib/pipeline/source-checkpoint";
import {
  createWorkerAttemptDeadline,
  WorkerAttemptDeadlineError,
} from "@/lib/pipeline/worker-attempt-deadline";
import { loadRequiredWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";
import { WALLIE_GIT_IDENTITY_ENV } from "@/lib/sandbox/commit-author";
import { observeUntilAbort } from "@/lib/sandbox/lifecycle";
import type { SandboxHandle } from "@/lib/sandbox/types";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { readValidationIdentity } from "@/lib/validation-evidence/capture";
import { uploadWorkspaceObject } from "@/lib/workspaces/resource-operations";

import { renderQualifiedReplayPrompt } from "./qualified-prompt";
import { bindQualifiedSandbox, qualifiedTrialRpcIdentity } from "./qualified-sandbox-binding";
import {
  QUALIFIED_BENCHMARK_RUNNER,
  QUALIFIED_PROMPT_RENDERER_VERSION,
  qualifiedInferenceReceiptSchema,
  qualifiedTrialClaimSchema,
  qualifiedTrialResultSchema,
  type QualifiedTrialClaim,
} from "./qualified-trial-contracts";
import { withQualifiedBenchmarkReplay } from "./replay-sandbox";
import {
  benchmarkEvidenceSensitiveValues,
  readPrivateBenchmarkDiff,
  stagePrivateBenchmarkDiff,
} from "./trial-diff";
import { runRecordedBenchmarkTrial } from "./trial-runner";
import { BenchmarkTrialTranscript } from "./trial-transcript";

type Admin = SupabaseClient<Database>;
type BenchmarkJob = {
  admin: Admin;
  job: Tables<"agent_jobs">;
  workerRuntime: AttemptWorkerRuntime;
  deadlineAt?: string;
  signal?: AbortSignal;
  captureOrderedEvents?: boolean;
};

const maxDurationMs = 180_000;
const deadlineMessage = "The live benchmark deadline expired.";

const setupFailureByPhase = {
  acquiring_sandbox: "sandbox_unavailable",
  restoring_inputs: "replay_unavailable",
  sealing_network: "sandbox_binding_unavailable",
} as const;

type QualifiedTrialFailure =
  | (typeof setupFailureByPhase)[keyof typeof setupFailureByPhase]
  | "cli_pin_mismatch"
  | "replay_prompt_unavailable"
  | "inference_relay_unavailable"
  | "candidate_failed"
  | "provider_receipt_unavailable"
  | "checkpoint_unavailable";

function outcome(jobId: string, result: "idle" | "success" | "error", runId: string | null) {
  return { jobId, result, runId, processed: true };
}

export async function runBenchmarkTrial(input: BenchmarkJob) {
  const { admin, job, signal } = input;
  const query = admin
    .from("factory_benchmark_trials")
    .select("runner_revision")
    .eq("job_id", job.id)
    .eq("workspace_id", job.workspace_id)
    .eq("session_id", job.session_id);
  const { data, error } = await (signal ? query.abortSignal(signal) : query).maybeSingle();
  signal?.throwIfAborted();
  if (error || !data) throw new Error("The captured benchmark runner is unavailable.");
  switch (data.runner_revision) {
    case "recorded-fixture-v1":
      return runRecordedBenchmarkTrial(input);
    case QUALIFIED_BENCHMARK_RUNNER:
      return runQualifiedBenchmarkTrial(input);
    default:
      throw new Error("The captured benchmark runner is unsupported.");
  }
}

export async function runQualifiedBenchmarkTrial(input: BenchmarkJob) {
  const { admin, job, workerRuntime } = input;
  input.signal?.throwIfAborted();
  const deadlineAt = input.deadlineAt ?? new Date(Date.now() + maxDurationMs).toISOString();
  const remaining = Date.parse(deadlineAt) - Date.now();
  if (!Number.isFinite(remaining)) throw new Error("The live benchmark deadline is invalid.");
  if (remaining <= 0) throw new WorkerAttemptDeadlineError(deadlineMessage);
  const startupDeadlineMs = Date.now() + Math.min(remaining, maxDurationMs);
  using startupBudget = createWorkerAttemptDeadline(
    Math.min(remaining, maxDurationMs),
    deadlineMessage,
  );
  const startup = input.signal
    ? AbortSignal.any([input.signal, startupBudget.signal])
    : startupBudget.signal;
  const start = await observeUntilAbort(startup, async () =>
    admin
      .rpc("start_factory_benchmark_live_trial", {
        p_job_id: job.id,
        p_attempt_count: job.attempt_count,
        p_deadline_at: deadlineAt,
        p_worker_runtime: workerRuntime,
      })
      .abortSignal(startup),
  );
  if (start.error) throw new Error("The captured live benchmark could not start.");
  if (start.data === null) return outcome(job.id, "idle", null);
  const claim = qualifiedTrialClaimSchema.safeParse(start.data);
  if (!claim.success) throw new Error("The live benchmark start returned an invalid claim.");
  const trial = claim.data;
  const { identity, candidate } = trial;
  if (
    identity.jobId !== job.id ||
    identity.workspaceId !== job.workspace_id ||
    identity.sessionId !== job.session_id ||
    identity.attemptCount !== job.attempt_count ||
    trial.workerRuntime !== workerRuntime
  )
    throw new Error("The live benchmark claim does not match this worker.");
  const attemptRemaining = Date.parse(trial.deadlineAt) - Date.now();
  if (attemptRemaining <= 0) throw new WorkerAttemptDeadlineError(deadlineMessage);
  const evidenceDeadlineMs = Math.min(startupDeadlineMs, Date.parse(trial.deadlineAt));
  using attemptDeadline = createWorkerAttemptDeadline(
    Math.min(attemptRemaining, maxDurationMs),
    deadlineMessage,
  );
  const signal = AbortSignal.any([startup, attemptDeadline.signal]);
  const scope = qualifiedTrialRpcIdentity(identity);

  let failure: QualifiedTrialFailure = "sandbox_unavailable";
  const result = await observeUntilAbort(signal, async () => {
    try {
      const { connection } = await loadRequiredWorkspaceSandboxConnection(
        admin,
        identity.workspaceId,
        "vercel",
      );
      signal.throwIfAborted();
      if (
        connection.provider !== "vercel" ||
        connection.revision !== trial.sandboxConnectionRevision
      )
        throw new Error("The pinned live sandbox connection is unavailable.");
      failure = "inference_relay_unavailable";
      const proxyUrl = benchmarkRelayUrl();
      failure = "replay_unavailable";
      const staged = await withQualifiedBenchmarkReplay(
        {
          principal: {
            admin,
            workspaceId: identity.workspaceId,
            actorUserId: identity.actorUserId,
          },
          factoryId: identity.factoryId,
          taskRevisionId: trial.taskRevisionId,
          executionId: identity.trialId,
          policyRevisionId: trial.policyRevisionId,
          expectedPolicyDigest: trial.policyDigest,
          connection,
          signal,
          candidate: {
            harness: candidate.harness,
            model: candidate.nativeModel,
            definitionDigest: candidate.definitionDigest,
          },
          profile: { image: candidate.toolchain.image, proxyUrl },
          onSetupPhase(phase) {
            failure = setupFailureByPhase[phase];
          },
          async onSandboxCreated({ sandboxId }) {
            const attached = await admin
              .from("agent_runs")
              .update({
                sandbox_id: sandboxId,
                sandbox_provider: "vercel",
                sandbox_connection_revision: connection.revision,
                sandbox_vercel_team_id: connection.credentials.teamId,
                sandbox_vercel_project_id: connection.credentials.projectId,
              })
              .eq("id", identity.runId)
              .eq("agent_job_id", identity.jobId)
              .eq("attempt_count", identity.attemptCount)
              .eq("workspace_id", identity.workspaceId)
              .eq("session_id", identity.sessionId)
              .eq("status", "running")
              .select("id")
              .abortSignal(signal)
              .maybeSingle();
            if (attached.error || attached.data?.id !== identity.runId)
              throw new Error("The live benchmark no longer owns this sandbox.");
          },
        },
        async ({ sandbox, signal, snapshot, plan, repositoryFullName, baseBranch }) => {
          failure = "cli_pin_mismatch";
          const executablePath = await verifyQualifiedCli(sandbox, trial, signal);
          failure = "sandbox_binding_unavailable";
          const signedSandboxId = await bindQualifiedSandbox({
            admin,
            sandbox,
            identity,
            deadlineAt: trial.deadlineAt,
            signal,
          });
          failure = "replay_prompt_unavailable";
          const { prompt, promptSha256, effort } = await renderQualifiedReplayPrompt({
            admin,
            trial,
            plan,
            repositoryFullName,
            baseBranch,
            signal,
          });
          failure = "inference_relay_unavailable";
          const ready = await admin
            .rpc("enable_factory_benchmark_live_inference", {
              ...scope,
              p_signed_sandbox_id: signedSandboxId,
              p_replay_prompt_sha256: promptSha256,
              p_input_bundle_sha256: snapshot.inputBundleSha256,
              p_restoration_receipt_sha256: snapshot.restorationReceiptSha256,
            })
            .abortSignal(signal);
          if (ready.error || ready.data !== true)
            throw new Error("The qualified inference relay is unavailable.");
          signal.throwIfAborted();

          failure = "candidate_failed";
          const runner = benchmarkRunner(candidate, executablePath, effort);
          const sensitiveValues = benchmarkEvidenceSensitiveValues(prompt);
          sensitiveValues?.push(BENCHMARK_REPLAY_API_PLACEHOLDER);
          const transcript =
            input.captureOrderedEvents !== false && sensitiveValues
              ? new BenchmarkTrialTranscript()
              : undefined;
          let artifactMarkdown: string;
          let receipt: ReturnType<typeof qualifiedInferenceReceiptSchema.parse> | undefined;
          try {
            artifactMarkdown = await collectQualifiedArtifact({
              sandbox,
              identity,
              signal,
              runner,
              prompt,
              transcript,
            });
          } finally {
            const [closed] = await Promise.all([
              Promise.resolve(
                admin
                  .rpc("close_factory_benchmark_live_inference", scope)
                  .abortSignal(AbortSignal.timeout(5000)),
              ).catch(() => null),
              transcript?.persist({
                admin,
                identity,
                adapter: runner.provider,
                sensitiveValues,
                signal,
                deadlineMs: evidenceDeadlineMs,
              }),
            ]);
            const parsed = qualifiedInferenceReceiptSchema.safeParse(closed?.data);
            if (
              closed &&
              !closed.error &&
              parsed.success &&
              parsed.data.observedModel === candidate.upstreamModel
            )
              receipt = parsed.data;
          }
          signal.throwIfAborted();
          failure = "provider_receipt_unavailable";
          if (!receipt) throw new Error("The exact provider receipt is unavailable.");

          failure = "checkpoint_unavailable";
          const local = checkpointSandbox(sandbox);
          const checkpoint = await captureSourceCheckpoint({
            sandbox: local,
            signal,
            baseSha: snapshot.checkoutSha,
            sensitiveValues: [prompt, BENCHMARK_REPLAY_API_PLACEHOLDER],
          });
          if (checkpoint.kind !== "bundle")
            throw new Error("The qualified replay requires a source change.");
          const source = await readValidationIdentity(local, signal);
          if (
            !source.clean ||
            source.commitSha !== checkpoint.headSha ||
            source.treeSha === snapshot.treeSha
          )
            throw new Error("The private checkpoint does not match the replay output.");

          const path = `${identity.workspaceId}/benchmark/${identity.trialId}/${identity.runId}/${checkpoint.sha256}.bundle`;
          const upload = await uploadWorkspaceObject(admin, {
            bucket: SOURCE_CHECKPOINT_BUCKET,
            bytes: checkpoint.bytes,
            contentType: "application/octet-stream",
            deferTransfer: true,
            signal,
            path,
            workspaceId: identity.workspaceId,
          });
          signal.throwIfAborted();
          if (upload.error || !upload.operationId)
            throw new Error("The private replay checkpoint could not be stored.");
          const diff = await readPrivateBenchmarkDiff({
            sandbox: local,
            signal,
            deadlineMs: evidenceDeadlineMs,
            commits: {
              input: { commitSha: snapshot.checkoutSha, treeSha: snapshot.treeSha },
              output: source,
            },
            sensitiveValues,
          });
          await stagePrivateBenchmarkDiff(admin, scope, diff, signal, evidenceDeadlineMs);
          signal.throwIfAborted();
          const completed = qualifiedTrialResultSchema.parse({
            input: {
              restorationReceiptSha256: snapshot.restorationReceiptSha256,
              inputBundleSha256: snapshot.inputBundleSha256,
              commitSha: snapshot.checkoutSha,
              treeSha: snapshot.treeSha,
              replayPromptSha256: promptSha256,
              rendererRevision: QUALIFIED_PROMPT_RENDERER_VERSION,
            },
            output: {
              artifactMarkdown,
              commitSha: source.commitSha,
              treeSha: source.treeSha,
              validation: {
                version: 1,
                key: "qualified-replay-source",
                status: "passed",
                commitSha: source.commitSha,
                treeSha: source.treeSha,
              },
              checkpoint: {
                kind: "bundle",
                sha256: checkpoint.sha256,
                storagePath: path,
                uploadOperationId: upload.operationId,
              },
            },
            inferenceReceiptId: receipt.inferenceReceiptId,
          });
          failure = "sandbox_unavailable";
          return completed;
        },
      );
      return staged;
    } catch {
      signal.throwIfAborted();
      return null;
    }
  });

  if (!result) {
    const failed = await observeUntilAbort(signal, async () =>
      admin
        .rpc("fail_factory_benchmark_trial", { ...scope, p_failure_code: failure })
        .abortSignal(signal),
    );
    if (failed.error) throw new Error("The live benchmark failure could not be recorded.");
    return outcome(job.id, failed.data ? "error" : "idle", identity.runId);
  }
  const finished = await observeUntilAbort(signal, async () =>
    admin
      .rpc("finish_factory_benchmark_live_trial", { ...scope, p_result: result })
      .abortSignal(signal),
  );
  if (finished.error) throw new Error("The exact live benchmark result could not be recorded.");
  return outcome(job.id, finished.data ? "success" : "idle", identity.runId);
}

function benchmarkRelayUrl() {
  const origin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "");
  if (origin.protocol !== "https:" || origin.username || origin.password)
    throw new Error("A trusted benchmark relay origin is required.");
  return new URL("/api/internal/benchmark-openai", origin).href;
}

async function verifyQualifiedCli(
  sandbox: SandboxHandle,
  trial: QualifiedTrialClaim,
  signal: AbortSignal,
) {
  const { harness, toolchain } = trial.candidate;
  const command = await sandbox.exec(
    "sh",
    [
      "-c",
      'set -eu; executable=$(readlink -f "$(command -v "$1")"); printf "%s\\n" "$executable"; sha256sum "$executable"; "$executable" --version',
      "wallie-cli-proof",
      harness,
    ],
    { cwd: "/tmp", signal },
  );
  const [status, { stdout }] = await Promise.all([command.exitCode, command.output()]);
  const [executablePath, digestLine, versionLine] = stdout.trim().split("\n");
  const expectedVersion =
    harness === "codex" ? `codex-cli ${toolchain.cliVersion}` : toolchain.cliVersion;
  if (
    status !== 0 ||
    !executablePath ||
    !/^\/[A-Za-z0-9._@/+:-]+$/.test(executablePath) ||
    executablePath.startsWith(`${sandbox.repoPath}/`) ||
    executablePath.startsWith("/tmp/") ||
    digestLine?.split(/\s+/)[0] !== toolchain.cliDigest ||
    versionLine !== expectedVersion
  )
    throw new Error("The installed benchmark CLI does not match its qualification.");
  return executablePath;
}

function benchmarkRunner(
  candidate: QualifiedTrialClaim["candidate"],
  executablePath: string,
  effort?: AgentEffort,
) {
  return candidate.harness === "codex"
    ? createAgentRunner("codex", {
        codex: { isolatedBenchmark: true, executablePath, model: candidate.nativeModel, effort },
      })
    : createAgentRunner("opencode", {
        openCode: { isolatedBenchmark: true, executablePath, model: candidate.nativeModel },
      });
}

async function collectQualifiedArtifact(input: {
  sandbox: SandboxHandle;
  identity: QualifiedTrialClaim["identity"];
  runner: AgentRunner;
  prompt: string;
  signal: AbortSignal;
  transcript?: BenchmarkTrialTranscript;
}) {
  const { sandbox, identity, runner, prompt, signal } = input;
  for await (const event of runner.start({
    sandbox,
    sessionId: identity.sessionId,
    runId: identity.runId,
    prompt,
    signal,
    secrets: [BENCHMARK_REPLAY_API_PLACEHOLDER],
  })) {
    signal.throwIfAborted();
    input.transcript?.record(event);
    if (event.type === "error") break;
    if (event.type === "completion" && event.taskComplete && event.finalOutput?.trim()) {
      if (Buffer.byteLength(event.finalOutput, "utf8") > 256 * 1024) break;
      return event.finalOutput;
    }
  }
  throw new Error("The benchmark agent did not return a complete private artifact.");
}

const gitEnvironment: Readonly<Record<string, string>> = {
  ...WALLIE_GIT_IDENTITY_ENV,
  GIT_NO_REPLACE_OBJECTS: "1",
};

function checkpointSandbox(
  sandbox: SandboxHandle,
): Pick<SandboxHandle, "exec" | "repoPath" | "writeFile"> {
  return {
    repoPath: sandbox.repoPath,
    writeFile: sandbox.writeFile.bind(sandbox),
    exec(cmd, args, { env, ...options } = {}) {
      if (!env) return sandbox.exec(cmd, args, options);
      const variables = Object.entries(env).map(([key, value]) => {
        if (!Object.hasOwn(gitEnvironment, key) || gitEnvironment[key] !== value)
          throw new Error("The local checkpoint requested an unsupported environment option.");
        return `${key}=${value}`;
      });
      return sandbox.exec("env", [...variables, cmd, ...args], options);
    },
  };
}
