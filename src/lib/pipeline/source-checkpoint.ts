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

export class UnsafeRuntimeCheckpointError extends Error {
  constructor() {
    // Neither paths nor matched values are safe to include in this error.
    super("Source checkpoint contains reserved runtime files or known sensitive material.");
    this.name = "UnsafeRuntimeCheckpointError";
  }
}

/**
 * Read exact Git objects, including symlink targets, rather than following paths
 * in the working tree. Match only caller-supplied runtime material; this is not
 * a general secret detector. Streaming retains enough overlap for split values
 * without buffering arbitrarily large source files.
 */
const CHECK_SENSITIVE_OBJECTS = String.raw`
const { readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const values = JSON.parse(readFileSync(process.argv[1], "utf8"));
const variants = values.flatMap((value) => {
  const result = [value, JSON.stringify(value).slice(1, -1)];
  try { result.push(encodeURIComponent(value)); } catch { /* Invalid Unicode still has its raw variant. */ }
  return result;
});
const patterns = [...new Set(variants)].map((value) => Buffer.from(value));
const overlap = Math.max(0, ...patterns.map((pattern) => pattern.length - 1));
const records = readFileSync(0, "utf8").split(process.argv[2] === "index" ? "\0" : "\n");
const objects = new Map();
let unsafePath = false;
if (process.argv[2] === "index") {
  for (let index = 0; index + 1 < records.length; index += 2) {
    const fields = records[index].split(" ");
    if (fields[1] !== "160000" && fields[1] !== "000000") {
      objects.set(fields[3], "blob");
      if (patterns.some((pattern) => Buffer.from(records[index + 1]).includes(pattern))) unsafePath = true;
    }
  }
} else {
  for (const record of records) {
    const [object, type] = record.split(" ");
    if (["blob", "tree", "commit"].includes(type)) objects.set(object, type);
  }
}
async function check(object, type) {
  if (!/^[a-f0-9]{40}$/.test(object)) throw new Error("Invalid object");
  const process = spawn("git", ["cat-file", type, object], { stdio: ["ignore", "pipe", "ignore"] });
  const completion = new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("close", (code) => code === 0 ? resolve() : reject(new Error("Unreadable object")));
  });
  let tail = Buffer.alloc(0);
  let unsafe = false;
  for await (const chunk of process.stdout) {
    const data = Buffer.concat([tail, chunk]);
    if (patterns.some((pattern) => data.includes(pattern))) unsafe = true;
    tail = overlap ? data.subarray(Math.max(0, data.length - overlap)) : Buffer.alloc(0);
  }
  await completion;
  return unsafe;
}
(async () => {
  if (unsafePath) { process.exitCode = 45; return; }
  if (!patterns.length) return;
  for (const [object, type] of objects) if (await check(object, type)) { process.exitCode = 45; return; }
})().catch(() => { process.exitCode = 46; });
`;

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
 * bundle. CLI homes and copied Wallie runner directories are reserved at any
 * depth, as are local environment/credential files. Root prompt.txt/auth.json
 * and the runner's codex/auth.json/data/opencode/auth.json are also reserved;
 * ordinary nested product files with those basenames remain valid source.
 * Existing reserved files in the base may remain unchanged or be deleted.
 * Reject additions/edits, including reverted intermediate commits, rather than
 * silently omitting work. Harness files themselves live outside this checkout.
 * Disabling hooks keeps capture from invoking repository-controlled scripts.
 */
export async function captureSourceCheckpoint(input: {
  sandbox: SandboxHandle;
  baseSha: string;
  signal?: AbortSignal;
  /** Exact current prompts/credentials to reject, including encoded variants. Values shorter than 8 characters are ignored. */
  sensitiveValues?: readonly string[];
}): Promise<SourceCheckpoint> {
  if (!COMMIT_SHA.test(input.baseSha)) throw new Error("Invalid source base commit.");
  input.signal?.throwIfAborted();
  const directory = `/tmp/wallie-source-${randomUUID()}`;
  const bundle = `${directory}/source.bundle`;
  const candidates = `${directory}/paths`;
  const sensitiveFile = `${directory}/sensitive.json`;
  const sensitiveValues = input.sensitiveValues?.filter((value) => value.length >= 8) ?? [];
  const checkSensitive = (mode: "index" | "history") =>
    `node -e ${shellQuote(CHECK_SENSITIVE_OBJECTS)} ${shellQuote(sensitiveFile)} ${mode} 2>/dev/null`;
  const script = [
    "set -euo pipefail",
    `trap ${shellQuote(`rm -rf ${shellQuote(directory)}`)} EXIT`,
    // Slash-delimited matching reserves a whole runtime directory, even when
    // copied below a source directory. No path is printed on rejection.
    "reserved_runtime_path() {",
    '  case "/$1/" in',
    "    */.wallie-runner*/*|*/wallie-codex-*/*|*/wallie-claude-code-*/*|*/wallie-cursor-*/*|*/wallie-opencode-*/*|*/.codex/*|*/.claude/*|*/.cursor/*|*/.config/opencode/*|*/.local/share/opencode/*|*/.git-credentials/*|*/.env/*|*/.env.local/*|*/.env.*.local/*) return 0 ;;",
    "  esac",
    '  case "$1" in prompt.txt|auth.json|codex/auth.json|data/opencode/auth.json) return 0 ;; esac',
    "  return 1",
    "}",
    // Inspect before staging, so a rejected reserved file does not modify the
    // index. Include both index and worktree changes, plus nonignored source.
    `git diff --name-only --no-renames -z > ${shellQuote(candidates)}`,
    `git ls-files --others --exclude-standard -z >> ${shellQuote(candidates)}`,
    "reject_runtime_paths() {",
    `  while IFS= read -r -d '' path; do`,
    '    if { [ -e "$path" ] || [ -L "$path" ]; } && reserved_runtime_path "$path"; then exit 45; fi',
    "  done",
    "}",
    `reject_runtime_paths < ${shellQuote(candidates)}`,
    "git diff --cached --name-only --no-renames -z | reject_runtime_paths",
    // No shell expansion, pathspec magic or newline splitting may expand this
    // explicit list into unrelated files. Deleted tracked paths are included.
    `if [ -s ${shellQuote(candidates)} ]; then git --literal-pathspecs add --pathspec-from-file=${shellQuote(candidates)} --pathspec-file-nul 2>/dev/null; fi`,
    ...(sensitiveValues.length
      ? [`git diff --cached --raw --no-abbrev --no-renames -z | ${checkSensitive("index")}`]
      : []),
    "if ! git diff --cached --quiet; then git -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -qm 'Preserve Wallie stage source'; fi",
    // A superproject bundle cannot preserve dirty submodule worktrees.
    "if [ -n \"$(git status --porcelain --untracked-files=normal --ignore-submodules=none)\" ]; then echo 'Source checkout still contains uncommitted changes' >&2; exit 41; fi",
    "head=$(git rev-parse --verify 'HEAD^{commit}')",
    `if [ "$head" = ${shellQuote(input.baseSha)} ]; then printf 'UNCHANGED\\n%s\\n' "$head"; exit 0; fi`,
    // A clean gitlink can still point to a commit available only in a local
    // submodule. Check each new commit, including reverted intermediate edits.
    `git rev-list "$head" ${shellQuote(`^${input.baseSha}`)} | while read -r commit; do`,
    `  git diff-tree --root --name-only --no-commit-id --no-renames --diff-filter=ACMRT -z -r -m "$commit" | while IFS= read -r -d '' path; do`,
    '    if reserved_runtime_path "$path"; then exit 45; fi',
    "  done",
    `  if git diff-tree --root --raw --no-commit-id --no-renames -r -m "$commit" | awk '$1 == ":160000" || $2 == "160000" { gitlink = 1 } END { exit !gitlink }'; then exit 44; fi`,
    "done",
    // Bundles contain LFS pointers, not their external payloads. Inspect every
    // new blob, including intermediate commits, without depending on git-lfs.
    `git rev-list --objects --no-object-names "$head" ${shellQuote(`^${input.baseSha}`)} | git cat-file --batch-check='%(objectname) %(objecttype)' | while read -r object type; do`,
    `  if [ "$type" = blob ] && git cat-file blob "$object" | awk 'NR == 1 && ($0 == "version https://git-lfs.github.com/spec/v1" || $0 == "version https://hawser.github.com/spec/v1") { pointer = 1 } END { exit !pointer }'; then exit 43; fi`,
    "done",
    ...(sensitiveValues.length
      ? [
          `git rev-list --objects --no-object-names "$head" ${shellQuote(`^${input.baseSha}`)} | git cat-file --batch-check='%(objectname) %(objecttype)' | ${checkSensitive("history")}`,
        ]
      : []),
    `git update-ref ${shellQuote(SOURCE_CHECKPOINT_REF)} "$head"`,
    `git bundle create ${shellQuote(bundle)} ${shellQuote(SOURCE_CHECKPOINT_REF)} ${shellQuote(`^${input.baseSha}`)}`,
    `size=$(wc -c < ${shellQuote(bundle)})`,
    `if [ "$size" -gt ${MAX_SOURCE_CHECKPOINT_BYTES} ]; then echo 'Source checkpoint exceeds 4 MiB' >&2; exit 42; fi`,
    `if [ "$(git rev-parse --verify 'HEAD^{commit}')" != "$head" ]; then exit 41; fi`,
    'if [ -n "$(git status --porcelain --untracked-files=normal --ignore-submodules=none)" ]; then exit 41; fi',
    'printf \'BUNDLE\\n%s\\n%s\\n\' "$head" "$size"',
    `base64 < ${shellQuote(bundle)}`,
  ].join("\n");
  let output: { stdout: string; stderr: string };
  let code: number;
  try {
    const mkdir = await input.sandbox.exec("mkdir", ["-m", "700", directory], {
      cwd: "/tmp",
      signal: input.signal,
    });
    if ((await mkdir.exitCode) !== 0)
      throw new Error("Could not create a private checkpoint directory.");
    if (sensitiveValues.length)
      await input.sandbox.writeFile(sensitiveFile, JSON.stringify(sensitiveValues), {
        mode: 0o600,
      });
    const proc = await input.sandbox.exec("bash", ["-lc", script], {
      cwd: input.sandbox.repoPath,
      env: WALLIE_GIT_IDENTITY_ENV,
      signal: input.signal,
    });
    [output, code] = await Promise.all([proc.output(), proc.exitCode]);
  } catch {
    input.signal?.throwIfAborted();
    // Provider write/transport errors may echo a payload. Do not retain them
    // as a cause or stack when handling the private runtime-material file.
    throw new Error("Could not preserve the source checkpoint.");
  } finally {
    // Also covers write/transport failures before the shell installs its trap.
    // Cleanup must still run if the execution signal has been aborted.
    await input.sandbox
      .exec("rm", ["-rf", directory], { cwd: "/tmp" })
      .then((proc) => proc.exitCode)
      .catch(() => undefined);
  }
  input.signal?.throwIfAborted();
  if (code !== 0) {
    if (code === 43) throw new UnsupportedLfsCheckpointError();
    if (code === 44) throw new UnsupportedSubmoduleCheckpointError();
    if (code === 45) throw new UnsafeRuntimeCheckpointError();
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
