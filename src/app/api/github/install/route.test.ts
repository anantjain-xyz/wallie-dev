import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  access: vi.fn(),
  config: vi.fn(),
  createFlow: vi.fn(),
  installSlug: vi.fn(),
  appUrl: "https://wallie.dev/nested?ignored=yes#fragment",
}));

vi.mock("@/env/server", () => ({
  parseServerEnv: () => ({ NEXT_PUBLIC_APP_URL: mocked.appUrl }),
}));
vi.mock("@/features/github/config", () => ({ getGitHubConfigStatus: mocked.config }));
vi.mock("@/features/github/service", () => ({ resolveGitHubInstallSlug: mocked.installSlug }));
vi.mock("@/features/github/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/github/state")>()),
  createGitHubInstallFlow: mocked.createFlow,
}));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocked.access }));

import {
  githubInstallCookieName,
  githubInstallFlowLifetimeSeconds,
  matchesGitHubStateCookie,
} from "@/features/github/state";
import { GET } from "./route";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";
const state = "s".repeat(43);
const access = {
  ok: true,
  context: { user: { id: userId }, workspace: { id: workspaceId, slug: "acme" } },
};

function request(query: Record<string, string | undefined> = {}) {
  const url = new URL("https://request-host.invalid/api/github/install");
  url.searchParams.set("workspaceId", workspaceId);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.appUrl = "https://wallie.dev/nested?ignored=yes#fragment";
  mocked.access.mockResolvedValue(access);
  mocked.config.mockReturnValue({ missingAppKeys: [] });
  mocked.installSlug.mockResolvedValue("wallie-dev");
  mocked.createFlow.mockResolvedValue(state);
});

describe("GET /api/github/install", () => {
  it.each([undefined, "", "not-a-uuid", "1", "../../another-workspace"])(
    "rejects invalid workspace ID %s before accessing a workspace",
    async (requestedWorkspaceId) => {
      const response = await GET(request({ workspaceId: requestedWorkspaceId }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
      expect(mocked.access).not.toHaveBeenCalled();
      expect(mocked.createFlow).not.toHaveBeenCalled();
      expect(response.headers.get("set-cookie")).toBeNull();
    },
  );

  it("rejects an unsupported installation source", async () => {
    const response = await GET(request({ source: "https://attacker.invalid" }));
    expect(response.status).toBe(400);
    expect(mocked.access).not.toHaveBeenCalled();
    expect(mocked.createFlow).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])("requires current manager access (HTTP %s)", async (status) => {
    mocked.access.mockResolvedValue({ ok: false, error: "Workspace access denied.", status });
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "Workspace access denied." });
    expect(mocked.access).toHaveBeenCalledWith(workspaceId, { requireManager: true });
    expect(mocked.config).not.toHaveBeenCalled();
    expect(mocked.installSlug).not.toHaveBeenCalled();
    expect(mocked.createFlow).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("reports missing OAuth configuration without starting a flow", async () => {
    mocked.config.mockReturnValue({
      missingAppKeys: ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"],
    });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "missing_config",
      error: "GitHub App installation is unavailable until server config is complete.",
      missing: ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"],
    });
    expect(mocked.installSlug).not.toHaveBeenCalled();
    expect(mocked.createFlow).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each([undefined, "settings", "onboarding"])(
    "creates an opaque server flow and matching secure cookie for source %s",
    async (source) => {
      const response = await GET(request({ source, userId: "attacker-controlled-user-id" }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(Object.keys(body)).toEqual(["installUrl"]);
      const installUrl = new URL(body.installUrl);
      expect(installUrl.origin).toBe("https://github.com");
      expect(installUrl.pathname).toBe("/apps/wallie-dev/installations/new");
      expect(Object.fromEntries(installUrl.searchParams)).toEqual({
        redirect_uri: "https://wallie.dev/api/github/callback",
        state,
      });
      expect(installUrl.toString()).not.toContain("request-host.invalid");
      expect(mocked.createFlow).toHaveBeenCalledWith({
        source: source ?? "settings",
        userId,
        workspaceId,
      });
      const cookie = response.cookies.get(githubInstallCookieName);
      expect(matchesGitHubStateCookie(installUrl.searchParams.get("state"), cookie?.value)).toBe(
        true,
      );
      expect(cookie).toMatchObject({
        httpOnly: true,
        maxAge: githubInstallFlowLifetimeSeconds,
        path: "/api/github",
        sameSite: "lax",
        secure: true,
      });
      expect(JSON.stringify(body)).not.toContain("code_verifier");
    },
  );

  it("supports a local HTTP callback while retaining HttpOnly and SameSite protections", async () => {
    mocked.appUrl = "http://localhost:3000";
    const response = await GET(request());
    const body = await response.json();
    expect(new URL(body.installUrl).searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/github/callback",
    );
    expect(response.cookies.get(githubInstallCookieName)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/api/github",
    });
  });

  it.each(["access", "installSlug", "createFlow"] as const)(
    "returns a generic credential-free failure if %s throws",
    async (operation) => {
      const privateDiagnostic =
        "ghu_PRIVATE_USER_TOKEN client_secret=PRIVATE_SECRET code=PRIVATE_CODE";
      mocked[operation].mockRejectedValueOnce(new Error(privateDiagnostic));
      const response = await GET(request());
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ error: expect.any(String) });
      expect(body).not.toContain("PRIVATE_");
      expect(body).not.toContain(privateDiagnostic);
      expect(response.headers.get("set-cookie")).toBeNull();
    },
  );
});
