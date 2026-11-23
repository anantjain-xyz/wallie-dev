import { z } from "zod/v4";

export const monitoringBindingId = z.uuid();
const externalId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const providerId = z.union([externalId, z.number().int().positive().safe().transform(String)]);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const eventId = z.string().regex(/^[a-f0-9]{32}$/);
const environment = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export const monitoringBindingCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("approve"),
    bindingId: monitoringBindingId,
    deploymentSourceId: z.uuid(),
    installationId: z.uuid(),
    projectId: externalId,
    signingSecret: z
      .string()
      .min(16)
      .max(512)
      .regex(/^[!-~]+$/),
    suppressionSeconds: z.number().int().min(60).max(86_400),
  }),
  z.strictObject({ action: z.literal("disable"), bindingId: monitoringBindingId }),
]);

export const monitoringBindingSchema = z.strictObject({
  id: monitoringBindingId,
  deploymentSourceId: z.uuid(),
  installationId: z.uuid(),
  projectId: externalId,
  suppressionSeconds: z.number().int().min(60).max(86_400),
  approvedAt: z.iso.datetime({ offset: true }),
  disabledAt: z.iso.datetime({ offset: true }).nullable(),
});

export const monitoringBindingListSchema = z.array(monitoringBindingSchema).max(10);

const sentryAlertSchema = z.object({
  action: z.literal("triggered"),
  installation: z.object({ uuid: z.uuid() }),
  data: z.object({
    event: z.object({
      event_id: eventId,
      issue_id: providerId,
      project: providerId,
      datetime: z.iso.datetime({ offset: true }),
      release: z.string().max(250).nullable().optional(),
      environment: z.string().max(64).nullable().optional(),
      tags: z.array(z.tuple([z.string(), z.string()])).max(128),
    }),
  }),
});

const monitoredDeploymentSchema = z.object({
  commandId: z.uuid(),
  sourceSha: revision,
  environment,
});

export function parseSentryAlert(payload: unknown) {
  const parsed = sentryAlertSchema.safeParse(payload);
  if (!parsed.success) return null;
  const event = parsed.data.data.event;
  const selectedTags = new Map<string, string>();
  for (const [name, value] of event.tags) {
    if (name !== "wallie_delivery_command" && name !== "release" && name !== "environment")
      continue;
    if (selectedTags.has(name)) return null;
    selectedTags.set(name, value);
  }
  const taggedRelease = selectedTags.get("release");
  const taggedEnvironment = selectedTags.get("environment");
  if (
    (event.release != null && taggedRelease !== undefined && taggedRelease !== event.release) ||
    (event.environment != null &&
      taggedEnvironment !== undefined &&
      taggedEnvironment !== event.environment)
  )
    return null;

  const deployment = monitoredDeploymentSchema.safeParse({
    commandId: selectedTags.get("wallie_delivery_command"),
    sourceSha: event.release ?? taggedRelease,
    environment: event.environment ?? taggedEnvironment,
  });
  if (!deployment.success) return null;
  return {
    installationId: parsed.data.installation.uuid,
    eventId: event.event_id,
    issueId: event.issue_id,
    projectId: event.project,
    eventAt: event.datetime,
    ...deployment.data,
  };
}

export const monitoringSignalReceiptSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.enum(["queued", "suppressed", "duplicate"]),
    incidentId: z.uuid(),
  }),
  z.strictObject({ status: z.enum(["ignored", "rate_limited"]) }),
]);

export const monitoringIncidentEvidenceSchema = z.strictObject({
  deploymentId: z.uuid(),
  deliveryCommandId: z.uuid(),
  deploymentObservationId: z.uuid(),
  sourceRevision: revision,
  approvedHeadRevision: revision,
  environment,
  sourceSessionNumber: z.number().int().positive(),
  sentryProjectId: externalId,
  sentryIssueId: externalId,
  sentryEventId: eventId,
  eventAt: z.iso.datetime({ offset: true }),
});

export type MonitoringIncidentEvidence = z.infer<typeof monitoringIncidentEvidenceSchema>;
