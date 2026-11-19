import "server-only";

import {
  fromJsonSchema,
  requireScopes,
  type CallToolResult,
  type McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import type { FactoryCommandTransport } from "@/lib/factory-command-authorization/server";
import {
  factoryReadErrorSchema,
  factoryReadRoutes,
  type FactoryReadOperation,
} from "@/lib/factory-read-api/contracts";
import { executeFactoryRead } from "@/lib/factory-read-api/server";
import {
  factoryMutationErrorSchema,
  factoryMutationKeySchema,
  factoryMutationRoutes,
  type FactoryMutationOperation,
} from "@/lib/factory-session-mutations/contracts";
import { executeFactoryMutation } from "@/lib/factory-session-mutations/server";
import type { Enums } from "@/lib/supabase/database.types";

import type { FactoryMcpToolContext } from "./server";

const readScope = "sessions:read";
const scopeKeys = { workspaceId: true, factoryId: true } as const;

const reads = {
  sessions: {
    name: "wallie_list_sessions",
    description: "List sessions in the attached factory. Use nextCursor to page through results.",
  },
  session: {
    name: "wallie_get_session",
    description: "Read a session, its current run, and the exact review or clarification link.",
  },
  runs: {
    name: "wallie_list_runs",
    description:
      "List execution attempts in the factory. Filter by sessionId or page with nextCursor.",
  },
  run: {
    name: "wallie_get_run",
    description: "Read one execution attempt and its exact status and provenance.",
  },
  artifact: {
    name: "wallie_get_artifact",
    description:
      "Read an exact artifact by session and artifact ID, with verified producing attempt.",
  },
  conversation: {
    name: "wallie_read_conversation",
    description:
      "Read the shared conversation. Pass resumeCursor as cursor with direction after to reconnect.",
  },
} satisfies Record<FactoryReadOperation, { name: string; description: string }>;

const writes = {
  create: {
    name: "wallie_create_session",
    description:
      "Create one session or replay its receipt. Keep the same idempotencyKey when retrying the same intent.",
  },
  follow_up: {
    name: "wallie_send_follow_up",
    description:
      "Send feedback on an exact artifact and queue one successor. Reuse the idempotencyKey on retry.",
  },
  answer_clarification: {
    name: "wallie_answer_clarification",
    description:
      "Answer the exact pending specification question with one durable receipt. Reuse the idempotencyKey on retry.",
  },
  cancel: {
    name: "wallie_cancel_session",
    description:
      "Cancel the exact expected active run. Reuse the idempotencyKey when retrying the same intent.",
  },
} satisfies Record<FactoryMutationOperation, { name: string; description: string }>;

type Fields = Record<string, unknown>;
type CommandScope = Enums<"factory_command_scope">;

function fieldsFor(shape: z.ZodRawShape, data: Fields) {
  return Object.fromEntries(
    Object.keys(shape)
      .filter((key) => Object.hasOwn(data, key))
      .map((key) => [key, data[key]]),
  );
}

function success(output: Fields): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
}

function failure(payload: {
  code: string;
  error: string;
  retryAfterSeconds?: number;
}): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: { ...payload },
  };
}

const recordSchema = z.record(z.string(), z.unknown());
const factoryToolError = z.union([factoryReadErrorSchema, factoryMutationErrorSchema]);

function absoluteLink(value: unknown, origin: string) {
  return typeof value === "string" && (value.startsWith("/w/") || value.startsWith("/api/v1/"))
    ? new URL(value, origin).href
    : value;
}

function absoluteRecord(body: Fields, origin: string): Fields {
  const output = { ...body };
  for (const field of ["canonicalUrl", "conversationUrl", "href"]) {
    if (Object.hasOwn(output, field)) output[field] = absoluteLink(output[field], origin);
  }
  const review = recordSchema.safeParse(output.review);
  if (review.success)
    output.review = { ...review.data, href: absoluteLink(review.data.href, origin) };
  return output;
}

function toolLinks(body: Fields, origin: string) {
  const output = absoluteRecord(body, origin);
  if (Array.isArray(output.items)) {
    output.items = output.items.map((item: unknown) => {
      const row = recordSchema.safeParse(item);
      return row.success ? absoluteRecord(row.data, origin) : item;
    });
  }
  return output;
}

async function factoryToolResponse(
  response: Response,
  scope: CommandScope,
  context: FactoryMcpToolContext,
) {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const data = factoryToolError.safeParse(body);
    const payload = data.success
      ? data.data
      : { code: "unavailable", error: "The factory command is unavailable." };
    if (response.status === 401) {
      context.reportHttpFailure({ status: 401, scope, code: "unauthorized" });
    } else if (response.status === 403) {
      context.reportHttpFailure({ status: 403, scope, code: "forbidden" });
    } else if (
      response.status === 429 &&
      data.success &&
      (data.data.code === "rate_limited" || data.data.code === "concurrency_limited") &&
      data.data.retryAfterSeconds !== undefined
    ) {
      context.reportHttpFailure({
        status: 429,
        scope,
        code: data.data.code,
        retryAfterSeconds: data.data.retryAfterSeconds,
      });
    }
    return { ok: false, result: failure(payload) } as const;
  }

  const result = recordSchema.safeParse(body);
  if (!result.success) {
    return {
      ok: false,
      result: failure({ code: "unavailable", error: "The factory command is unavailable." }),
    } as const;
  }
  return { ok: true, body: result.data } as const;
}

function register(
  server: McpServer,
  tool: { name: string; description: string },
  schema: z.ZodObject,
  scope: CommandScope,
  semantics: { readOnly: boolean; destructive?: boolean },
  run: (input: Fields) => Promise<CallToolResult>,
) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: fromJsonSchema<Fields>(
        z.toJSONSchema(schema, { io: "input" }) as Parameters<typeof fromJsonSchema>[0],
      ),
      scopeChallenge: requireScopes(scope),
      annotations: {
        readOnlyHint: semantics.readOnly,
        destructiveHint: semantics.destructive ?? false,
        idempotentHint: true,
        openWorldHint: !semantics.readOnly,
      },
      _meta: { "wallie.dev/requiredScope": scope },
    },
    run,
  );
}

const handoffTarget = factoryReadRoutes.session.params.omit(scopeKeys);
const handoffInput = handoffTarget.extend({
  expectedReview: factoryReadRoutes.session.response.shape.review
    .unwrap()
    .pick({
      stageId: true,
      artifactId: true,
      artifactVersion: true,
      reviewRevision: true,
    })
    .strict()
    .optional(),
});

export function registerFactoryMcpTools(server: McpServer, context: FactoryMcpToolContext) {
  const { workspaceId, factoryId, authorization, resource, signal } = context;
  const factory = { workspaceId, factoryId };
  const origin = new URL(resource).origin;
  const transport: FactoryCommandTransport = { surface: "mcp", authorization, resource, signal };

  for (const operation of Object.keys(reads) as FactoryReadOperation[]) {
    const contract = factoryReadRoutes[operation];
    const paramsSchema: z.ZodObject = contract.params;
    const params = paramsSchema.omit(scopeKeys);
    const input = params.extend(contract.query.shape);
    register(server, reads[operation], input, readScope, { readOnly: true }, async (args) => {
      const response = await executeFactoryRead(
        operation,
        { ...factory, ...fieldsFor(params.shape, args) },
        fieldsFor(contract.query.shape, args),
        transport,
      );
      const result = await factoryToolResponse(response, readScope, context);
      return result.ok ? success(toolLinks(result.body, origin)) : result.result;
    });
  }

  for (const operation of Object.keys(writes) as FactoryMutationOperation[]) {
    const contract = factoryMutationRoutes[operation];
    const paramsSchema: z.ZodObject = contract.params;
    const params = paramsSchema.omit(scopeKeys);
    const input = params
      .extend(contract.body.shape)
      .extend({ idempotencyKey: factoryMutationKeySchema });
    register(
      server,
      writes[operation],
      input,
      contract.scope,
      { readOnly: false, destructive: operation === "cancel" },
      async (args) => {
        const response = await executeFactoryMutation(
          operation,
          { ...factory, ...fieldsFor(params.shape, args) },
          args.idempotencyKey,
          async () => ({ ok: true, body: fieldsFor(contract.body.shape, args) }),
          transport,
        );
        const result = await factoryToolResponse(response, contract.scope, context);
        return result.ok ? success(toolLinks(result.body, origin)) : result.result;
      },
    );
  }

  register(
    server,
    {
      name: "wallie_review_handoff",
      description:
        "When asked to approve a gate, return the exact signed-in Workbench link for human action. Pass expectedReview if acting on a previously seen artifact.",
    },
    handoffInput,
    readScope,
    { readOnly: true },
    async (args) => {
      const request = handoffInput.safeParse(args);
      if (!request.success)
        return failure({ code: "invalid_request", error: "Provide an exact review target." });
      const { sessionId, expectedReview } = request.data;
      const response = await executeFactoryRead(
        "session",
        { ...factory, sessionId },
        {},
        transport,
      );
      const result = await factoryToolResponse(response, readScope, context);
      if (!result.ok) return result.result;
      const session = factoryReadRoutes.session.response.parse(result.body);
      const review = session.review;
      if (!review)
        return failure({
          code: "review_unavailable",
          error: "This session has no pending human decision.",
        });
      if (
        expectedReview &&
        (expectedReview.stageId.toLowerCase() !== review.stageId ||
          expectedReview.artifactId.toLowerCase() !== review.artifactId ||
          expectedReview.artifactVersion !== review.artifactVersion ||
          expectedReview.reviewRevision !== review.reviewRevision)
      ) {
        return failure({
          code: "stale_intent",
          error: "The review changed. Read the session again for its exact current link.",
        });
      }
      return success({
        code: "human_action_required",
        action: review.clarification ? "answer_clarification" : "review",
        sessionId: session.id,
        review: { ...review, href: new URL(review.href, origin).href },
      });
    },
  );
}
