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
    expect(await restoreAndPushSource(input, transport)).toBe(input.branch);
    expect(await restoreAndPushSource(input, transport)).toBe(input.branch);
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
    const recovered = await restoreAndPushSource(input, transport);
    expect(recovered).toMatch(/^wallie\/recovery\/[a-f0-9]{64}$/);
    expect(git("--git-dir", remote, "rev-parse", `refs/heads/${recovered}`)).toBe(
      checkpoint.headSha,
    );
    expect(git("--git-dir", remote, "rev-parse", "refs/heads/wallie/attempt-1")).toBe(newer);
    git("--git-dir", remote, "update-ref", "-d", "refs/heads/wallie/attempt-1");
    expect(await restoreAndPushSource(input, transport)).toBe(recovered);
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

async function deliveryFixture(branch = "wallie/attempt-recovery") {
  const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
  const root = mkdtempSync(join(tmpdir(), "wallie-source-recovery-"));
  const remote = join(root, "remote.git");
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repoGit = (...args: string[]) => git("-C", sandbox.repoPath, ...args);
  const baseSha = await readSourceBase(sandbox);
  git("clone", "--bare", sandbox.repoPath, remote);
  await sandbox.writeFile(`${sandbox.repoPath}/generated.txt`, "original agent push\n");
  repoGit("add", "generated.txt");
  repoGit("commit", "-qm", "Original agent commit");
  const original = repoGit("rev-parse", "HEAD");
  repoGit("push", remote, `HEAD:refs/heads/${branch}`);
  await sandbox.writeFile(`${sandbox.repoPath}/generated.txt`, "amended durable work\n");
  repoGit("add", "generated.txt");
  repoGit("commit", "--amend", "-qm", "Amended agent commit");
  const checkpoint = await captureSourceCheckpoint({ sandbox, baseSha });
  if (checkpoint.kind !== "bundle") throw new Error("Missing bundle");
  // Make the fixture's commit objects available to a competing remote writer.
  git("--git-dir", remote, "fetch", sandbox.repoPath, checkpoint.headSha);
  const input = {
    ...checkpoint,
    branch,
    remoteUrl: "https://github.com/acme/app.git",
    token: "synthetic-github-token",
    beforePush: vi.fn(async () => {}),
  };
  const transport = {
    execGit: vi.fn(
      (
        args: string[],
        options: Parameters<
          NonNullable<NonNullable<Parameters<typeof restoreAndPushSource>[1]>["execGit"]>
        >[1],
      ) =>
        promisify(execFile)(
          "git",
          args.map((arg) => (arg === input.remoteUrl ? `file://${remote}` : arg)),
          { ...options, encoding: "utf8" as const },
        ),
    ),
  };
  const remoteCommit = (parent: string) =>
    git(
      "-c",
      "user.name=Other",
      "-c",
      "user.email=other@example.com",
      "--git-dir",
      remote,
      "commit-tree",
      git("--git-dir", remote, "rev-parse", `${parent}^{tree}`),
      "-p",
      parent,
      "-m",
      "Remote work",
    );
  return {
    input,
    transport,
    git,
    remote,
    original,
    remoteCommit,
    cleanup: async () => {
      await sandbox.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("preserves a pushed commit after an agent amendment and uses a bounded stable recovery branch", async () => {
  const f = await deliveryFixture(`wallie/${"long-".repeat(40)}/attempt`);
  try {
    const branch = await restoreAndPushSource(f.input, f.transport);
    expect(branch).toMatch(/^wallie\/recovery\/[a-f0-9]{64}$/);
    expect(branch.length).toBeLessThanOrEqual(80);
    expect(f.git("--git-dir", f.remote, "show", `${branch}:generated.txt`)).toBe(
      "amended durable work",
    );
    expect(f.git("--git-dir", f.remote, "rev-parse", `refs/heads/${f.input.branch}`)).toBe(
      f.original,
    );
    expect(f.input.beforePush).toHaveBeenCalledTimes(2);
    expect(f.transport.execGit.mock.calls.filter(([args]) => args[0] === "push")).toHaveLength(2);
    f.git("--git-dir", f.remote, "update-ref", `refs/heads/${f.input.branch}`, f.input.headSha);
    expect(await restoreAndPushSource(f.input, f.transport)).toBe(branch);
    expect(f.input.beforePush).toHaveBeenCalledTimes(2);
  } finally {
    await f.cleanup();
  }
}, 20_000);

it("accepts a remote descendant using real ancestry despite shallow prerequisite restoration", async () => {
  const f = await deliveryFixture();
  try {
    const descendant = f.remoteCommit(f.input.headSha);
    f.git("--git-dir", f.remote, "update-ref", `refs/heads/${f.input.branch}`, descendant);
    expect(await restoreAndPushSource(f.input, f.transport)).toBe(f.input.branch);
    expect(f.transport.execGit.mock.calls.some(([args]) => args.includes("--depth=1"))).toBe(true);
    expect(f.transport.execGit.mock.calls.some(([args]) => args[0] === "merge-base")).toBe(true);
    expect(f.transport.execGit.mock.calls.some(([args]) => args[0] === "push")).toBe(false);
    expect(f.git("--git-dir", f.remote, "rev-parse", `refs/heads/${f.input.branch}`)).toBe(
      descendant,
    );
  } finally {
    await f.cleanup();
  }
}, 20_000);

it("recovers a raced fallback push only when the competing ref contains the checkpoint", async () => {
  const f = await deliveryFixture();
  try {
    const descendant = f.remoteCommit(f.input.headSha);
    const transport = {
      execGit: async (...args: Parameters<typeof f.transport.execGit>) => {
        const refspec = args[0][2];
        if (args[0][0] === "push" && refspec?.includes(":refs/heads/wallie/recovery/"))
          f.git("--git-dir", f.remote, "update-ref", refspec.split(":")[1], descendant);
        return f.transport.execGit(...args);
      },
    };
    const branch = await restoreAndPushSource(f.input, transport);
    expect(branch).toMatch(/^wallie\/recovery\//);
    expect(f.input.beforePush).toHaveBeenCalledTimes(2);
    expect(f.git("--git-dir", f.remote, "rev-parse", `refs/heads/${branch}`)).toBe(descendant);
    expect(f.git("--git-dir", f.remote, "rev-parse", `refs/heads/${f.input.branch}`)).toBe(
      f.original,
    );
    expect(await restoreAndPushSource(f.input, f.transport)).toBe(branch);
  } finally {
    await f.cleanup();
  }
}, 20_000);

it("keeps unrelated work when another writer races recovery branch creation", async () => {
  const f = await deliveryFixture();
  try {
    let recoveryRef = "";
    const transport = {
      execGit: async (...args: Parameters<typeof f.transport.execGit>) => {
        if (args[0][0] === "push" && args[0][2]?.includes(":refs/heads/wallie/recovery/")) {
          recoveryRef = args[0][2].split(":")[1];
          f.git("--git-dir", f.remote, "update-ref", recoveryRef, f.original);
        }
        return f.transport.execGit(...args);
      },
    };
    await expect(restoreAndPushSource(f.input, transport)).rejects.toThrow(
      "Could not restore and push",
    );
    expect(f.git("--git-dir", f.remote, "rev-parse", recoveryRef)).toBe(f.original);
    expect(f.git("--git-dir", f.remote, "rev-parse", `refs/heads/${f.input.branch}`)).toBe(
      f.original,
    );
  } finally {
    await f.cleanup();
  }
}, 20_000);

it("recovers a lost successful push response and keeps the same branch on retry", async () => {
  const f = await deliveryFixture();
  try {
    const transport = {
      execGit: async (...args: Parameters<typeof f.transport.execGit>) => {
        const result = await f.transport.execGit(...args);
        if (args[0][0] === "push") throw new Error("Successful push response lost");
        return result;
      },
    };
    const branch = await restoreAndPushSource(f.input, transport);
    expect(branch).toMatch(/^wallie\/recovery\//);
    expect(f.git("--git-dir", f.remote, "rev-parse", `refs/heads/${branch}`)).toBe(f.input.headSha);
    expect(await restoreAndPushSource(f.input, f.transport)).toBe(branch);
    expect(f.transport.execGit.mock.calls.filter(([args]) => args[0] === "push")).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
}, 20_000);

it("rechecks the lease before pushing a recovery branch", async () => {
  const f = await deliveryFixture();
  try {
    f.input.beforePush
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Lease lost"));
    await expect(restoreAndPushSource(f.input, f.transport)).rejects.toThrow(
      "Could not restore and push",
    );
    expect(f.input.beforePush).toHaveBeenCalledTimes(2);
    expect(f.transport.execGit.mock.calls.filter(([args]) => args[0] === "push")).toHaveLength(1);
    expect(
      f.git(
        "--git-dir",
        f.remote,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/wallie/recovery/",
      ),
    ).toBe("");
  } finally {
    await f.cleanup();
  }
}, 20_000);

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
