import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  advance: vi.fn(),
  consume: vi.fn(),
  loadFlow: vi.fn(),
  access: vi.fn(),
  user: vi.fn(),
  server: vi.fn(),
  config: vi.fn(),
  authorizationUrl: vi.fn(),
  exchange: vi.fn(),
  verifyOwnership: vi.fn(),
  sync: vi.fn(),
  decrypt: vi.fn(),
  from: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  neq: vi.fn(),
}));

vi.mock("@/env/server", () => ({
  parseServerEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://wallie.dev" }),
}));
vi.mock("@/features/github/config", () => ({ getGitHubConfigStatus: mocked.config }));
vi.mock("@/features/github/oauth", () => ({
  buildGitHubAuthorizationUrl: mocked.authorizationUrl,
  exchangeGitHubAuthorizationCode: mocked.exchange,
  verifyGitHubInstallationOwnership: mocked.verifyOwnership,
}));
vi.mock("@/features/github/service", () => ({
  syncGitHubInstallationAndRepositories: mocked.sync,
}));
vi.mock("@/features/github/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/github/state")>()),
  advanceGitHubInstallFlow: mocked.advance,
  consumeGitHubInstallFlow: mocked.consume,
  loadGitHubInstallFlow: mocked.loadFlow,
}));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocked.access }));
vi.mock("@/lib/supabase/auth", () => ({ getSupabaseUserOrNull: mocked.user }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocked.server }));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ from: mocked.from }),
}));
vi.mock("@/lib/secrets/crypto", () => ({ decryptSecretValue: mocked.decrypt }));

import { githubCodeChallenge, githubInstallCookieName } from "@/features/github/state";
import { activateOnboardingGitHubStep, GET } from "./route";

const state = "s".repeat(43);
const verifier = "v".repeat(43);
const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const dummyToken = "ghu_PRIVATE_TEST_TOKEN";
const authorizationUrl = "https://github.com/login/oauth/authorize?state=opaque";
const flow = {
  state_hash: "hash-of-state",
  user_id: userId,
  workspace_id: workspaceId,
  encrypted_code_verifier: "encrypted-verifier",
  expires_at: "2099-01-01T00:00:00Z",
  phase: "authorize",
  installation_id: 71,
  source: "settings",
};
const access = {
  ok: true,
  context: { user: { id: userId }, workspace: { id: workspaceId, slug: "acme" } },
};

function request(query: Record<string, string | undefined> = {}, cookie: string | null = state) {
  const url = new URL("https://wallie.dev/api/github/callback");
  url.searchParams.set("state", state);
  url.searchParams.set("code", "oauth-code");
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  return new NextRequest(url, {
    headers: cookie === null ? {} : { Cookie: `${githubInstallCookieName}=${cookie}` },
  });
}

function expectNoPublication() {
  expect(mocked.sync).not.toHaveBeenCalled();
  expect(mocked.from).not.toHaveBeenCalled();
}

function expectRedirect(response: Response, target: string) {
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(`https://wallie.dev${target}`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toContain(`${githubInstallCookieName}=`);
  expect(cookie).toContain("Max-Age=0");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("Path=/api/github");
  expect(cookie).toContain("SameSite=lax");
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.config.mockReturnValue({ missingAppKeys: [] });
  mocked.server.mockResolvedValue({});
  mocked.user.mockResolvedValue({ id: userId });
  mocked.loadFlow.mockResolvedValue({ ...flow });
  mocked.access.mockResolvedValue(access);
  mocked.advance.mockResolvedValue(true);
  mocked.consume.mockResolvedValue(true);
  mocked.decrypt.mockReturnValue(verifier);
  mocked.authorizationUrl.mockReturnValue(authorizationUrl);
  mocked.exchange.mockResolvedValue(dummyToken);
  mocked.verifyOwnership.mockResolvedValue(undefined);
  mocked.sync.mockResolvedValue({});
  mocked.neq.mockResolvedValue({ data: null, error: null });
  mocked.eq.mockReturnValue({ neq: mocked.neq });
  mocked.update.mockReturnValue({ eq: mocked.eq });
  mocked.from.mockReturnValue({ update: mocked.update });
});

describe("GET /api/github/callback state and access checks", () => {
  it.each([
    { query: {}, cookie: null },
    { query: {}, cookie: "different-cookie" },
    { query: {}, cookie: "x".repeat(43) },
    { query: { state: undefined }, cookie: state },
    { query: { state: "" }, cookie: state },
    { query: { state: "a".repeat(42) }, cookie: "a".repeat(42) },
    { query: { state: "+".repeat(43) }, cookie: "+".repeat(43) },
  ])(
    "rejects a missing or invalid cookie/state pair before loading auth",
    async ({ query, cookie }) => {
      const response = await GET(request(query, cookie));
      expectRedirect(response, "/?github=invalid_state");
      expect(mocked.user).not.toHaveBeenCalled();
      expect(mocked.loadFlow).not.toHaveBeenCalled();
      expectNoPublication();
    },
  );

  it("requires an authenticated user even with a matching cookie", async () => {
    mocked.user.mockResolvedValue(null);
    expectRedirect(await GET(request()), "/?github=invalid_state");
    expect(mocked.loadFlow).not.toHaveBeenCalled();
    expectNoPublication();
  });

  it("loads the flow for this user and rejects missing, expired, or consumed flows", async () => {
    mocked.loadFlow.mockResolvedValue(null);
    expectRedirect(await GET(request()), "/?github=invalid_state");
    expect(mocked.loadFlow).toHaveBeenCalledWith(state, userId);
    expect(mocked.access).not.toHaveBeenCalled();
    expect(mocked.exchange).not.toHaveBeenCalled();
    expectNoPublication();
  });

  it.each([
    { ok: false, error: "Forbidden", status: 403 },
    { ok: true, context: { user: { id: "different-user" }, workspace: { slug: "acme" } } },
  ])("rejects revoked manager access or an identity mismatch", async (result) => {
    mocked.access.mockResolvedValue(result);
    expectRedirect(await GET(request()), "/?github=invalid_state");
    expect(mocked.access).toHaveBeenCalledWith(workspaceId, { requireManager: true });
    expect(mocked.consume).not.toHaveBeenCalled();
    expectNoPublication();
  });

  it("rejects a flow returned for another user", async () => {
    mocked.loadFlow.mockResolvedValue({ ...flow, user_id: "other-user" });
    expectRedirect(await GET(request()), "/?github=invalid_state");
    expect(mocked.exchange).not.toHaveBeenCalled();
    expectNoPublication();
  });

  it.each(["settings", "onboarding"])("handles missing OAuth config for %s", async (source) => {
    mocked.loadFlow.mockResolvedValue({ ...flow, source });
    mocked.config.mockReturnValue({ missingAppKeys: ["GITHUB_APP_CLIENT_SECRET"] });
    const expected =
      source === "onboarding"
        ? "/w/acme/onboarding?github=config_missing&step=github"
        : "/w/acme/settings?github=config_missing";
    expectRedirect(await GET(request()), expected);
    expect(mocked.consume).not.toHaveBeenCalled();
    expect(mocked.exchange).not.toHaveBeenCalled();
    expectNoPublication();
  });

  it("handles denied OAuth authorization without consuming or exchanging", async () => {
    expectRedirect(
      await GET(request({ error: "access_denied" })),
      "/w/acme/settings?github=failed",
    );
    expect(mocked.consume).not.toHaveBeenCalled();
    expect(mocked.exchange).not.toHaveBeenCalled();
    expectNoPublication();
  });
});

describe("installation callback first hop", () => {
  beforeEach(() => {
    mocked.loadFlow.mockResolvedValue({
      ...flow,
      phase: "install",
      installation_id: null,
      source: "onboarding",
    });
  });

  it("advances the flow and redirects to OAuth without syncing or touching onboarding", async () => {
    const response = await GET(request({ installation_id: "71", code: undefined }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(authorizationUrl);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocked.advance).toHaveBeenCalledWith(expect.objectContaining({ phase: "install" }), 71);
    expect(mocked.authorizationUrl).toHaveBeenCalledWith({
      state,
      codeChallenge: githubCodeChallenge(verifier),
    });
    expect(mocked.advance.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.authorizationUrl.mock.invocationCallOrder[0]!,
    );
    expect(mocked.consume).not.toHaveBeenCalled();
    expect(mocked.exchange).not.toHaveBeenCalled();
    expect(mocked.verifyOwnership).not.toHaveBeenCalled();
    expectNoPublication();
  });

  it.each([
    undefined,
    "",
    "0",
    "-1",
    "01",
    "+1",
    " 1",
    "1 ",
    "1.0",
    "1e2",
    "0x10",
    "71junk",
    "9007199254740992",
  ])("rejects installation ID %s with strict integer parsing", async (installationId) => {
    expectRedirect(
      await GET(request({ installation_id: installationId })),
      "/w/acme/onboarding?github=invalid_state&step=github",
    );
    expect(mocked.advance).not.toHaveBeenCalled();
    expect(mocked.authorizationUrl).not.toHaveBeenCalled();
    expectNoPublication();
  });

  it("rejects a first-hop replay that loses the phase transition", async () => {
    mocked.advance.mockResolvedValue(false);
    expectRedirect(
      await GET(request({ installation_id: "71" })),
      "/w/acme/onboarding?github=invalid_state&step=github",
    );
    expect(mocked.authorizationUrl).not.toHaveBeenCalled();
    expectNoPublication();
  });
});

describe("OAuth callback second hop", () => {
  it("uses the persisted installation ID and consumes before any OAuth exchange", async () => {
    const response = await GET(request({ installation_id: "99999" }));
    expectRedirect(response, "/w/acme/settings?github=connected");
    expect(mocked.consume).toHaveBeenCalledWith(expect.objectContaining({ installation_id: 71 }));
    expect(mocked.exchange).toHaveBeenCalledWith({ code: "oauth-code", codeVerifier: verifier });
    expect(mocked.verifyOwnership).toHaveBeenCalledWith({ installationId: 71, token: dummyToken });
    expect(mocked.sync).toHaveBeenCalledWith({ installationId: 71, workspaceId });
    expect(mocked.consume.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.exchange.mock.invocationCallOrder[0]!,
    );
    expect(mocked.exchange.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.verifyOwnership.mock.invocationCallOrder[0]!,
    );
    expect(mocked.verifyOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.sync.mock.invocationCallOrder[0]!,
    );
    expect(mocked.access).toHaveBeenCalledTimes(2);
    expect(mocked.from).not.toHaveBeenCalled();
  });

  it("prevents replay after a successful consume", async () => {
    mocked.consume.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expectRedirect(await GET(request()), "/w/acme/settings?github=connected");
    expectRedirect(await GET(request()), "/w/acme/settings?github=invalid_state");
    expect(mocked.exchange).toHaveBeenCalledTimes(1);
    expect(mocked.verifyOwnership).toHaveBeenCalledTimes(1);
    expect(mocked.sync).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "", "a".repeat(1025)])(
    "rejects missing/oversized OAuth codes before consume",
    async (code) => {
      expectRedirect(await GET(request({ code })), "/w/acme/settings?github=invalid_state");
      expect(mocked.consume).not.toHaveBeenCalled();
      expect(mocked.exchange).not.toHaveBeenCalled();
      expectNoPublication();
    },
  );

  it.each([{ phase: "invalid" }, { installation_id: null }, { installation_id: 0 }])(
    "rejects invalid flow phase or missing persisted installation",
    async (overrides) => {
      mocked.loadFlow.mockResolvedValue({ ...flow, ...overrides });
      expectRedirect(await GET(request()), "/w/acme/settings?github=invalid_state");
      expect(mocked.consume).not.toHaveBeenCalled();
      expectNoPublication();
    },
  );

  it("does not synchronize an installation when ownership verification rejects", async () => {
    mocked.verifyOwnership.mockRejectedValue(
      new Error(`inaccessible installation with token ${dummyToken}`),
    );
    const response = await GET(request());
    expectRedirect(response, "/w/acme/settings?github=failed");
    expect(response.headers.get("location")).not.toContain(dummyToken);
    expect(await response.text()).not.toContain(dummyToken);
    expect(mocked.access).toHaveBeenCalledTimes(1);
    expectNoPublication();
  });

  it.each([
    { ok: false, status: 403, error: "Manager access revoked" },
    { ok: true, context: { user: { id: "another-user" }, workspace: { slug: "acme" } } },
  ])(
    "rechecks manager access and identity after OAuth before synchronization",
    async (currentAccess) => {
      mocked.access.mockResolvedValueOnce(access).mockResolvedValueOnce(currentAccess);
      expectRedirect(await GET(request()), "/?github=invalid_state");
      expect(mocked.verifyOwnership).toHaveBeenCalled();
      expect(mocked.access).toHaveBeenCalledTimes(2);
      expectNoPublication();
    },
  );

  it("advances onboarding only after verified synchronization and preserves completed rows", async () => {
    mocked.loadFlow.mockResolvedValue({ ...flow, source: "onboarding" });
    expectRedirect(await GET(request()), "/w/acme/onboarding?github=connected&step=github");
    expect(mocked.from).toHaveBeenCalledWith("workspace_onboarding");
    expect(mocked.update).toHaveBeenCalledWith({ current_step: "github", status: "in_progress" });
    expect(mocked.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(mocked.neq).toHaveBeenCalledWith("status", "completed");
    expect(mocked.sync.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.update.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps the successful connection when a best-effort onboarding update fails", async () => {
    mocked.loadFlow.mockResolvedValue({ ...flow, source: "onboarding" });
    mocked.neq.mockRejectedValue(new Error("onboarding unavailable"));
    expectRedirect(await GET(request()), "/w/acme/onboarding?github=connected&step=github");
    expect(mocked.sync).toHaveBeenCalledOnce();
  });

  it.each(["loadFlow", "access", "consume", "decrypt", "exchange", "sync"] as const)(
    "returns a generic token-free error when %s throws",
    async (operation) => {
      const error = new Error(`private code=oauth-code secret=${dummyToken}`);
      if (operation === "decrypt")
        mocked.decrypt.mockImplementationOnce(() => {
          throw error;
        });
      else mocked[operation].mockRejectedValueOnce(error);
      const response = await GET(request());
      const destination =
        operation === "loadFlow" || operation === "access"
          ? "/?github=failed"
          : "/w/acme/settings?github=failed";
      expectRedirect(response, destination);
      expect(JSON.stringify([...response.headers])).not.toContain(dummyToken);
      expect(await response.text()).not.toContain(dummyToken);
    },
  );
});

describe("activateOnboardingGitHubStep", () => {
  it("never downgrades completed onboarding", async () => {
    await activateOnboardingGitHubStep(workspaceId);
    expect(mocked.neq).toHaveBeenCalledWith("status", "completed");
  });
});
