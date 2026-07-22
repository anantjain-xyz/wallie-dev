import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  decryptSecretValue: vi.fn((value: string) => `decrypted:${value}`),
  loadConnectedVercelSandboxConnections: vi.fn(),
}));

vi.mock("@/lib/secrets/crypto", () => ({
  buildSecretPreview: vi.fn(),
  decryptSecretValue: mocked.decryptSecretValue,
  encryptSecretValue: vi.fn(),
}));

vi.mock("@/lib/vercel-sandbox/server", () => ({
  loadConnectedVercelSandboxConnections: mocked.loadConnectedVercelSandboxConnections,
  loadVercelSandboxConnection: vi.fn(),
  loadVercelSandboxConnectionPreview: vi.fn(),
}));

import { loadAllConnectedSandboxConnections } from "./server";

const previousAllowlist = process.env.WALLIE_DAYTONA_API_URL_ALLOWLIST;

beforeEach(() => {
  delete process.env.WALLIE_DAYTONA_API_URL_ALLOWLIST;
  mocked.loadConnectedVercelSandboxConnections.mockResolvedValue([
    {
      credentials: { projectId: "project-1", teamId: "team-1", token: "vercel-secret" },
      preview: {
        connectionRevision: "vercel-revision-1",
        workspaceId: "workspace-vercel",
      },
    },
  ]);
});

afterEach(() => {
  if (previousAllowlist === undefined) delete process.env.WALLIE_DAYTONA_API_URL_ALLOWLIST;
  else process.env.WALLIE_DAYTONA_API_URL_ALLOWLIST = previousAllowlist;
  vi.restoreAllMocks();
});

describe("loadAllConnectedSandboxConnections", () => {
  it("skips a Daytona row rejected by the current allowlist without aborting other providers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const admin = {
      from: vi.fn((table: string) => ({
        select: () => ({
          eq: async () => ({
            data:
              table === "workspace_daytona_sandbox_connections"
                ? [
                    {
                      api_url: "https://old-daytona.example/api",
                      connection_revision: "invalid-revision",
                      encrypted_api_key: "invalid-key",
                      target: null,
                      workspace_id: "workspace-invalid",
                    },
                    {
                      api_url: "https://app.daytona.io/api",
                      connection_revision: "valid-revision",
                      encrypted_api_key: "valid-key",
                      target: "cloud",
                      workspace_id: "workspace-daytona",
                    },
                  ]
                : [],
            error: null,
          }),
        }),
      })),
    };

    const connections = await loadAllConnectedSandboxConnections(admin as never);

    expect(connections).toEqual([
      {
        connection: {
          credentials: {
            projectId: "project-1",
            teamId: "team-1",
            token: "vercel-secret",
          },
          provider: "vercel",
          revision: "vercel-revision-1",
        },
        workspaceId: "workspace-vercel",
      },
      {
        connection: {
          credentials: {
            apiKey: "decrypted:valid-key",
            apiUrl: "https://app.daytona.io/api",
            target: "cloud",
          },
          provider: "daytona",
          revision: "valid-revision",
        },
        workspaceId: "workspace-daytona",
      },
    ]);
    expect(warn).toHaveBeenCalledWith("[sandbox-reaper] skipping invalid Daytona connection", {
      error: "Daytona API URL is not allowed by this Wallie deployment.",
      workspaceId: "workspace-invalid",
    });
  });
});
