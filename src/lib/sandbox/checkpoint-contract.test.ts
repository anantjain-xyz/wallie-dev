import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkoutSandboxCheckpoint, SandboxCheckpointRecoveryError } from "./checkout";
import { FakeSandbox, listRunningFakeSandboxes } from "./fake";
import { createSessionSandbox } from "./index";
import { finalizeSandboxAcquisition } from "./lifecycle";
import type {
  CreateSessionSandboxInput,
  SandboxExecHandle,
  SandboxHandle,
  SandboxImplementation,
} from "./types";

const implementations = ["vercel", "e2b", "daytona", "fake"] as const;
const checkpointRef = "refs/heads/wallie/checkpoints/accepted-stage";
const canonicalOrigin = "https://github.com/acme/checkpoint-contract.git";
const installationToken = "checkpoint-contract-secret";

function git(repoPath: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: "pipe",
  }).trim();
}

function successfulProcess(): SandboxExecHandle {
  return {
    exitCode: Promise.resolve(0),
    kill: async () => {},
    logs: async function* () {},
    output: async () => ({ stdout: "", stderr: "" }),
  };
}

describe("exact checkpoint acquisition contract", () => {
  let root: string;
  let remote: FakeSandbox;
  let expectedSha: string;
  let laterSha: string;
  let origin: string;
  let owned: Set<FakeSandbox>;
  let stopped: FakeSandbox[];
  let bootstrapHeads: string[];
  let onCheckpointExec: (() => void) | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wallie-checkpoint-contract-"));
    mkdirSync(join(root, "home"));
    remote = new FakeSandbox(undefined, {
      baseBranch: "main",
      branch: "main",
      passthroughExec: true,
    });
    owned = new Set([remote]);
    stopped = [];
    bootstrapHeads = [];
    onCheckpointExec = undefined;

    writeFileSync(join(remote.repoPath, "earlier-stage.txt"), "accepted implementation\n");
    git(remote.repoPath, "add", "earlier-stage.txt");
    git(remote.repoPath, "commit", "-qm", "Accepted earlier stage");
    expectedSha = git(remote.repoPath, "rev-parse", "HEAD");
    git(remote.repoPath, "update-ref", checkpointRef, expectedSha);
    writeFileSync(join(remote.repoPath, "earlier-stage.txt"), "unrelated default branch change\n");
    git(remote.repoPath, "commit", "-qam", "Default branch moves after acceptance");
    laterSha = git(remote.repoPath, "rev-parse", "HEAD");
    origin = remote.repoPath;

    const exec = FakeSandbox.prototype.exec;
    vi.spyOn(FakeSandbox.prototype, "exec").mockImplementation(async function (
      this: FakeSandbox,
      cmd,
      args,
      options = {},
    ) {
      owned.add(this);
      // Run the actual Git/credential setup and checkpoint commands. Only the
      // dependency installation phase is omitted; it must see the exact HEAD.
      if (cmd === "bash" && args.some((arg) => arg.includes("npm install -g @openai/codex"))) {
        bootstrapHeads.push(git(this.repoPath, "rev-parse", "HEAD"));
        return successfulProcess();
      }
      const process = await exec.call(
        this,
        cmd,
        args.map((arg) => arg.replaceAll(canonicalOrigin, origin)),
        {
          ...options,
          env: {
            ...options.env,
            HOME: join(root, "home"),
            GIT_CONFIG_GLOBAL: join(root, "home", ".gitconfig"),
            GIT_CONFIG_NOSYSTEM: "1",
          },
        },
      );
      if (cmd === "bash" && args.some((arg) => arg.includes("git check-ref-format --branch"))) {
        onCheckpointExec?.();
      }
      return process;
    });
    const stop = FakeSandbox.prototype.stop;
    vi.spyOn(FakeSandbox.prototype, "stop").mockImplementation(function (this: FakeSandbox) {
      stopped.push(this);
      owned.add(this);
      return stop.call(this);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([...owned].map((sandbox) => sandbox.stop()));
    rmSync(root, { force: true, recursive: true });
  });

  async function acquire(
    implementation: SandboxImplementation,
    overrides: Partial<CreateSessionSandboxInput> = {},
  ): Promise<SandboxHandle> {
    const request = {
      agentProvider: "codex",
      baseBranch: "main",
      branch: "wallie/session/generation-2/attempt-1",
      implementation,
      installationToken,
      mode: { kind: "checkpoint", sha: expectedSha, ref: checkpointRef },
      repoFullName: "acme/checkpoint-contract",
      sessionId: "checkpoint-contract-session",
      ...overrides,
    } satisfies CreateSessionSandboxInput;
    if (implementation === "fake") return createSessionSandbox(request);

    const handle = new FakeSandbox(undefined, { passthroughExec: true });
    owned.add(handle);
    // Real provider checkpoint acquisition starts with an empty repository.
    rmSync(join(handle.repoPath, ".git"), { recursive: true });
    rmSync(join(handle.repoPath, "README.md"));
    return finalizeSandboxAcquisition({
      handle,
      provider: implementation,
      repoAlreadyCloned: false,
      request,
    });
  }

  function expectStoppedExactlyOnce() {
    expect(stopped).toHaveLength(1);
    expect(existsSync(stopped[0]!.repoPath)).toBe(false);
    expect(bootstrapHeads).toEqual([]);
  }

  it.each(implementations)(
    "%s starts each isolated attempt at the accepted checkpoint before bootstrap",
    async (implementation) => {
      const first = await acquire(implementation);
      expect(git(first.repoPath, "rev-parse", "HEAD")).toBe(expectedSha);
      expect(git(first.repoPath, "branch", "--show-current")).toBe(
        "wallie/session/generation-2/attempt-1",
      );
      expect(readFileSync(join(first.repoPath, "earlier-stage.txt"), "utf8")).toBe(
        "accepted implementation\n",
      );
      expect(git(remote.repoPath, "rev-parse", "main")).toBe(laterSha);

      writeFileSync(join(first.repoPath, "earlier-stage.txt"), "unaccepted attempt output\n");
      git(first.repoPath, "commit", "-qam", "Only the first attempt sees this");
      const second = await acquire(implementation, {
        branch: "wallie/session/generation-2/attempt-2",
      });
      expect(second.id).not.toBe(first.id);
      expect(git(second.repoPath, "rev-parse", "HEAD")).toBe(expectedSha);
      expect(git(second.repoPath, "branch", "--show-current")).toBe(
        "wallie/session/generation-2/attempt-2",
      );
      expect(readFileSync(join(second.repoPath, "earlier-stage.txt"), "utf8")).toBe(
        "accepted implementation\n",
      );
      expect(bootstrapHeads).toEqual(implementation === "fake" ? [] : [expectedSha, expectedSha]);
      expect(stopped).toEqual([]);
    },
  );

  it.each(implementations)(
    "%s fetches an exact initial base without a retained ref",
    async (implementation) => {
      const sandbox = await acquire(implementation, {
        mode: { kind: "checkpoint", sha: expectedSha },
      });
      expect(git(sandbox.repoPath, "rev-parse", "HEAD")).toBe(expectedSha);
      expect(readFileSync(join(sandbox.repoPath, "earlier-stage.txt"), "utf8")).toBe(
        "accepted implementation\n",
      );
    },
  );

  it("restores a custom checkpoint ref and refuses it after the commit changes", async () => {
    const ref = `refs/wallie/checkpoints/00000000-0000-4000-8000-000000000001/${expectedSha}`;
    git(remote.repoPath, "update-ref", ref, expectedSha);
    const sandbox = await acquire("fake", {
      mode: { kind: "checkpoint", sha: expectedSha, ref },
    });
    expect(git(sandbox.repoPath, "rev-parse", "HEAD")).toBe(expectedSha);

    git(remote.repoPath, "update-ref", ref, laterSha);
    await expect(
      acquire("fake", { mode: { kind: "checkpoint", sha: expectedSha, ref } }),
    ).rejects.toMatchObject({ code: "sha_mismatch" });
  });

  it.each(implementations)(
    "%s restores an annotated retained tag at its commit",
    async (implementation) => {
      const ref = "refs/tags/wallie-accepted-stage";
      git(
        remote.repoPath,
        "tag",
        "-a",
        "wallie-accepted-stage",
        expectedSha,
        "-m",
        "Accepted stage",
      );
      const sandbox = await acquire(implementation, {
        mode: { kind: "checkpoint", sha: expectedSha, ref },
      });
      expect(git(sandbox.repoPath, "rev-parse", "HEAD")).toBe(expectedSha);
      expect(readFileSync(join(sandbox.repoPath, "earlier-stage.txt"), "utf8")).toBe(
        "accepted implementation\n",
      );
    },
  );

  it.each(implementations)(
    "%s refuses a missing retained ref and cleans up",
    async (implementation) => {
      await expect(
        acquire(implementation, {
          mode: { kind: "checkpoint", sha: expectedSha, ref: "refs/heads/missing-checkpoint" },
        }),
      ).rejects.toMatchObject({
        name: "SandboxCheckpointRecoveryError",
        code: "checkpoint_unavailable",
      });
      expectStoppedExactlyOnce();
    },
  );

  it.each(implementations)(
    "%s refuses a replaced retained ref and cleans up",
    async (implementation) => {
      git(remote.repoPath, "update-ref", checkpointRef, laterSha);
      await expect(acquire(implementation)).rejects.toMatchObject({
        name: "SandboxCheckpointRecoveryError",
        code: "sha_mismatch",
      });
      expectStoppedExactlyOnce();
    },
  );

  it.each(implementations)(
    "%s reports unavailable origin without leaking its token",
    async (implementation) => {
      origin = join(root, "repository-that-no-longer-exists");
      const error = await acquire(implementation).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(SandboxCheckpointRecoveryError);
      expect(error).toMatchObject({ code: "checkpoint_unavailable" });
      expect((error as Error).message).toMatch(/checkpoint.*fetch|fetch.*checkpoint/i);
      expect((error as Error).message).not.toContain(installationToken);
      expectStoppedExactlyOnce();
    },
  );

  it.each(implementations)(
    "%s cleans up when cancelled after ownership is recorded",
    async (implementation) => {
      const controller = new AbortController();
      const reason = new Error("superseded attempt");
      const onSandboxCreated = vi.fn(async () => controller.abort(reason));
      await expect(
        acquire(implementation, { signal: controller.signal, onSandboxCreated }),
      ).rejects.toBe(reason);
      expect(onSandboxCreated).toHaveBeenCalledOnce();
      expectStoppedExactlyOnce();
      const running = await listRunningFakeSandboxes();
      expect(running.map((sandbox) => sandbox.id)).not.toContain(stopped[0]!.id);
    },
  );

  it.each(implementations)(
    "%s cleans up when cancelled during the checkpoint command",
    async (implementation) => {
      const controller = new AbortController();
      const reason = new Error("attempt cancelled during Git restore");
      const cancel = vi.fn(() => controller.abort(reason));
      onCheckpointExec = cancel;

      await expect(acquire(implementation, { signal: controller.signal })).rejects.toBe(reason);
      expect(cancel).toHaveBeenCalledOnce();
      expectStoppedExactlyOnce();
      const running = await listRunningFakeSandboxes();
      expect(running.map((sandbox) => sandbox.id)).not.toContain(stopped[0]!.id);
    },
  );

  it("verifies the retained ref even when the expected commit already exists locally", async () => {
    const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
    owned.add(sandbox);
    git(sandbox.repoPath, "remote", "add", "origin", remote.repoPath);
    git(sandbox.repoPath, "fetch", "origin", checkpointRef);
    expect(git(sandbox.repoPath, "cat-file", "-t", expectedSha)).toBe("commit");
    const before = git(sandbox.repoPath, "rev-parse", "HEAD");
    git(remote.repoPath, "update-ref", checkpointRef, laterSha);

    await expect(
      checkoutSandboxCheckpoint({
        sandbox,
        branch: "wallie/retry",
        checkpoint: { sha: expectedSha, ref: checkpointRef },
      }),
    ).rejects.toMatchObject({ code: "sha_mismatch" });
    expect(git(sandbox.repoPath, "rev-parse", "HEAD")).toBe(before);
    expect(git(sandbox.repoPath, "rev-parse", "FETCH_HEAD")).toBe(laterSha);
  });

  it("preserves uncommitted work instead of replacing it with the checkpoint", async () => {
    const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
    owned.add(sandbox);
    git(sandbox.repoPath, "remote", "add", "origin", remote.repoPath);
    const before = git(sandbox.repoPath, "rev-parse", "HEAD");
    writeFileSync(join(sandbox.repoPath, "README.md"), "valuable unfinished work\n");
    writeFileSync(join(sandbox.repoPath, "untracked.txt"), "also preserve this\n");

    await expect(
      checkoutSandboxCheckpoint({
        sandbox,
        branch: "wallie/retry",
        checkpoint: { sha: expectedSha, ref: checkpointRef },
      }),
    ).rejects.toMatchObject({ code: "dirty_checkout" });
    expect(git(sandbox.repoPath, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(sandbox.repoPath, "README.md"), "utf8")).toBe(
      "valuable unfinished work\n",
    );
    expect(readFileSync(join(sandbox.repoPath, "untracked.txt"), "utf8")).toBe(
      "also preserve this\n",
    );
  });

  it("does not execute a repository checkout hook", async () => {
    const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
    owned.add(sandbox);
    git(sandbox.repoPath, "remote", "add", "origin", remote.repoPath);
    const hookMarker = join(root, "checkout-hook-ran");
    writeFileSync(
      join(sandbox.repoPath, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\ntouch '${hookMarker}'\n`,
      { mode: 0o755 },
    );

    await checkoutSandboxCheckpoint({
      sandbox,
      branch: "wallie/retry",
      checkpoint: { sha: expectedSha, ref: checkpointRef },
    });
    expect(git(sandbox.repoPath, "rev-parse", "HEAD")).toBe(expectedSha);
    expect(git(sandbox.repoPath, "branch", "--show-current")).toBe("wallie/retry");
    expect(existsSync(hookMarker)).toBe(false);
  });

  it.each(["refs/heads/has..dots", "refs/heads/trailing.", "refs/heads/name@{1}"])(
    "rejects Git-invalid retained ref %s without changing HEAD",
    async (ref) => {
      const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
      owned.add(sandbox);
      git(sandbox.repoPath, "remote", "add", "origin", remote.repoPath);
      const before = git(sandbox.repoPath, "rev-parse", "HEAD");
      await expect(
        checkoutSandboxCheckpoint({
          sandbox,
          branch: "wallie/retry",
          checkpoint: { sha: expectedSha, ref },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(git(sandbox.repoPath, "rev-parse", "HEAD")).toBe(before);
    },
  );
});
