import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { shellQuote } from "@/lib/sandbox/command";
import { WALLIE_GIT_IDENTITY_ENV } from "@/lib/sandbox/commit-author";
import type { SandboxHandle } from "@/lib/sandbox/types";

export const SOURCE_CHECKPOINT_BUCKET = "session-source-checkpoints";
export const MAX_SOURCE_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
export const SOURCE_CHECKPOINT_REF = "refs/heads/wallie-source-checkpoint";

export class UnsupportedLfsCheckpointError extends Error {
  constructor() {
    super("Changed Git LFS files cannot be preserved by source checkpoints.");
    this.name = "UnsupportedLfsCheckpointError";
  }
}

export class UnsupportedSubmoduleCheckpointError extends Error {
  constructor() {
    super("Changed Git submodules cannot be preserved by source checkpoints.");
    this.name = "UnsupportedSubmoduleCheckpointError";
  }
}

export type SourceCheckpoint =
  | { kind: "unchanged"; baseSha: string; headSha: string }
  | { kind: "bundle"; baseSha: string; headSha: string; bytes: Buffer; sha256: string };

/** Capture the checkout's base before the agent changes branches or commits. */
export async function readSourceBase(
  sandbox: SandboxHandle,
  signal?: AbortSignal,
): Promise<string> {
  const proc = await sandbox.exec("git", ["rev-parse", "--verify", "HEAD^{commit}"], { signal });
  const [output, code] = await Promise.all([proc.output(), proc.exitCode]);
  signal?.throwIfAborted();
  const sha = output.stdout.trim();
  if (code !== 0 || !COMMIT_SHA.test(sha))
    throw new Error("Could not identify the source checkout's base commit.");
  return sha;
}

/**
 * Preserve committed and nonignored working-tree changes in one incremental
 * bundle. Harness files live outside this checkout. Disabling hooks here keeps
 * capture from invoking repository-controlled scripts after the agent exits.
 */
export async function captureSourceCheckpoint(input: {
  sandbox: SandboxHandle;
  baseSha: string;
  signal?: AbortSignal;
}): Promise<SourceCheckpoint> {
  if (!COMMIT_SHA.test(input.baseSha)) throw new Error("Invalid source base commit.");
  input.signal?.throwIfAborted();
  const directory = `/tmp/wallie-source-${randomUUID()}`;
  const bundle = `${directory}/source.bundle`;
  const script = [
    "set -euo pipefail",
    "git add --all",
    "if ! git diff --cached --quiet; then git -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -qm 'Preserve Wallie stage source'; fi",
    // A superproject bundle cannot preserve dirty submodule worktrees.
    "if [ -n \"$(git status --porcelain --untracked-files=normal --ignore-submodules=none)\" ]; then echo 'Source checkout still contains uncommitted changes' >&2; exit 41; fi",
    "head=$(git rev-parse --verify 'HEAD^{commit}')",
    `if [ "$head" = ${shellQuote(input.baseSha)} ]; then printf 'UNCHANGED\\n%s\\n' "$head"; exit 0; fi`,
    // A clean gitlink can still point to a commit available only in a local
    // submodule. Check each new commit, including reverted intermediate edits.
    `git rev-list "$head" ${shellQuote(`^${input.baseSha}`)} | while read -r commit; do`,
    `  if git diff-tree --root --raw --no-commit-id --no-renames -r -m "$commit" | awk '$1 == ":160000" || $2 == "160000" { gitlink = 1 } END { exit !gitlink }'; then exit 44; fi`,
    "done",
    // Bundles contain LFS pointers, not their external payloads. Inspect every
    // new blob, including intermediate commits, without depending on git-lfs.
    `git rev-list --objects --no-object-names "$head" ${shellQuote(`^${input.baseSha}`)} | git cat-file --batch-check='%(objectname) %(objecttype)' | while read -r object type; do`,
    `  if [ "$type" = blob ] && git cat-file blob "$object" | awk 'NR == 1 && ($0 == "version https://git-lfs.github.com/spec/v1" || $0 == "version https://hawser.github.com/spec/v1") { pointer = 1 } END { exit !pointer }'; then exit 43; fi`,
    "done",
    `mkdir -m 700 ${shellQuote(directory)}`,
    `trap ${shellQuote(`rm -rf ${shellQuote(directory)}`)} EXIT`,
    `git update-ref ${shellQuote(SOURCE_CHECKPOINT_REF)} "$head"`,
    `git bundle create ${shellQuote(bundle)} ${shellQuote(SOURCE_CHECKPOINT_REF)} ${shellQuote(`^${input.baseSha}`)}`,
    `size=$(wc -c < ${shellQuote(bundle)})`,
    `if [ "$size" -gt ${MAX_SOURCE_CHECKPOINT_BYTES} ]; then echo 'Source checkpoint exceeds 4 MiB' >&2; exit 42; fi`,
    'printf \'BUNDLE\\n%s\\n%s\\n\' "$head" "$size"',
    `base64 < ${shellQuote(bundle)}`,
  ].join("\n");
  const proc = await input.sandbox.exec("bash", ["-lc", script], {
    cwd: input.sandbox.repoPath,
    env: WALLIE_GIT_IDENTITY_ENV,
    signal: input.signal,
  });
  const [output, code] = await Promise.all([proc.output(), proc.exitCode]);
  input.signal?.throwIfAborted();
  if (code !== 0) {
    if (code === 43) throw new UnsupportedLfsCheckpointError();
    if (code === 44) throw new UnsupportedSubmoduleCheckpointError();
    throw new Error(
      code === 42
        ? "Source checkpoint exceeds 4 MiB."
        : "Could not preserve the source checkpoint.",
    );
  }
  const [kind, headSha, size, ...encoded] = output.stdout.trim().split("\n");
  if (!COMMIT_SHA.test(headSha ?? ""))
    throw new Error("Source checkpoint returned an invalid commit.");
  if (kind === "UNCHANGED" && headSha === input.baseSha)
    return { kind: "unchanged", baseSha: input.baseSha, headSha };
  const byteLength = Number(size);
  if (
    kind !== "BUNDLE" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > MAX_SOURCE_CHECKPOINT_BYTES
  ) {
    throw new Error("Source checkpoint returned an invalid size.");
  }
  const bytes = Buffer.from(encoded.join(""), "base64");
  if (
    bytes.length !== byteLength ||
    !bytes.subarray(0, 32).toString("utf8").startsWith("# v2 git bundle\n")
  ) {
    throw new Error("Source checkpoint returned invalid bundle contents.");
  }
  return {
    kind: "bundle",
    baseSha: input.baseSha,
    headSha,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
