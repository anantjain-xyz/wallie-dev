import { z } from "zod/v4";

const uuid = z.uuid().toLowerCase();
const provider = z.enum(["github", "linear"]);
const revision = z.number().int().positive().safe();
const timestamp = z.iso.datetime({ offset: true });
const connectionStatus = z.enum(["connected", "disconnected", "credential_unavailable"]);

export const connectorInventorySchema = z.strictObject({
  canConfigure: z.boolean(),
  installations: z.array(
    z.strictObject({
      id: uuid,
      provider,
      generation: revision,
      status: connectionStatus,
      externalTenantId: z.string().min(1).max(192),
      externalInstallationId: z.string().min(1).max(192),
    }),
  ),
  resources: z.array(
    z.strictObject({
      id: uuid,
      installationId: uuid,
      provider,
      kind: z.enum(["repository", "team", "project"]),
      externalId: z.string().min(1).max(256),
      label: z.string().nullable(),
      mappingRevision: revision,
      enabled: z.boolean(),
      connectionStatus,
      githubRequests: z.array(
        z.strictObject({
          sourceKind: z.enum(["issue", "pull_request"]),
          revision,
          enabled: z.boolean(),
          labelId: revision,
        }),
      ),
    }),
  ),
});
export type ConnectorInventory = z.output<typeof connectorInventorySchema>;

export const connectorDeliveryLaneSchema = z.enum(["all", "ingress", "outbound"]);
export type ConnectorDeliveryLane = z.output<typeof connectorDeliveryLaneSchema>;

const deliveryKind = z.enum(["github_admission", "github_comment", "linear_intake", "outbound"]);
const statuses = [
  "observed",
  "deleted",
  "stale",
  "linked",
  "denied",
  "admitted",
  "pending",
  "settled",
  "failed",
  "queued",
  "sending",
  "unknown",
  "observing",
  "blocked",
  "delivered",
] as const;

export const connectorDeliveryRowSchema = z.strictObject({
  id: uuid,
  kind: deliveryKind,
  status: z.enum(statuses),
  reason: z.enum([
    ...statuses,
    "actor_not_allowed",
    "admission_denied",
    "expired",
    "attempt_limit",
    "processing_failed",
    "contention",
    "retry_pending",
    "appended",
    "ignored",
    "sent",
    "not_sent",
    "uncertain",
    "rate_limited",
    "credential_unavailable",
    "rejected",
    "found",
    "absent",
    "inconclusive",
  ]),
  recordedAt: timestamp,
  nextAttemptAt: timestamp.nullable(),
  deadlineAt: timestamp.nullable(),
  attempts: z.number().int().nonnegative(),
  observationAttempts: z.number().int().nonnegative(),
  uncertain: z.boolean(),
  canRetry: z.boolean(),
  sessionId: uuid.nullable(),
  sessionNumber: z.number().int().positive().nullable(),
  operation: z.enum(["reply", "edit", "linear_status"]).nullable(),
  sourceReference: z.string().max(256).nullable(),
});
export type ConnectorDeliveryRow = z.output<typeof connectorDeliveryRowSchema>;

export const connectorDeliveryCursorSchema = z.strictObject({
  recordedAt: timestamp,
  kind: deliveryKind,
  id: uuid,
});

export const linearDiscoveryFailureReasonSchema = z.enum([
  "provider_unavailable",
  "provider_access_denied",
  "invalid_provider_response",
  "scope_mismatch",
  "discovery_commit_failed",
]);
export type LinearDiscoveryFailureReason = z.output<typeof linearDiscoveryFailureReasonSchema>;

export const connectorDeliveryPageSchema = z.strictObject({
  deliveries: z.array(connectorDeliveryRowSchema).max(50),
  nextCursor: z.string().min(1).max(512).nullable(),
  linearDiscovery: z
    .strictObject({
      status: z.enum(["disabled", "unavailable", "rate_limited", "scheduled", "failed"]),
      nextScanAt: timestamp.nullable(),
      retryAt: timestamp.nullable(),
      lastFailureAt: timestamp.nullable(),
      lastFailureReason: linearDiscoveryFailureReasonSchema.nullable(),
    })
    .nullable(),
});
export type ConnectorDeliveryPage = z.output<typeof connectorDeliveryPageSchema>;

export const connectorDeliveryProjectionSchema = connectorDeliveryPageSchema.extend({
  nextCursor: connectorDeliveryCursorSchema.nullable(),
});

export const connectorRetryCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("github_comment"), id: uuid, mode: z.literal("retry") }),
  z.strictObject({ kind: z.literal("outbound"), id: uuid, mode: z.enum(["retry", "observe"]) }),
]);
export type ConnectorRetryCommand = z.output<typeof connectorRetryCommandSchema>;
