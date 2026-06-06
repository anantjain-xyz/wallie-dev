import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  sandboxCreate: vi.fn(),
  sandboxGet: vi.fn(),
  sandboxList: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: mocked.sandboxCreate,
    get: mocked.sandboxGet,
    list: mocked.sandboxList,
  },
}));

import {
  createVercelSessionSandbox,
  listRunningVercelSandboxes,
  stopVercelSandboxById,
} from "./vercel";
import type { CreateSessionSandboxInput, VercelSandboxCredentials } from "./types";

const credentials: VercelSandboxCredentials = {
  projectId: "prj_123",
  teamId: "team_123",
  token: "vca_secret",
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
    readFileToBuffer: vi.fn(),
    runCommand: vi.fn(async () => command()),
    sandboxId: "sandbox-1",
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
    installationToken: "ghs_token",
    repoFullName: "acme/app",
    sessionId: "session-1",
    vercelCredentials: credentials,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.sandboxCreate.mockResolvedValue(sandbox());
  mocked.sandboxGet.mockResolvedValue({ stop: vi.fn() });
  mocked.sandboxList.mockResolvedValue({
    json: {
      sandboxes: [
        { createdAt: 1000, id: "running", status: "running" },
        { createdAt: 2000, id: "stopped", status: "stopped" },
      ],
    },
  });
});

describe("createVercelSessionSandbox", () => {
  it("requires explicit workspace credentials", async () => {
    await expect(
      createVercelSessionSandbox(input({ vercelCredentials: undefined })),
    ).rejects.toThrow("Workspace Vercel Sandbox credentials are required.");
    expect(mocked.sandboxCreate).not.toHaveBeenCalled();
  });

  it("passes workspace credentials to Vercel Sandbox create", async () => {
    await createVercelSessionSandbox(input());

    expect(mocked.sandboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: credentials.projectId,
        teamId: credentials.teamId,
        token: credentials.token,
      }),
    );
  });
});

describe("stopVercelSandboxById", () => {
  it("passes workspace credentials to Vercel Sandbox get", async () => {
    await stopVercelSandboxById("sandbox-1", credentials);

    expect(mocked.sandboxGet).toHaveBeenCalledWith({
      projectId: credentials.projectId,
      sandboxId: "sandbox-1",
      teamId: credentials.teamId,
      token: credentials.token,
    });
  });
});

describe("listRunningVercelSandboxes", () => {
  it("lists active sandboxes in the workspace project", async () => {
    const sandboxes = await listRunningVercelSandboxes(credentials);

    expect(mocked.sandboxList).toHaveBeenCalledWith({
      limit: 100,
      projectId: credentials.projectId,
      teamId: credentials.teamId,
      token: credentials.token,
    });
    expect(sandboxes).toEqual([{ createdAt: 1000, id: "running", status: "running" }]);
  });
});
