import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(() => ({ id: "admin" })),
  createSupabaseServerClient: vi.fn(async () => ({ id: "server" })),
  exchangeGitHubAuthorCode: vi.fn(async () => "github-user-token"),
  fetchGitHubAuthorUser: vi.fn(async () => ({
    avatar_url: "https://avatars.githubusercontent.com/u/12345?v=4",
    email: "private@example.com",
    id: 12345,
    login: "anant",
    name: "Anant Jain",
  })),
  getGitHubConfigStatus: vi.fn(() => ({
    missingAppKeys: [],
    missingAuthorKeys: [] as string[],
    missingWebhookKeys: [],
  })),
  getSupabaseUserOrNull: vi.fn(async () => ({ id: "user-1" })),
  parseServerEnv: vi.fn(() => ({
    NEXT_PUBLIC_APP_URL: "https://wallie.cc",
  })),
  upsertGitHubAuthorIdentityForUser: vi.fn(async () => ({})),
  verifyGitHubAuthorState: vi.fn(() => ({
    createdAt: "2026-05-16T18:00:00.000Z",
    source: "settings",
    userId: "user-1",
    version: 1,
    workspaceId: "workspace-1",
    workspaceSlug: "wallie",
  })),
}));

vi.mock("@/env/server", () => ({
  parseServerEnv: mocked.parseServerEnv,
}));

vi.mock("@/features/github/config", () => ({
  getGitHubConfigStatus: mocked.getGitHubConfigStatus,
}));

vi.mock("@/features/github/author-identity", () => ({
  exchangeGitHubAuthorCode: mocked.exchangeGitHubAuthorCode,
  fetchGitHubAuthorUser: mocked.fetchGitHubAuthorUser,
  upsertGitHubAuthorIdentityForUser: mocked.upsertGitHubAuthorIdentityForUser,
  verifyGitHubAuthorState: mocked.verifyGitHubAuthorState,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import { GET } from "./route";

function request(url = "http://localhost/api/github/author/callback?code=abc&state=signed") {
  return new NextRequest(url);
}

describe("GitHub author OAuth callback route", () => {
  beforeEach(() => {
    mocked.createSupabaseAdminClient.mockReturnValue({ id: "admin" });
    mocked.createSupabaseServerClient.mockResolvedValue({ id: "server" });
    mocked.exchangeGitHubAuthorCode.mockResolvedValue("github-user-token");
    mocked.fetchGitHubAuthorUser.mockResolvedValue({
      avatar_url: "https://avatars.githubusercontent.com/u/12345?v=4",
      email: "private@example.com",
      id: 12345,
      login: "anant",
      name: "Anant Jain",
    });
    mocked.getGitHubConfigStatus.mockReturnValue({
      missingAppKeys: [],
      missingAuthorKeys: [],
      missingWebhookKeys: [],
    });
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    mocked.parseServerEnv.mockReturnValue({
      NEXT_PUBLIC_APP_URL: "https://wallie.cc",
    });
    mocked.upsertGitHubAuthorIdentityForUser.mockResolvedValue({});
    mocked.verifyGitHubAuthorState.mockReturnValue({
      createdAt: "2026-05-16T18:00:00.000Z",
      source: "settings",
      userId: "user-1",
      version: 1,
      workspaceId: "workspace-1",
      workspaceSlug: "wallie",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects invalid state before touching Supabase or GitHub", async () => {
    mocked.verifyGitHubAuthorState.mockReturnValue(null as never);

    const response = await GET(request());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://wallie.cc/?github_author=invalid_state");
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocked.exchangeGitHubAuthorCode).not.toHaveBeenCalled();
  });

  it("redirects wrong signed-in users without exchanging the GitHub code", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "other-user" });

    const response = await GET(request());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://wallie.cc/w/wallie/settings?github_author=wrong_user",
    );
    expect(mocked.exchangeGitHubAuthorCode).not.toHaveBeenCalled();
  });

  it("upserts the connected GitHub user as the current user's commit author identity", async () => {
    const admin = { id: "admin" };
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    const response = await GET(request());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://wallie.cc/w/wallie/settings?github_author=connected",
    );
    expect(mocked.exchangeGitHubAuthorCode).toHaveBeenCalledWith(
      "abc",
      "https://wallie.cc/api/github/author/callback",
    );
    expect(mocked.upsertGitHubAuthorIdentityForUser).toHaveBeenCalledWith({
      admin,
      githubUser: {
        avatar_url: "https://avatars.githubusercontent.com/u/12345?v=4",
        email: "private@example.com",
        id: 12345,
        login: "anant",
        name: "Anant Jain",
      },
      userId: "user-1",
    });
  });

  it("redirects onboarding callbacks back to onboarding with setup status", async () => {
    mocked.verifyGitHubAuthorState.mockReturnValue({
      createdAt: "2026-05-16T18:00:00.000Z",
      source: "onboarding",
      userId: "user-1",
      version: 1,
      workspaceId: "workspace-1",
      workspaceSlug: "wallie",
    } as never);

    const response = await GET(request());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://wallie.cc/w/wallie/onboarding?github_author=connected&step=github",
    );
  });
});
