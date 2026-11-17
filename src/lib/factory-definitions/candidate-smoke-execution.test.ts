import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";
import type { SandboxConnection, SandboxExecHandle } from "@/lib/sandbox/types";
import type { Database } from "@/lib/supabase/database.types";

import {
  acquireCandidateSmokeUtility,
  runCandidateSmokeExecution,
  type CandidateSmokeUtility,
} from "./candidate-smoke-execution";
import { compileFactoryDefinition } from "./compiler";

const mocks = vi.hoisted(() => ({
  createUtilitySandbox: vi.fn<typeof import("@/lib/sandbox").createUtilitySandbox>(),
  stopSandboxById: vi.fn<typeof import("@/lib/sandbox").stopSandboxById>(),
  reserve: vi.fn<typeof import("@/lib/workspaces/resource-operations").reserveWorkspaceSandbox>(),
  record: vi.fn<typeof import("@/lib/workspaces/resource-operations").recordWorkspaceSandbox>(),
  settle: vi.fn<typeof import("@/lib/workspaces/resource-operations").settleWorkspaceResource>(),
}));

vi.mock("@/lib/sandbox", () => ({
  createUtilitySandbox: mocks.createUtilitySandbox,
  stopSandboxById: mocks.stopSandboxById,
}));
vi.mock("@/lib/workspaces/resource-operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspaces/resource-operations")>()),
  reserveWorkspaceSandbox: mocks.reserve,
  recordWorkspaceSandbox: mocks.record,
  settleWorkspaceResource: mocks.settle,
}));

const workspaceId = "00000000-0000-4000-8000-000000000001";
const repositoryId = "00000000-0000-4000-8000-000000000002";
const pipelineId = "00000000-0000-4000-8000-000000000003";
const planStage = "00000000-0000-4000-8000-000000000004";
const buildStage = "00000000-0000-4000-8000-000000000005";
const privateCandidateText = "CANDIDATE_TEXT_MUST_STAY_SERVER_SIDE";

const compiled = compileFactoryDefinition(
  {
    kind: "structured",
    value: {
      kind: "serial",
      schemaVersion: 1,
      pipeline: pipelineId,
      repository: repositoryId,
      sandboxProvider: "vercel",
      agent: {
        provider: "claude-code",
        model: "claude-sonnet-4-6",
        effort: "high",
        concurrencyLimit: 1,
        stallTimeoutMs: 90_000,
        maxRetries: 1,
        maxTurns: 12,
      },
      operatingRulesMd: "{{#if artifact.previousStages.plan}}Use the approved plan.{{/if}}",
      stages: [
        { id: planStage, slug: "plan", name: "Plan", promptTemplateMd: "{{session.prompt}}" },
        {
          id: buildStage,
          slug: "build",
          name: "Build",
          promptTemplateMd: `${privateCandidateText}\n{{artifact.previousStages.plan}}`,
        },
      ],
    },
  },
  {
    workspaceId,
    repositories: [{ id: repositoryId, workspaceId }],
    pipelines: [{ id: pipelineId, workspaceId }],
    skills: [],
    tools: [],
    executionPolicyRevisions: [],
    deliveryPolicyRevisions: [],
    approvers: [],
    sandboxProviders: ["vercel"],
  },
);
if (!compiled.ok) throw new Error("Invalid serial smoke fixture.");
const bundle = compiled.bundle;

function utilityFor(sandbox: FakeSandbox): CandidateSmokeUtility {
  return { sandbox, cwd: sandbox.repoPath, close: () => sandbox.stop() };
}

beforeEach(() => vi.resetAllMocks());

describe("candidate smoke execution", () => {
  it("binds every stage's smoke digest to the immutable literal agent prompt", async () => {
    const instructions = "Private agent instructions {{artifact.previousStages.future-stage}}";
    const originalSandbox = new FakeSandbox();
    const candidateSandbox = new FakeSandbox();
    try {
      const original = await runCandidateSmokeExecution({
        bundle,
        profile: "fake",
        acquire: async () => utilityFor(originalSandbox),
      });
      const candidate = await runCandidateSmokeExecution({
        bundle: {
          ...bundle,
          implementationAgent: {
            agentId: "00000000-0000-4000-8000-000000000006",
            promptRevisionId: "00000000-0000-4000-8000-000000000007",
            promptMd: instructions,
            promptSha256: createHash("sha256").update(instructions).digest("hex"),
          },
        },
        profile: "fake",
        acquire: async () => utilityFor(candidateSandbox),
      });

      expect(original.status).toBe("passed");
      expect(candidate.status).toBe("passed");
      expect(candidate.evidence.completedStageCount).toBe(2);
      expect(candidate.evidence.stages.map(({ promptDigest }) => promptDigest)).not.toEqual(
        original.evidence.stages.map(({ promptDigest }) => promptDigest),
      );
      expect(JSON.stringify(candidateSandbox.calls)).not.toContain(instructions);
      expect(JSON.stringify(candidate)).not.toContain(instructions);
    } finally {
      await originalSandbox.stop();
      await candidateSandbox.stop();
    }
  });

  it("executes every stage in order in the fake utility and keeps candidate text out of commands", async () => {
    const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
    let finalState: string | null = null;
    try {
      const result = await runCandidateSmokeExecution({
        bundle,
        profile: "fake",
        acquire: async () => ({
          ...utilityFor(sandbox),
          close: async () => {
            const state = sandbox.calls.at(-1)?.args.at(-2);
            if (state) finalState = await sandbox.readFile(join(sandbox.repoPath, state));
            await sandbox.stop();
          },
        }),
      });

      expect(result).toMatchObject({
        status: "passed",
        evidence: {
          runtimeProfile: "fake",
          stageCount: 2,
          completedStageCount: 2,
          stages: [
            { stageId: planStage, promptDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) },
            { stageId: buildStage, promptDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) },
          ],
        },
      });
      expect(finalState).toBe("2");
      expect(sandbox.calls.map(({ cmd }) => cmd)).toEqual(["node", "node", "node"]);
      expect(sandbox.calls.map(({ opts }) => opts.env)).toEqual([undefined, undefined, undefined]);
      expect(JSON.stringify(sandbox.calls)).not.toContain(privateCandidateText);
      expect(JSON.stringify(result)).not.toContain(privateCandidateText);
      expect(existsSync(sandbox.repoPath)).toBe(false);
    } finally {
      await sandbox.stop();
    }
  });

  it("blocks an invalid serial prompt before allocating a runtime", async () => {
    const acquire = vi.fn<() => Promise<CandidateSmokeUtility>>();
    const invalid = {
      ...bundle,
      stages: bundle.stages.map((stage) =>
        stage.id === planStage ? { ...stage, previousStageIds: [buildStage] } : stage,
      ),
    };
    await expect(
      runCandidateSmokeExecution({ bundle: invalid, profile: "fake", acquire }),
    ).resolves.toMatchObject({ status: "blocked", evidence: { reason: "invalid_prompt" } });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("runs every stage when persisted evidence samples only the first 32", async () => {
    const sandbox = new FakeSandbox();
    const stages = Array.from({ length: 34 }, (_, index) => ({
      ...bundle.stages[0],
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      slug: `stage-${index}`,
    }));
    try {
      const result = await runCandidateSmokeExecution({
        bundle: { ...bundle, stages, operatingRulesMd: "", operatingRuleStageIds: [] },
        profile: "fake",
        acquire: async () => utilityFor(sandbox),
      });

      expect(result).toMatchObject({
        status: "passed",
        evidence: { stageCount: 34, completedStageCount: 34 },
      });
      expect(result.evidence.stages.map(({ stageId }) => stageId)).toEqual(
        stages.slice(0, 32).map(({ id }) => id),
      );
      expect(sandbox.calls.slice(1).map(({ args }) => args.at(-1))).toEqual(
        stages.map((_, index) => String(index + 1)),
      );
    } finally {
      await sandbox.stop();
    }
  });

  it("reports a runtime without suitable Node support before executing stages", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("node", [], { exitCode: 127 });
    const close = vi.fn(async () => sandbox.stop());
    await expect(
      runCandidateSmokeExecution({
        bundle,
        profile: "vercel",
        acquire: async () => ({ ...utilityFor(sandbox), close }),
      }),
    ).resolves.toMatchObject({
      status: "unsupported",
      evidence: { reason: "node_unavailable", completedStageCount: 0 },
    });
    expect(sandbox.calls).toHaveLength(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it("stops further stages and closes the utility when execution is canceled", async () => {
    const sandbox = new FakeSandbox();
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<number>();
    const exec = sandbox.exec.bind(sandbox);
    vi.spyOn(sandbox, "exec").mockImplementation(async (cmd, args, opts) => {
      const handle = await exec(cmd, args, opts);
      if (sandbox.calls.length === 2) {
        markStarted();
        return { ...handle, exitCode: pending.promise } satisfies SandboxExecHandle;
      }
      return handle;
    });
    const request = new AbortController();
    const close = vi.fn(async () => sandbox.stop());
    const result = runCandidateSmokeExecution({
      bundle,
      profile: "fake",
      acquire: async () => ({ ...utilityFor(sandbox), close }),
      signal: request.signal,
    });
    await started;
    request.abort(new Error("Private cancellation reason"));

    expect(await result).toMatchObject({
      status: "canceled",
      evidence: { completedStageCount: 0, reason: "canceled" },
    });
    expect(sandbox.calls).toHaveLength(2);
    expect(close).toHaveBeenCalledOnce();
    pending.resolve(143);
  });

  it("closes a utility that appears after the caller canceled acquisition", async () => {
    const sandbox = new FakeSandbox();
    const close = vi.fn(async () => sandbox.stop());
    const request = new AbortController();
    const acquisition = Promise.withResolvers<CandidateSmokeUtility>();
    const acquire = vi.fn(() => acquisition.promise);
    const result = runCandidateSmokeExecution({
      bundle,
      profile: "fake",
      acquire,
      signal: request.signal,
    });
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    request.abort();
    await expect(result).resolves.toMatchObject({ status: "canceled" });
    acquisition.resolve({ ...utilityFor(sandbox), close });

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(sandbox.calls).toHaveLength(0);
  });

  it("withholds a passing result if the runtime's cleanup cannot be confirmed", async () => {
    const sandbox = new FakeSandbox();
    try {
      const close = vi.fn(async () => {
        throw new Error("Remote response details must not be retained");
      });
      await expect(
        runCandidateSmokeExecution({
          bundle,
          profile: "fake",
          acquire: async () => ({ ...utilityFor(sandbox), close }),
        }),
      ).resolves.toMatchObject({
        status: "failed",
        evidence: { completedStageCount: 2, cleanupPending: true, reason: "cleanup_failed" },
      });
    } finally {
      await sandbox.stop();
    }
  });
});

describe("workspace utility ownership", () => {
  it("reserves before allocating and settles only after strict provider cleanup", async () => {
    const client = createClient<Database>("http://127.0.0.1:1", "local-fixture", {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const connection: SandboxConnection = {
      provider: "daytona",
      credentials: { apiKey: "test-provider-credential" },
      revision: "connection-test",
    };
    const requestId = "00000000-0000-4000-8000-000000000006";
    const sandbox = new FakeSandbox();
    const dispose = vi.fn(async () => undefined);
    try {
      mocks.reserve.mockResolvedValue("resource-test");
      mocks.record.mockResolvedValue(true);
      mocks.createUtilitySandbox.mockImplementation(async (input) => {
        expect(mocks.reserve).toHaveBeenCalledBefore(mocks.createUtilitySandbox);
        await input.onSandboxCreated({ provider: "daytona", sandboxId: sandbox.id });
        return Object.assign(sandbox, { [Symbol.asyncDispose]: dispose });
      });
      const utility = await acquireCandidateSmokeUtility({
        admin: client,
        workspaceId,
        requestId,
        connection,
        signal: new AbortController().signal,
      });
      expect(utility.cwd).toBe("/tmp");
      expect(mocks.createUtilitySandbox).toHaveBeenCalledWith(
        {
          workspaceId,
          ownerId: requestId,
          timeoutMs: 120_000,
          signal: expect.any(AbortSignal),
          onSandboxCreated: expect.any(Function),
        },
        connection,
      );
      expect(mocks.record).toHaveBeenCalledWith(client, "resource-test", sandbox.id);
      expect(mocks.settle).not.toHaveBeenCalled();

      await utility.close();
      expect(mocks.stopSandboxById).toHaveBeenCalledWith(sandbox.id, {
        connection,
        throwOnError: true,
      });
      expect(mocks.stopSandboxById).toHaveBeenCalledBefore(mocks.settle);
      expect(mocks.settle).toHaveBeenCalledWith(client, "resource-test", true);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await sandbox.stop();
    }
  });
});
