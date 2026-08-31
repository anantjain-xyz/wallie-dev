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

  it.each([
    ["e2b", "sudo apt-get update && sudo apt-get install -y gh"],
    ["daytona", "sudo apt-get update && sudo apt-get install -y gh"],
  ] as const)("installs and verifies gh for the %s provider", async (provider, installCommand) => {
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

    await prepareSessionSandbox({
      handle,
      provider,
      repoAlreadyCloned: true,
      request: {
        agentProvider: "codex",
        baseBranch: "main",
        branch: "wallie/test",
        installationToken: "gh-secret",
        repoFullName: "acme/app",
        sessionId: "session-1",
      },
    });

    expect(exec).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringContaining(installCommand)],
      expect.anything(),
    );
    expect(exec).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringContaining("gh --version >/dev/null")],
      expect.anything(),
    );
  });

  it("adds the official GitHub CLI repository before installing gh on Vercel", async () => {
    const exec = vi.fn<SandboxHandle["exec"]>(async () => ({
      exitCode: Promise.resolve(0),
      kill: vi.fn(),
      logs: async function* () {},
      output: async () => ({ stderr: "", stdout: "" }),
    }));
    const handle = {
      exec,
      id: "sandbox-1",
      readFile: vi.fn(),
      repoPath: "/vercel/sandbox",
      stop: vi.fn(),
      writeFile: vi.fn(),
    } satisfies SandboxHandle;

    await prepareSessionSandbox({
      handle,
      provider: "vercel",
      repoAlreadyCloned: true,
      request: {
        agentProvider: "codex",
        baseBranch: "main",
        branch: "wallie/test",
        installationToken: "gh-secret",
        repoFullName: "acme/app",
        sessionId: "session-1",
      },
    });

    const setupScript = exec.mock.calls[0]?.[1]?.[1] ?? "";
    expect(setupScript).toContain("sudo dnf install -y dnf-plugins-core");
    expect(setupScript).toContain(
      "sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo",
    );
    expect(setupScript).toContain("sudo dnf install -y gh --repo gh-cli");
    expect(setupScript).not.toContain("sudo dnf install -y gh &&");
    expect(setupScript).toContain("gh --version >/dev/null");
  });

  it("installs OpenCode v1 for OpenCode sessions", async () => {
    const exec = vi.fn<SandboxHandle["exec"]>(async () => ({
      exitCode: Promise.resolve(0),
      kill: vi.fn(),
      logs: async function* () {},
      output: async () => ({ stderr: "", stdout: "" }),
    }));
    const handle = {
      exec,
      id: "sandbox-1",
      readFile: vi.fn(),
      repoPath: "/vercel/sandbox",
      stop: vi.fn(),
      writeFile: vi.fn(),
    } satisfies SandboxHandle;

    await prepareSessionSandbox({
      handle,
      provider: "vercel",
      repoAlreadyCloned: true,
      request: {
        agentProvider: "opencode",
        baseBranch: "main",
        branch: "wallie/test",
        installationToken: "gh-secret",
        repoFullName: "acme/app",
        sessionId: "session-1",
      },
    });

    expect(exec.mock.calls[0]?.[1]?.[1]).toContain("npm install -g opencode-ai@1");
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
