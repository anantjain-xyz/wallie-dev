import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import type { SandboxHandle, CreateUtilitySandboxInput } from "@/lib/sandbox/types";
import { conflictBucket, retainJoinConflict } from "./join-conflict";
import { joinManagedResources } from "./join-managed-resources";
import type { Context } from "./join-worker-runtime";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  stop: vi.fn(),
  reserve: vi.fn(),
  record: vi.fn(),
  settle: vi.fn(),
}));
vi.mock("@/lib/sandbox", () => ({
  createUtilitySandbox: mocks.create,
  stopSandboxById: mocks.stop,
}));
vi.mock("@/lib/sandbox-connections/server", () => ({
  loadRequiredWorkspaceSandboxConnection: async () => ({
    connection: {
      provider: "e2b",
      revision: "scoped-revision",
      credentials: { apiKey: "test-only" },
    },
  }),
}));
vi.mock("@/lib/workspaces/resource-operations", () => ({
  reserveWorkspaceSandbox: mocks.reserve,
  recordWorkspaceSandbox: mocks.record,
  settleWorkspaceResource: mocks.settle,
}));

const ids = {
  rootSessionId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  factoryId: "00000000-0000-4000-8000-000000000003",
  parentSessionId: "00000000-0000-4000-8000-000000000004",
  joinId: "00000000-0000-4000-8000-000000000005",
  jobId: "00000000-0000-4000-8000-000000000006",
  runId: "00000000-0000-4000-8000-000000000007",
  ownershipToken: "00000000-0000-4000-8000-000000000008",
};
const controlCalls: Array<{ pathname: string; body: unknown }> = [];

function context(storageFetch?: typeof fetch): Context {
  const deadlineAt = new Date(Date.now() + 60_000).toISOString();
  return {
    admin: createClient<Database>("https://supabase.invalid", "test-only", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        async fetch(resource, request) {
          const url = new URL(String(resource));
          if (storageFetch && url.pathname.startsWith("/storage/v1/"))
            return storageFetch(resource, request);
          controlCalls.push({
            pathname: url.pathname,
            body: JSON.parse(String(request?.body)),
          });
          return Response.json(url.pathname.endsWith("/agent_runs") ? { id: ids.runId } : true);
        },
      },
    }),
    claim: {
      kind: "started",
      ...ids,
      attemptCount: 1,
      generation: 3,
      artifactVersion: 2,
      baseSha: "a".repeat(40),
      baseRef: null,
      deadlineAt,
      deadlineReason: "worker",
    },
    deadlineAt,
    signal: AbortSignal.timeout(15_000),
  };
}

function blank(id: string): SandboxHandle {
  return {
    id,
    repoPath: "/tmp/blank",
    exec: async () => ({
      exitCode: Promise.resolve(0),
      output: async () => ({ stdout: "", stderr: "" }),
      async *logs() {
        yield* [];
      },
      async kill() {},
    }),
    async writeFile() {},
    async readFile() {
      return null;
    },
    async stop() {},
  };
}

describe("managed join workspaces", () => {
  beforeEach(() => {
    controlCalls.length = 0;
    vi.resetAllMocks();
    mocks.reserve
      .mockResolvedValueOnce("integration-operation")
      .mockResolvedValueOnce("validation-operation");
    mocks.record.mockResolvedValue(true);
    mocks.settle.mockResolvedValue(undefined);
    mocks.create.mockImplementation(async (input: CreateUtilitySandboxInput) => {
      const id = input.acquisition?.operationId ?? "untracked";
      await input.onSandboxCreated({ provider: "e2b", sandboxId: id });
      return blank(id);
    });
  });

  it("recovers two independent utility reservations and attaches only the credential-free validation VM", async () => {
    const exact = context();
    await joinManagedResources.integrate(exact, async (sandbox) =>
      expect(sandbox.id).toBe("integration-operation"),
    );
    await joinManagedResources.validate(exact, async (sandbox) =>
      expect(sandbox.id).toBe("validation-operation"),
    );
    expect(mocks.create.mock.calls.map(([input]) => input.acquisition)).toEqual([
      { operationId: "integration-operation", workspaceId: ids.workspaceId },
      { operationId: "validation-operation", workspaceId: ids.workspaceId },
    ]);
    expect(
      mocks.create.mock.calls.every(
        ([input]) =>
          !("installationToken" in input) && !("env" in input) && !("repoFullName" in input),
      ),
    ).toBe(true);
    const lifecycle = controlCalls.filter(({ pathname }) =>
      pathname.endsWith("register_factory_workflow_sandbox_acquisition"),
    );
    expect(lifecycle.map(({ body }) => body)).toEqual([
      {
        p_run_id: ids.runId,
        p_attempt_count: 1,
        p_operation_id: "validation-operation",
      },
    ]);
    const attachments = controlCalls.filter(({ pathname }) => pathname.endsWith("/agent_runs"));
    expect(attachments.map(({ body }) => body)).toEqual([
      expect.objectContaining({
        sandbox_id: "validation-operation",
        sandbox_provider: "e2b",
      }),
    ]);
    expect(mocks.stop.mock.calls.map(([id]) => id)).toEqual([
      "integration-operation",
      "validation-operation",
    ]);
    expect(mocks.settle.mock.calls.map(([, id, transferred]) => [id, transferred])).toEqual([
      ["integration-operation", true],
      ["validation-operation", true],
    ]);
  });

  it("keeps the labeled reservation when the provider loses the create reply", async () => {
    mocks.create.mockRejectedValueOnce(new Error("lost create reply"));
    const run = vi.fn();
    await expect(joinManagedResources.integrate(context(), run)).rejects.toThrow(
      "lost create reply",
    );
    expect(run).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0]?.[0].acquisition).toEqual({
      operationId: "integration-operation",
      workspaceId: ids.workspaceId,
    });
  });

  it("keeps a known exact handle eligible for cleanup when stop fails", async () => {
    mocks.stop.mockRejectedValueOnce(new Error("lost stop reply"));
    await expect(joinManagedResources.integrate(context(), async () => true)).rejects.toThrow(
      "cleanup will retry",
    );
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.settle.mock.calls.map(([, id, transferred]) => [id, transferred])).toEqual([
      ["integration-operation", false],
    ]);
  });

  it("retains the lookup horizon when neither the handle record nor stop can be confirmed", async () => {
    mocks.record.mockRejectedValue(new Error("lost handle record"));
    mocks.stop.mockRejectedValueOnce(new Error("lost stop reply"));
    const work = vi.fn();
    await expect(joinManagedResources.integrate(context(), work)).rejects.toThrow(
      "cleanup will retry",
    );
    expect(work).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it("reserves and verifies exact conflict bytes when the upload reply is lost", async () => {
    let writtenBody: string | undefined;
    const storageFetch = vi.fn<typeof fetch>(async (_resource, request) => {
      if (request?.method === "POST") {
        writtenBody = String(request.body);
        throw new TypeError("lost upload reply");
      }
      return new Response(writtenBody, { headers: { "Content-Type": "application/json" } });
    });
    const exact = context(storageFetch);
    const scope = {
      workspaceId: ids.workspaceId,
      rootSessionId: ids.rootSessionId,
      joinId: ids.joinId,
      runId: ids.runId,
    };
    const report = await retainJoinConflict(
      joinManagedResources.conflicts(exact),
      scope,
      {
        kind: "conflict",
        edgeId: "branch.right",
        incomingSha: "b".repeat(40),
        integratedThroughSha: "c".repeat(40),
        paths: ["shared.ts"],
        pathsTruncated: false,
      },
      exact.signal,
    );
    const path = `${conflictBucket}/${Object.values(scope).join("/")}/${report.reportSha256}.json`;
    expect(controlCalls).toEqual([
      {
        pathname: "/rest/v1/rpc/reserve_factory_workflow_join_conflict",
        body: {
          p_workspace_id: ids.workspaceId,
          p_root_session_id: ids.rootSessionId,
          p_factory_id: ids.factoryId,
          p_expected_generation: exact.claim.generation,
          p_ownership_token: ids.ownershipToken,
          p_join_id: ids.joinId,
          p_run_id: ids.runId,
          p_job_id: ids.jobId,
          p_attempt_count: exact.claim.attemptCount,
          p_digest: report.reportSha256,
        },
      },
    ]);
    expect(storageFetch).toHaveBeenCalledTimes(2);
    expect(storageFetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(`/object/${path}`),
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(new Headers(storageFetch.mock.calls[0]?.[1]?.headers).get("x-upsert")).toBe("false");
    expect(storageFetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(`/object/${path}`),
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(report).toMatchObject({ paths: ["shared.ts"], pathsTruncated: false });
  });

  it("forwards the join deadline to an in-flight Storage download", async () => {
    const controller = new AbortController();
    const observedAbort = vi.fn();
    const storageFetch = vi.fn<typeof fetch>(async (_resource, request) => {
      const signal = request?.signal;
      if (!signal) return new Response("missing signal");
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAbort();
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    const exact = context(storageFetch);
    const path = [
      ids.workspaceId,
      ids.rootSessionId,
      ids.joinId,
      ids.runId,
      `${"a".repeat(64)}.json`,
    ].join("/");
    const download = joinManagedResources.conflicts(exact).download(path, controller.signal);
    await vi.waitFor(() => expect(storageFetch).toHaveBeenCalledOnce());
    const rejection = expect(download).rejects.toThrow("join deadline reached");
    controller.abort(new Error("join deadline reached"));
    await rejection;
    expect(observedAbort).toHaveBeenCalledOnce();
  });
});
