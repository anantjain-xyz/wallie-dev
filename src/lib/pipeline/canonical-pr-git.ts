import "server-only";

import type { GitExecutor, SourceGitWorkspace } from "./source-delivery-git-core";

const SHA = /^[a-f0-9]{40}$/;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const UUID_PATTERN = new RegExp(`^${UUID}$`);
const CANONICAL_BRANCH = new RegExp(`^wallie/sessions/(${UUID})/(${UUID})$`);
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const PROMOTION_ERROR = "Could not promote the canonical session refs.";

export interface CanonicalPromotionInput {
  operationId: string;
  desiredSha: string;
  /** Exact remote ref supplying the pinned source commit. */
  sourceRef: string;
  branchName: string;
  fenceBranch: string;
  expectedHeadSha: string | null;
  expectedFenceSha: string | null;
  desiredFenceSha: string;
  remoteUrl: string;
  token: string;
  signal?: AbortSignal;
  beforePush?: () => Promise<void>;
}

export class CanonicalRefConflictError extends Error {
  constructor() {
    super("Canonical session refs no longer match the expected publication state.");
    this.name = "CanonicalRefConflictError";
  }
}

/** Promote source and its operation fence in one remote Git transaction. */
export async function promoteCanonicalRefsWithWorkspace(
  input: CanonicalPromotionInput,
  dependencies: { execGit: GitExecutor; createWorkspace: () => Promise<SourceGitWorkspace> },
): Promise<{ headSha: string; fenceSha: string }> {
  const branch = CANONICAL_BRANCH.exec(input.branchName);
  if (
    !UUID_PATTERN.test(input.operationId) ||
    !SHA.test(input.desiredSha) ||
    !SHA.test(input.desiredFenceSha) ||
    (input.expectedHeadSha !== null && !SHA.test(input.expectedHeadSha)) ||
    (input.expectedFenceSha !== null && !SHA.test(input.expectedFenceSha)) ||
    !branch ||
    input.fenceBranch !== `wallie/session-fences/${branch[2]}` ||
    !input.sourceRef.startsWith("refs/heads/")
  ) {
    throw new Error("Invalid canonical session publication inputs.");
  }
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(input.remoteUrl)) {
    throw new Error("Canonical publication requires a canonical GitHub repository URL.");
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(input.signal ? [input.signal] : []),
  ]);
  const headRef = `refs/heads/${input.branchName}`;
  const fenceRef = `refs/heads/${input.fenceBranch}`;
  const desired = { headSha: input.desiredSha, fenceSha: input.desiredFenceSha };
  const expected = { headSha: input.expectedHeadSha, fenceSha: input.expectedFenceSha };
  const samePair = (
    left: { headSha: string | null; fenceSha: string | null },
    right: { headSha: string | null; fenceSha: string | null },
  ) => left.headSha === right.headSha && left.fenceSha === right.fenceSha;
  let workspace: SourceGitWorkspace | undefined;
  try {
    signal.throwIfAborted();
    workspace = await dependencies.createWorkspace();
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}`,
      GIT_AUTHOR_NAME: "Wallie",
      GIT_AUTHOR_EMAIL: "noreply@wallie.dev",
      GIT_AUTHOR_DATE: "946684800 +0000",
      GIT_COMMITTER_NAME: "Wallie",
      GIT_COMMITTER_EMAIL: "noreply@wallie.dev",
      GIT_COMMITTER_DATE: "946684800 +0000",
    };
    const root = workspace.path;
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
    const remotePair = async () => {
      const { stdout } = await git(["ls-remote", "--heads", input.remoteUrl, headRef, fenceRef]);
      const refs = new Map<string, string>();
      for (const line of stdout.trim().split("\n")) {
        if (!line) continue;
        const [sha, ref, extra] = line.split(/\s+/);
        if (!SHA.test(sha) || (ref !== headRef && ref !== fenceRef) || extra || refs.has(ref))
          throw new Error(PROMOTION_ERROR);
        refs.set(ref, sha);
      }
      return { headSha: refs.get(headRef) ?? null, fenceSha: refs.get(fenceRef) ?? null };
    };
    await git(["check-ref-format", input.sourceRef]);
    await git(["check-ref-format", headRef]);
    await git(["check-ref-format", fenceRef]);
    await git(["init", "--bare", "--quiet"]);
    await git(["fetch", "--no-tags", "--depth=1", input.remoteUrl, input.sourceRef]);
    const fetched = await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
    if (fetched.stdout.trim() !== input.desiredSha) throw new Error(PROMOTION_ERROR);
    if (input.expectedFenceSha !== null) {
      await git(["fetch", "--no-tags", "--depth=1", input.remoteUrl, input.expectedFenceSha]);
    }
    const tree = await git(["hash-object", "-w", "-t", "tree", "--", "/dev/null"]);
    if (tree.stdout.trim() !== EMPTY_TREE_SHA) throw new Error(PROMOTION_ERROR);
    const fence = await git([
      "commit-tree",
      EMPTY_TREE_SHA,
      ...(input.expectedFenceSha === null ? [] : ["-p", input.expectedFenceSha]),
      "-m",
      `Wallie canonical publication ${input.operationId}\n`,
    ]);
    if (fence.stdout.trim() !== input.desiredFenceSha) throw new Error(PROMOTION_ERROR);
    const current = await remotePair();
    if (samePair(current, desired)) return desired;
    if (!samePair(current, expected)) throw new CanonicalRefConflictError();
    await input.beforePush?.();
    signal.throwIfAborted();
    try {
      await git([
        "push",
        "--atomic",
        `--force-with-lease=${headRef}:${input.expectedHeadSha ?? ""}`,
        `--force-with-lease=${fenceRef}:${input.expectedFenceSha ?? ""}`,
        input.remoteUrl,
        `${input.desiredSha}:${headRef}`,
        `${input.desiredFenceSha}:${fenceRef}`,
      ]);
    } catch {
      signal.throwIfAborted();
      // A lost response can follow a committed transaction. Read both refs
      // together before accepting either a successful or ambiguous push.
    }
    const published = await remotePair();
    if (samePair(published, desired)) return desired;
    if (!samePair(published, expected)) throw new CanonicalRefConflictError();
    throw new Error(PROMOTION_ERROR);
  } catch (error) {
    if (error instanceof CanonicalRefConflictError) throw error;
    // Git and ownership errors can include authorization headers or tokens.
    throw new Error(PROMOTION_ERROR);
  } finally {
    if (workspace) {
      try {
        await workspace.close();
      } catch {
        throw new Error(PROMOTION_ERROR);
      }
    }
  }
}
