import { APIError } from "@vercel/sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  capabilityReportSucceeded: vi.fn(() => true),
  createSessionSandbox: vi.fn(),
  getClaudeCodeCredentialForUser: vi.fn(),
  getCodexCredentialForUser: vi.fn(),
  getCursorCredentialForUser: vi.fn(),
  getOpenCodeAuthForUser: vi.fn(),
  loadRequiredWorkspaceSandboxConnection: vi.fn(),
  loadWorkspaceAgentConfig: vi.fn(),
  octokitRequest: vi.fn(),
  probeSandboxCapabilities: vi.fn(),
}));

vi.mock("@octokit/app", () => ({
  App: vi.fn(function MockGitHubApp() {
    return {
      octokit: {
        request: mocked.octokitRequest,
      },
    };
  }),
}));

vi.mock("@/features/github/config", () => ({
  resolveGitHubAppConfig: vi.fn(() => ({ appId: "1", privateKey: "key" })),
}));

vi.mock("@/lib/agent-runner", () => ({
  loadWorkspaceAgentConfig: mocked.loadWorkspaceAgentConfig,
}));

vi.mock("@/lib/codex/tokens", () => ({
  getCodexCredentialForUser: mocked.getCodexCredentialForUser,
}));

vi.mock("@/lib/claude-code/tokens", () => ({
  getClaudeCodeCredentialForUser: mocked.getClaudeCodeCredentialForUser,
}));

vi.mock("@/lib/cursor/tokens", () => ({
  getCursorCredentialForUser: mocked.getCursorCredentialForUser,
}));

vi.mock("@/lib/opencode/tokens", () => ({
  getOpenCodeAuthForUser: mocked.getOpenCodeAuthForUser,
}));

vi.mock("@/lib/sandbox", () => ({
  createSessionSandbox: mocked.createSessionSandbox,
}));

vi.mock("@/lib/workspaces/resource-operations", () => ({
  createWorkspaceSessionSandbox: (_admin: unknown, input: unknown) =>
    mocked.createSessionSandbox(input),
}));

vi.mock("@/lib/sandbox-connections/server", () => ({
  loadRequiredWorkspaceSandboxConnection: mocked.loadRequiredWorkspaceSandboxConnection,
}));

vi.mock("@/lib/sandbox-capabilities/probe", () => ({
  capabilityReportSucceeded: mocked.capabilityReportSucceeded,
  probeSandboxCapabilities: mocked.probeSandboxCapabilities,
}));

import {
  completeSandboxCapabilityCheck,
  getLatestSandboxCapabilityCheck,
  startSandboxCapabilityCheck,
  type FactoryCapabilityCandidate,
} from "./server";

const credentials = { projectId: "prj_123", teamId: "team_123", token: "vca_secret" };
const candidate: FactoryCapabilityCandidate = {
  agent: { provider: "opencode", model: "opencode/gpt-5.6-sol" },
  definitionDigest: "a".repeat(64),
  sandboxProvider: "e2b",
};
const repository = {
  default_branch: "main",
  full_name: "acme/app",
  github_installation_id: "installation-row-1",
  id: "repo-1",
  workspace_id: "workspace-1",
};

describe("startSandboxCapabilityCheck", () => {
  it.each([undefined, { ...candidate, actorUserId: "user-1" }])(
    "creates the running check through the workspace-locked RPC for candidate %o",
    async (candidate) => {
      const rpc = vi.fn(async () => ({
        data: {
          capabilities: {},
          checked_at: "2026-06-06T18:00:00.000Z",
          error_text: null,
          github_repository_id: "repo-1",
          id: "check-1",
          sandbox_id: null,
          sandbox_provider: null,
          sandbox_vercel_project_id: null,
          sandbox_vercel_team_id: null,
          status: "running",
          workspace_id: "workspace-1",
        },
        error: null,
      }));
      const admin = {
        from: vi.fn((table: string) => {
          if (table !== "github_repositories") {
            throw new Error(`unexpected table: ${table}`);
          }
          const builder = {
            eq: () => builder,
            limit: () => builder,
            maybeSingle: async () => ({
              data: repository,
              error: null,
            }),
            order: () => builder,
            select: () => builder,
          };
          return builder;
        }),
        rpc,
      };

      const started = await startSandboxCapabilityCheck({
        admin: admin as never,
        repositoryId: "repo-1",
        workspaceId: "workspace-1",
        candidate,
      });

      const scope = {
        target_github_repository_id: "repo-1",
        target_workspace_id: "workspace-1",
      };
      if (candidate) {
        expect(rpc).toHaveBeenCalledWith("start_factory_definition_capability_check", {
          ...scope,
          target_actor_user_id: "user-1",
          target_agent_model: "opencode/gpt-5.6-sol",
          target_agent_provider: "opencode",
          target_definition_digest: candidate.definitionDigest,
          target_sandbox_provider: "e2b",
        });
      } else {
        expect(rpc).toHaveBeenCalledWith("start_sandbox_capability_check", scope);
      }
      expect(started.check).toMatchObject({
        githubRepositoryId: "repo-1",
        id: "check-1",
        status: "running",
      });
    },
  );
});

describe("getLatestSandboxCapabilityCheck", () => {
  it.each([undefined, candidate.definitionDigest])(
    "loads only the newest receipt for definition digest %s",
    async (definitionDigest) => {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        is: vi.fn(() => query),
        order: vi.fn(() => query),
        limit: vi.fn(() => query),
        maybeSingle: async () => ({ data: null, error: null }),
      };
      const admin = { from: vi.fn(() => query) };
      const check = await getLatestSandboxCapabilityCheck({
        admin: admin as never,
        repositoryId: "repo-1",
        workspaceId: "workspace-1",
        definitionDigest,
      });
      expect(check).toBeNull();
      expect(query.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
      expect(query.eq).toHaveBeenCalledWith("github_repository_id", "repo-1");
      if (definitionDigest) {
        expect(query.eq).toHaveBeenCalledWith("factory_definition_digest", definitionDigest);
        expect(query.is).not.toHaveBeenCalled();
      } else {
        expect(query.is).toHaveBeenCalledWith("factory_definition_digest", null);
      }
    },
  );
});

function adminMock() {
  const updates: unknown[] = [];
  const filters: { eq: [string, unknown][]; is: [string, unknown][] }[] = [];
  return {
    admin: {
      from: vi.fn((table: string) => {
        if (table === "github_installations") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: { installation_id: 123 }, error: null }),
                }),
              }),
            }),
          };
        }

        if (table === "sandbox_capability_checks") {
          return {
            update: (patch: Record<string, unknown>) => {
              const filter: (typeof filters)[number] = { eq: [], is: [] };
              filters.push(filter);
              const builder = {
                eq: (column: string, value: unknown) => {
                  filter.eq.push([column, value]);
                  return builder;
                },
                is: (column: string, value: unknown) => {
                  filter.is.push([column, value]);
                  return builder;
                },
                select: () => ({
                  single: async () => {
                    updates.push(patch);
                    return {
                      data: {
                        capabilities: {},
                        checked_at: "2026-06-06T18:00:00.000Z",
                        error_text: patch.error_text ?? null,
                        github_repository_id: "repo-1",
                        id: "check-1",
                        status: patch.status ?? "success",
                      },
                      error: null,
                    };
                  },
                }),
                then: (resolve: (value: { error: null }) => void) => {
                  updates.push(patch);
                  resolve({ error: null });
                },
              };
              return builder;
            },
          };
        }

        throw new Error(`unexpected table: ${table}`);
      }),
    },
    updates,
    filters,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.loadWorkspaceAgentConfig.mockResolvedValue({
    effort: "xhigh",
    model: "gpt-5.5",
    provider: "codex",
  });
  mocked.loadRequiredWorkspaceSandboxConnection.mockResolvedValue({
    connection: { credentials, provider: "vercel", revision: "revision-1" },
    provider: "vercel",
  });
  mocked.octokitRequest.mockResolvedValue({ data: { token: "gh-token" } });
  mocked.getClaudeCodeCredentialForUser.mockResolvedValue({ secret: "claude-token" });
  mocked.getCodexCredentialForUser.mockResolvedValue({ secret: "codex-token" });
  mocked.getCursorCredentialForUser.mockResolvedValue({ secret: "cursor-token" });
  mocked.getOpenCodeAuthForUser.mockResolvedValue({
    credential: { secret: "zen-token" },
    providerCredentials: {},
  });
  mocked.createSessionSandbox.mockImplementation(async (input) => {
    await input.onSandboxCreated?.({ provider: "vercel", sandboxId: "sandbox-1" });
    return {
      id: "sandbox-1",
      repoPath: "/vercel/sandbox",
      stop: vi.fn(),
    };
  });
  mocked.probeSandboxCapabilities.mockResolvedValue({
    git: { detail: "ok", ok: true },
  });
});

describe("completeSandboxCapabilityCheck", () => {
  it("qualifies the saved factory runtime without reading the workspace's active defaults", async () => {
    const e2bConnection = {
      credentials: { apiKey: "fixture-key" },
      provider: "e2b",
      revision: "revision-e2b",
    };
    mocked.loadRequiredWorkspaceSandboxConnection.mockResolvedValueOnce({
      connection: e2bConnection,
      provider: "e2b",
    });
    const { admin, filters, updates } = adminMock();
    const result = await completeSandboxCapabilityCheck({
      admin: admin as never,
      checkId: "check-1",
      repository,
      userId: "user-1",
      workspaceId: "workspace-1",
      candidate: { ...candidate, connectionRevision: "revision-e2b" },
    });

    expect(result.status).toBe("success");
    expect(mocked.loadWorkspaceAgentConfig).not.toHaveBeenCalled();
    expect(mocked.loadRequiredWorkspaceSandboxConnection).toHaveBeenCalledWith(
      admin,
      "workspace-1",
      "e2b",
    );
    expect(mocked.getOpenCodeAuthForUser).toHaveBeenCalledWith(
      admin,
      "user-1",
      "opencode/gpt-5.6-sol",
    );
    expect(mocked.getCodexCredentialForUser).not.toHaveBeenCalled();
    expect(mocked.createSessionSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        agentProvider: "opencode",
        implementation: "e2b",
        connection: e2bConnection,
      }),
    );
    expect(mocked.probeSandboxCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({
        agentProvider: "opencode",
        sandboxProvider: "e2b",
      }),
    );
    expect(updates[0]).toMatchObject({
      agent_model: "opencode/gpt-5.6-sol",
      sandbox_connection_revision: "revision-e2b",
    });
    expect(filters).toHaveLength(2);
    for (const filter of filters) {
      expect(filter.eq).toEqual(
        expect.arrayContaining([
          ["id", "check-1"],
          ["status", "running"],
          ["workspace_id", "workspace-1"],
          ["github_repository_id", "repo-1"],
          ["factory_definition_digest", candidate.definitionDigest],
          ["sandbox_provider", "e2b"],
          ["sandbox_connection_revision", "revision-e2b"],
          ["agent_provider", "opencode"],
          ["agent_model", "opencode/gpt-5.6-sol"],
        ]),
      );
    }
  });

  it("finishes the exact check as an error when its reserved sandbox connection has changed", async () => {
    mocked.loadRequiredWorkspaceSandboxConnection.mockResolvedValueOnce({
      connection: {
        credentials: { apiKey: "fixture-key" },
        provider: "e2b",
        revision: "new-revision",
      },
      provider: "e2b",
    });
    const { admin, updates, filters } = adminMock();
    const result = await completeSandboxCapabilityCheck({
      admin: admin as never,
      checkId: "check-1",
      repository,
      userId: "user-1",
      workspaceId: "workspace-1",
      candidate: { ...candidate, connectionRevision: "reserved-revision" },
    });

    expect(result.status).toBe("error");
    expect(result.errorText).toContain("The sandbox connection changed");
    expect(mocked.octokitRequest).not.toHaveBeenCalled();
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
    expect(mocked.probeSandboxCapabilities).not.toHaveBeenCalled();
    expect(updates).toEqual([expect.objectContaining({ status: "error" })]);
    expect(filters[0].eq).toContainEqual(["sandbox_connection_revision", "reserved-revision"]);
  });

  it("refuses a probe without durable check ownership", async () => {
    const { admin } = adminMock();
    const result = await completeSandboxCapabilityCheck({
      admin: admin as never,
      checkId: null,
      repository: {
        default_branch: "main",
        full_name: "acme/app",
        github_installation_id: "installation-row-1",
        id: "repo-1",
        workspace_id: "workspace-1",
      },
      userId: "user-1",
      workspaceId: "workspace-1",
    });
    expect(result.status).toBe("error");
    expect(result.errorText).toBe("Sandbox capability check reservation is required.");
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
  });
  it("validates Cursor credentials for Cursor capability checks", async () => {
    mocked.loadWorkspaceAgentConfig.mockResolvedValueOnce({
      effort: "xhigh",
      model: "auto",
      provider: "cursor",
    });
    const { admin } = adminMock();

    await completeSandboxCapabilityCheck({
      admin: admin as never,
      checkId: "check-1",
      repository: {
        default_branch: "main",
        full_name: "acme/app",
        github_installation_id: "installation-row-1",
        id: "repo-1",
        workspace_id: "workspace-1",
      },
      userId: "user-1",
      workspaceId: "workspace-1",
    });

    expect(mocked.getCursorCredentialForUser).toHaveBeenCalledWith(admin, "user-1");
    expect(mocked.getClaudeCodeCredentialForUser).not.toHaveBeenCalled();
    expect(mocked.createSessionSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ agentProvider: "cursor" }),
    );
  });

  it("validates OpenCode credentials for OpenCode capability checks", async () => {
    mocked.loadWorkspaceAgentConfig.mockResolvedValueOnce({
      effort: "xhigh",
      model: "opencode/gpt-5.6-sol",
      provider: "opencode",
    });
    const { admin } = adminMock();

    await completeSandboxCapabilityCheck({
      admin: admin as never,
      checkId: "check-1",
      repository: {
        default_branch: "main",
        full_name: "acme/app",
        github_installation_id: "installation-row-1",
        id: "repo-1",
        workspace_id: "workspace-1",
      },
      userId: "user-1",
      workspaceId: "workspace-1",
    });

    expect(mocked.getOpenCodeAuthForUser).toHaveBeenCalledWith(
      admin,
      "user-1",
      "opencode/gpt-5.6-sol",
    );
    expect(mocked.createSessionSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ agentProvider: "opencode" }),
    );
  });

  it("creates the probe sandbox with workspace Vercel credentials", async () => {
    const { admin, updates } = adminMock();

    await completeSandboxCapabilityCheck({
      admin: admin as never,
      checkId: "check-1",
      repository: {
        default_branch: "main",
        full_name: "acme/app",
        github_installation_id: "installation-row-1",
        id: "repo-1",
        workspace_id: "workspace-1",
      },
      userId: "user-1",
      workspaceId: "workspace-1",
    });

    expect(mocked.octokitRequest).toHaveBeenCalledWith(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: 123,
        repositories: ["app"],
        permissions: { contents: "read" },
      },
    );
    expect(mocked.createSessionSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: { credentials, provider: "vercel", revision: "revision-1" },
      }),
    );
    expect(mocked.capabilityReportSucceeded).toHaveBeenCalledWith(
      { git: { detail: "ok", ok: true } },
      "vercel",
      "codex",
    );
    expect(updates).toContainEqual(
      expect.objectContaining({
        sandbox_id: "sandbox-1",
        sandbox_provider: "vercel",
        sandbox_vercel_project_id: "prj_123",
        sandbox_vercel_team_id: "team_123",
      }),
    );
  });

  it("records an error when Vercel Sandbox is not connected", async () => {
    mocked.loadRequiredWorkspaceSandboxConnection.mockRejectedValueOnce(
      new Error("Connect a Vercel Sandbox account before starting Wallie runs."),
    );
    const { admin, updates } = adminMock();

    const result = await completeSandboxCapabilityCheck({
      admin: admin as never,
      checkId: "check-1",
      repository: {
        default_branch: "main",
        full_name: "acme/app",
        github_installation_id: "installation-row-1",
        id: "repo-1",
        workspace_id: "workspace-1",
      },
      userId: "user-1",
      workspaceId: "workspace-1",
    });

    expect(result.status).toBe("error");
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
    expect(updates).toContainEqual(
      expect.objectContaining({
        error_text: "Connect a Vercel Sandbox account before starting Wallie runs.",
        status: "error",
      }),
    );
  });

  it("stores the Vercel response body, url, method, and status when a check fails", async () => {
    const token = "vca_1234567890abcdef";
    const response = new Response(`1x ${token}`, { status: 502 });
    Object.defineProperty(response, "url", {
      value: "https://vercel.com/api/v1/sandboxes/sb/cmd",
    });
    Object.defineProperty(response, "method", { value: "POST" });
    mocked.createSessionSandbox.mockRejectedValueOnce(
      new APIError(response, {
        message:
          "Can't parse JSON: SyntaxError: Unexpected non-whitespace character after JSON at position 1 (line 1 column 2)",
        text: `1x ${token}`,
      }),
    );
    const { admin } = adminMock();

    const result = await completeSandboxCapabilityCheck({
      admin: admin as never,
      checkId: "check-1",
      repository: {
        default_branch: "main",
        full_name: "acme/app",
        github_installation_id: "installation-row-1",
        id: "repo-1",
        workspace_id: "workspace-1",
      },
      userId: "user-1",
      workspaceId: "workspace-1",
    });

    expect(result.status).toBe("error");
    expect(result.errorText).toContain(
      "Vercel Sandbox request failed (502 POST https://vercel.com/api/v1/sandboxes/sb/cmd)",
    );
    expect(result.errorText).toContain("body: 1x [REDACTED]");
    expect(result.errorText).not.toContain(token);
  });
});
