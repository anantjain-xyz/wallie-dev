import "server-only";

import { isWallieCheckpointRef } from "@/lib/checkpoint-ref";
import type { GitExecutor, SourceGitWorkspace } from "./source-delivery-git-core";

const SHA = /^[a-f0-9]{40}$/;
const FAILURE = "Could not verify retained checkpoint removal.";

export class RetainedCheckpointRefConflictError extends Error {
  constructor() {
    super("The retained checkpoint ref has a different source commit.");
    this.name = "RetainedCheckpointRefConflictError";
  }
}

/** The caller must fence adoption and all new references before claiming cleanup. */
export async function deleteRetainedCheckpointRefWithWorkspace(
  input: {
    runId: string;
    headSha: string;
    retainedRef: string;
    remoteUrl: string;
    token: string;
    signal?: AbortSignal;
    beforeDelete?: () => Promise<void>;
  },
  dependencies: { execGit: GitExecutor; createWorkspace: () => Promise<SourceGitWorkspace> },
): Promise<{ ref: string; absent: true }> {
  const ref = input.retainedRef;
  if (!isWallieCheckpointRef(ref, input.headSha, input.runId))
    throw new Error("Invalid retained checkpoint cleanup identity.");
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(input.remoteUrl))
    throw new Error("Checkpoint cleanup requires a canonical GitHub repository URL.");
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(input.signal ? [input.signal] : []),
  ]);
  let workspace: SourceGitWorkspace | undefined;
  try {
    signal.throwIfAborted();
    workspace = await dependencies.createWorkspace();
    const root = workspace.path;
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}`,
    };
    const git = async (args: string[]) => {
      signal.throwIfAborted();
      const result = await dependencies.execGit(args, {
        cwd: root,
        env,
        signal,
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      });
      signal.throwIfAborted();
      return result;
    };
    const remoteHead = async () => {
      const { stdout } = await git(["ls-remote", "--refs", input.remoteUrl, ref]);
      const lines = stdout.trim().split("\n").filter(Boolean);
      if (!lines.length) return null;
      if (lines.length !== 1) throw new Error(FAILURE);
      const [sha, name, extra] = lines[0].split(/\s+/);
      if (!SHA.test(sha) || name !== ref || extra) throw new Error(FAILURE);
      return sha;
    };
    await git(["check-ref-format", ref]);
    await git(["init", "--bare", "--quiet"]);
    const existing = await remoteHead();
    if (existing === null) return { ref, absent: true };
    if (existing !== input.headSha) throw new RetainedCheckpointRefConflictError();
    await input.beforeDelete?.();
    signal.throwIfAborted();
    try {
      await git(["push", `--force-with-lease=${ref}:${input.headSha}`, input.remoteUrl, `:${ref}`]);
    } catch {
      signal.throwIfAborted();
      // A missing response can follow a committed deletion. Only absence is proof.
    }
    const current = await remoteHead();
    if (current === null) return { ref, absent: true };
    if (current !== input.headSha) throw new RetainedCheckpointRefConflictError();
    throw new Error(FAILURE);
  } catch (error) {
    if (error instanceof RetainedCheckpointRefConflictError) throw error;
    throw new Error(FAILURE);
  } finally {
    if (workspace) {
      try {
        await workspace.close();
      } catch {
        throw new Error(FAILURE);
      }
    }
  }
}
