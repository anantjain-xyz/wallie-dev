import { describe, expect, it, vi } from "vitest";

import { createSessionSandbox, validateSandboxConnection } from "./index";
import { getSandboxProviderContract } from "./provider-contract";
import type { SandboxProviderDriver } from "./types";

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

  it("returns an E2B validation deadline as a failed connection result", async () => {
    vi.useFakeTimers();
    const contract = getSandboxProviderContract("e2b");
    const originalLoad = contract.driver.load;
    contract.driver.load = async () =>
      ({
        validate: () => new Promise<never>(() => undefined),
      }) as unknown as SandboxProviderDriver;

    try {
      const validation = validateSandboxConnection({
        credentials: { apiKey: "e2b_secret" },
        provider: "e2b",
        revision: "validation",
      });
      await vi.advanceTimersByTimeAsync(contract.deadlines.validate);

      await expect(validation).resolves.toEqual({
        error:
          "E2B validate exceeded its 15000ms provider-contract deadline (semantic owner: bounded provider remote operations).",
        ok: false,
      });
    } finally {
      contract.driver.load = originalLoad;
      vi.useRealTimers();
    }
  });
});
