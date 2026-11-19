import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod/v4";

import {
  authorizeFactoryCommand,
  factoryCommandTransactionInput,
  releaseFactoryCommandAdmission,
  type FactoryCommandTransactionInput,
} from "@/lib/factory-command-authorization/server";
import { workspaceSessionDetailPath } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

import {
  factoryReadArtifactRecordSchema,
  factoryReadMessageRecordSchema,
  factoryReadRoutes,
  factoryReadRunRecordSchema,
  factoryReadSessionRecordSchema,
  factoryReadSourceRecordSchema,
  type FactoryReadErrorCode,
  type FactoryReadOperation,
} from "./contracts";
import {
  conversationCursorKeySchema,
  decodeFactoryReadCursor,
  encodeFactoryReadCursor,
  runCursorKeySchema,
  sessionCursorKeySchema,
  type FactoryReadCursorScope,
} from "./cursor";
import {
  renderFactoryReadMarkdown,
  safeFactoryReadSourceHref,
  safeFactoryReadText,
} from "./output";

type Admin = Pick<ReturnType<typeof createSupabaseAdminClient>, "rpc">;
type ReadArgs = Database["public"]["Functions"]["read_factory_session_command"]["Args"];
type ReadSelectors = Omit<ReadArgs, keyof FactoryCommandTransactionInput | "p_operation">;
type Scope = Pick<FactoryReadCursorScope, "workspaceId" | "factoryId">;

const headers = { "Cache-Control": "private, no-store" };
const readErrors = {
  invalid_request: { status: 400, error: "Invalid factory read request." },
  invalid_cursor: { status: 400, error: "Invalid factory read cursor." },
  unauthorized: { status: 401, error: "A valid factory credential is required." },
  forbidden: { status: 403, error: "The credential does not authorize this read." },
  not_found: { status: 404, error: "Resource not found." },
  resource_unavailable: { status: 410, error: "The requested resource is unavailable." },
  unavailable: { status: 503, error: "The requested data is unavailable." },
  request_conflict: { status: 409, error: "The request conflicts with an existing admission." },
  already_admitted: { status: 409, error: "The request has already been admitted." },
  rate_limited: { status: 429, error: "The factory command rate limit was reached." },
  concurrency_limited: { status: 429, error: "The factory command concurrency limit was reached." },
} satisfies Record<FactoryReadErrorCode, { status: number; error: string }>;

function readError(code: FactoryReadErrorCode, retryAfterSeconds?: number) {
  const { status, error } = readErrors[code];
  const extraHeaders: Record<string, string> = {};
  if (status === 401) extraHeaders["WWW-Authenticate"] = "Bearer";
  if (retryAfterSeconds !== undefined) extraHeaders["Retry-After"] = String(retryAfterSeconds);
  return Response.json(
    { code, error, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) },
    { status, headers: { ...headers, ...extraHeaders } },
  );
}

function projectReadArgs(operation: FactoryReadOperation, request: Request, rawParams: unknown) {
  const contract = factoryReadRoutes[operation];
  const params = contract.params.safeParse(rawParams);
  if (!params.success) return { ok: false, code: "invalid_request" } as const;

  const search = new URL(request.url).searchParams;
  const queryValues = Object.fromEntries(search);
  if (search.size !== Object.keys(queryValues).length) {
    return { ok: false, code: "invalid_request" } as const;
  }
  const query = contract.query.safeParse(queryValues);
  if (!query.success) {
    const code = query.error.issues.some(({ path }) => path[0] === "cursor")
      ? "invalid_cursor"
      : "invalid_request";
    return { ok: false, code } as const;
  }

  const pathIds: Scope & { sessionId?: string; runId?: string; artifactId?: string } = params.data;
  const filters: z.infer<typeof factoryReadRoutes.runs.query> &
    z.infer<typeof factoryReadRoutes.conversation.query> = query.data;
  const scope = {
    workspaceId: pathIds.workspaceId.toLowerCase(),
    factoryId: pathIds.factoryId.toLowerCase(),
  };
  const sessionId = (pathIds.sessionId ?? filters.sessionId)?.toLowerCase();
  const selectors: ReadSelectors = {
    p_session_id: sessionId,
    p_run_id: pathIds.runId?.toLowerCase(),
    p_artifact_id: pathIds.artifactId?.toLowerCase(),
  };
  let cursorScope: FactoryReadCursorScope | undefined;
  switch (operation) {
    case "sessions":
      cursorScope = { ...scope, kind: operation };
      break;
    case "runs":
      cursorScope = { ...scope, kind: operation, sessionId };
      break;
    case "conversation":
      if (!sessionId) return { ok: false, code: "invalid_request" } as const;
      cursorScope = { ...scope, kind: operation, sessionId };
      selectors.p_conversation_direction = filters.direction ?? "before";
      break;
  }
  if (cursorScope) {
    selectors.p_limit = Number(filters.limit ?? 25);
    if (filters.cursor) {
      const cursor = decodeFactoryReadCursor(filters.cursor, cursorScope);
      if (!cursor) return { ok: false, code: "invalid_cursor" } as const;
      switch (cursor.kind) {
        case "sessions":
          selectors.p_before_session_number = cursor.key.number;
          break;
        case "runs":
          selectors.p_before_created_at = cursor.key.createdAt;
          selectors.p_before_id = cursor.key.id;
          break;
        case "conversation":
          selectors.p_conversation_sequence = cursor.key.sequence;
          break;
      }
    }
  }
  return { ok: true, scope, selectors } as const;
}

const envelopeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    workspaceSlug: z.string().min(1).max(100),
    data: z.unknown(),
  }),
  z.object({ status: z.enum(["not_found", "unavailable"]) }),
]);

const sessionPageSchema = z.object({
  items: z.array(factoryReadSessionRecordSchema).max(50),
  nextCursor: sessionCursorKeySchema.nullable(),
});

const runPageSchema = z.object({
  items: z.array(factoryReadRunRecordSchema).max(50),
  nextCursor: runCursorKeySchema.nullable(),
});

const conversationPageSchema = z.object({
  sessionNumber: z.number().int().positive(),
  items: z.array(factoryReadMessageRecordSchema).max(50),
  sourceLinks: z.array(factoryReadSourceRecordSchema).max(50),
  nextCursor: conversationCursorKeySchema.nullable(),
});

function artifactQuery(stageSlug: string, artifactId: string, version: number) {
  return { artifactStage: stageSlug, artifactId, artifactVersion: version };
}

function sessionProjection(session: z.infer<typeof factoryReadSessionRecordSchema>, slug: string) {
  const { review } = session;
  return {
    ...session,
    title: safeFactoryReadText(session.title),
    canonicalUrl: workspaceSessionDetailPath(slug, session.number),
    review: review
      ? {
          ...review,
          clarification: review.clarification
            ? {
                ...review.clarification,
                question: safeFactoryReadText(review.clarification.question),
              }
            : null,
          href: workspaceSessionDetailPath(slug, session.number, {
            ...artifactQuery(review.stageSlug, review.artifactId, review.artifactVersion),
            reviewRevision: review.reviewRevision,
            clarificationId: review.clarification?.id,
          }),
        }
      : null,
  };
}

function runProjection(run: z.infer<typeof factoryReadRunRecordSchema>, slug: string) {
  return {
    ...run,
    stageName: run.stageName === null ? null : safeFactoryReadText(run.stageName),
    canonicalUrl: `${workspaceSessionDetailPath(slug, run.sessionNumber)}#wallie-run-${run.id}`,
  };
}

function sourceProjection(source: z.infer<typeof factoryReadSourceRecordSchema>) {
  return {
    ...source,
    provider: safeFactoryReadText(source.provider),
    label: source.label === null ? null : safeFactoryReadText(source.label),
    url: safeFactoryReadSourceHref(source.url),
  };
}

function projectReadResult(
  operation: FactoryReadOperation,
  data: unknown,
  workspaceSlug: string,
  scope: Scope,
  selectors: ReadSelectors,
) {
  const slug = encodeURIComponent(workspaceSlug);
  const cursorBase = { ...scope, version: 1 } as const;
  switch (operation) {
    case "session":
      return sessionProjection(factoryReadSessionRecordSchema.parse(data), slug);
    case "sessions": {
      const { items, nextCursor } = sessionPageSchema.parse(data);
      return {
        items: items.map((session) => sessionProjection(session, slug)),
        nextCursor: nextCursor
          ? encodeFactoryReadCursor({ ...cursorBase, kind: operation, key: nextCursor })
          : null,
      };
    }
    case "run":
      return runProjection(factoryReadRunRecordSchema.parse(data), slug);
    case "runs": {
      const { items, nextCursor } = runPageSchema.parse(data);
      return {
        items: items.map((run) => runProjection(run, slug)),
        nextCursor: nextCursor
          ? encodeFactoryReadCursor({
              ...cursorBase,
              kind: operation,
              sessionId: selectors.p_session_id,
              key: nextCursor,
            })
          : null,
      };
    }
    case "conversation": {
      const { items, nextCursor, sessionNumber, sourceLinks } = conversationPageSchema.parse(data);
      const sessionId = selectors.p_session_id;
      if (!sessionId) throw new Error("Conversation requires a session.");
      const encodeCursor = (key: z.infer<typeof conversationCursorKeySchema>) =>
        encodeFactoryReadCursor({ ...cursorBase, kind: operation, sessionId, key });
      const sequence = items.length
        ? Math.max(...items.map((item) => item.sequence))
        : selectors.p_conversation_direction === "after"
          ? (selectors.p_conversation_sequence ?? 0)
          : 0;
      return {
        canonicalUrl: workspaceSessionDetailPath(slug, sessionNumber),
        items: items.map(({ bodyMarkdown, source, authorLabel, ...message }) => ({
          ...message,
          authorLabel: safeFactoryReadText(authorLabel),
          bodyHtml: renderFactoryReadMarkdown(bodyMarkdown),
          source: source === null ? null : sourceProjection(source),
        })),
        sources: sourceLinks.map(sourceProjection),
        nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
        resumeCursor: encodeCursor({ sequence }),
      };
    }
    case "artifact": {
      const { bodyMarkdown, ...artifact } = factoryReadArtifactRecordSchema.parse(data);
      return {
        ...artifact,
        canonicalUrl: workspaceSessionDetailPath(slug, artifact.sessionNumber),
        href: workspaceSessionDetailPath(
          slug,
          artifact.sessionNumber,
          artifactQuery(artifact.stageSlug, artifact.id, artifact.version),
        ),
        bodyHtml: renderFactoryReadMarkdown(bodyMarkdown),
      };
    }
  }
}

function readRpcFailure(code: string) {
  switch (code) {
    case "42501":
    case "P0010":
    case "P0011":
      return readError("unauthorized");
    case "PT403":
      return readError("forbidden");
    case "PT409":
      return readError("request_conflict");
    default:
      return readError("unavailable");
  }
}

export async function handleFactoryRead(
  operation: FactoryReadOperation,
  request: Request,
  rawParams: unknown,
  admin?: Admin,
) {
  const parsed = projectReadArgs(operation, request, rawParams);
  if (!parsed.ok) return readError(parsed.code);

  const { scope, selectors } = parsed;
  const requestHash = createHash("sha256")
    .update(JSON.stringify(["factory-read/v1", operation, scope, selectors]))
    .digest("hex");
  const authorized = await authorizeFactoryCommand(
    {
      authorization: request.headers.get("Authorization"),
      ...scope,
      scope: "sessions:read",
      surface: "api",
      requestHash,
    },
    admin,
  );
  if (!authorized.ok) {
    return readError(
      authorized.code,
      "retryAfterSeconds" in authorized ? authorized.retryAfterSeconds : undefined,
    );
  }

  const { admission } = authorized;
  let client = admin;
  try {
    client ??= createSupabaseAdminClient();
    const { p_scope: admittedScope, ...transaction } = factoryCommandTransactionInput(admission);
    if (admittedScope !== "sessions:read") return readError("forbidden");
    const { data, error } = await client
      .rpc("read_factory_session_command", {
        ...transaction,
        ...selectors,
        p_operation: operation,
      })
      .abortSignal(request.signal);
    if (error) return readRpcFailure(error.code);

    const result = envelopeSchema.parse(data);
    if (result.status !== "ok") {
      return readError(result.status === "unavailable" ? "resource_unavailable" : result.status);
    }
    const response = projectReadResult(
      operation,
      result.data,
      result.workspaceSlug,
      scope,
      selectors,
    );
    return Response.json(factoryReadRoutes[operation].response.parse(response), { headers });
  } catch {
    return readError("unavailable");
  } finally {
    await releaseFactoryCommandAdmission(admission, client);
  }
}
