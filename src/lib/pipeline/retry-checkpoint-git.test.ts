import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { restoreRetryCheckpoint } from "./retry-checkpoint-git";
import { captureCommittedSourceCheckpoint, SOURCE_CHECKPOINT_REF } from "./source-checkpoint";

function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

async function retryFixture() {
  const producer = new FakeSandbox(undefined, { passthroughExec: true });
  const retry = new FakeSandbox(undefined, { passthroughExec: true });
  const scratch = mkdtempSync(join(tmpdir(), "wallie-retry-checkpoint-"));
  const remote = join(scratch, "origin.git");
  const cleanup = async () => {
    await Promise.all([producer.stop(), retry.stop()]);
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    const repo = producer.repoPath;
    git(scratch, "init", "--bare", remote);
    await producer.writeFile(join(repo, "feature.txt"), "accepted source\n");
    git(repo, "add", "feature.txt");
    git(repo, "commit", "-m", "Accepted stage");
    const baseSha = git(repo, "rev-parse", "HEAD");
    git(repo, "push", remote, "HEAD:refs/heads/accepted");
    git(retry.repoPath, "remote", "add", "origin", remote);
    git(retry.repoPath, "fetch", "--depth=1", "origin", "refs/heads/accepted");
    git(retry.repoPath, "checkout", "-B", "wallie/retry", baseSha);
    await producer.writeFile(join(repo, "feature.txt"), "recoverable implementation\n");
    git(repo, "commit", "-am", "Recoverable build");
    const checkpoint = await captureCommittedSourceCheckpoint({
      sandbox: producer,
      baseSha,
      headSha: git(repo, "rev-parse", "HEAD"),
    });
    if (checkpoint.kind !== "bundle") throw new Error("Missing retry fixture bundle.");
    return { checkpoint, producer, retry, remote, scratch, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

it("restores the exact private commit in a fresh shallow attempt with no remote writes", async () => {
  const { checkpoint, producer, retry, remote, cleanup } = await retryFixture();
  try {
    await producer.stop();
    const repo = retry.repoPath;
    const hookOutput = join(repo, "hook-ran");
    writeFileSync(join(repo, ".git/hooks/post-checkout"), "#!/bin/sh\ntouch hook-ran\n", {
      mode: 0o755,
    });
    expect(git(repo, "rev-parse", "--is-shallow-repository")).toBe("true");
    const before = git(remote, "show-ref");

    await restoreRetryCheckpoint({ sandbox: retry, ...checkpoint });

    expect(git(repo, "rev-parse", "HEAD")).toBe(checkpoint.headSha);
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("wallie/retry");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(await retry.readFile(join(repo, "feature.txt"))).toBe("recoverable implementation\n");
    expect(existsSync(hookOutput)).toBe(false);
    expect(git(remote, "show-ref")).toBe(before);
    expect(() => git(remote, "cat-file", "-e", checkpoint.headSha)).toThrow();
  } finally {
    await cleanup();
  }
});

it.each(["wrong digest", "wrong head", "wrong base", "dirty checkout"])(
  "leaves the attempt branch untouched for a %s",
  async (failure) => {
    const { checkpoint, retry, cleanup } = await retryFixture();
    try {
      const invalid = { ...checkpoint };
      if (failure === "wrong digest") invalid.sha256 = "0".repeat(64);
      if (failure === "wrong head") invalid.headSha = "0".repeat(40);
      if (failure === "wrong base") invalid.baseSha = "0".repeat(40);
      if (failure === "dirty checkout") {
        await retry.writeFile(join(retry.repoPath, "feature.txt"), "uncommitted work\n");
      }

      await expect(restoreRetryCheckpoint({ sandbox: retry, ...invalid })).rejects.toThrow(
        /checkpoint/,
      );

      expect(git(retry.repoPath, "rev-parse", "HEAD")).toBe(checkpoint.baseSha);
      expect(await retry.readFile(join(retry.repoPath, "feature.txt"))).toBe(
        failure === "dirty checkout" ? "uncommitted work\n" : "accepted source\n",
      );
    } finally {
      await cleanup();
    }
  },
);

it("rejects a valid exact-head bundle whose commit does not descend from the pinned base", async () => {
  const { checkpoint, producer, retry, scratch, cleanup } = await retryFixture();
  try {
    const repo = producer.repoPath;
    git(repo, "checkout", "--orphan", "unrelated");
    git(repo, "commit", "-m", "Unrelated source");
    const headSha = git(repo, "rev-parse", "HEAD");
    const bundlePath = join(scratch, "unrelated.bundle");
    git(repo, "update-ref", SOURCE_CHECKPOINT_REF, headSha);
    git(repo, "bundle", "create", bundlePath, SOURCE_CHECKPOINT_REF);
    const bytes = readFileSync(bundlePath);

    await expect(
      restoreRetryCheckpoint({
        sandbox: retry,
        baseSha: checkpoint.baseSha,
        headSha,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    ).rejects.toThrow("Wallie could not restore the saved retry checkpoint.");

    expect(git(retry.repoPath, "rev-parse", "HEAD")).toBe(checkpoint.baseSha);
  } finally {
    await cleanup();
  }
});
