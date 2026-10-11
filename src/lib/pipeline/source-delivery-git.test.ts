import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { captureSourceCheckpoint, readSourceBase } from "./source-checkpoint";
import { restoreAndPushSource } from "./source-delivery-git";

it("pushes durable source after sandbox loss and safely retries an existing exact head", async () => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  const root = mkdtempSync(join(tmpdir(), "wallie-source-remote-"));
  const remote = join(root, "remote.git");
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const baseSha = await readSourceBase(sandbox);
    git("clone", "--bare", sandbox.repoPath, remote);
    await sandbox.writeFile(`${sandbox.repoPath}/generated.txt`, "durable work\n");
    const checkpoint = await captureSourceCheckpoint({ sandbox, baseSha });
    if (checkpoint.kind !== "bundle") throw new Error("Missing bundle");
    await sandbox.stop();
    const input = {
      ...checkpoint,
      branch: "wallie/attempt-1",
      remoteUrl: "https://github.com/acme/app.git",
      token: "synthetic-github-token",
    };
    const transport = {
      execGit: (
        args: string[],
        options: Parameters<
          NonNullable<NonNullable<Parameters<typeof restoreAndPushSource>[1]>["execGit"]>
        >[1],
      ) =>
        promisify(execFile)(
          "git",
          args.map((arg) => (arg === input.remoteUrl ? remote : arg)),
          { ...options, encoding: "utf8" as const },
        ),
    };
    await restoreAndPushSource(input, transport);
    await restoreAndPushSource(input, transport);
    expect(git("--git-dir", remote, "rev-parse", "refs/heads/wallie/attempt-1")).toBe(
      checkpoint.headSha,
    );
    expect(git("--git-dir", remote, "show", "wallie/attempt-1:generated.txt")).toBe("durable work");

    const tree = git("--git-dir", remote, "rev-parse", `${baseSha}^{tree}`);
    const newer = git(
      "-c",
      "user.name=Other",
      "-c",
      "user.email=other@example.com",
      "--git-dir",
      remote,
      "commit-tree",
      tree,
      "-p",
      baseSha,
      "-m",
      "Unrelated source",
    );
    git("--git-dir", remote, "update-ref", "refs/heads/wallie/attempt-1", newer);
    await expect(restoreAndPushSource(input, transport)).rejects.toThrow(
      "Could not restore and push",
    );
    expect(git("--git-dir", remote, "rev-parse", "refs/heads/wallie/attempt-1")).toBe(newer);
  } finally {
    await sandbox.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it("rejects checkpoint byte corruption before starting any remote operation", async () => {
  await expect(
    restoreAndPushSource({
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      branch: "work",
      bytes: Buffer.from("corrupt"),
      sha256: "bad",
      remoteUrl: "https://github.com/acme/app.git",
      token: "secret",
    }),
  ).rejects.toThrow("integrity verification");
});

it("restores merge history whose bundle requires more than the shallow base commit", async () => {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  const root = mkdtempSync(join(tmpdir(), "wallie-source-merge-"));
  const remote = join(root, "remote.git");
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repoGit = (...args: string[]) => git("-C", sandbox.repoPath, ...args);
  const change = (name: string) => {
    writeFileSync(join(sandbox.repoPath, name), name);
    repoGit("add", name);
    repoGit("commit", "-qm", name);
  };
  try {
    const branch = repoGit("branch", "--show-current");
    repoGit("checkout", "-qb", "side");
    change("side-before.txt");
    const sideBase = await readSourceBase(sandbox);
    repoGit("checkout", branch);
    change("main-before.txt");
    repoGit("merge", "--no-ff", "-qm", "Base merge", "side");
    const baseSha = await readSourceBase(sandbox);
    git("clone", "--bare", sandbox.repoPath, remote);
    repoGit("checkout", "side");
    change("side-after.txt");
    repoGit("checkout", branch);
    repoGit("merge", "--no-ff", "-qm", "Agent merge", "side");
    const checkpoint = await captureSourceCheckpoint({ sandbox, baseSha });
    if (checkpoint.kind !== "bundle") throw new Error("Missing bundle");
    const header = checkpoint.bytes.subarray(0, checkpoint.bytes.indexOf("\n\n")).toString("utf8");
    expect(header).toContain(`-${baseSha} `);
    expect(header).toContain(`-${sideBase} `);
    await sandbox.stop();
    await restoreAndPushSource(
      {
        ...checkpoint,
        branch: "wallie/merge",
        remoteUrl: "https://github.com/acme/app.git",
        token: "synthetic",
      },
      {
        execGit: (args, options) =>
          promisify(execFile)(
            "git",
            args.map((arg) =>
              arg === "https://github.com/acme/app.git" ? `file://${remote}` : arg,
            ),
            { ...options, encoding: "utf8" },
          ),
      },
    );
    expect(git("--git-dir", remote, "show", "wallie/merge:side-after.txt")).toBe("side-after.txt");
  } finally {
    await sandbox.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it("rejects non-GitHub transports before invoking a Git subprocess", async () => {
  const bytes = Buffer.from("untrusted transport");
  const { createHash } = await import("node:crypto");
  const execGit = vi.fn();
  await expect(
    restoreAndPushSource(
      {
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        branch: "work",
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        remoteUrl: "file:///private/source",
        token: "secret",
      },
      { execGit },
    ),
  ).rejects.toThrow("canonical GitHub");
  expect(execGit).not.toHaveBeenCalled();
});
