import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGitHubAuthorizationUrl,
  exchangeGitHubAuthorizationCode,
  verifyGitHubInstallationOwnership,
} from "@/features/github/oauth";

const testEnv = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_CLIENT_ID: "Iv1.audit-client",
  GITHUB_APP_CLIENT_SECRET: "audit-client-secret",
  NEXT_PUBLIC_APP_URL: "https://wallie.dev/nested?ignored=yes#fragment",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "supabase-publishable-key",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "secret-key",
  WALLIE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};
const token = "ghu_audit-user-token";
const codeVerifier = "a".repeat(43);
const codeChallenge = "b".repeat(43);
const fetchMock = vi.fn<typeof fetch>();
const authorizationError = "GitHub authorization could not be completed. Start connecting again.";
const ownershipError = "GitHub installation ownership could not be verified.";

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function installation(overrides: Record<string, unknown> = {}) {
  return {
    id: 71,
    app_id: 12345,
    account: { id: 10, login: "personal-owner", type: "User" },
    target_type: "User",
    suspended_at: null,
    ...overrides,
  };
}

function organizationInstallation(overrides: Record<string, unknown> = {}) {
  return installation({
    account: { id: 20, login: "example-org", type: "Organization" },
    target_type: "Organization",
    ...overrides,
  });
}

function membership(overrides: Record<string, unknown> = {}) {
  return {
    role: "admin",
    state: "active",
    organization: { id: 20 },
    user: { id: 10 },
    ...overrides,
  };
}

function userThenInstallations(installations: unknown[], totalCount = installations.length) {
  fetchMock.mockResolvedValueOnce(json({ id: 10, type: "User" }));
  fetchMock.mockResolvedValueOnce(json({ installations, total_count: totalCount }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHub OAuth authorization", () => {
  it("uses the configured canonical callback with state and S256 PKCE", () => {
    const state = "signed-state+with&characters";
    const url = new URL(buildGitHubAuthorizationUrl({ state, codeChallenge }, testEnv));
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: testEnv.GITHUB_APP_CLIENT_ID,
      redirect_uri: "https://wallie.dev/api/github/callback",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    expect(url.toString()).not.toContain(testEnv.GITHUB_APP_CLIENT_SECRET);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { state: "", codeChallenge },
    { state: "a".repeat(4097), codeChallenge },
    { state: "state", codeChallenge: "too-short" },
    { state: "state", codeChallenge: "+".repeat(43) },
  ])("rejects invalid state/PKCE data without starting authorization", (request) => {
    expect(() => buildGitHubAuthorizationUrl(request, testEnv)).toThrow(authorizationError);
  });

  it.each(["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_ID"])(
    "requires configured %s",
    (key) => {
      expect(() =>
        buildGitHubAuthorizationUrl({ state: "state", codeChallenge }, { ...testEnv, [key]: "" }),
      ).toThrow("GitHub OAuth is not configured.");
    },
  );

  it.each(["not-a-number", "0", "-1", "1.2", "9007199254740992"])(
    "rejects invalid configured App ID %s",
    (appId) => {
      expect(() =>
        buildGitHubAuthorizationUrl(
          { state: "state", codeChallenge },
          { ...testEnv, GITHUB_APP_ID: appId },
        ),
      ).toThrow("GitHub OAuth is not configured.");
    },
  );
});

describe("GitHub OAuth code exchange", () => {
  it("exchanges the code using a form POST and returns only the access token", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        access_token: token,
        token_type: "bearer",
        refresh_token: "discard-this-refresh-token",
      }),
    );
    const code = "code+with&special=characters";
    await expect(exchangeGitHubAuthorizationCode({ code, codeVerifier }, testEnv)).resolves.toBe(
      token,
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      client_id: testEnv.GITHUB_APP_CLIENT_ID,
      client_secret: testEnv.GITHUB_APP_CLIENT_SECRET,
      redirect_uri: "https://wallie.dev/api/github/callback",
      code,
      code_verifier: codeVerifier,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    null,
    [],
    {},
    { access_token: token },
    { access_token: token, token_type: "basic" },
    { access_token: "", token_type: "bearer" },
    { access_token: 123, token_type: "bearer" },
    { access_token: "a\r\nAuthorization: other", token_type: "bearer" },
    { access_token: "a".repeat(8193), token_type: "bearer" },
    { access_token: token, token_type: "bearer", error: "bad_verification_code" },
    { error: "bad_verification_code", error_description: "secret provider diagnostic" },
  ])("fails closed on an invalid token response", async (body) => {
    fetchMock.mockResolvedValueOnce(json(body));
    await expect(
      exchangeGitHubAuthorizationCode({ code: "code", codeVerifier }, testEnv),
    ).rejects.toThrow(authorizationError);
  });

  it.each([301, 400, 401, 403, 429, 500])(
    "rejects HTTP %s without leaking provider details",
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        json({ error: `${token} ${testEnv.GITHUB_APP_CLIENT_SECRET}` }, status),
      );
      await expect(
        exchangeGitHubAuthorizationCode({ code: "code", codeVerifier }, testEnv),
      ).rejects.toThrow(new Error(authorizationError));
    },
  );

  it("does not expose token-bearing fetch exceptions or log them", async () => {
    const log = vi.spyOn(console, "error");
    fetchMock.mockRejectedValueOnce(
      new Error(`request failed: ${testEnv.GITHUB_APP_CLIENT_SECRET} ${token}`),
    );
    await expect(
      exchangeGitHubAuthorizationCode({ code: "code", codeVerifier }, testEnv),
    ).rejects.toThrow(new Error(authorizationError));
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not JSON"));
    await expect(
      exchangeGitHubAuthorizationCode({ code: "code", codeVerifier }, testEnv),
    ).rejects.toThrow(authorizationError);
  });

  it("bounds network requests and returns a generic timeout failure", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    fetchMock.mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error(`timeout ${token}`)), {
            once: true,
          });
        }),
    );
    const result = exchangeGitHubAuthorizationCode({ code: "code", codeVerifier }, testEnv);
    controller.abort();
    await expect(result).rejects.toThrow(new Error(authorizationError));
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it.each([
    { code: "", codeVerifier },
    { code: " ", codeVerifier },
    { code: "a".repeat(4097), codeVerifier },
    { code: "code", codeVerifier: "short" },
    { code: "code", codeVerifier: "a".repeat(129) },
    { code: "code", codeVerifier: "+".repeat(43) },
  ])("rejects invalid exchange inputs before a network request", async (request) => {
    await expect(exchangeGitHubAuthorizationCode(request, testEnv)).rejects.toThrow(
      authorizationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GitHub installation ownership", () => {
  it("accepts the authenticated user's personal installation", async () => {
    userThenInstallations([installation()]);
    await expect(
      verifyGitHubInstallationOwnership({ installationId: 71, token }, testEnv),
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/user/installations?per_page=100&page=1",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        method: "GET",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10",
        },
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("rejects an inaccessible/arbitrary installation even if the user owns another", async () => {
    userThenInstallations([installation()]);
    await expect(
      verifyGitHubInstallationOwnership({ installationId: 9999, token }, testEnv),
    ).rejects.toThrow(ownershipError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an accessible personal installation belonging to someone else", async () => {
    userThenInstallations([
      installation({ account: { id: 99, login: "someone-else", type: "User" } }),
    ]);
    await expect(
      verifyGitHubInstallationOwnership({ installationId: 71, token }, testEnv),
    ).rejects.toThrow(ownershipError);
  });

  it.each([
    { app_id: 999 },
    { suspended_at: "2026-01-01T00:00:00Z" },
    { target_type: "Organization" },
    { target_type: "Enterprise", account: { id: 10, login: "enterprise", type: "Enterprise" } },
  ])("rejects app mismatch, suspension, and unsupported target types", async (overrides) => {
    userThenInstallations([installation(overrides)]);
    await expect(
      verifyGitHubInstallationOwnership({ installationId: 71, token }, testEnv),
    ).rejects.toThrow(ownershipError);
  });

  it("accepts an active organization owner and verifies membership identity", async () => {
    userThenInstallations([organizationInstallation()]);
    fetchMock.mockResolvedValueOnce(json(membership()));
    await expect(
      verifyGitHubInstallationOwnership({ installationId: 71, token }, testEnv),
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://api.github.com/user/memberships/orgs/example-org",
    );
  });

  it.each([
    { role: "member" },
    { role: "billing_manager" },
    { state: "pending" },
    { state: "inactive" },
    { organization: { id: 99 } },
    { user: { id: 99 } },
    { user: null },
    { role: undefined },
  ])(
    "rejects ordinary members, pending owners, and invalid membership bodies",
    async (overrides) => {
      userThenInstallations([organizationInstallation()]);
      fetchMock.mockResolvedValueOnce(json(membership(overrides)));
      await expect(
        verifyGitHubInstallationOwnership({ installationId: 71, token }, testEnv),
      ).rejects.toThrow(ownershipError);
    },
  );

  it.each(["../other", "..", "org?token=stolen", "org/#fragment", "https://attacker.invalid"])(
    "rejects an invalid organization login without using it as an endpoint: %s",
    async (login) => {
      userThenInstallations([
        organizationInstallation({ account: { id: 20, type: "Organization", login } }),
      ]);
      await expect(
        verifyGitHubInstallationOwnership({ installationId: 71, token }, testEnv),
      ).rejects.toThrow(ownershipError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("paginates on the fixed API origin without following an arbitrary Link URL", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => installation({ id: index + 1000 }));
    fetchMock.mockResolvedValueOnce(json({ id: 10, type: "User" }));
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { total_count: 101, installations: firstPage },
        { headers: { Link: '<https://attacker.invalid/steal>; rel="next"' } },
      ),
    );
    fetchMock.mockResolvedValueOnce(json({ total_count: 101, installations: [installation()] }));
    await expect(
      verifyGitHubInstallationOwnership({ installationId: 71, token }, testEnv),
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://api.github.com/user/installations?per_page=100&page=2",
    );
    expect(
      fetchMock.mock.calls.every(([url]) => String(url).startsWith("https://api.github.com/")),
    ).toBe(true);
  });

  it("fails closed when the bounded installation pagination is exhausted", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => installation({ id: index + 1000 }));
    fetchMock.mockResolvedValueOnce(json({ id: 10, type: "User" }));
    fetchMock.mockImplementation(async () =>
      json({ total_count: 10001, installations: firstPage }),
    );
    await expect(
      verifyGitHubInstallationOwnership({ installationId: 71, token }, testEnv),
    ).rejects.toThrow(ownershipError);
    expect(fetchMock).toHaveBeenCalledTimes(101);
  });

  it.each([null, [], {}, { id: "10", type: "User" }, { id: 10, type: "Bot" }])(
    "rejects malformed authenticated user data",
    async (body) => {
      fetchMock.mockResolvedValueOnce(json(body));
      await expect(
        verifyGitHubInstallationOwnership({ installationId: 71, token }, testEnv),
      ).rejects.toThrow(ownershipError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    null,
    [],
    {},
    { total_count: 1, installations: [null] },
    { total_count: "1", installations: [installation()] },
    { total_count: 1, installations: [installation({ suspended_at: undefined })] },
    { total_count: 1, installations: [installation({ account: null })] },
    { total_count: 1, installations: [installation({ id: "71" })] },
  ])("rejects malformed installation data", async (body) => {
    fetchMock.mockResolvedValueOnce(json({ id: 10, type: "User" }));
    fetchMock.mockResolvedValueOnce(json(body));
    await expect(
      verifyGitHubInstallationOwnership({ installationId: 71, token }, testEnv),
    ).rejects.toThrow(ownershipError);
  });

  it.each([301, 401, 403, 404, 429, 500])("fails closed on membership HTTP %s", async (status) => {
    userThenInstallations([organizationInstallation()]);
    fetchMock.mockResolvedValueOnce(json({ message: `provider token: ${token}` }, status));
    await expect(
      verifyGitHubInstallationOwnership({ installationId: 71, token }, testEnv),
    ).rejects.toThrow(new Error(ownershipError));
  });

  it("does not expose token-bearing network exceptions", async () => {
    fetchMock.mockRejectedValueOnce(new Error(`Authorization: Bearer ${token}`));
    await expect(
      verifyGitHubInstallationOwnership({ installationId: 71, token }, testEnv),
    ).rejects.toThrow(new Error(ownershipError));
  });

  it("applies a total verification deadline as well as a request deadline", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    userThenInstallations([installation()]);
    await verifyGitHubInstallationOwnership({ installationId: 71, token }, testEnv);
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe installation ID %s before network access",
    async (installationId) => {
      await expect(
        verifyGitHubInstallationOwnership({ installationId, token }, testEnv),
      ).rejects.toThrow(ownershipError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["", "token with spaces", "token\r\nInjected: header"])(
    "rejects invalid token inputs before building a header",
    async (invalidToken) => {
      await expect(
        verifyGitHubInstallationOwnership({ installationId: 71, token: invalidToken }, testEnv),
      ).rejects.toThrow(ownershipError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
