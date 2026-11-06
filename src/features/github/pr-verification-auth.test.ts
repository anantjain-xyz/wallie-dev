import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn(), config: vi.fn(() => ({})) }));
vi.mock("./config", () => ({ resolveGitHubAppConfig: mocks.config }));
vi.mock("@octokit/app", () => ({
  App: class {
    octokit = { request: mocks.request };
  },
}));

import { mintPrVerificationToken } from "./pr-verification-auth";

const input = () => ({
  installationId: 123,
  repositoryNumericId: 456,
  signal: new AbortController().signal,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.request.mockImplementation(async (route: string) => ({
    data: route.startsWith("GET")
      ? {
          id: 123,
          suspended_at: null,
          permissions: {
            contents: "write",
            pull_requests: "write",
            metadata: "read",
            actions: "read",
            unknown: "write",
          },
        }
      : { token: "private-token" },
  }));
});

it("downscopes installed permissions to read and one numeric repository", async () => {
  const result = await mintPrVerificationToken(input());
  expect(result.token).toBe("private-token");
  expect(mocks.request).toHaveBeenLastCalledWith(
    "POST /app/installations/{installation_id}/access_tokens",
    expect.objectContaining({
      installation_id: 123,
      repository_ids: [456],
      permissions: { contents: "read", pull_requests: "read", metadata: "read", actions: "read" },
    }),
  );
});

it.each([
  { id: 999, suspended_at: null },
  { id: 123, suspended_at: "2026-11-06T00:00:00Z" },
])("never mints credentials for mismatched or suspended installations", async (installation) => {
  mocks.request.mockResolvedValue({ data: { ...installation, permissions: {} } });
  await expect(mintPrVerificationToken(input())).rejects.toMatchObject({
    code: "github_installation_unavailable",
  });
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("rejects invalid identity and aborts before issuing a request", async () => {
  await expect(mintPrVerificationToken({ ...input(), repositoryNumericId: 0 })).rejects.toThrow(
    "identity",
  );
  await expect(
    mintPrVerificationToken({ ...input(), signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(mocks.request).not.toHaveBeenCalled();
});

it.each([
  [401, "github_installation_unavailable"],
  [404, "github_installation_unavailable"],
  [403, "github_permission_missing"],
  [429, "github_rate_limited"],
  [500, "github_auth_unavailable"],
])("records a safe access failure for HTTP %s", async (status, code) => {
  mocks.request.mockRejectedValue({ status, message: "private provider body" });
  await expect(mintPrVerificationToken(input())).rejects.toMatchObject({ code });
  await expect(mintPrVerificationToken(input())).rejects.not.toThrow("private provider body");
});

it("recognizes rate-limited installation requests without exposing provider responses", async () => {
  mocks.request.mockRejectedValue({
    status: 403,
    response: { headers: { "x-ratelimit-remaining": "0" } },
  });
  await expect(mintPrVerificationToken(input())).rejects.toMatchObject({
    code: "github_rate_limited",
  });
});
