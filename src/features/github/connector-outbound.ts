import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { buildAppUrl } from "@/lib/app-url";
import type { ConnectorOutboundAdapter } from "@/lib/connectors/outbound";
import { workspaceSessionDetailPath } from "@/lib/routes";
import { exactSessionReviewHref } from "@/lib/sessions/review-link";
import type { Database } from "@/lib/supabase/database.types";

import { resolveGitHubAppConfig } from "./config";

type Admin = Pick<SupabaseClient<Database>, "rpc">;
type Target = Parameters<ConnectorOutboundAdapter["send"]>[0];
type PreparationMode = "send" | "observe";

const apiOrigin = "https://api.github.com";
const apiVersion = "2026-03-10";
const commentsPerPage = 30;
const maxCommentPages = 5;
const positiveId = z.number().int().positive().safe();
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const fullName = z
  .string()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u)
  .refine((name) => !name.endsWith("/.") && !name.endsWith("/.."));
const sourceIdentity = z.object({
  github_installation_id: positiveId,
  github_repository_id: positiveId,
  repository_full_name: fullName,
  source_kind: z.enum(["issue", "pull_request"]),
  source_number: positiveId,
  source_id: positiveId,
});
const payloadFields = z.object({
  sessionId: z.uuid(),
  workspaceSlug: slug,
  sessionNumber: positiveId,
  body: z.string().trim().min(1).max(4_000),
});
const payload = z.discriminatedUnion("kind", [
  payloadFields.strict().extend({ kind: z.literal("progress") }),
  payloadFields.strict().extend({ kind: z.literal("outcome") }),
  payloadFields.strict().extend({
    kind: z.literal("review_ready"),
    reviewTarget: z.strictObject({
      stageId: z.uuid(),
      stageSlug: slug.max(100),
      artifactId: z.uuid(),
      artifactVersion: positiveId.max(2_147_483_647),
      reviewRevision: z.number().int().nonnegative().safe(),
      clarificationId: z.null(),
    }),
  }),
]);
const permissions = z.object({
  issues: z.string().optional(),
  pull_requests: z.string().optional(),
});
const installation = z.object({
  id: positiveId,
  app_id: positiveId,
  app_slug: slug,
  suspended_at: z.string().nullable(),
  permissions,
});
const token = z.object({
  token: z.string().min(1),
  permissions: z.record(z.string(), z.string()),
});
const repository = z.object({ id: positiveId, full_name: fullName, archived: z.boolean() });
const issue = z.object({ id: positiveId, number: positiveId, pull_request: z.never().optional() });
const pullRequest = z.object({
  id: positiveId,
  number: positiveId,
  base: z.object({ repo: z.object({ id: positiveId }) }),
});
const botIdentity = z.object({ id: positiveId, login: z.string(), type: z.literal("Bot") });
const comment = z.object({
  id: positiveId,
  body: z.string().nullable(),
  issue_url: z.string(),
  user: z.object({ id: positiveId, login: z.string(), type: z.string() }).nullable(),
  performed_via_github_app: z.object({ id: positiveId }).nullish(),
});
const commentList = z.array(comment).max(commentsPerPage);

class ConnectorScopeUnavailable extends Error {}

class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers,
  ) {
    super("GitHub could not complete a connector request.");
  }
}

function providerError(error: unknown) {
  if (error instanceof GitHubHttpError) return error;
  const failure = z
    .object({
      status: z.number(),
      response: z
        .object({ headers: z.record(z.string(), z.union([z.string(), z.number()])) })
        .optional(),
    })
    .safeParse(error);
  if (!failure.success) return null;
  const headers = new Headers();
  for (const name of ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
    const value = failure.data.response?.headers[name];
    if (value !== undefined) headers.set(name, String(value));
  }
  return new GitHubHttpError(failure.data.status, headers);
}

function rateLimit(error: GitHubHttpError | null) {
  if (!error) return null;
  const retryAfter = error.headers.get("retry-after");
  const exhausted = error.headers.get("x-ratelimit-remaining") === "0";
  if (error.status !== 429 && !(error.status === 403 && (retryAfter !== null || exhausted)))
    return null;
  const reset = error.headers.get("x-ratelimit-reset");
  const seconds =
    retryAfter && /^\d+$/u.test(retryAfter)
      ? Number(retryAfter)
      : exhausted && reset && /^\d+$/u.test(reset)
        ? Math.ceil(Number(reset) - Date.now() / 1_000)
        : 60;
  return {
    kind: "rate_limited" as const,
    retryAfterSeconds: Math.max(1, Math.min(3_600, seconds)),
  };
}

function commentMarker(deliveryId: string) {
  return `<!-- wallie-connector-delivery:${deliveryId} -->`;
}

function replyBody(target: Target) {
  const parsed = payload.safeParse(target.message.content);
  if (!parsed.success) return null;
  const message = parsed.data;
  const href =
    message.kind === "review_ready"
      ? exactSessionReviewHref(message.workspaceSlug, message.sessionNumber, message.reviewTarget)
      : workspaceSessionDetailPath(message.workspaceSlug, message.sessionNumber);
  const url = buildAppUrl(href);
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const label = message.kind === "review_ready" ? "Review in Wallie" : "Open in Wallie";
  return `${message.body}\n\n[${label}](${url.href})\n\n${commentMarker(target.correlationId)}`;
}

function createGitHubRequest(fetcher: typeof fetch, accessToken: string, signal: AbortSignal) {
  return async (path: string, method = "GET", body?: string) => {
    signal.throwIfAborted();
    const response = await fetcher(`${apiOrigin}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "user-agent": "wallie-connector-outbound",
        "x-github-api-version": apiVersion,
      },
      cache: "no-store",
      redirect: "manual",
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify({ body }) }),
    });
    if (!response.ok) throw new GitHubHttpError(response.status, response.headers);
    const data: unknown = await response.json();
    return { data, headers: response.headers };
  };
}

export function createGitHubConnectorOutboundAdapter(
  admin: Admin,
  fetcher: typeof fetch = fetch,
): ConnectorOutboundAdapter {
  async function readScope(target: Target, signal: AbortSignal) {
    const { data, error } = await admin
      .rpc("resolve_github_connector_delivery", {
        p_delivery_id: target.correlationId,
        p_lease_id: target.leaseId,
      })
      .abortSignal(signal);
    if (error) throw error;
    const [source] = z.union([z.tuple([]), z.tuple([sourceIdentity])]).parse(data);
    if (
      !source ||
      String(source.github_repository_id) !== target.externalResourceId ||
      `${source.source_kind}:${source.source_id}` !== target.externalThreadId
    ) {
      throw new ConnectorScopeUnavailable();
    }
    return source;
  }

  async function prepare(target: Target, mode: PreparationMode, signal: AbortSignal) {
    const source = await readScope(target, signal);
    let config: ReturnType<typeof resolveGitHubAppConfig>;
    try {
      config = resolveGitHubAppConfig();
    } catch {
      throw new ConnectorScopeUnavailable();
    }
    signal.throwIfAborted();
    const { App } = await import("@octokit/app");
    const app = new App(config);
    const request = { signal, redirect: "manual" as const };
    const headers = { "x-github-api-version": apiVersion };
    const response = await app.octokit.request("GET /app/installations/{installation_id}", {
      installation_id: source.github_installation_id,
      request,
      headers,
    });
    const active = installation.parse(response.data);
    const permission = source.source_kind === "pull_request" ? "pull_requests" : "issues";
    const required = mode === "send" ? "write" : "read";
    if (
      active.id !== source.github_installation_id ||
      active.app_id !== config.appId ||
      active.suspended_at !== null ||
      (active.permissions[permission] !== "write" && active.permissions[permission] !== required)
    ) {
      throw new ConnectorScopeUnavailable();
    }
    const minted = await app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: active.id,
        repository_ids: [source.github_repository_id],
        permissions: { [permission]: required },
        request,
        headers,
      },
    );
    const scoped = token.parse(minted.data);
    if (
      scoped.permissions[permission] !== required ||
      Object.entries(scoped.permissions).some(
        ([name, value]) => name !== permission && (name !== "metadata" || value !== "read"),
      )
    )
      throw new ConnectorScopeUnavailable();

    const github = createGitHubRequest(fetcher, scoped.token, signal);
    const repositoryPath = `/repos/${source.repository_full_name}`;
    const repo = repository.parse((await github(repositoryPath)).data);
    if (
      repo.id !== source.github_repository_id ||
      repo.archived ||
      repo.full_name.toLowerCase() !== source.repository_full_name.toLowerCase()
    ) {
      throw new ConnectorScopeUnavailable();
    }
    const issuePath = `${repositoryPath}/issues/${source.source_number}`;
    const threadPath =
      source.source_kind === "issue"
        ? issuePath
        : `${repositoryPath}/pulls/${source.source_number}`;
    const threadResponse = (await github(threadPath)).data;
    const thread =
      source.source_kind === "issue"
        ? issue.parse(threadResponse)
        : pullRequest.parse(threadResponse);
    if (
      thread.id !== source.source_id ||
      thread.number !== source.source_number ||
      ("base" in thread && thread.base.repo.id !== source.github_repository_id)
    ) {
      throw new ConnectorScopeUnavailable();
    }
    const login = `${active.app_slug}[bot]`;
    const bot = botIdentity.parse((await github(`/users/${encodeURIComponent(login)}`)).data);
    if (bot.login !== login) throw new ConnectorScopeUnavailable();
    return {
      github,
      async assertCurrent() {
        const current = await readScope(target, signal);
        if (
          current.github_installation_id !== source.github_installation_id ||
          current.repository_full_name !== source.repository_full_name ||
          current.source_number !== source.source_number
        )
          throw new ConnectorScopeUnavailable();
      },
      threadComments: `${issuePath}/comments`,
      commentPath: (replyId: number) => `${repositoryPath}/issues/comments/${replyId}`,
      matchesAuthorAndThread: (reply: z.infer<typeof comment>) =>
        reply.issue_url.toLowerCase() === `${apiOrigin}${issuePath}`.toLowerCase() &&
        reply.user?.type === "Bot" &&
        reply.user.id === bot.id &&
        reply.user.login === bot.login &&
        (!reply.performed_via_github_app || reply.performed_via_github_app.id === active.app_id),
    };
  }

  return {
    provider: "github",
    async send(target, signal) {
      let writeStarted = false;
      try {
        const body = replyBody(target);
        if (!body) return { kind: "rejected" };
        const scope = await prepare(target, "send", signal);
        let path = scope.threadComments;
        const operation = target.message.operation;
        let replyId: number | undefined;
        if (operation === "edit") {
          const providerReplyId = target.message.providerReplyId;
          const numeric = positiveId.safeParse(Number(providerReplyId));
          if (!numeric.success || String(numeric.data) !== providerReplyId)
            return { kind: "rejected" };
          replyId = numeric.data;
          path = scope.commentPath(replyId);
          const reply = comment.parse((await scope.github(path)).data);
          if (reply.id !== replyId || !scope.matchesAuthorAndThread(reply))
            return { kind: "rejected" };
        }
        await scope.assertCurrent();
        signal.throwIfAborted();
        writeStarted = true;
        const reply = comment.parse(
          (await scope.github(path, operation === "edit" ? "PATCH" : "POST", body)).data,
        );
        if (
          (replyId !== undefined && reply.id !== replyId) ||
          !scope.matchesAuthorAndThread(reply) ||
          !reply.body?.endsWith(`\n\n${commentMarker(target.correlationId)}`)
        )
          return { kind: "uncertain" };
        return { kind: "sent", providerReplyId: String(reply.id) };
      } catch (error) {
        const failure = providerError(error);
        const throttled = rateLimit(failure);
        if (throttled) return throttled;
        if (
          error instanceof ConnectorScopeUnavailable ||
          (failure && [401, 403, 404].includes(failure.status))
        ) {
          return { kind: "credential_unavailable" };
        }
        if (writeStarted && failure && [400, 410, 422].includes(failure.status))
          return { kind: "rejected" };
        return { kind: writeStarted ? "uncertain" : "not_sent" };
      }
    },
    async observe(target, signal) {
      try {
        const scope = await prepare(target, "observe", signal);
        const marker = `\n\n${commentMarker(target.correlationId)}`;
        const matches = (reply: z.infer<typeof comment>) =>
          scope.matchesAuthorAndThread(reply) && reply.body?.endsWith(marker);
        if (target.message.operation === "edit") {
          const providerReplyId = target.message.providerReplyId;
          const numeric = positiveId.safeParse(Number(providerReplyId));
          if (!numeric.success || String(numeric.data) !== providerReplyId)
            return { kind: "inconclusive" };
          const reply = comment.parse((await scope.github(scope.commentPath(numeric.data))).data);
          return reply.id === numeric.data && matches(reply)
            ? { kind: "found", providerReplyId }
            : { kind: "inconclusive" };
        }

        for (let page = 1; page <= maxCommentPages; page++) {
          const response = await scope.github(
            `${scope.threadComments}?per_page=${commentsPerPage}&page=${page}`,
          );
          const replies = commentList.parse(response.data);
          const reply = replies.find(matches);
          if (reply) return { kind: "found", providerReplyId: String(reply.id) };
          if (!response.headers.get("link")?.includes('rel="next"')) break;
        }
        // A missing comment is not proof that GitHub never accepted the write.
        return { kind: "inconclusive" };
      } catch (error) {
        const failure = providerError(error);
        const throttled = rateLimit(failure);
        if (throttled) return throttled;
        if (
          error instanceof ConnectorScopeUnavailable ||
          (failure && [401, 403].includes(failure.status))
        ) {
          return { kind: "credential_unavailable" };
        }
        return { kind: "inconclusive" };
      }
    },
  };
}
