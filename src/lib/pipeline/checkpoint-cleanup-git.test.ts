import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import {
  deleteRetainedCheckpointRefWithWorkspace,
  RetainedCheckpointRefConflictError,
} from "./checkpoint-cleanup-git";
import type { GitExecutor, SourceGitWorkspace } from "./source-delivery-git-core";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wallie-checkpoint-cleanup-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "--initial-branch=main", source);
  git("-C", source, "config", "user.name", "Checkpoint cleanup test");
  git("-C", source, "config", "user.email", "test@example.com");
  writeFileSync(join(source, "source.txt"), "Base\n");
  git("-C", source, "add", ".");
  git("-C", source, "commit", "-qm", "Base");
  const base = git("-C", source, "rev-parse", "HEAD");
  writeFileSync(join(source, "source.txt"), "Output\n");
  git("-C", source, "commit", "-qam", "Output");
  const headSha = git("-C", source, "rev-parse", "HEAD");
  git("clone", "--bare", source, remote);
  const input = {
    runId: "10000000-0000-4000-8000-000000000001",
    headSha,
    remoteUrl: "https://github.com/acme/fixture.git",
    token: "synthetic-cleanup-token",
    beforeDelete: vi.fn(async () => {}),
  };
  const ref = `refs/heads/wallie/checkpoints/${input.runId}/${headSha}`;
  git("--git-dir", remote, "update-ref", ref, headSha);
  const workspaces: SourceGitWorkspace[] = [];
  const dependencies = {
    execGit: vi.fn<GitExecutor>((args, options) =>
      promisify(execFile)(
        "git",
        args.map((arg) => (arg === input.remoteUrl ? `file://${remote}` : arg)),
        { ...options, encoding: "utf8" },
      ),
    ),
    createWorkspace: vi.fn(async () => {
      const path = mkdtempSync(join(root, "isolated-"));
      const workspace = {
        path,
        writeBundle: vi.fn(async () => {}),
        close: vi.fn(async () => rmSync(path, { recursive: true, force: true })),
      };
      workspaces.push(workspace);
      return workspace;
    }),
  };
  return {
    input,
    ref,
    base,
    git,
    remote,
    dependencies,
    refs: () => git("--git-dir", remote, "for-each-ref", "--format=%(objectname) %(refname)"),
    pushes: () => dependencies.execGit.mock.calls.filter(([args]) => args[0] === "push"),
    expectClean: () => {
      for (const workspace of workspaces) {
        expect(workspace.close).toHaveBeenCalledTimes(1);
        expect(existsSync(workspace.path)).toBe(false);
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

it("deletes only its exact retained ref with an explicit SHA lease and verifies absence", async () => {
  const f = fixture();
  try {
    expect(await deleteRetainedCheckpointRefWithWorkspace(f.input, f.dependencies)).toEqual({
      ref: f.ref,
      absent: true,
    });
    expect(f.refs()).not.toContain(f.ref);
    expect(f.refs()).toContain("refs/heads/main");
    expect(f.pushes()[0][0]).toEqual([
      "push",
      `--force-with-lease=${f.ref}:${f.input.headSha}`,
      f.input.remoteUrl,
      `:${f.ref}`,
    ]);
    expect(f.input.beforeDelete).toHaveBeenCalledTimes(1);
    expect(await deleteRetainedCheckpointRefWithWorkspace(f.input, f.dependencies)).toEqual({
      ref: f.ref,
      absent: true,
    });
    expect(f.pushes()).toHaveLength(1);
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it.each(["before-read", "before-push"])("preserves a rewritten retained ref %s", async (when) => {
  const f = fixture();
  try {
    const rewrite = () => f.git("--git-dir", f.remote, "update-ref", f.ref, f.base);
    if (when === "before-read") rewrite();
    else
      f.input.beforeDelete = vi.fn(async () => {
        rewrite();
      });
    await expect(
      deleteRetainedCheckpointRefWithWorkspace(f.input, f.dependencies),
    ).rejects.toBeInstanceOf(RetainedCheckpointRefConflictError);
    expect(f.refs()).toContain(`${f.base} ${f.ref}`);
    expect(f.pushes()).toHaveLength(when === "before-read" ? 0 : 1);
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it("reconciles an ambiguous successful deletion without repeating it", async () => {
  const f = fixture();
  try {
    const dependencies = {
      ...f.dependencies,
      execGit: async (...args: Parameters<GitExecutor>) => {
        const result = await f.dependencies.execGit(...args);
        if (args[0][0] === "push") throw new Error("Receipt lost");
        return result;
      },
    };
    expect(await deleteRetainedCheckpointRefWithWorkspace(f.input, dependencies)).toEqual({
      ref: f.ref,
      absent: true,
    });
    expect(await deleteRetainedCheckpointRefWithWorkspace(f.input, dependencies)).toEqual({
      ref: f.ref,
      absent: true,
    });
    expect(f.pushes()).toHaveLength(1);
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it("does not claim absence after a failed transport and sanitizes its credentials", async () => {
  const f = fixture();
  try {
    const dependencies = {
      ...f.dependencies,
      execGit: async (...args: Parameters<GitExecutor>) => {
        if (args[0][0] === "push")
          throw new Error(`${f.input.token} ${Buffer.from(f.input.token).toString("base64")}`);
        return f.dependencies.execGit(...args);
      },
    };
    await expect(deleteRetainedCheckpointRefWithWorkspace(f.input, dependencies)).rejects.toThrow(
      /^Could not verify retained checkpoint removal\.$/,
    );
    expect(f.refs()).toContain(`${f.input.headSha} ${f.ref}`);
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it("does not delete after losing cleanup ownership", async () => {
  const f = fixture();
  try {
    f.input.beforeDelete = vi.fn(async () => {
      throw new Error("Claim expired");
    });
    await expect(deleteRetainedCheckpointRefWithWorkspace(f.input, f.dependencies)).rejects.toThrow(
      "Could not verify",
    );
    expect(f.pushes()).toHaveLength(0);
    expect(f.refs()).toContain(f.ref);
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it.each(["ownership", "push", "verification"])(
  "does not accept absence after cancellation during %s",
  async (when) => {
    const f = fixture();
    try {
      const controller = new AbortController();
      if (when === "ownership")
        f.input.beforeDelete = vi.fn(async () => controller.abort(f.input.token));
      let pushed = false;
      const dependencies = {
        ...f.dependencies,
        execGit: async (...args: Parameters<GitExecutor>) => {
          const result = await f.dependencies.execGit(...args);
          if (args[0][0] === "push") {
            pushed = true;
            if (when === "push") controller.abort(f.input.token);
          }
          if (pushed && when === "verification" && args[0][0] === "ls-remote")
            controller.abort(f.input.token);
          return result;
        },
      };
      await expect(
        deleteRetainedCheckpointRefWithWorkspace(
          { ...f.input, signal: controller.signal },
          dependencies,
        ),
      ).rejects.toThrow(/^Could not verify retained checkpoint removal\.$/);
      expect(f.refs().includes(f.ref)).toBe(when === "ownership");
      f.expectClean();
    } finally {
      f.cleanup();
    }
  },
);

it("rejects arbitrary namespaces and credential-bearing URLs before creating a workspace", async () => {
  const f = fixture();
  try {
    for (const invalid of [
      { runId: "../../main" },
      { runId: "wallie/sessions/session/epoch" },
      { headSha: "HEAD" },
      { remoteUrl: "https://secret@github.com/acme/fixture.git" },
    ])
      await expect(
        deleteRetainedCheckpointRefWithWorkspace({ ...f.input, ...invalid }, f.dependencies),
      ).rejects.toThrow();
    expect(f.dependencies.createWorkspace).not.toHaveBeenCalled();
    expect(f.dependencies.execGit).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});
