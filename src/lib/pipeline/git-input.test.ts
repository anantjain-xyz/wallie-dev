import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

import { expect, it } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { checkoutPinnedGitInput } from "./git-input";
import { readSourceBase } from "./source-checkpoint";

it("fetches an absent pinned commit instead of executing the moving default branch", async () => {
  const remote = new FakeSandbox(undefined, { passthroughExec: true });
  const retry = new FakeSandbox(undefined, { passthroughExec: true });
  const git = (path: string, ...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
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

it("honors cancellation before touching the checkout", async () => {
  const sandbox = new FakeSandbox();
  const controller = new AbortController();
  controller.abort(new Error("Attempt expired"));
  await expect(
    checkoutPinnedGitInput({
      sandbox,
      branch: "wallie/retry",
      sha: "a".repeat(40),
      signal: controller.signal,
    }),
  ).rejects.toThrow("Attempt expired");
  expect(sandbox.calls).toEqual([]);
  await sandbox.stop();
});
