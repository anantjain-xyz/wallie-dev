import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkerAttemptDeadlineError } from "@/lib/pipeline/worker-attempt-deadline";
import { loadRequiredWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";
import type { SandboxConnection } from "@/lib/sandbox/types";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { uploadWorkspaceObject } from "@/lib/workspaces/resource-operations";

import { replaySha256 } from "./replay-contracts";
import { withIsolatedBenchmarkReplay } from "./replay-sandbox";
import { RecordedTrialFixtureError, runRecordedTrialFixture } from "./trial-fixture";
import { runRecordedBenchmarkTrial } from "./trial-runner";

vi.mock("@/lib/sandbox-connections/server", () => ({
  loadRequiredWorkspaceSandboxConnection: vi.fn(),
}));
vi.mock("@/lib/workspaces/resource-operations", () => ({ uploadWorkspaceObject: vi.fn() }));
vi.mock("./replay-sandbox", () => ({ withIsolatedBenchmarkReplay: vi.fn() }));
vi.mock("./trial-fixture", async (original) => ({
  ...(await original<typeof import("./trial-fixture")>()),
  runRecordedTrialFixture: vi.fn(),
}));

const id = (part: number) => `61600000-0000-4000-8000-${String(part).padStart(12, "0")}`;
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const treeSha = "c".repeat(40);
const receiptSha = "d".repeat(64);
const bundleSha = "e".repeat(64);
const outputSha = "f".repeat(64);
const bytes = Buffer.from("a retained fixture checkpoint");
const checkpointSha = replaySha256(bytes);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const connection = {
  provider: "vercel",
  revision: id(11),
  credentials: { projectId: "test-project", teamId: "test-team", token: "test-token" },
} satisfies SandboxConnection;
const trial = {
  id: id(1),
  workspace_id: id(2),
  factory_id: id(3),
  actor_user_id: id(4),
  task_revision_id: id(5),
  policy_revision_id: id(6),
  policy_digest: "1".repeat(64),
  fixture_key: "2".repeat(64),
  runner_revision: "recorded-fixture-v1",
  sandbox_connection_revision: connection.revision,
  session_id: id(7),
  job_id: id(8),
  run_id: id(9),
  replay_execution_id: id(1),
  attempt_count: 1,
  deadline_at: new Date(Date.now() + 360_000).toISOString(),
};
const job = {
  id: trial.job_id,
  workspace_id: trial.workspace_id,
  session_id: trial.session_id,
  attempt_count: 1,
} as Tables<"agent_jobs">;
const operationId = id(10);
const fixture = {
  version: 1,
  operation: "count_utf8_lines",
  promptSha256: "3".repeat(64),
  checkoutSha: baseSha,
  sourcePath: "README.md",
  expectedLineCount: 4,
};

function db({
  staleStart = false,
  staleFinish = false,
  budgetMs,
}: { staleStart?: boolean; staleFinish?: boolean; budgetMs?: number } = {}) {
  const calls: { path: string; body: unknown }[] = [];
  const admin = createClient<Database>("https://db.example.test", "local-fixture", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const path = url.pathname.split("/").at(-1) ?? "";
        calls.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
        switch (path) {
          case "start_factory_benchmark_trial":
            return Response.json(
              staleStart
                ? null
                : {
                    ...trial,
                    ...(budgetMs === undefined
                      ? {}
                      : { deadline_at: new Date(Date.now() + budgetMs).toISOString() }),
                  },
            );
          case "agent_runs":
            return Response.json({ id: trial.run_id });
          case "finish_factory_benchmark_trial":
            return Response.json(!staleFinish);
          case "fail_factory_benchmark_trial":
            return Response.json(true);
          default:
            throw new Error("Unexpected database request");
        }
      },
    },
  });
  return { admin, calls };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadRequiredWorkspaceSandboxConnection).mockResolvedValue({
    connection,
    provider: "vercel",
  });
  vi.mocked(withIsolatedBenchmarkReplay).mockImplementation(async (input, inspect) => {
    await input.onSandboxCreated?.({ sandboxId: "isolated-test", provider: "vercel" });
    return inspect({
      sandbox: {
        id: "isolated-test",
        repoPath: "/checkout",
        exec: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
      },
      signal: input.signal,
      inputPath: "/tmp/private.json",
      snapshot: {
        version: 1,
        taskRevisionId: trial.task_revision_id,
        sourceRunId: id(13),
        definitionRevisionId: id(14),
        definitionDigest: "4".repeat(64),
        contextManifestSha256: "5".repeat(64),
        checkoutSha: baseSha,
        treeSha,
        inputBundleSha256: bundleSha,
        restorationReceiptSha256: receiptSha,
        limits: [],
        candidateChanges: [],
      },
      readContext: [],
      broker: {
        permit: {
          version: 1,
          profile: "recorded_fixtures",
          executionId: trial.replay_execution_id,
          workspaceId: trial.workspace_id,
          factoryId: trial.factory_id,
          taskRevisionId: trial.task_revision_id,
          policyRevisionId: trial.policy_revision_id,
          policyDigest: trial.policy_digest,
          restorationReceiptSha256: receiptSha,
        },
        invoke: async (request) => {
          expect(request).toEqual({ operation: "tool_read", fixtureKey: trial.fixture_key });
          return {
            receipt: {
              version: 1,
              decision: "stubbed",
              reason: "fixture_matched",
              operation: "tool_read",
              operationId,
              executionId: trial.replay_execution_id,
              policyRevisionId: trial.policy_revision_id,
              policyDigest: trial.policy_digest,
              fixtureRevisionId: id(14),
              fixtureResponseSha256: replaySha256(JSON.stringify(fixture)),
            },
            response: JSON.stringify(fixture),
          };
        },
      },
    });
  });
  vi.mocked(runRecordedTrialFixture).mockResolvedValue({
    checkpoint: { kind: "bundle", baseSha, headSha, sha256: checkpointSha, bytes },
    artifactMarkdown: "Counted 4 lines in `README.md`.",
    validation: {
      version: 1,
      key: "recorded-fixture-output",
      status: "passed",
      commitSha: headSha,
      treeSha,
      outputSha256: outputSha,
    },
  });
  vi.mocked(uploadWorkspaceObject).mockResolvedValue({
    data: { id: "receipt", path: "path", fullPath: "full" },
    error: null,
    operationId: id(15),
  });
});

describe("benchmark worker execution contract", () => {
  it("attaches the sandbox and adopts the private checkpoint for the exact captured attempt", async () => {
    const { admin, calls } = db();
    await expect(
      runRecordedBenchmarkTrial({ admin, job, workerRuntime: "workerd" }),
    ).resolves.toMatchObject({ result: "success", runId: trial.run_id });
    const path = `${trial.workspace_id}/benchmark/${trial.id}/${trial.run_id}/${checkpointSha}.bundle`;
    expect(uploadWorkspaceObject).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ deferTransfer: true, bytes, path }),
    );
    expect(calls.map(({ path }) => path)).toEqual([
      "start_factory_benchmark_trial",
      "agent_runs",
      "finish_factory_benchmark_trial",
    ]);
    expect(calls.at(-1)?.body).toMatchObject({
      p_trial_id: trial.id,
      p_job_id: job.id,
      p_attempt_count: 1,
      p_run_id: trial.run_id,
      p_result: {
        restorationReceiptSha256: receiptSha,
        inputBundleSha256: bundleSha,
        inputCommitSha: baseSha,
        inputTreeSha: treeSha,
        outputCommitSha: headSha,
        outputTreeSha: treeSha,
        fixtureOperationId: operationId,
        checkpointStoragePath: path,
        checkpointBundleSha256: checkpointSha,
        checkpointUploadOperationId: id(15),
        runtime: "workerd",
      },
    });
  });

  it("records a bounded validation failure without uploading or publishing a checkpoint", async () => {
    const { admin, calls } = db();
    vi.mocked(runRecordedTrialFixture).mockRejectedValue(
      new RecordedTrialFixtureError("validation_failed"),
    );
    await expect(runRecordedBenchmarkTrial({ admin, job })).resolves.toMatchObject({
      result: "error",
    });
    expect(calls.at(-1)?.body).toMatchObject({
      p_run_id: trial.run_id,
      p_failure_code: "validation_failed",
    });
    expect(uploadWorkspaceObject).not.toHaveBeenCalled();
  });

  it("ignores stale starts and rejects stale completion at the exact database fence", async () => {
    const start = db({ staleStart: true });
    await expect(runRecordedBenchmarkTrial({ admin: start.admin, job })).resolves.toMatchObject({
      result: "idle",
      runId: null,
    });
    expect(withIsolatedBenchmarkReplay).not.toHaveBeenCalled();
    const finish = db({ staleFinish: true });
    await expect(runRecordedBenchmarkTrial({ admin: finish.admin, job })).resolves.toMatchObject({
      result: "idle",
    });
    expect(finish.calls.map(({ path }) => path)).toEqual([
      "start_factory_benchmark_trial",
      "agent_runs",
      "finish_factory_benchmark_trial",
    ]);
  });

  it("does not upload late candidate output after the owning attempt aborts", async () => {
    const { admin, calls } = db();
    const controller = new AbortController();
    const cancel = new Error("Attempt canceled");
    const result = vi.mocked(runRecordedTrialFixture).getMockImplementation();
    vi.mocked(runRecordedTrialFixture).mockImplementationOnce(async (input) => {
      const output = await result!(input);
      controller.abort(cancel);
      return output;
    });
    await expect(runRecordedBenchmarkTrial({ admin, job, signal: controller.signal })).rejects.toBe(
      cancel,
    );
    expect(uploadWorkspaceObject).not.toHaveBeenCalled();
    expect(calls.at(-1)?.path).toBe("agent_runs");
  });

  it("aborts candidate work at the earlier database deadline and discards late output", async () => {
    const { admin, calls } = db({ budgetMs: 1000 });
    const worker = new AbortController();
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const candidate = vi.mocked(runRecordedTrialFixture).getMockImplementation()!;
    const releaseProvider = deferred();
    const sentLateOutput = deferred();
    vi.mocked(runRecordedTrialFixture).mockImplementationOnce(async (input) => {
      const output = await candidate(input);
      await releaseProvider.promise;
      expect(input.signal.reason).toBeInstanceOf(WorkerAttemptDeadlineError);
      sentLateOutput.resolve();
      return output;
    });

    const terminal = runRecordedBenchmarkTrial({
      admin,
      job,
      signal: worker.signal,
      deadlineAt,
    }).catch((error: unknown) => error);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(
        await Promise.race([
          terminal,
          new Promise((resolve) => {
            watchdog = setTimeout(() => resolve("The worker still owns canceled work"), 3000);
          }),
        ]),
      ).toBeInstanceOf(WorkerAttemptDeadlineError);
    } finally {
      clearTimeout(watchdog);
      releaseProvider.resolve();
      await terminal;
    }
    await sentLateOutput.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.signal.aborted).toBe(false);
    expect(runRecordedTrialFixture).toHaveBeenCalledOnce();
    expect(uploadWorkspaceObject).not.toHaveBeenCalled();
    expect(calls).toEqual([
      {
        path: "start_factory_benchmark_trial",
        body: { p_job_id: job.id, p_attempt_count: 1, p_deadline_at: deadlineAt },
      },
      { path: "agent_runs", body: expect.anything() },
    ]);
  });
});
