import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createGitHubAuthorState: vi.fn(() => "signed-author-state"),
  getGitHubConfigStatus: vi.fn(() => ({
    missingAppKeys: [],
    missingAuthorKeys: [] as string[],
    missingWebhookKeys: [],
  })),
  parseServerEnv: vi.fn(() => ({
    NEXT_PUBLIC_APP_URL: "https://wallie.cc",
  })),
  requireWorkspaceAccessById: vi.fn(),
  resolveGitHubAuthorOAuthConfig: vi.fn(() => ({
    clientId: "github-client-id",
    clientSecret: "github-client-secret",
  })),
}));

vi.mock("@/env/server", () => ({
  parseServerEnv: mocked.parseServerEnv,
}));

vi.mock("@/features/github/config", () => ({
  getGitHubConfigStatus: mocked.getGitHubConfigStatus,
  resolveGitHubAuthorOAuthConfig: mocked.resolveGitHubAuthorOAuthConfig,
}));

vi.mock("@/features/github/author-identity", () => ({
  createGitHubAuthorState: mocked.createGitHubAuthorState,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { GET } from "./route";

const workspaceId = "00000000-0000-4000-8000-000000000001";

function request(url = `http://localhost/api/github/author?workspaceId=${workspaceId}`) {
  return new NextRequest(url);
}

function grantAccess() {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      user: { id: "user-1" },
      workspace: { id: workspaceId, name: "Wallie", slug: "wallie" },
    },
    ok: true,
  });
}

describe("GitHub author OAuth start route", () => {
  beforeEach(() => {
    mocked.createGitHubAuthorState.mockReturnValue("signed-author-state");
    mocked.getGitHubConfigStatus.mockReturnValue({
      missingAppKeys: [],
      missingAuthorKeys: [],
      missingWebhookKeys: [],
    });
    mocked.parseServerEnv.mockReturnValue({
      NEXT_PUBLIC_APP_URL: "https://wallie.cc",
    });
    mocked.resolveGitHubAuthorOAuthConfig.mockReturnValue({
      clientId: "github-client-id",
      clientSecret: "github-client-secret",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns missing config when the GitHub App user OAuth keys are absent", async () => {
    grantAccess();
    mocked.getGitHubConfigStatus.mockReturnValue({
      missingAppKeys: [],
      missingAuthorKeys: ["GITHUB_APP_CLIENT_ID"],
      missingWebhookKeys: [],
    });

    const response = await GET(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "missing_config",
      error: "GitHub author connection is unavailable until server config is complete.",
      missing: ["GITHUB_APP_CLIENT_ID"],
    });
  });

  it("returns a signed GitHub user authorization URL for the current workspace user", async () => {
    grantAccess();

    const response = await GET(
      request(`http://localhost/api/github/author?workspaceId=${workspaceId}&source=onboarding`),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizeUrl: string };
    const authorizeUrl = new URL(body.authorizeUrl);

    expect(authorizeUrl.origin).toBe("https://github.com");
    expect(authorizeUrl.pathname).toBe("/login/oauth/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("github-client-id");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://wallie.cc/api/github/author/callback",
    );
    expect(authorizeUrl.searchParams.get("state")).toBe("signed-author-state");
    expect(authorizeUrl.searchParams.get("prompt")).toBe("select_account");
    expect(mocked.createGitHubAuthorState).toHaveBeenCalledWith({
      source: "onboarding",
      userId: "user-1",
      workspaceId,
      workspaceSlug: "wallie",
    });
  });
});
