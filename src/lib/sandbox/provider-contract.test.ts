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
        cursor: [],
        opencode: [],
      });
    },
  );
});

describe("sandbox provider lifecycle contract", () => {
  it("rejects caller cancellation immediately and stops a provider's late acquisition", async () => {
    const controller = new AbortController();
    let finish!: (handle: SandboxHandle) => void;
    const stop = vi.fn().mockResolvedValue(undefined);
    const started = vi.fn();
    const pending = runBoundedSandboxProviderOperation({
      provider: "e2b",
      operation: "acquire",
      signal: controller.signal,
      run: () => {
        started();
        return new Promise<SandboxHandle>((resolve) => {
          finish = resolve;
        });
      },
      onLateSuccess: (handle) => handle.stop(),
    });
    await Promise.resolve();
    expect(started).toHaveBeenCalledOnce();
    const error = new Error("attempt expired");
    const rejected = expect(pending).rejects.toBe(error);
    controller.abort(error);
    await rejected;
    finish({ stop } as unknown as SandboxHandle);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it("does not begin setup or publish an already canceled acquisition", async () => {
    const controller = new AbortController();
    controller.abort(new Error("expired before acquisition"));
    const onSandboxCreated = vi.fn();
    const stop = vi.fn().mockResolvedValue(undefined);
    await expect(
      finalizeSandboxAcquisition({
        handle: { stop } as unknown as SandboxHandle,
        provider: "e2b",
        repoAlreadyCloned: false,
        request: {
          agentProvider: "codex",
          baseBranch: "main",
          branch: "work",
          installationToken: "gh",
          repoFullName: "acme/app",
          sessionId: "s",
          signal: controller.signal,
          onSandboxCreated,
        },
      }),
    ).rejects.toThrow("expired before acquisition");
    expect(onSandboxCreated).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });
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

  it("stops an acquired sandbox while its setup ignores cancellation", async () => {
    let finish!: () => void;
    let started!: () => void;
    const preparing = new Promise<void>((resolve) => {
      started = resolve;
    });
    mockedPrepareSessionSandbox.mockImplementationOnce(() => {
      started();
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const controller = new AbortController();
    const stop = vi.fn().mockResolvedValue(undefined);
    const pending = finalizeSandboxAcquisition({
      handle: { stop } as unknown as SandboxHandle,
      provider: "e2b",
      repoAlreadyCloned: false,
      request: {
        agentProvider: "codex",
        baseBranch: "main",
        branch: "work",
        installationToken: "gh",
        repoFullName: "acme/app",
        sessionId: "s",
        signal: controller.signal,
      },
    });
    await preparing;
    const rejected = expect(pending).rejects.toThrow("attempt expired");
    controller.abort(new Error("attempt expired"));
    expect(stop).toHaveBeenCalledOnce();
    finish();
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
  });
});
