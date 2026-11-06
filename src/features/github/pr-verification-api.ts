import "server-only";

import { z } from "zod";

import {
  deliveryRequirementsSchema,
  type DeliveryRequirements,
} from "@/lib/delivery-policy/contracts";
import type { Json } from "@/lib/supabase/database.types";

type Outcome = "passed" | "checking" | "blocked" | "unknown";
type Blocker = { code: string; requirement?: string };
type RequiredCheck = { context: string; appId: number | null; source: string };

export type GitHubPrVerificationSnapshot = {
  headSha: string;
  baseSha: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  updatedAt: string;
  payload: { [key: string]: Json };
};

type ErrorCode =
  | "github_invalid_input"
  | "github_invalid_response"
  | "github_identity_mismatch"
  | "github_permission_missing"
  | "github_rate_limited"
  | "github_access_denied"
  | "github_not_found"
  | "github_unavailable"
  | "github_pagination_limit"
  | "github_changed_during_refresh"
  | "github_request_aborted";

/** Fixed codes only: provider bodies, URLs, and credentials never escape here. */
export class PrVerificationApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status?: number,
  ) {
    super("Current GitHub pull request verification could not be confirmed.");
    this.name = "PrVerificationApiError";
  }
}

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 240_000;
const REQUEST_TIMEOUT_MS = 12_000;
const COLLECTION_TIMEOUT_MS = 55_000;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const name = z.string().min(1).max(200);
const id = z.number().int().positive().safe();
const timestamp = z.string().datetime({ offset: true });
const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const repository = z.object({ id, full_name: repositoryName });
const prSchema = z.object({
  number: id,
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged_at: timestamp.nullable(),
  mergeable: z.boolean().nullable(),
  mergeable_state: z.string(),
  updated_at: timestamp,
  head: z.object({ ref: z.string(), sha, repo: repository.nullable() }),
  base: z.object({ ref: z.string(), sha, repo: repository }),
});
const checkSchema = z.object({
  id,
  name,
  head_sha: sha,
  status: z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]),
  conclusion: z.string().nullable(),
  completed_at: timestamp.nullable(),
  app: z.object({ id, slug: z.string() }),
  check_suite: z.object({ id }).nullable(),
});
const statusSchema = z.object({
  id,
  context: name,
  state: z.enum(["error", "failure", "pending", "success"]),
  updated_at: timestamp,
});
const workflowSchema = z.object({
  id,
  check_suite_id: id.nullable(),
  head_sha: sha,
  event: z.string(),
});
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const reviewSchema = z.object({
  id: z.string().min(1),
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
  author: z.object({ login: z.string().min(1) }).nullable(),
  authorCanPushToRepository: z.boolean(),
  commit: z.object({ oid: sha }).nullable(),
});
const threadSchema = z.object({
  id: z.string().min(1),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
});
const graphSchema = z.object({
  data: z.object({
    repository: z.object({
      databaseId: id,
      nameWithOwner: repositoryName,
      pullRequest: z.object({
        number: id,
        headRefOid: sha,
        baseRefOid: sha,
        isDraft: z.boolean(),
        state: z.enum(["OPEN", "CLOSED", "MERGED"]),
        reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
        mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
        mergeStateStatus: z.string(),
        baseRef: z
          .object({
            name: z.string(),
            branchProtectionRule: z.object({ id: z.string() }).nullable(),
          })
          .nullable(),
        potentialMergeCommit: z
          .object({
            oid: sha,
            parents: z.object({ nodes: z.array(z.object({ oid: sha })).max(2), pageInfo }),
          })
          .nullable(),
        latestOpinionatedReviews: z
          .object({ nodes: z.array(reviewSchema).max(PAGE_SIZE), pageInfo })
          .optional(),
        reviewThreads: z
          .object({ nodes: z.array(threadSchema).max(PAGE_SIZE), pageInfo })
          .optional(),
      }),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});
const graphQuery = `query Verification($owner:String!,$repo:String!,$number:Int!,$reviews:String,$threads:String,$readReviews:Boolean!,$readThreads:Boolean!) {
  repository(owner:$owner,name:$repo) { databaseId nameWithOwner
    pullRequest(number:$number) { number headRefOid baseRefOid isDraft state reviewDecision mergeable mergeStateStatus
      baseRef { name branchProtectionRule { id } }
      potentialMergeCommit { oid parents(first:2) { nodes { oid } pageInfo { hasNextPage endCursor } } }
      latestOpinionatedReviews(first:100,after:$reviews,writersOnly:true) @include(if:$readReviews) {
        nodes { id state author { login } authorCanPushToRepository commit { oid } } pageInfo { hasNextPage endCursor }
      }
      reviewThreads(first:100,after:$threads) @include(if:$readThreads) {
        nodes { id isResolved isOutdated } pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new PrVerificationApiError("github_invalid_response");
  return result.data;
}

async function readJson(response: Response, signal: AbortSignal) {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new PrVerificationApiError("github_invalid_response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new PrVerificationApiError("github_invalid_response");
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
        throw new PrVerificationApiError("github_invalid_response");
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

/**
 * Authoritative collection only. No artifact approval, readiness result, merge,
 * repository setting, or GitHub check is written by this reader.
 */
export async function collectPrVerification(input: {
  token: string;
  repositoryFullName: string;
  repositoryNumericId: number;
  prNumber: number;
  branchName: string;
  baseBranch: string;
  signal: AbortSignal;
  requirements: DeliveryRequirements;
  installationPermissions: Record<string, string>;
}): Promise<GitHubPrVerificationSnapshot> {
  const validated = z
    .object({
      token: z
        .string()
        .min(1)
        .max(16_384)
        .regex(/^[\x21-\x7e]+$/),
      repositoryFullName: repositoryName.refine((value) =>
        value.split("/").every((part) => part !== "." && part !== ".."),
      ),
      repositoryNumericId: id,
      prNumber: id,
      branchName: z.string().min(1).max(1024),
      baseBranch: z.string().min(1).max(1024),
      requirements: deliveryRequirementsSchema,
      installationPermissions: z.record(z.string(), z.string()),
    })
    .safeParse(input);
  if (!validated.success || input.requirements.deliveryMode !== "code")
    throw new PrVerificationApiError("github_invalid_input");
  const config = validated.data;
  const canRead = (permission: string) =>
    ["read", "write"].includes(config.installationPermissions[permission]);
  if (!["contents", "checks", "statuses", "pull_requests"].every(canRead))
    throw new PrVerificationApiError("github_permission_missing");
  const [owner, repo] = config.repositoryFullName.split("/");
  const prefix = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const deadline = new AbortController();
  const collectionSignal = AbortSignal.any([input.signal, deadline.signal]);
  const collectionTimer = setTimeout(() => deadline.abort(), COLLECTION_TIMEOUT_MS);
  const request = async (path: string, body?: object, allow404 = false) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([collectionSignal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new PrVerificationApiError("github_request_aborted"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      return await Promise.race([
        (async () => {
          signal.throwIfAborted();
          const response = await fetch(
            body ? "https://api.github.com/graphql" : `${prefix}/${path}`,
            {
              method: body ? "POST" : "GET",
              signal,
              redirect: "manual",
              headers: {
                Authorization: `Bearer ${config.token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                ...(body ? { "Content-Type": "application/json" } : {}),
              },
              ...(body ? { body: JSON.stringify(body) } : {}),
            },
          );
          signal.throwIfAborted();
          if (response.status === 404 && allow404) {
            void response.body?.cancel().catch(() => undefined);
            return { data: null, next: false };
          }
          if (response.status !== 200) {
            void response.body?.cancel().catch(() => undefined);
            const rateLimited =
              response.status === 429 ||
              (response.status === 403 &&
                (response.headers.get("x-ratelimit-remaining") === "0" ||
                  response.headers.has("retry-after")));
            throw new PrVerificationApiError(
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
      if (error instanceof PrVerificationApiError) throw error;
      throw new PrVerificationApiError(
        signal.aborted ? "github_request_aborted" : "github_invalid_response",
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();
    }
  };
  const list = async <T>(path: string, schema: z.ZodType<T>, envelope?: string) => {
    const result: T[] = [];
    let total: number | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await request(
        `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`,
      );
      let items: unknown = response.data;
      if (envelope) {
        const metadata = parse(
          z.object({ total_count: z.number().int().nonnegative().safe() }).passthrough(),
          items,
        );
        if (total !== undefined && metadata.total_count !== total)
          throw new PrVerificationApiError("github_changed_during_refresh");
        total = metadata.total_count;
        if (total > MAX_PAGES * PAGE_SIZE)
          throw new PrVerificationApiError("github_pagination_limit");
        items = metadata[envelope];
      }
      const rows = parse(z.array(schema).max(PAGE_SIZE), items);
      result.push(...rows);
      if (!response.next && rows.length < PAGE_SIZE) {
        if (total !== undefined && result.length !== total)
          throw new PrVerificationApiError("github_invalid_response");
        return result;
      }
    }
    throw new PrVerificationApiError("github_pagination_limit");
  };
  const sameRepository = (value: z.infer<typeof repository> | null) =>
    value?.id === config.repositoryNumericId &&
    value.full_name.toLowerCase() === config.repositoryFullName.toLowerCase();
  const getPr = async () => {
    const value = parse(prSchema, (await request(`pulls/${config.prNumber}`)).data);
    const url = new URL(value.html_url);
    if (
      value.number !== config.prNumber ||
      value.head.ref !== config.branchName ||
      value.base.ref !== config.baseBranch ||
      !sameRepository(value.base.repo) ||
      (!sameRepository(value.head.repo) &&
        !(value.state === "closed" && value.head.repo === null)) ||
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.toLowerCase() !==
        `/${config.repositoryFullName}/pull/${config.prNumber}`.toLowerCase() ||
      (value.state === "open" && value.merged_at !== null)
    )
      throw new PrVerificationApiError("github_identity_mismatch");
    return value;
  };

  try {
    const initial = await getPr();
    const state = initial.merged_at ? "merged" : initial.state;
    const blockers: Blocker[] = [];
    const add = (code: string, requirement?: string) =>
      blockers.push({ code, ...(requirement ? { requirement } : {}) });
    const reviews: z.infer<typeof reviewSchema>[] = [];
    const threads: z.infer<typeof threadSchema>[] = [];
    let reviewCursor: string | null = null;
    let threadCursor: string | null = null;
    let readReviews = true;
    let readThreads = true;
    let graph: z.infer<typeof graphSchema>["data"]["repository"]["pullRequest"] | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = parse(
        graphSchema,
        (
          await request("", {
            query: graphQuery,
            variables: {
              owner,
              repo,
              number: config.prNumber,
              reviews: reviewCursor,
              threads: threadCursor,
              readReviews,
              readThreads,
            },
          })
        ).data,
      );
      if (result.errors?.length) throw new PrVerificationApiError("github_unavailable");
      const observedRepo = result.data.repository;
      const observed = observedRepo.pullRequest;
      if (
        observedRepo.databaseId !== config.repositoryNumericId ||
        observedRepo.nameWithOwner.toLowerCase() !== config.repositoryFullName.toLowerCase() ||
        observed.number !== config.prNumber ||
        observed.headRefOid !== initial.head.sha ||
        observed.baseRefOid !== initial.base.sha ||
        observed.state.toLowerCase() !== state ||
        observed.isDraft !== initial.draft ||
        (observed.baseRef && observed.baseRef.name !== config.baseBranch)
      )
        throw new PrVerificationApiError("github_changed_during_refresh");
      if (
        graph &&
        (observed.reviewDecision !== graph.reviewDecision ||
          observed.mergeable !== graph.mergeable ||
          observed.mergeStateStatus !== graph.mergeStateStatus ||
          observed.potentialMergeCommit?.oid !== graph.potentialMergeCommit?.oid)
      )
        throw new PrVerificationApiError("github_changed_during_refresh");
      graph = observed;
      const advance = (
        connection: { nodes: unknown[]; pageInfo: z.infer<typeof pageInfo> } | undefined,
        current: string | null,
      ) => {
        if (!connection) throw new PrVerificationApiError("github_invalid_response");
        if (
          connection.pageInfo.hasNextPage &&
          (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === current)
        )
          throw new PrVerificationApiError("github_pagination_limit");
        return connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      };
      if (readReviews) {
        reviewCursor = advance(observed.latestOpinionatedReviews, reviewCursor);
        reviews.push(...observed.latestOpinionatedReviews!.nodes);
        readReviews = reviewCursor !== null;
      }
      if (readThreads) {
        threadCursor = advance(observed.reviewThreads, threadCursor);
        threads.push(...observed.reviewThreads!.nodes);
        readThreads = threadCursor !== null;
      }
      if (!readReviews && !readThreads) break;
      if (page === MAX_PAGES) throw new PrVerificationApiError("github_pagination_limit");
    }
    if (!graph) throw new PrVerificationApiError("github_invalid_response");
    if (
      new Set(reviews.map((review) => review.id)).size !== reviews.length ||
      new Set(threads.map((thread) => thread.id)).size !== threads.length
    )
      throw new PrVerificationApiError("github_changed_during_refresh");

    const requiredChecks: RequiredCheck[] = config.requirements.requiredChecks.map((context) => ({
      context,
      appId: null,
      source: "policy",
    }));
    let protection: "verified" | "unknown" = "verified";
    let minimumApprovals = config.requirements.minimumApprovals;
    let codeOwnersRequired = false;
    let requireResolvedThreads = config.requirements.requireResolvedThreads;
    let strictChecks = false;
    const unsupportedRules: string[] = [];
    const rules = await list(
      `rules/branches/${encodeURIComponent(config.baseBranch)}`,
      z.object({
        type: z.string(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        ruleset_id: id.optional(),
      }),
    );
    const requiredCheckSchema = z.object({
      context: name,
      integration_id: id.nullable().optional(),
    });
    const pullRequestRuleSchema = z.object({
      required_approving_review_count: z.number().int().nonnegative(),
      require_code_owner_review: z.boolean(),
      required_review_thread_resolution: z.boolean(),
      dismiss_stale_reviews_on_push: z.boolean(),
      require_last_push_approval: z.boolean(),
    });
    for (const rule of rules) {
      if (rule.type === "required_status_checks") {
        const parameters = parse(
          z.object({
            required_status_checks: z.array(requiredCheckSchema).max(PAGE_SIZE),
            strict_required_status_checks_policy: z.boolean(),
          }),
          rule.parameters,
        );
        strictChecks ||= parameters.strict_required_status_checks_policy;
        requiredChecks.push(
          ...parameters.required_status_checks.map((check) => ({
            context: check.context,
            appId: check.integration_id ?? null,
            source: "ruleset",
          })),
        );
      } else if (rule.type === "pull_request") {
        const parameters = parse(pullRequestRuleSchema, rule.parameters);
        minimumApprovals = Math.max(minimumApprovals, parameters.required_approving_review_count);
        codeOwnersRequired ||= parameters.require_code_owner_review;
        requireResolvedThreads ||= parameters.required_review_thread_resolution;
      } else if (!["deletion", "non_fast_forward", "creation"].includes(rule.type)) {
        unsupportedRules.push(rule.type);
      }
    }
    if (!canRead("administration")) {
      protection = "unknown";
      add("github_administration_permission_missing");
    } else {
      const response = await request(
        `branches/${encodeURIComponent(config.baseBranch)}/protection`,
        undefined,
        true,
      );
      if (response.data === null) {
        // A 404 alone is ambiguous. The current GraphQL base ref must also prove
        // that no classic branch protection rule applies.
        if (!graph.baseRef || graph.baseRef.branchProtectionRule) {
          protection = "unknown";
          add("github_branch_protection_unavailable");
        }
      } else {
        const classic = parse(
          z.object({
            url: z.string().url(),
            required_status_checks: z
              .object({
                strict: z.boolean(),
                contexts: z.array(name),
                checks: z
                  .array(z.object({ context: name, app_id: z.number().int().safe().nullable() }))
                  .optional(),
              })
              .nullable()
              .optional(),
            required_pull_request_reviews: z
              .object({
                required_approving_review_count: z.number().int().nonnegative(),
                require_code_owner_reviews: z.boolean(),
                dismiss_stale_reviews: z.boolean(),
                require_last_push_approval: z.boolean().optional(),
              })
              .nullable()
              .optional(),
            required_conversation_resolution: z.object({ enabled: z.boolean() }).optional(),
            required_signatures: z.object({ enabled: z.boolean() }).optional(),
            required_linear_history: z.object({ enabled: z.boolean() }).optional(),
          }),
          response.data,
        );
        if (
          classic.url !== `${prefix}/branches/${encodeURIComponent(config.baseBranch)}/protection`
        )
          throw new PrVerificationApiError("github_identity_mismatch");
        if (!graph.baseRef?.branchProtectionRule) {
          protection = "unknown";
          add("github_branch_protection_changed");
        }
        if (classic.required_status_checks) {
          strictChecks ||= classic.required_status_checks.strict;
          for (const context of classic.required_status_checks.contexts) {
            const identities =
              classic.required_status_checks.checks?.filter((check) => check.context === context) ??
              [];
            if (
              !identities.length ||
              identities.some(
                (check) => check.app_id === null || (check.app_id ?? 0) < -1 || check.app_id === 0,
              )
            ) {
              protection = "unknown";
              add("github_required_check_source_unknown", context);
            }
          }
          for (const check of classic.required_status_checks.checks ?? []) {
            if (check.app_id === null || check.app_id < -1 || check.app_id === 0) {
              protection = "unknown";
              add("github_required_check_source_unknown", check.context);
            } else
              requiredChecks.push({
                context: check.context,
                appId: check.app_id === -1 ? null : check.app_id,
                source: "branch_protection",
              });
          }
        }
        if (classic.required_pull_request_reviews) {
          minimumApprovals = Math.max(
            minimumApprovals,
            classic.required_pull_request_reviews.required_approving_review_count,
          );
          codeOwnersRequired ||= classic.required_pull_request_reviews.require_code_owner_reviews;
        }
        requireResolvedThreads ||= classic.required_conversation_resolution?.enabled ?? false;
        if (classic.required_signatures?.enabled) unsupportedRules.push("required_signatures");
        if (classic.required_linear_history?.enabled)
          unsupportedRules.push("required_linear_history");
      }
    }
    if (unsupportedRules.length) {
      protection = "unknown";
      for (const rule of [...new Set(unsupportedRules)]) add("github_rule_unsupported", rule);
    }

    const collectChecks = async (commitSha: string) => {
      const checkRuns = await list(
        `commits/${commitSha}/check-runs?filter=all`,
        checkSchema,
        "check_runs",
      );
      const statuses = await list(`commits/${commitSha}/statuses`, statusSchema);
      if (checkRuns.some((check) => check.head_sha !== commitSha))
        throw new PrVerificationApiError("github_identity_mismatch");
      const workflows =
        canRead("actions") && checkRuns.some((check) => check.app.slug === "github-actions")
          ? await list(`actions/runs?head_sha=${commitSha}`, workflowSchema, "workflow_runs")
          : [];
      if (workflows.some((run) => run.head_sha !== commitSha))
        throw new PrVerificationApiError("github_identity_mismatch");
      const latestChecks = new Map<string, z.infer<typeof checkSchema>>();
      for (const check of checkRuns) {
        const key = `${check.app.id}:${check.name}`;
        if ((latestChecks.get(key)?.id ?? 0) < check.id) latestChecks.set(key, check);
      }
      const latestStatuses = new Map<string, z.infer<typeof statusSchema>>();
      for (const status of statuses)
        if ((latestStatuses.get(status.context)?.id ?? 0) < status.id)
          latestStatuses.set(status.context, status);
      return {
        sha: commitSha,
        checkRuns: [...latestChecks.values()],
        statuses: [...latestStatuses.values()],
        workflows,
      };
    };
    const headChecks = await collectChecks(initial.head.sha);
    let selectedChecks = headChecks;
    let mergeChecks: Awaited<ReturnType<typeof collectChecks>> | null = null;
    if (graph.potentialMergeCommit && state === "open") {
      const merge = graph.potentialMergeCommit;
      if (
        merge.parents.pageInfo.hasNextPage ||
        merge.parents.nodes.length !== 2 ||
        merge.parents.nodes[0].oid !== initial.base.sha ||
        merge.parents.nodes[1].oid !== initial.head.sha
      )
        throw new PrVerificationApiError("github_changed_during_refresh");
      mergeChecks = await collectChecks(merge.oid);
      if (mergeChecks.checkRuns.length || mergeChecks.statuses.length) selectedChecks = mergeChecks;
    }
    let checks: Outcome = "passed";
    const lower = (outcome: Outcome) => {
      if (outcome === "unknown" || checks === "unknown") checks = "unknown";
      else if (outcome === "blocked" || checks === "blocked") checks = "blocked";
      else if (outcome === "checking" || checks === "checking") checks = "checking";
    };
    if (!selectedChecks.checkRuns.length && !selectedChecks.statuses.length) {
      checks = "unknown";
      add("github_checks_empty");
    }
    const allowedEvents = new Set([
      "push",
      "pull_request",
      "pull_request_review",
      "pull_request_target",
      "deployment",
      "deployment_status",
    ]);
    const recent = (value: string | null) =>
      value !== null &&
      Date.parse(value) <= Date.now() + 5000 &&
      Date.parse(value) >= Date.now() - 7 * 86_400_000;
    for (const required of requiredChecks) {
      const matchingChecks = selectedChecks.checkRuns.filter(
        (check) =>
          check.name === required.context &&
          (required.appId === null || check.app.id === required.appId),
      );
      const matchingStatuses = selectedChecks.statuses.filter(
        (status) => status.context === required.context,
      );
      if (!matchingChecks.length && (required.appId !== null || !matchingStatuses.length)) {
        lower("checking");
        add("github_required_check_missing", required.context);
      }
      for (const check of matchingChecks) {
        if (check.status !== "completed") {
          lower("checking");
          add("github_required_check_pending", required.context);
        } else if (!["success", "neutral", "skipped"].includes(check.conclusion ?? "")) {
          lower("blocked");
          add("github_required_check_failed", required.context);
        } else if (!recent(check.completed_at)) {
          lower("unknown");
          add("github_required_check_stale", required.context);
        }
        if (check.app.slug === "github-actions") {
          const workflow = selectedChecks.workflows.find(
            (run) => run.check_suite_id === check.check_suite?.id,
          );
          if (!workflow) {
            lower("unknown");
            add("github_actions_provenance_unknown", required.context);
          } else if (!allowedEvents.has(workflow.event)) {
            lower("blocked");
            add("github_actions_event_ineligible", required.context);
          }
        }
      }
      // GitHub requires both a status and a check with the same required name.
      for (const status of matchingStatuses) {
        // Commit statuses expose a creator, not the GitHub App identity that
        // produced them. A matching check's App cannot attest a separate status,
        // and creator IDs/logins must never be treated as App IDs.
        if (required.appId !== null) {
          lower("unknown");
          add("github_required_status_source_unknown", required.context);
        }
        if (status.state === "pending") {
          lower("checking");
          add("github_required_status_pending", required.context);
        } else if (status.state !== "success") {
          lower("blocked");
          add("github_required_status_failed", required.context);
        } else if (!recent(status.updated_at)) {
          lower("unknown");
          add("github_required_status_stale", required.context);
        }
      }
    }
    if (protection === "unknown") lower("unknown");
    const approvals = new Set(
      reviews
        .filter(
          (review) =>
            review.state === "APPROVED" &&
            review.authorCanPushToRepository &&
            review.author &&
            review.commit?.oid === initial.head.sha,
        )
        .map((review) => review.author!.login.toLowerCase()),
    ).size;
    let reviewOutcome: Outcome = "passed";
    if (
      graph.reviewDecision === "CHANGES_REQUESTED" ||
      reviews.some(
        (review) => review.authorCanPushToRepository && review.state === "CHANGES_REQUESTED",
      )
    ) {
      reviewOutcome = "blocked";
      add("github_changes_requested");
    }
    if (approvals < minimumApprovals || graph.reviewDecision === "REVIEW_REQUIRED") {
      reviewOutcome = "blocked";
      add("github_approvals_required");
    }
    if ((minimumApprovals > 0 || codeOwnersRequired) && graph.reviewDecision === null) {
      reviewOutcome = "unknown";
      add("github_review_decision_unknown");
    }
    if (config.requirements.requireCodeOwnerReview && !codeOwnersRequired) {
      reviewOutcome = "unknown";
      add("github_code_owner_policy_unverified");
    } else if (codeOwnersRequired && graph.reviewDecision !== "APPROVED") {
      reviewOutcome = "blocked";
      add("github_code_owner_review_required");
    }
    const unresolved = threads.filter((thread) => !thread.isResolved);
    const threadOutcome: Outcome =
      requireResolvedThreads && unresolved.length ? "blocked" : "passed";
    if (threadOutcome === "blocked") add("github_review_threads_unresolved");
    let mergeability: Outcome = "passed";
    if (
      initial.mergeable === null ||
      graph.mergeable === "UNKNOWN" ||
      ["UNKNOWN", "unknown"].includes(graph.mergeStateStatus)
    ) {
      mergeability = "unknown";
      add("github_mergeability_unknown");
    } else if (!initial.mergeable || graph.mergeable === "CONFLICTING") {
      mergeability = "blocked";
      add("github_merge_conflict");
    } else if (strictChecks && graph.mergeStateStatus === "BEHIND") {
      mergeability = "blocked";
      add("github_base_update_required");
    } else if (
      !["CLEAN", "HAS_HOOKS", "BEHIND", "UNSTABLE", "BLOCKED", "DRAFT"].includes(
        graph.mergeStateStatus,
      )
    ) {
      mergeability = "unknown";
      add("github_merge_state_unsupported");
    } else if (["HAS_HOOKS", "BLOCKED"].includes(graph.mergeStateStatus)) {
      mergeability = "blocked";
      add("github_merge_blocked");
    }
    if (initial.draft) add("github_pr_draft");
    const final = await getPr();
    if (
      final.head.sha !== initial.head.sha ||
      final.base.sha !== initial.base.sha ||
      final.updated_at !== initial.updated_at ||
      final.state !== initial.state ||
      final.merged_at !== initial.merged_at ||
      final.draft !== initial.draft ||
      final.mergeable !== initial.mergeable ||
      final.mergeable_state !== initial.mergeable_state
    )
      throw new PrVerificationApiError("github_changed_during_refresh");
    const payload: { [key: string]: Json } = {
      version: 1,
      githubAccess: "available",
      checks,
      reviews: reviewOutcome,
      threads: threadOutcome,
      mergeability,
      protection,
      blockers: [
        ...new Map(blockers.map((blocker) => [JSON.stringify(blocker), blocker])).values(),
      ],
      pr: {
        number: config.prNumber,
        state,
        draft: initial.draft,
        headSha: initial.head.sha,
        baseSha: initial.base.sha,
        updatedAt: initial.updated_at,
      },
      requiredChecks,
      branchRules: {
        minimumApprovals,
        codeOwnersRequired,
        requireResolvedThreads,
        strictChecks,
        unsupportedRules: [...new Set(unsupportedRules)],
      },
      checkEvidence: { selectedSha: selectedChecks.sha, head: headChecks, merge: mergeChecks },
      reviewEvidence: {
        decision: graph.reviewDecision,
        currentHeadApprovals: approvals,
        latestReviews: reviews,
        unresolvedThreads: unresolved,
        mergeStateStatus: graph.mergeStateStatus,
      },
    };
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_PAYLOAD_BYTES)
      throw new PrVerificationApiError("github_pagination_limit");
    return {
      headSha: initial.head.sha,
      baseSha: initial.base.sha,
      state,
      draft: initial.draft,
      updatedAt: initial.updated_at,
      payload,
    };
  } finally {
    clearTimeout(collectionTimer);
    deadline.abort();
  }
}
