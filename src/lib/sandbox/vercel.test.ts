import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "@vercel/sandbox";

import { vercelSandboxFetch } from "@/lib/vercel-sandbox/errors";

import { WALLIE_GITHUB_BOT_COMMIT_AUTHOR } from "./commit-author";
import {
  createBenchmarkReplaySandbox,
  createSessionSandbox,
  createUtilitySandbox,
  sealBenchmarkReplaySandbox,
} from "./index";
import {
  createVercelSessionSandbox,
  hasRecoverableVercelSandboxSource,
  listRunningVercelSandboxes,
  stopVercelSandboxById,
  vercelSandboxDriver,
} from "./vercel";
import type { CreateSessionSandboxInput, VercelSandboxCredentials } from "./types";

type SandboxCommandInput = {
  args: string[];
  cmd: string;
};

const mocked = vi.hoisted(() => ({
  sandboxCreate: vi.fn(),
  sandboxGet: vi.fn(),
  sandboxList: vi.fn(),
}));

vi.mock("@vercel/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vercel/sandbox")>();
  return {
    APIError: actual.APIError,
    Sandbox: {
      create: mocked.sandboxCreate,
      get: mocked.sandboxGet,
      list: mocked.sandboxList,
    },
  };
});

const credentials: VercelSandboxCredentials = {
  projectId: "prj_123",
  teamId: "team_123",
  token: "vca_secret",
};
const vercelConnection = {
  credentials,
  provider: "vercel" as const,
  revision: "revision-1",
};

function command(exitCode = 0) {
  return {
    exitCode,
    logs: async function* logs() {},
    output: vi.fn(),
    wait: vi.fn(async () => ({ exitCode })),
  };
}

function sandbox(overrides: Record<string, unknown> = {}) {
  return {
    name: "sandbox-1",
    readFileToBuffer: vi.fn(),
    runCommand: vi.fn(async () => command()),
    stop: vi.fn(),
    writeFiles: vi.fn(),
    ...overrides,
  };
}

function input(overrides: Partial<CreateSessionSandboxInput> = {}): CreateSessionSandboxInput {
  return {
    agentProvider: "codex",
    baseBranch: "main",
    branch: "wallie/test",
    connection: vercelConnection,
    installationToken: "ghs_token",
    repoFullName: "acme/app",
    sessionId: "session-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.sandboxCreate.mockResolvedValue(sandbox());
  mocked.sandboxGet.mockResolvedValue({ stop: vi.fn() });
  mocked.sandboxList.mockResolvedValue({
    pagination: { count: 2, next: null },
    sandboxes: [
      { createdAt: 1000, name: "running", status: "running" },
      { createdAt: 2000, name: "stopped", status: "stopped" },
    ],
  });
});

describe("createVercelSessionSandbox", () => {
  it("restores checkpoint mode through the common checkout instead of native branch cloning", async () => {
    const runCommand = vi.fn(async (request: SandboxCommandInput) => {
      void request;
      return command();
    });
    mocked.sandboxCreate.mockResolvedValue(sandbox({ runCommand }));
    await createVercelSessionSandbox(
      input({
        mode: { kind: "checkpoint", ref: "refs/heads/wallie/retained", sha: "a".repeat(40) },
      }),
      vercelConnection,
    );
    expect(mocked.sandboxCreate.mock.calls[0]?.[0]).not.toHaveProperty("source");
    const scripts = runCommand.mock.calls.map(([request]) =>
      (request as SandboxCommandInput).args.join(" "),
    );
    expect(scripts[0]).toContain("git init");
    expect(scripts[1]).toContain("refs/heads/wallie/retained");
    expect(scripts[1]).not.toContain("'main'");
    expect(scripts[2]).toContain("npm install -g @openai/codex");
  });
  it("preserves the provider's creation rejection reason without exposing credentials", async () => {
    mocked.sandboxCreate.mockRejectedValueOnce(
      new APIError(new Response(null, { status: 403 }), {
        message: "Status code 403 is not ok",
        json: {
          error: { code: "forbidden", message: "Access denied for vca_secret and ghs_token." },
        },
      }),
    );

    await expect(createVercelSessionSandbox(input(), vercelConnection)).rejects.toThrow(
      "Vercel Sandbox request failed (403; forbidden): Access denied for [REDACTED] and [REDACTED].",
    );
  });

  it("requires explicit workspace credentials", async () => {
    await expect(
      createSessionSandbox(input({ connection: undefined, implementation: "vercel" })),
    ).rejects.toThrow("Workspace vercel Sandbox connection is required.");
    expect(mocked.sandboxCreate).not.toHaveBeenCalled();
  });

  it("passes workspace credentials to Vercel Sandbox create", async () => {
    await createVercelSessionSandbox(input(), vercelConnection);

    expect(mocked.sandboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        fetch: vercelSandboxFetch,
        persistent: false,
        projectId: credentials.projectId,
        runtime: "node22",
        teamId: credentials.teamId,
        token: credentials.token,
      }),
    );
  });

  it("notifies callers as soon as the provider sandbox is created", async () => {
    const onSandboxCreated = vi.fn();

    await createVercelSessionSandbox(input({ onSandboxCreated }), vercelConnection);

    expect(onSandboxCreated).toHaveBeenCalledWith({
      provider: "vercel",
      sandboxId: "sandbox-1",
    });
  });

  it("configures git commits as the Wallie GitHub App bot", async () => {
    const runCommand = vi.fn(async (request: SandboxCommandInput) => {
      void request;
      return command();
    });
    mocked.sandboxCreate.mockResolvedValue(sandbox({ runCommand }));

    await createVercelSessionSandbox(
      input({
        branch: "wallie/session-1-product",
        installationToken: "ghs_test",
        repoFullName: "acme/app",
        sessionId: "session-1",
      }),
      vercelConnection,
    );

    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "-lc",
          expect.stringContaining(
            `git -C '/vercel/sandbox' config user.email '${WALLIE_GITHUB_BOT_COMMIT_AUTHOR.email}'`,
          ),
        ],
        cmd: "bash",
      }),
    );
    const setupScript = runCommand.mock.calls[0]?.[0].args[1];
    expect(setupScript).toContain(
      `git -C '/vercel/sandbox' config user.name '${WALLIE_GITHUB_BOT_COMMIT_AUTHOR.name}'`,
    );
  });

  it("installs OpenCode v1 for OpenCode sandboxes", async () => {
    const runCommand = vi.fn(async () => command());
    mocked.sandboxCreate.mockResolvedValue(sandbox({ runCommand }));

    await createVercelSessionSandbox(input({ agentProvider: "opencode" }), vercelConnection);

    const setupCall = (
      runCommand.mock.calls[0] as unknown as [{ args?: string[] }] | undefined
    )?.[0];
    expect(setupCall?.args?.[1] ?? "").toContain("npm install -g opencode-ai@1");
  });
});

describe("Vercel benchmark replay isolation", () => {
  function replayInput() {
    return {
      workspaceId: "workspace",
      ownerId: "trial",
      timeoutMs: 60_000,
      onSandboxCreated: vi.fn(),
    };
  }

  function replayProvider(sessionSealPolicy = "deny-all") {
    let networkPolicy: unknown = { allow: ["github.com"] };
    let sessionPolicy: unknown = networkPolicy;
    const native = {
      ...sandbox(),
      get networkPolicy() {
        return networkPolicy;
      },
      currentSession: () => ({ networkPolicy: sessionPolicy }),
      update: vi.fn(async () => {
        networkPolicy = "deny-all";
        sessionPolicy = sessionSealPolicy;
      }),
    };
    mocked.sandboxCreate.mockResolvedValueOnce(native);
    return native;
  }

  it("confirms bootstrap egress, seals the native session, and rejects command env injection", async () => {
    const native = replayProvider();
    const request = replayInput();
    const signal = new AbortController().signal;
    const handle = await createBenchmarkReplaySandbox(request, vercelConnection);

    expect(request.onSandboxCreated).toHaveBeenCalledWith({
      provider: "vercel",
      sandboxId: "sandbox-1",
    });
    expect(mocked.sandboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({ persistent: false, networkPolicy: { allow: ["github.com"] } }),
    );
    const [creation] = mocked.sandboxCreate.mock.calls;
    expect(creation?.[0]).not.toHaveProperty("env");
    await expect((await handle.exec("git", ["fetch"])).exitCode).resolves.toBe(0);

    await sealBenchmarkReplaySandbox(handle, signal);

    expect(native.update).toHaveBeenCalledWith({ networkPolicy: "deny-all" }, { signal });
    await expect(handle.exec("node", [], { env: { API_TOKEN: "secret" } })).rejects.toThrow(
      "cannot inject environment variables",
    );
    expect(native.runCommand).toHaveBeenCalledTimes(1);
    await expect((await handle.exec("cat", ["fixture"], { signal })).exitCode).resolves.toBe(0);
    await expect(sealBenchmarkReplaySandbox(handle, signal)).rejects.toThrow("once");
  });

  it("rejects other providers and ordinary utility handles", async () => {
    const request = replayInput();
    await expect(
      createBenchmarkReplaySandbox(request, {
        provider: "e2b",
        revision: "other-provider",
        credentials: { apiKey: "test-key" },
      }),
    ).rejects.toThrow("requires Vercel Sandbox");
    expect(mocked.sandboxCreate).not.toHaveBeenCalled();

    const utility = await createUtilitySandbox(request, vercelConnection);
    const [creation] = mocked.sandboxCreate.mock.calls;
    expect(creation?.[0]).not.toHaveProperty("networkPolicy");
    await expect(sealBenchmarkReplaySandbox(utility, new AbortController().signal)).rejects.toThrow(
      "benchmark replay sandbox is required",
    );
  });

  it("leaves the hosted provider untouched in fake sandbox mode", async () => {
    vi.stubEnv("WALLIE_SANDBOX_IMPL", "fake");
    try {
      await expect(createBenchmarkReplaySandbox(replayInput(), vercelConnection)).rejects.toThrow(
        "Hosted benchmark replay is disabled in fake sandbox mode.",
      );
      expect(mocked.sandboxCreate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("stops a sandbox whose active bootstrap policy is too broad", async () => {
    const native = sandbox({
      networkPolicy: { allow: ["github.com"] },
      currentSession: () => ({ networkPolicy: { allow: ["github.com", "example.com"] } }),
    });
    mocked.sandboxCreate.mockResolvedValueOnce(native);

    await expect(createBenchmarkReplaySandbox(replayInput(), vercelConnection)).rejects.toThrow(
      "bootstrap network policy has not been verified",
    );
    expect(native.stop).toHaveBeenCalledOnce();
    expect(native.runCommand).not.toHaveBeenCalled();
  });

  it("keeps commands blocked if the provider update does not seal the active session", async () => {
    const native = replayProvider("allow-all");
    const handle = await createBenchmarkReplaySandbox(replayInput(), vercelConnection);

    await expect(sealBenchmarkReplaySandbox(handle, new AbortController().signal)).rejects.toThrow(
      "network seal has not been verified",
    );
    await expect(handle.exec("node", [])).rejects.toThrow("network seal has not been verified");
    expect(native.runCommand).not.toHaveBeenCalled();
  });

  it("blocks commands during seal and keeps them blocked after cancellation and late success", async () => {
    const native = replayProvider();
    const handle = await createBenchmarkReplaySandbox(replayInput(), vercelConnection);
    const complete = Promise.withResolvers<void>();
    const originalUpdate = native.update.getMockImplementation();
    native.update.mockImplementationOnce(async () => {
      await complete.promise;
      await originalUpdate?.();
    });
    const controller = new AbortController();
    const canceled = new Error("Trial canceled");
    const sealing = sealBenchmarkReplaySandbox(handle, controller.signal);
    await vi.waitFor(() => expect(native.update).toHaveBeenCalledOnce());
    await expect(handle.exec("node", [])).rejects.toThrow("network seal has not been verified");

    controller.abort(canceled);
    await expect(sealing).rejects.toBe(canceled);
    complete.resolve();
    await vi.waitFor(() => expect(native.networkPolicy).toBe("deny-all"));

    await expect(handle.exec("node", [])).rejects.toThrow("network seal has not been verified");
    expect(native.runCommand).not.toHaveBeenCalled();
  });
});

describe("VercelSandboxHandle exec", () => {
  function harness(wait: ReturnType<typeof vi.fn>) {
    const runCommand = vi.fn(async (request: SandboxCommandInput) => {
      if (request.cmd === "bash") return command();
      return {
        exitCode: null,
        logs: async function* logs() {},
        output: vi.fn(async () => ({ stderr: "", stdout: "" })),
        wait,
      };
    });
    mocked.sandboxCreate.mockResolvedValue(sandbox({ runCommand }));
  }

  it("retries a gateway timeout while waiting for the command to exit", async () => {
    vi.useFakeTimers();
    try {
      const wait = vi
        .fn()
        .mockRejectedValueOnce(
          new APIError(new Response(null, { status: 524 }), {
            message: "Can't parse JSON: SyntaxError: Unexpected token 'e'",
            text: "error code: 524\n",
          }),
        )
        .mockResolvedValueOnce({ exitCode: 0 });
      harness(wait);

      const handle = await createVercelSessionSandbox(input(), vercelConnection);
      const proc = await handle.exec("sleep", ["120"]);
      const exit = proc.exitCode;
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(exit).resolves.toBe(0);
      expect(wait).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a non-retryable wait failure without retrying", async () => {
    const wait = vi
      .fn()
      .mockRejectedValue(
        new APIError(new Response(null, { status: 403 }), { message: "Forbidden" }),
      );
    harness(wait);

    const handle = await createVercelSessionSandbox(input(), vercelConnection);
    const proc = await handle.exec("sleep", ["120"]);

    await expect(proc.exitCode).rejects.toThrow(
      "Vercel Sandbox request failed (403): Check the saved Vercel token, its team access, and the connected project.",
    );
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("does not emit an unhandled rejection when cancelled before exitCode is awaited", async () => {
    const controller = new AbortController();
    const cancellation = new Error("Run cancelled");
    let logSignal: AbortSignal | undefined;
    const wait = vi.fn(
      (options?: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason ?? cancellation),
            { once: true },
          );
        }),
    );
    mocked.sandboxCreate.mockResolvedValue(
      sandbox({
        runCommand: vi.fn(async (request: SandboxCommandInput) => {
          if (request.cmd === "bash") return command();
          return {
            exitCode: null,
            logs: async function* logs(options?: { signal?: AbortSignal }) {
              logSignal = options?.signal;
              await new Promise(() => undefined);
            },
            output: vi.fn(),
            wait,
          };
        }),
      }),
    );

    const handle = await createVercelSessionSandbox(input(), vercelConnection);
    const proc = await handle.exec("sleep", ["120"], { signal: controller.signal });
    // The agent runners drain logs to completion before awaiting exitCode.
    const logStream = proc.logs()[Symbol.asyncIterator]();
    void logStream.next();

    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      controller.abort(cancellation);
      await new Promise((resolve) => setImmediate(resolve));
      expect(logSignal).toBe(controller.signal);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    await expect(proc.exitCode).rejects.toThrow("Run cancelled");
  });
});

describe("stopVercelSandboxById", () => {
  it("passes workspace credentials to Vercel Sandbox get", async () => {
    await stopVercelSandboxById("sandbox-1", credentials);

    expect(mocked.sandboxGet).toHaveBeenCalledWith({
      fetch: vercelSandboxFetch,
      name: "sandbox-1",
      projectId: credentials.projectId,
      teamId: credentials.teamId,
      token: credentials.token,
    });
  });

  it.each([
    ["lookup", 404],
    ["stop", 404],
    ["lookup", 410],
    ["stop", 410],
  ] as const)(
    "accepts provider-confirmed absence during %s (%i) in strict mode",
    async (step, status) => {
      const error = new APIError(new Response(null, { status }), { message: "sandbox gone" });
      if (step === "lookup") mocked.sandboxGet.mockRejectedValueOnce(error);
      else mocked.sandboxGet.mockResolvedValueOnce({ stop: vi.fn().mockRejectedValue(error) });

      await expect(
        stopVercelSandboxById("sandbox-gone", credentials, { throwOnError: true }),
      ).resolves.toBeUndefined();
    },
  );

  it.each([401, 403, 429, 500])("propagates provider status %i in strict mode", async (status) => {
    const error = new APIError(new Response(null, { status }), { message: `provider ${status}` });
    mocked.sandboxGet.mockResolvedValueOnce({ stop: vi.fn().mockRejectedValue(error) });

    await expect(
      stopVercelSandboxById("sandbox-1", credentials, { throwOnError: true }),
    ).rejects.toThrow(
      status === 401 || status === 403
        ? `Vercel Sandbox request failed (${status}): Check the saved Vercel token, its team access, and the connected project.`
        : `Vercel Sandbox request failed (${status}): provider ${status}`,
    );
  });

  it("does not infer absence from an untyped error message or status field", async () => {
    mocked.sandboxGet.mockRejectedValueOnce(
      Object.assign(new Error("404 sandbox not found"), {
        response: { status: 404 },
      }),
    );
    await expect(
      stopVercelSandboxById("sandbox-1", credentials, { throwOnError: true }),
    ).rejects.toThrow("404 sandbox not found");
  });

  it("throws stop failures in strict cleanup mode", async () => {
    mocked.sandboxGet.mockRejectedValueOnce(new Error("provider down"));

    await expect(
      stopVercelSandboxById("sandbox-1", credentials, { throwOnError: true }),
    ).rejects.toThrow("provider down");
  });
});

describe("listRunningVercelSandboxes", () => {
  it("lists active sandboxes in the workspace project", async () => {
    const sandboxes = await listRunningVercelSandboxes(credentials);

    expect(mocked.sandboxList).toHaveBeenCalledWith({
      fetch: vercelSandboxFetch,
      limit: 50,
      projectId: credentials.projectId,
      teamId: credentials.teamId,
      token: credentials.token,
    });
    expect(sandboxes).toEqual([{ createdAt: 1000, id: "running", status: "running" }]);
  });

  it("pages through every Vercel sandbox list result", async () => {
    mocked.sandboxList
      .mockResolvedValueOnce({
        pagination: { count: 50, next: "1234" },
        sandboxes: [
          { createdAt: 3000, name: "running-page-1", status: "running" },
          { createdAt: 2500, name: "stopped-page-1", status: "stopped" },
        ],
      })
      .mockResolvedValueOnce({
        pagination: { count: 1, next: null },
        sandboxes: [{ createdAt: 1000, name: "pending-page-2", status: "pending" }],
      });

    const sandboxes = await listRunningVercelSandboxes(credentials);

    expect(mocked.sandboxList).toHaveBeenNthCalledWith(1, {
      fetch: vercelSandboxFetch,
      limit: 50,
      projectId: credentials.projectId,
      teamId: credentials.teamId,
      token: credentials.token,
    });
    expect(mocked.sandboxList).toHaveBeenNthCalledWith(2, {
      cursor: "1234",
      fetch: vercelSandboxFetch,
      limit: 50,
      projectId: credentials.projectId,
      teamId: credentials.teamId,
      token: credentials.token,
    });
    expect(sandboxes).toEqual([
      { createdAt: 3000, id: "running-page-1", status: "running" },
      { createdAt: 1000, id: "pending-page-2", status: "pending" },
    ]);
  });

  it("throws list failures in strict cleanup mode", async () => {
    mocked.sandboxList.mockRejectedValueOnce(new Error("provider down"));

    await expect(listRunningVercelSandboxes(credentials, { throwOnError: true })).rejects.toThrow(
      "provider down",
    );
  });
});

describe("Vercel retained source inspection", () => {
  const listed = (rows: object[], next: string | null = null) => ({
    sandboxes: rows,
    pagination: { next },
  });
  it.each(["pending", "running", "stopping", "snapshotting", "unknown"])(
    "retains %s source without stopping it",
    async (status) => {
      mocked.sandboxList.mockResolvedValue(listed([{ name: "sandbox-1", status }]));
      expect(await hasRecoverableVercelSandboxSource("sandbox-1", vercelConnection)).toBe(true);
      expect(mocked.sandboxGet).not.toHaveBeenCalled();
    },
  );
  it.each(["stopped", "failed", "aborted"])(
    "releases expired ephemeral %s source",
    async (status) => {
      mocked.sandboxList.mockResolvedValue(listed([{ name: "sandbox-1", status }]));
      expect(await hasRecoverableVercelSandboxSource("sandbox-1", vercelConnection)).toBe(false);
      mocked.sandboxList.mockResolvedValue(
        listed([{ name: "sandbox-1", status, currentSnapshotId: "snap-1" }]),
      );
      expect(await hasRecoverableVercelSandboxSource("sandbox-1", vercelConnection)).toBe(true);
    },
  );
  it("reads every provider page before proving absence", async () => {
    mocked.sandboxList
      .mockResolvedValueOnce(listed([{ name: "other", status: "stopped" }], "7"))
      .mockResolvedValueOnce(listed([{ name: "sandbox-1", status: "running" }]));
    expect(await hasRecoverableVercelSandboxSource("sandbox-1", vercelConnection)).toBe(true);
    expect(mocked.sandboxList).toHaveBeenLastCalledWith({
      ...credentials,
      cursor: "7",
      fetch: vercelSandboxFetch,
      limit: 50,
    });
    mocked.sandboxList.mockResolvedValue(listed([]));
    expect(await hasRecoverableVercelSandboxSource("sandbox-1", vercelConnection)).toBe(false);
  });
  it("does not turn a failed provider page into absence", async () => {
    mocked.sandboxList
      .mockResolvedValueOnce(listed([], "7"))
      .mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(hasRecoverableVercelSandboxSource("sandbox-1", vercelConnection)).rejects.toThrow(
      "Provider unavailable",
    );
  });
});

it("finds only an exact nonpersistent Vercel reservation and never resumes for lookup", async () => {
  const identity = { operationId: "operation-1", workspaceId: "workspace-1" };
  const exact = {
    name: "wallie-operation-1",
    persistent: false,
    status: "running",
    tags: {
      wallie_acquisition_id: identity.operationId,
      wallie_workspace_id: identity.workspaceId,
    },
  };
  mocked.sandboxList.mockResolvedValueOnce({
    pagination: { next: null },
    sandboxes: [exact, { ...exact, name: "wallie-operation-1-extra" }],
  });
  await expect(vercelSandboxDriver.findAcquisition(identity, vercelConnection)).resolves.toEqual([
    exact.name,
  ]);
  expect(mocked.sandboxList).toHaveBeenCalledWith(
    expect.objectContaining({
      namePrefix: exact.name,
      projectId: credentials.projectId,
      teamId: credentials.teamId,
    }),
  );
  expect(mocked.sandboxGet).not.toHaveBeenCalled();

  mocked.sandboxList.mockResolvedValueOnce({
    pagination: { next: null },
    sandboxes: [{ ...exact, status: "stopped" }],
  });
  await expect(vercelSandboxDriver.findAcquisition(identity, vercelConnection)).resolves.toEqual(
    [],
  );
});
