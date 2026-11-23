import { z } from "zod";

import { factoryAutomationPathSchema } from "./contracts";

const generation = z.number().int().nonnegative().safe();
const maxConcurrentSessions = z.number().int().min(1).max(100);

export const automationAdmissionControlCommandSchema = z.strictObject({
  expectedGeneration: generation,
  paused: z.boolean(),
  maxConcurrentSessions,
});

export const automationAdmissionControlSchema = z.strictObject({
  automationId: factoryAutomationPathSchema.shape.automationId,
  generation,
  paused: z.boolean(),
  maxConcurrentSessions,
});

export type AutomationAdmissionControlCommand = z.infer<
  typeof automationAdmissionControlCommandSchema
>;
