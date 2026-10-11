import "server-only";

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { MAX_SOURCE_CHECKPOINT_BYTES, SOURCE_CHECKPOINT_REF } from "./source-checkpoint";

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
type GitExecutor = (
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    maxBuffer: number;
    timeout: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

/** Restore objects into a bare repository. Recovery never executes source code. */
export async function restoreAndPushSource(
  input: {
    baseSha: string;
    headSha: string;
    branch: string;
    bytes: Buffer;
    sha256: string;
    /** Constructed by the caller from the validated GitHub repository identity. */
    remoteUrl: string;
    token: string;
    signal?: AbortSignal;
    beforePush?: () => Promise<void>;
  },
  dependencies: { execGit?: GitExecutor } = {},
): Promise<void> {
  if (
    !SHA.test(input.baseSha) ||
    !SHA.test(input.headSha) ||
    input.bytes.length > MAX_SOURCE_CHECKPOINT_BYTES ||
    createHash("sha256").update(input.bytes).digest("hex") !== input.sha256
  ) {
    throw new Error("Source checkpoint integrity verification failed.");
  }
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(input.remoteUrl)) {
    throw new Error("Source delivery requires a canonical GitHub repository URL.");
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(input.signal ? [input.signal] : []),
  ]);
  signal.throwIfAborted();
  const headerEnd = input.bytes.indexOf("\n\n");
  if (headerEnd < 0 || headerEnd > 65536) throw new Error("Invalid source bundle header.");
  const prerequisites = [
    ...new Set(
      input.bytes
        .subarray(0, headerEnd)
        .toString("utf8")
        .split("\n")
        .map((line) => /^-([a-f0-9]{40}) /.exec(line)?.[1])
        .filter((sha): sha is string => !!sha),
    ),
  ];
  const root = await mkdtemp(join(tmpdir(), "wallie-source-delivery-"));
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    PATH: process.env.PATH,
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}`,
  };
  const execGit =
    dependencies.execGit ??
    (async (args, options) => exec("git", args, { ...options, encoding: "utf8" }));
  const git = (args: string[]) =>
    execGit(args, { cwd: root, env, signal, maxBuffer: 1024 * 1024, timeout: 30_000 });
  try {
    await git(["check-ref-format", `refs/heads/${input.branch}`]);
    await git(["init", "--bare", "--quiet"]);
    await writeFile(join(root, "source.bundle"), input.bytes, { mode: 0o600 });
    // Merge history can exclude multiple ancestors. Fetch every declared
    // prerequisite rather than assuming a depth-one base provides them all.
    if (prerequisites.length)
      await git(["fetch", "--no-tags", "--depth=1", input.remoteUrl, ...prerequisites]);
    await git(["bundle", "verify", "source.bundle"]);
    const unbundled = await git(["bundle", "unbundle", "source.bundle"]);
    const refs = unbundled.stdout.trim().split("\n");
    if (!refs.includes(`${input.headSha} ${SOURCE_CHECKPOINT_REF}`)) {
      throw new Error("Checkpoint does not contain its recorded source commit.");
    }
    // Attempts have distinct branch names. A retry can fast-forward or observe
    // the same SHA, but cannot overwrite unrelated remote work with --force.
    await input.beforePush?.();
    signal.throwIfAborted();
    await git(["push", input.remoteUrl, `${input.headSha}:refs/heads/${input.branch}`]);
  } catch {
    // Git transport errors can repeat authorization headers or credential URLs.
    // Keep both raw tokens and base64 basic-auth values out of durable errors.
    throw new Error("Could not restore and push the source checkpoint.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
