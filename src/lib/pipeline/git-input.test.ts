import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { checkoutPinnedGitInput } from "./git-input";
import { readSourceBase } from "./source-checkpoint";

const retainedRef = "refs/heads/wallie/checkpoints/reviewed-stage";
const reviewedCode = 'export const feature = "reviewed output";\n';
const defaultCode = 'export const feature = "later default branch";\n';

function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

async function createReviewedRemote() {
  const source = new FakeSandbox(undefined, { passthroughExec: true });
  const directory = mkdtempSync(join(tmpdir(), "wallie-reviewed-input-"));
  const remote = join(directory, "origin.git");
  try {
    git(directory, "init", "--bare", remote);
    git(source.repoPath, "remote", "add", "origin", remote);
    await source.writeFile(`${source.repoPath}/src/feature.ts`, reviewedCode);
    git(source.repoPath, "add", ".");
    git(source.repoPath, "commit", "-m", "Reviewed stage output");
    const reviewedSha = await readSourceBase(source);
    git(source.repoPath, "push", "origin", `HEAD:${retainedRef}`);

    git(source.repoPath, "checkout", "main");
    await source.writeFile(`${source.repoPath}/src/feature.ts`, defaultCode);
    git(source.repoPath, "add", ".");
    git(source.repoPath, "commit", "-m", "Default branch moved after review");
    const movedSha = await readSourceBase(source);
    git(source.repoPath, "push", "origin", "main");
    return { directory, remote, reviewedSha, movedSha };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    // Successor tests must restore from the retained remote, not the original
    // execution sandbox or any of its local objects.
    await source.stop();
  }
}

function checkoutMovingDefault(sandbox: FakeSandbox, remote: string): void {
  git(sandbox.repoPath, "remote", "add", "origin", remote);
  git(sandbox.repoPath, "fetch", "--depth=1", "origin", "main");
  git(sandbox.repoPath, "checkout", "-B", "wallie/fresh-successor", "FETCH_HEAD");
}

it("fetches an absent pinned commit instead of executing the moving default branch", async () => {
  const remote = new FakeSandbox(undefined, { passthroughExec: true });
  const retry = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    await remote.writeFile(`${remote.repoPath}/pinned.txt`, "fixed input");
    git(remote.repoPath, "add", ".");
    git(remote.repoPath, "commit", "-m", "Pinned input");
    const pinnedSha = await readSourceBase(remote);
    await remote.writeFile(`${remote.repoPath}/pinned.txt`, "default branch moved");
    git(remote.repoPath, "commit", "-am", "Later default branch");
    const movedSha = await readSourceBase(remote);
    git(retry.repoPath, "remote", "add", "origin", remote.repoPath);
    git(retry.repoPath, "fetch", "--depth=1", "origin", movedSha);
    git(retry.repoPath, "checkout", "-B", "wallie/retry", movedSha);
    expect(() => git(retry.repoPath, "cat-file", "-e", `${pinnedSha}^{commit}`)).toThrow();
    writeFileSync(`${retry.repoPath}/.git/hooks/post-checkout`, "#!/bin/sh\ntouch hook-ran\n", {
      mode: 0o755,
    });

    await checkoutPinnedGitInput({ sandbox: retry, branch: "wallie/retry", sha: pinnedSha });

    expect(await readSourceBase(retry)).toBe(pinnedSha);
    expect(await retry.readFile(`${retry.repoPath}/pinned.txt`)).toBe("fixed input");
    expect(existsSync(`${retry.repoPath}/hook-ran`)).toBe(false);
  } finally {
    await Promise.all([remote.stop(), retry.stop()]);
  }
});

it.each(["revision", "next-stage"])(
  "restores reviewed code for a fresh %s sandbox from its exact retained ref",
  async (successor) => {
    const { directory, remote, reviewedSha, movedSha } = await createReviewedRemote();
    const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
    try {
      checkoutMovingDefault(sandbox, remote);
      expect(await readSourceBase(sandbox)).toBe(movedSha);
      expect(await sandbox.readFile(`${sandbox.repoPath}/src/feature.ts`)).toBe(defaultCode);
      expect(() => git(sandbox.repoPath, "cat-file", "-e", `${reviewedSha}^{commit}`)).toThrow();
      expect(git(remote, "rev-parse", retainedRef)).toBe(reviewedSha);

      await checkoutPinnedGitInput({
        sandbox,
        branch: `wallie/${successor}/attempt-2`,
        sha: reviewedSha,
        ref: retainedRef,
      });

      expect(await readSourceBase(sandbox)).toBe(reviewedSha);
      expect(git(sandbox.repoPath, "symbolic-ref", "--short", "HEAD")).toBe(
        `wallie/${successor}/attempt-2`,
      );
      expect(await sandbox.readFile(`${sandbox.repoPath}/src/feature.ts`)).toBe(reviewedCode);
      expect(git(sandbox.repoPath, "status", "--porcelain")).toBe("");
      expect(git(remote, "rev-parse", "main")).toBe(movedSha);
    } finally {
      await sandbox.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each(["changed", "missing"])(
  "refuses a %s retained ref even with the reviewed SHA cached locally",
  async (state) => {
    const { directory, remote, reviewedSha, movedSha } = await createReviewedRemote();
    const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
    try {
      checkoutMovingDefault(sandbox, remote);
      git(sandbox.repoPath, "fetch", "--depth=1", "origin", retainedRef);
      expect(git(sandbox.repoPath, "rev-parse", `${reviewedSha}^{commit}`)).toBe(reviewedSha);
      if (state === "changed") git(remote, "update-ref", retainedRef, movedSha);
      else git(remote, "update-ref", "-d", retainedRef);

      await expect(
        checkoutPinnedGitInput({
          sandbox,
          branch: "wallie/revision/attempt-2",
          sha: reviewedSha,
          ref: retainedRef,
        }),
      ).rejects.toThrow(
        state === "changed"
          ? "The retained Git checkpoint no longer matches the pinned commit."
          : "The pinned Git checkpoint could not be fetched.",
      );
      expect(await readSourceBase(sandbox)).toBe(movedSha);
      expect(git(sandbox.repoPath, "symbolic-ref", "--short", "HEAD")).toBe(
        "wallie/fresh-successor",
      );
      expect(await sandbox.readFile(`${sandbox.repoPath}/src/feature.ts`)).toBe(defaultCode);
    } finally {
      await sandbox.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("fails closed when the pinned input is unavailable", async () => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    const original = await readSourceBase(sandbox);
    await expect(
      checkoutPinnedGitInput({ sandbox, branch: "wallie/retry", sha: "f".repeat(40) }),
    ).rejects.toThrow("Restore its retained ref or reconnect the repository before retrying.");
    expect(await readSourceBase(sandbox)).toBe(original);
    await expect(
      checkoutPinnedGitInput({ sandbox, branch: "wallie/retry", sha: "main; echo unsafe" }),
    ).rejects.toThrow("The pinned Git checkpoint or attempt branch is invalid.");
  } finally {
    await sandbox.stop();
  }
});

it("honors cancellation without changing the checkout or local work", async () => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  const original = git(sandbox.repoPath, "rev-parse", "HEAD");
  await sandbox.writeFile(`${sandbox.repoPath}/unfinished.ts`, "preserve local work");
  const controller = new AbortController();
  controller.abort(new Error("Attempt expired"));
  try {
    await expect(
      checkoutPinnedGitInput({
        sandbox,
        branch: "wallie/retry",
        sha: "a".repeat(40),
        ref: retainedRef,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Attempt expired");
    expect(sandbox.calls).toEqual([]);
    expect(git(sandbox.repoPath, "rev-parse", "HEAD")).toBe(original);
    expect(await sandbox.readFile(`${sandbox.repoPath}/unfinished.ts`)).toBe("preserve local work");
  } finally {
    await sandbox.stop();
  }
});
