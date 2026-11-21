import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { AttemptWorkerRuntime } from "@/lib/pipeline/attempt-manifest";
import { SOURCE_CHECKPOINT_BUCKET } from "@/lib/pipeline/source-checkpoint";
import { loadRequiredWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { uploadWorkspaceObject } from "@/lib/workspaces/resource-operations";

import { replayDigestSchema } from "./replay-contracts";
import { withIsolatedBenchmarkReplay } from "./replay-sandbox";
import {
  RECORDED_FIXTURE_RUNNER,
  RecordedTrialFixtureError,
  recordedTrialFixtureSchema,
  runRecordedTrialFixture,
} from "./trial-fixture";

type TrialFailure =
  | "sandbox_unavailable"
  | "replay_unavailable"
  | "fixture_unavailable"
  | RecordedTrialFixtureError["code"];

const uuid = z.string().uuid();
const startedTrialSchema = z.object({
  id: uuid,
  workspace_id: uuid,
  factory_id: uuid,
  actor_user_id: uuid,
  task_revision_id: uuid,
  policy_revision_id: uuid,
  policy_digest: replayDigestSchema,
  fixture_key: replayDigestSchema,
  runner_revision: z.literal(RECORDED_FIXTURE_RUNNER),
  sandbox_connection_revision: uuid,
  session_id: uuid,
  job_id: uuid,
  run_id: uuid,
  replay_execution_id: uuid,
  attempt_count: z.number().int().positive(),
  deadline_at: z.string(),
});

/** Execute the one supported offline adapter against the captured worker attempt. */
export async function runRecordedBenchmarkTrial({
  admin,
  job,
  signal: workerSignal,
  deadlineAt,
  workerRuntime = "node",
}: {
  admin: SupabaseClient<Database>;
  job: Tables<"agent_jobs">;
  signal?: AbortSignal;
  deadlineAt?: string;
  workerRuntime?: AttemptWorkerRuntime;
}) {
  const deadline = deadlineAt ? Date.parse(deadlineAt) - Date.now() : 180_000;
  if (!Number.isFinite(deadline) || deadline <= 0)
    throw new Error("Benchmark attempt deadline expired.");
  const budget = AbortSignal.timeout(Math.min(deadline, 180_000));
  const startupSignal = workerSignal ? AbortSignal.any([workerSignal, budget]) : budget;
  const { id: jobId, attempt_count: attemptCount } = job;
  const outcome = (result: "idle" | "error" | "success", runId: string | null) => ({
    jobId,
    processed: true,
    result,
    runId,
  });

  startupSignal.throwIfAborted();
  const started = await admin
    .rpc("start_factory_benchmark_trial", {
      p_job_id: jobId,
      p_attempt_count: attemptCount,
      ...(deadlineAt ? { p_deadline_at: deadlineAt } : {}),
    })
    .abortSignal(startupSignal);
  startupSignal.throwIfAborted();
  if (started.error) throw new Error("The captured benchmark attempt could not start.");
  if (!started.data?.id) return outcome("idle", null);
  const parsed = startedTrialSchema.safeParse(started.data);
  if (!parsed.success) throw new Error("The captured benchmark attempt is unavailable.");
  const trial = parsed.data;
  if (
    trial.job_id !== jobId ||
    trial.workspace_id !== job.workspace_id ||
    trial.session_id !== job.session_id ||
    trial.attempt_count !== attemptCount
  ) {
    throw new Error("The captured benchmark attempt changed.");
  }
  const remaining = Date.parse(trial.deadline_at) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0)
    throw new Error("Benchmark attempt deadline expired.");
  const signal = AbortSignal.any([
    startupSignal,
    AbortSignal.timeout(Math.min(remaining, 180_000)),
  ]);
  const identity = {
    p_trial_id: trial.id,
    p_job_id: jobId,
    p_attempt_count: attemptCount,
    p_run_id: trial.run_id,
  };

  let failure: TrialFailure = "sandbox_unavailable";
  const staged = await (async () => {
    try {
      const { connection } = await loadRequiredWorkspaceSandboxConnection(
        admin,
        trial.workspace_id,
        "vercel",
      );
      signal.throwIfAborted();
      if (
        connection.provider !== "vercel" ||
        connection.revision !== trial.sandbox_connection_revision
      ) {
        throw new Error("The pinned benchmark sandbox revision is unavailable.");
      }
      failure = "replay_unavailable";
      const result = await withIsolatedBenchmarkReplay(
        {
          principal: { admin, workspaceId: trial.workspace_id, actorUserId: trial.actor_user_id },
          factoryId: trial.factory_id,
          taskRevisionId: trial.task_revision_id,
          executionId: trial.replay_execution_id,
          policyRevisionId: trial.policy_revision_id,
          expectedPolicyDigest: trial.policy_digest,
          connection,
          signal,
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
              .eq("id", trial.run_id)
              .eq("agent_job_id", jobId)
              .eq("attempt_count", attemptCount)
              .eq("workspace_id", trial.workspace_id)
              .eq("session_id", trial.session_id)
              .eq("status", "running")
              .select("id")
              .abortSignal(signal)
              .maybeSingle();
            if (attached.error || attached.data?.id !== trial.run_id) {
              throw new Error("The benchmark attempt no longer owns this sandbox.");
            }
          },
        },
        async ({ sandbox, signal: replaySignal, inputPath, snapshot, broker }) => {
          failure = "fixture_unavailable";
          if (
            broker.permit.profile !== "recorded_fixtures" &&
            broker.permit.profile !== "isolated_test"
          ) {
            throw new Error("The trial requires an approved recorded fixture.");
          }
          const read = await broker.invoke(
            { operation: "tool_read", fixtureKey: trial.fixture_key },
            { signal: replaySignal },
          );
          if (typeof read.response !== "string" || read.receipt.decision !== "stubbed") {
            throw new Error("The approved trial fixture is unavailable.");
          }
          const fixture = recordedTrialFixtureSchema.parse(JSON.parse(read.response));
          failure = "candidate_failed";
          const output = await runRecordedTrialFixture({
            sandbox,
            signal: replaySignal,
            inputPath,
            fixture,
            inputBundleSha256: snapshot.inputBundleSha256,
            inputCommitSha: snapshot.checkoutSha,
            inputTreeSha: snapshot.treeSha,
          });
          return { snapshot, fixtureOperationId: read.receipt.operationId, ...output };
        },
      );
      signal.throwIfAborted();
      failure = "checkpoint_unavailable";
      const { checkpoint, snapshot, fixtureOperationId, artifactMarkdown, validation } = result;
      const path = `${trial.workspace_id}/benchmark/${trial.id}/${trial.run_id}/${checkpoint.sha256}.bundle`;
      const upload = await uploadWorkspaceObject(admin, {
        bucket: SOURCE_CHECKPOINT_BUCKET,
        bytes: checkpoint.bytes,
        contentType: "application/octet-stream",
        deferTransfer: true,
        signal,
        path,
        workspaceId: trial.workspace_id,
      });
      signal.throwIfAborted();
      if (upload.error || !upload.operationId)
        throw new Error("The benchmark checkpoint could not be stored.");
      return {
        restorationReceiptSha256: snapshot.restorationReceiptSha256,
        inputBundleSha256: snapshot.inputBundleSha256,
        inputCommitSha: snapshot.checkoutSha,
        inputTreeSha: snapshot.treeSha,
        outputCommitSha: checkpoint.headSha,
        outputTreeSha: validation.treeSha,
        fixtureOperationId,
        artifactMarkdown,
        checkpointBundleSha256: checkpoint.sha256,
        checkpointStoragePath: path,
        checkpointUploadOperationId: upload.operationId,
        validation,
        runtime: workerRuntime,
      };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof RecordedTrialFixtureError) failure = error.code;
      return null;
    }
  })();

  signal.throwIfAborted();
  if (!staged) {
    const failed = await admin
      .rpc("fail_factory_benchmark_trial", {
        ...identity,
        p_failure_code: failure,
      })
      .abortSignal(signal);
    if (failed.error) throw new Error("The benchmark attempt failure could not be recorded.");
    return outcome(failed.data ? "error" : "idle", trial.run_id);
  }

  // The finish transaction adopts the reserved upload. A stale claim or lost
  // reply leaves its cleanup obligation intact until ownership is known.
  const finished = await admin
    .rpc("finish_factory_benchmark_trial", {
      ...identity,
      p_result: staged,
    })
    .abortSignal(signal);
  if (finished.error) throw new Error("The benchmark attempt result could not be recorded.");
  signal.throwIfAborted();
  return outcome(finished.data ? "success" : "idle", trial.run_id);
}
