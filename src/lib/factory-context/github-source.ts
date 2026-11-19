import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod/v4";

import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";

import { contextFilePathSchema } from "./contracts";

const maxContextBytes = 128 * 1024;
const maxGitMetadataBytes = 512 * 1024;
const syncTimeoutMs = 12_000;
const githubJson = "application/vnd.github+json";
const gitObjectId = z.string().regex(/^[a-f0-9]{40}$/);
const contentDigest = z.string().regex(/^[a-f0-9]{64}$/);
const commitSchema = z.object({
  sha: gitObjectId,
  committer: z.object({ date: z.iso.datetime({ offset: true }) }),
  tree: z.object({ sha: gitObjectId }),
});
const treeSchema = z.object({
  sha: gitObjectId,
  truncated: z.literal(false),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      size: z.number().int().nonnegative().optional(),
      sha: gitObjectId,
    }),
  ),
});
const tokenRequestErrorSchema = z.object({
  status: z.number(),
  response: z
    .object({
      headers: z.record(z.string(), z.string()),
      data: z.object({ message: z.string() }).optional(),
    })
    .optional(),
});

type GitHubContextInput = {
  installationId: number;
  repositoryId: number;
  repositoryFullName: string;
  filePath: string;
};

export type GitHubContextResult =
  | {
      status: "synced";
      content: string;
      upstreamRevision: string;
      upstreamUpdatedAt: string;
    }
  | { status: "access_revoked" }
  | { status: "upstream_deleted" }
  | { status: "unavailable" };

type GitHubReadFailure = Exclude<GitHubContextResult, { status: "synced" }>;
export type GitHubContextProof =
  | { status: "verified"; currentContentSha256: string }
  | { status: "revision_mismatch" }
  | GitHubReadFailure;

type ReadGitHubResource = (
  suffix: string,
  maxBytes: number,
  accept?: string,
) => Promise<Uint8Array>;

class GitHubAccessError extends Error {}

function isAccessError(status: number, headers: Headers, message = "") {
  return (
    status === 401 ||
    (status === 403 &&
      headers.get("x-ratelimit-remaining") !== "0" &&
      !headers.has("retry-after") &&
      !/rate limit|abuse detection/i.test(message))
  );
}

async function readBoundedBytes(response: Response, maximum: number, signal: AbortSignal) {
  const body = response.body;
  if (!body) throw new Error("GitHub response body is unavailable.");
  const length = Number(response.headers.get("content-length"));
  if (length > maximum || signal.aborted) {
    void body.cancel().catch(() => {});
    throw new Error("GitHub response did not fit its bounds.");
  }

  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const bytes = new Uint8Array(maximum);
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) return bytes.subarray(0, size);
      if (value.byteLength > maximum - size) {
        cancel();
        throw new Error("GitHub response exceeded its byte limit.");
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function decodeUtf8(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(decodeUtf8(bytes));
}

async function createGitHubResourceReader(
  input: GitHubContextInput,
  signal: AbortSignal,
): Promise<ReadGitHubResource> {
  let token: string;
  try {
    token = await mintSandboxRepositoryToken({
      installationId: input.installationId,
      repositoryId: input.repositoryId,
      repositoryFullName: input.repositoryFullName,
      purpose: "read-context",
      signal,
    });
  } catch (error) {
    const request = tokenRequestErrorSchema.safeParse(error);
    if (
      request.success &&
      isAccessError(
        request.data.status,
        new Headers(request.data.response?.headers),
        request.data.response?.data?.message,
      )
    ) {
      throw new GitHubAccessError();
    }
    throw new Error("GitHub context credentials are unavailable.");
  }

  return async (suffix, maxBytes, accept = githubJson) => {
    signal.throwIfAborted();
    const response = await fetch(
      `https://api.github.com/repositories/${input.repositoryId}/${suffix}`,
      {
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal,
      },
    );
    if (!response.ok) {
      let message = "";
      // Some secondary rate-limit responses have no retry hint.
      if (response.status === 403 && response.body) {
        message = decodeUtf8(await readBoundedBytes(response, 2048, signal));
      } else {
        void response.body?.cancel().catch(() => {});
      }
      if (isAccessError(response.status, response.headers, message)) throw new GitHubAccessError();
      throw new Error("GitHub returned an unavailable resource.");
    }
    return readBoundedBytes(response, maxBytes, signal);
  };
}

async function readGitHubHead(readResource: ReadGitHubResource) {
  return gitObjectId.parse(
    decodeUtf8(await readResource("commits/HEAD", 64, "application/vnd.github.sha")).trim(),
  );
}

async function readGitHubContextFileAtRevision(
  readResource: ReadGitHubResource,
  segments: string[],
  revision: string,
): Promise<GitHubContextResult> {
  const commit = commitSchema.parse(
    parseJson(await readResource(`git/commits/${revision}`, maxGitMetadataBytes)),
  );
  if (commit.sha !== revision) return { status: "unavailable" };
  let treeId = commit.tree.sha;

  for (const [index, segment] of segments.entries()) {
    const tree = treeSchema.parse(
      parseJson(await readResource(`git/trees/${treeId}`, maxGitMetadataBytes)),
    );
    if (tree.sha !== treeId) return { status: "unavailable" };
    // Absence is authoritative only in a verified, untruncated tree. A
    // provider HTTP 404 can also mean missing authorization.
    const entries = tree.tree.filter((candidate) => candidate.path === segment);
    if (entries.length > 1) return { status: "unavailable" };
    const [entry] = entries;
    if (!entry) return { status: "upstream_deleted" };
    if (index < segments.length - 1) {
      if (entry.type === "blob" || entry.type === "commit") return { status: "upstream_deleted" };
      if (entry.type !== "tree" || entry.mode !== "040000") return { status: "unavailable" };
      treeId = entry.sha;
      continue;
    }
    if (
      entry.type !== "blob" ||
      (entry.mode !== "100644" && entry.mode !== "100755") ||
      entry.size === undefined ||
      entry.size > maxContextBytes
    ) {
      return { status: "unavailable" };
    }
    const bytes = await readResource(
      `git/blobs/${entry.sha}`,
      entry.size,
      "application/vnd.github.raw+json",
    );
    const blobId = createHash("sha1")
      .update(`blob ${bytes.byteLength}\0`)
      .update(bytes)
      .digest("hex");
    if (bytes.byteLength !== entry.size || blobId !== entry.sha) return { status: "unavailable" };
    const content = decodeUtf8(bytes);
    if (content.includes("\0")) return { status: "unavailable" };
    return {
      status: "synced",
      content,
      upstreamRevision: revision,
      upstreamUpdatedAt: new Date(commit.committer.date).toISOString(),
    };
  }

  return { status: "unavailable" };
}

async function readGitHubContext<Result>(
  input: GitHubContextInput,
  read: (resource: ReadGitHubResource, segments: string[]) => Promise<Result>,
  callerSignal?: AbortSignal,
): Promise<Result | GitHubReadFailure> {
  const path = contextFilePathSchema.safeParse(input.filePath);
  if (
    !path.success ||
    !Number.isSafeInteger(input.repositoryId) ||
    !Number.isSafeInteger(input.installationId) ||
    input.repositoryId <= 0 ||
    input.installationId <= 0
  ) {
    return { status: "unavailable" };
  }

  const timeout = AbortSignal.timeout(syncTimeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  let onAbort = () => {};
  const deadline = new Promise<{ status: "unavailable" }>((resolve) => {
    onAbort = () => resolve({ status: "unavailable" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([
      createGitHubResourceReader(input, signal).then((resource) =>
        read(resource, path.data.split("/")),
      ),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof GitHubAccessError) return { status: "access_revoked" };
    return { status: "unavailable" };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Fetch external document bytes without granting them prompt authority. */
export async function fetchGitHubContextFile(
  input: GitHubContextInput,
): Promise<GitHubContextResult> {
  return readGitHubContext(input, async (resource, segments) =>
    readGitHubContextFileAtRevision(resource, segments, await readGitHubHead(resource)),
  );
}

/** Recheck live file access and verify the historical bytes without returning upstream text. */
export async function verifyLiveGitHubContextRevision(
  input: GitHubContextInput & {
    upstreamRevision: string;
    contentSha256: string;
    signal?: AbortSignal;
  },
): Promise<GitHubContextProof> {
  const { upstreamRevision, contentSha256, signal } = input;
  if (
    !gitObjectId.safeParse(upstreamRevision).success ||
    !contentDigest.safeParse(contentSha256).success
  ) {
    return { status: "revision_mismatch" };
  }

  return readGitHubContext<GitHubContextProof>(
    input,
    async (resource, segments) => {
      const head = await readGitHubHead(resource);
      const current = await readGitHubContextFileAtRevision(resource, segments, head);
      if (current.status !== "synced") return current;
      const currentContentSha256 = createHash("sha256").update(current.content).digest("hex");

      if (head === upstreamRevision) {
        return currentContentSha256 === contentSha256
          ? { status: "verified", currentContentSha256 }
          : { status: "revision_mismatch" };
      }

      const requested = await readGitHubContextFileAtRevision(resource, segments, upstreamRevision);
      if (requested.status === "upstream_deleted") return { status: "revision_mismatch" };
      if (requested.status !== "synced") return requested;
      if (createHash("sha256").update(requested.content).digest("hex") !== contentSha256) {
        return { status: "revision_mismatch" };
      }
      return { status: "verified", currentContentSha256 };
    },
    signal,
  );
}
