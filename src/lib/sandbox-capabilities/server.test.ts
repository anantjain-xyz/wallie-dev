import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSessionSandbox: vi.fn(),
  getCodexCredentialForUser: vi.fn(),
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
  getClaudeCodeCredentialForUser: vi.fn(),
}));

vi.mock("@/lib/sandbox", () => ({
  createSessionSandbox: mocked.createSessionSandbox,
}));

vi.mock("@/lib/sandbox-connections/server", () => ({
  loadRequiredWorkspaceSandboxConnection: mocked.loadRequiredWorkspaceSandboxConnection,
}));

vi.mock("@/lib/sandbox-capabilities/probe", () => ({
  capabilityReportSucceeded: vi.fn(() => true),
  probeSandboxCapabilities: mocked.probeSandboxCapabilities,
}));

import { completeSandboxCapabilityCheck, startSandboxCapabilityCheck } from "./server";

const credentials = { projectId: "prj_123", teamId: "team_123", token: "vca_secret" };

describe("startSandboxCapabilityCheck", () => {
  it("creates the running check through the workspace-locked RPC", async () => {
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
            data: {
              default_branch: "main",
              full_name: "acme/app",
              github_installation_id: "installation-row-1",
              id: "repo-1",
              workspace_id: "workspace-1",
            },
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
    });

    expect(rpc).toHaveBeenCalledWith("start_sandbox_capability_check", {
      target_github_repository_id: "repo-1",
      target_workspace_id: "workspace-1",
    });
    expect(started.check).toMatchObject({
      githubRepositoryId: "repo-1",
      id: "check-1",
      status: "running",
    });
  });
});

function adminMock() {
  const updates: unknown[] = [];
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
            update: (patch: Record<string, unknown>) => ({
              eq: () => {
                const builder = {
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
            }),
          };
        }

        throw new Error(`unexpected table: ${table}`);
      }),
    },
    updates,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.loadWorkspaceAgentConfig.mockResolvedValue({ model: "gpt-5.5", provider: "codex" });
  mocked.loadRequiredWorkspaceSandboxConnection.mockResolvedValue({
    connection: { credentials, provider: "vercel", revision: "revision-1" },
    provider: "vercel",
  });
  mocked.octokitRequest.mockResolvedValue({ data: { token: "gh-token" } });
  mocked.getCodexCredentialForUser.mockResolvedValue({ secret: "codex-token" });
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

    expect(mocked.createSessionSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: { credentials, provider: "vercel", revision: "revision-1" },
      }),
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
});
