import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import {
  captureSourceCheckpoint,
  MAX_SOURCE_CHECKPOINT_BYTES,
  readSourceBase,
  SOURCE_CHECKPOINT_REF,
  UnsafeRuntimeCheckpointError,
} from "./source-checkpoint";

function git(sandbox: FakeSandbox, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: sandbox.repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(sandbox: FakeSandbox): void {
  git(sandbox, "add", "--all");
  git(sandbox, "commit", "-qm", "Fixture source");
}

it("restores committed, unstaged and untracked source after the original sandbox is destroyed", async () => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  const recovery = mkdtempSync(join(tmpdir(), "wallie-source-restore-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: recovery,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    const baseSha = await readSourceBase(sandbox);
    // A recovery checkout has only the original base; the incremental bundle
    // must supply all agent commits and the final working-tree checkpoint.
    git("clone", "--bare", sandbox.repoPath, join(recovery, "base.git"));
    await sandbox.writeFile(`${sandbox.repoPath}/committed.txt`, "agent commit\n");
    expect(await (await sandbox.exec("git", ["add", "committed.txt"])).exitCode).toBe(0);
    expect(await (await sandbox.exec("git", ["commit", "-qm", "Agent change"])).exitCode).toBe(0);
    await sandbox.writeFile(`${sandbox.repoPath}/committed.txt`, "unstaged edit\n");
    await sandbox.writeFile(`${sandbox.repoPath}/generated.txt`, "generated work\n");
    const source = await captureSourceCheckpoint({ sandbox, baseSha });
    expect(source.kind).toBe("bundle");
    if (source.kind !== "bundle") throw new Error("Missing bundle");
    await sandbox.stop();
    const bundle = join(recovery, "source.bundle");
    writeFileSync(bundle, source.bytes);
    git(
      "--git-dir",
      join(recovery, "base.git"),
      "fetch",
      bundle,
      `${SOURCE_CHECKPOINT_REF}:refs/heads/recovered`,
    );
    expect(git("--git-dir", join(recovery, "base.git"), "rev-parse", "recovered")).toBe(
      source.headSha,
    );
    expect(git("--git-dir", join(recovery, "base.git"), "show", "recovered:committed.txt")).toBe(
      "unstaged edit",
    );
    expect(git("--git-dir", join(recovery, "base.git"), "show", "recovered:generated.txt")).toBe(
      "generated work",
    );
    expect(
      source.bytes
        .toString("utf8")
        .split("\n")
        .some((line) => line.startsWith(`-${baseSha} `)),
    ).toBe(true);
  } finally {
    await sandbox.stop();
    rmSync(recovery, { recursive: true, force: true });
  }
});

it("records no source delivery for an unchanged analysis-only checkout", async () => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    const baseSha = await readSourceBase(sandbox);
    expect(await captureSourceCheckpoint({ sandbox, baseSha })).toEqual({
      kind: "unchanged",
      baseSha,
      headSha: baseSha,
    });
  } finally {
    await sandbox.stop();
  }
});

it("ignores repository hooks during the checkpoint commit", async () => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    const baseSha = await readSourceBase(sandbox);
    await sandbox.writeFile(`${sandbox.repoPath}/.git/hooks/pre-commit`, "#!/bin/sh\nexit 99\n", {
      mode: 0o755,
    });
    await sandbox.writeFile(`${sandbox.repoPath}/generated.txt`, "source");
    expect((await captureSourceCheckpoint({ sandbox, baseSha })).kind).toBe("bundle");
  } finally {
    await sandbox.stop();
  }
});

it("deliberately preserves safe deletions, renames, ignored tracked edits and unusual filenames", async () => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    await sandbox.writeFile(`${sandbox.repoPath}/deleted.ts`, "remove this\n");
    await sandbox.writeFile(`${sandbox.repoPath}/old name.ts`, "rename this\n");
    await sandbox.writeFile(`${sandbox.repoPath}/tracked.generated.ts`, "tracked source\n");
    commit(sandbox);
    const baseSha = await readSourceBase(sandbox);
    rmSync(join(sandbox.repoPath, "deleted.ts"));
    git(sandbox, "mv", "old name.ts", "new\nname.ts");
    await sandbox.writeFile(`${sandbox.repoPath}/.gitignore`, "*.generated.ts\nignored-output/\n");
    await sandbox.writeFile(`${sandbox.repoPath}/tracked.generated.ts`, "changed tracked source\n");
    await sandbox.writeFile(
      `${sandbox.repoPath}/ignored-output/secret.txt`,
      "ignored local file\n",
    );
    await sandbox.writeFile(`${sandbox.repoPath}/space and\nnewline.ts`, "safe source\n");
    await sandbox.writeFile(`${sandbox.repoPath}/:(glob)**.ts`, "literal source path\n");
    await sandbox.writeFile(`${sandbox.repoPath}/docs/prompt.txt`, "a product prompt fixture\n");
    await sandbox.writeFile(`${sandbox.repoPath}/src/auth.json`, '{"public":true}\n');

    const source = await captureSourceCheckpoint({ sandbox, baseSha });
    expect(source.kind).toBe("bundle");
    expect(source.headSha).toBe(git(sandbox, "rev-parse", "HEAD"));
    const paths = git(sandbox, "ls-tree", "-rz", "--name-only", source.headSha).split("\0");
    expect(paths).not.toContain("deleted.ts");
    expect(paths).not.toContain("old name.ts");
    expect(paths).not.toContain("ignored-output/secret.txt");
    expect(paths).toEqual(
      expect.arrayContaining([
        "new\nname.ts",
        "space and\nnewline.ts",
        ":(glob)**.ts",
        "docs/prompt.txt",
        "src/auth.json",
      ]),
    );
    expect(git(sandbox, "show", `${source.headSha}:tracked.generated.ts`)).toBe(
      "changed tracked source",
    );
    expect(git(sandbox, "status", "--porcelain")).toBe("");
    const capture = sandbox.calls.find((call) => call.cmd === "bash")!;
    expect(capture.args[1]).not.toContain("git add --all");
  } finally {
    await sandbox.stop();
  }
});

it.each([
  "prompt.txt",
  "auth.json",
  "codex/auth.json",
  "data/opencode/auth.json",
  ".codex/auth.json",
  ".claude/cache.json",
  ".cursor/auth.json",
  ".config/opencode/auth.json",
  ".local/share/opencode/auth.json",
  ".git-credentials",
  ".env",
  ".env.local",
  "apps/web/.env.production.local",
  ".wallie-runner-copy/prompt.txt",
  "nested/wallie-codex-copy/prompt.txt",
])("rejects copied runtime path %s before changing the index", async (path) => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    const baseSha = await readSourceBase(sandbox);
    await sandbox.writeFile(`${sandbox.repoPath}/${path}`, "synthetic runtime material");
    await sandbox.writeFile(`${sandbox.repoPath}/safe.ts`, "safe source");
    await expect(captureSourceCheckpoint({ sandbox, baseSha })).rejects.toBeInstanceOf(
      UnsafeRuntimeCheckpointError,
    );
    expect(git(sandbox, "rev-parse", "HEAD")).toBe(baseSha);
    expect(git(sandbox, "diff", "--cached", "--name-only")).toBe("");
    expect(await sandbox.readFile(`${sandbox.repoPath}/${path}`)).toBe(
      "synthetic runtime material",
    );
    expect(await sandbox.readFile(`${sandbox.repoPath}/safe.ts`)).toBe("safe source");
  } finally {
    await sandbox.stop();
  }
});

it.each(["committed", "intermediate", "edited base"])(
  "rejects %s runtime files even when the final worktree appears safe",
  async (kind) => {
    const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
    try {
      const path = ".codex/auth.json";
      if (kind === "edited base") {
        await sandbox.writeFile(`${sandbox.repoPath}/${path}`, "original trusted fixture");
        commit(sandbox);
      }
      const baseSha = await readSourceBase(sandbox);
      await sandbox.writeFile(`${sandbox.repoPath}/${path}`, "synthetic runtime credential");
      commit(sandbox);
      if (kind === "intermediate") {
        rmSync(join(sandbox.repoPath, ".codex"), { recursive: true });
        commit(sandbox);
      }
      await expect(captureSourceCheckpoint({ sandbox, baseSha })).rejects.toBeInstanceOf(
        UnsafeRuntimeCheckpointError,
      );
      expect(git(sandbox, "for-each-ref", SOURCE_CHECKPOINT_REF)).toBe("");
    } finally {
      await sandbox.stop();
    }
  },
);

it("allows unchanged reserved files from the base and their deliberate deletion", async () => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    await sandbox.writeFile(`${sandbox.repoPath}/prompt.txt`, "trusted product fixture");
    await sandbox.writeFile(`${sandbox.repoPath}/auth.json`, "trusted public fixture");
    commit(sandbox);
    const baseSha = await readSourceBase(sandbox);
    rmSync(join(sandbox.repoPath, "prompt.txt"));
    await sandbox.writeFile(`${sandbox.repoPath}/source.ts`, "safe source");
    expect((await captureSourceCheckpoint({ sandbox, baseSha })).kind).toBe("bundle");
    expect(git(sandbox, "show", "HEAD:auth.json")).toBe("trusted public fixture");
  } finally {
    await sandbox.stop();
  }
});

it("leaves ignored runtime credentials outside the source checkpoint", async () => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    const baseSha = await readSourceBase(sandbox);
    await sandbox.writeFile(`${sandbox.repoPath}/.gitignore`, ".codex/\nprompt.txt\n");
    await sandbox.writeFile(`${sandbox.repoPath}/.codex/auth.json`, "synthetic local credential");
    await sandbox.writeFile(`${sandbox.repoPath}/prompt.txt`, "synthetic private prompt");
    await sandbox.writeFile(`${sandbox.repoPath}/source.ts`, "safe source");
    const source = await captureSourceCheckpoint({ sandbox, baseSha });
    expect(source.kind).toBe("bundle");
    expect(git(sandbox, "ls-tree", "--name-only", "HEAD")).not.toContain(".codex");
    expect(git(sandbox, "ls-tree", "--name-only", "HEAD")).not.toContain("prompt.txt");
    expect(await sandbox.readFile(`${sandbox.repoPath}/prompt.txt`)).toBe(
      "synthetic private prompt",
    );
  } finally {
    await sandbox.stop();
  }
});

it.each([
  "raw",
  "url",
  "json",
  "intermediate",
  "prompt",
  "binary boundary",
  "filename",
  "commit message",
])("rejects known %s runtime material copied into otherwise safe source paths", async (kind) => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  const credential = 'synthetic-token/with "quotes" and\\slashes';
  const prompt = "Private task prompt\nwith workspace instructions";
  try {
    const baseSha = await readSourceBase(sandbox);
    const copied =
      kind === "url"
        ? encodeURIComponent(credential)
        : kind === "json"
          ? JSON.stringify(credential).slice(1, -1)
          : kind === "prompt"
            ? prompt
            : credential;
    await sandbox.writeFile(
      `${sandbox.repoPath}/${kind === "filename" ? `src/${credential}.ts` : "source.ts"}`,
      kind === "binary boundary"
        ? Buffer.concat([Buffer.alloc(65530, 0), Buffer.from(copied), Buffer.alloc(30, 0)])
        : kind === "filename" || kind === "commit message"
          ? "safe source"
          : `copied runtime: ${copied}\n`,
    );
    if (kind === "intermediate") {
      commit(sandbox);
      await sandbox.writeFile(`${sandbox.repoPath}/source.ts`, "safe replacement");
    }
    if (kind === "commit message") {
      git(sandbox, "add", "--all");
      git(sandbox, "commit", "-qm", credential);
    }
    let error: unknown;
    try {
      await captureSourceCheckpoint({
        sandbox,
        baseSha,
        sensitiveValues: [credential, prompt],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnsafeRuntimeCheckpointError);
    expect(String(error)).not.toContain(credential);
    expect(String(error)).not.toContain("source.ts");
    expect(git(sandbox, "for-each-ref", SOURCE_CHECKPOINT_REF)).toBe("");
    if (kind !== "intermediate" && kind !== "commit message")
      expect(git(sandbox, "rev-parse", "HEAD")).toBe(baseSha);
    const privateFile = [...sandbox.files.entries()].find(([path]) =>
      path.endsWith("/sensitive.json"),
    );
    expect(privateFile?.[1].mode).toBe(0o600);
    expect(privateFile && existsSync(privateFile[0])).toBe(false);
    expect(JSON.stringify(sandbox.calls)).not.toContain(credential);
    expect(JSON.stringify(sandbox.calls)).not.toContain(prompt);
  } finally {
    await sandbox.stop();
  }
});

it("ignores short known values and preserves safe source with runtime matching enabled", async () => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    const baseSha = await readSourceBase(sandbox);
    await sandbox.writeFile(`${sandbox.repoPath}/source.ts`, "safe code with abc in it\n");
    expect(
      (
        await captureSourceCheckpoint({
          sandbox,
          baseSha,
          sensitiveValues: ["abc", "synthetic-unrelated-secret"],
        })
      ).kind,
    ).toBe("bundle");
  } finally {
    await sandbox.stop();
  }
});

it("rejects malformed transport output rather than persisting a truncated checkpoint", async () => {
  const sandbox = new FakeSandbox();
  const sha = "a".repeat(40);
  sandbox.scriptExec("bash", [{ stream: "stdout", data: `BUNDLE\n${sha}\n100\nYWJj` }]);
  await expect(captureSourceCheckpoint({ sandbox, baseSha: sha })).rejects.toThrow(
    "invalid bundle",
  );
});

it("sanitizes private runtime-file transport failures and still removes the directory", async () => {
  const sandbox = new FakeSandbox();
  const secret = "synthetic-sensitive-transport-value";
  vi.spyOn(sandbox, "writeFile").mockRejectedValueOnce(new Error(secret));
  await expect(
    captureSourceCheckpoint({
      sandbox,
      baseSha: "a".repeat(40),
      sensitiveValues: [secret],
    }),
  ).rejects.toThrow("Could not preserve the source checkpoint.");
  expect(sandbox.calls.at(-1)?.cmd).toBe("rm");
  expect(JSON.stringify(sandbox.calls)).not.toContain(secret);
});

it("keeps the 4 MiB bundle limit without discarding oversized source", async () => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    const baseSha = await readSourceBase(sandbox);
    const bytes = randomBytes(MAX_SOURCE_CHECKPOINT_BYTES + 128 * 1024);
    await sandbox.writeFile(`${sandbox.repoPath}/oversized.bin`, bytes);
    await expect(captureSourceCheckpoint({ sandbox, baseSha })).rejects.toThrow(
      "Source checkpoint exceeds 4 MiB.",
    );
    expect(existsSync(join(sandbox.repoPath, "oversized.bin"))).toBe(true);
    expect(git(sandbox, "rev-parse", "HEAD")).not.toBe(baseSha);
  } finally {
    await sandbox.stop();
  }
});

const lfsPointer = (oid: string) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${oid.repeat(64)}\nsize 12345\n`;

it.each(["new", "modified", "intermediate", "legacy"])(
  "rejects a %s LFS pointer whose payload cannot be restored from the Git bundle",
  async (kind) => {
    const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
    const commit = async () => {
      expect(await (await sandbox.exec("git", ["add", "--all"])).exitCode).toBe(0);
      expect(await (await sandbox.exec("git", ["commit", "-qm", "Pointer change"])).exitCode).toBe(
        0,
      );
    };
    try {
      if (kind === "modified") {
        await sandbox.writeFile(`${sandbox.repoPath}/asset.bin`, lfsPointer("a"));
        await commit();
      }
      const baseSha = await readSourceBase(sandbox);
      const pointer =
        kind === "legacy"
          ? lfsPointer("b").replace("git-lfs.github.com", "hawser.github.com")
          : lfsPointer("b");
      await sandbox.writeFile(`${sandbox.repoPath}/asset.bin`, pointer);
      if (kind === "intermediate") {
        await commit();
        await sandbox.writeFile(`${sandbox.repoPath}/asset.bin`, "ordinary replacement");
      }
      await expect(captureSourceCheckpoint({ sandbox, baseSha })).rejects.toThrow(
        "Changed Git LFS files",
      );
      expect(await sandbox.readFile(`${sandbox.repoPath}/asset.bin`)).toBe(
        kind === "intermediate" ? "ordinary replacement" : pointer,
      );
    } finally {
      await sandbox.stop();
    }
  },
);

it("allows unchanged LFS pointers already present in the original base", async () => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    await sandbox.writeFile(`${sandbox.repoPath}/asset.bin`, lfsPointer("a"));
    await (
      await sandbox.exec("git", ["add", "--all"])
    ).exitCode;
    await (
      await sandbox.exec("git", ["commit", "-qm", "Original pointer"])
    ).exitCode;
    const baseSha = await readSourceBase(sandbox);
    await sandbox.writeFile(`${sandbox.repoPath}/ordinary.txt`, "source");
    expect((await captureSourceCheckpoint({ sandbox, baseSha })).kind).toBe("bundle");
  } finally {
    await sandbox.stop();
  }
});

it.each(["new", "advanced", "intermediate", "unchanged", "ignored dirty"])(
  "checks %s submodule source independently of the superproject bundle",
  async (kind) => {
    const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
    const submodule = new FakeSandbox(undefined, { passthroughExec: true });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const commit = (cwd: string) => {
      git(cwd, "add", "--all");
      git(
        cwd,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "Fixture change",
      );
    };
    try {
      let baseSha = await readSourceBase(sandbox);
      git(
        sandbox.repoPath,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        submodule.repoPath,
        "payload",
      );
      if (kind === "ignored dirty")
        git(sandbox.repoPath, "config", "-f", ".gitmodules", "submodule.payload.ignore", "all");
      if (kind !== "new") {
        commit(sandbox.repoPath);
        baseSha = await readSourceBase(sandbox);
      }
      const modulePath = join(sandbox.repoPath, "payload");
      const originalModuleHead = git(modulePath, "rev-parse", "HEAD");
      if (kind === "advanced" || kind === "intermediate") {
        writeFileSync(join(modulePath, "new-payload.txt"), "local-only submodule source");
        commit(modulePath);
        if (kind === "intermediate") {
          commit(sandbox.repoPath);
          git(modulePath, "checkout", originalModuleHead);
          commit(sandbox.repoPath);
        }
      } else if (kind === "unchanged") {
        await sandbox.writeFile(`${sandbox.repoPath}/ordinary.txt`, "superproject edit");
      } else if (kind === "ignored dirty") {
        writeFileSync(join(modulePath, "new-payload.txt"), "hidden untracked submodule source");
        expect(git(sandbox.repoPath, "status", "--porcelain")).toBe("");
      }
      if (kind === "unchanged") {
        expect((await captureSourceCheckpoint({ sandbox, baseSha })).kind).toBe("bundle");
      } else {
        await expect(captureSourceCheckpoint({ sandbox, baseSha })).rejects.toThrow(
          kind === "ignored dirty" ? "Could not preserve" : "Changed Git submodules",
        );
      }
    } finally {
      await sandbox.stop();
      await submodule.stop();
    }
  },
);
