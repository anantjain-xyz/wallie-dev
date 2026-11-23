import { z } from "zod/v4";

export const actionsNumericId = z.number().int().positive().safe();
const workflowPath = z
  .string()
  .regex(/^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}\.ya?ml$/);
const tag = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/)
  .refine(
    (name) =>
      !name.includes("..") &&
      name.split("/").every((part) => !part.endsWith(".lock") && !part.endsWith(".")),
  );
const inputName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .refine((name) => !name.startsWith("wallie_"));
const inputs = z
  .record(inputName, z.string().max(256))
  .refine((items) => Object.keys(items).length <= 8);

export const actionsDeliveryTarget = z.strictObject({
  workflowId: actionsNumericId,
  workflowPath,
  tag,
  inputs,
});

export const actionsDeliveryReason = z.enum([
  "awaiting_dispatch",
  "app_unavailable",
  "installation_unavailable",
  "permission_missing",
  "repository_unavailable",
  "workflow_unavailable",
  "workflow_contract_mismatch",
  "immutable_tag_required",
  "guarded_source_changed",
  "cancelled",
  "source_mismatch",
  "github_unavailable",
  "provider_refused",
  "dispatch_unknown",
  "awaiting_run",
  "run_unavailable",
  "run_mismatch",
  "run_verified",
  "observation_expired",
]);

export const actionsRunStatus = z.enum([
  "queued",
  "requested",
  "waiting",
  "pending",
  "in_progress",
  "completed",
]);
export const actionsRunConclusion = z.enum([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
]);

export const actionsDeliveryRead = actionsDeliveryTarget.omit({ inputs: true }).extend({
  reason: actionsDeliveryReason,
  runId: actionsNumericId.nullable(),
  runStatus: actionsRunStatus.nullable(),
  runConclusion: actionsRunConclusion.nullable(),
});

export const actionsDeliveryOperation = actionsDeliveryTarget.extend({
  workspaceId: z.uuid(),
  factoryId: z.uuid(),
  commandId: z.uuid(),
  runNonce: z.uuid(),
  installationId: actionsNumericId,
  repositoryNumericId: actionsNumericId,
  repositoryFullName: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  environment: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
});

export const actionsDeliveryDispatch = actionsDeliveryOperation.extend({
  leaseId: z.uuid(),
  leaseExpiresAt: z.iso.datetime({ offset: true }),
});

export const actionsDeliveryObservation = actionsDeliveryOperation.extend({
  dispatchStartedAt: z.iso.datetime({ offset: true }),
  observationId: z.uuid(),
  runId: actionsNumericId.nullable(),
});

export type ActionsDeliveryOperation = z.infer<typeof actionsDeliveryOperation>;
export type ActionsDeliveryObservation = z.infer<typeof actionsDeliveryObservation>;
export type ActionsDeliveryReason = z.infer<typeof actionsDeliveryReason>;
