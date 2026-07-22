import { describe, expect, it, vi } from "vitest";

import { prepareSessionSandbox } from "./setup";
import type { CreateSessionSandboxInput, SandboxHandle } from "./types";

describe("prepareSessionSandbox", () => {
  it("bootstraps from an existing directory before creating the repository path", async () => {
    const exec = vi.fn(async () => ({
      exitCode: Promise.resolve(0),
      kill: vi.fn(),
      logs: async function* () {},
      output: async () => ({ stderr: "", stdout: "" }),
    }));
    const handle = {
      exec,
      id: "sandbox-1",
      readFile: vi.fn(),
      repoPath: "/home/user/wallie/repo",
      stop: vi.fn(),
      writeFile: vi.fn(),
    } satisfies SandboxHandle;
    const request = {
      agentProvider: "codex",
      baseBranch: "main",
      branch: "wallie/test",
      installationToken: "gh-secret",
      repoFullName: "acme/app",
      sessionId: "session-1",
    } satisfies CreateSessionSandboxInput;

    await prepareSessionSandbox({
      handle,
      provider: "e2b",
      repoAlreadyCloned: false,
      request,
    });

    expect(exec).toHaveBeenCalledWith(
      "bash",
      [
        "-lc",
        expect.stringMatching(
          /mkdir -p '\/home\/user\/wallie\/repo'[\s\S]*sudo swapon \/tmp\/wallie\.swap[\s\S]*sudo n 22/,
        ),
      ],
      expect.objectContaining({ cwd: "/tmp" }),
    );
  });

  it("includes stdout when setup fails without useful stderr", async () => {
    const exec = vi.fn(async () => ({
      exitCode: Promise.resolve(1),
      kill: vi.fn(),
      logs: async function* () {},
      output: async () => ({ stderr: "", stdout: "Node version is unsupported" }),
    }));
    const handle = {
      exec,
      id: "sandbox-1",
      readFile: vi.fn(),
      repoPath: "/home/user/wallie/repo",
      stop: vi.fn(),
      writeFile: vi.fn(),
    } satisfies SandboxHandle;

    await expect(
      prepareSessionSandbox({
        handle,
        provider: "e2b",
        repoAlreadyCloned: false,
        request: {
          agentProvider: "codex",
          baseBranch: "main",
          branch: "wallie/test",
          installationToken: "gh-secret",
          repoFullName: "acme/app",
          sessionId: "session-1",
        },
      }),
    ).rejects.toThrow("stdout: Node version is unsupported");
  });
});
