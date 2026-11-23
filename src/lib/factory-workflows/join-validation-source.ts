import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { SandboxHandle } from "@/lib/sandbox/types";

type Candidate = { commitSha: string; treeSha: string };
export type CredentialFreeSource = { bytes: Buffer; sha256: string };

const maxPackedBytes = 8 * 1024 * 1024;
const fullSha = /^[a-f0-9]{40}$/;
const emptyGitEnv = {
  BASH_ENV: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
};

const exportCandidateScript = [
  "set -euo pipefail",
  "trap 'rm -f -- \"$3\"' EXIT",
  'test "$(git rev-parse --verify "$1^{tree}")" = "$2"',
  '{ printf "%s\\n" "$1"; git rev-list --objects --no-object-names "$2"; } | git pack-objects --stdout > "$3"',
  'test "$(wc -c < "$3")" -le "$4"',
  'base64 < "$3"',
].join("\n");

const materializeCandidateScript = [
  "set -euo pipefail",
  "trap 'rm -f -- \"$3\"' EXIT",
  "test ! -e .git",
  "git init --template= --object-format=sha1 --quiet",
  'git index-pack --stdin < "$3" >/dev/null',
  'test "$(git rev-parse --verify "$1^{tree}")" = "$2"',
  // The one exact commit is the history boundary. Its whole tree was transferred.
  'printf "%s\\n" "$1" > .git/shallow',
  'git -c core.hooksPath=/dev/null -c core.autocrlf=false -c core.eol=lf checkout --detach --quiet "$1"',
  'git fsck --no-reflogs --connectivity-only "$1" >/dev/null',
].join("\n");

function assertCandidate(candidate: Candidate) {
  if (!fullSha.test(candidate.commitSha) || !fullSha.test(candidate.treeSha))
    throw new Error("The validation source requires exact Git object identities.");
}

function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function exportValidationSource(
  sandbox: SandboxHandle,
  candidate: Candidate,
  signal: AbortSignal,
): Promise<CredentialFreeSource> {
  assertCandidate(candidate);
  const path = `/tmp/wallie-join-tree-${randomUUID()}.pack`;
  const proc = await sandbox.exec(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      exportCandidateScript,
      "--",
      candidate.commitSha,
      candidate.treeSha,
      path,
      String(maxPackedBytes),
    ],
    { cwd: sandbox.repoPath, env: emptyGitEnv, signal },
  );
  const [output, code] = await Promise.all([proc.output(), proc.exitCode]);
  signal.throwIfAborted();
  if (code !== 0 || output.stdout.length > Math.ceil(maxPackedBytes * 1.4))
    throw new Error("The exact join tree could not be exported within its size bound.");
  const encoded = output.stdout.replaceAll(/\s/g, "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > maxPackedBytes || bytes.toString("base64") !== encoded)
    throw new Error("The exact join tree export returned invalid bytes.");
  return { bytes, sha256: digest(bytes) };
}

export async function materializeValidationSource(
  sandbox: SandboxHandle,
  candidate: Candidate,
  source: CredentialFreeSource,
  signal: AbortSignal,
) {
  assertCandidate(candidate);
  if (source.bytes.length > maxPackedBytes || digest(source.bytes) !== source.sha256)
    throw new Error("The joined source transfer failed integrity verification.");
  signal.throwIfAborted();
  const path = `/tmp/wallie-join-tree-${randomUUID()}.pack`;
  await sandbox.writeFile(path, source.bytes, { mode: 0o600 });
  const proc = await sandbox.exec(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      materializeCandidateScript,
      "--",
      candidate.commitSha,
      candidate.treeSha,
      path,
    ],
    { cwd: sandbox.repoPath, env: emptyGitEnv, signal },
  );
  const [output, code] = await Promise.all([proc.output(), proc.exitCode]);
  signal.throwIfAborted();
  if (code !== 0 || output.stdout.length !== 0 || output.stderr.length > 1024)
    throw new Error("The isolated workspace could not materialize the exact joined source.");
}
