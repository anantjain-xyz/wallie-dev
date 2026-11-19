import "server-only";

import { createHash } from "node:crypto";
import type { z } from "zod/v4";

import {
  authorizeFactoryCommand,
  factoryCommandTransactionInput,
  releaseFactoryCommandAdmission,
} from "@/lib/factory-command-authorization/server";
import { factoryResponseHeaders } from "@/lib/factories/route-context";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import {
  factoryDeploymentMaxBodyBytes,
  factoryDeploymentObservationRoute,
  factoryDeploymentScope,
  type factoryDeploymentErrorCodeSchema,
} from "./contracts";

type Admin = ReturnType<typeof createSupabaseAdminClient>;
type ErrorCode = z.infer<typeof factoryDeploymentErrorCodeSchema>;

const errors = {
  invalid_request: { status: 400, error: "Invalid deployment observation." },
  unauthorized: { status: 401, error: "A valid factory credential is required." },
  forbidden: { status: 403, error: "The credential cannot report to this deployment source." },
  request_conflict: { status: 409, error: "The admission or deployment revision conflicts." },
  already_admitted: { status: 409, error: "The request has already been admitted." },
  request_too_large: { status: 413, error: "The JSON request exceeds the supported size." },
  unsupported_media_type: { status: 415, error: "Send the request as application/json." },
  rate_limited: { status: 429, error: "The factory command rate limit was reached." },
  concurrency_limited: { status: 429, error: "The factory command concurrency limit was reached." },
  unavailable: {
    status: 503,
    error: "The deployment observation service is temporarily unavailable.",
  },
} satisfies Record<ErrorCode, { status: number; error: string }>;

function failure(code: ErrorCode, retryAfterSeconds?: number) {
  const { status, error } = errors[code];
  const headers = new Headers(factoryResponseHeaders);
  if (status === 401) headers.set("WWW-Authenticate", "Bearer");
  if (retryAfterSeconds !== undefined) headers.set("Retry-After", String(retryAfterSeconds));
  return Response.json(
    { code, error, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
    { status, headers },
  );
}

function rpcFailure(code: string) {
  switch (code) {
    case "42501":
    case "P0010":
    case "P0011":
      return failure("unauthorized");
    case "PT403":
      return failure("forbidden");
    case "PT409":
      return failure("request_conflict");
    case "22007":
    case "22008":
    case "22023":
      return failure("invalid_request");
    default:
      return failure("unavailable");
  }
}

export async function handleFactoryDeploymentObservation(
  request: Request,
  rawParams: unknown,
  admin?: Admin,
) {
  const route = factoryDeploymentObservationRoute;
  const params = route.params.safeParse(rawParams);
  if (!params.success || new URL(request.url).search) return failure("invalid_request");
  const authorization = request.headers.get("Authorization");
  if (!authorization) return failure("unauthorized");

  const raw = await readBoundedJsonBody(request, factoryDeploymentMaxBodyBytes);
  if (!raw.ok) return failure(raw.code);
  const parsed = route.body.safeParse(raw.body);
  if (!parsed.success) return failure("invalid_request");

  const workspaceId = params.data.workspaceId.toLowerCase();
  const factoryId = params.data.factoryId.toLowerCase();
  const input = { ...parsed.data, sourceId: parsed.data.sourceId.toLowerCase() };
  const requestHash = createHash("sha256")
    .update(JSON.stringify(["factory-deployment-observation/v1", workspaceId, factoryId, input]))
    .digest("hex");
  const decision = await authorizeFactoryCommand(
    {
      authorization,
      workspaceId,
      factoryId,
      scope: factoryDeploymentScope,
      requestHash,
      surface: "api",
    },
    admin,
  );
  if (!decision.ok) {
    return failure(
      decision.code,
      "retryAfterSeconds" in decision ? decision.retryAfterSeconds : undefined,
    );
  }

  const { admission } = decision;
  let client = admin;
  try {
    client ??= createSupabaseAdminClient();
    const { p_scope: scope, ...transaction } = factoryCommandTransactionInput(admission);
    if (scope !== factoryDeploymentScope) return failure("forbidden");
    const { data, error } = await client
      .rpc("execute_factory_deployment_observation", {
        ...transaction,
        p_source_id: input.sourceId,
        p_environment: input.environment,
        p_external_deployment_id: input.externalDeploymentId,
        p_revision: input.revision,
        p_outcome: input.outcome,
        ...(input.sourceRevision === null ? {} : { p_source_sha: input.sourceRevision }),
        ...(input.providerOccurredAt === null
          ? {}
          : { p_provider_occurred_at: input.providerOccurredAt }),
      })
      .abortSignal(request.signal);
    if (error) return rpcFailure(error.code);
    const receipt = route.response.safeParse(data);
    if (!receipt.success) return failure("unavailable");
    return Response.json(receipt.data, {
      status: receipt.data.replayed ? 200 : 201,
      headers: factoryResponseHeaders,
    });
  } catch {
    return failure("unavailable");
  } finally {
    await releaseFactoryCommandAdmission(admission, client);
  }
}
