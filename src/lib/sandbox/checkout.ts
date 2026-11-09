import { isWallieCheckpointRef } from "@/lib/checkpoint-ref";
import { shellQuote } from "./command";
import type { SandboxHandle } from "./types";

export type SandboxCheckpoint = { sha: string; ref?: string };

export class SandboxCheckpointRecoveryError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "repository_setup_failed"
      | "checkpoint_unavailable"
      | "checkout_failed"
      | "checkpoint_command_failed"
      | "sha_mismatch"
      | "dirty_checkout",
    readonly exitCode?: number,
  ) {
    const message = {
      invalid_input:
        "The pinned Git checkpoint or attempt branch is invalid. Restore a valid checkpoint before retrying.",
      repository_setup_failed:
        "The sandbox Git repository could not be initialized. Check sandbox setup before retrying.",
      checkpoint_unavailable:
        "Fetching the pinned Git commit failed. Check repository access, connectivity, and its checkpoint ref before retrying.",
      checkout_failed:
        "The pinned Git commit could not be checked out. Check the sandbox filesystem before retrying.",
      checkpoint_command_failed:
        "The sandbox Git checkpoint command failed. Check the sandbox runtime before retrying.",
      sha_mismatch:
        "The retained Git checkpoint no longer matches the pinned commit. Restore the original checkpoint ref before retrying.",
      dirty_checkout:
        "The sandbox contains uncommitted work. Preserve that work before restoring a checkpoint.",
    }[code];
    super(exitCode === undefined ? message : `${message} (exit ${exitCode})`);
    this.name = "SandboxCheckpointRecoveryError";
  }
}

export function assertValidSandboxCheckpoint(checkpoint: SandboxCheckpoint): void {
  if (
    !/^[a-f0-9]{40}$/.test(checkpoint.sha) ||
    (checkpoint.ref !== undefined &&
      !/^refs\/(heads|tags)\/[^\s\x00-\x1f\x7f]+$/.test(checkpoint.ref) &&
      !isWallieCheckpointRef(checkpoint.ref, checkpoint.sha))
  ) {
    throw new SandboxCheckpointRecoveryError("invalid_input");
  }
}

/** Shared by provider setup and the initial-base pinning compatibility path. */
export async function checkoutSandboxCheckpoint(input: {
  sandbox: SandboxHandle;
  branch: string;
  checkpoint: SandboxCheckpoint;
  signal?: AbortSignal;
}): Promise<void> {
  assertValidSandboxCheckpoint(input.checkpoint);
  input.signal?.throwIfAborted();
  const { sha, ref } = input.checkpoint;
  const git = "git -c core.hooksPath=/dev/null -c gc.auto=0 -c maintenance.auto=false";
  const script = [
    "set -euo pipefail",
    `git check-ref-format --branch ${shellQuote(input.branch)} >/dev/null 2>&1 || exit 70`,
    'status="$(git status --porcelain --untracked-files=normal)" || exit 75',
    'test -z "$status" || exit 73',
    ...(ref
      ? [
          `git check-ref-format ${shellQuote(ref)} >/dev/null 2>&1 || exit 70`,
          // Always fetch the named ref: a cached SHA cannot prove that the remote
          // retained ref still names it.
          `${git} fetch --no-tags --depth 1 origin ${shellQuote(ref)} >/dev/null 2>&1 || exit 71`,
          `test "$(git rev-parse --verify 'FETCH_HEAD^{commit}')" = ${shellQuote(sha)} || exit 72`,
        ]
      : [
          `git cat-file -e ${shellQuote(`${sha}^{commit}`)} 2>/dev/null || ${git} fetch --no-tags --depth 1 origin ${shellQuote(sha)} >/dev/null 2>&1 || exit 71`,
        ]),
    `${git} -c submodule.recurse=false checkout -B ${shellQuote(input.branch)} ${shellQuote(sha)} -- >/dev/null 2>&1 || exit 74`,
    `test "$(git rev-parse --verify 'HEAD^{commit}')" = ${shellQuote(sha)} || exit 72`,
    `test "$(git symbolic-ref --short HEAD)" = ${shellQuote(input.branch)} || exit 72`,
  ].join("\n");
  const process = await input.sandbox.exec("bash", ["-lc", script], {
    cwd: input.sandbox.repoPath,
    signal: input.signal,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  const [, code] = await Promise.all([process.output(), process.exitCode]);
  input.signal?.throwIfAborted();
  if (code !== 0)
    throw new SandboxCheckpointRecoveryError(
      code === 70
        ? "invalid_input"
        : code === 72
          ? "sha_mismatch"
          : code === 73
            ? "dirty_checkout"
            : code === 71
              ? "checkpoint_unavailable"
              : code === 74
                ? "checkout_failed"
                : "checkpoint_command_failed",
      code,
    );
}
