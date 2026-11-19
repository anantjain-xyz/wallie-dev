import { z } from "zod/v4";

import { factoryReadRoutes } from "@/lib/factory-read-api/contracts";

const uuid = z.uuid();
const provider = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const projectId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
const environment = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const externalDeploymentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/);
const revision = z.number().int().min(1).max(2_147_483_647);
const grantVersion = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const outcome = z.enum(["pending", "failed", "unknown", "succeeded"]);
const sourceRevision = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.iso.datetime({ offset: true });

export const factoryDeploymentScope = "deployments:observe";
export const factoryDeploymentMaxBodyBytes = 4096;

export const factoryDeploymentObservationRoute = {
  path: `${factoryReadRoutes.sessions.path.slice(0, -"/sessions".length)}/deployment-observations`,
  params: factoryReadRoutes.sessions.params,
  body: z.strictObject({
    sourceId: uuid,
    environment,
    externalDeploymentId,
    revision,
    outcome,
    sourceRevision: sourceRevision.nullable(),
    providerOccurredAt: timestamp.nullable(),
  }),
  response: z.object({
    deploymentId: uuid,
    observationId: uuid,
    revision,
    currentRevision: revision,
    repositoryId: uuid,
    environment,
    outcome,
    sourceRevision: sourceRevision.nullable(),
    providerOccurredAt: timestamp.nullable(),
    authoritativeOccurredAt: timestamp.nullable(),
    observedAt: timestamp,
    replayed: z.boolean(),
  }),
} as const;

export const factoryDeploymentSourceCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("approve"),
    executionGrantId: uuid,
    executionGrantVersion: grantVersion,
    provider,
    providerProjectId: projectId,
    environment,
    providerTimeAuthoritative: z.boolean().default(false),
  }),
  z.strictObject({ action: z.literal("revoke"), sourceId: uuid }),
]);

export const factoryDeploymentSourceSchema = z.object({
  sourceId: uuid,
  repositoryId: uuid,
  provider,
  providerProjectId: projectId,
  environment,
  servicePrincipalId: uuid,
  executionGrantId: uuid,
  executionGrantVersion: grantVersion,
  providerTimeAuthoritative: z.boolean(),
  approvedAt: timestamp,
  revokedAt: timestamp.nullable(),
});

export const factoryDeploymentErrorCodeSchema = z.enum([
  "invalid_request",
  "unauthorized",
  "forbidden",
  "request_conflict",
  "already_admitted",
  "request_too_large",
  "unsupported_media_type",
  "rate_limited",
  "concurrency_limited",
  "unavailable",
]);

export const factoryDeploymentErrorSchema = z.object({
  code: factoryDeploymentErrorCodeSchema,
  error: z.string(),
  retryAfterSeconds: z.number().int().positive().optional(),
});
