import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import {
  captureSourceCheckpoint,
  readSourceBase,
  SOURCE_CHECKPOINT_REF,
} from "./source-checkpoint";

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

it("rejects malformed transport output rather than persisting a truncated checkpoint", async () => {
  const sandbox = new FakeSandbox();
  const sha = "a".repeat(40);
  sandbox.scriptExec("bash", [{ stream: "stdout", data: `BUNDLE\n${sha}\n100\nYWJj` }]);
  await expect(captureSourceCheckpoint({ sandbox, baseSha: sha })).rejects.toThrow(
    "invalid bundle",
  );
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
