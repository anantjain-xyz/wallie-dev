import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_LOGIN_API_KEY_TTL_MS, loginCursor } from "./login-native";

afterEach(() => vi.unstubAllGlobals());

it("uses the pinned SDK challenge and Connect API-key protocol without local storage", async () => {
  const onLoginUrl = vi.fn();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh" }),
    )
    .mockResolvedValueOnce(Response.json({ apiKey: "synthetic-api-key" }))
    .mockResolvedValueOnce(Response.json({ email: "user@example.invalid" }));
  vi.stubGlobal("fetch", fetch);
  const result = await loginCursor({
    apiKeyName: "Wallie",
    apiKeyTtlMs: DEFAULT_LOGIN_API_KEY_TTL_MS,
    onLoginUrl,
  });
  const url = new URL(onLoginUrl.mock.calls[0][0]);
  const poll = JSON.parse(fetch.mock.calls[0][1].body);
  expect(url.pathname).toBe("/loginDeepControl");
  expect(url.searchParams.get("uuid")).toBe(poll.uuid);
  const digest = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(poll.verifier)),
  ).toString("base64url");
  expect(url.searchParams.get("challenge")).toBe(digest);
  expect(fetch.mock.calls[0][1].method).toBe("POST");
  expect(fetch.mock.calls[1][0]).toBe(
    "https://api2.cursor.sh/aiserver.v1.DashboardService/CreateUserApiKey",
  );
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
    name: "Wallie",
    expiresAt: String(result.apiKeyExpiresAtMs),
  });
  expect(fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer synthetic-access");
  expect(result).toMatchObject({ apiKey: "synthetic-api-key", email: "user@example.invalid" });
});

it("supports the SDK's legacy polling endpoint fallback", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('{"message":"Route POST:/auth/poll not found"}', { status: 404 }),
    )
    .mockResolvedValueOnce(
      Response.json({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh" }),
    )
    .mockResolvedValueOnce(Response.json({ apiKey: "synthetic-api-key" }))
    .mockResolvedValueOnce(Response.json({}));
  vi.stubGlobal("fetch", fetch);
  await loginCursor({ apiKeyName: "Wallie", apiKeyTtlMs: 1000, onLoginUrl: () => undefined });
  expect(fetch.mock.calls[1][1].method).toBe("GET");
  expect(new URL(fetch.mock.calls[1][0]).searchParams.has("verifier")).toBe(true);
});

it("does not poll or create credentials after cancellation", async () => {
  const controller = new AbortController();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    loginCursor({
      apiKeyName: "Wallie",
      apiKeyTtlMs: 1000,
      signal: controller.signal,
      onLoginUrl: () => controller.abort(),
    }),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps provider response bodies out of login failures", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh" }),
      )
      .mockResolvedValueOnce(new Response("private-token-and-provider-detail", { status: 403 })),
  );
  await expect(
    loginCursor({ apiKeyName: "Wallie", apiKeyTtlMs: 1000, onLoginUrl: () => undefined }),
  ).rejects.toThrow("Cursor account request failed.");
});
