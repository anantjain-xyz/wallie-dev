import { describe, expect, it, vi } from "vitest";

import { WALLIE_GITHUB_BOT_COMMIT_AUTHOR } from "./commit-author";
import { createVercelSessionSandbox } from "./vercel";

const mocked = vi.hoisted(() => ({
  runCommand: vi.fn(),
  sandboxCreate: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: mocked.sandboxCreate,
  },
}));

describe("createVercelSessionSandbox", () => {
  it("configures git commits as the Wallie GitHub App bot", async () => {
    mocked.runCommand.mockResolvedValue({
      logs: async function* () {},
      wait: async () => ({ exitCode: 0 }),
    });
    mocked.sandboxCreate.mockResolvedValue({
      readFileToBuffer: vi.fn(),
      runCommand: mocked.runCommand,
      sandboxId: "sandbox-1",
      stop: mocked.stop,
      writeFiles: vi.fn(),
    });

    await createVercelSessionSandbox({
      agentProvider: "codex",
      baseBranch: "main",
      branch: "wallie/session-1-product",
      installationToken: "ghs_test",
      repoFullName: "acme/app",
      sessionId: "session-1",
    });

    expect(mocked.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "-lc",
          expect.stringContaining(
            `git -C '/vercel/sandbox' config user.email '${WALLIE_GITHUB_BOT_COMMIT_AUTHOR.email}'`,
          ),
        ],
        cmd: "bash",
      }),
    );
    expect(mocked.runCommand.mock.calls[0]?.[0].args[1]).toContain(
      `git -C '/vercel/sandbox' config user.name '${WALLIE_GITHUB_BOT_COMMIT_AUTHOR.name}'`,
    );
  });
});
