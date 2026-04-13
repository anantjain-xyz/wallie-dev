import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorkspace, destroyWorkspace, workspaceExists } from "./manager";

// Use a real temporary directory so git operations work.
let baseDir: string;
// We need a real git repo to clone from.
let sourceRepo: string;

async function exec(cmd: string, cwd?: string): Promise<string> {
  const { execSync } = await import("node:child_process");
  return execSync(cmd, { cwd, encoding: "utf-8" });
}

beforeEach(async () => {
  baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wallie-mgr-test-"));

  // Create a bare source repo to clone from.
  sourceRepo = path.join(baseDir, "_source");
  await fs.promises.mkdir(sourceRepo, { recursive: true });
  await exec("git init --bare --initial-branch=main", sourceRepo);

  // Populate it with an initial commit via a temporary clone.
  // Disable commit signing so tests work in CI environments with
  // global gpgsign config.
  const tmpClone = path.join(baseDir, "_init-clone");
  await exec(`git clone ${sourceRepo} ${tmpClone}`);
  await exec(
    "git config user.email test@test.com && git config user.name Test && git config commit.gpgsign false",
    tmpClone,
  );
  await fs.promises.writeFile(path.join(tmpClone, "README.md"), "# test repo\n");
  await exec("git add . && git commit -m init", tmpClone);
  await exec("git push origin main", tmpClone);
  await fs.promises.rm(tmpClone, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.promises.rm(baseDir, { recursive: true, force: true });
});

describe("workspace-manager/manager", () => {
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  describe("createWorkspace", () => {
    it("clones a repo and checks out a new branch", async () => {
      const result = await createWorkspace({
        baseDir,
        repoUrl: sourceRepo,
        sessionId,
      });

      expect(result.sessionId).toBe(sessionId);
      expect(result.branch).toBe(`wallie/session-${sessionId}`);
      expect(fs.existsSync(result.path)).toBe(true);
      expect(fs.existsSync(path.join(result.path, "README.md"))).toBe(true);

      // Verify the branch was created.
      const branch = await exec("git branch --show-current", result.path);
      expect(branch.trim()).toBe(`wallie/session-${sessionId}`);
    });

    it("accepts a custom branch name", async () => {
      const result = await createWorkspace({
        baseDir,
        branch: "my-branch",
        repoUrl: sourceRepo,
        sessionId,
      });

      const branch = await exec("git branch --show-current", result.path);
      expect(branch.trim()).toBe("my-branch");
    });

    it("re-clones if the directory already exists (crash recovery)", async () => {
      // First create.
      const first = await createWorkspace({
        baseDir,
        repoUrl: sourceRepo,
        sessionId,
      });

      // Write a file that wouldn't be in the source.
      await fs.promises.writeFile(path.join(first.path, "dirty.txt"), "dirty");

      // Re-create should produce a clean clone.
      const second = await createWorkspace({
        baseDir,
        repoUrl: sourceRepo,
        sessionId,
      });

      expect(second.path).toBe(first.path);
      expect(fs.existsSync(path.join(second.path, "dirty.txt"))).toBe(false);
      expect(fs.existsSync(path.join(second.path, "README.md"))).toBe(true);
    });
  });

  describe("destroyWorkspace", () => {
    it("removes an existing workspace directory", async () => {
      await createWorkspace({
        baseDir,
        repoUrl: sourceRepo,
        sessionId,
      });

      expect(workspaceExists({ baseDir, sessionId })).toBe(true);

      await destroyWorkspace({ baseDir, sessionId });

      expect(workspaceExists({ baseDir, sessionId })).toBe(false);
    });

    it("is idempotent if workspace does not exist", async () => {
      await expect(
        destroyWorkspace({ baseDir, sessionId: "nonexistent-id" }),
      ).resolves.not.toThrow();
    });
  });

  describe("workspaceExists", () => {
    it("returns false when workspace has not been created", () => {
      expect(workspaceExists({ baseDir, sessionId })).toBe(false);
    });

    it("returns true after workspace is created", async () => {
      await createWorkspace({
        baseDir,
        repoUrl: sourceRepo,
        sessionId,
      });
      expect(workspaceExists({ baseDir, sessionId })).toBe(true);
    });
  });
});
