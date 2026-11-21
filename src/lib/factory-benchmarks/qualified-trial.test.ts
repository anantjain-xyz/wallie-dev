import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureSourceCheckpoint } from "@/lib/pipeline/source-checkpoint";
import { WorkerAttemptDeadlineError } from "@/lib/pipeline/worker-attempt-deadline";
import { FakeSandbox } from "@/lib/sandbox/fake";
import { loadRequiredWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { readValidationIdentity } from "@/lib/validation-evidence/capture";
import { uploadWorkspaceObject } from "@/lib/workspaces/resource-operations";

import { renderQualifiedReplayPrompt } from "./qualified-prompt";
import type { QualifiedTrialClaim } from "./qualified-trial-contracts";
import { runQualifiedBenchmarkTrial } from "./qualified-trial";
import { replaySha256, type ReplayPlan } from "./replay-contracts";
import { withQualifiedBenchmarkReplay } from "./replay-sandbox";

vi.mock("@/lib/pipeline/source-checkpoint", async (original) => ({
  ...(await original<typeof import("@/lib/pipeline/source-checkpoint")>()),
  captureSourceCheckpoint: vi.fn(),
}));
vi.mock("@/lib/sandbox-connections/server", () => ({
  loadRequiredWorkspaceSandboxConnection: vi.fn(),
}));
vi.mock("@/lib/validation-evidence/capture", async (original) => ({
  ...(await original<typeof import("@/lib/validation-evidence/capture")>()),
  readValidationIdentity: vi.fn(),
}));
vi.mock("@/lib/workspaces/resource-operations", () => ({ uploadWorkspaceObject: vi.fn() }));
vi.mock("./qualified-prompt", () => ({ renderQualifiedReplayPrompt: vi.fn() }));
vi.mock("./replay-sandbox", () => ({ withQualifiedBenchmarkReplay: vi.fn() }));

const id = (number: number) => `73500000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const base = "a".repeat(40);
const head = "b".repeat(40);
const tree = "c".repeat(40);
const outputTree = "d".repeat(40);
const prompt = "Work only in the disposable benchmark checkout.";
const artifact = "Updated the local fixture.";
const upstreamModel = "gpt-4.1-2025-04-14";
const checkpoint = Buffer.from("private benchmark fixture");
const privateDiagnostic = "synthetic sensitive provider and replay context";

function fixture(
  harness: "codex" | "opencode",
  problem?:
    | "wrong-runtime"
    | "missing-source"
    | "sandbox-acquisition"
    | "bad-cli-pin"
    | "bad-seal"
    | "wrong-model"
    | "bad-network"
    | "prompt-rejected"
    | "permit-rejected"
    | "receipt-unavailable"
    | "checkpoint-failed"
    | "stale-start"
    | "invalid-start"
    | "canceled"
    | "oversize",
  deadlineOffsetMs = 60_000,
) {
  const sandbox = new FakeSandbox();
  const controller = new AbortController();
  const trial = {
    runnerRevision: "openai-responses-v1",
    identity: {
      trialId: id(1),
      jobId: id(2),
      runId: id(3),
      workspaceId: id(4),
      factoryId: id(5),
      sessionId: id(6),
      actorUserId: id(7),
      attemptCount: 1,
    },
    deadlineAt: new Date(Date.now() + deadlineOffsetMs).toISOString(),
    taskRevisionId: id(8),
    policyRevisionId: id(9),
    policyDigest: "a".repeat(64),
    workerRuntime: problem === "wrong-runtime" ? "node" : "workerd",
    sandboxConnectionRevision: id(10),
    inferenceConnectionRevision: id(11),
    candidate: {
      definitionRevisionId: id(12),
      definitionDigest: "b".repeat(64),
      effectiveExecutionDigest: "c".repeat(64),
      qualificationId: id(13),
      harness,
      upstreamModel,
      nativeModel: harness === "codex" ? upstreamModel : `openai/${upstreamModel}`,
      toolchain: {
        image: `vcr.vercel.com/vercel/sandbox/universal@sha256:${"d".repeat(64)}`,
        cliVersion: "1.2.3",
        cliDigest: "e".repeat(64),
      },
    },
  } satisfies QualifiedTrialClaim;
  const { identity, candidate } = trial;
  const job = {
    id: identity.jobId,
    session_id: identity.sessionId,
    workspace_id: identity.workspaceId,
    attempt_count: 1,
  } as Tables<"agent_jobs">;
  const requests: { name: string; body: Record<string, unknown> }[] = [];
  let nonceDigest: unknown;
  const response = vi.fn(async (url: string, init: RequestInit) => {
    const name = new URL(url).pathname.split("/").at(-1) ?? "";
    const body = JSON.parse(String(init.body));
    requests.push({ name, body });
    switch (name) {
      case "start_factory_benchmark_live_trial":
        if (problem === "invalid-start")
          return Response.json({ runnerRevision: privateDiagnostic });
        return Response.json(problem === "stale-start" ? null : trial);
      case "agent_runs":
        return Response.json({ id: identity.runId });
      case "arm_factory_benchmark_live_sandbox_binding":
        nonceDigest = body.p_nonce_sha256;
        return Response.json(true);
      case "read_factory_benchmark_live_sandbox_binding":
        return Response.json({ signedSandboxId: "attested-id" });
      case "enable_factory_benchmark_live_inference":
        return Response.json(problem !== "permit-rejected");
      case "close_factory_benchmark_live_inference":
        if (problem === "receipt-unavailable") {
          return Response.json({ code: "P0001", message: privateDiagnostic }, { status: 503 });
        }
        return Response.json({
          inferenceReceiptId: id(14),
          observedModel: problem === "wrong-model" ? "gpt-5-2025-08-07" : upstreamModel,
        });
      case "finish_factory_benchmark_live_trial":
      case "fail_factory_benchmark_trial":
        return Response.json(true);
      default:
        throw new Error(`Unexpected test RPC ${name}`);
    }
  });
  const admin = createClient<Database>("https://db.example.test", "test-735", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init) => response(String(url), init ?? {}) },
  });
  sandbox.scriptExec("wallie-cli-proof", [], {
    output: {
      stdout: `/opt/qualified/${harness}\n${problem === "bad-cli-pin" ? "d".repeat(64) : candidate.toolchain.cliDigest}  /opt/qualified/${harness}\n${harness === "codex" ? "codex-cli " : ""}1.2.3\n`,
      stderr: problem === "bad-cli-pin" ? privateDiagnostic : "",
    },
  });
  sandbox.scriptExec(
    (call) => call.args.includes("https://api.openai.com/.well-known/wallie-benchmark-bind"),
    (call) => {
      const nonceFile = call.args.at(-2) ?? "";
      const nonce = sandbox.files.get(nonceFile);
      expect(nonce?.mode).toBe(0o600);
      expect(replaySha256(nonce?.data ?? "")).toBe(nonceDigest);
      expect(call.args.join(" ")).not.toContain(nonce?.data.toString());
      sandbox.files.delete(nonceFile);
      return [];
    },
  );
  sandbox.scriptExec(
    (call) => call.args.some((arg) => arg.includes("https://api.openai.com/v1/files")),
    () => {
      if (problem === "canceled") controller.abort(new Error("Canceled after network proof"));
      return [];
    },
    { exitCode: problem === "bad-network" ? 1 : 0 },
  );
  sandbox.scriptExec("env", ({ args }) => {
    expect(requests.at(-1)).toMatchObject({
      name: "enable_factory_benchmark_live_inference",
      body: { p_signed_sandbox_id: "attested-id", p_replay_prompt_sha256: replaySha256(prompt) },
    });
    expect(args).toContain(candidate.nativeModel);
    expect(args).toContain(`/opt/qualified/${harness}`);
    expect([...sandbox.files.keys()].some((path) => path.includes("wallie-live-bind"))).toBe(false);
    if (harness === "codex") {
      const output = args[args.indexOf("--output-last-message") + 1];
      sandbox.files.set(output, {
        data: Buffer.from(problem === "oversize" ? "é".repeat(128 * 1024 + 1) : artifact),
      });
      return [
        {
          stream: "stdout",
          data: '{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":4}}\n',
        },
      ];
    }
    return [
      {
        stream: "stdout",
        data: [
          { type: "text", part: { id: "part", messageID: "final", text: artifact } },
          { type: "step_finish", part: { messageID: "final", reason: "stop" } },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
      },
    ];
  });

  vi.mocked(loadRequiredWorkspaceSandboxConnection).mockResolvedValue({
    provider: "vercel",
    connection: {
      provider: "vercel",
      revision: trial.sandboxConnectionRevision,
      credentials: { projectId: "test-project", teamId: "test-team", token: "test-vercel-token" },
    },
  });
  const snapshot = {
    version: 1 as const,
    taskRevisionId: trial.taskRevisionId,
    sourceRunId: id(15),
    definitionRevisionId: id(16),
    definitionDigest: "f".repeat(64),
    contextManifestSha256: "1".repeat(64),
    checkoutSha: base,
    treeSha: tree,
    inputBundleSha256: "2".repeat(64),
    restorationReceiptSha256: "3".repeat(64),
    limits: [],
    candidateChanges: [],
  };
  vi.mocked(withQualifiedBenchmarkReplay).mockImplementation(async (input, execute) => {
    if (problem === "missing-source") throw new Error(privateDiagnostic);
    input.onSetupPhase?.("acquiring_sandbox");
    if (problem === "sandbox-acquisition") throw new Error(privateDiagnostic);
    await input.onSandboxCreated?.({ provider: "vercel", sandboxId: sandbox.id });
    input.onSetupPhase?.("restoring_inputs");
    input.onSetupPhase?.("sealing_network");
    if (problem === "bad-seal") throw new Error(privateDiagnostic);
    input.onSetupPhase?.("restoring_inputs");
    return execute({
      sandbox,
      signal: input.signal,
      snapshot,
      plan: {} as ReplayPlan,
      repositoryFullName: "test/repo",
      baseBranch: "main",
    });
  });
  vi.mocked(renderQualifiedReplayPrompt).mockResolvedValue({
    prompt,
    promptSha256: replaySha256(prompt),
    effort: undefined,
  });
  if (problem === "prompt-rejected") {
    vi.mocked(renderQualifiedReplayPrompt).mockRejectedValueOnce(new Error(privateDiagnostic));
  }
  vi.mocked(captureSourceCheckpoint).mockResolvedValue({
    kind: "bundle",
    baseSha: base,
    headSha: head,
    sha256: replaySha256(checkpoint),
    bytes: checkpoint,
  });
  if (problem === "checkpoint-failed") {
    vi.mocked(captureSourceCheckpoint).mockRejectedValueOnce(new Error(privateDiagnostic));
  }
  vi.mocked(readValidationIdentity).mockResolvedValue({
    commitSha: head,
    treeSha: outputTree,
    clean: true,
  });
  vi.mocked(uploadWorkspaceObject).mockResolvedValue({
    error: null,
    operationId: id(17),
    data: { id: id(18), path: "checkpoint", fullPath: "session-source-checkpoints/checkpoint" },
  });
  return { admin, job, requests, sandbox, snapshot, signal: controller.signal };
}

describe("qualified live benchmark execution", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://wallie.test");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["codex", "opencode"] as const)(
    "fences sandbox and provider use before adopting a private %s result",
    async (harness) => {
      const { admin, job, requests, sandbox, snapshot } = fixture(harness);
      await expect(
        runQualifiedBenchmarkTrial({ admin, job, workerRuntime: "workerd" }),
      ).resolves.toMatchObject({ result: "success", runId: id(3) });
      expect(requests.map(({ name }) => name)).toEqual([
        "start_factory_benchmark_live_trial",
        "agent_runs",
        "arm_factory_benchmark_live_sandbox_binding",
        "read_factory_benchmark_live_sandbox_binding",
        "enable_factory_benchmark_live_inference",
        "close_factory_benchmark_live_inference",
        "finish_factory_benchmark_live_trial",
      ]);
      expect(requests.at(-1)?.body).toMatchObject({
        p_result: {
          input: {
            replayPromptSha256: replaySha256(prompt),
            inputBundleSha256: snapshot.inputBundleSha256,
          },
          output: {
            artifactMarkdown: artifact,
            commitSha: head,
            treeSha: outputTree,
            checkpoint: { kind: "bundle", uploadOperationId: id(17) },
          },
          inferenceReceiptId: id(14),
        },
      });
      expect(sandbox.calls.every(({ opts }) => opts.env === undefined)).toBe(true);
      expect(vi.mocked(uploadWorkspaceObject)).toHaveBeenCalledWith(
        admin,
        expect.objectContaining({
          path: `${id(4)}/benchmark/${id(1)}/${id(3)}/${replaySha256(checkpoint)}.bundle`,
          bytes: checkpoint,
        }),
      );
    },
  );

  it.each([
    ["missing-source", "replay_unavailable", false],
    ["sandbox-acquisition", "sandbox_unavailable", false],
    ["bad-cli-pin", "cli_pin_mismatch", false],
    ["bad-seal", "sandbox_binding_unavailable", false],
    ["bad-network", "sandbox_binding_unavailable", false],
    ["prompt-rejected", "replay_prompt_unavailable", false],
    ["permit-rejected", "inference_relay_unavailable", false],
    ["wrong-model", "provider_receipt_unavailable", true],
    ["receipt-unavailable", "provider_receipt_unavailable", true],
    ["oversize", "candidate_failed", true],
    ["checkpoint-failed", "checkpoint_unavailable", true],
  ] as const)(
    "records %s as the bounded %s code without adopting output",
    async (problem, failureCode, closedInference) => {
      const { admin, job, requests } = fixture("codex", problem);
      await expect(
        runQualifiedBenchmarkTrial({ admin, job, workerRuntime: "workerd" }),
      ).resolves.toMatchObject({ result: "error" });
      expect(requests.at(-1)).toEqual({
        name: "fail_factory_benchmark_trial",
        body: {
          p_trial_id: id(1),
          p_job_id: id(2),
          p_run_id: id(3),
          p_attempt_count: 1,
          p_failure_code: failureCode,
        },
      });
      expect(JSON.stringify(requests)).not.toContain(privateDiagnostic);
      expect(uploadWorkspaceObject).not.toHaveBeenCalled();
      expect(requests.some(({ name }) => name === "close_factory_benchmark_live_inference")).toBe(
        closedInference,
      );
    },
  );

  it("does not enable inference after cancellation during sandbox proof", async () => {
    const { admin, job, requests, sandbox, signal } = fixture("codex", "canceled");
    await expect(
      runQualifiedBenchmarkTrial({ admin, job, workerRuntime: "workerd", signal }),
    ).rejects.toThrow("Canceled after network proof");
    expect(requests.some(({ name }) => name === "enable_factory_benchmark_live_inference")).toBe(
      false,
    );
    expect(sandbox.calls.some(({ cmd }) => cmd === "env")).toBe(false);
    expect(uploadWorkspaceObject).not.toHaveBeenCalled();
  });

  it("propagates the owned deadline for a started live attempt while keeping its closed receipt", async () => {
    const { admin, job, requests, signal } = fixture("codex", undefined, 1_000);
    vi.mocked(captureSourceCheckpoint).mockImplementationOnce(() => new Promise(() => {}));
    await expect(
      runQualifiedBenchmarkTrial({ admin, job, workerRuntime: "workerd", signal }),
    ).rejects.toBeInstanceOf(WorkerAttemptDeadlineError);
    expect(captureSourceCheckpoint).toHaveBeenCalledOnce();
    expect(requests.at(-1)?.name).toBe("close_factory_benchmark_live_inference");
    expect(uploadWorkspaceObject).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(false);
  });

  it("never allocates a sandbox for a stale or wrong-runtime claim", async () => {
    const stale = fixture("opencode", "stale-start");
    await expect(
      runQualifiedBenchmarkTrial({ admin: stale.admin, job: stale.job, workerRuntime: "workerd" }),
    ).resolves.toMatchObject({ result: "idle" });
    const wrong = fixture("opencode", "wrong-runtime");
    await expect(
      runQualifiedBenchmarkTrial({ admin: wrong.admin, job: wrong.job, workerRuntime: "workerd" }),
    ).rejects.toThrow("does not match this worker");
    expect(withQualifiedBenchmarkReplay).not.toHaveBeenCalled();
  });

  it("rejects a malformed start claim using only a fixed diagnostic", async () => {
    const { admin, job, requests } = fixture("codex", "invalid-start");
    await expect(
      runQualifiedBenchmarkTrial({ admin, job, workerRuntime: "workerd" }),
    ).rejects.toThrow(/^The live benchmark start returned an invalid claim\.$/);
    expect(requests.map(({ name }) => name)).toEqual(["start_factory_benchmark_live_trial"]);
    expect(withQualifiedBenchmarkReplay).not.toHaveBeenCalled();
  });
});
