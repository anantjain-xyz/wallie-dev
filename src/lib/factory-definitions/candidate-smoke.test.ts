import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import {
  cancelFactoryDefinitionSmokeTest,
  listFactoryDefinitionSmokeTests,
  startFactoryDefinitionSmokeTest,
} from "./candidate-smoke";
import { compileFactoryDefinition } from "./compiler";
import type { FactoryDefinitionCatalog } from "./references";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  catalog: vi.fn(),
  connection: vi.fn(),
}));
vi.mock("@/lib/sandbox-connections/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sandbox-connections/server")>()),
  loadRequiredWorkspaceSandboxConnection: mocks.connection,
}));
vi.mock("./authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./authority")>()),
  loadFactoryDefinitionCatalog: mocks.catalog,
}));
vi.mock("./candidate-smoke-execution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./candidate-smoke-execution")>()),
  acquireCandidateSmokeUtility: mocks.acquire,
}));

const fixtureId = (n: number) => `54700000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const workspaceId = fixtureId(1);
const pipelineId = fixtureId(2);
const repositoryId = fixtureId(3);
const factoryId = fixtureId(4);
const actorUserId = fixtureId(5);
const target = { kind: "draft" as const, id: fixtureId(6) };
const stageId = fixtureId(7);
const testId = fixtureId(8);
const connectionRevision = fixtureId(9);
const catalog: FactoryDefinitionCatalog = {
  workspaceId,
  pipelines: [{ id: pipelineId, workspaceId }],
  repositories: [{ id: repositoryId, workspaceId }],
  executionPolicyRevisions: [],
  deliveryPolicyRevisions: [],
  approvers: [],
  skills: [],
  tools: [],
  sandboxProviders: ["vercel"],
};
const definition = compileFactoryDefinition(
  {
    kind: "structured",
    value: {
      schemaVersion: 1,
      kind: "serial",
      pipeline: pipelineId,
      repository: repositoryId,
      sandboxProvider: "vercel",
      agent: {
        provider: "codex",
        model: "gpt-5.6-sol",
        concurrencyLimit: 1,
        stallTimeoutMs: 60_000,
        maxRetries: 1,
        maxTurns: 5,
      },
      stages: [{ id: stageId, slug: "plan", name: "Plan", anyoneCanApprove: true }],
    },
  },
  catalog,
);
if (!definition.ok) throw new Error("The candidate smoke fixture must compile.");
const stored = {
  canonical_digest: definition.canonicalDigest,
  definition_json: definition.definitionJson,
};
const command = { target, expectedActivationNumber: 4, expectedDigest: definition.canonicalDigest };

function fixture({
  status = "running",
  expired = false,
}: { status?: "running" | "blocked"; expired?: boolean } = {}) {
  const now = Date.now();
  const row = {
    id: testId,
    workspace_id: workspaceId,
    factory_id: factoryId,
    target_kind: target.kind,
    target_id: target.id,
    base_activation_number: 4,
    definition_digest: stored.canonical_digest,
    policy_version: 1,
    sandbox_connection_revision: status === "blocked" ? null : connectionRevision,
    created_by: actorUserId,
    created_at: new Date(now - 1_000).toISOString(),
    lease_expires_at: new Date(now + (expired ? -100 : 60_000)).toISOString(),
    finished_at: status === "blocked" ? new Date(now).toISOString() : null,
    status,
    evidence: {},
    error_text: status === "blocked" ? "Verify the selected runtime before testing." : null,
  };
  let state: string = row.status;
  const calls: Array<{ rpc: string; body: unknown }> = [];
  const admin = createClient<Database>("http://localhost:9999", "test-service-role", {
    global: {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const rpc = url.pathname.split("/rpc/")[1];
        if (rpc) {
          calls.push({ rpc, body: JSON.parse(String(init?.body)) });
          if (rpc.startsWith("start_")) return Response.json(row);
          if (rpc.startsWith("cancel_")) {
            state = "canceled";
            return Response.json({ ...row, status: state, finished_at: new Date().toISOString() });
          }
          return Response.json(state === "running");
        }
        expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
        if (url.pathname.endsWith("/factories")) return Response.json([{ id: factoryId }]);
        if (url.pathname.endsWith("/factory_definition_drafts")) {
          expect(url.searchParams.get("factory_id")).toBe(`eq.${factoryId}`);
          expect(url.searchParams.get("id")).toBe(`eq.${target.id}`);
          return Response.json([stored]);
        }
        expect(url.pathname).toMatch(/\/factory_definition_smoke_tests$/);
        if (url.searchParams.get("id")) {
          expect(url.searchParams.get("id")).toBe(`eq.${testId}`);
          expect(url.searchParams.get("status")).toBe("eq.running");
          return Response.json(state === "running" ? [{ id: testId }] : []);
        }
        expect(url.searchParams.get("target_kind")).toBe(`eq.${target.kind}`);
        expect(url.searchParams.get("target_id")).toBe(`eq.${target.id}`);
        expect(url.searchParams.get("definition_digest")).toBe(`eq.${stored.canonical_digest}`);
        return Response.json([row]);
      },
    },
  });
  return { admin, calls };
}

async function runReadyTest(admin: ReturnType<typeof fixture>["admin"]) {
  const result = await startFactoryDefinitionSmokeTest({
    admin,
    workspaceId,
    actorUserId,
    command,
  });
  if (!result.ok || !result.run) throw new Error("Expected an authorized smoke test.");
  return result;
}

describe("candidate smoke orchestration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.catalog.mockResolvedValue(catalog);
    mocks.connection.mockResolvedValue({
      provider: "vercel",
      connection: { provider: "vercel", revision: connectionRevision },
    });
  });

  it("reserves the exact target and digest before provisioning its selected runtime", async () => {
    const { admin, calls } = fixture();
    const exec = vi.fn().mockResolvedValue({ exitCode: Promise.resolve(0) });
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.acquire.mockResolvedValue({ sandbox: { exec }, cwd: "/tmp", close });
    const result = await runReadyTest(admin);
    expect(result.test).toMatchObject({
      status: "running",
      definitionDigest: command.expectedDigest,
    });
    expect(calls).toMatchObject([
      {
        rpc: "start_factory_definition_smoke_test",
        body: {
          p_actor_user_id: actorUserId,
          p_target_id: target.id,
          p_definition_digest: command.expectedDigest,
          p_expected_activation_number: command.expectedActivationNumber,
        },
      },
    ]);
    expect(mocks.acquire).not.toHaveBeenCalled();

    await result.run?.();

    expect(mocks.connection).toHaveBeenCalledWith(admin, workspaceId, "vercel");
    expect(mocks.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: testId,
        connection: { provider: "vercel", revision: connectionRevision },
      }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(calls.at(-1)).toMatchObject({
      rpc: "finish_factory_definition_smoke_test",
      body: {
        p_test_id: testId,
        p_status: "passed",
        p_evidence: {
          runtimeProfile: "vercel",
          stageCount: 1,
          completedStageCount: 1,
          stages: [{ stageId, promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }],
        },
      },
    });
  });

  it("rejects a mismatched digest and keeps a DB-blocked request out of the runtime", async () => {
    const { admin, calls } = fixture({ status: "blocked" });
    const start = (expectedDigest: string) =>
      startFactoryDefinitionSmokeTest({
        admin,
        workspaceId,
        actorUserId,
        command: { ...command, expectedDigest },
      });
    expect(await start("a".repeat(64))).toMatchObject({ ok: false, status: 409 });
    expect(calls).toEqual([]);

    expect(await start(command.expectedDigest)).toMatchObject({
      ok: true,
      test: { status: "blocked", error: "Verify the selected runtime before testing." },
      run: null,
    });
    expect(mocks.connection).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("records a rotated connection as blocked without acquiring a sandbox", async () => {
    const { admin, calls } = fixture();
    mocks.connection.mockResolvedValue({
      provider: "vercel",
      connection: { provider: "vercel", revision: fixtureId(10) },
    });
    const result = await runReadyTest(admin);
    await result.run?.();

    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(calls.at(-1)).toMatchObject({
      rpc: "finish_factory_definition_smoke_test",
      body: { p_test_id: testId, p_status: "blocked" },
    });
  });

  it("honors cancellation before the scheduled runtime starts", async () => {
    const { admin, calls } = fixture();
    const result = await runReadyTest(admin);
    expect(
      await cancelFactoryDefinitionSmokeTest({
        admin,
        workspaceId,
        actorUserId,
        testId,
        digest: command.expectedDigest,
      }),
    ).toMatchObject({
      ok: true,
      test: { status: "canceled" },
    });
    await result.run?.();

    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(calls.map(({ rpc }) => rpc)).toEqual([
      "start_factory_definition_smoke_test",
      "cancel_factory_definition_smoke_test",
    ]);
  });

  it("observes durable cancellation while a sandbox command is running and closes the sandbox", async () => {
    const { admin, calls } = fixture();
    const commandRunning = Promise.withResolvers<AbortSignal>();
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0 })
      .mockImplementationOnce(
        async (_script: string, _args: string[], { signal }: { signal: AbortSignal }) => {
          commandRunning.resolve(signal);
          return { exitCode: new Promise(() => {}) };
        },
      );
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.acquire.mockResolvedValue({ sandbox: { exec }, cwd: "/tmp", close });
    const result = await runReadyTest(admin);
    const completion = result.run?.();
    const commandSignal = await commandRunning.promise;

    await cancelFactoryDefinitionSmokeTest({
      admin,
      workspaceId,
      actorUserId,
      testId,
      digest: command.expectedDigest,
    });
    await completion;

    expect(commandSignal.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(calls.at(-1)).toMatchObject({
      rpc: "finish_factory_definition_smoke_test",
      body: { p_test_id: testId, p_status: "canceled" },
    });
  });

  it("surfaces an expired exact-digest reservation as a failed test until a retry records expiry", async () => {
    const { admin } = fixture({ expired: true });
    expect(
      await listFactoryDefinitionSmokeTests({
        client: admin,
        workspaceId,
        target,
        digest: command.expectedDigest,
      }),
    ).toMatchObject({
      ok: true,
      tests: [{ id: testId, status: "failed", definitionDigest: command.expectedDigest }],
    });
  });
});
