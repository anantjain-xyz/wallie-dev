import { generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("signs a GitHub App JWT with GitHub's PKCS#1 key format and mints a repository-scoped token in workerd", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  for (const [key, value] of Object.entries({
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: pem,
    NEXT_PUBLIC_APP_URL: "https://example.test",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
    SUPABASE_SECRET_KEY: "synthetic-service-key",
    WALLIE_ENCRYPTION_KEY: "a".repeat(64),
    WALLIE_DEPLOY_ENV: "development",
  }))
    vi.stubEnv(key, value);
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      expect(new URL(request.url).pathname).toBe("/app/installations/456/access_tokens");
      expect(request.headers.get("Authorization")).toMatch(/^bearer [^.]+\.[^.]+\.[^.]+$/i);
      expect(await request.json()).toEqual({
        repository_ids: [789],
        permissions: { contents: "write", pull_requests: "write" },
      });
      return Response.json({
        token: "synthetic-repository-token",
        expires_at: "2099-01-01T00:00:00Z",
      });
    }),
  );
  expect(
    await mintSandboxRepositoryToken({
      installationId: 456,
      repositoryId: 789,
      repositoryFullName: "example/repo",
      purpose: "execution",
    }),
  ).toBe("synthetic-repository-token");
  expect(requests).toHaveLength(1);
});
