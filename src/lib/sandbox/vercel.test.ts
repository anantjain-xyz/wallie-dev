import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "@vercel/sandbox";

import { vercelSandboxFetch } from "@/lib/vercel-sandbox/errors";

import { WALLIE_GITHUB_BOT_COMMIT_AUTHOR } from "./commit-author";
import { createSessionSandbox } from "./index";
import {
  createVercelSessionSandbox,
  hasRecoverableVercelSandboxSource,
  listRunningVercelSandboxes,
  stopVercelSandboxById,
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
      limit: 100,
      projectId: credentials.projectId,
      teamId: credentials.teamId,
      token: credentials.token,
    });
    expect(sandboxes).toEqual([{ createdAt: 1000, id: "running", status: "running" }]);
  });

  it("pages through every Vercel sandbox list result", async () => {
    mocked.sandboxList
      .mockResolvedValueOnce({
        pagination: { count: 100, next: "1234" },
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
      limit: 100,
      projectId: credentials.projectId,
      teamId: credentials.teamId,
      token: credentials.token,
    });
    expect(mocked.sandboxList).toHaveBeenNthCalledWith(2, {
      cursor: "1234",
      fetch: vercelSandboxFetch,
      limit: 100,
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
      limit: 100,
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
