import { describe, expect, it, vi } from "vitest";

import { checkoutSandboxCheckpoint } from "./checkout";
import { prepareSessionSandbox } from "./setup";
import type { CreateSessionSandboxInput, SandboxExecHandle, SandboxHandle } from "./types";

const request = {
  agentProvider: "codex",
  baseBranch: "main",
  branch: "wallie/checkpoint-diagnostics",
  installationToken: "secret-installation-token",
  mode: { kind: "checkpoint", sha: "a".repeat(40) },
  repoFullName: "acme/app",
  sessionId: "session-1",
} satisfies CreateSessionSandboxInput;

function failedSandbox(exitCode: number) {
  const exec = vi.fn<SandboxHandle["exec"]>(
    async () =>
      ({
        exitCode: Promise.resolve(exitCode),
        kill: vi.fn(),
        logs: async function* () {},
        output: async () => ({
          stderr: request.installationToken,
          stdout: request.installationToken,
        }),
      }) satisfies SandboxExecHandle,
  );
  const handle = {
    exec,
    id: "sandbox-1",
    readFile: vi.fn(),
    repoPath: "/vercel/sandbox",
    stop: vi.fn(),
    writeFile: vi.fn(),
  } satisfies SandboxHandle;
  return { exec, handle };
}

describe("checkpoint failure diagnostics", () => {
  it("reports initialization failure before attempting a fetch or bootstrap", async () => {
    const { exec, handle } = failedSandbox(128);
    const error = await prepareSessionSandbox({
      handle,
      provider: "vercel",
      repoAlreadyCloned: false,
      request,
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      name: "SandboxCheckpointRecoveryError",
      code: "repository_setup_failed",
      exitCode: 128,
    });
    expect((error as Error).message).toContain("initialized");
    expect((error as Error).message).toContain("exit 128");
    expect((error as Error).message).not.toContain(request.installationToken);
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]?.[1]?.[1]).not.toContain("fetch");
  });

  it.each([
    [70, "invalid_input"],
    [71, "checkpoint_unavailable"],
    [72, "sha_mismatch"],
    [73, "dirty_checkout"],
    [74, "checkout_failed"],
    [75, "checkpoint_command_failed"],
    [1, "checkpoint_command_failed"],
    [127, "checkpoint_command_failed"],
  ] as const)("classifies checkpoint command exit %i as %s", async (exitCode, code) => {
    const { handle } = failedSandbox(exitCode);
    const error = await checkoutSandboxCheckpoint({
      sandbox: handle,
      branch: request.branch,
      checkpoint: request.mode,
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ name: "SandboxCheckpointRecoveryError", code, exitCode });
    expect((error as Error).message).toContain(`exit ${exitCode}`);
    expect((error as Error).message).not.toContain(request.installationToken);
    if (code !== "checkpoint_unavailable") {
      expect((error as Error).message).not.toContain("Fetching the pinned");
    }
  });

  it("gives fetch and checkout failures separate shell exit codes", async () => {
    const { exec, handle } = failedSandbox(0);
    await checkoutSandboxCheckpoint({
      sandbox: handle,
      branch: request.branch,
      checkpoint: request.mode,
    });
    const script = exec.mock.calls[0]?.[1]?.[1] ?? "";
    expect(script).toMatch(/fetch[^\n]+exit 71/);
    expect(script).toMatch(/checkout -B[^\n]+exit 74/);
    expect(script).toContain(
      'status="$(git status --porcelain --untracked-files=normal)" || exit 75',
    );
  });
});
