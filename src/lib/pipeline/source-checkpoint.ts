import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { shellQuote } from "@/lib/sandbox/command";
import { WALLIE_GIT_IDENTITY_ENV } from "@/lib/sandbox/commit-author";
import type { SandboxHandle } from "@/lib/sandbox/types";

export const SOURCE_CHECKPOINT_BUCKET = "session-source-checkpoints";
export const MAX_SOURCE_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
export const SOURCE_CHECKPOINT_REF = "refs/heads/wallie-source-checkpoint";

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
    "if [ -n \"$(git status --porcelain --untracked-files=normal)\" ]; then echo 'Source checkout still contains uncommitted changes' >&2; exit 41; fi",
    "head=$(git rev-parse --verify 'HEAD^{commit}')",
    `if [ "$head" = ${shellQuote(input.baseSha)} ]; then printf 'UNCHANGED\\n%s\\n' "$head"; exit 0; fi`,
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
