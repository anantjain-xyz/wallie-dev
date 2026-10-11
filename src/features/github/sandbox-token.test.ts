import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("@octokit/app", () => ({
  App: vi.fn(function MockApp() {
    return { octokit: { request } };
  }),
}));
vi.mock("./config", () => ({ resolveGitHubAppConfig: () => ({}) }));

import { mintSandboxRepositoryToken } from "./sandbox-token";

beforeEach(() => {
  request.mockReset().mockResolvedValue({ data: { token: "repository-scoped-token" } });
});

describe("sandbox repository tokens", () => {
  it("limits execution to the chosen repository's code and pull requests", async () => {
    const token = await mintSandboxRepositoryToken({
      installationId: 123,
      repositoryFullName: "acme/selected-repo",
      purpose: "execution",
    });

    expect(token).toBe("repository-scoped-token");
    expect(request).toHaveBeenCalledWith(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: 123,
        repositories: ["selected-repo"],
        permissions: { contents: "write", pull_requests: "write" },
      },
    );
  });

  it("gives capability checks read-only repository access", async () => {
    await mintSandboxRepositoryToken({
      installationId: 123,
      repositoryFullName: "acme/probe-repo",
      purpose: "capability-check",
    });

    expect(request).toHaveBeenCalledWith(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: 123,
        repositories: ["probe-repo"],
        permissions: { contents: "read" },
      },
    );
  });

  it.each(["", "acme", "acme/", "/repo", "acme/repo/other", "acme/re po"])(
    "rejects invalid repository identity %j without minting a broader token",
    async (repositoryFullName) => {
      await expect(
        mintSandboxRepositoryToken({
          installationId: 123,
          repositoryFullName,
          purpose: "execution",
        }),
      ).rejects.toThrow("requires one owner/repository");
      expect(request).not.toHaveBeenCalled();
    },
  );
});
