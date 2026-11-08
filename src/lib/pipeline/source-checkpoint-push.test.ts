import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import { SOURCE_CHECKPOINT_REF } from "./source-checkpoint";
import { restoreAndPushSource } from "./source-delivery-git";
import type { GitExecutor, SourceRestoreInput } from "./source-delivery-git-core";

const retainedNamespaces = ["refs/wallie/checkpoints", "refs/heads/wallie/checkpoints"] as const;

function retainedFixture(namespace: (typeof retainedNamespaces)[number] = retainedNamespaces[0]) {
  const root = mkdtempSync(join(tmpdir(), "wallie-retained-checkpoint-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repoGit = (...args: string[]) => git("-C", source, ...args);
  git("init", "--quiet", "--initial-branch=main", source);
  repoGit("config", "user.name", "Checkpoint test");
  repoGit("config", "user.email", "checkpoint@example.com");
  writeFileSync(join(source, "README.md"), "Base source\n");
  repoGit("add", ".");
  repoGit("commit", "-qm", "Base source");
  const baseSha = repoGit("rev-parse", "HEAD");
  git("clone", "--bare", source, remote);
  writeFileSync(join(source, "output.txt"), "Captured output\n");
  repoGit("add", ".");
  repoGit("commit", "-qm", "Captured output");
  const headSha = repoGit("rev-parse", "HEAD");
  repoGit("update-ref", SOURCE_CHECKPOINT_REF, headSha);
  const bundle = join(root, "source.bundle");
  repoGit("bundle", "create", bundle, SOURCE_CHECKPOINT_REF, `^${baseSha}`);
  const bytes = readFileSync(bundle);
  const runId = "00000000-0000-4000-8000-000000000001";
  const ref = `${namespace}/${runId}/${headSha}`;
  const input: Extract<SourceRestoreInput, { retainedRef: string }> = {
    baseSha,
    headSha,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    retainedRef: ref,
    runId,
    remoteUrl: "https://github.com/acme/app.git",
    token: "synthetic-checkpoint-token",
    beforePush: vi.fn(async () => {}),
  };
  const transport = {
    execGit: vi.fn<GitExecutor>((args, options) =>
      promisify(execFile)(
        "git",
        args.map((arg) => (arg === input.remoteUrl ? `file://${remote}` : arg)),
        { ...options, encoding: "utf8" },
      ),
    ),
  };
  const remoteHead = () => git("--git-dir", remote, "rev-parse", ref);
  const refs = () => git("--git-dir", remote, "for-each-ref", "--format=%(refname)");
  const pushes = () => transport.execGit.mock.calls.filter(([args]) => args[0] === "push");
  const remoteCommit = (parent: string) => {
    const sha = repoGit(
      "commit-tree",
      repoGit("rev-parse", `${parent}^{tree}`),
      "-p",
      parent,
      "-m",
      "Competing work",
    );
    git("--git-dir", remote, "fetch", source, sha);
    return sha;
  };
  return {
    input,
    transport,
    git,
    remote,
    ref,
    refs,
    pushes,
    remoteHead,
    remoteCommit,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

it.each(retainedNamespaces)(
  "restores captured output under %s after the default branch changes",
  async (namespace) => {
    const f = retainedFixture(namespace);
    try {
      const changedDefault = f.remoteCommit(f.input.baseSha);
      f.git("--git-dir", f.remote, "update-ref", "refs/heads/new-default", changedDefault);
      f.git("--git-dir", f.remote, "symbolic-ref", "HEAD", "refs/heads/new-default");
      expect(await restoreAndPushSource(f.input, f.transport)).toBe(f.input.retainedRef);
      expect(f.remoteHead()).toBe(f.input.headSha);
      expect(f.git("--git-dir", f.remote, "show", `${f.ref}:output.txt`)).toBe("Captured output");
      expect(f.pushes()[0][0]).toEqual([
        "push",
        `--force-with-lease=${f.ref}:`,
        f.input.remoteUrl,
        `${f.input.headSha}:${f.ref}`,
      ]);
      expect(f.transport.execGit.mock.calls.some(([args]) => args.includes("--depth=1"))).toBe(
        true,
      );
      expect(f.refs().split("\n")).toEqual(
        ["refs/heads/main", "refs/heads/new-default", f.ref].sort(),
      );
    } finally {
      f.cleanup();
    }
  },
);

it("does not claim publication when the push fails before reaching the remote, and safely retries", async () => {
  const f = retainedFixture();
  try {
    const transport = {
      execGit: async (...args: Parameters<GitExecutor>) => {
        if (args[0][0] === "push") throw new Error(`Transport failed: ${f.input.token}`);
        return f.transport.execGit(...args);
      },
    };
    await expect(restoreAndPushSource(f.input, transport)).rejects.toThrow(
      /^Could not restore and push the source checkpoint\.$/,
    );
    expect(f.refs()).not.toContain(f.ref);
    expect(existsSync(f.transport.execGit.mock.calls[0][1].cwd)).toBe(false);
    expect(await restoreAndPushSource(f.input, f.transport)).toBe(f.input.retainedRef);
    expect(f.remoteHead()).toBe(f.input.headSha);
  } finally {
    f.cleanup();
  }
});

it("reconciles an ambiguous successful retained-ref push and retries without another push", async () => {
  const f = retainedFixture();
  try {
    const transport = {
      execGit: async (...args: Parameters<GitExecutor>) => {
        const result = await f.transport.execGit(...args);
        if (args[0][0] === "push") throw new Error("Successful push response lost");
        return result;
      },
    };
    expect(await restoreAndPushSource(f.input, transport)).toBe(f.input.retainedRef);
    expect(await restoreAndPushSource(f.input, transport)).toBe(f.input.retainedRef);
    expect(f.remoteHead()).toBe(f.input.headSha);
    expect(f.pushes()).toHaveLength(1);
    expect(f.input.beforePush).toHaveBeenCalledTimes(1);
  } finally {
    f.cleanup();
  }
});

it.each(["ancestor", "descendant"])(
  "rejects an existing retained ref at an %s commit",
  async (kind) => {
    const f = retainedFixture();
    try {
      const conflict = kind === "ancestor" ? f.input.baseSha : f.remoteCommit(f.input.headSha);
      f.git("--git-dir", f.remote, "update-ref", f.ref, conflict);
      await expect(restoreAndPushSource(f.input, f.transport)).rejects.toThrow(
        "Could not restore and push",
      );
      expect(f.remoteHead()).toBe(conflict);
      expect(f.pushes()).toHaveLength(0);
      expect(f.input.beforePush).not.toHaveBeenCalled();
      expect(f.refs()).not.toContain("wallie/recovery/");
      expect(f.transport.execGit.mock.calls.some(([args]) => args[0] === "merge-base")).toBe(false);
    } finally {
      f.cleanup();
    }
  },
);

it("does not overwrite a concurrent writer even when its commit is an ancestor", async () => {
  const f = retainedFixture();
  try {
    const transport = {
      execGit: async (...args: Parameters<GitExecutor>) => {
        if (args[0][0] === "push")
          f.git("--git-dir", f.remote, "update-ref", f.ref, f.input.baseSha);
        return f.transport.execGit(...args);
      },
    };
    await expect(restoreAndPushSource(f.input, transport)).rejects.toThrow(
      "Could not restore and push",
    );
    expect(f.remoteHead()).toBe(f.input.baseSha);
    expect(f.pushes()).toHaveLength(1);
    expect(f.refs()).not.toContain("wallie/recovery/");
  } finally {
    f.cleanup();
  }
});

it("verifies the exact remote ref after a successful push response", async () => {
  const f = retainedFixture();
  try {
    const descendant = f.remoteCommit(f.input.headSha);
    const transport = {
      execGit: async (...args: Parameters<GitExecutor>) => {
        const result = await f.transport.execGit(...args);
        if (args[0][0] === "push") f.git("--git-dir", f.remote, "update-ref", f.ref, descendant);
        return result;
      },
    };
    await expect(restoreAndPushSource(f.input, transport)).rejects.toThrow(
      "Could not restore and push",
    );
    expect(f.remoteHead()).toBe(descendant);
  } finally {
    f.cleanup();
  }
});

it("checks ownership immediately before pushing the retained ref", async () => {
  const f = retainedFixture();
  try {
    f.input.beforePush = vi.fn(async () => {
      throw new Error("Attempt no longer owns publication");
    });
    await expect(restoreAndPushSource(f.input, f.transport)).rejects.toThrow(
      "Could not restore and push",
    );
    expect(f.input.beforePush).toHaveBeenCalledTimes(1);
    expect(f.pushes()).toHaveLength(0);
    expect(f.refs()).not.toContain(f.ref);
  } finally {
    f.cleanup();
  }
});

it("stops a canceled attempt after its ownership callback without pushing", async () => {
  const f = retainedFixture();
  try {
    const controller = new AbortController();
    f.input.signal = controller.signal;
    f.input.beforePush = vi.fn(async () => controller.abort());
    await expect(restoreAndPushSource(f.input, f.transport)).rejects.toThrow(
      "Could not restore and push",
    );
    expect(f.pushes()).toHaveLength(0);
    expect(f.refs()).not.toContain(f.ref);
  } finally {
    f.cleanup();
  }
});

it.each(["push", "verification"])("does not accept proof if canceled during %s", async (stage) => {
  const f = retainedFixture();
  try {
    const controller = new AbortController();
    f.input.signal = controller.signal;
    let pushed = false;
    const transport = {
      execGit: async (...args: Parameters<GitExecutor>) => {
        const result = await f.transport.execGit(...args);
        if (args[0][0] === "push") {
          pushed = true;
          if (stage === "push") controller.abort();
        }
        if (stage === "verification" && pushed && args[0][0] === "ls-remote") controller.abort();
        return result;
      },
    };
    await expect(restoreAndPushSource(f.input, transport)).rejects.toThrow(
      "Could not restore and push",
    );
    expect(f.remoteHead()).toBe(f.input.headSha);
    expect(existsSync(f.transport.execGit.mock.calls[0][1].cwd)).toBe(false);
    expect(await restoreAndPushSource({ ...f.input, signal: undefined }, f.transport)).toBe(
      f.input.retainedRef,
    );
    expect(f.pushes()).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

it("requires a retained ref with the exact checkpoint identity before starting Git", async () => {
  const f = retainedFixture();
  try {
    await expect(
      restoreAndPushSource({ ...f.input, retainedRef: "refs/heads/wallie/attempt-1" }, f.transport),
    ).rejects.toThrow("retained checkpoint ref");
    await expect(
      restoreAndPushSource(
        { ...f.input, retainedRef: `${f.input.retainedRef}-different` },
        f.transport,
      ),
    ).rejects.toThrow("retained checkpoint ref");
    await expect(
      restoreAndPushSource(
        { ...f.input, runId: "00000000-0000-4000-8000-000000000002" },
        f.transport,
      ),
    ).rejects.toThrow("retained checkpoint ref");
    expect(f.transport.execGit).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});
