import { z } from "zod";

const id = z.string().uuid();
export const factoryEventSubscriptionCredentialKind = z.enum(["machine_token", "oauth_grant"]);
export const factoryOutboundEventType = z.enum([
  "session.created",
  "session.canceled",
  "run.started",
  "run.completed",
  "conversation.message_added",
  "review.ready",
  "review.approved",
  "review.changes_requested",
  "review.clarification_requested",
  "review.clarification_answered",
]);

export const factoryOutboundEventLabels: Record<
  z.infer<typeof factoryOutboundEventType>,
  string
> = {
  "session.created": "Session created",
  "session.canceled": "Session canceled",
  "run.started": "Run started",
  "run.completed": "Run completed",
  "conversation.message_added": "Conversation message added",
  "review.ready": "Review ready",
  "review.approved": "Review approved",
  "review.changes_requested": "Changes requested",
  "review.clarification_requested": "Clarification requested",
  "review.clarification_answered": "Clarification answered",
};

export const createFactoryEventSubscriptionSchema = z
  .object({
    action: z.literal("create"),
    name: z.string().trim().min(1).max(120),
    destination: z.string().trim().min(1).max(2048),
    credentialKind: factoryEventSubscriptionCredentialKind,
    credentialId: id,
    eventTypes: z
      .array(factoryOutboundEventType)
      .min(1)
      .max(factoryOutboundEventType.options.length),
  })
  .strict();

export const factoryEventSubscriptionCommand = z.discriminatedUnion("action", [
  createFactoryEventSubscriptionSchema,
  z.object({ action: z.literal("verify"), subscriptionId: id }).strict(),
  z.object({ action: z.literal("revoke"), subscriptionId: id }).strict(),
  z.object({ action: z.literal("retry"), deliveryId: id }).strict(),
]);

export const factoryEventDeliveryQuery = z.object({
  subscriptionId: id,
  cursor: z.string().min(1).max(180).optional(),
});

export const factoryEventDeliveryCursor = z.object({
  beforeAt: z.string().datetime({ offset: true }),
  beforeId: id,
});

export type FactoryEventSubscriptionCommand = z.infer<typeof factoryEventSubscriptionCommand>;
