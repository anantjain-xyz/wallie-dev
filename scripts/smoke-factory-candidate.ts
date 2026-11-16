import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import {
  runCandidateSmokeExecution,
  type CandidateSmokeUtility,
} from "../src/lib/factory-definitions/candidate-smoke-execution";
import type { CompiledFactoryDefinition } from "../src/lib/factory-definitions/compiler";
import { createUtilitySandbox } from "../src/lib/sandbox";
import { FakeSandbox } from "../src/lib/sandbox/fake";
import type { SandboxExecHandle, SandboxExecOptions } from "../src/lib/sandbox/types";

const runFile = promisify(execFile);
const suiteDeadlineMs = 90_000;
const fixtureId = (index: number) => `54700000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const bundle: CompiledFactoryDefinition = {
  schemaVersion: 1,
  kind: "serial",
  pipelineId: fixtureId(1),
  repositoryId: fixtureId(2),
  agent: {
    provider: "codex",
    model: "gpt-5.5",
    effort: null,
    concurrencyLimit: 1,
    stallTimeoutMs: 90_000,
    maxRetries: 1,
    maxTurns: 2,
  },
  sandboxProvider: "vercel",
  executionPolicyRevisionId: null,
  deliveryPolicyRevisionId: null,
  skillIds: [],
  toolIds: [],
  operatingRulesMd: "Use the fixture inputs.",
  operatingRuleStageIds: [],
  stages: [
    {
      id: fixtureId(3),
      slug: "plan",
      name: "Plan",
      description: "",
      promptTemplateMd: "Plan {{session.title}}.",
      anyoneCanApprove: true,
      approverMemberIds: [],
      previousStageIds: [],
    },
    {
      id: fixtureId(4),
      slug: "verify",
      name: "Verify",
      description: "",
      promptTemplateMd: "Verify {{session.title}}.",
      anyoneCanApprove: true,
      approverMemberIds: [],
      previousStageIds: [fixtureId(3)],
    },
  ],
};

function dockerCommand(
  name: string,
  command: string,
  args: string[],
  options: SandboxExecOptions | undefined,
  close: () => Promise<void>,
): SandboxExecHandle {
  const output = new Promise<{ stdout: string; stderr: string; code: number }>(
    (resolve, reject) => {
      execFile(
        "docker",
        ["exec", "--workdir", options?.cwd ?? "/tmp", name, command, ...args],
        { signal: options?.signal, maxBuffer: 128 * 1024 },
        (error, stdout, stderr) => {
          const code = error ? error.code : 0;
          if (typeof code !== "number") {
            reject(error);
            return;
          }
          resolve({ stdout, stderr, code });
        },
      );
    },
  );
  const exitCode = output.then(({ code }) => code);
  void exitCode.catch(() => undefined);
  return {
    async *logs() {
      const result = await output;
      yield { data: result.stdout, stream: "stdout" };
      yield { data: result.stderr, stream: "stderr" };
    },
    async output() {
      const { stdout, stderr } = await output;
      return { stdout, stderr };
    },
    exitCode,
    kill: close,
  };
}

async function acquireDocker(signal: AbortSignal): Promise<CandidateSmokeUtility> {
  const name = `wallie-candidate-smoke-${randomUUID()}`;
  let stopped: Promise<void> | undefined;
  const close = () => (stopped ??= runFile("docker", ["rm", "-f", name]).then(() => undefined));
  await runFile(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--pull",
      "never",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,mode=1777",
      "--user",
      "node",
      "node:22-bookworm",
      "node",
      "-e",
      "setTimeout(() => {}, 90000)",
    ],
    { signal },
  );
  return {
    sandbox: {
      exec: async (command, args, options) => dockerCommand(name, command, args, options, close),
    },
    cwd: "/tmp",
    close,
  };
}

function vercelAcquisition() {
  const {
    WALLIE_CANDIDATE_SMOKE_VERCEL_TOKEN: token,
    WALLIE_CANDIDATE_SMOKE_VERCEL_TEAM_ID: teamId,
    WALLIE_CANDIDATE_SMOKE_VERCEL_PROJECT_ID: projectId,
  } = process.env;
  if (!token || !teamId || !projectId) {
    throw new Error(
      "Configure the WALLIE_CANDIDATE_SMOKE_VERCEL variables for a dedicated test project.",
    );
  }
  return async (signal: AbortSignal): Promise<CandidateSmokeUtility> => {
    const fixture = randomUUID();
    const sandbox = await createUtilitySandbox(
      {
        ownerId: fixture,
        workspaceId: fixture,
        timeoutMs: suiteDeadlineMs,
        signal,
        onSandboxCreated: async () => undefined,
      },
      { provider: "vercel", revision: fixture, credentials: { token, teamId, projectId } },
    );
    return { sandbox, cwd: "/tmp", close: () => sandbox.stop() };
  };
}

async function main() {
  const profile = process.argv[2] ?? "fake";
  if (profile !== "fake" && profile !== "docker" && profile !== "vercel") {
    throw new Error("Choose fake, docker, or vercel.");
  }
  const acquire =
    profile === "vercel"
      ? vercelAcquisition()
      : profile === "docker"
        ? acquireDocker
        : async () => {
            const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
            return { sandbox, cwd: sandbox.repoPath, close: () => sandbox.stop() };
          };
  const result = await runCandidateSmokeExecution({
    bundle,
    profile: profile === "vercel" ? "vercel" : "fake",
    signal: AbortSignal.timeout(suiteDeadlineMs),
    acquire,
  });
  assert.equal(result.status, "passed", JSON.stringify(result.evidence));
  assert.equal(result.evidence.completedStageCount, bundle.stages.length);
  console.log(`Candidate serial smoke passed with ${profile} (${bundle.stages.length} stages).`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Candidate serial smoke failed.");
  process.exitCode = 1;
});
