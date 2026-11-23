import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { observeUntilAbort } from "@/lib/sandbox/lifecycle";
import type { SandboxHandle } from "@/lib/sandbox/types";

type Candidate = { commitSha: string; treeSha: string };
export type CredentialFreeSource = Candidate & {
  byteLength: number;
  sha256: string;
  chunks: readonly Buffer[];
};

// The validation snapshot contains the full tree, including unchanged base
// files. Keep each provider message small and cap the total held by this attempt.
export const maxJoinValidationSourceBytes = 48 * 1024 * 1024;
const chunkBytes = 256 * 1024;
const fullSha = /^[a-f0-9]{40}$/;
const packMetadata = z.strictObject({
  byteLength: z.number().int().positive().max(maxJoinValidationSourceBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const emptyGitEnv = {
  BASH_ENV: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  LC_ALL: "C",
};

const writeBoundedPack = String.raw`
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { pipeline, Transform } = require("node:stream");
const [path, limit] = process.argv.slice(1);
const hash = createHash("sha256");
let byteLength = 0;
const bounded = new Transform({
  transform(bytes, _encoding, next) {
    byteLength += bytes.length;
    if (byteLength > Number(limit)) return next(new Error("Size bound exceeded"));
    hash.update(bytes);
    next(null, bytes);
  }
});
pipeline(process.stdin, bounded, fs.createWriteStream(path, { flags: "wx", mode: 0o600 }), (error) => {
  if (error) process.exitCode = 1;
  else process.stdout.write(JSON.stringify({ byteLength, sha256: hash.digest("hex") }));
});
`;

const readPackChunk = String.raw`
const fs = require("node:fs");
const [path, offset, length] = process.argv.slice(1);
const descriptor = fs.openSync(path, "r");
try {
  const bytes = Buffer.alloc(Number(length));
  if (fs.readSync(descriptor, bytes, 0, bytes.length, Number(offset)) !== bytes.length)
    process.exitCode = 1;
  else process.stdout.write(bytes.toString("base64"));
} finally {
  fs.closeSync(descriptor);
}
`;

const verifyPack = String.raw`
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const [path, expected] = process.argv.slice(1);
const hash = createHash("sha256");
const source = fs.createReadStream(path);
source.on("data", (bytes) => hash.update(bytes));
source.on("end", () => {
  if (hash.digest("hex") !== expected) process.exitCode = 1;
});
source.on("error", () => { process.exitCode = 1; });
`;

const exportCandidateScript = [
  "set -euo pipefail",
  'test "$(git rev-parse --verify "$1^{tree}")" = "$2"',
  '{ printf "%s\\n" "$1"; git rev-list --objects --no-object-names "$2"; } | git pack-objects --stdout | node -e "$5" "$3/source.pack" "$4"',
].join("\n");

const materializeCandidateScript = [
  "set -euo pipefail",
  "umask 077",
  'cat -- "$3"/*.part > "$3/source.pack"',
  'test "$(wc -c < "$3/source.pack")" -eq "$4"',
  'node -e "$6" "$3/source.pack" "$5"',
  "test ! -e .git",
  "git init --template= --object-format=sha1 --quiet",
  'git index-pack --stdin < "$3/source.pack" >/dev/null',
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

async function runTransferCommand(
  sandbox: SandboxHandle,
  command: string,
  args: string[],
  signal: AbortSignal,
  message: string,
) {
  return observeUntilAbort(signal, async () => {
    const process = await sandbox.exec(command, args, {
      cwd: sandbox.repoPath,
      env: emptyGitEnv,
      signal,
    });
    const [output, code] = await Promise.all([process.output(), process.exitCode]);
    if (code !== 0) throw new Error(message);
    return output;
  });
}

async function withPrivateTransferDirectory<T>(
  sandbox: SandboxHandle,
  signal: AbortSignal,
  transfer: (directory: string) => Promise<T>,
) {
  const directory = `/tmp/wallie-join-tree-${randomUUID()}`;
  try {
    await runTransferCommand(
      sandbox,
      "mkdir",
      ["-m", "700", "--", directory],
      signal,
      "The joined source transfer could not be prepared.",
    );
    return await transfer(directory);
  } finally {
    // After cancellation the managed sandbox owns cleanup. Preserve the exact
    // deadline even if the provider never answers a pending file operation.
    const cleanupSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    await observeUntilAbort(cleanupSignal, async () => {
      const process = await sandbox.exec("rm", ["-rf", "--", directory], {
        cwd: "/tmp",
        signal: cleanupSignal,
      });
      await process.exitCode;
    }).catch(() => undefined);
  }
}

async function retryChunk<T>(transfer: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await transfer();
  } catch {
    signal.throwIfAborted();
    return transfer();
  }
}

export async function exportValidationSource(
  sandbox: SandboxHandle,
  candidate: Candidate,
  signal: AbortSignal,
): Promise<CredentialFreeSource> {
  assertCandidate(candidate);
  return withPrivateTransferDirectory(sandbox, signal, async (directory) => {
    const failure = "The exact join tree could not be exported within its size bound.";
    const { stdout } = await runTransferCommand(
      sandbox,
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        exportCandidateScript,
        "--",
        candidate.commitSha,
        candidate.treeSha,
        directory,
        String(maxJoinValidationSourceBytes),
        writeBoundedPack,
      ],
      signal,
      failure,
    );
    if (stdout.length > 128) throw new Error(failure);
    const { byteLength, sha256 } = packMetadata.parse(JSON.parse(stdout));

    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    for (let offset = 0; offset < byteLength; offset += chunkBytes) {
      const size = Math.min(chunkBytes, byteLength - offset);
      const bytes = await retryChunk(async () => {
        const { stdout: encoded } = await runTransferCommand(
          sandbox,
          "node",
          ["-e", readPackChunk, directory + "/source.pack", String(offset), String(size)],
          signal,
          failure,
        );
        if (encoded.length !== Math.ceil(size / 3) * 4) throw new Error(failure);
        const chunk = Buffer.from(encoded, "base64");
        if (chunk.length !== size || chunk.toString("base64") !== encoded) throw new Error(failure);
        return chunk;
      }, signal);
      chunks.push(bytes);
      hash.update(bytes);
    }
    if (hash.digest("hex") !== sha256)
      throw new Error("The exported join tree failed integrity verification.");
    return {
      commitSha: candidate.commitSha,
      treeSha: candidate.treeSha,
      chunks,
      byteLength,
      sha256,
    };
  });
}

export async function materializeValidationSource(
  sandbox: SandboxHandle,
  candidate: Candidate,
  source: CredentialFreeSource,
  signal: AbortSignal,
) {
  assertCandidate(candidate);
  const metadata = packMetadata.safeParse({ byteLength: source.byteLength, sha256: source.sha256 });
  const failure = "The joined source transfer failed integrity verification.";
  if (
    !metadata.success ||
    source.commitSha !== candidate.commitSha ||
    source.treeSha !== candidate.treeSha ||
    source.chunks.length !== Math.ceil(source.byteLength / chunkBytes)
  )
    throw new Error(failure);
  const hash = createHash("sha256");
  for (const [index, chunk] of source.chunks.entries()) {
    if (chunk.length !== Math.min(chunkBytes, source.byteLength - index * chunkBytes))
      throw new Error(failure);
    hash.update(chunk);
  }
  if (hash.digest("hex") !== source.sha256) throw new Error(failure);

  await withPrivateTransferDirectory(sandbox, signal, async (directory) => {
    for (const [index, chunk] of source.chunks.entries()) {
      signal.throwIfAborted();
      const path = `${directory}/${index.toString().padStart(4, "0")}.part`;
      await retryChunk(
        () => observeUntilAbort(signal, () => sandbox.writeFile(path, chunk, { mode: 0o600 })),
        signal,
      );
    }
    const output = await runTransferCommand(
      sandbox,
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        materializeCandidateScript,
        "--",
        candidate.commitSha,
        candidate.treeSha,
        directory,
        String(source.byteLength),
        source.sha256,
        verifyPack,
      ],
      signal,
      "The isolated workspace could not materialize the exact joined source.",
    );
    if (output.stdout.length !== 0 || output.stderr.length > 1024)
      throw new Error("The isolated workspace could not materialize the exact joined source.");
  });
}
