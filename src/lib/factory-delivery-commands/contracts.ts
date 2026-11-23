import { z } from "zod/v4";

import { actionsDeliveryRead, actionsDeliveryTarget } from "./actions-contract";

const uuid = z.uuid();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.iso.datetime({ offset: true });

export const factoryDeliveryCommandIdSchema = uuid;

export const factoryDeliveryCommandRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("prepare"),
    commandId: uuid,
    sessionId: uuid,
    checkpointRunId: uuid,
    approvalId: uuid,
    policyRevisionId: uuid,
    mergeObservationId: uuid,
    deploymentSourceId: uuid,
    actions: actionsDeliveryTarget.optional(),
  }),
  z.strictObject({ action: z.literal("cancel"), commandId: uuid }),
]);

export const factoryDeliveryCandidateSchema = z.object({
  sessionId: uuid,
  repositoryId: uuid,
  checkpointRunId: uuid,
  approvalId: uuid,
  policyRevisionId: uuid,
  mergeObservationId: uuid,
  approvedHeadSha: sha,
  sourceRevision: sha,
  deploymentSourceId: uuid,
});

export const factoryDeliveryCommandSchema = factoryDeliveryCandidateSchema.extend({
  id: uuid,
  requestedByMemberId: uuid,
  requestedAt: timestamp,
  dispatchState: z.enum([
    "queued",
    "dispatching",
    "accepted",
    "rejected",
    "unknown",
    "blocked",
    "cancelled",
  ]),
  outcome: z.enum(["pending", "succeeded", "failed", "unknown"]).nullable(),
  dispatchStartedAt: timestamp.nullable(),
  deploymentObservationId: uuid.nullable(),
  actions: actionsDeliveryRead.optional(),
});
