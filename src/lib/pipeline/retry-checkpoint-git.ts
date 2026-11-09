import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { shellQuote } from "@/lib/sandbox/command";
import type { SandboxHandle } from "@/lib/sandbox/types";

import { MAX_SOURCE_CHECKPOINT_BYTES, SOURCE_CHECKPOINT_REF } from "./source-checkpoint";

const COMMIT_SHA = /^[a-f0-9]{40}$/;

/** Restore private source onto the fresh attempt branch without updating remote refs. */
export async function restoreRetryCheckpoint(input: {
  sandbox: SandboxHandle;
  baseSha: string;
  headSha: string;
  bytes: Buffer;
  sha256: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { sandbox, baseSha, headSha, bytes, sha256, signal } = input;
  signal?.throwIfAborted();
  if (
    !COMMIT_SHA.test(baseSha) ||
    !COMMIT_SHA.test(headSha) ||
    headSha === baseSha ||
    bytes.length > MAX_SOURCE_CHECKPOINT_BYTES ||
    createHash("sha256").update(bytes).digest("hex") !== sha256
  ) {
    throw new Error("The saved retry checkpoint failed integrity verification.");
  }

  const directory = `/tmp/wallie-retry-${randomUUID()}`;
  const bundle = `${directory}/source.bundle`;
  const git = "git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false";
  const script = [
    "set -euo pipefail",
    'ref="$(git symbolic-ref --quiet HEAD)"',
    'case "$ref" in refs/heads/?*) ;; *) exit 1 ;; esac',
    'branch="${ref#refs/heads/}"',
    `test "$(${git} rev-parse --verify 'HEAD^{commit}')" = ${shellQuote(baseSha)}`,
    `status="$(${git} status --porcelain --untracked-files=normal --ignore-submodules=none)"`,
    'test -z "$status"',
    `test "$(git bundle list-heads ${shellQuote(bundle)})" = ${shellQuote(`${headSha} ${SOURCE_CHECKPOINT_REF}`)}`,
    `git bundle verify ${shellQuote(bundle)}`,
    `git bundle unbundle ${shellQuote(bundle)}`,
    `git merge-base --is-ancestor ${shellQuote(baseSha)} ${shellQuote(headSha)}`,
    `${git} checkout --no-overwrite-ignore -B "$branch" ${shellQuote(headSha)} --`,
    `test "$(${git} rev-parse --verify 'HEAD^{commit}')" = ${shellQuote(headSha)}`,
    'test "$(git symbolic-ref --quiet HEAD)" = "$ref"',
  ].join("\n");

  try {
    const mkdir = await sandbox.exec("mkdir", ["-m", "700", directory], { cwd: "/tmp", signal });
    if ((await mkdir.exitCode) !== 0) throw new Error("Could not create checkpoint directory.");
    signal?.throwIfAborted();
    await sandbox.writeFile(bundle, bytes, { mode: 0o600 });
    signal?.throwIfAborted();
    const restore = await sandbox.exec("bash", ["--noprofile", "--norc", "-c", script], {
      cwd: sandbox.repoPath,
      env: {
        BASH_ENV: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_LFS_SKIP_SMUDGE: "1",
      },
      signal,
    });
    if ((await restore.exitCode) !== 0) throw new Error("Git checkpoint restore failed.");
    signal?.throwIfAborted();
  } catch {
    signal?.throwIfAborted();
    // Provider transport errors can contain uploaded source. Never retain their details.
    throw new Error("Wallie could not restore the saved retry checkpoint.");
  } finally {
    await sandbox
      .exec("rm", ["-rf", directory], { cwd: "/tmp", signal: AbortSignal.timeout(5_000) })
      .then((command) => command.exitCode)
      .catch(() => undefined);
  }
}
