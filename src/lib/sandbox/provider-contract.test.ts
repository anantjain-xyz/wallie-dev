import { describe, expect, it, vi } from "vitest";

vi.mock("./setup", () => ({ prepareSessionSandbox: vi.fn() }));

import {
  COMPLETE_PROVIDER_REGISTRY_FIXTURE,
  INCOMPLETE_PROVIDER_IDS_FIXTURE,
  INCOMPLETE_PROVIDER_REGISTRY_FIXTURE,
} from "./provider-contract.fixtures";
import {
  PROVIDER_CONTRACT_SEMANTIC_OWNERS,
  SANDBOX_PROVIDER_CONTRACTS,
  verifySandboxProviderContracts,
} from "./provider-contract";
import {
  finalizeSandboxAcquisition,
  runBoundedSandboxProviderOperation,
  SandboxProviderDeadlineError,
} from "./lifecycle";
import { prepareSessionSandbox } from "./setup";
import { SANDBOX_PROVIDER_IDS, type SandboxHandle } from "./types";

const mockedPrepareSessionSandbox = vi.mocked(prepareSessionSandbox);

describe("sandbox provider contract verifier", () => {
  it("accepts the exhaustive canonical registry and positive fixture", () => {
    expect(
      verifySandboxProviderContracts(SANDBOX_PROVIDER_CONTRACTS, SANDBOX_PROVIDER_IDS),
    ).toEqual([]);
    expect(
      verifySandboxProviderContracts(COMPLETE_PROVIDER_REGISTRY_FIXTURE, SANDBOX_PROVIDER_IDS),
    ).toEqual([]);
  });

  it("diagnoses the exact missing field and semantic owner for an incomplete provider", () => {
    const diagnostics = verifySandboxProviderContracts(
      INCOMPLETE_PROVIDER_REGISTRY_FIXTURE,
      INCOMPLETE_PROVIDER_IDS_FIXTURE,
    );

    expect(diagnostics).toContainEqual({
      message:
        'Sandbox provider "incomplete" is missing contract field "cleanup" (semantic owner: sandbox lifecycle cleanup).',
      owner: PROVIDER_CONTRACT_SEMANTIC_OWNERS.cleanup,
      path: "cleanup",
      provider: "incomplete",
    });
    expect(diagnostics).toContainEqual({
      message:
        'Sandbox provider "incomplete" is missing contract field "cleanup.acquisitionFailure" (semantic owner: sandbox acquisition failure cleanup).',
      owner: PROVIDER_CONTRACT_SEMANTIC_OWNERS["cleanup.acquisitionFailure"],
      path: "cleanup.acquisitionFailure",
      provider: "incomplete",
    });
  });

  it("rejects missing tagged states instead of treating optional capabilities as absent", () => {
    const invalid = {
      ...SANDBOX_PROVIDER_CONTRACTS,
      e2b: {
        ...SANDBOX_PROVIDER_CONTRACTS.e2b,
        reaper: {},
      },
    };

    expect(verifySandboxProviderContracts(invalid, SANDBOX_PROVIDER_IDS)).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          'must declare "reaper" as supported or unsupported (semantic owner: orphan sandbox recovery)',
        ),
        owner: "orphan sandbox recovery",
        path: "reaper",
        provider: "e2b",
      }),
    );
  });

  it("keeps Daytona deletion inside its provider-contract deadline", () => {
    expect(SANDBOX_PROVIDER_CONTRACTS.daytona.deadlines.stopById).toBeGreaterThan(60_000);
  });

  it("reserves setup time after Daytona's maximum provisioning window", () => {
    const acquireDeadline = SANDBOX_PROVIDER_CONTRACTS.daytona.deadlines.acquire;
    const maximumProvisioningTime = 30 * 60_000;

    expect(acquireDeadline - maximumProvisioningTime).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it.each(SANDBOX_PROVIDER_IDS)(
    "declares agent-specific capability requirements for %s",
    (provider) => {
      expect(SANDBOX_PROVIDER_CONTRACTS[provider].capabilityProbes.requiredByAgent).toEqual({
        "claude-code": [],
        codex: ["codexExternalSandbox"],
      });
    },
  );
});

describe("sandbox provider lifecycle contract", () => {
  it.each(SANDBOX_PROVIDER_IDS)(
    "cleans up an acquired %s sandbox when publication fails",
    async (provider) => {
      const originalError = new Error("ownership publication failed");
      const handle = {
        id: `${provider}-sandbox`,
        stop: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxHandle;
      const onSandboxCreated = vi.fn().mockRejectedValue(originalError);

      await expect(
        finalizeSandboxAcquisition({
          handle,
          provider,
          repoAlreadyCloned: provider === "vercel",
          request: {
            agentProvider: "codex",
            baseBranch: "main",
            branch: "wallie/test",
            installationToken: "gh-secret",
            onSandboxCreated,
            repoFullName: "acme/app",
            sessionId: "session-1",
          },
        }),
      ).rejects.toBe(originalError);

      expect(handle.stop).toHaveBeenCalledTimes(1);
      expect(mockedPrepareSessionSandbox).not.toHaveBeenCalled();
    },
  );

  it.each(["acquire", "validate", "listRunning", "stopById"] as const)(
    "bounds the %s remote operation with its declared deadline",
    async (operation) => {
      vi.useFakeTimers();
      try {
        const result = runBoundedSandboxProviderOperation({
          operation,
          provider: "e2b",
          run: () => new Promise<never>(() => undefined),
          timeoutMs: 25,
        });
        const rejection = result.catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(25);
        const error = await rejection;
        expect(error).toBeInstanceOf(SandboxProviderDeadlineError);
        expect(error).toEqual(
          expect.objectContaining({ operation, provider: "e2b", timeoutMs: 25 }),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("stops an acquisition that resolves after its deadline", async () => {
    vi.useFakeTimers();
    try {
      let resolveAcquisition!: (handle: SandboxHandle) => void;
      const lateHandle = {
        stop: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxHandle;
      const acquisition = new Promise<SandboxHandle>((resolve) => {
        resolveAcquisition = resolve;
      });
      const result = runBoundedSandboxProviderOperation({
        onLateSuccess: (handle) => handle.stop(),
        operation: "acquire",
        provider: "daytona",
        run: () => acquisition,
        timeoutMs: 25,
      });
      const rejection = result.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(25);
      expect(await rejection).toBeInstanceOf(SandboxProviderDeadlineError);
      resolveAcquisition(lateHandle);
      await vi.waitFor(() => expect(lateHandle.stop).toHaveBeenCalledTimes(1));
    } finally {
      vi.useRealTimers();
    }
  });
});
