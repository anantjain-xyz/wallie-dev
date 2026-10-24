import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../index";
import { loadSandboxProviderDriver } from "@/lib/sandbox/provider-contract";
import { SANDBOX_PROVIDER_IDS } from "@/lib/sandbox/types";
import { encryptSecretValue, decryptSecretValue } from "@/lib/secrets/crypto";
import { loginCursor, DEFAULT_LOGIN_API_KEY_TTL_MS } from "@/lib/cursor/login-native";
afterEach(() => vi.unstubAllGlobals());

describe("native worker runtime", () => {
  it.each(SANDBOX_PROVIDER_IDS)(
    "loads the complete %s SDK adapter inside workerd",
    async (provider) => {
      const driver = await loadSandboxProviderDriver(provider);
      expect(driver.create).toBeTypeOf("function");
      expect(driver.createUtility).toBeTypeOf("function");
      expect(driver.stopById).toBeTypeOf("function");
      expect(driver.hasRecoverableSource).toBeTypeOf("function");
    },
  );

  it("preserves the existing encrypted credential format", () => {
    const env = { WALLIE_ENCRYPTION_KEY: "a".repeat(64) };
    const ciphertext = encryptSecretValue("synthetic credential", env);
    expect(ciphertext.startsWith("v2.")).toBe(true);
    expect(decryptSecretValue(ciphertext, env)).toBe("synthetic credential");
  });

  it.each([false, true])(
    "runs Cursor's native auth transport with redirect=%s",
    async (redirect) => {
      const requests: Request[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          requests.push(request);
          const path = new URL(request.url).pathname;
          if (path === "/auth/poll")
            return Response.json({
              accessToken: "synthetic-access",
              refreshToken: "synthetic-refresh",
            });
          if (path.endsWith("/CreateUserApiKey"))
            return redirect
              ? new Response(null, { status: 307, headers: { Location: "https://other.test" } })
              : Response.json({ apiKey: "synthetic-api-key" });
          return Response.json({ email: "synthetic@example.test" });
        }),
      );
      const result = loginCursor({
        apiKeyName: "Wallie",
        apiKeyTtlMs: DEFAULT_LOGIN_API_KEY_TTL_MS,
        onLoginUrl: vi.fn(),
      });
      if (redirect) await expect(result).rejects.toThrow("Cursor account request failed.");
      else
        await expect(result).resolves.toEqual(
          expect.objectContaining({ apiKey: "synthetic-api-key" }),
        );
      expect(requests.every((request) => request.redirect === "manual")).toBe(true);
      expect(requests.every((request) => new URL(request.url).hostname === "api2.cursor.sh")).toBe(
        true,
      );
    },
  );

  it.each(SANDBOX_PROVIDER_IDS)("validates %s using native HTTP transport", async (provider) => {
    const fetch = vi.fn(async () =>
      Response.json(
        provider === "vercel"
          ? { sandboxes: [], pagination: { count: 0, next: null, prev: null } }
          : provider === "daytona"
            ? { items: [], total: 0, page: 1, totalPages: 1 }
            : [],
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const driver = await loadSandboxProviderDriver(provider);
    const credentials =
      provider === "vercel"
        ? { token: "synthetic-token", teamId: "team-test", projectId: "prj-test" }
        : { apiKey: provider === "e2b" ? `e2b_${"0".repeat(40)}` : "synthetic-token" };
    const result = await driver.validate({
      provider,
      credentials,
      revision: "synthetic-revision",
    } as never);
    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalled();
  });

  it("authenticates wake-ups and leaves disabled dispatch idle", async () => {
    const kick = vi.fn();
    const secret = "synthetic-test-wake-secret-32-characters";
    const env = {
      WALLIE_WORKER_WAKE_SECRET: secret,
      WALLIE_WORKER_DISPATCH_ENABLED: "false",
      DISPATCHER: { getByName: () => ({ kick }) },
    } as unknown as Env;
    expect(
      (
        await worker.fetch(
          new Request("https://worker.test/internal/wake", { method: "POST" }),
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await worker.fetch(
          new Request("https://worker.test/internal/wake", {
            method: "POST",
            headers: { Authorization: `Bearer ${secret}` },
          }),
          env,
        )
      ).status,
    ).toBe(202);
    expect(kick).not.toHaveBeenCalled();
    env.WALLIE_WORKER_DISPATCH_ENABLED = "true";
    await worker.fetch(
      new Request("https://worker.test/internal/wake", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      }),
      env,
    );
    expect(kick).toHaveBeenCalledOnce();
  });
});
