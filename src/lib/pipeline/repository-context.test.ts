import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import type { SandboxHandle } from "@/lib/sandbox/types";

import { materializeFactoryRepositoryContext } from "./repository-context";

vi.mock("@/features/github/sandbox-token", () => ({ mintSandboxRepositoryToken: vi.fn() }));

const token = vi.mocked(mintSandboxRepositoryToken);
const scratch: string[] = [];

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  for (const directory of scratch.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function fixture(connected = true) {
  const query = {
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: connected
        ? { repo_id: 123, full_name: "acme/docs", github_installations: { installation_id: 456 } }
        : null,
      error: null,
    }),
  };
  const exec = vi.fn<SandboxHandle["exec"]>();
  const input = {
    admin: { from: vi.fn().mockReturnValue(query) } as never,
    factoryId: "factory-1",
    repositoryIds: ["context-1"],
    sandbox: { exec } as unknown as SandboxHandle,
    workspaceId: "workspace-1",
  };
  return { input, query, exec };
}

describe("factory repository context", () => {
  it("exports the exact authorized commit to scratch space with no checkout metadata", async () => {
    const repository = mkdtempSync("/tmp/wallie-context-fixture.");
    scratch.push(repository);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repository, "reference.txt"), "Authorized snapshot\n");
    git("add", "reference.txt");
    git("commit", "--quiet", "-m", "Authorized snapshot");
    const sha = git("rev-parse", "HEAD");
    writeFileSync(join(repository, "reference.txt"), "New branch tip\n");
    git("commit", "--quiet", "-am", "New branch tip");

    const { input, query, exec } = fixture();
    token.mockResolvedValue("context-token");
    const fetchHead = vi.fn().mockResolvedValue(Response.json({ sha }));
    vi.stubGlobal("fetch", fetchHead);
    let snapshotPath: string | undefined;
    exec.mockImplementation(async (cmd, args, opts) => {
      const [flag, program, name, remote, commit] = args;
      expect(remote).toBe("https://github.com/acme/docs.git");
      expect(commit).toBe(sha);
      expect(program).not.toContain("context-token");
      expect(opts?.env?.GIT_CONFIG_KEY_0).toBe(`http.${remote}.extraheader`);
      const stdout = execFileSync(
        cmd,
        [flag, program, name, pathToFileURL(repository).href, commit],
        {
          cwd: opts?.cwd,
          env: { ...process.env, ...opts?.env },
          encoding: "utf8",
        },
      );
      snapshotPath = stdout.trim();
      const root = join(snapshotPath, "..");
      scratch.push(root);
      expect(readFileSync(join(snapshotPath, "reference.txt"), "utf8")).toBe(
        "Authorized snapshot\n",
      );
      expect(existsSync(join(root, "repo.git"))).toBe(false);
      expect(existsSync(join(snapshotPath, ".git"))).toBe(false);
      chmodSync(snapshotPath, 0o700);
      return {
        output: async () => ({ stdout, stderr: "" }),
        exitCode: Promise.resolve(0),
      } as never;
    });

    const snapshots = await materializeFactoryRepositoryContext(input);
    expect(snapshots).toEqual([`acme/docs at ${sha} → ${snapshotPath}`]);
    expect(query.eq.mock.calls).toEqual([
      ["id", "context-1"],
      ["workspace_id", "workspace-1"],
      ["factory_id", "factory-1"],
      ["is_archived", false],
      ["github_installations.workspace_id", "workspace-1"],
      ["github_installations.suspended", false],
    ]);
    expect(token).toHaveBeenCalledExactlyOnceWith({
      installationId: 456,
      repositoryId: 123,
      repositoryFullName: "acme/docs",
      purpose: "read-context",
    });
    expect(fetchHead).toHaveBeenCalledWith(
      "https://api.github.com/repositories/123/commits/HEAD",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("never mints a token or reads Git when the scoped installation is unavailable", async () => {
    const { input, exec } = fixture(false);
    await expect(materializeFactoryRepositoryContext(input)).rejects.toThrow(
      "read-context repository is unavailable",
    );
    expect(token).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("stops before Git when GitHub revokes access to the bound numeric repository", async () => {
    const { input, exec } = fixture();
    token.mockResolvedValue("revoked-context-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    await expect(materializeFactoryRepositoryContext(input)).rejects.toThrow(
      "read-context repository is unavailable",
    );
    expect(exec).not.toHaveBeenCalled();
  });
});
