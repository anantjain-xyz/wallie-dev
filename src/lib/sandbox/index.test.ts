import { describe, expect, it, vi } from "vitest";

import {
  createSessionSandbox,
  hasRecoverableSandboxSource,
  validateSandboxConnection,
} from "./index";
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

describe("retained source inspection boundary", () => {
  it("bounds provider reads and redacts connection secrets", async () => {
    const contract = getSandboxProviderContract("e2b");
    const originalLoad = contract.driver.load;
    const inspect = vi.fn().mockRejectedValue(new Error("Rejected e2b-secret"));
    contract.driver.load = async () =>
      ({ hasRecoverableSource: inspect }) as unknown as SandboxProviderDriver;
    const connection = {
      provider: "e2b" as const,
      revision: "revision-1",
      credentials: { apiKey: "e2b-secret" },
    };
    try {
      await expect(hasRecoverableSandboxSource("sandbox-1", connection)).rejects.toThrow(
        "Rejected [REDACTED]",
      );
      vi.useFakeTimers();
      inspect.mockImplementation(() => new Promise<never>(() => undefined));
      const outcome = hasRecoverableSandboxSource("sandbox-1", connection).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(contract.deadlines.hasRecoverableSource);
      expect(await outcome).toEqual(
        expect.objectContaining({ name: "SandboxProviderDeadlineError" }),
      );
    } finally {
      contract.driver.load = originalLoad;
      vi.useRealTimers();
    }
  });
});
