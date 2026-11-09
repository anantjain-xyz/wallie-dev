import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import {
  CanonicalRefConflictError,
  promoteCanonicalRefsWithWorkspace,
  type CanonicalPromotionInput,
} from "./canonical-pr-git";
import type { GitExecutor, SourceGitWorkspace } from "./source-delivery-git-core";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const SESSION = "10000000-0000-4000-8000-000000000001";
const EPOCH = "20000000-0000-4000-8000-000000000001";
const RUN = "40000000-0000-4000-8000-000000000001";
const operation = (n: number) => `30000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ERROR = "Could not promote the canonical session refs.";

// Compute the raw Git object independently of commit-tree and the implementation.
function fenceObject(operationId: string, parent: string | null) {
  return (
    `tree ${EMPTY_TREE}\n` +
    (parent ? `parent ${parent}\n` : "") +
    "author Wallie <noreply@wallie.dev> 946684800 +0000\n" +
    "committer Wallie <noreply@wallie.dev> 946684800 +0000\n\n" +
    `Wallie canonical publication ${operationId}\n`
  );
}

function fenceSha(operationId: string, parent: string | null) {
  const object = fenceObject(operationId, parent);
  return createHash("sha1")
    .update(`commit ${Buffer.byteLength(object)}\0${object}`)
    .digest("hex");
}

function fixture(refKind: "custom" | "legacy" = "custom") {
  const root = mkdtempSync(join(tmpdir(), "wallie-canonical-git-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repoGit = (...args: string[]) => git("-C", source, ...args);
  git("init", "--quiet", "--initial-branch=main", source);
  repoGit("config", "user.name", "Canonical test");
  repoGit("config", "user.email", "canonical@example.com");
  writeFileSync(join(source, "output.txt"), "Source A\n");
  repoGit("add", ".");
  repoGit("commit", "-qm", "Source A");
  const a = repoGit("rev-parse", "HEAD");
  repoGit("branch", "checkpoint-a");
  writeFileSync(join(source, "output.txt"), "Source B\n");
  repoGit("add", ".");
  repoGit("commit", "-qm", "Source B");
  const b = repoGit("rev-parse", "HEAD");
  repoGit("branch", "checkpoint-b");
  git("clone", "--bare", source, remote);
  const checkpointRef = (sha: string) =>
    refKind === "custom"
      ? `refs/wallie/checkpoints/${RUN}/${sha}`
      : `refs/heads/checkpoint-${sha === a ? "a" : "b"}`;
  git("--git-dir", remote, "update-ref", checkpointRef(a), a);
  git("--git-dir", remote, "update-ref", checkpointRef(b), b);
  const headRef = `refs/heads/wallie/sessions/${SESSION}/${EPOCH}`;
  const fenceRef =
    refKind === "custom"
      ? `refs/wallie/fences/${EPOCH}`
      : `refs/heads/wallie/session-fences/${EPOCH}`;
  const remoteUrl = "https://github.com/acme/app.git";
  const workspaces: SourceGitWorkspace[] = [];
  const dependencies = {
    execGit: vi.fn<GitExecutor>((args, options) =>
      promisify(execFile)(
        "git",
        args.map((arg) => (arg === remoteUrl ? `file://${remote}` : arg)),
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
  const input = (
    n = 1,
    sha = a,
    expected: { headSha: string; fenceSha: string } | null = null,
  ): CanonicalPromotionInput => ({
    operationId: operation(n),
    desiredSha: sha,
    sourceRef: checkpointRef(sha),
    branchName: headRef.slice("refs/heads/".length),
    fenceRef,
    expectedHeadSha: expected?.headSha ?? null,
    expectedFenceSha: expected?.fenceSha ?? null,
    desiredFenceSha: fenceSha(operation(n), expected?.fenceSha ?? null),
    remoteUrl,
    token: "synthetic-canonical-token",
    beforePush: vi.fn(async () => {}),
  });
  const pair = () => {
    const result = git("--git-dir", remote, "show-ref");
    const refs = result.split("\n").map((line) => line.split(" "));
    return {
      headSha: refs.find(([, ref]) => ref === headRef)?.[0] ?? null,
      fenceSha: refs.find(([, ref]) => ref === fenceRef)?.[0] ?? null,
    };
  };
  return {
    a,
    b,
    git,
    remote,
    headRef,
    fenceRef,
    dependencies,
    input,
    pair,
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

it.each(["custom", "legacy"] as const)(
  "atomically publishes exact source and a deterministic %s fence",
  async (refKind) => {
    const f = fixture(refKind);
    try {
      const input = f.input();
      const result = await promoteCanonicalRefsWithWorkspace(input, f.dependencies);
      expect(result).toEqual({ headSha: f.a, fenceSha: input.desiredFenceSha });
      expect(f.pair()).toEqual(result);
      expect(f.git("--git-dir", f.remote, "show", `${f.headRef}:output.txt`)).toBe("Source A");
      expect(f.git("--git-dir", f.remote, "cat-file", "commit", result.fenceSha)).toBe(
        fenceObject(input.operationId, null).trim(),
      );
      expect(
        f
          .git("--git-dir", f.remote, "for-each-ref", "--format=%(refname)", "refs/heads/wallie")
          .split("\n"),
      ).toEqual(refKind === "custom" ? [f.headRef] : [f.fenceRef, f.headRef]);
      expect(f.pushes()[0][0]).toEqual([
        "push",
        "--atomic",
        `--force-with-lease=${f.headRef}:`,
        `--force-with-lease=${f.fenceRef}:`,
        input.remoteUrl,
        `${f.a}:${f.headRef}`,
        `${input.desiredFenceSha}:${f.fenceRef}`,
      ]);
      expect(input.beforePush).toHaveBeenCalledTimes(1);
      f.expectClean();
    } finally {
      f.cleanup();
    }
  },
);

it("retries a completed operation without changing either ref or checking ownership again", async () => {
  const f = fixture();
  try {
    const input = f.input();
    const result = await promoteCanonicalRefsWithWorkspace(input, f.dependencies);
    expect(await promoteCanonicalRefsWithWorkspace(input, f.dependencies)).toEqual(result);
    expect(f.pushes()).toHaveLength(1);
    expect(input.beforePush).toHaveBeenCalledTimes(1);
    expect(f.pair()).toEqual(result);
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it("advances the fence even when the canonical code commit does not change", async () => {
  const f = fixture();
  try {
    const first = await promoteCanonicalRefsWithWorkspace(f.input(), f.dependencies);
    const next = f.input(2, f.a, first);
    const result = await promoteCanonicalRefsWithWorkspace(next, f.dependencies);
    expect(result.headSha).toBe(first.headSha);
    expect(result.fenceSha).not.toBe(first.fenceSha);
    expect(f.git("--git-dir", f.remote, "rev-parse", `${result.fenceSha}^`)).toBe(first.fenceSha);
    expect(f.pair()).toEqual(result);
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it("rejects an ABA-delayed operation after source returns to the same commit", async () => {
  const f = fixture();
  try {
    const first = await promoteCanonicalRefsWithWorkspace(f.input(), f.dependencies);
    const delayed = f.input(4, f.b, first);
    delayed.beforePush = async () => {
      const second = await promoteCanonicalRefsWithWorkspace(
        f.input(2, f.b, first),
        f.dependencies,
      );
      const third = await promoteCanonicalRefsWithWorkspace(
        f.input(3, f.a, second),
        f.dependencies,
      );
      expect(third.headSha).toBe(first.headSha);
      expect(third.fenceSha).not.toBe(first.fenceSha);
    };
    await expect(promoteCanonicalRefsWithWorkspace(delayed, f.dependencies)).rejects.toBeInstanceOf(
      CanonicalRefConflictError,
    );
    expect(f.pair()).toEqual({
      headSha: f.a,
      fenceSha: fenceSha(operation(3), fenceSha(operation(2), first.fenceSha)),
    });
    expect(f.pushes()).toHaveLength(4);
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it("allows only one of two operations that race the same expected pair", async () => {
  const f = fixture();
  try {
    let release!: () => void;
    let arrivals = 0;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beforePush = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
    };
    const inputs = [f.input(1, f.a), f.input(2, f.b)].map((input) => ({ ...input, beforePush }));
    const results = await Promise.allSettled(
      inputs.map((input) => promoteCanonicalRefsWithWorkspace(input, f.dependencies)),
    );
    const successful = results.filter((result) => result.status === "fulfilled");
    const failed = results.filter((result) => result.status === "rejected");
    expect(successful).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(CanonicalRefConflictError);
    expect(f.pair()).toEqual(successful[0].value);
    expect(f.pushes()).toHaveLength(2);
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it.each(["code", "fence"])(
  "rejects an external %s edit before attempting a push",
  async (changed) => {
    const f = fixture();
    try {
      const first = await promoteCanonicalRefsWithWorkspace(f.input(), f.dependencies);
      if (changed === "code") f.git("--git-dir", f.remote, "update-ref", f.headRef, f.b);
      else f.git("--git-dir", f.remote, "update-ref", "-d", f.fenceRef);
      const external = f.pair();
      await expect(
        promoteCanonicalRefsWithWorkspace(f.input(2, f.b, first), f.dependencies),
      ).rejects.toBeInstanceOf(CanonicalRefConflictError);
      expect(f.pair()).toEqual(external);
      expect(f.pushes()).toHaveLength(1);
      f.expectClean();
    } finally {
      f.cleanup();
    }
  },
);

it("keeps both transaction refs untouched when an external code writer races the push", async () => {
  const f = fixture();
  try {
    const input = f.input(1, f.b);
    input.beforePush = async () => {
      f.git("--git-dir", f.remote, "update-ref", f.headRef, f.a);
    };
    await expect(promoteCanonicalRefsWithWorkspace(input, f.dependencies)).rejects.toBeInstanceOf(
      CanonicalRefConflictError,
    );
    expect(f.pair()).toEqual({ headSha: f.a, fenceSha: null });
    expect(f.pushes()).toHaveLength(1);
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it("fails without a sequential fallback when the remote does not support atomic pushes", async () => {
  const f = fixture();
  try {
    f.git("--git-dir", f.remote, "config", "receive.advertiseAtomic", "false");
    await expect(promoteCanonicalRefsWithWorkspace(f.input(), f.dependencies)).rejects.toThrow(
      ERROR,
    );
    expect(f.pair()).toEqual({ headSha: null, fenceSha: null });
    expect(f.pushes()).toHaveLength(1);
    expect(f.pushes()[0][0]).toContain("--atomic");
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it("reconciles a lost successful push response and never republishes its fence", async () => {
  const f = fixture();
  try {
    const first = await promoteCanonicalRefsWithWorkspace(f.input(), f.dependencies);
    const dependencies = {
      ...f.dependencies,
      execGit: async (...args: Parameters<GitExecutor>) => {
        const result = await f.dependencies.execGit(...args);
        if (args[0][0] === "push") throw new Error("Successful transaction response lost");
        return result;
      },
    };
    const input = f.input(2, f.b, first);
    const expected = { headSha: input.desiredSha, fenceSha: input.desiredFenceSha };
    expect(await promoteCanonicalRefsWithWorkspace(input, dependencies)).toEqual(expected);
    expect(await promoteCanonicalRefsWithWorkspace(input, dependencies)).toEqual(expected);
    expect(f.pushes()).toHaveLength(2);
    expect(f.pair()).toEqual(expected);
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it("retries safely after a transport failure before either ref is pushed and sanitizes credentials", async () => {
  const f = fixture();
  try {
    const input = f.input();
    const dependencies = {
      ...f.dependencies,
      execGit: async (...args: Parameters<GitExecutor>) => {
        if (args[0][0] === "push") {
          const auth = Buffer.from(`x-access-token:${input.token}`).toString("base64");
          throw new Error(`${input.token} AUTHORIZATION: basic ${auth}`);
        }
        return f.dependencies.execGit(...args);
      },
    };
    await expect(promoteCanonicalRefsWithWorkspace(input, dependencies)).rejects.toThrow(
      new RegExp(`^${ERROR.replaceAll(".", "\\.")}$`),
    );
    expect(f.pair()).toEqual({ headSha: null, fenceSha: null });
    expect(await promoteCanonicalRefsWithWorkspace(input, f.dependencies)).toEqual({
      headSha: input.desiredSha,
      fenceSha: input.desiredFenceSha,
    });
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it("rejects an external edit discovered after a successful push response", async () => {
  const f = fixture();
  try {
    const dependencies = {
      ...f.dependencies,
      execGit: async (...args: Parameters<GitExecutor>) => {
        const result = await f.dependencies.execGit(...args);
        if (args[0][0] === "push") f.git("--git-dir", f.remote, "update-ref", f.headRef, f.b);
        return result;
      },
    };
    const input = f.input();
    await expect(promoteCanonicalRefsWithWorkspace(input, dependencies)).rejects.toBeInstanceOf(
      CanonicalRefConflictError,
    );
    expect(f.pair()).toEqual({ headSha: f.b, fenceSha: input.desiredFenceSha });
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it.each(["source", "fence"])(
  "fails closed if the pinned %s SHA does not match its object",
  async (changed) => {
    const f = fixture();
    try {
      const input = f.input();
      if (changed === "source") f.git("--git-dir", f.remote, "update-ref", input.sourceRef, f.b);
      else input.desiredFenceSha = "a".repeat(40);
      await expect(promoteCanonicalRefsWithWorkspace(input, f.dependencies)).rejects.toThrow(ERROR);
      expect(f.pair()).toEqual({ headSha: null, fenceSha: null });
      expect(f.pushes()).toHaveLength(0);
      f.expectClean();
    } finally {
      f.cleanup();
    }
  },
);

it("does not push after losing ownership", async () => {
  const f = fixture();
  try {
    const input = f.input();
    input.beforePush = async () => {
      throw new Error(`Stale claim ${input.token}`);
    };
    await expect(promoteCanonicalRefsWithWorkspace(input, f.dependencies)).rejects.toThrow(ERROR);
    expect(f.pushes()).toHaveLength(0);
    expect(f.pair()).toEqual({ headSha: null, fenceSha: null });
    f.expectClean();
  } finally {
    f.cleanup();
  }
});

it.each(["ownership", "push", "verification"])(
  "does not accept a canceled operation during %s",
  async (stage) => {
    const f = fixture();
    try {
      const input = f.input();
      const controller = new AbortController();
      input.signal = controller.signal;
      if (stage === "ownership") input.beforePush = async () => controller.abort(input.token);
      let pushed = false;
      const dependencies = {
        ...f.dependencies,
        execGit: async (...args: Parameters<GitExecutor>) => {
          const result = await f.dependencies.execGit(...args);
          if (args[0][0] === "push") {
            pushed = true;
            if (stage === "push") controller.abort(input.token);
          }
          if (stage === "verification" && pushed && args[0][0] === "ls-remote")
            controller.abort(input.token);
          return result;
        },
      };
      await expect(promoteCanonicalRefsWithWorkspace(input, dependencies)).rejects.toThrow(ERROR);
      expect(f.pair()).toEqual(
        stage === "ownership"
          ? { headSha: null, fenceSha: null }
          : { headSha: input.desiredSha, fenceSha: input.desiredFenceSha },
      );
      f.expectClean();
    } finally {
      f.cleanup();
    }
  },
);

it("validates branch identities and canonical remote URL before creating a workspace", async () => {
  const f = fixture();
  try {
    const input = f.input();
    for (const invalid of [
      { operationId: "not-a-uuid" },
      { branchName: "wallie/sessions/unrelated" },
      { fenceRef: `refs/wallie/fences/${SESSION}` },
      { fenceRef: `refs/heads/wallie/session-fences/${SESSION}` },
      { sourceRef: `refs/wallie/checkpoints/${RUN}/${f.b}` },
      { sourceRef: `refs/wallie/fences/${EPOCH}` },
      { sourceRef: "refs/tags/source" },
      { remoteUrl: "https://credential@github.com/acme/app.git" },
    ]) {
      await expect(
        promoteCanonicalRefsWithWorkspace({ ...input, ...invalid }, f.dependencies),
      ).rejects.toThrow();
    }
    expect(f.dependencies.createWorkspace).not.toHaveBeenCalled();
    expect(f.dependencies.execGit).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});
