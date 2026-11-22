import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import {
  readCanonicalGitHubJson,
  readCanonicalGitHubMerge,
  type CanonicalPullRequest,
} from "@/lib/pipeline/canonical-pr-api";
import { WALLIE_GITHUB_BOT_COMMIT_AUTHOR } from "@/lib/sandbox/commit-author";

type GitHubErrorCode =
  | "invalid_input"
  | "invalid_response"
  | "repository_mismatch"
  | "base_mismatch"
  | "head_conflict"
  | "pull_request_conflict"
  | "ref_creation_uncertain"
  | "remote_unavailable";

/** Carries no GitHub response text or credentials. */
export class ImprovementPublicationGitHubError extends Error {
  constructor(
    readonly code: GitHubErrorCode,
    readonly status?: number,
  ) {
    super("The improvement publication GitHub identity could not be confirmed.");
    this.name = "ImprovementPublicationGitHubError";
  }
}

const maxDefinitionBytes = 2 * 1024 * 1024;
const operationTimeoutMs = 45_000;
const requestTimeoutMs = 10_000;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positiveId = z.number().int().positive().safe();
const timestamp = z.string().datetime({ offset: true });
const repositoryName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .max(255);
const repositoryIdentity = z.object({ id: positiveId, full_name: repositoryName });
const repository = repositoryIdentity.extend({
  default_branch: z.string(),
  archived: z.boolean().optional(),
  disabled: z.boolean().optional(),
});

function isBranchName(value: string) {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== "@" &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith(".") &&
    value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

const branch = z.string().refine(isBranchName);
const uuid = z.string().uuid();
const configPath = z.string().refine((value) => {
  const match = /^\.wallie\/factory-definitions\/([^/]+)\.json$/.exec(value);
  return match !== null && uuid.safeParse(match[1]).success;
});
const targetSchema = z
  .object({
    repositoryFullName: repositoryName.refine((value) =>
      value.split("/").every((part) => part !== "." && part !== ".."),
    ),
    repositoryNumericId: positiveId,
    baseBranch: branch.refine(
      (value) => !value.startsWith("wallie/improvements/") && !value.startsWith("wallie/sessions/"),
    ),
    headBranch: branch,
    configPath,
  })
  .refine((value) => {
    const [owner, family, factoryId, revisionId, ...rest] = value.headBranch.split("/");
    return (
      owner === "wallie" &&
      family === "improvements" &&
      rest.length === 0 &&
      uuid.safeParse(factoryId).success &&
      uuid.safeParse(revisionId).success &&
      value.configPath === `.wallie/factory-definitions/${factoryId}.json`
    );
  });

export type ImprovementPublicationGitHubTarget = z.infer<typeof targetSchema>;

const tokenSchema = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[\x21-\x7e]+$/);
const commitIdentity = z.object({ commitSha: sha, treeSha: sha });
const baseIdentity = commitIdentity.extend({ fileSha256: digest });
const commit = z.object({
  sha,
  tree: z.object({ sha }),
  parents: z.array(z.object({ sha })),
});
const ref = z.object({
  ref: z.string(),
  object: z.object({ sha, type: z.literal("commit") }),
});
const treeEntry = z.object({
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((path) => path !== "." && path !== ".." && !/[\/\0]/.test(path)),
  mode: z.string().regex(/^[0-7]{6}$/),
  type: z.enum(["blob", "tree", "commit"]),
  sha,
  size: z.number().int().nonnegative().safe().optional(),
});
const tree = z.object({
  sha,
  truncated: z.literal(false),
  tree: z.array(treeEntry).max(100_000),
});
const createdObject = z.object({ sha });
const blob = createdObject.extend({
  size: z.number().int().nonnegative().max(maxDefinitionBytes),
  encoding: z.literal("base64"),
  content: z.string().max(3 * 1024 * 1024),
});
const pr = z.object({
  number: positiveId,
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  updated_at: timestamp,
  merged_at: timestamp.nullable(),
  merged: z.boolean().optional(),
  merge_commit_sha: sha.nullable().optional(),
  base: z.object({ ref: branch, sha, repo: repositoryIdentity }),
  head: z.object({ ref: branch, sha, repo: repositoryIdentity }),
});
const mergedPullIdentity = z.object({
  created_at: timestamp,
  user: z.object({ id: positiveId }),
  merged: z.literal(true),
});
const comparison = z.object({
  status: z.literal("ahead"),
  base_commit: z.object({ sha }),
  merge_base_commit: z.object({ sha }),
  ahead_by: positiveId,
  behind_by: z.literal(0),
});

export type ImprovementPublicationBase = z.infer<typeof baseIdentity>;
export type ImprovementPublicationHead = z.infer<typeof commitIdentity>;

type TreeEntry = z.infer<typeof treeEntry>;
type TreeLevel = { target: TreeEntry; siblings: Map<string, TreeEntry> };
type VerifyHead = {
  base: ImprovementPublicationBase;
  head: ImprovementPublicationHead;
  candidateDigest: string;
  requireRef?: boolean;
  signal?: AbortSignal;
};
type VerifyPullRequest = {
  pullNumber: number;
  baseCommitSha: string;
  headCommitSha: string;
  signal?: AbortSignal;
};
type GitHubTransportOptions = {
  target: ImprovementPublicationGitHubTarget;
  token: string;
  fetcher?: typeof fetch;
};

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: GitHubErrorCode = "invalid_response",
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ImprovementPublicationGitHubError(code);
  return result.data;
}

function gitBlobId(bytes: Uint8Array) {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkCommitParent(
  gitCommit: z.infer<typeof commit>,
  base: ImprovementPublicationBase,
  treeSha: string,
) {
  if (
    gitCommit.sha === base.commitSha ||
    gitCommit.tree.sha !== treeSha ||
    gitCommit.parents.length !== 1 ||
    gitCommit.parents[0]?.sha !== base.commitSha
  ) {
    throw new ImprovementPublicationGitHubError("head_conflict");
  }
}

function createImprovementGitHub(input: GitHubTransportOptions) {
  const target = parse(targetSchema, input.target, "invalid_input");
  const token = parse(tokenSchema, input.token, "invalid_input");
  const fetcher = input.fetcher ?? fetch;
  // Numeric routes keep Git writes scoped even if an owner/name is reassigned.
  const origin = `https://api.github.com/repositories/${target.repositoryNumericId}`;
  const path = target.configPath.split("/");
  const sameRepository = (value: z.infer<typeof repositoryIdentity>) =>
    value.id === target.repositoryNumericId &&
    value.full_name.toLowerCase() === target.repositoryFullName.toLowerCase();

  async function withDeadline<T>(
    caller: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    const deadline = AbortSignal.timeout(operationTimeoutMs);
    const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
    try {
      signal.throwIfAborted();
      const result = await work(signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      caller?.throwIfAborted();
      if (deadline.aborted) throw new ImprovementPublicationGitHubError("remote_unavailable");
      throw error;
    }
  }

  async function request(
    suffix: string,
    signal: AbortSignal,
    body?: Record<string, unknown>,
    observeHeaders?: (headers: Headers) => void,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]);
    const unavailable = new ImprovementPublicationGitHubError("remote_unavailable");
    const { promise, reject } = Promise.withResolvers<never>();
    const onAbort = () => reject(unavailable);
    requestSignal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([
        promise,
        (async () => {
          requestSignal.throwIfAborted();
          const response = await fetcher(origin + suffix, {
            method: body ? "POST" : "GET",
            signal: requestSignal,
            cache: "no-store",
            redirect: "manual",
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${token}`,
              "User-Agent": "Wallie",
              "X-GitHub-Api-Version": "2022-11-28",
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          if (response.status !== (body ? 201 : 200) || requestSignal.aborted) {
            void response.body?.cancel().catch(() => undefined);
            requestSignal.throwIfAborted();
            throw new ImprovementPublicationGitHubError("remote_unavailable", response.status);
          }
          observeHeaders?.(response.headers);
          try {
            return await readCanonicalGitHubJson(response, requestSignal);
          } catch {
            requestSignal.throwIfAborted();
            throw new ImprovementPublicationGitHubError("invalid_response", response.status);
          }
        })(),
      ]);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ImprovementPublicationGitHubError) throw error;
      throw unavailable;
    } finally {
      requestSignal.removeEventListener("abort", onAbort);
    }
  }

  async function readRepository(signal: AbortSignal) {
    const identity = parse(repository, await request("", signal));
    if (
      !sameRepository(identity) ||
      identity.archived ||
      identity.disabled ||
      !isBranchName(identity.default_branch) ||
      identity.default_branch === target.baseBranch ||
      identity.default_branch === target.headBranch
    ) {
      throw new ImprovementPublicationGitHubError("repository_mismatch");
    }
    return identity.default_branch;
  }

  async function readRef(branchName: string, signal: AbortSignal) {
    const encodedBranch = branchName.split("/").map(encodeURIComponent).join("/");
    let data: unknown;
    try {
      data = await request(`/git/ref/heads/${encodedBranch}`, signal);
    } catch (error) {
      if (error instanceof ImprovementPublicationGitHubError && error.status === 404) return null;
      throw error;
    }
    const value = parse(ref, data);
    if (value.ref !== `refs/heads/${branchName}`) {
      throw new ImprovementPublicationGitHubError("invalid_response");
    }
    return value.object.sha;
  }

  async function readCommit(commitSha: string, signal: AbortSignal) {
    const value = parse(commit, await request(`/git/commits/${commitSha}`, signal));
    if (value.sha !== commitSha) throw new ImprovementPublicationGitHubError("invalid_response");
    return value;
  }

  async function checkHeadRef(
    head: ImprovementPublicationHead,
    required: boolean,
    signal: AbortSignal,
  ) {
    const observed = await readRef(target.headBranch, signal);
    if (observed !== head.commitSha && (required || observed !== null)) {
      throw new ImprovementPublicationGitHubError("head_conflict");
    }
  }

  async function readPath(
    rootSha: string,
    signal: AbortSignal,
    code: "base_mismatch" | "head_conflict",
  ) {
    let current = rootSha;
    const levels: TreeLevel[] = [];
    for (const [index, segment] of path.entries()) {
      const value = parse(tree, await request(`/git/trees/${current}`, signal));
      const entries = new Map(value.tree.map((entry) => [entry.path, entry]));
      if (value.sha !== current || entries.size !== value.tree.length) {
        throw new ImprovementPublicationGitHubError("invalid_response");
      }
      const entry = entries.get(segment);
      if (!entry) throw new ImprovementPublicationGitHubError(code);
      entries.delete(segment);
      levels.push({ target: entry, siblings: entries });
      if (index === path.length - 1) {
        if (
          entry.type !== "blob" ||
          (entry.mode !== "100644" && entry.mode !== "100755") ||
          entry.size === undefined ||
          entry.size > maxDefinitionBytes
        ) {
          throw new ImprovementPublicationGitHubError(code);
        }
        return { entry, levels };
      }
      if (entry.type !== "tree" || entry.mode !== "040000") {
        throw new ImprovementPublicationGitHubError(code);
      }
      current = entry.sha;
    }
    throw new ImprovementPublicationGitHubError("invalid_input");
  }

  async function readFileBytes(entry: TreeEntry, signal: AbortSignal) {
    const value = parse(blob, await request(`/git/blobs/${entry.sha}`, signal));
    const encoding = value.content.replace(/[\r\n]/g, "");
    const bytes = Buffer.from(encoding, "base64");
    if (
      bytes.toString("base64") !== encoding ||
      value.sha !== entry.sha ||
      value.size !== entry.size ||
      bytes.byteLength !== value.size ||
      gitBlobId(bytes) !== entry.sha
    ) {
      throw new ImprovementPublicationGitHubError("invalid_response");
    }
    return bytes;
  }

  async function readPinnedBase(base: ImprovementPublicationBase, signal: AbortSignal) {
    const exactCommit = await readCommit(base.commitSha, signal);
    if (exactCommit.tree.sha !== base.treeSha)
      throw new ImprovementPublicationGitHubError("base_mismatch");
    const exactPath = await readPath(base.treeSha, signal, "base_mismatch");
    if (sha256(await readFileBytes(exactPath.entry, signal)) !== base.fileSha256) {
      throw new ImprovementPublicationGitHubError("base_mismatch");
    }
    return exactPath;
  }

  function verifyTreeDelta(base: TreeLevel[], candidate: TreeLevel[]) {
    for (const [index, level] of base.entries()) {
      const changed = candidate[index];
      if (
        !changed ||
        changed.target.mode !== level.target.mode ||
        changed.siblings.size !== level.siblings.size
      ) {
        throw new ImprovementPublicationGitHubError("head_conflict");
      }
      for (const [name, sibling] of level.siblings) {
        const after = changed.siblings.get(name);
        if (
          after?.sha !== sibling.sha ||
          after.mode !== sibling.mode ||
          after.type !== sibling.type
        ) {
          throw new ImprovementPublicationGitHubError("head_conflict");
        }
      }
    }
  }

  function readVerifiedHead(command: VerifyHead) {
    return withDeadline(command.signal, async (signal) => {
      const base = parse(baseIdentity, command.base, "invalid_input");
      const head = parse(commitIdentity, command.head, "invalid_input");
      const candidateDigest = parse(digest, command.candidateDigest, "invalid_input");
      if (candidateDigest === base.fileSha256)
        throw new ImprovementPublicationGitHubError("head_conflict");
      await readRepository(signal);
      // Only a verified terminal pull request can authorize a missing review ref.
      const requireRef = command.requireRef ?? true;
      await checkHeadRef(head, requireRef, signal);
      checkCommitParent(await readCommit(head.commitSha, signal), base, head.treeSha);
      const before = await readPinnedBase(base, signal);
      const after = await readPath(head.treeSha, signal, "head_conflict");
      verifyTreeDelta(before.levels, after.levels);
      const bytes = await readFileBytes(after.entry, signal);
      const definitionJson = bytes.toString("utf8");
      if (sha256(bytes) !== candidateDigest || !Buffer.from(definitionJson, "utf8").equals(bytes)) {
        throw new ImprovementPublicationGitHubError("head_conflict");
      }
      await checkHeadRef(head, requireRef, signal);
      return definitionJson;
    });
  }

  async function readMatchingPullRequest(command: VerifyPullRequest, signal: AbortSignal) {
    const number = parse(positiveId, command.pullNumber, "invalid_input");
    const base = parse(sha, command.baseCommitSha, "invalid_input");
    const head = parse(sha, command.headCommitSha, "invalid_input");
    await readRepository(signal);
    const data = await request(`/pulls/${number}`, signal);
    const pull = parse(pr, data);
    const url = new URL(pull.html_url);
    if (
      pull.number !== number ||
      pull.base.ref !== target.baseBranch ||
      pull.head.ref !== target.headBranch ||
      !sameRepository(pull.base.repo) ||
      !sameRepository(pull.head.repo) ||
      pull.base.sha !== base ||
      pull.head.sha !== head ||
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.toLowerCase() !== `/${target.repositoryFullName}/pull/${number}`.toLowerCase()
    ) {
      throw new ImprovementPublicationGitHubError("pull_request_conflict");
    }
    const merge = readCanonicalGitHubMerge(data);
    if (
      (pull.merged !== undefined && pull.merged !== (merge !== undefined)) ||
      (pull.merged_at !== null) !== (merge !== undefined)
    ) {
      throw new ImprovementPublicationGitHubError("invalid_response");
    }
    const canonical: CanonicalPullRequest = {
      number: pull.number,
      url: pull.html_url,
      state: merge ? "merged" : pull.state,
      draft: pull.draft,
      headSha: pull.head.sha,
      updatedAt: pull.updated_at,
      ...(merge ? { merge } : {}),
    };
    return { canonical, data };
  }

  return {
    readBase(signal?: AbortSignal) {
      return withDeadline(signal, async (deadline) => {
        const defaultBranch = await readRepository(deadline);
        const commitSha = await readRef(target.baseBranch, deadline);
        if (!commitSha) throw new ImprovementPublicationGitHubError("base_mismatch");
        const base = await readCommit(commitSha, deadline);
        const { entry } = await readPath(base.tree.sha, deadline, "base_mismatch");
        const fileSha256 = sha256(await readFileBytes(entry, deadline));
        if ((await readRef(target.baseBranch, deadline)) !== commitSha) {
          throw new ImprovementPublicationGitHubError("base_mismatch");
        }
        return {
          commitSha,
          treeSha: base.tree.sha,
          fileSha256,
          defaultBranch,
        };
      });
    },

    prepareHead(command: {
      base: ImprovementPublicationBase;
      definitionJson: string;
      candidateDigest: string;
      message: string;
      committedAt: string;
      signal?: AbortSignal;
    }) {
      return withDeadline(command.signal, async (signal) => {
        const base = parse(baseIdentity, command.base, "invalid_input");
        const byteLength = Buffer.byteLength(command.definitionJson, "utf8");
        if (byteLength === 0 || byteLength > maxDefinitionBytes) {
          throw new ImprovementPublicationGitHubError("invalid_input");
        }
        const bytes = Buffer.from(command.definitionJson, "utf8");
        const date = new Date(parse(timestamp, command.committedAt, "invalid_input"))
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z");
        if (
          bytes.includes(0) ||
          bytes.toString("utf8") !== command.definitionJson ||
          !command.message.trim() ||
          Buffer.byteLength(command.message, "utf8") > 2_048 ||
          command.message.includes("\0") ||
          sha256(bytes) !== command.candidateDigest ||
          command.candidateDigest === base.fileSha256
        ) {
          throw new ImprovementPublicationGitHubError("invalid_input");
        }
        await readRepository(signal);
        if ((await readRef(target.baseBranch, signal)) !== base.commitSha) {
          throw new ImprovementPublicationGitHubError("base_mismatch");
        }
        const basePath = await readPinnedBase(base, signal);
        const newBlob = parse(
          createdObject,
          await request("/git/blobs", signal, {
            encoding: "base64",
            content: bytes.toString("base64"),
          }),
        );
        if (newBlob.sha !== gitBlobId(bytes))
          throw new ImprovementPublicationGitHubError("invalid_response");
        const { sha: treeSha } = parse(
          createdObject,
          await request("/git/trees", signal, {
            base_tree: base.treeSha,
            tree: [
              {
                path: target.configPath,
                mode: basePath.entry.mode,
                type: "blob",
                sha: newBlob.sha,
              },
            ],
          }),
        );
        const nextPath = await readPath(treeSha, signal, "head_conflict");
        verifyTreeDelta(basePath.levels, nextPath.levels);
        if (nextPath.entry.sha !== newBlob.sha || nextPath.entry.size !== bytes.byteLength)
          throw new ImprovementPublicationGitHubError("head_conflict");
        const identity = { ...WALLIE_GITHUB_BOT_COMMIT_AUTHOR, date };
        const nextCommit = parse(
          commit,
          await request("/git/commits", signal, {
            message: command.message,
            tree: treeSha,
            parents: [base.commitSha],
            author: identity,
            committer: identity,
          }),
        );
        checkCommitParent(nextCommit, base, treeSha);
        if ((await readRef(target.baseBranch, signal)) !== base.commitSha) {
          throw new ImprovementPublicationGitHubError("base_mismatch");
        }
        return { commitSha: nextCommit.sha, treeSha };
      });
    },

    ensureHeadRef({
      head,
      signal: caller,
    }: {
      head: ImprovementPublicationHead;
      signal?: AbortSignal;
    }) {
      return withDeadline(caller, async (signal) => {
        const pinned = parse(commitIdentity, head, "invalid_input");
        await readRepository(signal);
        const observed = await readRef(target.headBranch, signal);
        if (observed === pinned.commitSha) return;
        if (observed !== null) throw new ImprovementPublicationGitHubError("head_conflict");
        if ((await readCommit(pinned.commitSha, signal)).tree.sha !== pinned.treeSha) {
          throw new ImprovementPublicationGitHubError("head_conflict");
        }
        try {
          const created = parse(
            ref,
            await request("/git/refs", signal, {
              sha: pinned.commitSha,
              ref: `refs/heads/${target.headBranch}`,
            }),
          );
          if (
            created.ref === `refs/heads/${target.headBranch}` &&
            created.object.sha === pinned.commitSha
          )
            return;
        } catch {
          signal.throwIfAborted();
        }
        let reconciled: string | null;
        try {
          reconciled = await readRef(target.headBranch, signal);
        } catch {
          signal.throwIfAborted();
          throw new ImprovementPublicationGitHubError("ref_creation_uncertain");
        }
        if (reconciled === pinned.commitSha) return;
        if (reconciled !== null) throw new ImprovementPublicationGitHubError("head_conflict");
        throw new ImprovementPublicationGitHubError("ref_creation_uncertain");
      });
    },

    async verifyHead(command: VerifyHead) {
      await readVerifiedHead(command);
    },

    readVerifiedHead,

    verifyPullRequest(command: VerifyPullRequest): Promise<CanonicalPullRequest> {
      return withDeadline(command.signal, async (signal) => {
        const { canonical } = await readMatchingPullRequest(command, signal);
        return canonical;
      });
    },

    verifyMergedPullRequest(command: VerifyPullRequest) {
      return withDeadline(command.signal, async (signal) => {
        const { canonical, data } = await readMatchingPullRequest(command, signal);
        if (!canonical.merge || canonical.state !== "merged" || canonical.draft) {
          throw new ImprovementPublicationGitHubError("pull_request_conflict");
        }
        const identity = parse(mergedPullIdentity, data);
        return {
          number: canonical.number,
          url: canonical.url,
          updatedAt: canonical.updatedAt,
          createdAt: identity.created_at,
          authorId: identity.user.id,
          ...canonical.merge,
        };
      });
    },

    verifyMergedBranch(command: {
      baseCommitSha: string;
      head: ImprovementPublicationHead;
      mergeCommitSha: string;
      candidateDigest: string;
      signal: AbortSignal;
    }) {
      return withDeadline(command.signal, async (signal) => {
        const baseCommitSha = parse(sha, command.baseCommitSha, "invalid_input");
        const head = parse(commitIdentity, command.head, "invalid_input");
        const mergeCommitSha = parse(sha, command.mergeCommitSha, "invalid_input");
        const candidateDigest = parse(digest, command.candidateDigest, "invalid_input");
        await readRepository(signal);
        const tipSha = await readRef(target.baseBranch, signal);
        if (!tipSha) throw new ImprovementPublicationGitHubError("base_mismatch");
        const merged = await readCommit(mergeCommitSha, signal);
        if (
          merged.sha === baseCommitSha ||
          merged.tree.sha !== head.treeSha ||
          merged.parents[0]?.sha !== baseCommitSha ||
          (merged.parents.length !== 1 &&
            (merged.parents.length !== 2 || merged.parents[1]?.sha !== head.commitSha))
        ) {
          throw new ImprovementPublicationGitHubError("pull_request_conflict");
        }
        let tip = merged;
        if (tipSha !== mergeCommitSha) {
          const compared = parse(
            comparison,
            await request(`/compare/${mergeCommitSha}...${tipSha}?per_page=1`, signal),
            "base_mismatch",
          );
          if (
            compared.base_commit.sha !== mergeCommitSha ||
            compared.merge_base_commit.sha !== mergeCommitSha
          ) {
            throw new ImprovementPublicationGitHubError("base_mismatch");
          }
          tip = await readCommit(tipSha, signal);
        }
        const mergedPath = await readPath(merged.tree.sha, signal, "head_conflict");
        if (sha256(await readFileBytes(mergedPath.entry, signal)) !== candidateDigest) {
          throw new ImprovementPublicationGitHubError("head_conflict");
        }
        if (tip.tree.sha !== merged.tree.sha) {
          const { entry } = await readPath(tip.tree.sha, signal, "base_mismatch");
          if (entry.sha !== mergedPath.entry.sha || entry.mode !== mergedPath.entry.mode) {
            throw new ImprovementPublicationGitHubError("base_mismatch");
          }
        }
        await checkHeadRef(head, false, signal);
        if ((await readRef(target.baseBranch, signal)) !== tipSha) {
          throw new ImprovementPublicationGitHubError("base_mismatch");
        }
      });
    },

    async readReviewPage(pullNumber: number, page: number, signal: AbortSignal) {
      const number = parse(positiveId, pullNumber, "invalid_input");
      const pageNumber = parse(positiveId, page, "invalid_input");
      let link = "";
      const data = await request(
        `/pulls/${number}/reviews?per_page=100&page=${pageNumber}`,
        signal,
        undefined,
        (headers) => {
          link = headers.get("link") ?? "";
        },
      );
      return { data, hasNextPage: /;\s*rel="next"/i.test(link) };
    },

    async readReviewerPermission(login: string, signal: AbortSignal) {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(login)) {
        throw new ImprovementPublicationGitHubError("invalid_input");
      }
      try {
        return await request(`/collaborators/${encodeURIComponent(login)}/permission`, signal);
      } catch (error) {
        if (error instanceof ImprovementPublicationGitHubError && error.status === 404) return null;
        throw error;
      }
    },
  };
}

/** Writes only Git objects and the owned, create-only review branch. */
export function createImprovementPublicationGitHub(options: GitHubTransportOptions) {
  const { readBase, prepareHead, ensureHeadRef, verifyHead, verifyPullRequest } =
    createImprovementGitHub(options);
  return { readBase, prepareHead, ensureHeadRef, verifyHead, verifyPullRequest };
}

export function createImprovementAdoptionGitHub(options: GitHubTransportOptions) {
  const {
    readVerifiedHead,
    verifyMergedPullRequest,
    verifyMergedBranch,
    readReviewPage,
    readReviewerPermission,
  } = createImprovementGitHub(options);
  return {
    readVerifiedHead,
    verifyMergedPullRequest,
    verifyMergedBranch,
    readReviewPage,
    readReviewerPermission,
  };
}
