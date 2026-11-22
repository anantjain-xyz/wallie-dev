import { z } from "zod";

const id = z.string().uuid().toLowerCase();
const activationNumber = z.number().int().safe().positive();

export const routingCanarySelectionSchema = z.strictObject({
  taskClassId: id,
  candidateBps: z.number().int().min(1).max(9_999),
});

export const routingCanarySummarySchema = routingCanarySelectionSchema.extend({
  id,
  taskClassSlug: z.string().min(1),
  activationNumber,
  baselineActivationNumber: activationNumber,
  candidateRevisionId: id,
  baselineRevisionId: id,
  minimumSupport: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
});

export type RoutingCanarySelection = z.infer<typeof routingCanarySelectionSchema>;
export type RoutingCanarySummary = z.infer<typeof routingCanarySummarySchema>;
