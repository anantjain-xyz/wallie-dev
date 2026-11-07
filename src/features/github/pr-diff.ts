import "server-only";

import { z } from "zod";

import type { PrDiff, PrDiffFile } from "@/features/sessions/detail/review-evidence-contracts";

const MAX_FILES = 100;
const MAX_PATCH_LINES = 400;
const MAX_PATCH_CHARS = 24_000;
const MAX_TOTAL_PATCH_CHARS = 160_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.number().int().positive().safe();
const timestamp = z.string().datetime({ offset: true });
const repository = z.object({
  id,
  full_name: z.string().min(1).max(200),
});
const pullRequestSchema = z.object({
  number: id,
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged_at: timestamp.nullable(),
  head: z.object({ sha, repo: repository.nullable() }),
  base: z.object({ sha, repo: repository }),
});
const fileSchema = z.object({
  filename: z.string().min(1).max(1000),
  previous_filename: z.string().min(1).max(1000).optional(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  patch: z.string().optional(),
  blob_url: z.string().url().optional(),
});

export type PrDiffErrorCode =
  | "github_invalid_response"
  | "github_identity_mismatch"
  | "github_access_denied"
  | "github_not_found"
  | "github_rate_limited"
  | "github_unavailable"
  | "github_request_aborted";

/** Fixed codes only; provider bodies, URLs, and credentials never escape here. */
export class PrDiffApiError extends Error {
  constructor(
    readonly code: PrDiffErrorCode,
    readonly status?: number,
  ) {
    super("The pull request diff could not be confirmed.");
    this.name = "PrDiffApiError";
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new PrDiffApiError("github_invalid_response");
  return result.data;
}

async function readJson(response: Response, signal: AbortSignal) {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new PrDiffApiError("github_invalid_response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new PrDiffApiError("github_invalid_response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        cancel();
        throw new PrDiffApiError("github_invalid_response");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function hasNextPage(link: string | null) {
  return /;\s*rel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|next(?:\s|,|$))/i.test(link ?? "");
}

function boundedPatch(patch: string | undefined, remainingChars: number) {
  if (!patch) return { patch: null, patchTruncated: false, patchUnavailable: true, used: 0 };
  const lines = patch.split("\n");
  const lineLimited = lines.length > MAX_PATCH_LINES;
  const boundedLines = lineLimited ? lines.slice(0, MAX_PATCH_LINES).join("\n") : patch;
  const charLimited = boundedLines.length > Math.min(MAX_PATCH_CHARS, remainingChars);
  const bounded = charLimited
    ? boundedLines.slice(0, Math.min(MAX_PATCH_CHARS, remainingChars))
    : boundedLines;
  return {
    patch: bounded,
    patchTruncated: lineLimited || charLimited,
    patchUnavailable: false,
    used: bounded.length,
  };
}

/**
 * Read-only canonical PR diff. The caller supplies a pinned repository/PR
 * identity; no request value can select another provider target.
 */
export async function loadPrDiff(input: {
  token: string;
  repositoryFullName: string;
  repositoryNumericId: number;
  prNumber: number;
  expectedUrl: string | null;
  signal: AbortSignal;
}): Promise<PrDiff> {
  const config = z
    .object({
      token: z
        .string()
        .min(1)
        .max(16_384)
        .regex(/^[\x21-\x7e]+$/),
      repositoryFullName: z
        .string()
        .max(200)
        .refine((value) => {
          const parts = value.split("/");
          return (
            parts.length === 2 &&
            parts.every((part) => part !== "" && part !== "." && part !== "..") &&
            /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
          );
        }),
      repositoryNumericId: id,
      prNumber: id,
      expectedUrl: z.string().url().nullable(),
    })
    .safeParse(input);
  if (!config.success) throw new PrDiffApiError("github_invalid_response");
  const value = config.data;
  const [owner, repo] = value.repositoryFullName.split("/") as [string, string];
  const prefix = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const request = async (path: string) => {
    const requestController = new AbortController();
    const requestSignal = AbortSignal.any([signal, requestController.signal]);
    const requestTimer = setTimeout(() => requestController.abort(), REQUEST_TIMEOUT_MS);
    try {
      requestSignal.throwIfAborted();
      const response = await fetch(`${prefix}/${path}`, {
        signal: requestSignal,
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${value.token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "Wallie",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      requestSignal.throwIfAborted();
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        const rateLimited =
          response.status === 429 ||
          (response.status === 403 &&
            (response.headers.get("x-ratelimit-remaining") === "0" ||
              response.headers.has("retry-after")));
        throw new PrDiffApiError(
          rateLimited
            ? "github_rate_limited"
            : [401, 403].includes(response.status)
              ? "github_access_denied"
              : response.status === 404
                ? "github_not_found"
                : "github_unavailable",
          response.status,
        );
      }
      return {
        data: await readJson(response, requestSignal),
        link: response.headers.get("link"),
      };
    } catch (error) {
      if (error instanceof PrDiffApiError) throw error;
      throw new PrDiffApiError(
        requestSignal.aborted ? "github_request_aborted" : "github_invalid_response",
      );
    } finally {
      clearTimeout(requestTimer);
      requestController.abort();
    }
  };

  try {
    const pr = parse(pullRequestSchema, (await request(`pulls/${value.prNumber}`)).data);
    const url = new URL(pr.html_url);
    if (
      pr.number !== value.prNumber ||
      pr.base.repo.id !== value.repositoryNumericId ||
      pr.base.repo.full_name.toLowerCase() !== value.repositoryFullName.toLowerCase() ||
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.toLowerCase() !==
        `/${value.repositoryFullName.toLowerCase()}/pull/${value.prNumber}` ||
      (pr.head.repo !== null &&
        (pr.head.repo.id !== value.repositoryNumericId ||
          pr.head.repo.full_name.toLowerCase() !== value.repositoryFullName.toLowerCase())) ||
      (pr.state === "open" && pr.merged_at !== null) ||
      (value.expectedUrl !== null &&
        (() => {
          const expected = new URL(value.expectedUrl);
          return (
            expected.origin !== "https://github.com" ||
            expected.pathname.replace(/\/+$/, "").toLowerCase() !==
              url.pathname.replace(/\/+$/, "").toLowerCase()
          );
        })())
    )
      throw new PrDiffApiError("github_identity_mismatch");

    const filesResponse = await request(
      `pulls/${value.prNumber}/files?per_page=${MAX_FILES}&page=1`,
    );
    const rawFiles = parse(z.array(fileSchema).max(MAX_FILES), filesResponse.data);
    // A push during page collection must not label an old head over a new diff.
    const final = parse(pullRequestSchema, (await request(`pulls/${value.prNumber}`)).data);
    if (
      final.head.sha !== pr.head.sha ||
      final.base.sha !== pr.base.sha ||
      final.state !== pr.state ||
      final.merged_at !== pr.merged_at ||
      final.draft !== pr.draft
    )
      throw new PrDiffApiError("github_identity_mismatch");
    let remainingChars = MAX_TOTAL_PATCH_CHARS;
    let anyTruncated = false;
    let additions = 0;
    let deletions = 0;
    const files: PrDiffFile[] = rawFiles.map((file) => {
      const bounded = boundedPatch(file.patch, remainingChars);
      remainingChars = Math.max(remainingChars - bounded.used, 0);
      additions += file.additions;
      deletions += file.deletions;
      anyTruncated ||= bounded.patchTruncated || bounded.patchUnavailable;
      return {
        filename: file.filename,
        previousFilename: file.previous_filename ?? null,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: bounded.patch,
        patchTruncated: bounded.patchTruncated,
        patchUnavailable: bounded.patchUnavailable,
        blobUrl: file.blob_url ?? null,
      };
    });
    const hasMore = hasNextPage(filesResponse.link);
    return {
      repositoryFullName: pr.base.repo.full_name,
      prNumber: pr.number,
      url: pr.html_url,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      state: pr.merged_at ? "merged" : pr.state,
      draft: pr.draft,
      files,
      additions,
      deletions,
      hasMore,
      truncated: anyTruncated || hasMore,
      limits: {
        maxFiles: MAX_FILES,
        maxPatchLines: MAX_PATCH_LINES,
        maxPatchCharacters: MAX_PATCH_CHARS,
      },
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
