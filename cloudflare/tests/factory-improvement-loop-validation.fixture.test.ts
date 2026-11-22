import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";

import { env } from "cloudflare:workers";
import { it, vi } from "vitest";
import { z } from "zod";

import { verifyBenchmarkGitStart } from "@/lib/factory-benchmarks/capture-evidence";
import { runBenchmarkTrial } from "@/lib/factory-benchmarks/qualified-trial";
import { replaySha256 } from "@/lib/factory-benchmarks/replay-contracts";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import { drainFactoryJudges } from "@/lib/factory-evaluations/judge-worker";
import { untrustedPromptValue, verifyPromptBoundary } from "@/lib/pipeline/prompt-safety";
import { FakeSandbox } from "@/lib/sandbox/fake";
import type { SandboxExecOptions } from "@/lib/sandbox/types";
import { createVercelQualifiedBenchmarkReplaySandbox } from "@/lib/sandbox/vercel";

import {
  createQualificationClients,
  receipt,
  type QualificationAdmin,
} from "../../test/release/factory-benchmark-qualification";
import {
  improvementLoopFixtureCostUsd,
  improvementLoopFixtureJudge,
  improvementLoopFixtureToolchain,
  improvementLoopReplayWitness,
  type ImprovementLoopReplayWitness,
} from "../../test/release/factory-improvement-loop-replay-contract";

vi.mock("@/features/github/sandbox-token", () => ({
  mintSandboxRepositoryToken: async () => "synthetic-improvement-loop-repository-read-token",
}));
vi.mock("@/lib/sandbox/vercel", async (original) => ({
  ...(await original<typeof import("@/lib/sandbox/vercel")>()),
  createVercelQualifiedBenchmarkReplaySandbox: vi.fn(),
}));
vi.mock("@/lib/sandbox", async (original) => ({
  ...(await original<typeof import("@/lib/sandbox")>()),
  stopSandboxById: async () => {},
}));

const raw = (env as typeof env & { WALLIE_FACTORY_RUNTIME_FIXTURE?: string })
  .WALLIE_FACTORY_RUNTIME_FIXTURE;
const configured = z
  .object({ improvementLoopWitness: improvementLoopReplayWitness })
  .safeParse(raw ? JSON.parse(raw) : null);
const executablePath = "/opt/wallie-qualification/codex";
const syntheticMarker = "Fixture acceptance marker";
const baselineTemplate = "Implement {{session.prompt}}.";
const candidateTemplate = "Implement {{session.prompt}} and check the required acceptance marker.";
const requestId = z.object({ requestId: z.string().uuid() });

type ReplayTask = ImprovementLoopReplayWitness["tasks"][number];
type ReplayOutput = ReplayTask["outputs"][number];
type Trial = { id: string; job_id: string; run_id: string; attempt_count: number };

class QualificationSandbox extends FakeSandbox {
  constructor(
    private readonly setup: {
      admin: QualificationAdmin;
      task: ReplayTask;
      output: ReplayOutput;
      expectedStagePrompt: string;
      otherStagePrompt: string;
      trial: Trial;
      upstreamModel: string;
      teamId: string;
      projectId: string;
    },
  ) {
    super(`sbx_m10_${setup.trial.id.replaceAll("-", "")}`);
  }

  async sealBenchmarkInference() {
    assert(
      this.calls.some(
        ({ cmd, args }) => cmd === "git" && args.join(" ") === "remote remove origin",
      ),
    );
  }

  override async exec(cmd: string, args: string[], opts?: SandboxExecOptions) {
    const { admin, task, output, trial, upstreamModel, teamId, projectId } = this.setup;
    opts?.signal?.throwIfAborted();
    const [command, script] = args;

    if (cmd === "bash" && script?.includes("git check-ref-format")) {
      assert(script.includes(task.inputSha) && script.includes(task.inputRef));
    }
    if (cmd === "git" && args.join(" ") === "rev-parse HEAD HEAD^{tree}") {
      this.reply(cmd, `${task.inputSha}\n${task.inputTree}\n`);
    }
    if (cmd === "sha256sum") {
      const bytes = this.files.get(command)?.data;
      assert(bytes, "Restored task inputs must exist in the fixture sandbox.");
      this.reply(cmd, `${replaySha256(bytes)}  ${command}\n`);
    }
    if (cmd === "node" && command === "--version") this.reply(cmd, "v22.22.0\n");
    if (cmd === "sh" && args.includes("wallie-cli-proof")) {
      const { cliDigest, cliVersion } = improvementLoopFixtureToolchain.codex;
      this.reply(
        cmd,
        `${executablePath}\n${cliDigest}  ${executablePath}\ncodex-cli ${cliVersion}\n`,
      );
    }

    if (
      cmd === "node" &&
      args.at(-1) === "https://api.openai.com/.well-known/wallie-benchmark-bind"
    ) {
      const nonceFile = args.at(-2);
      assert(nonceFile);
      const nonce = this.files.get(nonceFile);
      assert.equal(nonce?.mode, 0o600);
      assert(nonce);
      this.files.delete(nonceFile);
      assert.equal(
        await receipt(
          admin.rpc("consume_factory_benchmark_live_sandbox_binding", {
            p_nonce_sha256: replaySha256(nonce.data),
            p_signed_sandbox_id: this.id,
            p_team_id: teamId,
            p_project_id: projectId,
          }),
        ),
        true,
      );
    }

    if (cmd === "env" && args.includes(executablePath)) {
      const promptFile = args[args.indexOf(executablePath) - 1];
      const artifactFile = args[args.indexOf("--output-last-message") + 1];
      const prompt = await this.readFile(promptFile);
      assert(prompt && artifactFile);
      const paragraphs = prompt.split("\n\n");
      assert(
        paragraphs.includes(this.setup.expectedStagePrompt) &&
          !paragraphs.includes(this.setup.otherStagePrompt),
        "The CLI input must contain the exact stage prompt for its frozen comparison arm.",
      );
      const request = requestId.parse(
        await receipt(
          admin.rpc("begin_factory_benchmark_inference_request", {
            p_team_id: teamId,
            p_project_id: projectId,
            p_signed_sandbox_id: this.id,
            p_request_digest: replaySha256(`${trial.id}:${prompt}`),
          }),
        ),
      );
      try {
        await wait(350, undefined, { signal: opts?.signal });
        opts?.signal?.throwIfAborted();
      } catch (error) {
        if (opts?.signal?.aborted) {
          const settlement = await admin
            .rpc("finish_factory_benchmark_inference_request", {
              p_request_id: request.requestId,
              p_status: "unavailable",
            })
            .abortSignal(AbortSignal.timeout(5_000));
          if (settlement.error || settlement.data !== true) {
            console.warn("Could not settle the cancelled fixture inference receipt.");
          }
        }
        throw error;
      }
      assert.equal(
        await receipt(
          admin.rpc("finish_factory_benchmark_inference_request", {
            p_request_id: request.requestId,
            p_status: "completed",
            p_observed_model: upstreamModel,
            p_input_tokens: 40,
            p_output_tokens: 12,
          }),
        ),
        true,
      );
      // Explicitly synthetic paid usage still crosses the exact-running-attempt receipt boundary.
      const [usage] = await receipt(
        admin.rpc("record_session_run_usage", {
          p_job_id: trial.job_id,
          p_run_id: trial.run_id,
          p_attempt_count: trial.attempt_count,
          p_input_tokens: 40,
          p_output_tokens: 12,
          p_token_provenance: "measured",
          p_cost_usd: improvementLoopFixtureCostUsd,
          p_cost_provenance: "measured",
        }),
      );
      assert.equal(usage?.accepted, true);
      const artifact = `${syntheticMarker}: ${output.pass ? "present" : "absent"}. The scripted qualification agent updated result.txt.`;
      await this.writeFile(artifactFile, artifact);
      const lines = [
        { type: "item.completed", item: { type: "agent_message", text: artifact } },
        { type: "turn.completed", usage: { input_tokens: 40, output_tokens: 12 } },
      ];
      this.scriptExec(cmd, [
        { stream: "stdout", data: lines.map((line) => JSON.stringify(line)).join("\n") + "\n" },
      ]);
    }

    if (cmd === "env" && args.some((arg) => arg.includes("Preserve Wallie stage source"))) {
      const size = Buffer.from(output.bundle, "base64").byteLength;
      this.reply(cmd, `BUNDLE\n${output.outputSha}\n${size}\n${output.bundle}\n`);
    }
    if (
      cmd === "env" &&
      args.some((arg) => arg.includes("JSON.stringify({commitSha,treeSha,clean})"))
    ) {
      this.reply(
        cmd,
        JSON.stringify({ commitSha: output.outputSha, treeSha: output.outputTree, clean: true }),
      );
    }
    if (
      cmd === "env" &&
      command === "-i" &&
      args.at(-7) === "node" &&
      args.at(-6) === "-e" &&
      args.at(-5)?.includes('"diff", "--patch", "--no-ext-diff"')
    ) {
      assert.deepEqual(args.slice(-4), [
        task.inputSha,
        task.inputTree,
        output.outputSha,
        output.outputTree,
      ]);
      this.reply(cmd, output.diff);
    }
    return super.exec(cmd, args, opts);
  }

  private reply(command: string, stdout: string) {
    this.scriptExec(command, [], { output: { stdout, stderr: "" } });
  }
}

function fixtureTransport(adminUrl: string, witness: ImprovementLoopReplayWitness) {
  const send = globalThis.fetch;
  const origin = new URL(adminUrl).origin;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === origin) return send(input, init);
    if (url.origin === "https://api.github.com") {
      const task = witness.tasks.find(
        ({ inputRef }) =>
          url.pathname === `/repositories/${witness.repositoryNumber}/git/ref/${inputRef.slice(5)}`,
      );
      assert(task && (init?.method ?? "GET") === "GET", `Unexpected fixture ref ${url.pathname}.`);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer synthetic-improvement-loop-repository-read-token",
      );
      return Response.json({ ref: task.inputRef, object: { type: "commit", sha: task.inputSha } });
    }
    const request = new Request(input, init);
    assert.equal(url.href, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(request.headers.get("authorization"), `Bearer ${improvementLoopFixtureJudge.key}`);
    const judge = z
      .object({
        messages: z.array(
          z.object({
            content: z.union([
              z.string(),
              z.array(z.object({ type: z.string(), text: z.string().optional() })),
            ]),
          }),
        ),
      })
      .parse(await request.json());
    const evidence = judge.messages
      .flatMap(({ content }) => (typeof content === "string" ? [] : content))
      .find(({ text }) => text?.includes(syntheticMarker))?.text;
    assert(evidence);
    const header = z
      .object({ kind: z.literal("artifact"), id: z.string().uuid() })
      .parse(JSON.parse(evidence.slice(0, evidence.indexOf("\n"))));
    const pass = evidence.includes(`${syntheticMarker}: present.`);
    return Response.json({
      id: `wallie-m10-judge-${header.id}`,
      model: improvementLoopFixtureJudge.model,
      provider: improvementLoopFixtureJudge.provider,
      usage: { prompt_tokens: 30, completion_tokens: 6, cost: improvementLoopFixtureJudge.costUsd },
      choices: [
        {
          finish_reason: "stop",
          message: {
            refusal: null,
            content: JSON.stringify({
              score: pass,
              explanation: "The scripted fixture checks the recorded acceptance marker.",
              citations: [{ ...header, start: null, end: null }],
            }),
          },
        },
      ],
    });
  };
}

async function control(
  admin: QualificationAdmin,
  witness: ImprovementLoopReplayWitness,
  experimentId: string,
  action: "pause" | "resume",
) {
  const result = await receipt(
    admin.rpc("control_factory_benchmark_schedule", {
      p_workspace_id: witness.workspaceId,
      p_factory_id: witness.factoryId,
      p_actor_user_id: witness.actorUserId,
      p_experiment_id: experimentId,
      p_action: action,
    }),
  );
  assert.equal(
    z.object({ state: z.string() }).parse(result).state,
    action === "pause" ? "paused" : "active",
  );
}

async function executeExperiment(
  admin: QualificationAdmin,
  witness: ImprovementLoopReplayWitness,
  experimentId: string,
) {
  const scope = { workspace: witness.workspaceId, factory: witness.factoryId };
  const sandbox = await receipt(
    admin
      .from("workspace_vercel_sandbox_connections")
      .select("team_id,project_id")
      .eq("workspace_id", scope.workspace)
      .single(),
  );
  const slots = await receipt(
    admin
      .from("factory_benchmark_experiment_trials")
      .select("trial_id,task_revision_id,candidate_key,replay_eligibility")
      .eq("workspace_id", scope.workspace)
      .eq("factory_id", scope.factory)
      .eq("experiment_id", experimentId),
  );
  assert.equal(slots.length, 4);
  assert(slots.every((slot) => slot.replay_eligibility === "eligible"));
  const candidates = await receipt(
    admin
      .from("factory_benchmark_experiment_candidates")
      .select("candidate_key,comparison_position,definition_revision_id,definition_digest")
      .eq("workspace_id", scope.workspace)
      .eq("factory_id", scope.factory)
      .eq("experiment_id", experimentId),
  );
  assert.equal(candidates.length, 2);
  const definitions = await receipt(
    admin
      .from("factory_definition_revisions")
      .select("id,definition_json,canonical_digest")
      .eq("workspace_id", scope.workspace)
      .eq("factory_id", scope.factory)
      .in("id", [witness.baselineRevisionId, witness.candidateRevisionId]),
  );
  assert.equal(definitions.length, 2);
  const experimentTrialIds = slots.map(({ trial_id }) => trial_id);
  const seen = new Set<string>();
  for (let index = 0; index < slots.length; index += 1) {
    assert.equal(
      await receipt(admin.rpc("reconcile_factory_benchmark_schedules", { p_limit: 10 })),
      1,
    );
    const current = await receipt(
      admin
        .from("factory_benchmark_trials")
        .select("id,job_id,run_id,status")
        .eq("workspace_id", scope.workspace)
        .eq("factory_id", scope.factory)
        .in("id", experimentTrialIds)
        .eq("status", "queued")
        .single(),
    );
    const competing = await receipt(
      admin
        .from("agent_jobs")
        .select("id")
        .in("status", ["queued", "started", "running"])
        .neq("id", current.job_id)
        .limit(1),
    );
    assert.equal(
      competing.length,
      0,
      "The qualification dispatcher requires an exclusive queue with only its exact admitted job.",
    );
    const [dispatch] = await receipt(
      admin.rpc("claim_next_worker_dispatch", {
        accept_benchmark_trials: true,
        p_default_workspace_limit: 1,
        p_max_concurrent: 1,
        p_timeout_ms: 180_000,
      }),
    );
    assert(dispatch);
    assert.equal(dispatch.job_id, current.job_id);
    assert(!seen.has(current.id));
    seen.add(current.id);
    const slot = slots.find(({ trial_id }) => trial_id === current.id);
    assert(slot && current.status === "queued");
    const task = witness.tasks.find(
      ({ taskRevisionId }) => taskRevisionId === slot.task_revision_id,
    );
    const candidate = candidates.find(({ candidate_key }) => candidate_key === slot.candidate_key);
    assert(task && candidate);
    const position = candidate.comparison_position;
    assert(position === 1 || position === 2);
    assert.equal(
      candidate.definition_revision_id,
      position === 1 ? witness.baselineRevisionId : witness.candidateRevisionId,
    );
    const row = definitions.find(({ id }) => id === candidate.definition_revision_id);
    assert(row && row.canonical_digest === candidate.definition_digest);
    const definition = readVerifiedFactoryDefinition(
      row.definition_json,
      candidate.definition_digest,
    );
    const expectedTemplate = position === 1 ? baselineTemplate : candidateTemplate;
    const otherTemplate = position === 1 ? candidateTemplate : baselineTemplate;
    assert.equal(definition?.stages.length, 1);
    assert.equal(definition?.stages[0]?.promptTemplateMd, expectedTemplate);
    const taskInput = verifyPromptBoundary(untrustedPromptValue("session.prompt", task.prompt));
    const output = task.outputs[position - 1];
    assert(output);
    const local = new QualificationSandbox({
      admin,
      task,
      output,
      expectedStagePrompt: expectedTemplate.replace("{{session.prompt}}", () => taskInput),
      otherStagePrompt: otherTemplate.replace("{{session.prompt}}", () => taskInput),
      trial: { ...current, attempt_count: dispatch.attempt_count },
      upstreamModel: witness.upstreamModel,
      teamId: sandbox.team_id,
      projectId: sandbox.project_id,
    });
    vi.mocked(createVercelQualifiedBenchmarkReplaySandbox).mockImplementationOnce(async (input) => {
      await input.onSandboxCreated?.({ provider: "vercel", sandboxId: local.id });
      return local;
    });
    assert.equal(
      await receipt(
        admin.rpc("begin_worker_dispatch", {
          p_job_id: dispatch.job_id,
          p_attempt_count: dispatch.attempt_count,
          p_workflow_id: dispatch.workflow_id,
        }),
      ),
      true,
    );
    const job = await receipt(
      admin
        .from("agent_jobs")
        .select("*")
        .eq("workspace_id", scope.workspace)
        .eq("id", dispatch.job_id)
        .single(),
    );
    try {
      const executed = await runBenchmarkTrial({
        admin,
        job,
        workerRuntime: "workerd",
        signal: AbortSignal.timeout(25_000),
      });
      const trial = await receipt(
        admin
          .from("factory_benchmark_trials")
          .select("failure_code,status")
          .eq("workspace_id", scope.workspace)
          .eq("id", current.id)
          .single(),
      );
      assert.equal(
        executed.result,
        "success",
        `Native replay ended with ${trial.failure_code ?? trial.status}.`,
      );
      const stored = await receipt(
        admin
          .from("factory_benchmark_trial_results")
          .select(
            "runtime,input_commit_sha,input_tree_sha,output_commit_sha,output_tree_sha,inference_receipt_id",
          )
          .eq("workspace_id", scope.workspace)
          .eq("factory_id", scope.factory)
          .eq("trial_id", current.id)
          .single(),
      );
      assert.deepEqual(
        [
          stored.runtime,
          stored.input_commit_sha,
          stored.input_tree_sha,
          stored.output_commit_sha,
          stored.output_tree_sha,
        ],
        ["workerd", task.inputSha, task.inputTree, output.outputSha, output.outputTree],
      );
      assert(stored.inference_receipt_id);
    } finally {
      await local.stop();
    }
  }
  assert.equal(
    await receipt(admin.rpc("reconcile_factory_benchmark_evaluations", { p_limit: 100 })),
    4,
  );
  // The fixture workspace has one evaluation slot. Wait for each drain before claiming the next.
  for (let index = 0; index < slots.length; index += 1) {
    await drainFactoryJudges(admin, "workerd");
  }
  const samples = await receipt(
    admin
      .from("factory_scorer_sample_receipts")
      .select("id")
      .eq("workspace_id", scope.workspace)
      .eq("factory_id", scope.factory)
      .in("benchmark_trial_id", [...seen]),
  );
  assert.equal(samples.length, 4);
  const evaluations = await receipt(
    admin
      .from("factory_evaluation_jobs")
      .select("status")
      .eq("workspace_id", scope.workspace)
      .eq("factory_id", scope.factory)
      .in(
        "sample_receipt_id",
        samples.map(({ id }) => id),
      ),
  );
  assert.deepEqual(
    evaluations.map(({ status }) => status),
    Array(4).fill("succeeded"),
  );
}

it.skipIf(!configured.success)(
  "executes and scores both frozen improvement suites in native Workerd",
  async () => {
    assert(configured.success && raw);
    const witness = configured.data.improvementLoopWitness;
    const { admin, config } = createQualificationClients(raw);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://improvement-loop-fixture.example.test");
    vi.stubGlobal("fetch", fixtureTransport(config.url, witness));
    let replayFailed = false;
    try {
      for (const task of witness.tasks) {
        assert.equal(
          await verifyBenchmarkGitStart(
            {
              installationId: 1,
              repositoryId: witness.repositoryNumber,
              repositoryFullName: "fixture/improvement-loop",
            },
            { input_ref: task.inputRef, input_sha: task.inputSha },
          ),
          "verified",
          `Workerd fixture could not read its retained commit for ${task.taskRevisionId}.`,
        );
      }
      await control(admin, witness, witness.holdoutExperimentId, "pause");
      await executeExperiment(admin, witness, witness.targetedExperimentId);
      await control(admin, witness, witness.targetedExperimentId, "pause");
      await control(admin, witness, witness.holdoutExperimentId, "resume");
      await executeExperiment(admin, witness, witness.holdoutExperimentId);
    } catch (error) {
      replayFailed = true;
      throw error;
    } finally {
      try {
        const pauses = await Promise.allSettled([
          control(admin, witness, witness.targetedExperimentId, "pause"),
          control(admin, witness, witness.holdoutExperimentId, "pause"),
        ]);
        const failures = pauses.filter((result) => result.status === "rejected");
        if (failures.length > 0) {
          const cleanup = new AggregateError(
            failures.map(({ reason }) => reason),
            "Could not pause both improvement qualification schedules.",
          );
          if (!replayFailed) throw cleanup;
          console.warn(cleanup);
        }
      } finally {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
      }
    }
  },
  180_000,
);
