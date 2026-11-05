import "server-only";

import { z } from "zod";

export type CanonicalPullRequest = {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  updatedAt: string;
};

type ErrorCode =
  | "pr_creation_uncertain"
  | "pr_creation_rejected"
  | "pr_api_failed"
  | "pr_identity_conflict"
  | "pr_multiple_matches"
  | "pr_invalid_response"
  | "pr_pagination_limit"
  | "pr_request_aborted"
  | "pr_invalid_input";

/** Contains only fixed codes and HTTP status, never provider bodies or credentials. */
export class CanonicalPrApiError extends Error {
  readonly retryCreationSafe: boolean;
  readonly status?: number;

  constructor(
    readonly code: ErrorCode,
    options: { retryCreationSafe?: boolean; status?: number } = {},
  ) {
    super("Canonical pull request synchronization could not be confirmed.");
    this.name = "CanonicalPrApiError";
    this.retryCreationSafe = options.retryCreationSafe ?? false;
    this.status = options.status;
  }
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const repositorySchema = z.object({
  id: z.number().int().positive().safe(),
  full_name: repositoryName,
});
const pullRequestSchema = z.object({
  number: z.number().int().positive().safe(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged_at: z.string().datetime({ offset: true }).nullable(),
  updated_at: z.string().datetime({ offset: true }),
  head: z.object({
    ref: z.string().min(1),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    repo: repositorySchema.nullable(),
  }),
  base: z.object({ ref: z.string().min(1), repo: repositorySchema.nullable() }),
});
type ProviderPullRequest = z.infer<typeof pullRequestSchema>;

function isBranchName(value: string) {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    value !== "@" &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    !value.endsWith(".") &&
    value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

const inputSchema = z.object({
  repositoryFullName: repositoryName.refine((value) =>
    value.split("/").every((part) => part !== "." && part !== ".."),
  ),
  repositoryNumericId: z.number().int().positive().safe(),
  branchName: z.string().refine(isBranchName),
  baseBranch: z.string().refine(isBranchName),
  token: z
    .string()
    .min(1)
    .max(16_384)
    .regex(/^[\x21-\x7e]+$/),
});
const creationSchema = z.object({
  title: z
    .string()
    .max(256)
    .refine((value) => value.trim().length > 0),
  body: z.string().max(65_536),
});

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new CanonicalPrApiError("pr_invalid_response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CanonicalPrApiError("pr_invalid_response");
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        cancel();
        throw new CanonicalPrApiError("pr_invalid_response");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (error) {
    if (signal.aborted || error instanceof CanonicalPrApiError) throw error;
    throw new CanonicalPrApiError("pr_invalid_response");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Only recognized validation failures prove this POST did not create a PR. */
function isDefinitiveValidationRejection(body: unknown) {
  const result = z
    .object({
      message: z.literal("Validation Failed"),
      errors: z
        .array(
          z.object({
            resource: z.literal("PullRequest"),
            code: z.string(),
            field: z.string().optional(),
            message: z.string().optional(),
          }),
        )
        .min(1),
    })
    .safeParse(body);
  if (!result.success) return false;
  return result.data.errors.every((error) => {
    if (error.message && /already exists|duplicate/i.test(error.message)) return false;
    if (
      ["missing", "missing_field", "invalid"].includes(error.code) &&
      error.field &&
      ["head", "base", "title", "body", "issue", "draft", "maintainer_can_modify"].includes(
        error.field,
      )
    )
      return true;
    return error.code === "custom" && /^No commits between .+ and .+$/i.test(error.message ?? "");
  });
}

/** Transport only: durable creation arming and retry ownership belong to the publisher. */
export function createCanonicalPrApi(input: {
  repositoryFullName: string;
  repositoryNumericId: number;
  branchName: string;
  baseBranch: string;
  token: string;
  signal: AbortSignal;
}) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new CanonicalPrApiError("pr_invalid_input");
  const config = parsed.data;
  const [owner, repo] = config.repositoryFullName.split("/");
  const prefix = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const sameRepository = (repository: z.infer<typeof repositorySchema> | null) =>
    repository?.id === config.repositoryNumericId &&
    repository.full_name.toLowerCase() === config.repositoryFullName.toLowerCase();

  const request = async (
    path: string,
    body?: z.infer<typeof creationSchema>,
  ): Promise<{
    data: unknown;
    next: boolean;
  }> => {
    const creating = body !== undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    let started = false;
    let status: number | undefined;
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error());
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await Promise.race([
        (async () => {
          signal.throwIfAborted();
          started = true;
          const response = await fetch(`${prefix}/${path}`, {
            method: creating ? "POST" : "GET",
            signal,
            redirect: "manual",
            headers: {
              Authorization: `Bearer ${config.token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              ...(creating ? { "Content-Type": "application/json" } : {}),
            },
            ...(creating
              ? {
                  body: JSON.stringify({
                    base: config.baseBranch,
                    head: config.branchName,
                    ...body,
                  }),
                }
              : {}),
          });
          status = response.status;
          signal.throwIfAborted();
          if (response.status !== (creating ? 201 : 200)) {
            let safe = creating && [401, 403, 404].includes(response.status);
            if (creating && response.status === 422) {
              try {
                safe = isDefinitiveValidationRejection(await readJson(response, signal));
              } catch {
                safe = false;
              }
            } else void response.body?.cancel().catch(() => undefined);
            throw new CanonicalPrApiError(
              creating
                ? safe
                  ? "pr_creation_rejected"
                  : "pr_creation_uncertain"
                : "pr_api_failed",
              { retryCreationSafe: safe, status: response.status },
            );
          }
          const data = await readJson(response, signal);
          signal.throwIfAborted();
          return {
            data,
            next: /;\s*rel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|next(?:\s|,|$))/i.test(
              response.headers.get("link") ?? "",
            ),
          };
        })(),
        aborted,
      ]);
    } catch (error) {
      if (error instanceof CanonicalPrApiError && (!creating || error.retryCreationSafe))
        throw error;
      throw new CanonicalPrApiError(
        creating
          ? started
            ? "pr_creation_uncertain"
            : "pr_creation_rejected"
          : signal.aborted
            ? "pr_request_aborted"
            : "pr_api_failed",
        {
          retryCreationSafe: creating && !started,
          status: error instanceof CanonicalPrApiError ? (error.status ?? status) : status,
        },
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();
    }
  };

  const receipt = (pr: ProviderPullRequest, pinnedNumber = false): CanonicalPullRequest => {
    const terminalMissingHead = pinnedNumber && pr.state === "closed" && pr.head.repo === null;
    if (
      pr.head.ref !== config.branchName ||
      (!sameRepository(pr.head.repo) && !terminalMissingHead) ||
      !sameRepository(pr.base.repo) ||
      pr.base.ref !== config.baseBranch
    )
      throw new CanonicalPrApiError("pr_identity_conflict");
    const url = new URL(pr.html_url);
    if (
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.toLowerCase() !==
        `/${config.repositoryFullName}/pull/${pr.number}`.toLowerCase() ||
      (pr.state === "open" && pr.merged_at !== null)
    )
      throw new CanonicalPrApiError("pr_invalid_response");
    return {
      number: pr.number,
      url: pr.html_url,
      state: pr.merged_at ? "merged" : pr.state,
      draft: pr.draft,
      headSha: pr.head.sha,
      updatedAt: pr.updated_at,
    };
  };
  const parseOne = (data: unknown) => {
    const result = pullRequestSchema.safeParse(data);
    if (!result.success) throw new CanonicalPrApiError("pr_invalid_response");
    return result.data;
  };

  return {
    async find(): Promise<CanonicalPullRequest | null> {
      let match: CanonicalPullRequest | null = null;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { data, next } = await request(
          `pulls?${new URLSearchParams({
            state: "all",
            head: `${owner}:${config.branchName}`,
            per_page: String(PAGE_SIZE),
            page: String(page),
            sort: "created",
            direction: "asc",
          })}`,
        );
        const parsedPage = z.array(pullRequestSchema).max(PAGE_SIZE).safeParse(data);
        if (!parsedPage.success) throw new CanonicalPrApiError("pr_invalid_response");
        for (const pr of parsedPage.data) {
          if (pr.head.ref !== config.branchName) continue;
          // A deleted head no longer proves this branch absent. In particular,
          // a terminal canonical PR must never authorize a replacement POST.
          if (!pr.head.repo) throw new CanonicalPrApiError("pr_identity_conflict");
          const ownId = pr.head.repo.id === config.repositoryNumericId;
          const ownName =
            pr.head.repo.full_name.toLowerCase() === config.repositoryFullName.toLowerCase();
          if (!ownId && !ownName) continue;
          const found = receipt(pr);
          if (match && match.number !== found.number)
            throw new CanonicalPrApiError("pr_multiple_matches");
          match = found;
        }
        if (!next && parsedPage.data.length < PAGE_SIZE) return match;
      }
      throw new CanonicalPrApiError("pr_pagination_limit");
    },
    async get(number: number): Promise<CanonicalPullRequest> {
      if (!Number.isSafeInteger(number) || number <= 0)
        throw new CanonicalPrApiError("pr_invalid_input");
      const { data } = await request(`pulls/${number}`);
      const pr = parseOne(data);
      if (pr.number !== number) throw new CanonicalPrApiError("pr_identity_conflict");
      return receipt(pr, true);
    },
    async create(body: { title: string; body: string }): Promise<CanonicalPullRequest> {
      const parsedBody = creationSchema.safeParse(body);
      if (!parsedBody.success)
        throw new CanonicalPrApiError("pr_creation_rejected", { retryCreationSafe: true });
      try {
        const { data } = await request("pulls", parsedBody.data);
        return receipt(parseOne(data));
      } catch (error) {
        if (error instanceof CanonicalPrApiError && error.retryCreationSafe) throw error;
        throw new CanonicalPrApiError("pr_creation_uncertain", {
          status: error instanceof CanonicalPrApiError ? error.status : undefined,
        });
      }
    },
  };
}
