import "server-only";

import { createHash } from "node:crypto";
import type { z } from "zod/v4";

import {
  authorizeFactoryCommand,
  factoryCommandTransactionInput,
  releaseFactoryCommandAdmission,
  type FactoryCommandTransport,
} from "@/lib/factory-command-authorization/server";
import { factoryReadRoutes } from "@/lib/factory-read-api/contracts";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { workspaceSessionDetailPath } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { wakeWorker } from "@/lib/worker/wake";

import {
  factoryMutationReceiptSchema,
  factoryMutationErrorCodeSchema,
  factoryMutationKeySchema,
  factoryMutationResponseSchema,
  factoryMutationRoutes,
  type FactoryMutationOperation,
} from "./contracts";

type Admin = ReturnType<typeof createSupabaseAdminClient>;
type ErrorCode = z.infer<typeof factoryMutationErrorCodeSchema>;
type Receipt = z.infer<typeof factoryMutationReceiptSchema>;

const headers = { "Cache-Control": "private, no-store" };
const maxBodyBytes = 256 * 1024;

const errors = {
  invalid_request: { status: 400, error: "Invalid factory mutation request." },
  unauthorized: { status: 401, error: "A valid factory credential is required." },
  forbidden: { status: 403, error: "The credential does not authorize this mutation." },
  not_found: { status: 404, error: "Resource not found." },
  stale_intent: {
    status: 409,
    error: "The session state changed. Refresh the session before retrying.",
  },
  idempotency_conflict: {
    status: 409,
    error: "This idempotency key identifies a different request.",
  },
  clarification_required: {
    status: 409,
    error: "Answer the pending clarification before sending a follow-up.",
  },
  request_conflict: { status: 409, error: "The request conflicts with an existing admission." },
  already_admitted: { status: 409, error: "The request has already been admitted." },
  request_too_large: { status: 413, error: "The JSON request exceeds the supported size." },
  unsupported_media_type: { status: 415, error: "Send the request as application/json." },
  unready: {
    status: 422,
    error: "The selected factory or agent configuration cannot start this session.",
  },
  rate_limited: { status: 429, error: "The factory command rate limit was reached." },
  concurrency_limited: { status: 429, error: "The factory command concurrency limit was reached." },
  unavailable: { status: 503, error: "The session mutation service is temporarily unavailable." },
} satisfies Record<ErrorCode, { status: number; error: string }>;

function mutationError(code: ErrorCode, retryAfterSeconds?: number) {
  const { status, error } = errors[code];
  const responseHeaders = new Headers(headers);
  if (status === 401) responseHeaders.set("WWW-Authenticate", "Bearer");
  if (retryAfterSeconds !== undefined) {
    responseHeaders.set("Retry-After", String(retryAfterSeconds));
  }
  return Response.json(
    { code, error, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) },
    { status, headers: responseHeaders },
  );
}

function mutationRpcFailure(code: string) {
  switch (code) {
    case "42501":
    case "P0010":
    case "P0011":
      return mutationError("unauthorized");
    case "PT403":
      return mutationError("forbidden");
    case "P0002":
    case "PT404":
      return mutationError("not_found");
    case "P0003":
    case "40001":
    case "PT412":
      return mutationError("stale_intent");
    case "P0005":
      return mutationError("idempotency_conflict");
    case "PT409":
      return mutationError("request_conflict");
    case "PT423":
      return mutationError("clarification_required");
    case "PT422":
      return mutationError("unready");
    case "22023":
    case "22001":
      return mutationError("invalid_request");
    default:
      return mutationError("unavailable");
  }
}

type ScopeIds = {
  workspaceId: string;
  factoryId: string;
  sessionId?: string;
  clarificationId?: string;
};

function commandPayload(
  body: z.infer<(typeof factoryMutationRoutes)[FactoryMutationOperation]["body"]>,
  ids: ScopeIds,
) {
  if ("agentId" in body) {
    return {
      ...body,
      agentId: body.agentId.toLowerCase(),
      repositoryId: body.repositoryId.toLowerCase(),
    };
  }
  const sessionId = ids.sessionId?.toLowerCase();
  if ("expectedRunId" in body) {
    return { sessionId, expectedRunId: body.expectedRunId.toLowerCase() };
  }
  const exact = { ...body, sessionId, artifactId: body.artifactId.toLowerCase() };
  if ("stageId" in body) return { ...exact, stageId: body.stageId.toLowerCase() };
  return { ...exact, clarificationId: ids.clarificationId?.toLowerCase() };
}

async function reconcileCommittedMutation(
  admin: Admin,
  operation: FactoryMutationOperation,
  workspaceId: string,
  receipt: Receipt,
) {
  // The transaction has committed. A lost response can retry the same exact
  // post-commit work without rerunning the mutation or touching a newer run.
  if (operation === "cancel" && receipt.jobIds && receipt.runIds) {
    const { cleanupSessionWorkReceipt } = await import("@/lib/pipeline/cancel");
    await cleanupSessionWorkReceipt(admin, {
      workspaceId,
      receipt: { job_ids: receipt.jobIds, run_ids: receipt.runIds },
    });
  } else if (receipt.jobId) {
    await wakeWorker();
  }
}

export async function handleFactoryMutation(
  operation: FactoryMutationOperation,
  request: Request,
  rawParams: unknown,
  admin?: Admin,
) {
  if (new URL(request.url).search) return mutationError("invalid_request");
  return executeFactoryMutation(
    operation,
    rawParams,
    request.headers.get("Idempotency-Key"),
    () => readBoundedJsonBody(request, maxBodyBytes),
    { surface: "api", authorization: request.headers.get("Authorization"), signal: request.signal },
    admin,
  );
}

export async function executeFactoryMutation(
  operation: FactoryMutationOperation,
  rawParams: unknown,
  rawKey: unknown,
  readBody: () => ReturnType<typeof readBoundedJsonBody>,
  transport: FactoryCommandTransport,
  admin?: Admin,
) {
  const contract = factoryMutationRoutes[operation];
  const params = contract.params.safeParse(rawParams);
  const key = factoryMutationKeySchema.safeParse(rawKey);
  if (!params.success || !key.success) return mutationError("invalid_request");
  if (!transport.authorization) return mutationError("unauthorized");

  const raw = await readBody();
  if (!raw.ok) return mutationError(raw.code);
  const body = contract.body.safeParse(raw.body);
  if (!body.success) return mutationError("invalid_request");

  const ids: ScopeIds = params.data;
  const workspaceId = ids.workspaceId.toLowerCase();
  const factoryId = ids.factoryId.toLowerCase();
  const requestKey = key.data.toLowerCase();
  const payload = commandPayload(body.data, ids);
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify([
        "factory-mutation/v1",
        workspaceId,
        factoryId,
        operation,
        requestKey,
        payload,
      ]),
    )
    .digest("hex");

  const decision = await authorizeFactoryCommand(
    { ...transport, workspaceId, factoryId, scope: contract.scope, requestHash },
    admin,
  );
  if (!decision.ok) {
    return mutationError(
      decision.code,
      "retryAfterSeconds" in decision ? decision.retryAfterSeconds : undefined,
    );
  }

  const { admission } = decision;
  let client = admin;
  let receipt: Receipt;
  try {
    client ??= createSupabaseAdminClient();
    const { p_scope: admittedScope, ...transaction } = factoryCommandTransactionInput(admission);
    if (admittedScope !== contract.scope) return mutationError("forbidden");
    const { data, error } = await client
      .rpc("execute_factory_session_mutation", {
        ...transaction,
        p_operation: operation,
        p_request_key: requestKey,
        p_payload: payload,
      })
      .abortSignal(transport.signal);
    if (error) return mutationRpcFailure(error.code);
    const parsed = factoryMutationReceiptSchema.safeParse(data);
    if (!parsed.success) return mutationError("unavailable");
    receipt = parsed.data;
    const expectedRunId = "expectedRunId" in payload ? payload.expectedRunId : undefined;
    if (
      (ids.sessionId && receipt.sessionId !== ids.sessionId.toLowerCase()) ||
      (expectedRunId && (!receipt.jobIds || !receipt.runIds?.includes(expectedRunId))) ||
      (ids.clarificationId && receipt.clarificationId !== ids.clarificationId.toLowerCase())
    ) {
      return mutationError("unavailable");
    }
  } catch {
    return mutationError("unavailable");
  } finally {
    await releaseFactoryCommandAdmission(admission, client);
  }

  try {
    await reconcileCommittedMutation(client, operation, workspaceId, receipt);
  } catch {
    // Scheduled worker/reaper recovery can service the committed receipt.
  }

  const canonicalUrl = workspaceSessionDetailPath(
    encodeURIComponent(receipt.workspaceSlug),
    receipt.sessionNumber,
  );
  const conversationUrl = factoryReadRoutes.conversation.path
    .replace("{workspaceId}", workspaceId)
    .replace("{factoryId}", factoryId)
    .replace("{sessionId}", receipt.sessionId);
  const response = factoryMutationResponseSchema.parse({
    ...receipt,
    canonicalUrl,
    conversationUrl,
  });
  return Response.json(response, {
    status: operation === "create" && !receipt.replayed ? 201 : 200,
    headers,
  });
}
