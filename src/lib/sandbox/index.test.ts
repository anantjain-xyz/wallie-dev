import { describe, expect, it } from "vitest";

import { createSessionSandbox } from "./index";

describe("sandbox provider registry", () => {
  it("fails closed when the requested implementation and connection disagree", async () => {
    await expect(
      createSessionSandbox({
        agentProvider: "codex",
        baseBranch: "main",
        branch: "wallie/test",
        connection: {
          credentials: { apiKey: "e2b_secret" },
          provider: "e2b",
          revision: "revision-1",
        },
        implementation: "vercel",
        installationToken: "github_secret",
        repoFullName: "acme/app",
        sessionId: "session-1",
      }),
    ).rejects.toThrow(/does not match the e2b workspace connection/);
  });
});
